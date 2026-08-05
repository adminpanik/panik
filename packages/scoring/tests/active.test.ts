import { describe, expect, it, vi } from "vitest";
import { ActiveAdapter } from "../src/adapters/active";
import { adviseWallet } from "../src/advisor/rules";
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
      // ...and the half that genuinely needs the oracle is withheld, not faked.
      expect(r?.collateralValueUsd).toBeNull();
      expect(r?.borrowValueUsd).toBeNull();
      expect(r?.usdValuesUnavailable).toBe(true);
      expect(onWarn).toHaveBeenCalledOnce();
    },
  );

  // The shipping config (COMETS_BASE) holds BOTH cUSDCv3 and cWETHv3. Dropping
  // the ETH-quoted leg used to leave a fully-valid-looking "HF 1.6, comfortable"
  // reading with 40 WETH of real debt invisible.
  it("signals a degraded comet without losing the healthy one (two-comet config)", async () => {
    const onWarn = vi.fn();
    const bothComets = [
      { address: "0xcometusdc", baseSymbol: "USDC", priceInEth: false },
      { address: "0xcometweth", baseSymbol: "WETH", priceInEth: true },
    ] as never;
    const multicall = vi
      .fn()
      // cUSDCv3: borrow 1,000 USDC against $2,000 of cbETH → HF (2000×0.8)/1000 = 1.6
      .mockResolvedValueOnce([ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n)])
      .mockResolvedValueOnce([assetInfo("0xcbeth")])
      .mockResolvedValueOnce([ok(1_00000000n), ok([1n * 10n ** 18n, 0n]), ok(2000_00000000n)])
      // cWETHv3: 40 WETH borrow against 60 cbETH → HF 1.2, ETH/USD needed for USD
      .mockResolvedValueOnce(whaleHead())
      .mockResolvedValueOnce([assetInfo("0xcbeth")])
      .mockResolvedValueOnce([ok(1_00000000n), ok([60n * 10n ** 18n, 0n]), ok(1_00000000n)])
      // ETH/USD unusable
      .mockResolvedValueOnce([fail])
      .mockResolvedValueOnce([ok("cbETH")]);

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
    const bothComets = [
      { address: "0xcometusdc", baseSymbol: "USDC", priceInEth: false },
      { address: "0xcometweth", baseSymbol: "WETH", priceInEth: true },
    ] as never;
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(1_000n * 10n ** 6n), ok("0xbf"), ok(10n ** 6n)])
      .mockResolvedValueOnce([assetInfo("0xcbeth")])
      .mockResolvedValueOnce([ok(1_00000000n), ok([1n * 10n ** 18n, 0n]), ok(2000_00000000n)])
      .mockResolvedValueOnce(whaleHead())
      .mockResolvedValueOnce([assetInfo("0xcbeth")])
      .mockResolvedValueOnce([ok(1_00000000n), ok([60n * 10n ** 18n, 0n]), ok(1_00000000n)])
      .mockResolvedValueOnce([ok(ethRound(3000))])
      .mockResolvedValueOnce([ok("cbETH")]);

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

  it("returns null — and never warns — for wallets with no Comet usage", async () => {
    const onWarn = vi.fn();
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([ok(1), ok(0n), ok("0xbf"), ok(10n ** 18n)])
      .mockResolvedValueOnce([assetInfo()])
      .mockResolvedValueOnce([ok(1_00000000n), ok([0n, 0n]), ok(1_00000000n)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    expect(await new CompoundActiveReader(client, ethComets, { now, onWarn }).read("0xempty"))
      .toBeNull();
    // The head multicall precedes any position check, so an unconditional warn
    // here would fire every 60s for every watched wallet on the platform.
    expect(onWarn).not.toHaveBeenCalled();
    expect(multicall).toHaveBeenCalledTimes(3); // no oracle read either
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
        dominantCollateralSymbol: "WETH",
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
});
