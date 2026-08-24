/**
 * Per-user alert tuning (7.4) and digest mode (7.5) — the VALUES, the parsing
 * and the predicates. The decision that reads them is `alertPolicy.decideSend`;
 * the storage is `server/alertSettingsStore.ts`.
 *
 * ── THE ONE RULE THAT OUTRANKS EVERY PREFERENCE ────────────────────────────
 * A critical alert is never muted, never held for quiet hours and never
 * batched into a digest. That is enforced STRUCTURALLY: `decideSend` computes
 * `isCriticalAlert` before it looks at any of those three branches, so a
 * preference cannot reach the code path that would delay one. A quiet-hours
 * setting that can sit on a liquidation warning is not a preference, it is a
 * silent failure with a settings screen in front of it.
 *
 * Cooldown is the exception that proves it: the cooldown is calibrated
 * anti-spam (params.ALERT_POLICY) and stays in force, but a user may only ever
 * SHORTEN it for a critical alert. `effectiveCooldownMs` clamps a critical
 * alert to at most the engine default, so nobody can configure themselves into
 * hearing about a liquidation later than the default would have told them.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * Defaults do NOT vary by risk profile. Nothing in the engine scales a cooldown
 * or a materiality floor by profile (ALERT_THRESHOLD 25/50/75 is a SCORE
 * boundary and already decides who gets an alert at all), so a per-profile
 * default table would be an invented product decision, not a derived one. Every
 * profile therefore starts from `DEFAULT_ALERT_SETTINGS`, which is the policy
 * the product already ships.
 */

import { ALERT_POLICY } from "../params";
import type { Band, ProfileStatus, Protocol } from "../types";

/** How often a digest goes out. "off" = every non-critical alert sends live. */
export type DigestFrequency = "off" | "hourly" | "daily";

export const DIGEST_INTERVAL_MS: Record<Exclude<DigestFrequency, "off">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

const MINUTES_PER_DAY = 1440;

/** Longest cooldown a user may set: a week. Beyond that it is a mute, and mute exists. */
export const COOLDOWN_MINUTES_MAX = 7 * 24 * 60;

/** Most mutes one user may hold. A bound on the row, not a product opinion. */
export const MUTE_MAX = 50;

const PROTOCOLS: readonly Protocol[] = ["aave_v3", "moonwell", "morpho", "compound_v3"];

export interface AlertSettings {
  /** Debt below this never alerts. Dust filter, in USD. */
  minBorrowUsd: number;
  /** At most one alert per (chat, wallet, protocol) per this window. */
  cooldownMs: number;
  /**
   * Quiet hours as minutes past midnight UTC, or null for "no quiet hours".
   * Start > end wraps past midnight (22:00 -> 07:00 is the normal case).
   *
   * ponytail: UTC, not the user's zone. A local-time window needs a tz column
   * and DST handling; add both when the settings UI collects a timezone.
   */
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  /** Protocols this user does not want non-critical alerts from. */
  mutedProtocols: readonly Protocol[];
  /** Individual positions, as "wallet:protocol" (lowercased). */
  mutedPositions: readonly string[];
  digest: DigestFrequency;
}

/**
 * What every user gets before they touch anything: exactly the policy the
 * dispatcher applied before settings existed, so storing no row and storing the
 * defaults are the same behaviour.
 */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  minBorrowUsd: ALERT_POLICY.minBorrowUsd,
  cooldownMs: ALERT_POLICY.cooldownMs,
  quietStartMinute: null,
  quietEndMinute: null,
  mutedProtocols: [],
  mutedPositions: [],
  digest: "off",
};

/** The key a per-position mute is stored under. */
export function positionKey(wallet: string, protocol: Protocol): string {
  return `${wallet.trim().toLowerCase()}:${protocol}`;
}

/**
 * Is this alert critical, i.e. exempt from every quietness preference?
 *
 * Two ways in, and the union is deliberately generous: "over the limit the USER
 * chose" and "the engine's own top band". Either one is a message about a
 * position that can be liquidated, and the cost of being wrong is asymmetric -
 * one extra alert against a warning that arrived after the liquidation.
 */
export function isCriticalAlert(toStatus: ProfileStatus, band: Band | null | undefined): boolean {
  return toStatus === "outside" || band === "CRITICAL";
}

/**
 * The cooldown that actually applies. A critical alert can only ever be
 * cooled down for LESS than the engine default, never more.
 */
export function effectiveCooldownMs(settings: AlertSettings, critical: boolean): number {
  return critical ? Math.min(settings.cooldownMs, ALERT_POLICY.cooldownMs) : settings.cooldownMs;
}

