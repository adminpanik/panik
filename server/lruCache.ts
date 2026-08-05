/**
 * Minimal LRU map for the API's per-wallet response caches. Those are keyed by
 * caller-supplied wallet strings, so an unbounded Map is an OOM lever — this
 * caps the entry count and drops the least-recently-used key when full.
 *
 * Same surface as the Map methods the caches already use (get/set/delete), so
 * call sites only change the constructor. Not a TTL cache: the callers keep
 * their own `at` timestamps and decide what counts as fresh.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert so Map iteration order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
