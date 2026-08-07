import { dailyReturns } from "../math";
import type { AssetRiskInput } from "../types";
import { TtlCache } from "./cache";
import type { AssetRiskProvider, FetchFn } from "./types";

/**
 * CoinGecko Demo plan: 30 calls/min, 10k calls/month. Daily history barely
 * moves intraday, so a 1h TTL keeps ~5 assets ≈ 7k calls/month — inside
 * budget. BTC is fetched once and shared across assets via the same cache.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface CoinGeckoOptions {
  baseUrl?: string;
  ttlMs?: number;
  fetchFn?: FetchFn;
}

export class CoinGeckoProvider implements AssetRiskProvider {
  private readonly cache: TtlCache<number[]>;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly apiKey: string,
    opts: CoinGeckoOptions = {},
  ) {
    this.cache = new TtlCache(opts.ttlMs ?? DEFAULT_TTL_MS);
    this.baseUrl = opts.baseUrl ?? "https://api.coingecko.com/api/v3";
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** 91 daily closes (90d window + today) for one CoinGecko asset id. */
  private dailyPrices(id: string): Promise<number[]> {
    return this.cache.getOrFetch(id, async () => {
      const url = `${this.baseUrl}/coins/${id}/market_chart?vs_currency=usd&days=91&interval=daily`;
      const res = await this.fetchFn(url, {
        headers: { "x-cg-demo-api-key": this.apiKey },
      });
      if (!res.ok) throw new Error(`CoinGecko ${id}: HTTP ${res.status}`);
      const body = (await res.json()) as { prices?: [number, number][] };
      const prices = (body.prices ?? []).map(([, p]) => p);
      if (prices.length < 31) {
        throw new Error(`CoinGecko ${id}: only ${prices.length} price points`);
      }
      return prices;
    });
  }

  async getAssetRiskInput(coingeckoId: string): Promise<AssetRiskInput> {
    const [asset, btc] = await Promise.all([
      this.dailyPrices(coingeckoId),
      this.dailyPrices("bitcoin"),
    ]);
    const win90 = asset.slice(-91);
    return {
      dailyReturns30d: dailyReturns(asset).slice(-30),
      btcReturns30d: dailyReturns(btc).slice(-30),
      // Ordered series drives the true max drawdown; the extremes are kept
      // for backwards compatibility with consumers still reading them.
      prices90d: win90,
      maxPrice90d: Math.max(...win90),
      minPrice90d: Math.min(...win90),
    };
  }
}
