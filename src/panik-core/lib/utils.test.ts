/**
 * Plain-language risk copy. These strings are the product's whole answer to
 * "am I about to be liquidated", so the cases that are easy to get subtly
 * wrong — no debt, already liquidatable, a rounding that flatters — are the
 * ones asserted here rather than the happy path alone.
 */
import { describe, expect, it } from "vitest";
import { liquidationOutlook } from "./utils";

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
    expect(o.hover).toBeNull();
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
      expect(o.hover ?? "").not.toContain("—");
    }
  });
});
