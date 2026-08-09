/**
 * The economic floor: the point below which a repay costs more gas than the
 * liquidation penalty it avoids.
 *
 * The behaviour that matters is the SUPPRESSION, not the arithmetic: before
 * this gate the advisor would tell a user sitting a hair under target to repay
 * a couple of dollars, which is advice that loses money at any gas price. The
 * decision-shape assertions below pin that a suppressed leg keeps flowing
 * through the remaining rules instead of vanishing.
 */

import { describe, expect, it } from "vitest";
import type { ActiveScore } from "../src/adapters/active";
import {
  AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS,
  collateralFundedRepayUsdFloor,
  DEFAULT_GAS_USD,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  DELEVERAGE_FLASH_FEE_BPS,
  DELEVERAGE_GAS_UNITS,
  FLASH_FEE_BPS,
  FORK_MEASUREMENT,
  gasUsdFromUnits,
  LIQUIDATION_PENALTY_BPS,
  protocolRepayUsdFloor,
  repayUsdFloor,
} from "../src/advisor/economicFloor";
import { repayToTargetHf, TARGET_HF } from "../src/advisor/repayMath";
import { adviseLeg } from "../src/advisor/rules";
import type { Band, Protocol } from "../src/types";

const WALLET = "0x2222222222222222222222222222222222222222";

function leg(overrides: Partial<ActiveScore> = {}): ActiveScore {
  return {
    total: 55,
    band: "HIGH" as Band,
    subScores: { positionHealth: 60, assetRisk: 30, protocolSafety: 10, systemicRisk: 10 },
    protocol: "aave_v3" as Protocol,
    wallet: WALLET,
    healthFactor: 1.5,
    collateralValueUsd: 20_000,
    borrowValueUsd: 8_000,
    usdValuesUnavailable: false,
    // Null by default: the collateral-funded option must be OMITTED on a leg
    // whose threshold was not read, and a fixture that always supplied one
    // would never exercise that. Tests that want the option set it.
    weightedLiquidationThreshold: null,
    marketContextUnavailable: false,
    dominantCollateralUnpriced: false,
    scoredCollateralSymbol: "WETH",
    dominantBorrowSymbol: "USDC",
    assetRiskIsProxy: false,
    ...overrides,
  };
}

describe("repayUsdFloor", () => {
  it("is gas grossed up by the penalty it avoids", () => {
    // $0.25 of gas against a 5% penalty: the repay must be $5 before the 5%
    // it protects covers the quarter it costs.
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 500 })).toBeCloseTo(5, 12);
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 700 })).toBeCloseTo(25 / 7, 12);
    expect(repayUsdFloor({ gasUsd: 2, penaltyAvoidedBps: 500 })).toBeCloseTo(40, 12);
  });

  it("charges the Phase 3 costs against the same penalty", () => {
    // A flash fee and a slippage allowance eat the benefit, so the floor rises.
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 500, flashFeeBps: 9 })).toBeCloseTo(
      2500 / 491,
      12,
    );
    expect(
      repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 500, flashFeeBps: 9, slippageBps: 50 }),
    ).toBeCloseTo(2500 / 441, 12);
  });

  it("returns null, never a number, when no size can pay for itself", () => {
    // Denominator at zero and below: the benefit is gone, so there is no floor
    // to quote. Null is "do not recommend", and it must not read as 0 - a
    // caller treating it as 0 recommends EVERY repay in exactly this case.
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 500, flashFeeBps: 500 })).toBeNull();
    expect(
      repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 500, flashFeeBps: 400, slippageBps: 200 }),
    ).toBeNull();
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: 0 })).toBeNull();
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: -100 })).toBeNull();
  });

  it("rejects inputs it cannot compute with, and lets free gas through", () => {
    expect(repayUsdFloor({ gasUsd: Number.NaN, penaltyAvoidedBps: 500 })).toBeNull();
    expect(repayUsdFloor({ gasUsd: Number.POSITIVE_INFINITY, penaltyAvoidedBps: 500 })).toBeNull();
    expect(repayUsdFloor({ gasUsd: -1, penaltyAvoidedBps: 500 })).toBeNull();
    expect(repayUsdFloor({ gasUsd: 0.25, penaltyAvoidedBps: Number.NaN })).toBeNull();
    expect(repayUsdFloor({ gasUsd: 0, penaltyAvoidedBps: 500 })).toBe(0);
  });

  it("every protocol carries a penalty and resolves to a floor", () => {
    const protocols: Protocol[] = ["aave_v3", "moonwell", "morpho", "compound_v3"];
    for (const p of protocols) {
      expect(LIQUIDATION_PENALTY_BPS[p]).toBeGreaterThan(0);
      const floor = protocolRepayUsdFloor(p);
      expect(floor).not.toBeNull();
      // The default gas band puts every floor in single-digit dollars: this is
      // a dust guard, and a floor that reached tens of dollars would start
      // suppressing repays a user would want.
      expect(floor as number).toBeGreaterThan(0);
      expect(floor as number).toBeLessThan(10);
    }
    expect(protocolRepayUsdFloor("aave_v3")).toBe(
      repayUsdFloor({ gasUsd: DEFAULT_GAS_USD, penaltyAvoidedBps: 500 }),
    );
  });

  it("scales with the gas the caller supplies", () => {
    expect(protocolRepayUsdFloor("aave_v3", 1)).toBeCloseTo(20, 12);
    expect(protocolRepayUsdFloor("aave_v3", 0)).toBe(0);
  });
});

