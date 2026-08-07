import { describe, expect, it, vi } from "vitest";
import type { PublicClientLike } from "../src/adapters/chain";
import {
  ChainlinkPriceReader,
  PriceWatcher,
  type ChainlinkFeed,
} from "../src/providers/chainlink";

const ok = (result: unknown) => ({ status: "success" as const, result });
const NOW = 1_750_000_000;

const feeds: ChainlinkFeed[] = [
  { symbol: "ETH", address: "0xfeed1", heartbeatSeconds: 1200 },
  { symbol: "USDC", address: "0xfeed2", heartbeatSeconds: 86_400 },
];

function round(answer: bigint, updatedAt: number) {
  return ok([1n, answer, 0n, BigInt(updatedAt), 1n]);
}

describe("ChainlinkPriceReader", () => {
  it("decodes prices and flags staleness per-feed heartbeat", async () => {
    const multicall = vi.fn().mockResolvedValueOnce([
      round(1667_46000000n, NOW - 3000), // ETH: 3000s old > 1200×1.5 → stale
      round(1_00000000n, NOW - 3000), // USDC: well within 24h heartbeat
    ]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const reader = new ChainlinkPriceReader(client, feeds, { now: () => NOW });

    const [eth, usdc] = await reader.readAll();
    expect(eth?.price).toBeCloseTo(1667.46, 6);
    expect(eth?.isStale).toBe(true);
    expect(usdc?.price).toBeCloseTo(1.0, 6);
    expect(usdc?.isStale).toBe(false);
  });

  it("treats failed reads and non-positive answers as stale", async () => {
    const multicall = vi.fn().mockResolvedValueOnce([
      { status: "failure" as const },
      round(0n, NOW),
    ]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const [a, b] = await new ChainlinkPriceReader(client, feeds, {
      now: () => NOW,
    }).readAll();
    expect(a?.price).toBeNull();
    expect(a?.isStale).toBe(true);
    expect(b?.isStale).toBe(true);
  });

  // `now - updatedAt > max` is FALSE for every future timestamp, so without an
  // explicit guard a feed reporting the future is accepted unconditionally.
  it("rejects future-dated and missing round timestamps", async () => {
    const multicall = vi.fn().mockResolvedValueOnce([
      round(1667_46000000n, NOW + 3600), // an hour in the future
      round(1_00000000n, 0), // never updated
    ]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const [future, missing] = await new ChainlinkPriceReader(client, feeds, {
      now: () => NOW,
    }).readAll();
    expect(future?.isStale).toBe(true);
    expect(missing?.isStale).toBe(true);
  });

  it("accepts a round inside heartbeat × grace (ETH: 1200 × 1.5 = 1800s)", async () => {
    const multicall = vi
      .fn()
      .mockResolvedValueOnce([round(2000_00000000n, NOW - 1799), round(1_00000000n, NOW)]);
    const client = { multicall, readContract: vi.fn() } as unknown as PublicClientLike;
    const [eth] = await new ChainlinkPriceReader(client, feeds, { now: () => NOW }).readAll();
    expect(eth?.isStale).toBe(false);
  });
});

describe("PriceWatcher (event-trigger detection)", () => {
  const fresh = (symbol: string, price: number) => ({
    symbol,
    price,
    updatedAt: NOW,
    isStale: false,
  });

  it("fires only on moves ≥ threshold, after a baseline exists", () => {
    const w = new PriceWatcher(2);
    expect(w.update([fresh("ETH", 1700)])).toEqual([]); // baseline
    expect(w.update([fresh("ETH", 1715)])).toEqual([]); // +0.88% — quiet
    const moves = w.update([fresh("ETH", 1660)]); // −3.2% from 1715
    expect(moves).toHaveLength(1);
    expect(moves[0]?.changePct).toBeLessThan(-2);
  });

  it("stale readings never update the baseline", () => {
    const w = new PriceWatcher(2);
    w.update([fresh("ETH", 1700)]);
    w.update([{ symbol: "ETH", price: 9999, updatedAt: 0, isStale: true }]);
    // Baseline must still be 1700 — the bogus stale price was ignored.
    const moves = w.update([fresh("ETH", 1750)]); // +2.9% vs 1700
    expect(moves).toHaveLength(1);
    expect(moves[0]?.fromPrice).toBe(1700);
  });
});
