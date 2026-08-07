import { describe, expect, it, vi } from "vitest";
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
});
