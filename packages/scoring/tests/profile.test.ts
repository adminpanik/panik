import { describe, expect, it } from "vitest";
import { statusFor } from "../src/profile";
import {
  drawdownToLiquidation,
  estimateHealthFactor,
  formatDrawdownPct,
  liquidationDrawdown,
} from "../src/prospective";

describe("statusFor (arch §Risk Profiles / biz plan Watch table)", () => {
  // Conservative: fires at 25+, approaching 15–24
  it.each([
    ["conservative", 14, "within"],
    ["conservative", 15, "approaching"],
    ["conservative", 24, "approaching"],
    ["conservative", 25, "outside"],
    // Moderate: fires 50+, approaching 40–49
    ["moderate", 39, "within"],
    ["moderate", 40, "approaching"],
    ["moderate", 49, "approaching"],
    ["moderate", 50, "outside"],
    // Aggressive: fires 75+, approaching 65–74
    ["aggressive", 64, "within"],
    ["aggressive", 65, "approaching"],
    ["aggressive", 74, "approaching"],
    ["aggressive", 75, "outside"],
  ] as const)("%s @ score %i → %s", (profile, score, status) => {
    expect(statusFor(profile, score)).toBe(status);
  });
});

describe("prospective scenario estimates (Compass)", () => {
  it("HF formula matches arch line 62", () => {
    // $10k collateral, 80% liq threshold, $4k borrow → HF 2.0
    expect(estimateHealthFactor(10_000, 4_000, 0.8)).toBe(2.0);
  });
  it("no borrow → null (no HF, matches null-sentinel convention)", () => {
    expect(estimateHealthFactor(10_000, 0, 0.8)).toBeNull();
  });
  it("liquidation drawdown: HF 2.0 → 50% price drop to liquidation", () => {
    expect(liquidationDrawdown(10_000, 4_000, 0.8)).toBeCloseTo(0.5, 9);
  });
  it("already liquidatable (HF < 1) → 0% drop needed", () => {
    expect(liquidationDrawdown(10_000, 9_000, 0.8)).toBe(0);
  });
});

describe("drawdownToLiquidation (the formula, from an HF already measured)", () => {
  it.each([
    [2.0, 0.5], // HF 2.00 → the collateral may halve
    [1.2, 1 - 1 / 1.2], // the levered Moonwell leg
    [1.05, 1 - 1 / 1.05], // the CRITICAL Morpho leg
    [1.34, 1 - 1 / 1.34], // the degraded Compound leg (HF is a ratio, still exact)
  ])("HF %s → %s", (hf, expected) => {
    expect(drawdownToLiquidation(hf)).toBeCloseTo(expected, 12);
  });

  it("no debt (null HF) stays null — there is no liquidation to be a distance from", () => {
    expect(drawdownToLiquidation(null)).toBeNull();
  });

  it.each([1, 0.9, 0.01])(
    "HF %s is already liquidatable → floored at 0, never negative",
    (hf) => {
      expect(drawdownToLiquidation(hf)).toBe(0);
    },
  );

  /**
   * A non-positive health factor is not a position that is 100% of the way to
   * liquidation, it is a number this formula cannot describe — 1 - 1/-1 would
   * report a 200% drop and 1 - 1/0 is Infinity. `null` is the same answer the
   * no-debt case gets, and every caller already branches on it.
   */
  it.each([0, -0.5, -1])("HF %s has no drawdown to state → null, not a number", (hf) => {
    expect(drawdownToLiquidation(hf)).toBeNull();
  });

  it("is the single implementation liquidationDrawdown delegates to", () => {
    // Same inputs, same number: the wrapper adds the HF step and nothing else.
    expect(liquidationDrawdown(10_000, 4_000, 0.8)).toBe(
      drawdownToLiquidation(estimateHealthFactor(10_000, 4_000, 0.8)),
    );
  });
});

/**
 * One rounding policy for the drop, shared by the UI's stat strips and the
 * engine's own prose — they printed "17%" and "17.4%" for one health factor on
 * one card before this lived in the package.
 */
describe("formatDrawdownPct", () => {
  it.each([
    [1 - 1 / 1.2, "17%"], // no decimal above 10%: the model is an estimate
    [1 - 1 / 1.05, "4.8%"], // one decimal below it: 4.8 and 5.4 are different days
    [0.0996, "10%"], // re-checked after rounding, never "10.0%"
    [0.0005, "under 0.1%"], // would print "0.0%", which reads as "no drop needed"
    [0, "0%"], // liquidatable now, not "a very small drop away"
  ])("%s → %s", (drop, expected) => {
    expect(formatDrawdownPct(drop)).toBe(expected);
  });
});
