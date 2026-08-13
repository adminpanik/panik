/**
 * Monitoring alerts (Phase 4.B) — the taxonomy, the anti-spam gate, and the
 * delivery fan-out.
 *
 * EVERY ALERT IN THIS SYSTEM EXISTS TO MAKE ONE SENTENCE FALSE: "the user
 * believed they were protected and were not." That is the only test for whether
 * a condition belongs here. A metric that cannot end in that sentence is a
 * dashboard line, not a page.
 *
 * Three design rules, each of which has a failure mode behind it:
 *
 *   1. AN ALERT NAMES A FACT THE CODE KNOWS. `summary` states what was
 *      observed, never what it implies. "aToken allowance is 0, the exit would
 *      revert" is an alert; "user is unprotected" is an inference that a
 *      degraded read can make into a lie.
 *   2. A MONITORING SYSTEM THAT SPAMS GETS MUTED, and a muted monitor is itself
 *      a coverage failure. Every alert carries a stable `key` naming the
 *      ONGOING CONDITION (not the observation), and the gate refuses to resend
 *      the same key inside its repeat window. Escalating severity on the same
 *      key bypasses the window once, because "this got worse" is new
 *      information.
 *   3. THE GATE IS DURABLE. It lives in Postgres, not in a process map, or a
 *      crash-loop turns the anti-spam gate into a spam amplifier: every restart
 *      re-fires every standing condition.
 *
 * Nothing here talks to a chain. It is pure policy plus two thin sinks, so the
 * whole gate can be tested without a network.
 */

/** How loud. `critical` means a human is expected to act now. */
export type AlertSeverity = "info" | "warning" | "critical";

/**
 * Every condition this system can page on. Stable strings: a renamed kind is a
 * broken runbook and a reset dedupe key, exactly as `SkipReason` is stable in
 * server/relayerPolicy.ts.
 */
export type AlertKind =
  /** The worker (or one of its loops) has not reported a completed cycle. */
  | "worker.heartbeat_missing"
  /** A relayer signer is below the balance its own limits require. */
  | "relayer.balance_low"
  /** The pool cannot fund the worst-case burst its caps allow. */
  | "relayer.balance_under_burst"
  /** A submitted atomicExitFor did not succeed. Near-zero in steady state. */
  | "relayer.submission_failed"
  /** The same permit keeps being skipped for the same reason. */
  | "relayer.repeated_skip"
  /** An RPC provider is unreachable or erroring. */
  | "rpc.provider_down"
  /** Every configured provider is down: the worker is blind. */
  | "rpc.all_providers_down"
  /** Providers disagree about the head by more than the tolerated lag. */
  | "rpc.providers_diverged"
  /** The chain's latest block is too old to trust (4.A's detector, surfaced). */
  | "sequencer.stale"
  /** A live permit exists but the exit it authorises would revert today. */
  | "coverage.gap"
  /** The sweep could not verify an authorization. Unknown, not fine. */
  | "coverage.unverifiable"
  /** A permit's deadline is approaching. Escalates; fires once per threshold. */
  | "coverage.expiring"
  /** A permit expired while its position is still monitored and at risk. */
  | "coverage.expired_at_risk"
  /** A permit expired on a position that is not currently at risk. */
  | "coverage.expired"
  /** The signer address gained code after signing (EIP-7702 delegate). */
  | "coverage.signer_gained_code"
  /** The signer's code changed since the permit was verified against it. */
  | "coverage.signer_code_changed"
  /** A user with an at-risk position cannot be reached on Telegram. */
  | "telegram.unreachable"
  /**
   * The scoring pass keeps producing nothing while wallets are watched. The
   * worker is alive and blind, which every liveness signal reads as healthy.
   */
  | "scoring.blind";

/** One condition, ready to deliver. JSON-safe throughout. */
export interface MonitorAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  /**
   * Identity of the ONGOING CONDITION, not of the observation. Two ticks that
   * see the same missing allowance must produce the same key or the gate
   * cannot suppress the second one.
   */
  key: string;
  /** Operator-facing one-liner. Observed facts only. */
  summary: string;
  /** Structured context. Never a bigint (JSON.stringify throws). */
  detail?: Record<string, string | number | boolean | null>;
  /** The wallet this concerns, when there is one. */
  wallet?: string;
  /**
   * The USER-facing message, when this alert is one a user should see. Absent
   * means operator-only — most of them are, because "our relayer is low on
   * gas" is not a sentence a user can act on.
   */
  userMessage?: string;
  /** Observation time, epoch ms. */
  at: number;
}

