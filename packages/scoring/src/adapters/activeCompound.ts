/**
 * Compound V3 (Comet) active reader — Base mainnet (cUSDCv3 + cWETHv3).
 * Comet markets have ONE borrowable base asset and multiple collaterals;
 * HF is derived: Σ(collateral_i × liquidateCollateralFactor_i) / borrow.
 * cWETHv3 nuance: its price feeds are ETH-denominated, so USD display
 * values are converted via the Chainlink ETH/USD feed (HF is unaffected —
 * numerator and denominator share the denomination).
 *
 * That conversion is load-bearing for money math: without a usable ETH/USD
 * round an ETH-quoted market must be SKIPPED, never scored with a 1.0
 * placeholder — a $120k debt would otherwise surface as ~$40 and fall under
 * the advisor's minimum-borrow gate while the position sits near liquidation.
 */

import type { PositionHealthInput } from "../types";
import type { ActiveReading } from "./activeAave";
import {
  CHAINLINK_ETH_USD_BASE,
  COMETS_BASE,
  type PublicClientLike,
  chainlinkAggregatorAbi,
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

/** latestRoundData: [roundId, answer, startedAt, updatedAt, answeredInRound]. */
type ChainlinkRound = readonly [bigint, bigint, bigint, bigint, bigint];

/** Rounds older than this are unusable — ETH/USD heartbeats in ~20 minutes. */
const MAX_ROUND_AGE_SECONDS = 24 * 60 * 60;

export interface CompoundReaderOptions {
  /** Unix-seconds clock; injectable for tests. */
  now?: () => number;
  /** Max accepted age of a Chainlink round, in seconds. Default 24h. */
  maxRoundAgeSeconds?: number;
  /** Notified when a market is skipped for want of a usable ETH/USD round. */
  onWarn?: (message: string) => void;
}

export class CompoundActiveReader {
  private readonly now: () => number;
  private readonly maxRoundAgeSeconds: number;
  private readonly onWarn: (message: string) => void;

  constructor(
    private readonly client: PublicClientLike,
    private readonly comets = COMETS_BASE,
    opts: CompoundReaderOptions = {},
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxRoundAgeSeconds = opts.maxRoundAgeSeconds ?? MAX_ROUND_AGE_SECONDS;
    this.onWarn = opts.onWarn ?? ((m) => console.warn(m));
  }

  /**
   * USD price from a Chainlink round, or null when the read failed, the
   * answer is non-positive, or the round is stale. Null means "skip", never
   * "assume 1" — a wrong denomination silently deflates USD by ~3000x.
   */
  private usdFromRound(round: ChainlinkRound | null): number | null {
    if (!round) return null;
    const answer = round[1];
    const updatedAt = Number(round[3]);
    if (answer <= 0n) return null;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    if (this.now() - updatedAt > this.maxRoundAgeSeconds) return null;
    return Number(answer) / 1e8;
  }

  /** Aggregates across both Comet markets; null when the wallet uses neither. */
  async read(wallet: string): Promise<ActiveReading | null> {
    let collateralUsd = 0;
    let borrowUsd = 0;
    let weightedLiqUsd = 0; // Σ collateral × liquidateCF
    let weightedBorrowCfUsd = 0; // Σ collateral × borrowCF (maxLtv)
    let bestCollateralUsd = 0;
    let dominantAsset: string | null = null;

    const ok = <T>(r: { status: string; result?: unknown } | undefined): T | null =>
      r && r.status === "success" ? (r.result as T) : null;

    for (const comet of this.comets) {
      const head = await this.client.multicall({
        allowFailure: true,
        contracts: [
          { address: comet.address, abi: cometAbi, functionName: "numAssets" },
          { address: comet.address, abi: cometAbi, functionName: "borrowBalanceOf", args: [wallet] },
          { address: comet.address, abi: cometAbi, functionName: "baseTokenPriceFeed" },
          { address: comet.address, abi: cometAbi, functionName: "baseScale" },
          { address: CHAINLINK_ETH_USD_BASE, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
        ],
      });
      const numAssets = ok<number>(head[0]);
      const borrowBase = ok<bigint>(head[1]);
      const baseFeed = ok<string>(head[2]);
      const baseScale = ok<bigint>(head[3]);
      const ethRound = ok<ChainlinkRound>(head[4]);
      if (numAssets === null || borrowBase === null || baseFeed === null || baseScale === null) continue;

      // ETH/USD for cWETHv3 conversion (1 when the market is USD-quoted).
      // allowFailure means head[4] can be absent, so an ETH-quoted market with
      // no usable round is dropped rather than reported ~3000x too small.
      let ethUsd = 1;
      if (comet.priceInEth) {
        const price = this.usdFromRound(ethRound);
        if (price === null) {
          this.onWarn(
            `Compound ${comet.baseSymbol} market ${comet.address}: ETH/USD round missing, non-positive or older than ${this.maxRoundAgeSeconds}s — market skipped (USD values would be ~ETH-denominated)`,
          );
          continue;
        }
        ethUsd = price;
      }

      const infoCalls = Array.from({ length: numAssets }, (_, i) => ({
        address: comet.address,
        abi: cometAbi,
        functionName: "getAssetInfo",
        args: [i],
      }));
      const infos = await this.client.multicall({ allowFailure: true, contracts: infoCalls });
      const assets = infos
        .map((r) => ok<AssetInfo>(r))
        .filter((a): a is AssetInfo => a !== null);

      const balanceAndPriceCalls = [
        { address: comet.address, abi: cometAbi, functionName: "getPrice", args: [baseFeed] },
        ...assets.flatMap((a) => [
          { address: comet.address, abi: cometAbi, functionName: "userCollateral", args: [wallet, a.asset] },
          { address: comet.address, abi: cometAbi, functionName: "getPrice", args: [a.priceFeed] },
        ]),
      ];
      const res = await this.client.multicall({ allowFailure: true, contracts: balanceAndPriceCalls });
      const basePrice = ok<bigint>(res[0]);
      if (basePrice === null) continue;

      borrowUsd += (Number(borrowBase) / Number(baseScale)) * (Number(basePrice) / 1e8) * ethUsd;

      assets.forEach((a, i) => {
        const coll = ok<readonly [bigint, bigint]>(res[1 + i * 2]);
        const price = ok<bigint>(res[2 + i * 2]);
        if (!coll || price === null || coll[0] === 0n) return;
        const usd = (Number(coll[0]) / Number(a.scale)) * (Number(price) / 1e8) * ethUsd;
        collateralUsd += usd;
        weightedLiqUsd += usd * (Number(a.liquidateCollateralFactor) / 1e18);
        weightedBorrowCfUsd += usd * (Number(a.borrowCollateralFactor) / 1e18);
        if (usd > bestCollateralUsd) {
          bestCollateralUsd = usd;
          dominantAsset = a.asset;
        }
      });
    }

    if (collateralUsd === 0 && borrowUsd === 0) return null;

    const positionHealth: PositionHealthInput = {
      healthFactor: borrowUsd > 0 ? weightedLiqUsd / borrowUsd : null,
      currentLtv: collateralUsd > 0 ? borrowUsd / collateralUsd : 0,
      maxLtv: collateralUsd > 0 ? weightedBorrowCfUsd / collateralUsd : 0,
    };

    let dominantCollateralSymbol: string | null = null;
    if (dominantAsset) {
      const sym = await this.client.multicall({
        allowFailure: true,
        contracts: [{ address: dominantAsset, abi: erc20Abi, functionName: "symbol" }],
      });
      dominantCollateralSymbol = ok<string>(sym[0]);
    }

    return {
      protocol: "compound_v3",
      positionHealth,
      collateralValueUsd: collateralUsd,
      borrowValueUsd: borrowUsd,
      dominantCollateralSymbol,
    };
  }
}
