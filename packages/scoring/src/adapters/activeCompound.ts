/**
 * Compound V3 (Comet) active reader — Base mainnet (cUSDCv3 + cWETHv3).
 * Comet markets have ONE borrowable base asset and multiple collaterals;
 * HF is derived: Σ(collateral_i × liquidateCollateralFactor_i) / borrow.
 * cWETHv3 nuance: its price feeds are ETH-denominated, so USD display
 * values are converted via the Chainlink ETH/USD feed.
 *
 * ETH/USD is a COMMON FACTOR of that market's money math: it multiplies the
 * borrow, the collateral, and both collateral-factor-weighted sums alike, and
 * HF / currentLtv / maxLtv are all RATIOS of those quantities — so it cancels
 * out of every one of them. Consequences, and the whole design of this file:
 *
 *  - Without a usable round the USD MAGNITUDES are unknowable, so they are
 *    reported as `null` with `usdValuesUnavailable: true`.
 *  - The HF/LTV/maxLtv are NOT affected and are reported exactly as usual.
 *    Dropping the market (an earlier fix here) threw the correct half away
 *    with the wrong half and turned a partially-correct warning into an
 *    affirmative all-clear — arch §3.4 says "degrade, don't score", and
 *    degrade is not delete.
 *  - When several comets contribute and any of them is degraded, their sums
 *    are in different denominations and cannot be pooled. Comet markets are
 *    isolated (each liquidates on its own), so the aggregate then reports the
 *    WORST leg's health — the same MIN-HF rule the Morpho reader uses for
 *    isolated markets. With every comet usable, pooling is unchanged.
 */

import { ETH_USD_FEED_BASE, ChainlinkPriceReader, type FeedReading } from "../providers/chainlink";
import type { PositionHealthInput } from "../types";
import type { ActiveReading } from "./activeAave";
import {
  COMETS_BASE,
  type PublicClientLike,
  cometAbi,
  erc20Abi,
} from "./chain";

interface AssetInfo {
  asset: string;
  priceFeed: string;
  scale: bigint;
  borrowCollateralFactor: bigint;
  liquidateCollateralFactor: bigint;
}

/**
 * One Comet market's totals in its OWN denomination (USD for cUSDCv3, ETH for
 * cWETHv3). `usdFactor` converts them to USD; null when it is unknown, which
 * is exactly the degraded case — the ratios below stay valid regardless.
 */
interface CometLeg {
  address: string;
  baseSymbol: string;
  collateral: number;
  borrow: number;
  weightedLiq: number;
  weightedBorrowCf: number;
  bestCollateral: number;
  dominantAsset: string | null;
  usdFactor: number | null;
}

export interface CompoundReaderOptions {
  /** Unix-seconds clock; injectable for tests. */
  now?: () => number;
  /**
   * Staleness multiple of the ETH/USD heartbeat, passed straight to
   * `ChainlinkPriceReader`. Default 1.5 → 1200s × 1.5 = 1800s, the repo's
   * single ETH staleness policy (providers/chainlink.ts). Do not fork it.
   */
  staleGraceFactor?: number;
  /** Notified when a market's USD values are degraded. Rate-limited. */
  onWarn?: (message: string) => void;
}

/**
 * Collateral-weighted liquidation threshold of one leg. Comet's
 * liquidateCollateralFactor sits strictly above its borrowCollateralFactor, so
 * this is NOT `healthOf().maxLtv`: the smaller borrow-side factor under-sizes
 * a collateral-funded repay, which lands short of the target it quoted.
 * null with no collateral: there is nothing to average.
 */
function weightedLiquidationThresholdOf(leg: CometLeg): number | null {
  return leg.collateral > 0 ? leg.weightedLiq / leg.collateral : null;
}

/** Health of one isolated Comet market — denomination-free by construction. */
function healthOf(leg: CometLeg): PositionHealthInput {
  return {
    healthFactor: leg.borrow > 0 ? leg.weightedLiq / leg.borrow : null,
    currentLtv: leg.collateral > 0 ? leg.borrow / leg.collateral : 0,
    maxLtv: leg.collateral > 0 ? leg.weightedBorrowCf / leg.collateral : 0,
  };
}

