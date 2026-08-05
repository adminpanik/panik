/**
 * The eviction path used to BE the bypass: at the key cap the limiter deleted
 * the oldest-inserted entries unconditionally, so ~10k requests from unique
 * addresses handed a throttled victim a fresh budget. These cases pin that a
 * live entry is never freed, that the sweep stays cheap under a flood, and the
 * sliding-window boundary.
 */

import type { NextFunction, Request, Response } from "express";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { rateLimit, type RateLimiter } from "./rateLimit";

// The harness sends x-forwarded-for as a single hop, i.e. "one trusted proxy".
const ORIGINAL_HOPS = process.env.TRUSTED_PROXY_HOPS;
process.env.TRUSTED_PROXY_HOPS = "1";

afterEach(() => vi.useRealTimers());
afterAll(() => {
  if (ORIGINAL_HOPS === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = ORIGINAL_HOPS;
});

interface Outcome {
  passed: boolean;
  status: number | null;
}

/** Drive the real middleware with a minimal Express-shaped request. */
function call(limiter: RateLimiter, ip: string | null): Outcome {
  const outcome: Outcome = { passed: false, status: null };
  const headers = ip === null ? {} : { "x-forwarded-for": ip };
  const req = { headers, socket: { remoteAddress: "10.0.0.1" } } as unknown as Request;
  const res = {
    setHeader: () => res,
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json: () => undefined,
  } as unknown as Response;
  limiter(req, res, (() => {
    outcome.passed = true;
  }) as NextFunction);
  return outcome;
}

/** Distinct, valid IPv4 strings — the "spray of unique sources" of the PoC. */
const floodIp = (i: number): string => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

describe("rateLimit — window", () => {
  it("allows up to the limit and rejects the next request", () => {
    const limiter = rateLimit({ limit: 3 });
    for (let i = 0; i < 3; i++) expect(call(limiter, "203.0.113.1").passed).toBe(true);
    const blocked = call(limiter, "203.0.113.1");
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it("keeps separate budgets per client", () => {
    const limiter = rateLimit({ limit: 1 });
    expect(call(limiter, "203.0.113.1").passed).toBe(true);
    expect(call(limiter, "203.0.113.1").passed).toBe(false);
    expect(call(limiter, "203.0.113.2").passed).toBe(true);
  });

  it("slides exactly at the window boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = rateLimit({ limit: 2, windowMs: 1_000 });
    expect(call(limiter, "203.0.113.1").passed).toBe(true);
    vi.setSystemTime(400);
    expect(call(limiter, "203.0.113.1").passed).toBe(true);
    vi.setSystemTime(999);
    expect(call(limiter, "203.0.113.1").passed).toBe(false); // the first hit still counts
    vi.setSystemTime(1_000);
    expect(call(limiter, "203.0.113.1").passed).toBe(true); // the first hit has aged out
    vi.setSystemTime(1_001);
    expect(call(limiter, "203.0.113.1").passed).toBe(false); // the 400ms hit has not
  });

  it("shares one bucket across an IPv6 /64 but not across /64s", () => {
    const limiter = rateLimit({ limit: 1 });
    expect(call(limiter, "2001:db8:0:1::1").passed).toBe(true);
    expect(call(limiter, "2001:db8:0:1::dead").passed).toBe(false);
    expect(call(limiter, "2001:db8:0:2::1").passed).toBe(true);
  });

  it("refuses a request whose client cannot be identified", () => {
    // No shared "unknown" bucket: that either merges strangers into one budget
    // or, with a forgeable header, is an unlimited one.
    const limiter = rateLimit({ limit: 5 });
    const refused = call(limiter, null);
    expect(refused.passed).toBe(false);
    expect(refused.status).toBe(503);
  });
});

describe("rateLimit — eviction", () => {
  it("does not free a throttled victim when the key map floods", () => {
    const limiter = rateLimit({ limit: 1, maxKeys: 50 });
    expect(call(limiter, "203.0.113.1").passed).toBe(true);
    expect(call(limiter, "203.0.113.1").passed).toBe(false);
    // The PoC's flood, scaled down: unique IPv4s, then unique IPv6 /64s.
    for (let i = 0; i < 500; i++) call(limiter, floodIp(i));
    for (let i = 0; i < 500; i++) call(limiter, `2001:db8:0:${i.toString(16)}::1`);
    expect(call(limiter, "203.0.113.1").passed).toBe(false);
  });

  it("refuses NEW keys rather than dropping live ones when full", () => {
    const limiter = rateLimit({ limit: 5, maxKeys: 10 });
    for (let i = 0; i < 10; i++) expect(call(limiter, floodIp(i)).passed).toBe(true);
    const overflow = call(limiter, "198.51.100.99");
    expect(overflow.passed).toBe(false);
    expect(overflow.status).toBe(503);
    // Existing clients keep their (correct) budgets while the map is saturated.
    expect(call(limiter, floodIp(0)).passed).toBe(true);
    expect(limiter.size()).toBe(10);
  });

  it("reuses the slots of entries whose window has fully elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = rateLimit({ limit: 5, windowMs: 1_000, maxKeys: 4 });
    for (let i = 0; i < 4; i++) call(limiter, floodIp(i));
    expect(call(limiter, "198.51.100.99").status).toBe(503);
    vi.setSystemTime(1_500); // every tracked window has now elapsed
    expect(call(limiter, "198.51.100.99").passed).toBe(true);
    expect(limiter.size()).toBeLessThanOrEqual(4);
  });

  it("stays amortized: a 10k-unique-key flood does not sweep per request", () => {
    // Regression guard for the ~100x self-amplification: the old evict() ran an
    // O(n) scan for EVERY new key once at the cap (measured 5ms -> 481ms).
    const limiter = rateLimit({ limit: 1, maxKeys: 10_000 });
    for (let i = 0; i < 10_000; i++) call(limiter, floodIp(i));
    const started = performance.now();
    for (let i = 10_000; i < 20_000; i++) call(limiter, floodIp(i));
    expect(performance.now() - started).toBeLessThan(200);
    expect(limiter.size()).toBe(10_000);
  });
});
