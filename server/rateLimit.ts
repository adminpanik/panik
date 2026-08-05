/**
 * Tiny in-memory per-key rate limiter. No dependency: the Express API runs as a
 * SINGLE Railway container, so a process-local sliding window IS the whole
 * picture (a shared store only matters once we scale horizontally).
 *
 * Keyed on clientIp() — the right-most X-Forwarded-For hop, i.e. the one the
 * proxy appended and a client cannot forge. The key map is hard-capped so a
 * spray of unique source IPs can't grow it without bound.
 *
 * Two faces on one core:
 *   - rateLimit()      Express middleware (scripts/api-server.ts, production).
 *   - keyedRateLimit() transport-agnostic, for the api/ serverless fallbacks.
 *     There each invocation may be its own isolate, so the window only holds
 *     for a warm container — a brake on the obvious burst, NOT a guarantee.
 *     It is still worth having: without it those handlers had no ceiling at all
 *     while their Express twins were capped at 10/min.
 */

import type { NextFunction, Request, Response } from "express";
import { clientIp } from "./clientIp";

/** Hard cap on tracked keys. Oldest-inserted entries are dropped first. */
const MAX_KEYS = 10_000;

interface Entry {
  /** Request timestamps inside the current window, oldest first. */
  hits: number[];
  /** Consecutive failed auths (lockout-enabled limiters only). */
  failures: number;
  /** Epoch ms until which the key is locked out (0 = not locked). */
  lockedUntil: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in ms. Default 60s. */
  windowMs?: number;
  /** Consecutive failed auths before a lockout. Omit to disable the lockout. */
  maxFailures?: number;
  /** Lockout length once maxFailures is reached. Default 15min. */
  lockoutMs?: number;
}

/** Outcome of one `hit`. `retryAfterSec` is only meaningful when blocked. */
export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec: number;
}

export interface KeyedRateLimiter {
  /** Record + judge one request for `key`. */
  hit(key: string): RateLimitDecision;
  /** Record a failed auth for `key` (drives the lockout). */
  fail(key: string): void;
}

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Record a failed auth for this request's key (drives the lockout). */
  fail(req: Request): void;
}

/** Transport-agnostic sliding window. Callers supply their own key. */
export function keyedRateLimit(opts: RateLimitOptions): KeyedRateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxFailures = opts.maxFailures ?? 0;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const entries = new Map<string, Entry>();

  /** Drop entries with no live hits and no active lockout; then oldest-first. */
  const evict = (now: number): void => {
    for (const [k, e] of entries) {
      if (e.lockedUntil <= now && (e.hits.length === 0 || now - e.hits[e.hits.length - 1]! >= windowMs)) {
        entries.delete(k);
      }
    }
    while (entries.size >= MAX_KEYS) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const entryOf = (key: string, now: number): Entry => {
    const existing = entries.get(key);
    if (existing) return existing;
    if (entries.size >= MAX_KEYS) evict(now);
    const fresh: Entry = { hits: [], failures: 0, lockedUntil: 0 };
    entries.set(key, fresh);
    return fresh;
  };

  const retryAfter = (retryMs: number): number => Math.max(1, Math.ceil(retryMs / 1000));

  return {
    hit(key: string): RateLimitDecision {
      const now = Date.now();
      const entry = entryOf(key, now);
      if (entry.lockedUntil > now) return { ok: false, retryAfterSec: retryAfter(entry.lockedUntil - now) };
      while (entry.hits.length && now - entry.hits[0]! >= windowMs) entry.hits.shift();
      if (entry.hits.length >= opts.limit) {
        return { ok: false, retryAfterSec: retryAfter(windowMs - (now - entry.hits[0]!)) };
      }
      entry.hits.push(now);
      return { ok: true, retryAfterSec: 0 };
    },
    fail(key: string): void {
      if (maxFailures <= 0) return;
      const now = Date.now();
      const entry = entryOf(key, now);
      entry.failures += 1;
      if (entry.failures >= maxFailures) {
        entry.failures = 0;
        entry.lockedUntil = now + lockoutMs;
      }
    },
  };
}

/** Express middleware enforcing `limit` requests per `windowMs` per client IP. */
export function rateLimit(opts: RateLimitOptions): RateLimiter {
  const core = keyedRateLimit(opts);
  const keyOf = (req: Request): string => clientIp(req.headers) ?? "unknown";

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const decision = core.hit(keyOf(req));
    if (!decision.ok) {
      res.setHeader("Retry-After", String(decision.retryAfterSec));
      res.status(429).json({ error: "rate limit exceeded", retryAfterSec: decision.retryAfterSec });
      return;
    }
    next();
  };

  middleware.fail = (req: Request): void => core.fail(keyOf(req));

  return middleware;
}
