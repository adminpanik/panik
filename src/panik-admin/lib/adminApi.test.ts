/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `describeAccess` is the one place a membership status becomes words, so the
 * enum never reaches a screen. What is asserted here is the mapping AND the
 * absence of the enum in what comes out: "is an enum leaking?" stays a
 * mechanical check rather than a reading of the JSX.
 */

import { describe, expect, it } from "vitest";

import { describeAccess, type Membership } from "./adminApi";

const NOW = Date.parse("2026-08-16T12:00:00Z");
const PAST = "2026-08-01T12:00:00Z";
const FUTURE = "2026-09-01T12:00:00Z";

const grant = (over: Partial<Membership>): Membership => ({
  id: "m1",
  status: "trial",
  source: "voucher",
  voucherCode: "PANIK-1",
  startedAt: PAST,
  expiresAt: null,
  ...over,
});

describe("describeAccess", () => {
  it("says nobody is in the beta when there is no grant", () => {
    expect(describeAccess(null, NOW)).toEqual({ label: "Not in beta", detail: null });
  });

  it("calls a live trial a trial, and dates it when it expires", () => {
    const dated = describeAccess(grant({ status: "trial", expiresAt: FUTURE }), NOW);
    expect(dated.label).toBe("Trial");
    expect(dated.detail).toBe(`until ${new Date(Date.parse(FUTURE)).toLocaleDateString()}`);

    // No expiry is not an unknown date: there is no date to state.
    expect(describeAccess(grant({ status: "trial", expiresAt: null }), NOW)).toEqual({
      label: "Trial",
      detail: null,
    });
  });

  it("calls an open grant a member", () => {
    expect(describeAccess(grant({ status: "active", expiresAt: null }), NOW)).toEqual({
      label: "Member",
      detail: null,
    });
    expect(describeAccess(grant({ status: "active", expiresAt: FUTURE }), NOW)).toEqual({
      label: "Member",
      detail: null,
    });
  });

  it("calls a lapsed grant, an expired trial and an expired membership ended", () => {
    const ended = { label: "Ended", detail: null };
    expect(describeAccess(grant({ status: "lapsed", expiresAt: null }), NOW)).toEqual(ended);
    expect(describeAccess(grant({ status: "trial", expiresAt: PAST }), NOW)).toEqual(ended);
    // Matches isLiveMembership in server/accountStore.ts: nothing rewrites the
    // status on read, so a run-out 'active' row is still labelled 'active'.
    expect(describeAccess(grant({ status: "active", expiresAt: PAST }), NOW)).toEqual(ended);
  });

  it("does not read an unparseable expiry as an unbounded grant", () => {
    expect(describeAccess(grant({ status: "active", expiresAt: "whenever" }), NOW)).toEqual({
      label: "Ended",
      detail: null,
    });
  });

  it("never hands back a raw status token", () => {
    const cases: (Membership | null)[] = [
      null,
      grant({ status: "trial", expiresAt: FUTURE }),
      grant({ status: "trial", expiresAt: null }),
      grant({ status: "active", expiresAt: null }),
      grant({ status: "lapsed", expiresAt: null }),
    ];
    // Case-sensitive, and that is the whole point: the word "Trial" is English
    // and the token `trial` is the database's. What must never render is a
    // value copied out of the column.
    for (const m of cases) {
      const { label, detail } = describeAccess(m, NOW);
      for (const token of ["trial", "active", "lapsed"]) {
        expect(label).not.toContain(token);
        expect(detail ?? "").not.toContain(token);
      }
    }
  });
});
