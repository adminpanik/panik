/**
 * The one thing worth testing here: an unknown figure stays unknown.
 *
 * The whole point of this module is that a null from SQL survives the trip to
 * the console, because "we could not price these positions" and "these
 * positions are worth nothing" are different sentences and only one of them is
 * true. A `?? 0` anywhere in the mapping turns the second into the first, and
 * it would be invisible in every environment where the data happens to be
 * complete.
 */

import { describe, expect, it } from "vitest";

import { MetricsStore, toMetrics } from "./metricsStore";

const FULL = {
  walletsConnected: 12,
  positionsMonitored: 19,
  positionsPriced: 17,
  positionsFresh: 18,
  freshWindowMinutes: 15,
  collateralUsd: 482_300.55,
  eventsReady: true,
  txCount: 640,
  txVolumeUsd: 1_204_000,
  txUnpriced: 3,
  txOldestAt: "2026-08-07T09:00:00Z",
  generatedAt: "2026-08-14T09:01:00Z",
};

function stubFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

describe("toMetrics", () => {
  it("passes a complete payload through unchanged", () => {
    expect(toMetrics(FULL)).toEqual(FULL);
  });

  it("keeps every unknown as null rather than zero", () => {
    const m = toMetrics({
      walletsConnected: 4,
      positionsMonitored: 2,
      positionsPriced: 0,
      collateralUsd: null,
      positionsFresh: 0,
      freshWindowMinutes: 15,
      eventsReady: false,
      txCount: null,
      txVolumeUsd: null,
      txUnpriced: null,
      txOldestAt: null,
      generatedAt: "2026-08-14T09:01:00Z",
    });
    expect(m.collateralUsd).toBeNull();
    expect(m.txCount).toBeNull();
    expect(m.txVolumeUsd).toBeNull();
    expect(m.txUnpriced).toBeNull();
    expect(m.txOldestAt).toBeNull();
    // A freshness ratio of 0-of-2 is a known fact, not an unknown: the counts
    // are always known even when every figure derived from them is missing.
    expect(m.positionsFresh).toBe(0);
    expect(m.eventsReady).toBe(false);
    // Counts the schema guarantees stay numbers.
    expect(m.walletsConnected).toBe(4);
    expect(m.positionsPriced).toBe(0);
  });

  it("treats a non-numeric or absent field as unknown, never as 0", () => {
    const m = toMetrics({ collateralUsd: "482300.55", txCount: undefined });
    expect(m.collateralUsd).toBeNull();
    expect(m.txCount).toBeNull();
  });

  it("does not invent an eventsReady of true", () => {
    expect(toMetrics({}).eventsReady).toBe(false);
    expect(toMetrics({ eventsReady: "yes" }).eventsReady).toBe(false);
  });
});

describe("MetricsStore.fetchMetrics", () => {
  it("returns the mapped payload on success", async () => {
    const store = new MetricsStore("https://x.supabase.co/", "key", stubFetch(200, FULL));
    await expect(store.fetchMetrics()).resolves.toEqual(FULL);
  });

  it("throws on an error status instead of returning empty figures", async () => {
    const store = new MetricsStore("https://x.supabase.co", "key", stubFetch(404, { message: "no fn" }));
    await expect(store.fetchMetrics()).rejects.toThrow("HTTP 404");
  });
});
