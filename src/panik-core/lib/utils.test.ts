/**
 * Plain-language risk copy. These strings are the product's whole answer to
 * "am I about to be liquidated", so the cases that are easy to get subtly
 * wrong — no debt, already liquidatable, a rounding that flatters — are the
 * ones asserted here rather than the happy path alone.
 */
import { describe, expect, it } from "vitest";
import {
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
} from "./utils";

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
