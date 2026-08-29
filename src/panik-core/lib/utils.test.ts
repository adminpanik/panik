/**
 * Plain-language risk copy. These strings are the product's whole answer to
 * "am I about to be liquidated", so the cases that are easy to get subtly
 * wrong, no debt, already liquidatable, a rounding that flatters, are the
 * ones asserted here rather than the happy path alone.
 */
import { describe, expect, it } from "vitest";
import {
  assetLoanToValue,
  calculateDynamicPosition,
  liquidationOutlook,
  listedLiquidationThreshold,
  LOAN_TO_VALUE_UNAVAILABLE_HINT,
  LOAN_TO_VALUE_UNAVAILABLE_LABEL,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  PROTOCOL_LABEL,
  simulatedHealthFactor,
  UNLISTED_MARKET_HINT,
} from "./utils";
import type { LiveProtocol } from "./live";
import { MARKETS } from "../../../packages/scoring/src/markets";
import { estimateHealthFactor } from "../../../packages/scoring/src/prospective";

describe("liquidationOutlook", () => {
  it("states a health factor as the price drop it means", () => {
    // The four live fixture positions, which are also the four rows a reviewer
    // reads on the Portfolio tab.
    expect(liquidationOutlook(1.2, "WETH (proxy)").sentence).toBe(
      "Liquidates if WETH (proxy) falls 17%",
    );
    expect(liquidationOutlook(1.05, "cbBTC").sentence).toBe("Liquidates if cbBTC falls 4.8%");
    expect(liquidationOutlook(1.34, "cbBTC").sentence).toBe("Liquidates if cbBTC falls 25%");
  });

  it("no debt is not a zero drop: no debt cannot be liquidated at all", () => {
    const o = liquidationOutlook(null, "wstETH");
    expect(o.sentence).toBe("No debt");
    expect(o.sentence).not.toMatch(/falls|%/);
    expect(o.strip).toBe("none");
    expect(o.stripNote).toBe("no debt");
  });

  /**
   * The strip feeds a `Stat` value: one truncated 24px line. A value that
   * carries its own clause renders as "0%, liquidatab…" exactly where the clause
   * is the only thing stopping "0%" from reading as "perfectly safe".
   */
  it("keeps the strip a value and the clause beside it", () => {
    for (const hf of [null, 0.9, 1.0005, 1.2, 3]) {
      const o = liquidationOutlook(hf, "WETH");
      expect(o.strip).not.toContain(",");
      expect(o.strip.length).toBeLessThanOrEqual(11); // "under 0.1%"
    }
    const liquidatable = liquidationOutlook(0.95, "WETH");
    expect(liquidatable.strip).toBe("0%");
    expect(liquidatable.stripNote).toBe("liquidatable now");
    expect(liquidationOutlook(1.2, "WETH").stripNote).toBeNull();
  });

  /**
   * The Advisor strip is label/value pairs with NO sub-line, so it reads
   * `statLabel`/`statValue`. Joining `strip` and `stripNote` back together to
   * fill that slot is what put "none, no debt" and "0%, liquidatable now" where
   * a number belongs.
   */
  it("gives a slot with no sub-line a self-sufficient label and value", () => {
    for (const hf of [null, 0.9, 1.0005, 1.2, 3]) {
      const o = liquidationOutlook(hf, "WETH");
      expect(o.statValue).not.toContain(",");
      expect(o.statLabel).toBeTruthy();
      expect(o.statValue).toBeTruthy();
    }
    // A debt-free position has no liquidation price, so it answers a different
    // question rather than putting a clause in a percentage.
    const noDebt = liquidationOutlook(null, "wstETH");
    expect(noDebt.statLabel).toBe("Liquidation risk");
    expect(noDebt.statValue).toBe("None");
    expect(noDebt.statValue).not.toMatch(/\d/);
    // "0%" under "Drop to liquidation" reads as the inverse of the truth, so the
    // already-liquidatable case does not print a figure either.
    const liquidatable = liquidationOutlook(0.95, "WETH");
    expect(liquidatable.statLabel).toBe("Liquidation risk");
    expect(liquidatable.statValue).toBe("Liquidatable now");
    // The ordinary case is the drawdown, formatted exactly as the strip is.
    const normal = liquidationOutlook(1.05, "cbBTC");
    expect(normal.statLabel).toBe("Drop to liquidation");
    expect(normal.statValue).toBe(normal.strip);
  });

  /**
   * Every branch explains itself. When this was null for no debt, all three call
   * sites patched it with a sentence of their own and the three disagreed.
   */
  it("always has a hover, including the no-debt branch", () => {
    for (const hf of [null, 0.9, 1.0005, 1.2, 3]) {
      expect(liquidationOutlook(hf, "WETH").hover).toBeTruthy();
    }
    expect(liquidationOutlook(null, "wstETH").hover).toMatch(/Nothing is borrowed/);
  });

  it.each([1, 0.98, 0.5])(
    "HF %s is already liquidatable and never renders as a 0%% fall",
    (hf) => {
      const o = liquidationOutlook(hf, "cbBTC");
      expect(o.sentence).toBe("Can be liquidated at today's cbBTC price");
      expect(o.sentence).not.toMatch(/falls/);
    },
  );

  it("a drop too small to round is stated as a bound, not as zero", () => {
    // HF 1.0005 → 0.05%, which one decimal would print as "0.0%".
    expect(liquidationOutlook(1.0005, "WETH").sentence).toBe("Liquidates if WETH falls under 0.1%");
  });

  it("keeps a decimal only where it changes the decision", () => {
    expect(liquidationOutlook(1.05, "X").strip).toBe("4.8%"); // 4.8 and 5.4 are different days
    expect(liquidationOutlook(1.06, "X").strip).toBe("5.7%");
    expect(liquidationOutlook(2, "X").strip).toBe("50%"); // "50.0%" claims precision the model lacks
    // 9.96% must not print "10.0%": the one-decimal branch is re-checked after
    // rounding so no value in the UI carries a decimal it is not entitled to.
    expect(liquidationOutlook(1 / (1 - 0.0996), "X").strip).toBe("10%");
  });

  it("keeps the exact health factor reachable in the hover", () => {
    expect(liquidationOutlook(1.2, "WETH").hover).toContain("Health factor 1.20");
    expect(liquidationOutlook(0.9, "WETH").hover).toContain("Health factor 0.90");
  });

  it("states the assumption the conversion rests on", () => {
    expect(liquidationOutlook(1.2, "WETH").hover).toMatch(/estimate/);
  });

  it("emits no em dash on any branch", () => {
    for (const hf of [null, 0.9, 1.0005, 1.2, 3]) {
      const o = liquidationOutlook(hf, "WETH");
      expect(o.sentence).not.toContain("—");
      expect(o.strip).not.toContain("—");
      expect(o.stripNote ?? "").not.toContain("—");
      expect(o.statLabel).not.toContain("—");
      expect(o.statValue).not.toContain("—");
      expect(o.hover).not.toContain("—");
    }
  });
});