/** Is `atMs` inside the user's quiet window? False when they set none. */
export function inQuietHours(atMs: number, settings: AlertSettings): boolean {
  const { quietStartMinute: start, quietEndMinute: end } = settings;
  if (start === null || end === null || start === end) return false;
  const minute = Math.floor((atMs % 86_400_000) / 60_000);
  // A window that wraps midnight is two ranges, not one comparison.
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isMuted(settings: AlertSettings, wallet: string, protocol: Protocol): boolean {
  return (
    settings.mutedProtocols.includes(protocol) ||
    settings.mutedPositions.includes(positionKey(wallet, protocol))
  );
}

/**
 * When the digest holding these alerts is due to go out, or null when the user
 * is not in digest mode.
 *
 * The clock starts at the last digest, or - for a user who has never had one -
 * at the OLDEST alert now waiting. That is what makes the 15s dispatcher pass
 * the scheduler: no cron, and a first digest cannot fire the instant the first
 * alert lands, which would batch nothing and just add a wrapper to one message.
 */
export function digestDueAtMs(
  settings: AlertSettings,
  lastDigestAtMs: number | null,
  oldestHeldAtMs: number,
): number | null {
  if (settings.digest === "off") return null;
  return (lastDigestAtMs ?? oldestHeldAtMs) + DIGEST_INTERVAL_MS[settings.digest];
}

// ── request parsing ──────────────────────────────────────────────────────────

/**
 * Validate a settings body into an `AlertSettings`, or explain what is wrong.
 *
 * REJECT, never repair: these values decide whether someone is warned before a
 * liquidation, so a malformed cooldown must not quietly become the default the
 * caller did not ask for (same rule as `parseWatchlistOps`). An ABSENT field is
 * different from a malformed one and means "use the default" - the endpoint
 * writes a whole row, so a partial body is a full reset to defaults plus the
 * fields it names.
 */
export function parseAlertSettings(body: unknown): { settings: AlertSettings } | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const out: AlertSettings = { ...DEFAULT_ALERT_SETTINGS };

  if (raw.minBorrowUsd !== undefined) {
    const v = raw.minBorrowUsd;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { error: "minBorrowUsd must be a number of dollars, zero or more" };
    }
    out.minBorrowUsd = v;
  }

  if (raw.cooldownMinutes !== undefined) {
    const v = raw.cooldownMinutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > COOLDOWN_MINUTES_MAX) {
      return { error: `cooldownMinutes must be a whole number of minutes between 0 and ${COOLDOWN_MINUTES_MAX}` };
    }
    out.cooldownMs = v * 60_000;
  }

  const minute = (value: unknown, field: string): number | null | { error: string } => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY) {
      return { error: `${field} must be minutes past midnight UTC (0-1439) or null` };
    }
    return value;
  };
  if (raw.quietStartMinute !== undefined) {
    const v = minute(raw.quietStartMinute, "quietStartMinute");
    if (typeof v === "object" && v !== null) return v;
    out.quietStartMinute = v;
  }
  if (raw.quietEndMinute !== undefined) {
    const v = minute(raw.quietEndMinute, "quietEndMinute");
    if (typeof v === "object" && v !== null) return v;
    out.quietEndMinute = v;
  }
  // Half a window silences nothing and would read on the settings screen as if
  // it did, which is the same class of lie as rendering an unknown as a zero.
  if ((out.quietStartMinute === null) !== (out.quietEndMinute === null)) {
    return { error: "quiet hours need both quietStartMinute and quietEndMinute, or neither" };
  }

  if (raw.mutedProtocols !== undefined) {
    if (!Array.isArray(raw.mutedProtocols)) return { error: "mutedProtocols must be an array" };
    if (raw.mutedProtocols.length > MUTE_MAX) return { error: `mutedProtocols holds at most ${MUTE_MAX} entries` };
    const list: Protocol[] = [];
    for (const entry of raw.mutedProtocols) {
      if (typeof entry !== "string" || !(PROTOCOLS as readonly string[]).includes(entry)) {
        return { error: `mutedProtocols entries must be one of ${PROTOCOLS.join(", ")}` };
      }
      if (!list.includes(entry as Protocol)) list.push(entry as Protocol);
    }
    out.mutedProtocols = list;
  }

  if (raw.mutedPositions !== undefined) {
    if (!Array.isArray(raw.mutedPositions)) return { error: "mutedPositions must be an array" };
    if (raw.mutedPositions.length > MUTE_MAX) return { error: `mutedPositions holds at most ${MUTE_MAX} entries` };
    const list: string[] = [];
    for (const entry of raw.mutedPositions) {
      if (typeof entry !== "string") return { error: "mutedPositions entries must be strings" };
      const [wallet, protocol] = entry.trim().toLowerCase().split(":");
      if (!/^0x[0-9a-f]{40}$/.test(wallet ?? "") || !(PROTOCOLS as readonly string[]).includes(protocol ?? "")) {
        return { error: "mutedPositions entries must look like 0x<address>:<protocol>" };
      }
      const key = `${wallet}:${protocol}`;
      if (!list.includes(key)) list.push(key);
    }
    out.mutedPositions = list;
  }

  if (raw.digest !== undefined) {
    if (raw.digest !== "off" && raw.digest !== "hourly" && raw.digest !== "daily") {
      return { error: "digest must be one of off, hourly, daily" };
    }
    out.digest = raw.digest;
  }

  return { settings: out };
}
