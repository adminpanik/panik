/**
 * Shared helpers for the admin campaign endpoints (api/admin/campaigns.ts and
 * the mirrored Express route). Keeps auth + input validation in one place so the
 * two transports stay in lockstep.
 *
 * Auth: a shared secret in ADMIN_ACCESS_KEY, sent by the admin page as the
 * `x-admin-key` header - the same header-secret pattern as the Telegram webhook
 * (x-telegram-bot-api-secret-token).
 */

import type { CreateCampaignInput } from "./campaignStore";

export type AdminAuth = "ok" | "unconfigured" | "forbidden";

/** Timing-safe-ish shared-secret check. */
export function checkAdminKey(provided: string | undefined): AdminAuth {
  const expected = process.env.ADMIN_ACCESS_KEY;
  if (!expected) return "unconfigured";
  return provided && provided === expected ? "ok" : "forbidden";
}

export interface RawCreateBody {
  label?: unknown;
  trialDays?: unknown;
  maxRedemptions?: unknown;
  /** Optional campaign-level claim cutoff, in days from creation. */
  claimWindowDays?: unknown;
}

/** Validate + normalize the create-campaign body. Returns an error string or the input. */
export function buildCreateInput(body: RawCreateBody): { input?: CreateCampaignInput; error?: string } {
  const trialDays = Number(body.trialDays);
  const maxRedemptions = Number(body.maxRedemptions);
  if (!Number.isFinite(trialDays) || trialDays <= 0) return { error: "trialDays must be a positive number" };
  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) return { error: "maxRedemptions must be a positive integer" };

  let claimWindowExpiresAt: string | null = null;
  if (body.claimWindowDays !== undefined && body.claimWindowDays !== null && String(body.claimWindowDays) !== "") {
    const days = Number(body.claimWindowDays);
    if (!Number.isFinite(days) || days <= 0) return { error: "claimWindowDays must be a positive number" };
    claimWindowExpiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : null;

  return {
    input: {
      label,
      maxRedemptions,
      trialDurationHours: Math.round(trialDays * 24),
      claimWindowExpiresAt,
    },
  };
}