/**
 * Issue #61: the Open flow printed one hand-written pair of borrow limits
 * (82/78) as a fact about the user's protocol, and the engine disagreed with it
 * on every market it lists. These assert the two properties that stops
 * recurring: the figures come from `MARKETS`, and a market `MARKETS` does not
 * list produces no figure at all.
 */
describe("assetLoanToValue", () => {
  it("reads the engine's parameters per ASSET, not per protocol", () => {
    // The four rows of the issue's table, plus the pair that makes the point:
    // WETH and wstETH are different numbers on the same Aave.
    expect(assetLoanToValue("Aave V3", "WETH")).toMatchObject({
      borrowLimitPct: 80,
      liquidationPct: 83,
    });
    expect(assetLoanToValue("Aave V3", "wstETH")).toMatchObject({
      borrowLimitPct: 75,
      liquidationPct: 79,
    });
    expect(assetLoanToValue("Morpho", "WETH")).toMatchObject({
      borrowLimitPct: 86,
      liquidationPct: 86,
    });
    expect(assetLoanToValue("Compound V3", "WETH")).toMatchObject({
      borrowLimitPct: 78,
      liquidationPct: 84,
    });
    // Neither of the two literals this replaced was any market's number.
    for (const [protocol, assets] of Object.entries(MARKETS)) {
      for (const symbol of Object.keys(assets)) {
        const ltv = assetLoanToValue(PROTOCOL_LABEL[protocol as LiveProtocol], symbol);
        expect(ltv?.borrowLimitPct).toBe(Math.round(assets[symbol]!.maxLtv * 100));
        expect(ltv?.liquidationPct).toBe(
          Math.round(assets[symbol]!.liquidationThreshold * 100),
        );
      }
    }
  });

  it("moves the ceiling with the selected asset", () => {
    // Same protocol, different asset, different ceiling: the behaviour the
    // single 82/78 literal could not express.
    expect(assetLoanToValue("Aave V3", "WETH")?.ceilingPct).toBe(76);
    expect(assetLoanToValue("Aave V3", "wstETH")?.ceilingPct).toBe(71);
    expect(assetLoanToValue("Aave V3", "cbBTC")?.ceilingPct).toBe(69);
    // Same asset, different protocol, different ceiling.
    expect(assetLoanToValue("Morpho", "WETH")?.ceilingPct).toBe(82);
    expect(assetLoanToValue("Compound V3", "WETH")?.ceilingPct).toBe(74);
  });

  /**
   * The reason the ceiling is a margin below the borrow limit rather than the
   * limit itself: on Morpho and Moonwell the limit IS the liquidation
   * threshold, so a slider reaching it would offer a position whose starting
   * health factor is exactly 1.00, openable and immediately liquidatable.
   */
  it("never offers a position that opens liquidatable", () => {
    for (const [protocol, assets] of Object.entries(MARKETS)) {
      for (const symbol of Object.keys(assets)) {
        const ltv = assetLoanToValue(PROTOCOL_LABEL[protocol as LiveProtocol], symbol)!;
        const hf = estimateHealthFactor(100, ltv.ceilingPct, ltv.liquidationPct / 100);
        expect(hf).not.toBeNull();
        expect(hf!).toBeGreaterThan(1);
        // ...and it is a margin, so it never claims to be either engine figure.
        expect(ltv.ceilingPct).toBeLessThan(ltv.borrowLimitPct);
        expect(ltv.ceilingPct).toBeLessThan(ltv.liquidationPct);
      }
    }
  });

  it("has no figure for a market the engine does not list", () => {
    expect(assetLoanToValue("Moonwell", "wstETH")).toBeNull(); // not listed
    expect(assetLoanToValue("Compound V3", "USDC")).toBeNull(); // the base asset
    expect(assetLoanToValue("Aave V3", "PEPE")).toBeNull();
    expect(assetLoanToValue("Some New Protocol", "WETH")).toBeNull();
    // Null, not zero: a "0%" ceiling is a number, and a number here is a claim.
    expect(assetLoanToValue("Moonwell", "wstETH")?.ceilingPct).toBeUndefined();
  });

  it("resolves a symbol carrying the engine's proxy marker", () => {
    // `active.ts` scores an unpriceable asset against WETH and says so in the
    // symbol. It is still a WETH position as far as this table is concerned.
    expect(assetLoanToValue("Aave V3", "WETH (proxy)")?.borrowLimitPct).toBe(80);
    // ...and the marker never reaches the sentence a user reads.
    expect(assetLoanToValue("Aave V3", "WETH (proxy)")?.note).not.toContain("proxy");
  });

  it("states both engine figures in words, with no abbreviation or enum", () => {
    const note = assetLoanToValue("Aave V3", "wstETH")!.note;
    expect(note).toBe(
      "Aave V3 lets wstETH borrow up to 75% loan to value and can liquidate from 79%.",
    );
    expect(note).not.toMatch(/\bLTV\b/);
    expect(note).not.toContain("—");
    expect(note).not.toMatch(/aave_v3|compound_v3|maxLtv|liquidationThreshold/);
  });
});

