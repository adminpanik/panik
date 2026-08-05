import { describe, expect, it, vi } from "vitest";
import { ActiveAdapter } from "../src/adapters/active";
import { AaveActiveReader } from "../src/adapters/activeAave";
import { MoonwellActiveReader } from "../src/adapters/activeMoonwell";
import type { PublicClientLike } from "../src/adapters/chain";
import type { AssetRiskInput, SystemicRiskInput } from "../src/types";

const UINT256_MAX = 2n ** 256n - 1n;
const ok = (result: unknown) => ({ status: "success" as const, result });

function reserveData(aToken: string) {
  return ok({ aTokenAddress: aToken });
}

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
          8300n,
          8000n, // maxLtv 80.00%
          1_660000000000000000n, // HF 1.66
        ]),
        reserveData("0xaWETH"),
        reserveData("0xaUSDC"),
        reserveData("0xaWSTETH"),
        reserveData("0xaCBBTC"),
      ])
      // call 2: aToken balances — 2 WETH dominates 1,000 USDC
      .mockResolvedValueOnce([ok(2n * 10n ** 18n), ok(1_000n * 10n ** 6n), ok(0n), ok(0n)]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");

    expect(r).not.toBeNull();
    expect(r?.positionHealth.healthFactor).toBeCloseTo(1.66, 9);
    expect(r?.positionHealth.currentLtv).toBeCloseTo(0.4, 9);
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.8, 9);
    expect(r?.collateralValueUsd).toBeCloseTo(10_000, 6);
    expect(r?.dominantCollateralSymbol).toBe("WETH");
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
      .mockResolvedValueOnce([ok(0n), ok(5_000n * 10n ** 6n), ok(0n), ok(0n)]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new AaveActiveReader(client).read("0xwallet");
    expect(r?.positionHealth.healthFactor).toBeNull();
    expect(r?.dominantCollateralSymbol).toBe("USDC");
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
    { address: "0xcomet", baseSymbol: "WETH", priceInEth: true },
  ] as never;

  it("derives HF from liquidateCollateralFactor and converts ETH-quoted markets to USD", async () => {
    // One synthetic ETH-quoted comet (like cWETHv3): 1 asset, ETH/USD = $2000.
    const comets = ethComets;
    const multicall = vi
      .fn()
      // head: numAssets, borrowBalanceOf, baseTokenPriceFeed, baseScale, ETH/USD round
      .mockResolvedValueOnce([
        ok(1),
        ok(1n * 10n ** 18n), // borrow: 1 WETH
        ok("0xbasefeed"),
        ok(10n ** 18n),
        ok(ethRound(2000)), // ETH/USD $2000, fresh
      ])
      // getAssetInfo(0): cbETH collateral, scale 1e18, borrowCF 0.75, liqCF 0.80
      .mockResolvedValueOnce([
        ok({
          offset: 0,
          asset: "0xcbeth",
          priceFeed: "0xcbethfeed",
          scale: 10n ** 18n,
          borrowCollateralFactor: 750000000000000000n,
          liquidateCollateralFactor: 800000000000000000n,
        }),
      ])
      // base price (1.0 in ETH terms), userCollateral (2 cbETH), cbETH price (1.05 ETH)
      .mockResolvedValueOnce([ok(1_00000000n), ok([2n * 10n ** 18n, 0n]), ok(1_05000000n)])
      // dominant symbol lookup
      .mockResolvedValueOnce([ok("cbETH")]);

    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, comets, { now }).read("0xw");

    // collateral: 2 × 1.05 ETH × $2000 = $4200; borrow: 1 × 1.0 × $2000 = $2000
    expect(r?.collateralValueUsd).toBeCloseTo(4200, 6);
    expect(r?.borrowValueUsd).toBeCloseTo(2000, 6);
    expect(r?.positionHealth.healthFactor).toBeCloseTo((4200 * 0.8) / 2000, 6); // 1.68
    expect(r?.positionHealth.maxLtv).toBeCloseTo(0.75, 6);
    expect(r?.dominantCollateralSymbol).toBe("cbETH");
  });

  // A cWETHv3 borrower: 40 WETH of debt. With a live ETH/USD round that is
  // $120,000; treating the ETH-denominated price as USD would report $40 —
  // below ALERT_POLICY.minBorrowUsd, so the advisor would never emit EXIT.
  const fail = { status: "failure" as const };
  const whaleHead = (round: unknown) => [
    ok(1),
    ok(40n * 10n ** 18n), // borrow: 40 WETH
    ok("0xbasefeed"),
    ok(10n ** 18n),
    round,
  ];
  const whaleTail = (multicall: ReturnType<typeof vi.fn>) =>
    multicall
      .mockResolvedValueOnce([
        ok({
          offset: 0,
          asset: "0xcbeth",
          priceFeed: "0xcbethfeed",
          scale: 10n ** 18n,
          borrowCollateralFactor: 750000000000000000n,
          liquidateCollateralFactor: 800000000000000000n,
        }),
      ])
      .mockResolvedValueOnce([ok(1_00000000n), ok([60n * 10n ** 18n, 0n]), ok(1_00000000n)])
      .mockResolvedValueOnce([ok("cbETH")]);

  it("reports true USD for an ETH-quoted market when the round is healthy", async () => {
    const multicall = vi.fn().mockResolvedValueOnce(whaleHead(ok(ethRound(3000))));
    whaleTail(multicall);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, ethComets, { now }).read("0xw");
    expect(r?.borrowValueUsd).toBeCloseTo(120_000, 6); // 40 WETH × $3000
  });

  const unusableRounds: [string, unknown][] = [
    ["missing (multicall leg failed)", fail],
    ["non-positive answer", ok(ethRound(0))],
    ["negative answer", ok([0n, -1n, 0n, BigInt(NOW_S - 60), 0n])],
    ["zero updatedAt", ok([0n, 3000_00000000n, 0n, 0n, 0n])],
    ["stale (older than 24h)", ok(ethRound(3000, 25 * 3600))],
  ];

  it.each(unusableRounds)(
    "skips an ETH-quoted market when the ETH/USD round is %s",
    async (_label, round) => {
      const onWarn = vi.fn();
      const multicall = vi.fn().mockResolvedValueOnce(whaleHead(round));
      whaleTail(multicall);
      const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
      const r = await new CompoundActiveReader(client, ethComets, { now, onWarn }).read("0xw");

      // Skipped, not silently deflated ~3000x to $40 of "debt".
      expect(r).toBeNull();
      expect(onWarn).toHaveBeenCalledOnce();
      // The market is dropped at the head stage: no follow-up reads.
      expect(multicall).toHaveBeenCalledOnce();
    },
  );

  it("keeps USD-quoted markets alive when the ETH/USD round is unusable", async () => {
    // cUSDCv3 does not need the conversion, so a dead ETH feed must not drop it.
    const usdComets = [
      { address: "0xcomet", baseSymbol: "USDC", priceInEth: false },
    ] as never;
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n), fail])
      .mockResolvedValueOnce([
        ok({
          offset: 0,
          asset: "0xcbeth",
          priceFeed: "0xf",
          scale: 10n ** 18n,
          borrowCollateralFactor: 750000000000000000n,
          liquidateCollateralFactor: 800000000000000000n,
        }),
      ])
      .mockResolvedValueOnce([ok(1_00000000n), ok([1n * 10n ** 18n, 0n]), ok(2000_00000000n)])
      .mockResolvedValueOnce([ok("cbETH")]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const r = await new CompoundActiveReader(client, usdComets, { now }).read("0xw");
    expect(r?.borrowValueUsd).toBeCloseTo(1000, 6);
    expect(r?.collateralValueUsd).toBeCloseTo(2000, 6);
  });

  it("returns null for wallets with no Comet usage", async () => {
    const comets = [{ address: "0xcomet", baseSymbol: "USDC", priceInEth: false }] as never;
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(0n), ok("0xbf"), ok(10n ** 6n), ok([0n, 1n, 0n, 0n, 0n])])
      .mockResolvedValueOnce([
        ok({ offset: 0, asset: "0xa", priceFeed: "0xf", scale: 10n ** 18n, borrowCollateralFactor: 1n, liquidateCollateralFactor: 1n }),
      ])
      .mockResolvedValueOnce([ok(1_00000000n), ok([0n, 0n]), ok(1_00000000n)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    expect(await new CompoundActiveReader(client, comets).read("0xempty")).toBeNull();
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
            dominantCollateralSymbol: "WEIRDTOKEN", // not in SYMBOL_TO_COINGECKO
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
            dominantCollateralSymbol: "WETH",
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
});
