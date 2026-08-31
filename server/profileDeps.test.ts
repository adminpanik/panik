/**
 * `stated` is JSON.stringify'd into the LLM user message and the completion is
 * rendered back to the user as their persona, so the guard has to bound VALUES,
 * not just check the shape: an unknown key or a 100 kB string is both a prompt
 * injection and a ~25k-token bill per request.
 */

import { describe, expect, it } from "vitest";

import { isDuneExecutionId, isEvmAddress, isStatedProfile } from "./profileDeps";
import { isEvmAddress as clientIsEvmAddress } from "../src/panik-core/lib/telegram";
import { isValidEvmAddress as landingIsEvmAddress } from "../src/panik-landing-page/lib/waitlist";

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

  /**
   * `ADDRESS_INVISIBLES` codepoints, built with `String.fromCharCode` rather
   * than typed as `\u` escapes in this source file: a zero-width space or a
   * BOM pasted straight into a test file is invisible in a diff and in a
   * reviewer's editor, which is exactly the failure mode this fix exists for.
   */
  const ZWSP = String.fromCharCode(0x200b); // zero-width space
  const WORD_JOINER = String.fromCharCode(0x2060);
  const SOFT_HYPHEN = String.fromCharCode(0x00ad);
  const BOM = String.fromCharCode(0xfeff);
  const ADDR = "0x" + "a".repeat(40);

  /**
   * One tester on 2026-08-30 pasted an address out of a PDF into "Add a
   * wallet" and was told it was invalid, with the leading zero-width space
   * invisible in the field. `normalizeVoucherCode` (server/accounts.ts) fixed
   * the same class of bug for voucher codes on 2026-08-31; this is that fix
   * applied to addresses.
   */
  const INVISIBLE_CASES: Array<[string, string]> = [
    ["leading zero-width space", ZWSP + ADDR],
    ["trailing zero-width space", ADDR + ZWSP],
    ["interior zero-width space", "0x" + "a".repeat(20) + ZWSP + "a".repeat(20)],
    ["leading BOM", BOM + ADDR],
    ["trailing BOM", ADDR + BOM],
    ["leading soft hyphen", SOFT_HYPHEN + ADDR],
    ["interior soft hyphen", "0x" + "a".repeat(20) + SOFT_HYPHEN + "a".repeat(20)],
    ["interior word joiner", "0x" + "a".repeat(20) + WORD_JOINER + "a".repeat(20)],
    ["ordinary leading/trailing whitespace", "  " + ADDR + "  "],
  ];

  it.each(INVISIBLE_CASES)("accepts an address carrying %s", (_label, raw) => {
    expect(isEvmAddress(raw)).toBe(true);
  });

  it("still rejects garbage that merely LOOKS like an address", () => {
    expect(isEvmAddress("0x" + "g".repeat(40))).toBe(false); // not hex
    expect(isEvmAddress("0x" + "a".repeat(41))).toBe(false); // too long
    expect(isEvmAddress("0x" + "a".repeat(20) + "-" + "a".repeat(19))).toBe(false); // a real, visible hyphen is not invisible
    expect(isEvmAddress("")).toBe(false);
    expect(isEvmAddress(ZWSP)).toBe(false); // invisible characters alone are not an address
  });

  /**
   * TWIN: `ADDRESS_INVISIBLES` in `src/panik-core/lib/telegram.ts` (client),
   * this file's `server/profileDeps.ts` (server), and
   * `src/panik-landing-page/lib/waitlist.ts` (landing) are character-for-
   * character copies and must stay one, the same way `server/accounts.test.ts`
   * pins `normalizeVoucherCode`'s two copies together.
   */
  it("agrees with its client and landing twins on every case", () => {
    const cases = [
      ...INVISIBLE_CASES.map(([, raw]) => raw),
      "0x" + "g".repeat(40),
      "0x" + "a".repeat(39),
      "",
      "not-a-wallet",
    ];
    for (const raw of cases) {
      const server = isEvmAddress(raw);
      expect(clientIsEvmAddress(raw)).toBe(server);
      expect(landingIsEvmAddress(raw)).toBe(server);
    }
  });
});
