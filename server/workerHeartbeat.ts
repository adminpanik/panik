/**
 * The dead-man's heartbeat (Phase 4.B).
 *
 * THIS IS THE ALERT THAT CATCHES EVERY OTHER ALERT FAILING. Balance checks,
 * coverage sweeps and RPC probes all run INSIDE the worker, so a worker that
 * dies or hangs silences all of them at once — and silence looks exactly like
 * "nothing is wrong". The fix is to invert the signal: the worker asserts
 * liveness on every completed loop, and the ABSENCE of that assertion past one
 * expected cycle is itself the page.
 *
 * WHY THE HEARTBEAT LIVES IN POSTGRES AND NOT IN THE PROCESS. A process cannot
 * observe its own death. An in-process timer that checks "did my loop run?"
 * catches a HUNG loop while the process lives, which is real and worth having,
 * but it cannot catch `SIGKILL`, an OOM, or a Railway restart loop. So the
 * heartbeat is a durable row carrying `expected_by`, and a SECOND process (the
 * Express API on Railway, which is deployed separately and does not share a
 * lifecycle with the worker) reads it. Two independent processes: one dying
 * does not silence the other.
 *
 * The row is also the contract for anything outside this codebase — an uptime
 * check, a Grafana alert, a pg_cron job — because the whole condition is
 * `now() > expected_by`, expressed in the data rather than in code somebody has
 * to run.
 */

import type { AlertKind, MonitorAlert } from "./monitorAlerts";

/** One loop's liveness assertion. */
export interface HeartbeatRecord {
  /** Loop name, e.g. "watch" / "dispatch" / "monitor". Primary key. */
  loop: string;
  /** When the loop last COMPLETED, epoch ms. Not when it started. */
  at: number;
  /** The loop's nominal period, so the checker needs no config of its own. */
  intervalMs: number;
  /** at + intervalMs * (1 + HEARTBEAT_GRACE_CYCLES). Epoch ms. */
  expectedByMs: number;
}

/**
 * How many extra periods a loop may miss before it is considered dead.
 *
 * One. A tick that overruns its own period is ordinary (an RPC that took 70s on
 * a 60s loop), so alerting at exactly one period would page on jitter. Two full
 * periods of silence is not jitter — nothing in this worker takes that long
 * without something being wrong.
 */
export const HEARTBEAT_GRACE_CYCLES = 1;

export function expectedByMs(at: number, intervalMs: number): number {
  return at + intervalMs * (1 + HEARTBEAT_GRACE_CYCLES);
}

/** Persistence for heartbeats. Injectable so the detector tests without a DB. */
export interface HeartbeatStore {
  /** Record a COMPLETED cycle of `loop`. */
  ping(loop: string, intervalMs: number, now: number): Promise<void>;
  /** Every loop's latest heartbeat. */
  list(): Promise<HeartbeatRecord[]>;
}

/** Is this heartbeat overdue as of `now`? */
export function heartbeatStale(record: HeartbeatRecord, now: number): boolean {
  return now > record.expectedByMs;
}

/**
 * THE ABSENCE DETECTOR.
 *
 * `expectedLoops` is what makes absence detectable at all: without it, a loop
 * that never started (or whose row was never written) produces no record and
 * therefore no alert — the exact silence this file exists to break. A loop that
 * is expected and has NO record is treated as the worst case, not the best one.
 *
 * `bootedAt` suppresses the "never reported" alert during the first grace
 * window after a deliberate restart, so a rolling deploy is not a page. It does
 * NOT suppress a stale record: a loop that used to report and stopped is always
 * an alert, restart or not.
 */
export function heartbeatAlerts(
  records: readonly HeartbeatRecord[],
  expectedLoops: readonly string[],
  now: number,
  opts: { bootedAt?: number; expectedIntervalMs?: Record<string, number> } = {},
): MonitorAlert[] {
  const kind: AlertKind = "worker.heartbeat_missing";
  const byLoop = new Map(records.map((r) => [r.loop, r]));
  const alerts: MonitorAlert[] = [];

  for (const loop of expectedLoops) {
    const record = byLoop.get(loop);

    if (!record) {
      const interval = opts.expectedIntervalMs?.[loop];
      const graceMs = interval ? interval * (1 + HEARTBEAT_GRACE_CYCLES) : 0;
      if (opts.bootedAt !== undefined && now - opts.bootedAt <= graceMs) continue;
      alerts.push({
        kind,
        severity: "critical",
        key: `worker.heartbeat:${loop}`,
        summary: `worker loop "${loop}" has never reported a completed cycle`,
        detail: { loop, lastSeen: null, overdueMs: null },
        at: now,
      });
      continue;
    }

    if (!heartbeatStale(record, now)) continue;
    alerts.push({
      kind,
      severity: "critical",
      key: `worker.heartbeat:${loop}`,
      summary:
        `worker loop "${loop}" last completed ${Math.round((now - record.at) / 1000)}s ago, ` +
        `expected every ${Math.round(record.intervalMs / 1000)}s`,
      detail: {
        loop,
        lastSeen: new Date(record.at).toISOString(),
        overdueMs: now - record.expectedByMs,
        intervalMs: record.intervalMs,
      },
      at: now,
    });
  }

  return alerts;
}

interface RawHeartbeat {
  loop: string;
  at: string;
  interval_ms: number;
  expected_by: string;
}

/**
 * Supabase-backed store over PostgREST — same transport as
 * server/telegramStore.ts, so no `pg` and it bundles into a serverless
 * function unchanged.
 */
export class SupabaseHeartbeatStore implements HeartbeatStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  static fromEnv(): SupabaseHeartbeatStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SupabaseHeartbeatStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async ping(loop: string, intervalMs: number, now: number): Promise<void> {
    const res = await fetch(`${this.base}/rest/v1/worker_heartbeats`, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        loop,
        at: new Date(now).toISOString(),
        interval_ms: intervalMs,
        // Written by the WRITER, not computed by the reader, so any consumer
        // (SQL, an uptime check, a dashboard) evaluates the same condition
        // without needing to know this loop's period.
        expected_by: new Date(expectedByMs(now, intervalMs)).toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`heartbeat ping: HTTP ${res.status}`);
  }

  async list(): Promise<HeartbeatRecord[]> {
    const res = await fetch(
      `${this.base}/rest/v1/worker_heartbeats?select=loop,at,interval_ms,expected_by`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`heartbeat list: HTTP ${res.status}`);
    const rows = (await res.json()) as RawHeartbeat[];
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      loop: r.loop,
      at: new Date(r.at).getTime(),
      intervalMs: r.interval_ms,
      expectedByMs: new Date(r.expected_by).getTime(),
    }));
  }
}

/** In-memory store for tests and for a worker with no Supabase config. */
export class MemoryHeartbeatStore implements HeartbeatStore {
  private readonly rows = new Map<string, HeartbeatRecord>();

  async ping(loop: string, intervalMs: number, now: number): Promise<void> {
    this.rows.set(loop, { loop, at: now, intervalMs, expectedByMs: expectedByMs(now, intervalMs) });
  }

  async list(): Promise<HeartbeatRecord[]> {
    return [...this.rows.values()];
  }
}
