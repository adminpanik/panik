/**
 * Tiny in-memory per-client sliding-window rate limiter for the Express API. No
 * dependency: the API runs as a SINGLE Railway container, so a process-local
 * window IS the whole picture (a shared store only matters once we scale
 * horizontally).
 *
 * Keyed on ipBucket(clientIp(req)) — see server/clientIp.ts for how the client
 * address is established (TRUSTED_PROXY_HOPS) and why IPv6 is bucketed by /64.
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
 * Used by scripts/api-server.ts; the Vercel functions are rate-limited by the
 * platform instead (each invocation is its own isolate, so this wouldn't hold).
 */

import type { NextFunction, Request, Response } from "express";
import { clientIp, ipBucket } from "./clientIp";

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

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Tracked key count — for tests and diagnostics. */
  size(): number;
}

function reject(res: Response, retryMs: number): void {
  const retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: "rate limit exceeded", retryAfterSec });
}

function refuse(res: Response, error: string, retryAfterSec: number): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(503).json({ error, retryAfterSec });
}

/** Express middleware enforcing `limit` requests per `windowMs` per client. */
export function rateLimit(opts: RateLimitOptions): RateLimiter {
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

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip = clientIp(req);
    if (ip === null) {
      // No usable client identity. A shared "unknown" bucket would either merge
      // unrelated clients into one budget or (with a forgeable header) be an
      // unlimited one, so refuse instead. See server/clientIp.ts.
      refuse(res, "client address unavailable", 60);
      return;
    }
    const entry = entryOf(ipBucket(ip), now);
    if (entry === null) {
      refuse(res, "server at capacity, retry shortly", Math.ceil(MIN_SWEEP_INTERVAL_MS / 1000));
      return;
    }
    while (entry.hits.length && now - entry.hits[0]! >= windowMs) entry.hits.shift();
    if (entry.hits.length >= opts.limit) {
      reject(res, windowMs - (now - entry.hits[0]!));
      return;
    }
    entry.hits.push(now);
    next();
  };

  middleware.size = (): number => entries.size;

  return middleware;
}
