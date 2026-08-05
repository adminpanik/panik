/**
 * `stated` is JSON.stringify'd into the LLM user message and the completion is
 * rendered back to the user as their persona, so the guard has to bound VALUES,
 * not just check the shape: an unknown key or a 100 kB string is both a prompt
 * injection and a ~25k-token bill per request.
 */

import { describe, expect, it } from "vitest";

import { isDuneExecutionId, isEvmAddress, isStatedProfile } from "./profileDeps";

describe("isStatedProfile", () => {
  it("accepts what the quiz actually sends", () => {
    expect(isStatedProfile({ riskProfile3: "moderate" })).toBe(true);
    expect(
      isStatedProfile({
        riskProfile3: "aggressive",
        riskTier: "moderately_aggressive",
        segment: "risk_optimizer",
        segmentLabel: "Risk Optimizer",
        riskScore: 13,
      }),
    ).toBe(true);
  });

  it("rejects a bogus shape", () => {
    expect(isStatedProfile(undefined)).toBe(false);
    expect(isStatedProfile(null)).toBe(false);
    expect(isStatedProfile("moderate")).toBe(false);
    expect(isStatedProfile([])).toBe(false);
    expect(isStatedProfile({})).toBe(false);
    expect(isStatedProfile({ riskProfile3: "reckless" })).toBe(false);
  });

  it("rejects an oversized string instead of forwarding it to the prompt", () => {
    expect(isStatedProfile({ riskProfile3: "moderate", segmentLabel: "x".repeat(64) })).toBe(true);
    expect(isStatedProfile({ riskProfile3: "moderate", segmentLabel: "x".repeat(65) })).toBe(false);
    expect(isStatedProfile({ riskProfile3: "moderate", segmentLabel: "x".repeat(100_000) })).toBe(false);
  });

  it("rejects unknown keys — they ride into the prompt too", () => {
    expect(isStatedProfile({ riskProfile3: "moderate", ignorePreviousInstructions: "..." })).toBe(false);
    expect(isStatedProfile({ riskProfile3: "moderate", riskProfile3Extra: "x" })).toBe(false);
  });

  it("clamps riskScore to the quiz's real range, not merely 'finite'", () => {
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: 0 })).toBe(true);
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: 18 })).toBe(true);
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: -1 })).toBe(false);
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: 1e9 })).toBe(false);
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: NaN })).toBe(false);
    expect(isStatedProfile({ riskProfile3: "moderate", riskScore: "12" })).toBe(false);
  });
});

describe("isDuneExecutionId", () => {
  it("accepts Dune's own ids and rejects traversal", () => {
    expect(isDuneExecutionId("01HZY7Q9WQ3M2AB_CD-EF")).toBe(true);
    expect(isDuneExecutionId("../../v1/query/7771860")).toBe(false);
    expect(isDuneExecutionId("a/b")).toBe(false);
    expect(isDuneExecutionId("")).toBe(false);
    expect(isDuneExecutionId("x".repeat(65))).toBe(false);
    expect(isDuneExecutionId(42)).toBe(false);
  });
});

describe("isEvmAddress", () => {
  it("accepts a 20-byte hex address only", () => {
    expect(isEvmAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isEvmAddress("0x" + "A".repeat(40))).toBe(true);
    expect(isEvmAddress("0x" + "a".repeat(39))).toBe(false);
    expect(isEvmAddress("a".repeat(40))).toBe(false);
    expect(isEvmAddress(null)).toBe(false);
  });
});
