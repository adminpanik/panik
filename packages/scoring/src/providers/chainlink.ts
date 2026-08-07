/**
 * Chainlink price reads — SYSTEM_ARCHITECTURE §3.3/§3.4.
 * Why Chainlink for live prices: it is the same oracle family the protocols
 * liquidate against, so risk math sees what the liquidator sees. CoinGecko
 * remains the *history* source (vol/drawdown); this is the *now* source plus
 * the staleness guard and the price-movement trigger ("60s + events").
 */

import { parseAbi } from "viem";
import { CHAINLINK_ETH_USD_BASE, type PublicClientLike } from "../adapters/chain";

export const aggregatorV3Abi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface ChainlinkFeed {
  symbol: string;
  address: string;
  /** Chainlink's max update interval; staleness = age > heartbeat × grace. */
  heartbeatSeconds: number;
}

/**
 * ETH/USD on Base — the single source of the repo's ETH staleness policy.
 * Every consumer (including the Comet ETH-quoted markets, which need it to
 * denominate USD display values) reuses THIS feed definition rather than
 * inventing its own bound: 1200s heartbeat × the 1.5 grace = 1800s.
 */
export const ETH_USD_FEED_BASE: ChainlinkFeed = {
  symbol: "ETH",
  address: CHAINLINK_ETH_USD_BASE,
  heartbeatSeconds: 1200,
};

/**
 * Base mainnet feeds — addresses verified LIVE 2026-06-13 via description()
 * eth_calls (each returned the expected pair name). All 8 decimals.
 */
export const CHAINLINK_FEEDS_BASE: ChainlinkFeed[] = [
  ETH_USD_FEED_BASE,
  { symbol: "USDC", address: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", heartbeatSeconds: 86_400 },
  { symbol: "cbETH", address: "0xd7818272B9e248357d13057AAb0B417aF31E817d", heartbeatSeconds: 1200 },
  { symbol: "BTC", address: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", heartbeatSeconds: 1200 },
];

export interface FeedReading {
  symbol: string;
  /** USD price, or null when the read failed. */
  price: number | null;
  /** Unix seconds of the feed's last update (0 when read failed). */
  updatedAt: number;
  /**
   * True when the read failed, the answer was non-positive, the timestamp is
   * absent/future-dated, or the feed is older than heartbeat × grace. Stale
   * prices must DEGRADE scoring, not feed it (§3.4) — callers flag, never
   * score money math on a stale price.
   */
  isStale: boolean;
}

export interface ChainlinkReaderOptions {
  /** Staleness multiple of the heartbeat. Default 1.5. */
  staleGraceFactor?: number;
  /** Clock injection for tests. Returns unix seconds. */
  now?: () => number;
}

export class ChainlinkPriceReader {
  private readonly grace: number;
  private readonly now: () => number;

  constructor(
    private readonly client: PublicClientLike,
    private readonly feeds: ChainlinkFeed[] = CHAINLINK_FEEDS_BASE,
    opts: ChainlinkReaderOptions = {},
  ) {
    this.grace = opts.staleGraceFactor ?? 1.5;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** One multicall for every feed; failures come back as stale readings. */
  async readAll(): Promise<FeedReading[]> {
    const res = await this.client.multicall({
      allowFailure: true,
      contracts: this.feeds.map((f) => ({
        address: f.address,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
      })),
    });

    const nowS = this.now();
    return this.feeds.map((feed, i) => {
      const r = res[i];
      if (!r || r.status !== "success") {
        return { symbol: feed.symbol, price: null, updatedAt: 0, isStale: true };
      }
      const [, answer, , updatedAt] = r.result as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const price = Number(answer) / 1e8;
      const updated = Number(updatedAt);
      // `now - updatedAt > max` is FALSE for any future timestamp, so a feed
      // reporting a round from the future would otherwise be accepted
      // unconditionally. Treat the future (and a missing/absurd stamp) as stale.
      const unusableStamp =
        !Number.isFinite(updated) || updated <= 0 || updated > nowS;
      const isStale =
        answer <= 0n ||
        unusableStamp ||
        nowS - updated > feed.heartbeatSeconds * this.grace;
      return { symbol: feed.symbol, price, updatedAt: updated, isStale };
    });
  }
}

export interface PriceMove {
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
}

/**
 * Detects significant moves between cycles — the "events" half of arch's
 * "60s + events" cadence. A detected move should trigger an immediate
 * re-score instead of waiting for the next timer tick. Stale readings never
 * update the baseline (a degraded feed must not mask a real move later).
 */
export class PriceWatcher {
  private readonly last = new Map<string, number>();

  constructor(private readonly thresholdPct: number = 2) {}

  update(readings: FeedReading[]): PriceMove[] {
    const moves: PriceMove[] = [];
    for (const r of readings) {
      if (r.isStale || r.price === null) continue;
      const prev = this.last.get(r.symbol);
      if (prev !== undefined) {
        const changePct = (r.price / prev - 1) * 100;
        if (Math.abs(changePct) >= this.thresholdPct) {
          moves.push({ symbol: r.symbol, fromPrice: prev, toPrice: r.price, changePct });
        }
      }
      this.last.set(r.symbol, r.price);
    }
    return moves;
  }
}
