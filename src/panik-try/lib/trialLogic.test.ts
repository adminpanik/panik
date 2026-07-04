/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the trial-code decision logic. These mirror the SQL rules in
 * supabase/migrations/20260704000001_product_codes.sql: campaign status
 * (time + count limits), per-user expiry (clock starts on first open), and code
 * parsing for the scan vs manual-input paths.
 *
 * NOTE: the atomic over-limit guard itself lives in SQL (redeem_campaign_code's
 * guarded UPDATE) and is exercised by the end-to-end verification steps, not
 * here - this file covers the pure, DB-free logic the SQL mirrors.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCampaign,
  computeTrialExpiry,
  evaluateTrialAccess,
  normalizeCode,
  parseCode,
  formatRemaining,
  type CampaignLike,
} from "./trialLogic";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const base: CampaignLike = {
  is_active: true,
  redemption_count: 0,
  max_redemptions: 20,
  claim_window_expires_at: null,
};

describe("evaluateCampaign - usage (count) limit", () => {
  it("is active below the limit", () => {
    expect(evaluateCampaign({ ...base, redemption_count: 5 }, NOW)).toBe("active");
  });
  it("is exhausted when count reaches max", () => {
    expect(evaluateCampaign({ ...base, redemption_count: 20 }, NOW)).toBe("exhausted");
  });
  it("is exhausted when count exceeds max", () => {
    expect(evaluateCampaign({ ...base, redemption_count: 21 }, NOW)).toBe("exhausted");
  });
});

describe("evaluateCampaign - time (claim window) limit", () => {
  it("is active before the claim window closes", () => {
    expect(
      evaluateCampaign({ ...base, claim_window_expires_at: "2026-07-06T12:00:00.000Z" }, NOW),
    ).toBe("active");
  });
  it("is expired once the claim window has passed", () => {
    expect(
      evaluateCampaign({ ...base, claim_window_expires_at: "2026-07-04T12:00:00.000Z" }, NOW),
    ).toBe("expired");
  });
  it("is expired exactly at the boundary", () => {
    expect(
      evaluateCampaign({ ...base, claim_window_expires_at: NOW.toISOString() }, NOW),
    ).toBe("expired");
  });
});

describe("evaluateCampaign - precedence (whichever limit is hit first wins)", () => {
  it("disabled beats everything", () => {
    expect(evaluateCampaign({ ...base, is_active: false, redemption_count: 99 }, NOW)).toBe("disabled");
  });
  it("expired (time) beats exhausted (count)", () => {
    expect(
      evaluateCampaign(
        { ...base, redemption_count: 20, claim_window_expires_at: "2026-07-04T12:00:00.000Z" },
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("computeTrialExpiry", () => {
  it("adds the duration in hours to the first-open time", () => {
    const opened = new Date("2026-07-05T12:00:00.000Z");
    expect(computeTrialExpiry(opened, 72).toISOString()).toBe("2026-07-08T12:00:00.000Z");
  });
});

describe("evaluateTrialAccess - per-user expiry (clock starts on first open)", () => {
  it("is invalid for a missing/unknown token", () => {
    expect(evaluateTrialAccess(null, NOW)).toBe("invalid");
  });
  it("is active when never opened (clock not started yet)", () => {
    expect(evaluateTrialAccess({ first_opened_at: null, expires_at: null }, NOW)).toBe("active");
  });
  it("is active before expiry", () => {
    expect(
      evaluateTrialAccess(
        { first_opened_at: "2026-07-05T11:00:00.000Z", expires_at: "2026-07-05T13:00:00.000Z" },
        NOW,
      ),
    ).toBe("active");
  });
  it("is expired after expiry", () => {
    expect(
      evaluateTrialAccess(
        { first_opened_at: "2026-07-01T12:00:00.000Z", expires_at: "2026-07-04T12:00:00.000Z" },
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("parseCode - scan path vs manual fallback", () => {
  it("reads the code param (scan path)", () => {
    expect(parseCode("?code=PANIK-TRY-8X2Q")).toBe("PANIK-TRY-8X2Q");
  });
  it("normalizes case and whitespace", () => {
    expect(parseCode("?code=panik-try-8x2q")).toBe("PANIK-TRY-8X2Q");
  });
  it("returns null with no code param (manual fallback path)", () => {
    expect(parseCode("")).toBeNull();
    expect(parseCode("?foo=bar")).toBeNull();
  });
});

describe("normalizeCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeCode("  panik-try-abcd ")).toBe("PANIK-TRY-ABCD");
  });
  it("handles null/undefined", () => {
    expect(normalizeCode(null)).toBe("");
    expect(normalizeCode(undefined)).toBe("");
  });
});

describe("formatRemaining", () => {
  it("labels days and hours", () => {
    expect(formatRemaining(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });
  it("labels hours and minutes", () => {
    expect(formatRemaining(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
  });
  it("labels minutes only", () => {
    expect(formatRemaining(8 * 60_000)).toBe("8m");
  });
  it("says expired at or below zero", () => {
    expect(formatRemaining(0)).toBe("expired");
    expect(formatRemaining(-1000)).toBe("expired");
  });
});
