import { describe, expect, it, vi } from "vitest";
import { ActiveAdapter } from "../src/adapters/active";
import { adviseWallet } from "../src/advisor/rules";
import { AaveActiveReader } from "../src/adapters/activeAave";
import { MoonwellActiveReader } from "../src/adapters/activeMoonwell";
import { computeScore } from "../src/computeScore";
import type { PublicClientLike } from "../src/adapters/chain";
import type { AssetRiskInput, SystemicRiskInput } from "../src/types";

const UINT256_MAX = 2n ** 256n - 1n;
const ok = (result: unknown) => ({ status: "success" as const, result });

function reserveData(aToken: string) {
  return ok({
    aTokenAddress: aToken,
    stableDebtTokenAddress: `${aToken}-sdebt`,
    variableDebtTokenAddress: `${aToken}-vdebt`,
  });
}

/** AaveOracle quote in base-currency units — BASE_CURRENCY_UNIT() is 1e8. */
const price = (usd: number) => ok(BigInt(Math.round(usd * 1e8)));
/**
 * Live Base quotes, read from the AaveOracle on 2026-08-09. wstETH/WETH = 1.24
 * is the ratio the deleted price-class table could not represent at all: both
 * assets shared the 1_800 class.
 */
const ORACLE = {
  WETH: price(1915.79),
  USDC: price(0.99994),
  wstETH: price(2377.91),
  cbBTC: price(64857.87),
};
/** KNOWN_AAVE_RESERVES order: WETH, USDC, wstETH, cbBTC. */
const allPrices = [ORACLE.WETH, ORACLE.USDC, ORACLE.wstETH, ORACLE.cbBTC];

