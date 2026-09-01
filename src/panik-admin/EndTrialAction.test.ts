/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The three decisions the End trial control makes before it renders anything:
 * what the confirm dialog promises, which addresses count as open, and the
 * difference between "this trial is over" and "we could not find out".
 *
 * That third state is the point of the file. Collapsing `null` to `false`
 * would hide the control on a row whose trial is running, which reads as a
 * claim that it has ended; collapsing it to `true` would offer an action that
 * cannot be honoured. It is a disabled control with a reason, and nothing
 * else, so it is asserted here rather than left to a component test this suite
 * has no DOM for.
 */

import { describe, expect, it } from "vitest";

import {
  endTrialConfirmText,
  isTrialLive,
  liveTrialEmails,
  normalizeEmail,
} from "./EndTrialAction";
import type { TrialSummary } from "./lib/adminApi";

const trial = (email: string | null): TrialSummary => ({
  userId: `u-${email ?? "none"}`,
  email,
  membershipId: `m-${email ?? "none"}`,
  status: "trial",
  source: "voucher",
  voucherCode: "PANIK-TRY-ABCDEFGH",
  startedAt: "2026-08-01T12:00:00Z",
  expiresAt: "2026-09-30T12:00:00Z",
});

describe("endTrialConfirmText", () => {
  it("names the person and both halves of what happens to them", () => {
    const text = endTrialConfirmText("tester@panik.fi");
    expect(text).toBe(
      "End the trial for tester@panik.fi now? They keep their account; access ends immediately.",
    );
    // The account surviving is the reassurance that makes this safe to press,
    // and the immediacy is the warning. Neither may quietly drop out.
    expect(text).toContain("keep their account");
    expect(text).toContain("immediately");
  });
});

describe("liveTrialEmails", () => {
  it("keys on the normalized address", () => {
    const set = liveTrialEmails([trial("  Tester@Panik.FI ")]);
    expect(set.has("tester@panik.fi")).toBe(true);
  });

  it("drops a grant with no address instead of keying it on an empty string", () => {
    // Otherwise every emailless row in a roster would look up as live.
    expect(liveTrialEmails([trial(null), trial("")]).size).toBe(0);
  });
});

describe("isTrialLive", () => {
  const set = liveTrialEmails([trial("tester@panik.fi")]);

  it("is true for an address holding an open grant, whatever its case", () => {
    expect(isTrialLive(set, "TESTER@panik.fi ")).toBe(true);
  });

  it("is false for an address the server did not list", () => {
    expect(isTrialLive(set, "ended@panik.fi")).toBe(false);
  });

  it("is false for a row with no address: there is nothing to end by", () => {
    expect(isTrialLive(set, null)).toBe(false);
    expect(isTrialLive(set, "  ")).toBe(false);
  });

  it("stays null when the live set never arrived, and never collapses to false", () => {
    expect(isTrialLive(null, "tester@panik.fi")).toBeNull();
    expect(isTrialLive(null, null)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("agrees with the server's own normalization", () => {
    expect(normalizeEmail("  Tester@Panik.FI ")).toBe("tester@panik.fi");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});