export class CompoundActiveReader {
  private readonly prices: ChainlinkPriceReader;
  private readonly onWarn: (message: string) => void;
  /** Last warned `${comet}:${round.updatedAt}` — one warning per bad round. */
  private readonly warnedRound = new Map<string, number>();

  constructor(
    private readonly client: PublicClientLike,
    private readonly comets = COMETS_BASE,
    opts: CompoundReaderOptions = {},
  ) {
    this.prices = new ChainlinkPriceReader(client, [ETH_USD_FEED_BASE], {
      now: opts.now,
      staleGraceFactor: opts.staleGraceFactor,
    });
    this.onWarn = opts.onWarn ?? ((m) => console.warn(m));
  }

  /**
   * ETH/USD, read at most once per `read()` and ONLY once an ETH-quoted market
   * is known to hold a position — wallets with no Comet position must not cost
   * an oracle round-trip or emit a warning (this fires every 60s per wallet).
   */
  private async ethUsd(): Promise<FeedReading | null> {
    const [reading] = await this.prices.readAll();
    return reading ?? null;
  }

  /** Warn at most once per (market, bad round) instead of once per tick. */
  private warnDegraded(comet: CometLeg, feed: FeedReading | null): void {
    const stamp = feed?.updatedAt ?? 0;
    if (this.warnedRound.get(comet.address) === stamp) return;
    this.warnedRound.set(comet.address, stamp);
    this.onWarn(
      `Compound ${comet.baseSymbol} market ${comet.address}: ETH/USD round missing, non-positive, future-dated or stale (updatedAt=${stamp}) — USD values withheld; health factor and LTV are unaffected and still scored`,
    );
  }

  /** Reads one Comet market's totals in its own denomination. */
  private async readLeg(
    comet: (typeof COMETS_BASE)[number],
    wallet: string,
  ): Promise<CometLeg | null> {
    const ok = <T>(r: { status: string; result?: unknown } | undefined): T | null =>
      r && r.status === "success" ? (r.result as T) : null;

    const head = await this.client.multicall({
      allowFailure: true,
      contracts: [
        { address: comet.address, abi: cometAbi, functionName: "numAssets" },
        { address: comet.address, abi: cometAbi, functionName: "borrowBalanceOf", args: [wallet] },
        { address: comet.address, abi: cometAbi, functionName: "baseTokenPriceFeed" },
        { address: comet.address, abi: cometAbi, functionName: "baseScale" },
      ],
    });
    const numAssets = ok<number>(head[0]);
    const borrowBase = ok<bigint>(head[1]);
    const baseFeed = ok<string>(head[2]);
    const baseScale = ok<bigint>(head[3]);
    if (numAssets === null || borrowBase === null || baseFeed === null || baseScale === null) {
      return null;
    }

    const infos = await this.client.multicall({
      allowFailure: true,
      contracts: Array.from({ length: numAssets }, (_, i) => ({
        address: comet.address,
        abi: cometAbi,
        functionName: "getAssetInfo",
        args: [i],
      })),
    });
    const assets = infos
      .map((r) => ok<AssetInfo>(r))
      .filter((a): a is AssetInfo => a !== null);

    const res = await this.client.multicall({
      allowFailure: true,
      contracts: [
        { address: comet.address, abi: cometAbi, functionName: "getPrice", args: [baseFeed] },
        ...assets.flatMap((a) => [
          { address: comet.address, abi: cometAbi, functionName: "userCollateral", args: [wallet, a.asset] },
          { address: comet.address, abi: cometAbi, functionName: "getPrice", args: [a.priceFeed] },
        ]),
      ],
    });
    const basePrice = ok<bigint>(res[0]);
    if (basePrice === null) return null;

    const leg: CometLeg = {
      address: comet.address,
      baseSymbol: comet.baseSymbol,
      collateral: 0,
      borrow: (Number(borrowBase) / Number(baseScale)) * (Number(basePrice) / 1e8),
      weightedLiq: 0,
      weightedBorrowCf: 0,
      bestCollateral: 0,
      dominantAsset: null,
      // USD-quoted markets need no conversion; ETH-quoted ones resolve later.
      usdFactor: comet.priceInEth ? null : 1,
    };

    assets.forEach((a, i) => {
      const coll = ok<readonly [bigint, bigint]>(res[1 + i * 2]);
      const price = ok<bigint>(res[2 + i * 2]);
      if (!coll || price === null || coll[0] === 0n) return;
      const value = (Number(coll[0]) / Number(a.scale)) * (Number(price) / 1e8);
      leg.collateral += value;
      leg.weightedLiq += value * (Number(a.liquidateCollateralFactor) / 1e18);
      leg.weightedBorrowCf += value * (Number(a.borrowCollateralFactor) / 1e18);
      if (value > leg.bestCollateral) {
        leg.bestCollateral = value;
        leg.dominantAsset = a.asset;
      }
    });

    return leg.collateral === 0 && leg.borrow === 0 ? null : leg;
  }

