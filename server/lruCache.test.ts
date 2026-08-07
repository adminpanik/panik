/**
 * The wallet-keyed response caches are filled from caller-supplied addresses,
 * so the cap is what stands between the API and an OOM one address at a time —
 * and the recency order is what decides whose result a flood evicts.
 */

import { describe, expect, it } from "vitest";

import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("stores and overwrites by key", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("never exceeds its cap", () => {
    const cache = new LruCache<number>(100);
    for (let i = 0; i < 10_000; i++) cache.set(`0x${i.toString(16)}`, i);
    expect(cache.size).toBe(100);
  });

  it("evicts the LEAST RECENTLY USED entry, not the oldest inserted", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1); // "a" is now the most recently used
    cache.set("d", 4);
    expect(cache.get("b")).toBeUndefined(); // "b" was the LRU
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("re-setting an existing key does not shrink the cache below the cap", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(9);
    expect(cache.get("b")).toBe(2);
  });

  it("deletes", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.size).toBe(0);
  });
});
