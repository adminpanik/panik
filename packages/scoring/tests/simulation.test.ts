/**
 * The price-override boundary: what it changes, what it refuses to change, and
 * how it dies.
 *
 * The load-bearing case is the LAST group. A cleared or expired simulation must
 * leave the engine byte-identical to one that was never armed, because the
 * alternative is a product whose numbers are subtly wrong for the rest of the
 * process's life with nothing visibly broken.
 */

import { describe, expect, it } from "vitest";
import {
  activeSimulation,
  applySimulationToReading,
  ARMABLE_SCENARIO_KEYS,
  formatSimulationRemaining,
  isUsableMultiplier,
  MARKET_SCENARIOS,
  multiplierFromPct,
  pctFromMultiplier,
  scenarioByKey,
  simulationMultiplierFor,
  simulationRemainingMs,
  type MarketSimulation,
} from "../src/simulation";
import type { ActiveReading } from "../src/adapters/activeAave";

const T0 = 1_700_000_000_000;

function sim(overrides: Partial<MarketSimulation> = {}): MarketSimulation {
  return {
    id: "sim-1",
    scenario: "crash",
    label: "Crash",
    multipliers: { cbBTC: 0.6 },
    setBy: "admin.panik@gmail.com",
    startedAt: T0,
    expiresAt: T0 + 60 * 60_000,
    ...overrides,
  };
}

function reading(overrides: Partial<ActiveReading> = {}): ActiveReading {
  return {
    protocol: "aave_v3",
    positionHealth: { healthFactor: 2.0, currentLtv: 0.4, maxLtv: 0.8 },
    collateralValueUsd: 20_000,
    borrowValueUsd: 8_000,
    weightedLiquidationThreshold: 0.8,
    dominantCollateralSymbol: "cbBTC",
    dominantBorrowSymbol: "USDC",
    ...overrides,
  };
}

describe("scenario constants", () => {
  it("carries the -20 / -40 / -55 magnitudes the Watch tab uses", () => {
    expect(MARKET_SCENARIOS.map((s) => s.pct)).toEqual([0, -0.2, -0.4, -0.55]);
  });

  it("offers exactly the three non-zero scenarios as armable", () => {
    expect([...ARMABLE_SCENARIO_KEYS]).toEqual(["stress", "crash", "blackswan"]);
    for (const key of ARMABLE_SCENARIO_KEYS) {
      expect(scenarioByKey(key)?.pct).toBeLessThan(0);
    }
  });

  it("round-trips a percentage through a multiplier", () => {
    for (const s of MARKET_SCENARIOS) {
      expect(pctFromMultiplier(multiplierFromPct(s.pct))).toBeCloseTo(s.pct, 12);
    }
    // The one conversion anybody will check by hand.
    expect(multiplierFromPct(-0.4)).toBeCloseTo(0.6, 12);
  });

  it("refuses a multiplier that is not a price", () => {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, "0.6"]) {
      expect(isUsableMultiplier(bad)).toBe(false);
    }
    expect(isUsableMultiplier(0.6)).toBe(true);
  });
});

describe("the override is applied", () => {
  it("moves the health factor, not just the dollars", () => {
    // The whole point. HF is a ratio each reader computes itself and hands over
    // untouched; scaling only collateralValueUsd would move the money on screen
    // and leave the band, the score and the alert exactly where they were.
    const { reading: out, stamp } = applySimulationToReading(reading(), sim(), T0);
    expect(out.collateralValueUsd).toBeCloseTo(12_000, 9);
    expect(out.positionHealth.healthFactor).toBeCloseTo(1.2, 9);
    expect(out.positionHealth.currentLtv).toBeCloseTo(0.4 / 0.6, 9);
    expect(stamp?.healthFactorMultiplier).toBeCloseTo(0.6, 9);
  });

  it("leaves the debt and the protocol's own parameters alone", () => {
    const { reading: out } = applySimulationToReading(reading(), sim(), T0);
    expect(out.borrowValueUsd).toBe(8_000);
    expect(out.positionHealth.maxLtv).toBe(0.8);
    expect(out.weightedLiquidationThreshold).toBe(0.8);
  });

  it("moves a debt asset too when the scenario names one", () => {
    const { reading: out, stamp } = applySimulationToReading(
      reading(),
      sim({ multipliers: { cbBTC: 0.6, USDC: 0.5 } }),
      T0,
    );
    expect(out.borrowValueUsd).toBeCloseTo(4_000, 9);
    // HF moves by the RATIO, so halving the debt cancels part of the crash.
    expect(out.positionHealth.healthFactor).toBeCloseTo(2.0 * (0.6 / 0.5), 9);
    expect(stamp?.borrowMultiplier).toBe(0.5);
  });

  it("leaves a same-asset market's distance to liquidation untouched", () => {
    // Collateral and debt in one asset: the price rescales both sides, and the
    // buffer genuinely does not move. The Watch tab suppresses its scenario
    // chips for exactly this case; the engine reaches the same answer by math.
    const { reading: out, stamp } = applySimulationToReading(
      reading({ dominantCollateralSymbol: "USDC", dominantBorrowSymbol: "USDC" }),
      sim({ multipliers: { USDC: 0.6 } }),
      T0,
    );
    expect(out.positionHealth.healthFactor).toBeCloseTo(2.0, 9);
    expect(stamp?.healthFactorMultiplier).toBeCloseTo(1, 9);
    // The dollar magnitudes DID move, so the leg is still marked.
    expect(out.collateralValueUsd).toBeCloseTo(12_000, 9);
    expect(stamp).not.toBeNull();
  });

  it("does not touch a leg holding an asset the scenario says nothing about", () => {
    const untouched = reading({ dominantCollateralSymbol: "WETH" });
    const { reading: out, stamp } = applySimulationToReading(untouched, sim(), T0);
    expect(out).toBe(untouched);
    expect(stamp).toBeNull();
  });

  it("matches asset symbols case-insensitively", () => {
    const { stamp } = applySimulationToReading(
      reading(),
      sim({ multipliers: { cbbtc: 0.6 } }),
      T0,
    );
    expect(stamp?.collateralMultiplier).toBe(0.6);
  });

  it("keeps an unknown dollar amount unknown", () => {
    // "Simulated" and "unavailable" are different states. A price we imagined
    // must not turn an amount we could not read into one we can - that is how a
    // made-up number ends up where the UI refuses to print a zero.
    const { reading: out, stamp } = applySimulationToReading(
      reading({ collateralValueUsd: null, borrowValueUsd: null, usdValuesUnavailable: true }),
      sim(),
      T0,
    );
    expect(out.collateralValueUsd).toBeNull();
    expect(out.borrowValueUsd).toBeNull();
    // The ratio is still exact, so the band still moves and the leg is marked.
    expect(out.positionHealth.healthFactor).toBeCloseTo(1.2, 9);
    expect(stamp).not.toBeNull();
  });

  it("keeps a debt-free position debt-free", () => {
    const { reading: out } = applySimulationToReading(
      reading({ positionHealth: { healthFactor: null, currentLtv: 0, maxLtv: 0.8 } }),
      sim(),
      T0,
    );
    expect(out.positionHealth.healthFactor).toBeNull();
  });

  it("ignores an unusable multiplier rather than scoring from it", () => {
    for (const bad of [0, -2, NaN]) {
      const { stamp } = applySimulationToReading(
        reading(),
        sim({ multipliers: { cbBTC: bad } }),
        T0,
      );
      expect(stamp).toBeNull();
    }
  });
});