/**
 * How long the same key stays suppressed after a send, by severity.
 *
 * Sized so a standing condition reminds an operator at a cadence matched to how
 * fast it can hurt someone: a critical repeats hourly (a coverage gap that
 * lasts a day should be impossible to forget), a warning twice a shift, an info
 * once a day.
 */
export const ALERT_REPEAT_MS: Record<AlertSeverity, number> = {
  info: 24 * 3_600_000,
  warning: 6 * 3_600_000,
  critical: 3_600_000,
};

/** A repeat window meaning "send this key exactly once, ever". */
export const ONCE = Number.POSITIVE_INFINITY;

/**
 * Kinds that fire once per key and never repeat.
 *
 * Expiry escalation is the whole reason this exists: the 7d / 48h / 12h prompts
 * carry the threshold IN the key, so "once per key" is exactly "once per
 * threshold", and a user who ignores the 7-day prompt gets the 48-hour one
 * rather than the 7-day one seven more times.
 */
const ONCE_ONLY_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  "coverage.expiring",
]);

export function repeatWindowFor(alert: MonitorAlert): number {
  return ONCE_ONLY_KINDS.has(alert.kind) ? ONCE : ALERT_REPEAT_MS[alert.severity];
}

/** Severity ordering, so an escalation can be detected. */
const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function isEscalation(prev: AlertSeverity | null, next: AlertSeverity): boolean {
  return prev !== null && SEVERITY_RANK[next] > SEVERITY_RANK[prev];
}

/**
 * The durable dedupe ledger.
 *
 * `claim` is the whole contract: it returns true AT MOST ONCE per (key, window)
 * and records the send in the same operation. Implementations must make that
 * atomic — two workers racing the same condition should page once, not twice.
 */
export interface AlertLedger {
  /**
   * Claim the right to send `alert` now. Resolves false when the same key was
   * sent inside `windowMs` and the severity did not escalate.
   */
  claim(alert: MonitorAlert, windowMs: number, now: number): Promise<boolean>;
}

/** In-memory ledger. Tests, and any process that has no Supabase config. */
export class MemoryAlertLedger implements AlertLedger {
  private readonly seen = new Map<string, { at: number; severity: AlertSeverity }>();

  async claim(alert: MonitorAlert, windowMs: number, now: number): Promise<boolean> {
    const prev = this.seen.get(alert.key);
    if (prev && !isEscalation(prev.severity, alert.severity) && now - prev.at < windowMs) {
      return false;
    }
    this.seen.set(alert.key, { at: now, severity: alert.severity });
    return true;
  }

  /** Test helper: when was this key last sent? */
  lastSentAt(key: string): number | null {
    return this.seen.get(key)?.at ?? null;
  }
}

interface LedgerRow {
  key: string;
  severity: AlertSeverity;
  last_sent_at: string;
}

/**
 * Supabase-backed ledger over PostgREST (same transport as
 * server/telegramStore.ts, so it bundles without `pg`).
 *
 * ATOMICITY. The claim is two conditional writes, never a read-then-write:
 *
 *   1. INSERT with `resolution=ignore-duplicates` + `return=representation`.
 *      A returned row means THIS caller created it and owns the send. An empty
 *      body means somebody else already holds the key.
 *   2. PATCH filtered on `last_sent_at < cutoff` (or on an escalated severity),
 *      also `return=representation`. An empty body means the row did not match
 *      the filter, i.e. the window has not elapsed. Postgres evaluates that
 *      filter under the row lock, so two racers produce one winner.
 */
