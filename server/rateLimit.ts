/**
 * Tiny in-memory per-IP rate limiter for the Express API. No dependency: the
 * API runs as a SINGLE Railway container, so a process-local sliding window IS
 * the whole picture (a shared store only matters once we scale horizontally).
 *
 * Keyed on clientIp() — the right-most X-Forwarded-For hop, i.e. the one the
 * proxy appended and a client cannot forge. The key map is hard-capped so a
 * spray of unique source IPs can't grow it without bound.
 *
 * Used by scripts/api-server.ts; the Vercel functions are rate-limited by the
 * platform instead (each invocation is its own isolate, so this wouldn't hold).
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

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Record a failed auth for this request's key (drives the lockout). */
  fail(req: Request): void;
}

function reject(res: Response, retryMs: number): void {
  const retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: "rate limit exceeded", retryAfterSec });
}

/** Express middleware enforcing `limit` requests per `windowMs` per client IP. */
export function rateLimit(opts: RateLimitOptions): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxFailures = opts.maxFailures ?? 0;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const entries = new Map<string, Entry>();

  const keyOf = (req: Request): string => clientIp(req) ?? "unknown";

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

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const entry = entryOf(keyOf(req), now);
    if (entry.lockedUntil > now) {
      reject(res, entry.lockedUntil - now);
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

  middleware.fail = (req: Request): void => {
    if (maxFailures <= 0) return;
    const now = Date.now();
    const entry = entryOf(keyOf(req), now);
    entry.failures += 1;
    if (entry.failures >= maxFailures) {
      entry.failures = 0;
      entry.lockedUntil = now + lockoutMs;
    }
  };

  return middleware;
}
