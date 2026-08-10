import { describe, expect, it, vi } from "vitest";
import { ActiveAdapter } from "../src/adapters/active";
import { AaveActiveReader } from "../src/adapters/activeAave";
import {
  AAVE_ORACLE_BASE,
  AAVE_POOL_BASE,
  KNOWN_AAVE_RESERVES,
  type PublicClientLike,
} from "../src/adapters/chain";
import { SCORING_CHAINS, scoringChainConfig, scoringChainMode } from "../src/chains";
import type { AssetRiskInput, SystemicRiskInput } from "../src/types";

const ok = (result: unknown) => ({ status: "success" as const, result });

describe("scoringChainMode", () => {
  it("defaults to mainnet for anything that is not exactly testnet", () => {
    for (const raw of [undefined, null, "", "  ", "main", "sepolia", "TESTNETT", "8453"]) {
      expect(scoringChainMode(raw)).toBe("mainnet");
    }
  });

  it("accepts testnet regardless of case or padding", () => {
    for (const raw of ["testnet", "TESTNET", " Testnet "]) {
      expect(scoringChainMode(raw)).toBe("testnet");
    }
  });

  it("resolves the config that matches the mode", () => {
    expect(scoringChainConfig(undefined)).toBe(SCORING_CHAINS.mainnet);
    expect(scoringChainConfig("testnet")).toBe(SCORING_CHAINS.testnet);
  });
});