describe("AaveActiveReader", () => {
  it("maps getUserAccountData into PositionHealthInput (8-dec USD, bps LTV)", async () => {
    const multicall = vi
      .fn()
      // call 1: account data + 4 reserves
      .mockResolvedValueOnce([
        ok([
          10_000_00000000n, // $10,000 collateral (8 dec)
          4_000_00000000n, // $4,000 debt
          0n,
          8300n, // liquidation threshold 83.00%
          8000n, // maxLtv 80.00%
          1_660000000000000000n, // HF 1.66
        ]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      // call 2: aToken balances then oracle prices — 2 WETH ($3,832) dominates
      // 1,000 USDC ($1,000).
      .mockResolvedValueOnce([
        ok(2n * 10n ** 18n),
        ok(1_000n * 10n ** 6n),
        ok(0n),
        ok(0n),
        ...allPrices,
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");

    expect(r).not.toBeNull();
    expect(r?.positionHealth.healthFactor).toBeCloseTo(1.66, 9);
    expect(r?.positionHealth.currentLtv).toBeCloseTo(0.4, 9);
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.8, 9);
    expect(r?.collateralValueUsd).toBeCloseTo(10_000, 6);
    expect(r?.dominantCollateralSymbol).toBe("WETH");
    // Aave's own weighted threshold, in bps, from the tuple slot the reader
    // used to discard. It is the slot BEFORE ltv and must not collapse onto it.
    expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.83, 9);
    expect(r?.weightedLiquidationThreshold).not.toBe(r?.positionHealth.maxLtv);
  });

  it("reports an absent liquidation threshold as null, never 0", async () => {
    // Aave answers 0 bps when the account has no collateral configured as
    // such. Zero is a real threshold ("liquidates against any debt"), so
    // passing it on would let the deleverage math size a repay off a fiction.
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([1_000_00000000n, 500_00000000n, 0n, 0n, 0n, 2_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce([ok(1n * 10n ** 18n), ok(0n), ok(0n), ok(0n), ...allPrices]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.weightedLiquidationThreshold).toBeNull();
    // The rest of the read is unaffected — degrade one field, not the leg.
    expect(r?.positionHealth.healthFactor).toBeCloseTo(2.0, 9);
  });

  it("maps the zero-debt sentinel to null HF (never uint256.max)", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([5_000_00000000n, 0n, 0n, 0n, 8000n, UINT256_MAX]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce([ok(0n), ok(5_000n * 10n ** 6n), ok(0n), ok(0n), ...allPrices]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.positionHealth.healthFactor).toBeNull();
    expect(r?.dominantCollateralSymbol).toBe("USDC");
  });

  // The hardcoded price classes this replaced put WETH and wstETH in the SAME
  // 1_800 class, so they were ranked on raw token amount: 100 WETH beat
  // 90 wstETH even though 90 wstETH is worth ~$214k against ~$192k. A wrong
  // pick here is the wrong scored asset, the wrong safestAlternativeProtocol
  // and the wrong ExitFlow prefill.
  it("ranks wstETH above a larger WETH balance at real oracle prices", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([406_000_00000000n, 100_000_00000000n, 0n, 0n, 8000n, 2_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      // 100 WETH = $191,579 vs 90 wstETH = $214,012.
      .mockResolvedValueOnce([
        ok(100n * 10n ** 18n),
        ok(0n),
        ok(90n * 10n ** 18n),
        ok(0n),
        ...allPrices,
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.dominantCollateralSymbol).toBe("wstETH");
    expect(r?.dominantCollateralUnpriced).toBeUndefined();
  });

  it("ranks across decimals: 1 cbBTC (8 dec) over 10 WETH (18 dec)", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([84_000_00000000n, 10_000_00000000n, 0n, 0n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      // 10 WETH = $19,158 vs 1 cbBTC = $64,858. The old table's 60,000/1,800
      // ratio happened to agree here; it does not once BTC/ETH drifts.
      .mockResolvedValueOnce([
        ok(10n * 10n ** 18n),
        ok(0n),
        ok(0n),
        ok(1n * 10n ** 8n),
        ...allPrices,
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.dominantCollateralSymbol).toBe("cbBTC");
  });

  it("falls back to token amounts and flags the pick when a price is missing", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([406_000_00000000n, 100_000_00000000n, 0n, 0n, 8000n, 2_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce([
        ok(100n * 10n ** 18n),
        ok(0n),
        ok(90n * 10n ** 18n),
        ok(0n),
        ORACLE.WETH,
        ORACLE.USDC,
        { status: "failure" as const }, // wstETH feed unreadable this block
        ORACLE.cbBTC,
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");

    // No price for a competing leg means no value comparison: the ranking falls
    // back to decimal-normalised amounts, so the larger 100 WETH balance wins.
    expect(r?.dominantCollateralSymbol).toBe("WETH");
    expect(r?.dominantCollateralUnpriced).toBe(true);
    // Degrade, don't invent, and never render unknown as zero: the unpriced
    // asset is neither dropped from the ranking nor valued at $0, and the
    // position's own USD magnitudes come from getUserAccountData regardless.
    expect(r?.collateralValueUsd).toBeCloseTo(406_000, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(100_000, 6);
    expect(r?.usdValuesUnavailable).toBeUndefined();
    expect(r?.positionHealth.healthFactor).toBeCloseTo(2.0, 9);
  });

  it("does not call a single collateral's pick degraded when its price fails", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([214_000_00000000n, 50_000_00000000n, 0n, 0n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce([
        ok(0n),
        ok(0n),
        ok(90n * 10n ** 18n),
        ok(0n),
        ORACLE.WETH,
        ORACLE.USDC,
        { status: "failure" as const },
        ORACLE.cbBTC,
      ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    // Nothing to compare it against, so the pick is certain and unflagged.
    expect(r?.dominantCollateralSymbol).toBe("wstETH");
    expect(r?.dominantCollateralUnpriced).toBeUndefined();
  });

  it("returns null for wallets with no position", async () => {
    const multicall = vi.fn().mockResolvedValueOnce([
      ok([0n, 0n, 0n, 0n, 0n, UINT256_MAX]),
      reserveData("0xa"),
      reserveData("0xb"),
      reserveData("0xc"),
      reserveData("0xd"),
    ]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    expect(await new AaveActiveReader(client).read("0xempty")).toBeNull();
  });

  // The borrow side used to be invisible to the reader, so the advisor named
  // "USDC" for every wallet. The repay is executed in this asset's own units.
  // Read order in the second batch: aToken balances, prices, variable debt,
  // stable debt - 4 reserves each.
  const NO_DEBT = [ok(0n), ok(0n), ok(0n), ok(0n)];
  const aaveReads = (
    aTokens: unknown[],
    prices: unknown[],
    variableDebt: unknown[] = NO_DEBT,
    stableDebt: unknown[] = NO_DEBT,
  ) => [...aTokens, ...prices, ...variableDebt, ...stableDebt];

  it("names WETH as the dominant borrow when the wallet borrows WETH", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([84_000_00000000n, 19_158_00000000n, 0n, 8300n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce(
        aaveReads(
          [ok(0n), ok(0n), ok(0n), ok(1n * 10n ** 8n)], // collateral: 1 cbBTC
          allPrices,
          [ok(10n * 10n ** 18n), ok(0n), ok(0n), ok(0n)], // debt: 10 WETH
        ),
      );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.dominantBorrowSymbol).toBe("WETH");
    expect(r?.dominantCollateralSymbol).toBe("cbBTC");
  });

  it("ranks the borrow side by oracle value, not token amount", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([200_000_00000000n, 30_000_00000000n, 0n, 8300n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce(
        aaveReads(
          [ok(0n), ok(0n), ok(0n), ok(4n * 10n ** 8n)],
          allPrices,
          // 10,000 USDC ($10,000) is 1,000x the token amount of 10 WETH
          // ($19,158) and still the smaller debt.
          [ok(10n * 10n ** 18n), ok(10_000n * 10n ** 6n), ok(0n), ok(0n)],
        ),
      );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.dominantBorrowSymbol).toBe("WETH");
  });

  it("sums a reserve's stable and variable debt into one borrow leg", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([200_000_00000000n, 30_000_00000000n, 0n, 8300n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce(
        aaveReads(
          [ok(0n), ok(0n), ok(0n), ok(4n * 10n ** 8n)],
          allPrices,
          // 6 WETH variable ($11,495) vs 15,000 USDC variable: USDC leads on
          // the variable leg alone...
          [ok(6n * 10n ** 18n), ok(15_000n * 10n ** 6n), ok(0n), ok(0n)],
          // ...until the 4 WETH of stable debt is added to it ($19,158 total).
          [ok(4n * 10n ** 18n), ok(0n), ok(0n), ok(0n)],
        ),
      );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.dominantBorrowSymbol).toBe("WETH");
  });

  it("leaves the borrow asset unnamed when the wallet has no debt", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([5_000_00000000n, 0n, 0n, 8300n, 8000n, UINT256_MAX]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce(
        aaveReads([ok(2n * 10n ** 18n), ok(0n), ok(0n), ok(0n)], allPrices),
      );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    // Null, not "USDC": there is no debt, so there is no debt asset.
    expect(r?.dominantBorrowSymbol).toBeNull();
  });

  it("leaves the borrow asset unnamed when both debt reads fail", async () => {
    const fail = [
      { status: "failure" as const },
      { status: "failure" as const },
      { status: "failure" as const },
      { status: "failure" as const },
    ];
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([
        ok([200_000_00000000n, 30_000_00000000n, 0n, 8300n, 8000n, 3_000000000000000000n]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      .mockResolvedValueOnce(
        aaveReads([ok(0n), ok(0n), ok(0n), ok(4n * 10n ** 8n)], allPrices, fail, fail),
      );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    // getUserAccountData still says there IS debt; the reader just cannot say
    // in which asset, and an unreadable balance is not a zero balance.
    expect(r?.borrowValueUsd).toBeCloseTo(30_000, 6);
    expect(r?.dominantBorrowSymbol).toBeNull();
  });
});

describe("MoonwellActiveReader", () => {
  it("derives HF = Σ(collateral×CF)/borrow from entered markets", async () => {
    const readContract = vi.fn(async (args: unknown) => {
      const fn = (args as { functionName: string }).functionName;
      if (fn === "getAssetsIn") return ["0xmWETH"];
      if (fn === "oracle") return "0xoracle";
      throw new Error(`unexpected ${fn}`);
    });
    const multicall = vi
      .fn()
      // per-market batch: balance, borrow, exchangeRate, markets, price, underlying
      .mockResolvedValueOnce([
        ok(1n * 10n ** 8n), // mToken balance
        ok(1n * 10n ** 16n), // borrow 0.01 WETH raw
        ok(2n * 10n ** 26n), // exchangeRate → 0.02 WETH underlying
        ok([true, 800000000000000000n]), // CF 0.80
        ok(18n * 10n ** 20n), // price $1800 × 10^(36−18)
        ok("0xWETHunderlying"),
      ])
      // symbol lookup for dominant collateral
      .mockResolvedValueOnce([ok("WETH")]);

    const client = { multicall, readContract } as unknown as PublicClientLike;
    const r = await new MoonwellActiveReader(client).read("0xwallet");

    // collateral = 0.02 WETH × $1800 = $36; debt = 0.01 × $1800 = $18
    expect(r?.collateralValueUsd).toBeCloseTo(36, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(18, 6);
    expect(r?.positionHealth.healthFactor).toBeCloseTo((36 * 0.8) / 18, 6); // 1.6
    expect(r?.positionHealth.currentLtv).toBeCloseTo(0.5, 6);
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.8, 6);
    expect(r?.dominantCollateralSymbol).toBe("WETH");
    // Compound-V2 fork: the one collateralFactorMantissa is both the borrow
    // limit and the liquidation threshold, so these agree by construction.
    expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.8, 6);
    expect(r?.weightedLiquidationThreshold).toBe(r?.positionHealth.maxLtv);
  });

  it("returns null when no markets entered", async () => {
    const readContract = vi.fn(async () => []);
    const client = {
      multicall: vi.fn(),
      readContract,
    } as unknown as PublicClientLike;
    expect(await new MoonwellActiveReader(client).read("0xempty")).toBeNull();
  });
});

describe("MorphoActiveReader (official API)", async () => {
  const { MorphoActiveReader } = await import("../src/adapters/activeMorpho");
  const apiBody = (items: unknown[]) =>
    ({ ok: true, status: 200, json: async () => ({ data: { marketPositions: { items } } }) }) as unknown as Response;

  it("aggregates isolated markets with MIN health factor and filters closed ones", async () => {
    const reader = new MorphoActiveReader(async () =>
      apiBody([
        {
          healthFactor: 1.5,
          state: { collateralUsd: 1000, borrowAssetsUsd: 500 },
          market: { lltv: "860000000000000000", collateralAsset: { symbol: "WETH" }, loanAsset: { symbol: "USDC" } },
        },
        {
          healthFactor: 1.1, // the at-risk leg must drive the aggregate
          state: { collateralUsd: 3000, borrowAssetsUsd: 2500 },
          market: { lltv: "945000000000000000", collateralAsset: { symbol: "cbETH" }, loanAsset: { symbol: "WETH" } },
        },
        {
          healthFactor: null, // closed market — must be ignored
          state: { collateralUsd: 0, borrowAssetsUsd: 0 },
          market: { lltv: "860000000000000000", collateralAsset: { symbol: "cbBTC" }, loanAsset: { symbol: "USDC" } },
        },
      ]),
    );
    const r = await reader.read("0xw");
    expect(r?.positionHealth.healthFactor).toBeCloseTo(1.1, 9);
    expect(r?.collateralValueUsd).toBeCloseTo(4000, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(3000, 6);
    // weighted LLTV: (1000×0.86 + 3000×0.945) / 4000 = 0.92375
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.92375, 6);
    // Morpho Blue prices one factor per market: lltv IS the liquidation
    // threshold, so it is also the max LTV.
    expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.92375, 6);
    expect(r?.weightedLiquidationThreshold).toBe(r?.positionHealth.maxLtv);
    expect(r?.dominantCollateralSymbol).toBe("cbETH");
  });

  it("returns null when all markets are closed", async () => {
    const reader = new MorphoActiveReader(async () =>
      apiBody([
        {
          healthFactor: null,
          state: { collateralUsd: 0, borrowAssetsUsd: 0 },
          market: { lltv: "860000000000000000", collateralAsset: { symbol: "WETH" }, loanAsset: { symbol: "USDC" } },
        },
      ]),
    );
    expect(await reader.read("0xempty")).toBeNull();
  });
});

describe("CompoundActiveReader (Comet)", async () => {
  const { CompoundActiveReader } = await import("../src/adapters/activeCompound");

  const NOW_S = 1_770_000_000;
  const now = () => NOW_S;
  /** ETH/USD round tuple: [roundId, answer, startedAt, updatedAt, answeredInRound]. */
  const ethRound = (usd: number, ageS = 60) =>
    [0n, BigInt(Math.round(usd * 1e8)), 0n, BigInt(NOW_S - ageS), 0n] as const;
  /** ETH-quoted comet (like cWETHv3) — the market that needs the conversion. */
  const ethComets = [
    { address: "0xcometweth", baseSymbol: "WETH", priceInEth: true },
  ] as never;
  const usdComets = [
    { address: "0xcometusdc", baseSymbol: "USDC", priceInEth: false },
  ] as never;

  const assetInfo = (asset = "0xcbeth") =>
    ok({
      offset: 0,
      asset,
      priceFeed: "0xcbethfeed",
      scale: 10n ** 18n,
      borrowCollateralFactor: 750000000000000000n,
      liquidateCollateralFactor: 800000000000000000n,
    });

  it("derives HF from liquidateCollateralFactor and converts ETH-quoted markets to USD", async () => {
    const multicall = vi
      .fn()
      // head: numAssets, borrowBalanceOf, baseTokenPriceFeed, baseScale
      .mockResolvedValueOnce([ok(1), ok(1n * 10n ** 18n), ok("0xbasefeed"), ok(10n ** 18n)])
      // getAssetInfo(0): cbETH collateral, scale 1e18, borrowCF 0.75, liqCF 0.80
      .mockResolvedValueOnce([assetInfo()])
      // base price (1.0 in ETH terms), userCollateral (2 cbETH), cbETH price (1.05 ETH)
      .mockResolvedValueOnce([ok(1_00000000n), ok([2n * 10n ** 18n, 0n]), ok(1_05000000n)])
      // ETH/USD round — read only now that an ETH-quoted market has a position
      .mockResolvedValueOnce([ok(ethRound(2000))])
      // dominant symbol lookup
      .mockResolvedValueOnce([ok("cbETH")]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, ethComets, { now }).read("0xw");

    // collateral: 2 × 1.05 ETH × $2000 = $4200; borrow: 1 × 1.0 × $2000 = $2000
    expect(r?.collateralValueUsd).toBeCloseTo(4200, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(2000, 6);
    expect(r?.usdValuesUnavailable).toBeUndefined();
    expect(r?.positionHealth.healthFactor).toBeCloseTo((4200 * 0.8) / 2000, 6); // 1.68
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.75, 6);
    // Comet carries TWO factors per asset. The exposed threshold must be the
    // liquidate side (0.80), not the borrow side maxLtv already reports (0.75):
    // the smaller factor under-sizes a collateral-funded repay, leaving the
    // position short of the health it was told the repay would buy.
    expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.8, 6);
    expect(r?.weightedLiquidationThreshold).not.toBe(r?.positionHealth.maxLtv);
    expect(r?.dominantCollateralSymbol).toBe("cbETH");
  });

  // A cWETHv3 borrower: 40 WETH of debt against 60 cbETH at parity, liqCF 0.80.
  // HF = (60 × 0.80) / 40 = 1.20 — a RATIO, so it is exactly the same whether
  // ETH is worth $1 or $3000. Only the dollar magnitudes need the oracle.
  const fail = { status: "failure" as const };
  const whaleHead = () => [ok(1), ok(40n * 10n ** 18n), ok("0xbasefeed"), ok(10n ** 18n)];
  const whaleBody = (multicall: ReturnType<typeof vi.fn>) =>
    multicall
      .mockResolvedValueOnce([assetInfo()])
      .mockResolvedValueOnce([ok(1_00000000n), ok([60n * 10n ** 18n, 0n]), ok(1_00000000n)]);

  it("reports true USD for an ETH-quoted market when the round is healthy", async () => {
    const multicall = vi.fn().mockResolvedValueOnce(whaleHead());
    whaleBody(multicall)
      .mockResolvedValueOnce([ok(ethRound(3000))])
      .mockResolvedValueOnce([ok("cbETH")]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, ethComets, { now }).read("0xw");
    expect(r?.borrowValueUsd).toBeCloseTo(120_000, 6); // 40 WETH × $3000
    expect(r?.usdValuesUnavailable).toBeUndefined();
  });

  const unusableRounds: [string, unknown][] = [
    ["missing (multicall leg failed)", fail],
    ["non-positive answer", ok(ethRound(0))],
    ["negative answer", ok([0n, -1n, 0n, BigInt(NOW_S - 60), 0n])],
    ["zero updatedAt", ok([0n, 3000_00000000n, 0n, 0n, 0n])],
    // 1200s heartbeat × 1.5 grace = 1800s, the repo-wide ETH policy. A 3h-old
    // round is a routine Chainlink outage and must NOT be silently accepted.
    ["stale (older than heartbeat × grace)", ok(ethRound(3000, 3 * 3600))],
    ["future-dated", ok([0n, 3000_00000000n, 0n, BigInt(NOW_S + 3600), 0n])],
  ];

  it.each(unusableRounds)(
    "keeps the leg and withholds only USD when the ETH/USD round is %s",
    async (_label, round) => {
      const onWarn = vi.fn();
      const multicall = vi.fn().mockResolvedValueOnce(whaleHead());
      whaleBody(multicall)
        .mockResolvedValueOnce([round])
        .mockResolvedValueOnce([ok("cbETH")]);
      const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
      const r = await new CompoundActiveReader(client, ethComets, { now, onWarn }).read("0xw");

      // Degrade, don't delete: the risk-bearing half of the read survives.
      expect(r).not.toBeNull();
      expect(r?.positionHealth.healthFactor).toBeCloseTo(1.2, 9);
      expect(r?.positionHealth.currentLtv).toBeCloseTo(40 / 60, 9);
      expect(r?.positionHealth.maxLtv).toBeCloseTo(0.75, 9);
      // The liquidation threshold is a ratio too, so it rides out the dead feed.
      expect(r?.weightedLiquidationThreshold).toBeCloseTo(0.8, 9);
      // ...and the half that genuinely needs the oracle is withheld, not faked.
      expect(r?.collateralValueUsd).toBeNull();
      expect(r?.borrowValueUsd).toBeNull();
      expect(r?.usdValuesUnavailable).toBe(true);
      expect(onWarn).toHaveBeenCalledOnce();
    },
  );

  /**
   * A multicall stub keyed on the contract each batch targets, plus an ordered
   * `rest` for everything else (the ETH/USD round, the symbol lookup). The
   * reader walks its comets in PARALLEL, so a flat call-order chain would hand
   * one comet's getAssetInfo batch to the other comet's head read.
   */
  const perComet = (byComet: Record<string, unknown[][]>, rest: unknown[][] = []) =>
    vi.fn(({ contracts }: { contracts: readonly { address: string }[] }) =>
      Promise.resolve(byComet[contracts[0]?.address ?? ""]?.shift() ?? rest.shift() ?? []),
    );

  const bothComets = [
    { address: "0xcometusdc", baseSymbol: "USDC", priceInEth: false },
    { address: "0xcometweth", baseSymbol: "WETH", priceInEth: true },
  ] as never;
  // cUSDCv3: borrow 1,000 USDC against $2,000 of cbETH → HF (2000×0.8)/1000 = 1.6
  const usdcLeg = () => [
    [ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n)],
    [assetInfo("0xcbeth")],
    [ok(1_00000000n), ok([1n * 10n ** 18n, 0n]), ok(2000_00000000n)],
  ];
  // cWETHv3: 40 WETH borrow against 60 cbETH → HF 1.2, ETH/USD needed for USD
  const wethLeg = () => [
    whaleHead(),
    [assetInfo("0xcbeth")],
    [ok(1_00000000n), ok([60n * 10n ** 18n, 0n]), ok(1_00000000n)],
  ];

  // The shipping config (COMETS_BASE) holds BOTH cUSDCv3 and cWETHv3. Dropping
  // the ETH-quoted leg used to leave a fully-valid-looking "HF 1.6, comfortable"
  // reading with 40 WETH of real debt invisible.
  it("signals a degraded comet without losing the healthy one (two-comet config)", async () => {
    const onWarn = vi.fn();
    const multicall = perComet(
      { "0xcometusdc": usdcLeg(), "0xcometweth": wethLeg() },
      // ETH/USD unusable, then the dominant-symbol lookup.
      [[fail], [ok("cbETH")]],
    );

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, bothComets, { now, onWarn }).read("0xw");

    expect(r).not.toBeNull();
    // The degraded leg is SIGNALLED, not dropped: the aggregate reports the
    // worst isolated market (1.20), never the comfortable 1.6 of the USDC leg
    // and never the 1.58 a denomination-blind pooling would produce.
    expect(r?.positionHealth.healthFactor).toBeCloseTo(1.2, 9);
    expect(r?.usdValuesUnavailable).toBe(true);
    expect(r?.collateralValueUsd).toBeNull();
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("pools both comets when every round is usable", async () => {
    const multicall = perComet({ "0xcometusdc": usdcLeg(), "0xcometweth": wethLeg() }, [
      [ok(ethRound(3000))],
      [ok("cbETH")],
    ]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, bothComets, { now }).read("0xw");

    // USDC leg $2,000 / $1,000; WETH leg 60 × $3,000 = $180,000 / $120,000.
    expect(r?.collateralValueUsd).toBeCloseTo(182_000, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(121_000, 6);
    expect(r?.usdValuesUnavailable).toBeUndefined();
    expect(r?.positionHealth.healthFactor).toBeCloseTo((1600 + 144_000) / 121_000, 9);
  });

  it("warns once per bad round, not once per tick", async () => {
    const onWarn = vi.fn();
    const multicall = vi.fn();
    const arm = () => {
      multicall.mockResolvedValueOnce(whaleHead());
      whaleBody(multicall)
        .mockResolvedValueOnce([fail])
        .mockResolvedValueOnce([ok("cbETH")]);
    };
    arm();
    arm();
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const reader = new CompoundActiveReader(client, ethComets, { now, onWarn });
    await reader.read("0xw");
    await reader.read("0xw");
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("keeps USD-quoted markets alive without touching the ETH/USD feed", async () => {
    // cUSDCv3 does not need the conversion, so it must cost no oracle read at
    // all — and a dead ETH feed must never affect it.
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n)])
      .mockResolvedValueOnce([assetInfo()])
      .mockResolvedValueOnce([ok(1_00000000n), ok([1n * 10n ** 18n, 0n]), ok(2000_00000000n)])
      .mockResolvedValueOnce([ok("cbETH")]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, usdComets, { now }).read("0xw");
    expect(r?.borrowValueUsd).toBeCloseTo(1000, 6);
    expect(r?.collateralValueUsd).toBeCloseTo(2000, 6);
    expect(multicall).toHaveBeenCalledTimes(4); // head, infos, prices, symbol
  });

  // `userBasic` -> (principal, baseTrackingIndex, baseTrackingAccrued,
  // assetsIn, _reserved). `assetsIn` is Comet's bitmask over userCollateral.
  const userBasic = (assetsIn: number, principal = 0n) =>
    ok([principal, 0n, 0n, assetsIn, 0] as const);

  it("returns null — and never warns — for wallets with no Comet usage", async () => {
    const onWarn = vi.fn();
    const multicall = vi
      .fn()
      // head: numAssets, borrowBalanceOf, baseTokenPriceFeed, baseScale, userBasic
      .mockResolvedValueOnce([ok(1), ok(0n), ok("0xbf"), ok(10n ** 18n), userBasic(0)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    expect(await new CompoundActiveReader(client, ethComets, { now, onWarn }).read("0xempty"))
      .toBeNull();
    // The head multicall precedes any position check, so an unconditional warn
    // here would fire every 60s for every watched wallet on the platform.
    expect(onWarn).not.toHaveBeenCalled();
    // ONE call, not three. No borrow and an empty `assetsIn` mask settles it in
    // the head batch; the getAssetInfo and price batches below it would only
    // read a row of zeros to reach this same null. With two comets on Base and
    // a tick every 60s, the two calls saved here are the bulk of the reader's
    // RPC budget for wallets that use no Comet market at all.
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unreadable userBasic as an empty wallet", async () => {
    // A failed leg is UNKNOWN, not zero. Short-circuiting on it would answer
    // "no position" for a wallet nobody could see — so the full path still
    // runs and the answer comes from balances that were actually read.
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(0n), ok("0xbf"), ok(10n ** 18n), fail])
      .mockResolvedValueOnce([assetInfo()])
      .mockResolvedValueOnce([ok(1_00000000n), ok([0n, 0n]), ok(1_00000000n)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    expect(await new CompoundActiveReader(client, ethComets, { now }).read("0xw")).toBeNull();
    expect(multicall).toHaveBeenCalledTimes(3);
  });

  it("keeps reading a borrower whose collateral mask is empty", async () => {
    // Debt with no collateral bit: `assetsIn` alone would look like an empty
    // wallet. The short-circuit needs BOTH signals, and this is the position
    // that would vanish if it needed only one.
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n), userBasic(0)])
      .mockResolvedValueOnce([assetInfo()])
      .mockResolvedValueOnce([ok(1_00000000n), ok([0n, 0n]), ok(1_00000000n)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, usdComets, { now }).read("0xw");
    expect(r).not.toBeNull();
    expect(r?.borrowValueUsd).toBeCloseTo(1000, 6);
    expect(r?.positionHealth.healthFactor).toBe(0); // no collateral behind $1,000 of debt
  });

  it("reads a wallet WITH a position identically whether or not userBasic answers", async () => {
    // The early exit must be invisible to every wallet that has anything here.
    // Same fixtures twice: once with a populated `assetsIn` (the new head
    // batch), once with that leg failing (which falls through to exactly the
    // call sequence this reader made before the short-circuit existed). The
    // two readings must be indistinguishable, money math included.
    const armed = (basic: unknown) => {
      const multicall = vi
        .fn()
        .mockResolvedValueOnce([ok(1), ok(1n * 10n ** 18n), ok("0xbasefeed"), ok(10n ** 18n), basic])
        .mockResolvedValueOnce([assetInfo()])
        .mockResolvedValueOnce([ok(1_00000000n), ok([2n * 10n ** 18n, 0n]), ok(1_05000000n)])
        .mockResolvedValueOnce([ok(ethRound(2000))])
        .mockResolvedValueOnce([ok("cbETH")]);
      return { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    };

    const withMask = await new CompoundActiveReader(armed(userBasic(0b1)), ethComets, {
      now,
    }).read("0xw");
    const legacy = await new CompoundActiveReader(armed(fail), ethComets, { now }).read("0xw");

    expect(withMask).toEqual(legacy);
    // Pinned against the arithmetic, not just against each other: 2 x 1.05 ETH
    // x $2000 collateral, 1 x 1.0 ETH x $2000 borrow, liqCF 0.80.
    expect(withMask?.collateralValueUsd).toBeCloseTo(4200, 6);
    expect(withMask?.borrowValueUsd).toBeCloseTo(2000, 6);
    expect(withMask?.positionHealth.healthFactor).toBeCloseTo((4200 * 0.8) / 2000, 6);
  });
});

describe("ActiveAdapter", () => {
  const calmAsset: AssetRiskInput = {
    dailyReturns30d: Array(30).fill(0),
    btcReturns30d: Array(30).fill(0),
    maxPrice90d: 100,
    minPrice90d: 100,
  };
  const calmSystemic: SystemicRiskInput = {
    sectorTvlNow: 1,
    sectorTvl7dAgo: 1,
    protocolTvlNow: 1,
    protocolTvl7dAgo: 1,
  };

  it("scores readings through the shared core and flags WETH proxy fallback", async () => {
    const adapter = new ActiveAdapter(
      [
        {
          read: async () => ({
            protocol: "moonwell" as const,
            positionHealth: { healthFactor: 1.05, currentLtv: 0.7, maxLtv: 0.8 },
            collateralValueUsd: 1000,
            borrowValueUsd: 700,
            weightedLiquidationThreshold: 0.8, // V2 fork: same factor as maxLtv
            dominantCollateralSymbol: "WEIRDTOKEN", // not in SYMBOL_TO_COINGECKO
            dominantBorrowSymbol: "USDC",
          }),
        },
        { read: async () => null }, // protocol without a position is skipped
      ],
      {
        assetRisk: { getAssetRiskInput: async () => calmAsset },
        systemic: { getSystemicRiskInput: async () => calmSystemic },
      },
    );

    const scores = await adapter.scoreWallet("0xw");
    expect(scores).toHaveLength(1);
    expect(scores[0]?.band).toBe("CRITICAL"); // HF 1.05 → proximity floor
    expect(scores[0]?.assetRiskIsProxy).toBe(true);
    expect(scores[0]?.scoredCollateralSymbol).toBe("WETH (proxy)");
  });

  it("carries an unpriced collateral pick through to the advisor", async () => {
    const scores = await new ActiveAdapter(
      [
        {
          read: async () => ({
            protocol: "aave_v3" as const,
            positionHealth: { healthFactor: 2.0, currentLtv: 0.25, maxLtv: 0.8 },
            collateralValueUsd: 406_000,
            borrowValueUsd: 100_000,
            weightedLiquidationThreshold: 0.83,
            dominantCollateralSymbol: "WETH",
            dominantBorrowSymbol: "USDC",
            dominantCollateralUnpriced: true,
          }),
        },
      ],
      {
        assetRisk: { getAssetRiskInput: async () => calmAsset },
        systemic: { getSystemicRiskInput: async () => calmSystemic },
      },
    ).scoreWallet("0xw");

    expect(scores[0]?.dominantCollateralUnpriced).toBe(true);
    const { recommendations } = adviseWallet(scores, "moderate");
    expect(recommendations[0]?.triggers).toContain("collateral:unpriced");
    // The pick being unverified says nothing about the position's size, which
    // getUserAccountData reports directly.
    expect(recommendations[0]?.sections.position).not.toContain("$0");
    expect(scores[0]?.usdValuesUnavailable).toBe(false);
  });

  it("isolates a failing reader — other protocols still score", async () => {
    const onReaderError = vi.fn();
    const adapter = new ActiveAdapter(
      [
        { read: async () => { throw new Error("Morpho API: HTTP 503"); } },
        {
          read: async () => ({
            protocol: "aave_v3" as const,
            positionHealth: { healthFactor: 2.0, currentLtv: 0.4, maxLtv: 0.8 },
            collateralValueUsd: 1000,
            borrowValueUsd: 400,
            weightedLiquidationThreshold: 0.83,
            dominantCollateralSymbol: "WETH",
            dominantBorrowSymbol: "USDC",
          }),
        },
      ],
      {
        assetRisk: { getAssetRiskInput: async () => calmAsset },
        systemic: { getSystemicRiskInput: async () => calmSystemic },
      },
      onReaderError,
    );

    const scores = await adapter.scoreWallet("0xw");
    expect(scores).toHaveLength(1); // the Aave leg survived the Morpho failure
    expect(scores[0]?.protocol).toBe("aave_v3");
    expect(onReaderError).toHaveBeenCalledOnce();
  });

  // The end-to-end claim: a degraded reader must still produce a CORRECT
  // severity and must never let the wallet be summarised as an all-clear.
  // "Reader broken" (throws → dropped) and "prices degraded" (kept, flagged)
  // are distinct outcomes, and only the second one still scores.
  describe("degraded USD legs (SYSTEM_ARCHITECTURE §3.4 'degrade, don't score')", () => {
    const degradedReader = {
      read: async () => ({
        protocol: "compound_v3" as const,
        // 40 WETH debt at HF 1.20 — the ratio survives a dead ETH/USD feed.
        positionHealth: { healthFactor: 1.2, currentLtv: 40 / 60, maxLtv: 0.75 },
        collateralValueUsd: null,
        borrowValueUsd: null,
        usdValuesUnavailable: true,
        // A ratio, so a dead ETH/USD feed does not take it down with the
        // dollar magnitudes. Above maxLtv: Comet liquidates later than it
        // stops lending.
        weightedLiquidationThreshold: 0.8,
        dominantCollateralSymbol: "WETH",
        dominantBorrowSymbol: "USDC",
      }),
    };
    const providers = {
      assetRisk: { getAssetRiskInput: async () => calmAsset },
      systemic: { getSystemicRiskInput: async () => calmSystemic },
    };

    it("scores the leg on its (exact) health factor and flags it", async () => {
      const scores = await new ActiveAdapter([degradedReader], providers).scoreWallet("0xw");
      expect(scores).toHaveLength(1);
      expect(scores[0]?.healthFactor).toBeCloseTo(1.2, 9);
      // HF ≤ 1.25 → the liquidation-proximity floor lifts the composite to 50.
      expect(scores[0]?.total).toBeGreaterThanOrEqual(50);
      expect(scores[0]?.band).toBe("HIGH");
      expect(scores[0]?.usdValuesUnavailable).toBe(true);
      expect(scores[0]?.collateralValueUsd).toBeNull();
    });

    it("never yields an all-clear verdict for the wallet", async () => {
      const scores = await new ActiveAdapter([degradedReader], providers).scoreWallet("0xw");
      const { overall, recommendations } = adviseWallet(scores, "moderate");

      expect(overall.action).not.toBe("HOLD");
      expect(overall.headline).not.toContain("All positions within your risk profile");
      expect(overall.headline).toContain("degraded");
      // The dust gate is waived, not failed: a six-figure debt of unknown size
      // must not be treated as "no real debt".
      expect(recommendations[0]?.triggers).not.toContain("debt:none");
      expect(recommendations[0]?.triggers).toContain("prices:degraded");
      // No dollar amount is invented for a repay the engine cannot size.
      expect(recommendations[0]?.repayPlan).toBeUndefined();
      expect(recommendations[0]?.sections.position).not.toContain("$0");
    });

    it("a thrown reader is dropped and reported — not confused with degradation", async () => {
      const onReaderError = vi.fn();
      const scores = await new ActiveAdapter(
        [{ read: async () => { throw new Error("RPC down"); } }],
        providers,
        onReaderError,
      ).scoreWallet("0xw");
      expect(scores).toHaveLength(0);
      expect(onReaderError).toHaveBeenCalledOnce();
      // Nothing to advise on, and nothing degraded to warn about either.
      expect(adviseWallet(scores, "moderate").overall.headline).toBe(
        "All positions within your risk profile.",
      );
    });
  });

  // The `moonwell` vs `moonwell-artemis` incident: one unresolvable CoinGecko
  // id threw inside the per-leg loop and took every already-computed leg of the
  // wallet down with it, so wallets with Moonwell exposure got no score and no
  // liquidation alerts for 55 days. The provider failure now belongs to its leg.
  describe("market-context provider failure (per-leg isolation)", () => {
    const aaveReading = {
      protocol: "aave_v3" as const,
      positionHealth: { healthFactor: 2.0, currentLtv: 0.4, maxLtv: 0.8 },
      collateralValueUsd: 20_000,
      borrowValueUsd: 8_000,
      weightedLiquidationThreshold: 0.83,
      dominantCollateralSymbol: "WETH",
      dominantBorrowSymbol: "USDC",
    };
    // WELL is the symbol whose id was wrong; this leg is the one that throws.
    const moonwellReading = {
      protocol: "moonwell" as const,
      positionHealth: { healthFactor: 1.4, currentLtv: 0.6, maxLtv: 0.8 },
      collateralValueUsd: 120_000,
      borrowValueUsd: 70_000,
      weightedLiquidationThreshold: 0.8,
      dominantCollateralSymbol: "WELL",
      dominantBorrowSymbol: "USDC",
    };
    const twoLegReaders = [
      { read: async () => aaveReading },
      { read: async () => moonwellReading },
    ];
    /** Asset-risk provider that 404s for exactly one asset, as CoinGecko did. */
    const assetRiskFailingOn = (badId: string) => ({
      getAssetRiskInput: async (id: string) => {
        if (id === badId) throw new Error(`CoinGecko ${id}: HTTP 404`);
        return calmAsset;
      },
    });

    it("keeps every other leg when one leg's asset-risk provider throws", async () => {
      const onReaderError = vi.fn();
      const scores = await new ActiveAdapter(
        twoLegReaders,
        {
          assetRisk: assetRiskFailingOn("moonwell-artemis"),
          systemic: { getSystemicRiskInput: async () => calmSystemic },
        },
        onReaderError,
      ).scoreWallet("0xw");

      expect(scores).toHaveLength(2);
      const aave = scores.find((s) => s.protocol === "aave_v3");
      const moonwell = scores.find((s) => s.protocol === "moonwell");

      // The healthy leg is untouched: same sub-scores it scores in isolation.
      expect(aave?.marketContextUnavailable).toBe(false);
      expect(aave?.subScores.assetRisk).not.toBeNull();
      expect(aave?.subScores.systemicRisk).not.toBeNull();

      // The failed leg is present and degraded, not missing and not faked.
      expect(moonwell?.marketContextUnavailable).toBe(true);
      expect(moonwell?.subScores.assetRisk).toBeNull();
      // Only the term that failed is null; the systemic lookup still succeeded.
      expect(moonwell?.subScores.systemicRisk).not.toBeNull();
      // Position health is a chain read and stays exact through the failure.
      expect(moonwell?.healthFactor).toBeCloseTo(1.4, 9);
      expect(moonwell?.collateralValueUsd).toBeCloseTo(120_000, 6);
      expect(moonwell?.usdValuesUnavailable).toBe(false);
      expect(onReaderError).toHaveBeenCalledOnce();
    });

    it("never throws out of scoreWallet when both providers are down", async () => {
      const down = async () => {
        throw new Error("provider unreachable");
      };
      const scores = await new ActiveAdapter(twoLegReaders, {
        assetRisk: { getAssetRiskInput: down },
        systemic: { getSystemicRiskInput: down },
      }).scoreWallet("0xw");

      expect(scores).toHaveLength(2);
      for (const s of scores) {
        expect(s.marketContextUnavailable).toBe(true);
        expect(s.subScores.assetRisk).toBeNull();
        expect(s.subScores.systemicRisk).toBeNull();
        // The unmeasured terms are DROPPED from the composite, not imputed as
        // zero: position health 0.4 + protocol safety 0.2 renormalise to 1.
        const expected = Math.round(
          (0.4 * s.subScores.positionHealth + 0.2 * s.subScores.protocolSafety) / 0.6,
        );
        expect(s.total).toBe(expected);
        expect(s.total).toBeGreaterThan(0);
      }
    });

    it("scores identically to a healthy read when nothing is missing", async () => {
      const [degradable] = await new ActiveAdapter(
        [{ read: async () => aaveReading }],
        {
          assetRisk: { getAssetRiskInput: async () => calmAsset },
          systemic: { getSystemicRiskInput: async () => calmSystemic },
        },
      ).scoreWallet("0xw");
      const direct = computeScore({
        protocol: "aave_v3",
        positionHealth: aaveReading.positionHealth,
        assetRisk: calmAsset,
        systemicRisk: calmSystemic,
      });
      expect(degradable?.total).toBe(direct.total);
      expect(degradable?.subScores).toEqual(direct.subScores);
    });

    it("does not let an unmeasured asset risk open the crash-regime gate", async () => {
      // HF 1.20 is inside CRASH_REGIME.hfAtOrBelow, so the only thing standing
      // between this leg and a forced 75/CRITICAL is the asset-risk gate — and
      // an unread term must not satisfy it in either direction.
      const scores = await new ActiveAdapter(
        [
          {
            read: async () => ({
              ...moonwellReading,
              positionHealth: { healthFactor: 1.2, currentLtv: 0.7, maxLtv: 0.8 },
            }),
          },
        ],
        {
          assetRisk: assetRiskFailingOn("moonwell-artemis"),
          systemic: { getSystemicRiskInput: async () => calmSystemic },
        },
      ).scoreWallet("0xw");

      const leg = scores[0];
      expect(leg?.subScores.assetRisk).toBeNull();
      // The HF <= 1.25 proximity floor still applies (it reads only the exact
      // health factor), so the leg is HIGH, not silently LOW.
      expect(leg?.total).toBeGreaterThanOrEqual(50);
      expect(leg?.band).toBe("HIGH");
      const { recommendations } = adviseWallet(scores, "moderate");
      expect(recommendations[0]?.triggers).toContain("market:unavailable");
      expect(recommendations[0]?.triggers).not.toContain("regime:crash");
    });

    it("never summarises a leg with no market context as an all-clear", async () => {
      // A calm, healthy position: without the fix this reads HOLD / "all
      // positions within your risk profile" on a score that never looked at
      // the market at all.
      const scores = await new ActiveAdapter(
        [
          {
            read: async () => ({
              ...aaveReading,
              dominantCollateralSymbol: "WELL",
              dominantBorrowSymbol: "USDC",
              positionHealth: { healthFactor: 3.0, currentLtv: 0.2, maxLtv: 0.8 },
            }),
          },
        ],
        {
          assetRisk: assetRiskFailingOn("moonwell-artemis"),
          systemic: { getSystemicRiskInput: async () => calmSystemic },
        },
      ).scoreWallet("0xw");

      const { overall, recommendations } = adviseWallet(scores, "moderate");
      expect(overall.action).not.toBe("HOLD");
      expect(overall.headline).not.toBe("All positions within your risk profile.");
      // The missing term is named rather than quietly dropped from the prose,
      // and it is never printed as a 0/100 driver.
      expect(recommendations[0]?.sections.market).toContain("asset volatility");
      expect(recommendations[0]?.sections.market).not.toContain("asset volatility risk (0/100)");
    });
  });

});
