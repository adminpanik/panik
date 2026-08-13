import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FAILURE_TTL_MS, TtlCache } from "../src/providers/cache";
import { CoinGeckoProvider } from "../src/providers/coingecko";
import { DefiLlamaProvider } from "../src/providers/defillama";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

/** 92 synthetic daily closes (ts, price) — enough for the 91-day window. */
function syntheticChart(base: number): { prices: [number, number][] } {
  return {
    prices: Array.from({ length: 92 }, (_, i) => [
      i * 86_400_000,
      base * (1 + 0.01 * Math.sin(i)),
    ]),
  };
}

describe("CoinGeckoProvider", () => {
  it("builds AssetRiskInput (30 returns, 90d extremes) and caches per asset", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      return jsonResponse(syntheticChart(u.includes("/bitcoin/") ? 60000 : 1800));
    });
    const provider = new CoinGeckoProvider("test-key", { fetchFn });

    const input = await provider.getAssetRiskInput("ethereum");
    expect(input.dailyReturns30d).toHaveLength(30);
    expect(input.btcReturns30d).toHaveLength(30);
    // Ordered 90d series (91 closes) — the drawdown term needs the ordering.
    expect(input.prices90d).toHaveLength(91);
    expect(input.maxPrice90d ?? 0).toBeGreaterThan(input.minPrice90d ?? 0);
    expect(fetchFn).toHaveBeenCalledTimes(2); // ethereum + bitcoin

    // Second asset reuses the cached BTC series: only ONE new fetch.
    await provider.getAssetRiskInput("usd-coin");
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // Same asset again within TTL: zero new fetches.
    await provider.getAssetRiskInput("ethereum");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("sends the demo API key header", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(syntheticChart(100)));
    await new CoinGeckoProvider("CG-KEY", { fetchFn }).getAssetRiskInput("ethereum");
    const callArgs = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["x-cg-demo-api-key"]).toBe("CG-KEY");
  });

  it("throws on HTTP errors and on short series", async () => {
    const p1 = new CoinGeckoProvider("k", { fetchFn: async () => errorResponse(429) });
    await expect(p1.getAssetRiskInput("ethereum")).rejects.toThrow("HTTP 429");

    const p2 = new CoinGeckoProvider("k", {
      fetchFn: async () => jsonResponse({ prices: [[0, 1]] }),
    });
    await expect(p2.getAssetRiskInput("ethereum")).rejects.toThrow("price points");
  });

  it("stops re-asking after a 429, and still fails rather than inventing data", async () => {
    const fetchFn = vi.fn(async () => errorResponse(429));
    const provider = new CoinGeckoProvider("k", { fetchFn });

    await expect(provider.getAssetRiskInput("ethereum")).rejects.toThrow("HTTP 429");
    expect(fetchFn).toHaveBeenCalledTimes(2); // ethereum + bitcoin, once each

    // Every other leg of every other wallet in the window rides the cached
    // rejection: no new requests, and no result that could pass for data.
    await expect(provider.getAssetRiskInput("ethereum")).rejects.toThrow("HTTP 429");
    await expect(provider.getAssetRiskInput("usd-coin")).rejects.toThrow("HTTP 429");
    expect(fetchFn).toHaveBeenCalledTimes(3); // only the new asset, usd-coin
  });
});