describe("expiry auto-clears", () => {
  it("is live inside the window and dead outside it", () => {
    const s = sim();
    expect(activeSimulation(s, T0)).not.toBeNull();
    expect(activeSimulation(s, s.expiresAt - 1)).not.toBeNull();
    expect(activeSimulation(s, s.expiresAt)).toBeNull();
    expect(activeSimulation(s, s.expiresAt + 60_000)).toBeNull();
  });

  it("stops affecting a score the instant the window closes, with no action", () => {
    const s = sim();
    const before = applySimulationToReading(reading(), s, s.expiresAt - 1);
    const after = applySimulationToReading(reading(), s, s.expiresAt);
    expect(before.stamp).not.toBeNull();
    expect(after.stamp).toBeNull();
    expect(after.reading).toEqual(reading());
  });

  it("reports remaining time, floored at zero", () => {
    const s = sim();
    expect(simulationRemainingMs(s, T0)).toBe(60 * 60_000);
    expect(simulationRemainingMs(s, s.expiresAt + 5_000)).toBe(0);
    expect(formatSimulationRemaining(58 * 60_000)).toBe("58 minutes");
    expect(formatSimulationRemaining(60_000)).toBe("1 minute");
    expect(formatSimulationRemaining(20_000)).toBe("under a minute");
    expect(formatSimulationRemaining(0)).toBe("expired");
  });

  it("treats a scenario that moves nothing as no scenario at all", () => {
    // An "armed" simulation changing no number would light the marker over
    // figures that are, in fact, real: a marker that lies about itself.
    expect(activeSimulation(sim({ multipliers: {} }), T0)).toBeNull();
    expect(activeSimulation(sim({ multipliers: { cbBTC: 1 } }), T0)).toBeNull();
    expect(activeSimulation(sim({ multipliers: { cbBTC: 0 } }), T0)).toBeNull();
  });
});

describe("cleared state is identical to never-armed", () => {
  const base = reading();

  it("returns the very same reading object, not a rebuilt copy", () => {
    for (const dead of [null, undefined, sim({ expiresAt: T0 - 1 }), sim({ multipliers: {} })]) {
      const { reading: out, stamp } = applySimulationToReading(base, dead, T0);
      expect(out).toBe(base);
      expect(stamp).toBeNull();
    }
  });

  it("leaves no drift after arming and clearing", () => {
    const armed = applySimulationToReading(base, sim(), T0);
    expect(armed.reading).not.toEqual(base);
    // Clearing is not an inverse operation applied to the armed value; the
    // override is recomputed from the ORIGINAL reading every pass, so there is
    // no accumulated floating-point residue to undo.
    const cleared = applySimulationToReading(base, null, T0);
    expect(cleared.reading).toEqual(base);
  });

  it("never reports a multiplier for an unarmed scenario", () => {
    expect(simulationMultiplierFor(sim({ multipliers: {} }), "cbBTC")).toBe(1);
    expect(simulationMultiplierFor(sim(), null)).toBe(1);
    expect(simulationMultiplierFor(sim(), "WETH")).toBe(1);
  });
});