describe("adviseLeg suppresses a repay that cannot pay for itself", () => {
  // HF 1.74 against a moderate target of 1.75 on a $500 debt: the sized repay
  // is a couple of dollars, and Aave's floor at default gas is $5.
  const target = TARGET_HF.moderate;
  const dustLeg = leg({ healthFactor: 1.74, borrowValueUsd: 500, collateralValueUsd: 1_000 });

  it("the case is real: the sized repay lands under the floor", () => {
    const sized = repayToTargetHf(500, 1.74, target);
    expect(sized).toBeGreaterThan(0);
    expect(sized).toBeLessThan(protocolRepayUsdFloor("aave_v3") as number);
  });

  it("does not emit a REDUCE, and says why in the triggers", () => {
    const rec = adviseLeg(dustLeg, "moderate");
    expect(rec.action).not.toBe("REDUCE");
    expect(rec.repayPlan).toBeUndefined();
    expect(rec.exitPrefill).toBeUndefined();
    expect(rec.triggers).toContain("repay:below_floor");
    // The health factor is BELOW target here, so the pre-existing "nothing to
    // repay" trigger would be a false statement about the position.
    expect(rec.triggers).not.toContain("hf:above_target");
  });

  it("keeps the leg in the report on the existing decision-shape", () => {
    // Suppression is not silence: the leg falls through to the rebalance and
    // monitor rules exactly as a leg already at target does. HIGH band means
    // `statusFor` puts it outside the profile, so it lands on MONITOR.
    const rec = adviseLeg(dustLeg, "moderate");
    expect(rec.action).toBe("MONITOR");
    expect(rec.sections.recommendation.length).toBeGreaterThan(0);
  });

  it("a repay above the floor is untouched", () => {
    const rec = adviseLeg(leg({ healthFactor: 1.2, borrowValueUsd: 8_000 }), "moderate");
    expect(rec.action).toBe("REDUCE");
    expect(rec.repayPlan?.repayUsd).toBeGreaterThan(protocolRepayUsdFloor("aave_v3") as number);
    expect(rec.triggers).not.toContain("repay:below_floor");
  });

  it("sits exactly on the boundary: at the floor it is recommended, below it is not", () => {
    // Solve for the debt whose sized repay is exactly the floor:
    // R = D(1 - hf/T)  =>  D = R / (1 - hf/T).
    const floor = protocolRepayUsdFloor("aave_v3") as number;
    const hf = 1.7;
    const atFloor = floor / (1 - hf / target);
    expect(repayToTargetHf(atFloor, hf, target)).toBeCloseTo(floor, 9);

    const at = adviseLeg(leg({ healthFactor: hf, borrowValueUsd: atFloor }), "moderate");
    expect(at.action).toBe("REDUCE");

    const below = adviseLeg(
      leg({ healthFactor: hf, borrowValueUsd: atFloor * 0.99 }),
      "moderate",
    );
    expect(below.action).not.toBe("REDUCE");
    expect(below.triggers).toContain("repay:below_floor");
  });

  it("the gas input moves the gate", () => {
    const marginal = leg({ healthFactor: 1.2, borrowValueUsd: 8_000 });
    expect(adviseLeg(marginal, "moderate").action).toBe("REDUCE");
    // The same leg at absurd gas: a $2,514 repay no longer covers $500 of gas
    // against a 5% penalty (floor $10,000).
    const expensive = adviseLeg(marginal, "moderate", undefined, { gasUsd: 500 });
    expect(expensive.action).not.toBe("REDUCE");
    expect(expensive.triggers).toContain("repay:below_floor");
  });

  it("a CRITICAL leg is band-driven and the floor never reaches it", () => {
    // Rule 1 returns before any repay is sized, which is correct: the floor is
    // about whether a REPAY pays for itself, not about whether a position an
    // exit is recommended for is worth exiting.
    const rec = adviseLeg(
      leg({ total: 80, band: "CRITICAL", healthFactor: 1.02, borrowValueUsd: 60 }),
      "moderate",
      undefined,
      { gasUsd: 1_000 },
    );
    expect(rec.action).toBe("EXIT");
    expect(rec.triggers).not.toContain("repay:below_floor");
  });
});