export class SupabaseAlertLedger implements AlertLedger {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  static fromEnv(): SupabaseAlertLedger {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SupabaseAlertLedger(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async claim(alert: MonitorAlert, windowMs: number, now: number): Promise<boolean> {
    const sentAt = new Date(now).toISOString();
    const created = await fetch(`${this.base}/rest/v1/monitor_alerts`, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=ignore-duplicates,return=representation" }),
      body: JSON.stringify({
        key: alert.key,
        kind: alert.kind,
        severity: alert.severity,
        summary: alert.summary.slice(0, 500),
        wallet: alert.wallet ?? null,
        first_seen_at: sentAt,
        last_sent_at: sentAt,
      }),
    });
    if (!created.ok) throw new Error(`monitor_alerts insert: HTTP ${created.status}`);
    const inserted = (await created.json().catch(() => [])) as LedgerRow[];
    if (Array.isArray(inserted) && inserted.length > 0) return true;

    // The key exists, so this is a REPEAT. It goes out only if the window has
    // elapsed, or if the stored severity is strictly lower than this one (the
    // condition got worse, which is new information whatever the window says).
    // Both conditions are expressed as a row FILTER rather than as a decision
    // taken after a read, so Postgres evaluates them under the row lock.
    const lower = escalatableFrom(alert.severity);
    let filter: string;
    if (windowMs === ONCE) {
      if (!lower) return false;
      filter = `&severity=in.(${lower})`;
    } else {
      const cutoff = encodeURIComponent(new Date(now - windowMs).toISOString());
      filter = lower
        ? `&or=(last_sent_at.lt.${cutoff},severity.in.(${lower}))`
        : `&last_sent_at=lt.${cutoff}`;
    }

    const patched = await fetch(
      `${this.base}/rest/v1/monitor_alerts?key=eq.${encodeURIComponent(alert.key)}${filter}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({
          severity: alert.severity,
          summary: alert.summary.slice(0, 500),
          last_sent_at: sentAt,
        }),
      },
    );
    if (!patched.ok) throw new Error(`monitor_alerts patch: HTTP ${patched.status}`);
    const rows = (await patched.json().catch(() => [])) as LedgerRow[];
    return Array.isArray(rows) && rows.length > 0;
  }
}

/** Severities strictly below `next`, as a PostgREST `in.(…)` list. */
function escalatableFrom(next: AlertSeverity): string {
  return (Object.keys(SEVERITY_RANK) as AlertSeverity[])
    .filter((s) => SEVERITY_RANK[s] < SEVERITY_RANK[next])
    .join(",");
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Somewhere an alert can land. Must never throw; a dead sink is not a crash. */
export type AlertSink = (alert: MonitorAlert) => Promise<void>;

/** One human-readable line. Used by every sink so they agree on wording. */
export function formatAlertLine(alert: MonitorAlert): string {
  const tag = alert.severity.toUpperCase();
  const who = alert.wallet ? ` [${alert.wallet}]` : "";
  const extra = alert.detail
    ? " " +
      Object.entries(alert.detail)
        .map(([k, v]) => `${k}=${v ?? "unknown"}`)
        .join(" ")
    : "";
  return `${tag} ${alert.kind}${who}: ${alert.summary}${extra}`;
}

/**
 * Structured stderr sink. ALWAYS wired, even when a webhook is configured: the
 * log drain is the one delivery path that cannot itself be down, and one JSON
 * line per alert is what a log-based monitor can key on. Deliberately mirrors
 * `consoleEventSink` in server/relayerPolicy.ts — prose is a promise to break.
 */
export const operatorLogSink: AlertSink = async (alert) => {
  console.error(JSON.stringify({ type: "monitor.alert", ...alert }));
};

/**
 * Generic JSON webhook sink (`MONITOR_OPERATOR_WEBHOOK_URL`). The body carries
 * both `text` (so a Slack/Discord incoming webhook renders something useful
 * with no transform) and the full structured alert.
 */
export function operatorWebhookSink(url: string, timeoutMs = 5_000): AlertSink {
  return async (alert) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: formatAlertLine(alert), alert }),
        signal: controller.signal,
      });
    } catch (err) {
      // A failed page must not take the worker with it, but it must be loud:
      // the operator channel being down is itself an outage.
      console.error(`operator webhook failed: ${(err as Error).message.slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fan-out with the durable gate in front.
 *
 * `dispatch` is the ONLY way an alert should reach a sink. Calling a sink
 * directly bypasses the anti-spam gate, which is how a monitoring system earns
 * a mute rule.
 */
export class AlertDispatcher {
  constructor(
    private readonly ledger: AlertLedger,
    private readonly sinks: readonly AlertSink[],
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Gate and deliver. Returns the alerts that actually went out. */
  async dispatch(alerts: readonly MonitorAlert[]): Promise<MonitorAlert[]> {
    const sent: MonitorAlert[] = [];
    for (const alert of alerts) {
      let allowed: boolean;
      try {
        allowed = await this.ledger.claim(alert, repeatWindowFor(alert), this.nowMs());
      } catch (err) {
        // A ledger outage must not silence a page. Fail OPEN and say so: a
        // duplicate alert is an annoyance, a swallowed one is the whole bug
        // this file exists to prevent.
        console.error(
          `alert ledger unavailable, delivering ungated: ${(err as Error).message.slice(0, 160)}`,
        );
        allowed = true;
      }
      if (!allowed) continue;
      for (const sink of this.sinks) {
        try {
          await sink(alert);
        } catch (err) {
          console.error(`alert sink failed: ${(err as Error).message.slice(0, 160)}`);
        }
      }
      sent.push(alert);
    }
    return sent;
  }
}
