import { describe, expect, it } from "vitest";
import { scoreProspective } from "../src/adapters/prospective";
import { marketParams } from "../src/markets";
import type { AssetRiskInput, SystemicRiskInput } from "../src/types";

/** Calm-market stub providers — isolate the adapter's own math. */
const calmAsset: AssetRiskInput = {
  dailyReturns30d: Array(30).fill(0),
  btcReturns30d: Array(30).fill(0),
  maxPrice90d: 100,
  minPrice90d: 100,
};
const calmSystemic: SystemicRiskInput = {
  sectorTvlNow: 100e9,
  sectorTvl7dAgo: 100e9,
  protocolTvlNow: 5e9,
  protocolTvl7dAgo: 5e9,
};
const providers = {
  assetRisk: { getAssetRiskInput: async () => calmAsset },
  systemic: { getSystemicRiskInput: async () => calmSystemic },
};

describe("scoreProspective (Compass scenario adapter)", () => {
  it("computes the scenario HF from the market's liquidation threshold", async () => {
    const r = await scoreProspective(
      {
        protocol: "aave_v3",
        collateralSymbol: "WETH",
        collateralValueUsd: 5000,
        borrowValueUsd: 2000,
      },
      providers,
    );
    expect(r.healthFactor).toBeCloseTo((5000 * 0.83) / 2000, 6); // 2.075
    expect(r.liquidationDrawdown).toBeCloseTo(1 - 1 / 2.075, 4);
    expect(r.band).toBe("LOW"); // calm market, comfortable HF
  });

  it("near-liquidation scenarios hit the proximity floor", async () => {
    const r = await scoreProspective(
      {
        protocol: "aave_v3",
        collateralSymbol: "WETH",
        collateralValueUsd: 5000,
        borrowValueUsd: 3900, // HF ≈ 1.064
      },
      providers,
    );
    expect(r.band).toBe("CRITICAL");
  });

  it("no-debt scenarios have null HF and score LOW", async () => {
    const r = await scoreProspective(
      {
        protocol: "moonwell",
        collateralSymbol: "USDC",
        collateralValueUsd: 2000,
        borrowValueUsd: 0,
      },
      providers,
    );
    expect(r.healthFactor).toBeNull();
    expect(r.liquidationDrawdown).toBeNull();
    expect(r.band).toBe("LOW");
  });

  it("rejects unknown markets", async () => {
    await expect(
      scoreProspective(
        {
          protocol: "aave_v3",
          collateralSymbol: "DOGE",
          collateralValueUsd: 1,
          borrowValueUsd: 0,
        },
        providers,
      ),
    ).rejects.toThrow("Unknown market");
  });
});

/**
 * The one way to read `MARKETS`. It exists because a UI surface indexing the
 * table itself is how a missing listing became a borrow limit on screen (issue
 * #61): `undefined` multiplies to `NaN` and the tidy-looking repair is a
 * literal, whereas a `null` has to be handled.
 */
describe("marketParams", () => {
  it("answers per asset, not per protocol", () => {
    expect(marketParams("aave_v3", "WETH")?.maxLtv).toBe(0.8);
    expect(marketParams("aave_v3", "wstETH")?.maxLtv).toBe(0.75);
    expect(marketParams("morpho", "WETH")?.maxLtv).toBe(0.86);
    expect(marketParams("compound_v3", "WETH")?.maxLtv).toBe(0.78);
  });

  it("is null for a pair the table does not list", () => {
    expect(marketParams("moonwell", "wstETH")).toBeNull();
    expect(marketParams("aave_v3", "DOGE")).toBeNull();
  });

  it("looks through the proxy marker, which is not part of the symbol", () => {
    expect(marketParams("aave_v3", "WETH (proxy)")).toBe(marketParams("aave_v3", "WETH"));
  });
});