describe("the missing-borrow-limits copy", () => {
  it("says what is unknown without printing a figure for it", () => {
    expect(LOAN_TO_VALUE_UNAVAILABLE_LABEL).not.toMatch(/\d/);
    expect(LOAN_TO_VALUE_UNAVAILABLE_HINT).not.toMatch(/\d/);
    for (const s of [LOAN_TO_VALUE_UNAVAILABLE_LABEL, LOAN_TO_VALUE_UNAVAILABLE_HINT]) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\bLTV\b|null|undefined|NaN/);
    }
  });
});

describe("marketContextMissing", () => {
  const measured = { assetRisk: 34, systemicRisk: 30 };

  it("is true when either market term was not measured", () => {
    expect(marketContextMissing({ ...measured, assetRisk: null })).toBe(true);
    expect(marketContextMissing({ ...measured, systemicRisk: null })).toBe(true);
    expect(marketContextMissing({ assetRisk: null, systemicRisk: null })).toBe(true);
  });

  it("is false when both were measured, including at zero", () => {
    expect(marketContextMissing(measured)).toBe(false);
    // 0 is a REAL score: the calmest reading either term has. Treating it as
    // absent would flip an honest case into a degraded banner, which is the
    // same conflation running the other way.
    expect(marketContextMissing({ assetRisk: 0, systemicRisk: 0 })).toBe(false);
  });
});

describe("the not-measured copy", () => {
  it("says what is missing in words a non-expert reads", () => {
    expect(MARKET_CONTEXT_MISSING_LABEL).toBe("Market risk not measured");
    // No numeral anywhere in the marker: a figure standing where an unknown
    // belongs is the exact thing this path exists to keep off the screen.
    expect(MARKET_CONTEXT_MISSING_LABEL).not.toMatch(/\d/);
  });

  it("names no provider, no enum and no em dash", () => {
    for (const s of [MARKET_CONTEXT_MISSING_LABEL, MARKET_CONTEXT_MISSING_HINT]) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/CoinGecko|DefiLlama|null|undefined|NaN/i);
    }
  });
});