/**
 * The fork-measured constants.
 *
 * These are not arithmetic assertions, they are a LEDGER: every value below was
 * read off a pinned Base mainnet fork, and a silent edit to one would move a
 * money-path gate with nothing to catch it. The test's job is to make changing
 * them a deliberate act with a stated reason.
 */
describe("fork-measured constants", () => {
  it("names the fork the readings came from", () => {
    expect(FORK_MEASUREMENT.chain).toBe("Base mainnet");
    expect(FORK_MEASUREMENT.block).toBe(49_691_000);
  });

  it("carries the Aave non-e-mode liquidation bonuses as read", () => {
    // liquidationBonus 10500 / 10750 on the 1e4 scale => 500 / 750 bps.
    expect(AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS.WETH).toBe(500);
    expect(AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS.cbBTC).toBe(750);
  });

  it("uses the LOWER Aave bonus for the protocol-wide penalty", () => {
    // A single per-protocol number cannot know which collateral a leg holds,
    // and the lower penalty yields the HIGHER floor - the direction that cannot
    // claim a repay pays for itself on a market where it does not.
    expect(LIQUIDATION_PENALTY_BPS.aave_v3).toBe(
      Math.min(...Object.values(AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS)),
    );
  });

  it("carries the Compound III penalty derived from liquidationFactor", () => {
    // liquidationFactor 0.95e18 => penalty = 1e18 - 0.95e18 = 5%.
    expect(LIQUIDATION_PENALTY_BPS.compound_v3).toBe(500);
  });

  it("leaves the two unmeasured penalties alone", () => {
    // Moonwell and Morpho were NOT captured by the fork suite. Changing either
    // without a reading is the thing this pins.
    expect(LIQUIDATION_PENALTY_BPS.moonwell).toBe(700);
    expect(LIQUIDATION_PENALTY_BPS.morpho).toBe(500);
  });

  it("prices the flash sources, free first and Aave last", () => {
    expect(FLASH_FEE_BPS.balancer_v2).toBe(0);
    expect(FLASH_FEE_BPS.morpho_singleton).toBe(0);
    expect(FLASH_FEE_BPS.aave_v3).toBe(5);
  });

  it("charges the worst case of the route, and nothing on Morpho Blue", () => {
    // Balancer -> Morpho -> Aave, so the ceiling is Aave's premium.
    expect(DELEVERAGE_FLASH_FEE_BPS.aave_v3).toBe(FLASH_FEE_BPS.aave_v3);
    expect(DELEVERAGE_FLASH_FEE_BPS.moonwell).toBe(FLASH_FEE_BPS.aave_v3);
    expect(DELEVERAGE_FLASH_FEE_BPS.compound_v3).toBe(FLASH_FEE_BPS.aave_v3);
    // Structurally zero: that leg repays inside onMorphoRepay and never flashes.
    expect(DELEVERAGE_FLASH_FEE_BPS.morpho).toBe(0);
  });

  it("carries the measured deleverage gas, in units", () => {
    expect(DELEVERAGE_GAS_UNITS).toEqual({
      aave_v3: 693_320,
      compound_v3: 532_172,
      moonwell: 1_167_280,
      morpho: 348_959,
    });
  });
});

