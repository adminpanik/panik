/**
 * Tiny in-memory per-client sliding-window rate limiter. No dependency: the
 * Express API runs as a SINGLE Railway container, so a process-local window IS
 * the whole picture (a shared store only matters once we scale horizontally).
 *
 * Keyed on ipBucket(clientIp(req)) — see server/clientIp.ts for how the client
 * address is established (TRUSTED_PROXY_HOPS) and why IPv6 is bucketed by /64.
 *
 * Two faces on one core, so both transports enforce the SAME rules:
 *   - rateLimit()      Express middleware (scripts/api-server.ts, production).
 *   - keyedRateLimit() transport-agnostic, for the api/ serverless fallbacks.
 *     There each invocation may be its own isolate, so the window only holds
 *     for a warm container — a brake on the obvious burst, NOT a guarantee.
 *     It is still worth having: without it those handlers had no ceiling at all
 *     while their Express twins were capped at 10/min.
 *   Both go through denyRequest() for identity + refusal, so the serverless
 *   fallback cannot drift into being weaker than the primary.
 *
 * ── EVICTION IS PART OF THE SECURITY BOUNDARY ─────────────────────────────
 * The key map is hard-capped, so something has to give when it is full. What
 * gives must NEVER be a live entry: dropping the entry of a client that is
 * currently at its limit hands that client a fresh budget, which turns the cap
 * itself into the bypass (flood 10k unique keys, and the previous victim — or a
 * lockout — is erased). So only entries whose window has fully elapsed are
 * evicted; when none have, new keys are refused with 503 instead. Failing
 * closed for newcomers is the correct trade: the alternative silently unlimits
 * everyone already being limited.
 *
 * Sweeps are also throttled, so a unique-key flood cannot make us pay an O(n)
 * scan per request (measured ~100x self-amplification before this).
 *
 * NOTE: there is deliberately no failed-auth lockout here. It used to live in
 * this module keyed on the client IP, which let a third party lock out the real
 * admin; it now lives in server/adminAuth.ts keyed on a hash of the PRESENTED
 * credential. Do not reintroduce fail()/maxFailures on an IP-keyed limiter.
 */

import type { NextFunction, Request, Response } from "express";
import { clientIp, ipBucket, type IpRequest } from "./clientIp";

/** Hard cap on tracked keys. Only EXPIRED entries are ever dropped. */
const MAX_KEYS = 10_000;
/** Floor between full sweeps, so a flood pays O(n) at most once a second. */
const MIN_SWEEP_INTERVAL_MS = 1_000;

interface Entry {
  /** Request timestamps inside the current window, oldest first. */
  hits: number[];
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in ms. Default 60s. */
  windowMs?: number;
  /** Tracked-key cap. Default MAX_KEYS; lowered in tests. */
  maxKeys?: number;
}

/** Why a request was let through or turned away. */
export type RateLimitOutcome = "ok" | "limited" | "at-capacity";

/** Outcome of one `hit`. `retryAfterSec` is only meaningful when not ok. */
export interface RateLimitDecision {
  ok: boolean;
  outcome: RateLimitOutcome;
  retryAfterSec: number;
}

export interface KeyedRateLimiter {
  /** Record + judge one request for `key`. */
  hit(key: string): RateLimitDecision;
  /** Tracked key count — for tests and diagnostics. */
  size(): number;
}

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Tracked key count — for tests and diagnostics. */
  size(): number;
}

/** A refusal, ready to be written to whichever response object the caller has. */
export interface RateLimitDenial {
  status: number;
  error: string;
  retryAfterSec: number;
}

const retryAfterSec = (retryMs: number): number => Math.max(1, Math.ceil(retryMs / 1000));

/** Transport-agnostic sliding window. Callers supply their own key. */
export function keyedRateLimit(opts: RateLimitOptions): KeyedRateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxKeys = opts.maxKeys ?? MAX_KEYS;
  const entries = new Map<string, Entry>();
  /** No full sweep before this instant (throttle + "nothing can have expired"). */
  let sweepBlockedUntil = 0;

  /** ms until this entry can no longer affect any decision. */
  const expiresAt = (e: Entry): number => (e.hits.length ? e.hits[e.hits.length - 1]! + windowMs : 0);

  /**
   * Delete expired entries only. Returns true if that freed room. When it did
   * not, block further sweeps until the soonest entry can actually expire, so
   * a sustained flood costs one scan per second rather than one per request.
   */
  const sweep = (now: number): boolean => {
    if (now < sweepBlockedUntil) return false;
    let soonest = Infinity;
    for (const [key, entry] of entries) {
      const until = expiresAt(entry);
      if (until <= now) entries.delete(key);
      else if (until < soonest) soonest = until;
    }
    if (entries.size < maxKeys) {
      sweepBlockedUntil = 0;
      return true;
    }
    sweepBlockedUntil = Math.max(soonest, now + MIN_SWEEP_INTERVAL_MS);
    return false;
  };

  /** The entry for `key`, or null when the map is full of LIVE entries. */
  const entryOf = (key: string, now: number): Entry | null => {
    const existing = entries.get(key);
    if (existing) return existing;
    if (entries.size >= maxKeys && !sweep(now)) return null;
    const fresh: Entry = { hits: [] };
    entries.set(key, fresh);
    return fresh;
  };

  return {
    hit(key: string): RateLimitDecision {
      const now = Date.now();
      const entry = entryOf(key, now);
      if (entry === null) {
        return {
          ok: false,
          outcome: "at-capacity",
          retryAfterSec: Math.ceil(MIN_SWEEP_INTERVAL_MS / 1000),
        };
      }
      while (entry.hits.length && now - entry.hits[0]! >= windowMs) entry.hits.shift();
      if (entry.hits.length >= opts.limit) {
        return { ok: false, outcome: "limited", retryAfterSec: retryAfterSec(windowMs - (now - entry.hits[0]!)) };
      }
      entry.hits.push(now);
      return { ok: true, outcome: "ok", retryAfterSec: 0 };
    },
    size: (): number => entries.size,
  };
}

/**
 * Judge one request against `limiter`, establishing the client identity the
 * same way for every transport. Returns null when the request may proceed.
 *
 * An unidentifiable client is REFUSED (503), never folded into a shared
 * "unknown" bucket: that would either merge unrelated clients into one budget
 * or — with a forgeable header — be an unlimited one. See server/clientIp.ts.
 */
export function denyRequest(limiter: KeyedRateLimiter, req: IpRequest): RateLimitDenial | null {
  const ip = clientIp(req);
  if (ip === null) return { status: 503, error: "client address unavailable", retryAfterSec: 60 };

  const decision = limiter.hit(ipBucket(ip));
  if (decision.ok) return null;
  if (decision.outcome === "at-capacity") {
    return { status: 503, error: "server at capacity, retry shortly", retryAfterSec: decision.retryAfterSec };
  }
  return { status: 429, error: "rate limit exceeded", retryAfterSec: decision.retryAfterSec };
}

/** Express middleware enforcing `limit` requests per `windowMs` per client. */
export function rateLimit(opts: RateLimitOptions): RateLimiter {
  const core = keyedRateLimit(opts);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const denied = denyRequest(core, req);
    if (denied) {
      res.setHeader("Retry-After", String(denied.retryAfterSec));
      res.status(denied.status).json({ error: denied.error, retryAfterSec: denied.retryAfterSec });
      return;
    }
    next();
  };

  middleware.size = (): number => core.size();

  return middleware;
}
