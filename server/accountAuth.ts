/**
 * The account boundary: who is calling, and are they in the closed beta yet.
 *
 * Identity is a SUPABASE AUTH USER. The SPA signs in with an email magic link
 * and carries the resulting access token as `Authorization: Bearer <jwt>`, the
 * same shape the admin console already uses (src/panik-admin/lib/supabaseAuth.ts
 * on the client, server/adminIdentity.ts on the server).
 *
 * ── WHY WE ASK SUPABASE INSTEAD OF VERIFYING THE JWT LOCALLY ───────────────
 * Two approaches were available and only one is configurable in this repo.
 *
 *   (a) Verify the signature locally with the project's JWT secret. Cheapest
 *       per request, but there is no such variable in .env.example and none of
 *       Railway, Vercel or the worker has ever been given one. Adding a new
 *       secret to every deployment target - and to the "what do I rotate when
 *       this leaks" list - to save a round trip on a route the user hits a
 *       handful of times per session is a bad trade. It also cannot see
 *       revocation: a signed-out or deleted session still produces a
 *       signature-valid token until its `exp`.
 *
 *   (b) Ask `GET /auth/v1/user` with the presented bearer. SUPABASE_URL and a
 *       key are already set everywhere in this codebase, so this needs no new
 *       configuration at all, and the answer accounts for the signature, the
 *       expiry AND the session's revocation state.
 *
 * (b) it is, exactly as server/adminIdentity.ts decided for /api/admin/*. No
 * new runtime dependency: plain fetch, no @supabase/supabase-js.
 *
 * ── THE CACHE, AND WHY THIS FILE HAS ONE WHEN adminIdentity DOES NOT ───────
 * adminIdentity refuses to cache: there is one admin, the console makes a
 * handful of requests, and a cache there is purely a window in which a
 * signed-out operator still opens the door. The account surface is different in
 * degree - every user, every page load - so an uncached design turns one
 * outbound round trip into the latency floor of the whole app and makes
 * Supabase Auth a hard dependency of every read.
 *
 * The cache is therefore deliberately SHORT (60s), POSITIVE-ONLY, and clamped
 * to the token's own `exp` so it can never outlive the credential. A failure is
 * never cached: a 401 must be re-asked, or an outage would pin every user out
 * for a minute. The window it opens is real and bounded: for up to 60 seconds
 * after a sign-out, a stolen token still resolves. That is the same order as
 * every JWT-expiry design and much shorter than the token's own hour.
 *
 * Keys are SHA-256 of the token, never the token: a heap dump of this process
 * must not be a list of live bearer credentials.
 *
 * ── ON TIMING-SAFE COMPARISON ──────────────────────────────────────────────
 * There is no secret compared in this module. The only credential in the
 * exchange is the bearer, and the only party that compares it is Supabase. The
 * cache lookup is a hash-keyed map probe, not a byte comparison of a secret,
 * and the membership check compares a status string and a timestamp. The
 * timing-safe comparisons in this codebase live where a secret really is
 * compared locally: server/adminAuth.ts (the shared admin key) and
 * server/sessionStore.ts (session token hashes).
 */

import { createHash } from "node:crypto";
// Aliased: the GoTrue call below uses the global fetch Response, and two types
// named Response in one module is a bug waiting to be typed over.
import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from "express";

import { bearerToken } from "./adminIdentity";
import { LruCache } from "./lruCache";
import { AccountStore, isLiveMembership, type Membership } from "./accountStore";

export { bearerToken };

/** Tokens longer than this are refused before we spend a network call. */
const MAX_TOKEN_CHARS = 4_096;

/** How long a resolved identity may be reused. See the header note. */
export const IDENTITY_CACHE_MS = 60_000;

/** Cap on cached identities, so the map cannot grow one stranger at a time. */
const IDENTITY_CACHE_MAX = 5_000;

/** What the beta gate says. One sentence, no jargon, and it names the fix. */
export const CLOSED_BETA_MESSAGE = "closed beta - a voucher code is needed";

export interface AccountIdentity {
  /** auth.users.id — the account's primary key everywhere in this codebase. */
  userId: string;
  email: string;
}

/** Identity plus the beta verdict, stamped on res.locals.account. */
export interface AccountContext extends AccountIdentity {
  /** The account's live grant, or null when it has none. */
  membership: Membership | null;
}

export type AccountVerdict =
  | ({ ok: true } & AccountIdentity)
  | { ok: false; status: 401 | 502 | 503; error: string };

export interface AccountAuthDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Injected in tests; production resolves it from env per request. */
  store?: AccountStore;
}

interface CachedIdentity extends AccountIdentity {
  /** Epoch ms after which this entry must be re-resolved. */
  goodUntil: number;
}

let identityCache = new LruCache<CachedIdentity>(IDENTITY_CACHE_MAX);

/**
 * Drop every cached identity. Tests only — a shared cache would otherwise let
 * one case's resolved token satisfy the next case's assertion about a round
 * trip that should have happened.
 */
export function clearIdentityCache(): void {
  identityCache = new LruCache<CachedIdentity>(IDENTITY_CACHE_MAX);
}

/**
 * The `apikey` header GoTrue requires alongside the bearer. Same precedence as
 * server/adminIdentity.ts: the publishable key first (it authorizes nothing on
 * its own), the secret key only so a deploy that never set one still works.
 */
function supabaseApiKey(): string | undefined {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_SECRET_KEY
  );
}

