/**
 * Shared helpers for the admin campaign endpoints (api/admin/campaigns.ts,
 * api/admin/redemptions.ts and their mirrored Express routes). Keeps auth,
 * input validation and the two decisions that write - create a campaign, clear
 * one person's use of a code - in one place, so the two transports stay in
 * lockstep.
 *
 * Auth: a shared secret in ADMIN_ACCESS_KEY, sent by the admin page as the
 * `x-admin-key` header - the same header-secret pattern as the Telegram webhook
 * (x-telegram-bot-api-secret-token).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  normalizeGrantEmail,
  type Campaign,
  type CreateCampaignInput,
  type TrialGrantRow,
} from "./campaignStore";

export type AdminAuth = "ok" | "unconfigured" | "forbidden";

/**
 * Timing-safe shared-secret check. Compares SHA-256 digests, not the raw
 * strings: the digests are always 32 bytes, so timingSafeEqual never throws on
 * a length mismatch and the comparison leaks neither length nor prefix.
 */
export function checkAdminKey(provided: string | undefined): AdminAuth {
  const expected = process.env.ADMIN_ACCESS_KEY;
  if (!expected) return "unconfigured";
  if (!provided) return "forbidden";
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "forbidden";
}

export interface RawCreateBody {
  label?: unknown;
  trialDays?: unknown;
  maxRedemptions?: unknown;
  /** Optional campaign-level claim cutoff, in days from creation. */
  claimWindowDays?: unknown;
  /**
   * Replay guard the client mints once via `crypto.randomUUID()` when the
   * create form opens, and echoes on every submit of that same form (see
   * CampaignsPanel.tsx). A second POST carrying a key already seen here
   * returns the campaign that key already minted instead of creating another
   * one, which is what makes a double-click or a retried request safe.
   */
  idempotencyKey?: unknown;
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

// ── create-campaign replay guard ────────────────────────────────────────────
//
// This is a double-click / retried-request guard on a single-operator admin
// console, not a durable dedupe contract, so it is a per-process Map with a
// TTL rather than a database column: a migration plus a unique index plus a
// conflict-handling path is disproportionate for that threat model, and the
// client-side ref guard in CampaignsPanel.tsx already closes the common case
// (the same click racing `busy` state within one frame). This is the
// belt-and-suspenders second layer for a submit that reaches the network
// twice anyway - a slow double click, or a client retry after a dropped
// response whose request actually landed.
//
// The Express route in scripts/api-server.ts is the path that matters: it is
// a long-lived Railway process, so the cache persists for the lifetime of the
// key. The Vercel mirror in api/admin/campaigns.ts shares this module for
// consistency, but per CLAUDE.md that surface is vercelignored and does not
// serve traffic, so a cold start losing its cache there is not a regression.

/** Long enough to cover a double click or a same-form retry; short enough
 * that a stale key cannot block a legitimately new campaign later. */
const IDEMPOTENCY_TTL_MS = 5 * 60_000;

const idempotencyCache = new Map<string, { campaign: Campaign; expiresAt: number }>();

function pruneIdempotencyCache(now: number): void {
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt <= now) idempotencyCache.delete(key);
  }
}