  /** Aggregates across both Comet markets; null when the wallet uses neither. */
  async read(wallet: string): Promise<ActiveReading | null> {
    const legs: CometLeg[] = [];
    for (const comet of this.comets) {
      const leg = await this.readLeg(comet, wallet);
      if (leg) legs.push(leg);
    }
    if (legs.length === 0) return null;

    // Only now — with a real position in an ETH-quoted market — is the oracle
    // worth a call, and only now is a degraded feed worth a warning.
    if (legs.some((l) => l.usdFactor === null)) {
      const feed = await this.ethUsd();
      const usable = feed && !feed.isStale && feed.price !== null && feed.price > 0;
      for (const leg of legs) {
        if (leg.usdFactor !== null) continue;
        if (usable) leg.usdFactor = feed.price;
        else this.warnDegraded(leg, feed);
      }
    }

    const degraded = legs.some((l) => l.usdFactor === null);

    let positionHealth: PositionHealthInput;
    let weightedLiquidationThreshold: number | null;
    let dominantAsset: string | null;
    if (!degraded) {
      // Every leg is in USD: pool them, exactly as before.
      const sum = (pick: (l: CometLeg) => number) =>
        legs.reduce((acc, l) => acc + pick(l) * (l.usdFactor as number), 0);
      const pooled: CometLeg = {
        ...(legs[0] as CometLeg),
        collateral: sum((l) => l.collateral),
        borrow: sum((l) => l.borrow),
        weightedLiq: sum((l) => l.weightedLiq),
        weightedBorrowCf: sum((l) => l.weightedBorrowCf),
      };
      positionHealth = healthOf(pooled);
      weightedLiquidationThreshold = weightedLiquidationThresholdOf(pooled);
      dominantAsset = legs.reduce<CometLeg | null>(
        (best, l) =>
          best === null ||
          l.bestCollateral * (l.usdFactor as number) >
            best.bestCollateral * (best.usdFactor as number)
            ? l
            : best,
        null,
      )?.dominantAsset ?? null;
    } else {
      // Mixed denominations: report the most endangered isolated market.
      const worst = legs.reduce((a, b) =>
        (healthOf(a).healthFactor ?? Infinity) <= (healthOf(b).healthFactor ?? Infinity) ? a : b,
      );
      positionHealth = healthOf(worst);
      weightedLiquidationThreshold = weightedLiquidationThresholdOf(worst);
      dominantAsset = worst.dominantAsset;
    }

    let dominantCollateralSymbol: string | null = null;
    if (dominantAsset) {
      const sym = await this.client.multicall({
        allowFailure: true,
        contracts: [{ address: dominantAsset, abi: erc20Abi, functionName: "symbol" }],
      });
      const first = sym[0];
      dominantCollateralSymbol =
        first && first.status === "success" ? (first.result as string) : null;
    }

    return {
      protocol: "compound_v3",
      positionHealth,
      collateralValueUsd: degraded
        ? null
        : legs.reduce((a, l) => a + l.collateral * (l.usdFactor as number), 0),
      borrowValueUsd: degraded
        ? null
        : legs.reduce((a, l) => a + l.borrow * (l.usdFactor as number), 0),
      ...(degraded ? { usdValuesUnavailable: true } : {}),
      weightedLiquidationThreshold,
      dominantCollateralSymbol,
    };
  }
}