/**
 * The Watch simulator used to hold a SECOND health-factor formula: its
 * price-scenario rows ran `collateral x price x demoMaxLtv / debt` against a
 * 0.82 / 0.78 pair keyed only by protocol, while the card beside them printed
 * the engine's. One position, two health factors on one screen (measured on the
 * mock fixture: "HF ~1.00" beside "Health factor 1.22").
 *
 * These assert the property that stops it recurring: there is one formula, it
 * is the engine's, and it is fed the threshold the engine lists for that pair.
 */
describe("simulatedHealthFactor", () => {
  it("is the engine's formula against the engine's listed threshold", () => {
    for (const [protocol, assets] of Object.entries(MARKETS)) {
      for (const [symbol, params] of Object.entries(assets)) {
        const label = PROTOCOL_LABEL[protocol as LiveProtocol];
        expect(simulatedHealthFactor(label, symbol, 128_500, 105_200)).toBe(
          estimateHealthFactor(128_500, 105_200, params.liquidationThreshold),
        );
        expect(listedLiquidationThreshold(label, symbol)).toBe(params.liquidationThreshold);
      }
    }
  });

  it("disagrees with the protocol-keyed literal it replaced, on every asset", () => {
    // The old helper returned 0.82 for Aave and 0.78 for everything else.
    // Neither was any listed market's liquidation threshold.
    const oldDemoMaxLtv = (label: string) => (label === "Aave V3" ? 0.82 : 0.78);
    for (const [protocol, assets] of Object.entries(MARKETS)) {
      for (const symbol of Object.keys(assets)) {
        const label = PROTOCOL_LABEL[protocol as LiveProtocol];
        expect(listedLiquidationThreshold(label, symbol)).not.toBe(oldDemoMaxLtv(label));
      }
    }
    // The fixture position the audit measured: Aave cbBTC, $128,500 against
    // $105,200. 0.78 is what Aave lists; 0.82 is what the literal claimed.
    expect(simulatedHealthFactor("Aave V3", "cbBTC", 128_500, 105_200)).toBeCloseTo(0.953, 3);
    expect((128_500 * 0.82) / 105_200).toBeCloseTo(1.002, 3);
  });

  it("has no health factor for no debt, and none for an unlisted market", () => {
    // No debt is the engine's own null, not a 9.99 sentinel and not a zero.
    expect(simulatedHealthFactor("Aave V3", "WETH", 50_000, 0)).toBeNull();
    // A market this build lists no parameters for has no threshold to divide
    // by, so it gets no ratio rather than one measured against an invented one.
    expect(simulatedHealthFactor("Moonwell", "wstETH", 50_000, 10_000)).toBeNull();
    expect(simulatedHealthFactor("Some New Protocol", "WETH", 50_000, 10_000)).toBeNull();
    expect(listedLiquidationThreshold("Aave V3", "PEPE")).toBeNull();
  });

  it("resolves the engine's proxy marker, like every other market lookup", () => {
    expect(simulatedHealthFactor("Moonwell", "WETH (proxy)", 84_200, 56_800)).toBe(
      estimateHealthFactor(84_200, 56_800, 0.81),
    );
  });
});

/**
 * `calculateDynamicPosition` is the Watch tab's OFFLINE fallback. Its score is
 * local arithmetic by design; the health factor it reports beside that score is
 * not, because the price-scenario rows state the same quantity.
 */
describe("calculateDynamicPosition", () => {
  it("reports the engine's health factor, not the fallback curve's clamp", () => {
    // 10 WETH at $2,000 against $1,000 of debt: far above the 9.99 the old
    // clamp pinned every comfortable position to.
    const state = calculateDynamicPosition("Aave V3", "WETH", 10, 1_000, 2_000);
    expect(state.healthFactor).toBe(estimateHealthFactor(20_000, 1_000, 0.83));
    expect(state.healthFactor!).toBeGreaterThan(9.99);
    // ...and the score is still the fallback's, in its own band.
    expect(state.status).toBe("LOW");
  });

  it("agrees with the scenario rows on the same position", () => {
    const state = calculateDynamicPosition("Aave V3", "cbBTC", 2, 105_200, 64_250);
    expect(state.healthFactor).toBe(
      simulatedHealthFactor("Aave V3", "cbBTC", 128_500, 105_200),
    );
  });

  it("has no health factor and no liquidation price without debt", () => {
    const state = calculateDynamicPosition("Morpho", "cbBTC", 1, 0, 64_250);
    expect(state.healthFactor).toBeNull();
    expect(state.liquidationPrice).toBe(0);
  });
});

describe("the unlisted-market copy", () => {
  it("does not say 'no debt' about a market that cannot be measured", () => {
    expect(UNLISTED_MARKET_HINT).not.toMatch(/no debt/i);
    expect(UNLISTED_MARKET_HINT).not.toContain("—");
    expect(UNLISTED_MARKET_HINT).not.toMatch(/null|undefined|NaN|liquidationThreshold/);
  });
});