const tokenKey = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Cheap shape + expiry screen. NOT verification: the payload is read without
 * checking the signature, so `exp` here is only "worth asking Supabase". A
 * forged token sails through and is rejected by the round trip.
 *
 * Returns the claimed expiry in epoch ms (or null), so the cache can be clamped
 * to it. Clamping to an attacker-controlled claim is safe in the only direction
 * that matters: a LOWER exp shortens the cache, and a higher one is bounded by
 * IDENTITY_CACHE_MS regardless.
 */
function claimedExpiry(token: string, now: number): { plausible: boolean; expMs: number | null } {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return { plausible: false, expMs: null };
  const parts = token.split(".");
  if (parts.length !== 3) return { plausible: false, expMs: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== "number") return { plausible: true, expMs: null };
    const expMs = payload.exp * 1000;
    return { plausible: expMs > now, expMs };
  } catch {
    return { plausible: false, expMs: null };
  }
}

/**
 * Resolve a bearer token to the account it belongs to, or say why not. Never
 * throws. Error strings are coarse on purpose: they tell the caller which wall
 * they hit without confirming whether an address has an account.
 */
export async function verifyAccountToken(
  token: string,
  deps: AccountAuthDeps = {},
): Promise<AccountVerdict> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = (deps.now ?? Date.now)();

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const apikey = supabaseApiKey();
  if (!url || !apikey) {
    return { ok: false, status: 503, error: "sign-in unconfigured (SUPABASE_URL / key)" };
  }

  const { plausible, expMs } = claimedExpiry(token, now);
  if (!plausible) return { ok: false, status: 401, error: "session expired or invalid" };

  const key = tokenKey(token);
  const hit = identityCache.get(key);
  if (hit && hit.goodUntil > now) {
    return { ok: true, userId: hit.userId, email: hit.email };
  }

  let res: Response;
  try {
    res = await doFetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
  } catch {
    // Upstream unreachable. Failing closed is the only safe direction.
    return { ok: false, status: 502, error: "could not reach the sign-in service" };
  }

  if (res.status === 401 || res.status === 403) {
    // Whatever we believed about this token a moment ago is now wrong.
    identityCache.delete(key);
    return { ok: false, status: 401, error: "session expired or invalid" };
  }
  if (!res.ok) return { ok: false, status: 502, error: "could not reach the sign-in service" };

  let user: { id?: unknown; email?: unknown };
  try {
    user = (await res.json()) as { id?: unknown; email?: unknown };
  } catch {
    return { ok: false, status: 502, error: "could not reach the sign-in service" };
  }

  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (typeof user.id !== "string" || user.id === "" || email === "") {
    return { ok: false, status: 401, error: "session expired or invalid" };
  }

  // Never past the token's own expiry, never longer than the cache window.
  const goodUntil = Math.min(now + IDENTITY_CACHE_MS, expMs ?? Number.POSITIVE_INFINITY);
  if (goodUntil > now) identityCache.set(key, { userId: user.id, email, goodUntil });
  return { ok: true, userId: user.id, email };
}

/** Is this account inside the closed beta right now? */
export function isMember(membership: Membership | null, now = Date.now()): boolean {
  return membership !== null && isLiveMembership(membership, now);
}

/**
 * Express middleware: resolve the bearer, load the account's membership, and
 * stamp both on `res.locals.account`. 401 when there is no live session.
 *
 * It does NOT gate on membership — GET /api/account has to answer a signed-in
 * account with no voucher, or the SPA has no way to render the screen that asks
 * for one. Pair it with `requireMember` on everything else.
 */
export function requireAccount(deps: AccountAuthDeps = {}): RequestHandler {
  return async (req: Request, res: ExpressResponse, next: NextFunction): Promise<void> => {
    const token = bearerToken(req.header("authorization"));
    if (token === "") {
      res.status(401).json({ error: "sign in to continue" });
      return;
    }
    const verdict = await verifyAccountToken(token, deps);
    if (!verdict.ok) {
      res.status(verdict.status).json({ error: verdict.error });
      return;
    }

    let store: AccountStore;
    try {
      store = deps.store ?? AccountStore.fromEnv();
    } catch (err) {
      res.status(503).json({ error: `accounts unconfigured: ${(err as Error).message}` });
      return;
    }

    let membership: Membership | null;
    try {
      membership = await store.liveMembership(verdict.userId);
    } catch (err) {
      // The gate cannot answer, so it must not guess. Failing open here would
      // hand the whole closed beta to anyone who can make the database blink.
      console.error(`membership lookup failed for ${verdict.userId}: ${(err as Error).message}`);
      res.status(502).json({ error: "could not check your membership" });
      return;
    }

    const account: AccountContext = { userId: verdict.userId, email: verdict.email, membership };
    res.locals.account = account;
    next();
  };
}

/**
 * The closed-beta gate. Runs AFTER requireAccount and 403s an account that has
 * no live grant. A trial counts: `isLiveMembership` asks "trial or active and
 * not past expires_at", never "paid".
 */
export function requireMember(req: Request, res: ExpressResponse, next: NextFunction): void {
  const account = res.locals.account as AccountContext | undefined;
  if (!account) {
    // requireAccount did not run, or ran and refused. Either way this request
    // has no established identity and must not be treated as a member.
    res.status(401).json({ error: "sign in to continue" });
    return;
  }
  if (!isMember(account.membership)) {
    res.status(403).json({ error: CLOSED_BETA_MESSAGE });
    return;
  }
  next();
}