describe("DefiLlamaProvider", () => {
  const DAY = 86_400;

  it("picks now vs the closest point ≥7d older, for sector and protocol", async () => {
    const sector = Array.from({ length: 30 }, (_, i) => ({
      date: 1_700_000_000 + i * DAY,
      tvl: 100e9 + i * 1e9, // rising: now = 129e9, 7d-ago = 122e9
    }));
    const protocol = {
      tvl: Array.from({ length: 30 }, (_, i) => ({
        date: 1_700_000_000 + i * DAY,
        totalLiquidityUSD: 5e9 - i * 0.05e9,
      })),
    };
    const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
      jsonResponse(String(url).includes("historicalChainTvl") ? sector : protocol),
    );

    const input = await new DefiLlamaProvider({ fetchFn }).getSystemicRiskInput(
      "aave-v3",
    );
    expect(input.sectorTvlNow).toBe(129e9);
    expect(input.sectorTvl7dAgo).toBe(122e9);
    expect(input.protocolTvlNow).toBeCloseTo(5e9 - 29 * 0.05e9, 5);
    expect(input.protocolTvl7dAgo).toBeCloseTo(5e9 - 22 * 0.05e9, 5);
  });

  it("throws on empty TVL series", async () => {
    const provider = new DefiLlamaProvider({
      fetchFn: async () => jsonResponse([]),
    });
    await expect(provider.getSystemicRiskInput("aave-v3")).rejects.toThrow(
      "empty TVL series",
    );
  });

  it("does not re-ask a failing endpoint inside the negative window", async () => {
    const fetchFn = vi.fn(async () => errorResponse(503));
    const provider = new DefiLlamaProvider({ fetchFn });

    await expect(provider.getSystemicRiskInput("aave-v3")).rejects.toThrow("HTTP 503");
    // Both legs (sector + protocol) missed once; neither is re-fetched.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await expect(provider.getSystemicRiskInput("aave-v3")).rejects.toThrow("HTTP 503");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("TtlCache negative caching", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const HOUR = 60 * 60 * 1000;

  it("caches the rejection: one fetch serves every caller in the window", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    const cache = new TtlCache<number>(HOUR);

    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("surfaces the cached miss as a rejection, never as data", async () => {
    const cause = new Error("HTTP 429");
    const cache = new TtlCache<number | null>(HOUR);
    const fetcher = async (): Promise<number | null> => {
      throw cause;
    };

    await expect(cache.getOrFetch("k", fetcher)).rejects.toBe(cause);
    // The point of the whole design: allSettled consumers must still see a
    // rejection, so the sub-score stays null rather than becoming a zero.
    const settled = await Promise.allSettled([cache.getOrFetch("k", fetcher)]);
    expect(settled[0]!.status).toBe("rejected");
    expect((settled[0] as PromiseRejectedResult).reason).toBe(cause);
  });

  it("retries once the (much shorter) negative TTL expires", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const fetcher = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    const cache = new TtlCache<number>(HOUR);

    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    vi.setSystemTime(start + DEFAULT_FAILURE_TTL_MS - 1);
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + DEFAULT_FAILURE_TTL_MS + 1);
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(2);
    // The success TTL is untouched by any of this: an hour, not a minute.
    expect(DEFAULT_FAILURE_TTL_MS).toBeLessThan(HOUR);
  });

  it("lets a later success replace the negative entry and cache normally", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let fail = true;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error("HTTP 429");
      return 7;
    });
    const cache = new TtlCache<number>(HOUR);

    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    fail = false;
    vi.setSystemTime(start + DEFAULT_FAILURE_TTL_MS + 1);
    await expect(cache.getOrFetch("k", fetcher)).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // And the replacement is a normal success entry: cached for the full hour.
    vi.setSystemTime(start + DEFAULT_FAILURE_TTL_MS + HOUR - 1);
    await expect(cache.getOrFetch("k", fetcher)).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps failures per key: one bad asset does not blank the others", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key === "bad") throw new Error("HTTP 429");
      return 1;
    });
    const cache = new TtlCache<number>(HOUR);

    await expect(cache.getOrFetch("bad", () => fetcher("bad"))).rejects.toThrow("HTTP 429");
    await expect(cache.getOrFetch("good", () => fetcher("good"))).resolves.toBe(1);
  });

  it("never caches a failure longer than the success TTL it was given", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    // ttl 0 means "do not cache" — the negative default must not override it.
    const cache = new TtlCache<number>(0);

    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    await expect(cache.getOrFetch("k", fetcher)).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
