/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `describeAccess` is the one place a membership status becomes words, so the
 * enum never reaches a screen. Whether a grant is open is the server's `live`;
 * this only owns the vocabulary.
 */

import { describe, expect, it } from "vitest";

import type { Membership } from "../../panik-core/lib/account";
import { describeAccess } from "./adminApi";

const FUTURE = "2026-09-01T12:00:00Z";

const grant = (over: Partial<Membership>): Membership => ({
  id: "m1",
  status: "trial",
  source: "voucher",
  voucherCode: "PANIK-1",
  startedAt: "2026-08-01T12:00:00Z",
  expiresAt: null,
  ...over,
});

describe("describeAccess", () => {
  it("says nobody is in the beta when there is no grant", () => {
    expect(describeAccess({ membership: null, live: false })).toEqual({ label: "Not in beta", detail: null });
  });

  it("calls a live trial a trial, and dates it only when it expires", () => {
    expect(describeAccess({ membership: grant({ expiresAt: FUTURE }), live: true })).toEqual({
      label: "Trial",
      detail: `until ${new Date(FUTURE).toLocaleDateString()}`,
    });
    expect(describeAccess({ membership: grant({}), live: true })).toEqual({ label: "Trial", detail: null });
  });

  it("calls a live non-trial grant a member", () => {
    expect(describeAccess({ membership: grant({ status: "active" }), live: true })).toEqual({
      label: "Member",
      detail: null,
    });
  });

  it("calls any grant the server judged not live ended, whatever its status says", () => {
    for (const status of ["trial", "active", "lapsed"] as const) {
      expect(describeAccess({ membership: grant({ status }), live: false })).toEqual({
        label: "Ended",
        detail: null,
      });
    }
  });
});
