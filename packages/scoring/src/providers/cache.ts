/**
 * Minimal TTL cache used by the data providers (per-asset per-cycle caching).
 *
 * FAILURES ARE CACHED TOO, briefly. Caching only successes is what turns one
 * CoinGecko 429 into a spiral there is no exit from: nothing is stored, so the
 * next tick re-asks for every leg of every wallet, which earns another 429 on a
 * 30 req/min free tier, which again stores nothing. A short negative TTL breaks
 * the loop — the first caller pays for the failed request and everyone inside
 * the window is handed the same rejection with no network call at all.
 *
 * A negative entry is still a FAILURE to its callers: `getOrFetch` rethrows the
 * cached error rather than resolving. That is load-bearing. The scoring path
 * reads these providers through `Promise.allSettled`, so a rejection becomes a
 * null sub-score; a cached failure that resolved to some placeholder instead
 * would launder "we could not ask" into data, which is the one thing this cache
 * must never do. Caching makes a failure cheaper, never quieter.
 */

/** Failed lookups are retried this soon — long enough to stop a burst. */
export const DEFAULT_FAILURE_TTL_MS = 60_000;

type Entry<V> =
  | { readonly ok: true; readonly value: V; readonly expiresAt: number }
  | { readonly ok: false; readonly error: unknown; readonly expiresAt: number };

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly failureTtlMs: number;

  /**
   * `failureTtlMs` is clamped to the success TTL: a caller that asked for no
   * caching at all (ttl 0, as tests do) must not silently get a minute of
   * remembered failures out of a default it never set.
   */
  constructor(
    private readonly ttlMs: number,
    failureTtlMs: number = DEFAULT_FAILURE_TTL_MS,
  ) {
    this.failureTtlMs = Math.min(Math.max(failureTtlMs, 0), ttlMs);
  }

  async getOrFetch(key: string, fetcher: () => Promise<V>): Promise<V> {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      if (hit.ok) return hit.value;
      throw hit.error;
    }
    try {
      const value = await fetcher();
      // Overwrites any expired negative entry: a success is the newer truth.
      this.store.set(key, { ok: true, value, expiresAt: Date.now() + this.ttlMs });
      return value;
    } catch (error) {
      this.store.set(key, { ok: false, error, expiresAt: Date.now() + this.failureTtlMs });
      throw error;
    }
  }
}
