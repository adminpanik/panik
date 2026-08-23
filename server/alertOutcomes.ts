/**
 * Observed alert quality (7.3): how many delivered alerts were followed by the
 * position getting worse, and how many by it simply going away again.
 *
 * The pairing is `public.watch_alert_outcomes`
 * (supabase/migrations/20260823000001_alert_outcomes.sql) - one row per alert a
 * person actually received, with what the position did next. This file only
 * counts them, per subscriber and in aggregate.
 *
 * ── SAY WHAT WAS MEASURED, NOT WHAT IT FLATTERS ────────────────────────────
 * `falseAlarms` is "resolved without escalating". The database cannot tell an
 * alert that was wrong from an alert the user acted on - both end with the
 * position back under the limit - so `falseAlarmRate` is an UPPER BOUND on how
 * often we cried wolf, and every surface quoting it has to say so. The engine's
 * own backtest documents ~24-27% intrinsic false alarms (params.ALERT_POLICY),
 * which is the number this exists to make honest rather than hide.
 *
 * `decided` is the denominator, NOT the alert count: an alert whose position
 * has not moved since is not evidence either way, and folding it into the
 * denominator would make a quiet week look like an accurate one.
 */

export interface AlertOutcomeQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface AlertOutcomeStats {
  /** Alerts actually delivered (every bucket, pending included). */
  alerts: number;
  /** Alerts whose position later crossed further out. */
  escalated: number;
  /** Alerts whose position returned under the limit without getting worse. */
  falseAlarms: number;
  /** Alerts with no subsequent move yet. Not evidence, so not in the rate. */
  pending: number;
  /** escalated + falseAlarms. The rate's denominator. */
  decided: number;
  /**
   * falseAlarms / decided, 0-1, rounded to three decimals. NULL when nothing
   * has been decided yet - a rate of "0%" from zero evidence is the
   * unknown-rendered-as-zero bug, in the one place it would be most flattering.
   */
  falseAlarmRate: number | null;
  /** Window the figures cover. Null when there are no delivered alerts at all. */
  firstAlertAt: string | null;
  lastAlertAt: string | null;
}

/**
 * `$1` null = aggregate over every subscriber; otherwise one owner's alerts.
 * One statement for both, so the per-user number and the product-wide number
 * can never be computed two different ways.
 */
export const OUTCOME_STATS_SQL = `select count(*)::int                                          as alerts,
            count(*) filter (where outcome = 'escalated')::int as escalated,
            count(*) filter (where outcome = 'resolved')::int  as false_alarms,
            count(*) filter (where outcome = 'pending')::int   as pending,
            min(alerted_at) as first_alert_at,
            max(alerted_at) as last_alert_at
       from public.watch_alert_outcomes
      where ($1::text is null or owner_wallet = $1::text)`;

const int = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value !== "" ? value : null;
};

export function toOutcomeStats(raw: unknown): AlertOutcomeStats {
  const row = (raw ?? {}) as Record<string, unknown>;
  const escalated = int(row.escalated);
  const falseAlarms = int(row.false_alarms);
  const decided = escalated + falseAlarms;
  return {
    alerts: int(row.alerts),
    escalated,
    falseAlarms,
    pending: int(row.pending),
    decided,
    falseAlarmRate: decided === 0 ? null : Math.round((falseAlarms / decided) * 1000) / 1000,
    firstAlertAt: iso(row.first_alert_at),
    lastAlertAt: iso(row.last_alert_at),
  };
}

/** One subscriber's observed alert quality, or the whole product's when null. */
export async function fetchAlertOutcomes(
  db: AlertOutcomeQueryable,
  ownerWallet: string | null,
): Promise<AlertOutcomeStats> {
  const { rows } = await db.query(OUTCOME_STATS_SQL, [
    ownerWallet ? ownerWallet.trim().toLowerCase() : null,
  ]);
  return toOutcomeStats(rows[0] ?? {});
}
