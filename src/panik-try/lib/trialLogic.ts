/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure, DB-free decision logic for the trial-code feature. This mirrors the SQL
 * in supabase/migrations/20260704000001_product_codes.sql so the frontend can
 * label campaign/trial state without a round-trip, and so the rules are unit-
 * testable without a database. Keep in sync with the SQL functions.
 */

/** Outcomes of a redemption attempt (mirrors redeem_campaign_code in SQL). */
export type RedeemOutcome = "success" | "not_found" | "disabled" | "expired" | "exhausted";

export type CampaignStatus = "active" | "exhausted" | "expired" | "disabled";

export interface CampaignLike {
  is_active: boolean;
  redemption_count: number;
  max_redemptions: number;
  /** ISO timestamp, or null for no campaign-level claim deadline. */
  claim_window_expires_at: string | null;
}

/**
 * Derived campaign status. Precedence matches redeem_campaign_code:
 * disabled (kill switch) → expired (claim window) → exhausted (usage) → active.
 * Whichever limit is hit first wins.
 */
export function evaluateCampaign(c: CampaignLike, now: Date = new Date()): CampaignStatus {
  if (!c.is_active) return "disabled";
  if (
    c.claim_window_expires_at &&
    now.getTime() >= new Date(c.claim_window_expires_at).getTime()
  ) {
    return "expired";
  }
  if (c.redemption_count >= c.max_redemptions) return "exhausted";
  return "active";
}

/** Per-user trial expiry = first app-open + duration. */
export function computeTrialExpiry(firstOpenedAt: Date, durationHours: number): Date {
  return new Date(firstOpenedAt.getTime() + durationHours * 3_600_000);
}

export type TrialAccessStatus = "active" | "expired" | "invalid";

export interface GrantLike {
  /** null until the first app open (clock not started yet). */
  first_opened_at: string | null;
  /** null until the first app open. */
  expires_at: string | null;
}

/**
 * Per-user trial status. A grant that has never been opened is still "active"
 * (opening it will start the clock). Unknown/missing token → "invalid".
 */
export function evaluateTrialAccess(
  grant: GrantLike | null | undefined,
  now: Date = new Date(),
): TrialAccessStatus {
  if (!grant) return "invalid";
  if (!grant.first_opened_at || !grant.expires_at) return "active";
  return now.getTime() >= new Date(grant.expires_at).getTime() ? "expired" : "active";
}

/** Normalize a code from user input or a URL (uppercased, trimmed). */
export function normalizeCode(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/**
 * Read the campaign code from a URL query string (the scan path). Returns null
 * when no `code` param is present (the no-scan / manual-input fallback path).
 * Accepts either a full search string ("?code=ABC") or a bare one ("code=ABC").
 */
export function parseCode(search: string): string | null {
  const code = normalizeCode(new URLSearchParams(search).get("code"));
  return code || null;
}

/** Milliseconds → compact "2d 3h" / "5h 12m" / "8m" remaining label. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
