/**
 * Shared helpers for the admin campaign endpoints (api/admin/campaigns.ts and
 * the mirrored Express route). Keeps auth + input validation in one place so the
 * two transports stay in lockstep.
 *
 * Auth: a shared secret in ADMIN_ACCESS_KEY, sent by the admin page as the
 * `x-admin-key` header - the same header-secret pattern as the Telegram webhook
 * (x-telegram-bot-api-secret-token).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { Campaign, CreateCampaignInput } from "./campaignStore";

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
