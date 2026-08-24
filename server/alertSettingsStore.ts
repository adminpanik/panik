/**
 * Reading and writing one subscriber's alert settings (7.4 / 7.5).
 *
 * The VALUES, the validation and the predicates live in the engine
 * (packages/scoring/src/watch/alertSettings.ts) because the dispatcher decides
 * with them and the engine is where a decision belongs. This file is the row:
 * one decoder, one upsert, and the digest bookkeeping.
 *
 * THE CALLER IS ALREADY AUTHENTICATED. `ownerWallet` reaching `saveAlertSettings`
 * means a SIWE proof for `urn:panik:action:alert-settings` verified. Nothing
 * here re-checks that and nothing here may be called on an unproven address -
 * these columns decide whether somebody is warned before a liquidation, so
 * writing them on an address the caller merely named is a silent-failure attack,
 * not a validation slip.
 */

import {
  DEFAULT_ALERT_SETTINGS,
  type AlertSettings,
  type DigestFrequency,
} from "../packages/scoring/src/watch/alertSettings";
import type { Protocol } from "../packages/scoring/src/types";

/** The slice of `pg.Pool` this module uses. */
export interface AlertSettingsQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Settings plus the bookkeeping only the dispatcher cares about. */
export interface StoredAlertSettings {
  settings: AlertSettings;
  /** When the last digest was sent, or null if this user has never had one. */
  lastDigestAt: string | null;
}

const numberOrNull = (value: unknown): number | null => {
  // numeric arrives from pg as a string; a bad one is "unknown", never a zero.
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * One `alert_settings` row (or the jsonb the drain selects) into settings.
 *
 * A null column means "use the engine default", so a row that exists only to
 * hold `last_digest_at` behaves exactly like no row at all. Unrecognised values
 * fall back the same way rather than throwing: a settings column no code
 * understands must not be able to stop an alert going out.
 */
export function decodeAlertSettings(raw: unknown): StoredAlertSettings {
  const row = (raw ?? {}) as Record<string, unknown>;
  const cooldownMinutes = numberOrNull(row.cooldown_minutes);
  const digest = row.digest_frequency;
  return {
    settings: {
      minBorrowUsd: numberOrNull(row.min_borrow_usd) ?? DEFAULT_ALERT_SETTINGS.minBorrowUsd,
      cooldownMs:
        cooldownMinutes === null ? DEFAULT_ALERT_SETTINGS.cooldownMs : cooldownMinutes * 60_000,
      quietStartMinute: numberOrNull(row.quiet_start_minute),
      quietEndMinute: numberOrNull(row.quiet_end_minute),
      mutedProtocols: stringList(row.muted_protocols) as Protocol[],
      mutedPositions: stringList(row.muted_positions),
      digest:
        digest === "hourly" || digest === "daily" || digest === "off"
          ? (digest as DigestFrequency)
          : DEFAULT_ALERT_SETTINGS.digest,
    },
    // pg hands back a Date for timestamptz; `to_jsonb(a)` in the drain's join
    // hands back an ISO string. Both mean the same instant.
    lastDigestAt:
      row.last_digest_at instanceof Date
        ? row.last_digest_at.toISOString()
        : typeof row.last_digest_at === "string"
          ? row.last_digest_at
          : null,
  };
}

const SELECT_SQL = `select min_borrow_usd, cooldown_minutes, quiet_start_minute, quiet_end_minute,
            muted_protocols, muted_positions, digest_frequency, last_digest_at
       from public.alert_settings
      where owner_wallet = $1`;

/**
 * One subscriber's settings. A missing row is the DEFAULTS, not an error: every
 * user has settings, most have never touched them.
 */
export async function loadAlertSettings(
  db: AlertSettingsQueryable,
  ownerWallet: string,
): Promise<StoredAlertSettings> {
  const { rows } = await db.query(SELECT_SQL, [ownerWallet.trim().toLowerCase()]);
  return decodeAlertSettings(rows[0] ?? {});
}

/**
 * Write the whole row. `last_digest_at` is deliberately NOT touched: it is the
 * dispatcher's bookkeeping, and a user saving their preferences must not be
 * able to reset the digest clock (which would let a settings save flush, or
 * indefinitely postpone, a batch of held alerts).
 */
const UPSERT_SQL = `insert into public.alert_settings
         (owner_wallet, min_borrow_usd, cooldown_minutes, quiet_start_minute, quiet_end_minute,
          muted_protocols, muted_positions, digest_frequency)
       values ($1, $2::numeric, $3::integer, $4::integer, $5::integer, $6::text[], $7::text[], $8::text)
       on conflict (owner_wallet) do update
          set min_borrow_usd     = excluded.min_borrow_usd,
              cooldown_minutes   = excluded.cooldown_minutes,
              quiet_start_minute = excluded.quiet_start_minute,
              quiet_end_minute   = excluded.quiet_end_minute,
              muted_protocols    = excluded.muted_protocols,
              muted_positions    = excluded.muted_positions,
              digest_frequency   = excluded.digest_frequency`;

export async function saveAlertSettings(
  db: AlertSettingsQueryable,
  ownerWallet: string,
  settings: AlertSettings,
): Promise<void> {
  await db.query(UPSERT_SQL, [
    ownerWallet.trim().toLowerCase(),
    settings.minBorrowUsd,
    Math.round(settings.cooldownMs / 60_000),
    settings.quietStartMinute,
    settings.quietEndMinute,
    [...settings.mutedProtocols],
    [...settings.mutedPositions],
    settings.digest,
  ]);
}

/** Stamp a digest as sent. Creates the row when the user only has defaults. */
export const DIGEST_SENT_SQL = `insert into public.alert_settings (owner_wallet, last_digest_at)
       values ($1, now())
       on conflict (owner_wallet) do update set last_digest_at = now()`;

export async function markDigestSent(
  db: AlertSettingsQueryable,
  ownerWallet: string,
): Promise<void> {
  await db.query(DIGEST_SENT_SQL, [ownerWallet.trim().toLowerCase()]);
}

/** The settings as the API returns them. Minutes, not milliseconds. */
export function toWireSettings(stored: StoredAlertSettings): Record<string, unknown> {
  const s = stored.settings;
  return {
    minBorrowUsd: s.minBorrowUsd,
    cooldownMinutes: Math.round(s.cooldownMs / 60_000),
    quietStartMinute: s.quietStartMinute,
    quietEndMinute: s.quietEndMinute,
    mutedProtocols: s.mutedProtocols,
    mutedPositions: s.mutedPositions,
    digest: s.digest,
    lastDigestAt: stored.lastDigestAt,
  };
}