describe("gasUsdFromUnits", () => {
  it("prices a deleverage from a gas price and an ETH price", () => {
    // 693,320 gas at 0.01 gwei is 6.9332e12 wei = 6.9332e-6 ETH; at $4,000 that
    // is about 2.8 cents, which is the shape of a Base transaction.
    expect(gasUsdFromUnits(DELEVERAGE_GAS_UNITS.aave_v3, 10_000_000n, 4_000)).toBeCloseTo(
      0.0277328,
      6,
    );
  });

  it("keeps the wei arithmetic exact past the double range", () => {
    // 1e6 gas at 100 gwei is 1e17 wei - already past a double's exact-integer
    // range, which is why the reduction to nano-ETH happens in BigInt.
    expect(gasUsdFromUnits(1_000_000, 100_000_000_000n, 3_000)).toBeCloseTo(300, 9);
  });

  it("returns null for anything it cannot price, never 0", () => {
    expect(gasUsdFromUnits(Number.NaN, 1n, 1)).toBeNull();
    expect(gasUsdFromUnits(-1, 1n, 1)).toBeNull();
    expect(gasUsdFromUnits(1, -1n, 1)).toBeNull();
    expect(gasUsdFromUnits(1, 1n, Number.NaN)).toBeNull();
    expect(gasUsdFromUnits(1, 1n, -1)).toBeNull();
    // A genuinely free transaction is 0, and that is a different fact.
    expect(gasUsdFromUnits(1_000, 0n, 4_000)).toBe(0);
  });
});

describe("collateralFundedRepayUsdFloor", () => {
  it("is strictly higher than the wallet-funded floor where a flash fee is paid", () => {
    for (const protocol of ["aave_v3", "moonwell", "compound_v3"] as const) {
      expect(collateralFundedRepayUsdFloor(protocol) as number).toBeGreaterThan(
        protocolRepayUsdFloor(protocol) as number,
      );
    }
  });

  it("is higher on Morpho too, from slippage alone", () => {
    expect(DELEVERAGE_FLASH_FEE_BPS.morpho).toBe(0);
    expect(collateralFundedRepayUsdFloor("morpho") as number).toBeGreaterThan(
      protocolRepayUsdFloor("morpho") as number,
    );
  });

  it("matches the explicit cost shape it stands for", () => {
    expect(collateralFundedRepayUsdFloor("aave_v3")).toBe(
      repayUsdFloor({
        gasUsd: DEFAULT_GAS_USD,
        penaltyAvoidedBps: LIQUIDATION_PENALTY_BPS.aave_v3,
        flashFeeBps: DELEVERAGE_FLASH_FEE_BPS.aave_v3,
        slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
      }),
    );
  });

  it("returns null when the costs swallow the penalty entirely", () => {
    // A slippage allowance at the avoided penalty: no repay of any size pays
    // for itself, which is not a floor of zero.
    expect(collateralFundedRepayUsdFloor("aave_v3", DEFAULT_GAS_USD, 500)).toBeNull();
  });
});