function normalizeKey(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** The campaign already minted for this key, or null if the key is new, blank, or expired. */
export function campaignForIdempotencyKey(rawKey: unknown): Campaign | null {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const now = Date.now();
  pruneIdempotencyCache(now);
  const entry = idempotencyCache.get(key);
  return entry && entry.expiresAt > now ? entry.campaign : null;
}

/** Record which campaign a key minted, so a replay of the same key short-circuits. */
export function rememberCampaignForIdempotencyKey(rawKey: unknown, campaign: Campaign): void {
  const key = normalizeKey(rawKey);
  if (!key) return;
  idempotencyCache.set(key, { campaign, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}

/** What either transport's create route needs from the store: just the mint call. */
export interface CreateCampaignDeps {
  createCampaign(input: CreateCampaignInput): Promise<Campaign>;
}

export interface CreateCampaignResult {
  status: 200 | 201 | 400;
  campaign?: Campaign;
  error?: string;
}

/**
 * Validate, then mint - unless `body.idempotencyKey` was already seen, in
 * which case this returns the campaign that key minted (status 200) instead
 * of validating or minting again. The one place both transports (the Express
 * route and the Vercel mirror) call, so the replay guard cannot drift between
 * them the way two hand-written copies of this sequence could.
 */
export async function createCampaignIdempotent(
  body: RawCreateBody,
  deps: CreateCampaignDeps,
): Promise<CreateCampaignResult> {
  const replay = campaignForIdempotencyKey(body.idempotencyKey);
  if (replay) return { status: 200, campaign: replay };

  const { input, error } = buildCreateInput(body);
  if (error) return { status: 400, error };

  const campaign = await deps.createCampaign(input!);
  rememberCampaignForIdempotencyKey(body.idempotencyKey, campaign);
  return { status: 201, campaign };
}

// ── clearing one person's use of a code ─────────────────────────────────────
//
// One trial code is good for one account. Once the access it bought is over,
// `redeem_campaign_code` refuses the same code from the same address with
// `already_used` (supabase/migrations/20260901000001_one_code_one_account.sql).
// This is the operator's way to hand it back: delete that address's grant row,
// which frees the (campaign_id, lower(email)) slot the unique index holds, so
// the next redemption falls through to the ordinary mint path.
//
// WHAT IT DELIBERATELY DOES NOT DO. `redemption_count` is not decremented: it
// is a running total of successful redemptions and never a live population
// (the argument is set out at length in 20260831000001), so giving a slot back
// here would hand the campaign capacity its operator never authorised, and the
// re-redemption then takes a real one. The attempt log is not edited either:
// it is what the 2026-08-31 incident was reconstructed from, and the attempt
// that minted this grant keeps its row, its outcome and its timestamp. Only
// its `granted_token_id` pointer nulls, through the ON DELETE SET NULL the FK
// was declared with.
//
// Reached only through the admin gate (server/adminGate.ts), from
// POST /api/admin/redemptions in scripts/api-server.ts and its
// api/admin/redemptions.ts mirror, on the same adminLimit as its siblings.

/** What the operator gets back after a use is cleared. No access token. */
export interface ClearedUse {
  code: string;
  email: string;
  grantId: string;
  /** When that grant was redeemed, so the audit trail reads as a history. */
  redeemedAt: string;
  clearedAt: string;
}

export type ClearUseOutcome = "cleared" | "missing_code" | "missing_email" | "no_redemption";

export type ClearUseResult =
  | { outcome: "cleared"; cleared: ClearedUse }
  | { outcome: Exclude<ClearUseOutcome, "cleared"> };

/**
 * What each refusal answers with, status and sentence together so a new
 * outcome cannot be added without deciding both. Same shape and same reason as
 * `END_TRIAL_REFUSAL` in server/adminTrials.ts.
 *
 * `no_redemption` names both halves of what was looked for, because this route
 * is behind the admin gate and an operator who mistyped needs to know which
 * one missed. It is also the honest answer when another operator cleared the
 * same row a moment earlier.
 */
export const CLEAR_USE_REFUSAL: Record<
  Exclude<ClearUseOutcome, "cleared">,
  { status: number; error: string }
> = {
  missing_code: { status: 400, error: "missing code" },
  missing_email: { status: 400, error: "missing email" },
  no_redemption: { status: 404, error: "that address has no redemption of this code on file" },
};

/** The parts of the store the decision below actually uses. */
export interface ClearUseDeps {
  findGrant(code: string, email: string): Promise<TrialGrantRow | null>;
  deleteGrant(id: string): Promise<boolean>;
}

export interface ClearUseInput {
  code: unknown;
  email: unknown;
  /** The signed-in operator, for the audit line. Null on the shared-secret path. */
  actor?: string | null;
  now?: number;
}

/**
 * Clear one address's use of one code.
 *
 * Transport-free so both routes call one decision, and so the four answers can
 * be pinned without a database. The audit line is written HERE, on the success
 * path only: an operator action that hands a spent voucher back has to leave a
 * trace wherever it was invoked from.
 */
export async function clearRedemptionUse(
  deps: ClearUseDeps,
  input: ClearUseInput,
): Promise<ClearUseResult> {
  // The same normalization the SQL applies (upper(btrim(...))), so a code
  // pasted with stray case or spaces still resolves.
  const code = String(input.code ?? "").trim().toUpperCase();
  if (code === "") return { outcome: "missing_code" };
  const email = normalizeGrantEmail(input.email as string | null | undefined);
  if (email === "") return { outcome: "missing_email" };

  const grant = await deps.findGrant(code, email);
  if (!grant) return { outcome: "no_redemption" };

  // Targeted by id, so two operators clearing the same row leave one winner
  // and one honest "no redemption on file": the database decides, not a read
  // this code did a moment earlier.
  const gone = await deps.deleteGrant(grant.id);
  if (!gone) return { outcome: "no_redemption" };

  const clearedAt = new Date(input.now ?? Date.now()).toISOString();
  // Address, code, grant, who did it and when. No access token and no key,
  // because a log line is not a place to move a credential.
  console.log(
    `admin voucher clear use: ${email} on ${code} (grant ${grant.id}) ` +
      `by ${input.actor ?? "shared-secret"} at ${clearedAt}`,
  );

  return {
    outcome: "cleared",
    cleared: { code, email, grantId: grant.id, redeemedAt: grant.created_at, clearedAt },
  };
}