describe("SCORING_CHAINS", () => {
  /**
   * The whole point of the default is that it changed nothing. If these drift
   * apart, the mainnet path is reading a market nobody chose to move it to.
   */
  it("mainnet reproduces the addresses the readers were hardcoded to", () => {
    const { aave } = SCORING_CHAINS.mainnet;
    expect(aave.pool).toBe(AAVE_POOL_BASE);
    expect(aave.oracle).toBe(AAVE_ORACLE_BASE);
    expect(aave.reserves).toBe(KNOWN_AAVE_RESERVES);
    expect(SCORING_CHAINS.mainnet.chainId).toBe(8453);
    expect(SCORING_CHAINS.mainnet.marketContext).toBe("measured");
    expect([...SCORING_CHAINS.mainnet.protocols].sort()).toEqual([
      "aave_v3",
      "compound_v3",
      "moonwell",
      "morpho",
    ]);
  });

  /**
   * The exit executor is on 84532 (src/panik-core/lib/exit.generated.ts) and
   * `EXECUTABLE_PROTOCOLS.testnet` there is `["aave_v3"]`. Scoring a different
   * chain, or offering a protocol the exit cannot act on, is the incoherence
   * this config exists to prevent. Asserted rather than assumed because the two
   * tables live in different packages.
   */
  it("testnet targets the executor's chain and only its executable protocol", () => {
    expect(SCORING_CHAINS.testnet.chainId).toBe(84532);
    expect(SCORING_CHAINS.testnet.protocols).toEqual(["aave_v3"]);
    expect(SCORING_CHAINS.testnet.marketContext).toBe("unavailable");
  });

  it("every configured reserve fits the reader's 18-decimal ranking scale", () => {
    for (const config of Object.values(SCORING_CHAINS)) {
      for (const r of config.aave.reserves) {
        expect(r.decimals).toBeLessThanOrEqual(18);
        expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  it("no testnet reserve reuses a mainnet token address", () => {
    // Faucet assets are distinct contracts. WETH is the exception: Base and
    // Base Sepolia both put it at the same predeploy, which is real, not a
    // copy-paste, so it is named here rather than silently allowed.
    const mainnet = new Set(SCORING_CHAINS.mainnet.aave.reserves.map((r) => r.address.toLowerCase()));
    const shared = SCORING_CHAINS.testnet.aave.reserves
      .map((r) => r.address.toLowerCase())
      .filter((a) => mainnet.has(a));
    expect(shared).toEqual(["0x4200000000000000000000000000000000000006"]);
  });
});

describe("AaveActiveReader with a configured market", () => {
  it("scans the reserves it was given, at their own decimals", async () => {
    const { aave } = SCORING_CHAINS.testnet;
    const n = aave.reserves.length;
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([
          199_976_070_681n, // $1,999.76 collateral (8 dec)
          119_907_600_293n, // $1,199.08 debt
          0n,
          8600n, // liquidation threshold 86.00%
          8250n, // maxLtv 82.50%
          1_434266221368954070n, // HF 1.4343
        ]),
        ...aave.reserves.map((r) => ok({
          aTokenAddress: `${r.symbol}-a`,
          stableDebtTokenAddress: `${r.symbol}-s`,
          variableDebtTokenAddress: `${r.symbol}-v`,
        })),
      ])
      .mockResolvedValueOnce([
        // aToken balances: 2,000 USDC (6 dec) and nothing else.
        ok(2_000_000000n),
        ...Array.from({ length: n - 1 }, () => ok(0n)),
        // Oracle prices, 1e8 base units.
        ok(99_987_959n),
        ok(99_922_992n),
        ok(6_499_639_059_320n),
        ok(191_645_096_421n),
        ok(217_942_269_504n),
        ok(818_203_158n),
        // Variable debt: 1,200 USDT (6 dec) on reserve index 1.
        ok(0n),
        ok(1_200_000099n),
        ...Array.from({ length: n - 2 }, () => ok(0n)),
        // Stable debt: none.
        ...Array.from({ length: n }, () => ok(0n)),
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client, aave.pool, aave.oracle, aave.reserves).read("0xw");

    // The pool and oracle it was configured with, not the mainnet defaults.
    expect(multicall.mock.calls[0]![0].contracts[0].address).toBe(aave.pool);
    expect(multicall.mock.calls[1]![0].contracts[n]!.address).toBe(aave.oracle);
    // One request per reserve on each of the four legs, plus the account read.
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(n + 1);
    expect(multicall.mock.calls[1]![0].contracts).toHaveLength(4 * n);

    expect(r?.positionHealth.healthFactor).toBeCloseTo(1.434266, 6);
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.825, 9);
    expect(r?.collateralValueUsd).toBeCloseTo(1999.76070681, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(1199.07600293, 6);
    expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.86, 9);
    expect(r?.dominantCollateralSymbol).toBe("USDC");
    expect(r?.dominantBorrowSymbol).toBe("USDT");
  });
});

describe("ActiveAdapter with market context unavailable", () => {
  const reading = {
    read: async () => ({
      protocol: "aave_v3" as const,
      positionHealth: { healthFactor: 1.434266, currentLtv: 0.5996, maxLtv: 0.825 },
      collateralValueUsd: 1999.76,
      borrowValueUsd: 1199.08,
      weightedLiquidationThreshold: 0.86,
      dominantCollateralSymbol: "USDC",
      dominantBorrowSymbol: "USDT",
    }),
  };
  const calmAsset: AssetRiskInput = {
    dailyReturns30d: Array(30).fill(0),
    btcReturns30d: Array(30).fill(0),
    prices90d: Array(90).fill(100),
  };
  const calmSystemic: SystemicRiskInput = {
    sectorTvlNow: 1,
    sectorTvl7dAgo: 1,
    protocolTvlNow: 1,
    protocolTvl7dAgo: 1,
  };

  it("leaves both market terms unmeasured without calling, or failing, a provider", async () => {
    const getAssetRiskInput = vi.fn(async () => calmAsset);
    const getSystemicRiskInput = vi.fn(async () => calmSystemic);
    const onReaderError = vi.fn();

    const [score] = await new ActiveAdapter(
      [reading],
      { assetRisk: { getAssetRiskInput }, systemic: { getSystemicRiskInput } },
      onReaderError,
      { marketContext: "unavailable" },
    ).scoreWallet("0xw");

    expect(getAssetRiskInput).not.toHaveBeenCalled();
    expect(getSystemicRiskInput).not.toHaveBeenCalled();
    // "Nothing to measure" is not an outage; it must not page anyone.
    expect(onReaderError).not.toHaveBeenCalled();

    expect(score?.subScores.assetRisk).toBeNull();
    expect(score?.subScores.systemicRisk).toBeNull();
    expect(score?.marketContextUnavailable).toBe(true);
  });

  it("still produces a real, non-zero score from the terms it did measure", async () => {
    const [score] = await new ActiveAdapter(
      [reading],
      {
        assetRisk: { getAssetRiskInput: async () => calmAsset },
        systemic: { getSystemicRiskInput: async () => calmSystemic },
      },
      undefined,
      { marketContext: "unavailable" },
    ).scoreWallet("0xw");

    // A degraded read must never surface as a 0/100 "secure" score, and the USD
    // magnitudes come from the market's own oracle so they are never withheld.
    expect(score?.total).toBeGreaterThan(0);
    expect(score?.total).toBe(44);
    expect(score?.band).toBe("ELEVATED");
    expect(score?.subScores.positionHealth).toBeGreaterThan(0);
    expect(score?.healthFactor).toBeCloseTo(1.434266, 6);
    expect(score?.collateralValueUsd).toBe(1999.76);
    expect(score?.borrowValueUsd).toBe(1199.08);
    expect(score?.usdValuesUnavailable).toBe(false);
  });

  it("defaults to measured, so existing callers are unchanged", async () => {
    const getAssetRiskInput = vi.fn(async () => calmAsset);
    const [score] = await new ActiveAdapter([reading], {
      assetRisk: { getAssetRiskInput },
      systemic: { getSystemicRiskInput: async () => calmSystemic },
    }).scoreWallet("0xw");

    expect(getAssetRiskInput).toHaveBeenCalledOnce();
    expect(score?.marketContextUnavailable).toBe(false);
    expect(score?.subScores.assetRisk).not.toBeNull();
  });
});
