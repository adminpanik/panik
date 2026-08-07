/**
 * The admin lockout used to be a weapon against the operator: keyed on the
 * caller's IP, so five wrong keys from anyone locked the real admin out for 15
 * minutes. These cases pin the inverted property — a third party can never make
 * the correct key stop working — plus the "consecutive" semantics the JSDoc
 * always claimed, and that a full credential map never frees a live lockout.
 */

import { describe, expect, it } from "vitest";

import { AdminAuthGate } from "./adminAuth";
import { checkAdminKey } from "./adminCampaigns";

const SECRET = "correct-horse-battery-staple";

/** Gate over a fixed secret with a controllable clock. */
function gate() {
  let now = 1_000_000;
  const verify = (provided: string | undefined) =>
    provided === undefined ? ("forbidden" as const) : provided === SECRET ? ("ok" as const) : ("forbidden" as const);
  const g = new AdminAuthGate(() => now, verify);
  return { g, advance: (ms: number) => (now += ms) };
}

describe("AdminAuthGate", () => {
  it("locks out the guessed credential, not the admin", () => {
    const { g } = gate();
    for (let i = 0; i < 5; i++) expect(g.authorize("guess").auth).toBe("forbidden");
    expect(g.authorize("guess").auth).toBe("locked");
    // The real admin sails straight through — this is the whole point.
    expect(g.authorize(SECRET).auth).toBe("ok");
  });

  it("cannot be locked out by an attacker hammering wrong keys", () => {
    const { g } = gate();
    for (let i = 0; i < 200; i++) g.authorize(`guess-${i}`);
    expect(g.authorize(SECRET).auth).toBe("ok");
  });

  it("cannot be locked out by an attacker hammering ONE wrong key", () => {
    const { g } = gate();
    for (let i = 0; i < 200; i++) g.authorize("guess");
    expect(g.authorize(SECRET).auth).toBe("ok");
  });

  it("does not lock the admin who mistypes five DIFFERENT values", () => {
    // The old IP-keyed counter treated unrelated typos as consecutive failures
    // and locked the admin on their 5th-ever slip. Each credential now counts
    // for itself.
    const { g } = gate();
    for (const typo of ["a", "b", "c", "d", "e"]) expect(g.authorize(typo).auth).toBe("forbidden");
    expect(g.authorize(SECRET).auth).toBe("ok");
  });

  it("resets the failure state on a successful auth", () => {
    const { g } = gate();
    for (let i = 0; i < 4; i++) expect(g.authorize(SECRET.slice(0, -1)).auth).toBe("forbidden");
    expect(g.authorize(SECRET).auth).toBe("ok");
    // The correct credential's own counter is clear again, and so is the global
    // one — a later slip does not resume mid-way toward a lockout.
    expect(g.authorize("one-more-wrong").auth).toBe("forbidden");
    expect(g.authorize(SECRET).auth).toBe("ok");
  });

  it("ages a stale failure counter out rather than counting across days", () => {
    const { g, advance } = gate();
    for (let i = 0; i < 4; i++) g.authorize("typo");
    advance(16 * 60_000);
    expect(g.authorize("typo").auth).toBe("forbidden"); // not "locked"
  });

  it("releases the credential lockout when it expires", () => {
    const { g, advance } = gate();
    for (let i = 0; i < 5; i++) g.authorize("guess");
    expect(g.authorize("guess").auth).toBe("locked");
    advance(15 * 60_000 + 1);
    expect(g.authorize("guess").auth).toBe("forbidden");
  });

  it("applies a global backoff to failures only", () => {
    const { g } = gate();
    for (let i = 0; i < 25; i++) g.authorize(`spray-${i}`);
    expect(g.authorize("another-wrong-key").auth).toBe("locked");
    expect(g.authorize(SECRET).auth).toBe("ok"); // and a success clears it
    expect(g.authorize("another-wrong-key").auth).toBe("forbidden");
  });

  it("reports a retry-after with the lockout", () => {
    const { g } = gate();
    for (let i = 0; i < 5; i++) g.authorize("guess");
    const result = g.authorize("guess");
    expect(result.auth).toBe("locked");
    expect(result.retryAfterSec).toBeGreaterThan(0);
  });

  it("never lets a flood of new credentials free a live lockout", () => {
    const { g } = gate();
    for (let i = 0; i < 5; i++) g.authorize("victim-key");
    expect(g.authorize("victim-key").auth).toBe("locked");
    for (let i = 0; i < 20_000; i++) g.authorize(`flood-${i}`);
    expect(g.authorize("victim-key").auth).toBe("locked");
    expect(g.size()).toBeLessThanOrEqual(4_096);
  });
});

describe("checkAdminKey", () => {
  const withKey = <T>(value: string | undefined, run: () => T): T => {
    const previous = process.env.ADMIN_ACCESS_KEY;
    if (value === undefined) delete process.env.ADMIN_ACCESS_KEY;
    else process.env.ADMIN_ACCESS_KEY = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.ADMIN_ACCESS_KEY;
      else process.env.ADMIN_ACCESS_KEY = previous;
    }
  };

  it("reports unconfigured when no key is set — never 'ok'", () => {
    expect(withKey(undefined, () => checkAdminKey(undefined))).toBe("unconfigured");
    expect(withKey(undefined, () => checkAdminKey("anything"))).toBe("unconfigured");
    expect(withKey("", () => checkAdminKey(""))).toBe("unconfigured");
  });

  it("distinguishes forbidden from ok", () => {
    expect(withKey(SECRET, () => checkAdminKey(undefined))).toBe("forbidden");
    expect(withKey(SECRET, () => checkAdminKey(""))).toBe("forbidden");
    expect(withKey(SECRET, () => checkAdminKey("wrong"))).toBe("forbidden");
    expect(withKey(SECRET, () => checkAdminKey(`${SECRET} `))).toBe("forbidden");
    expect(withKey(SECRET, () => checkAdminKey(SECRET))).toBe("ok");
  });
});
