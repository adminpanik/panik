/**
 * How old a cached score may be before it stops being evidence.
 *
 * THE CACHE THAT NEVER FORGOT. The worker keeps the latest `ActiveScore` per
 * position in a plain Map, and nothing ever removed an entry. Three consumers
 * act on that Map, and each of them read a score from an unknown point in the
 * past as if it were the current state of a wallet:
 *
 *   * the relayer offers candidates whose `healthFactor` is compared against a
 *     user's SIGNED trigger. A health factor from before an outage is a claim
 *     about someone's money that nothing has checked since.
 *   * the coverage sweep decides which wallets to verify and, through
 *     `atRisk`, how loudly to page about an unreachable Telegram link.
 *   * the alert's why-now line explains a crossing with the facts that caused
 *     it, which stop being those facts once they are hours old.
 *
 * A STALE ENTRY IS UNKNOWN. Not safe, not at-risk, not recovered. This is the
 * whole point of the file and the only rule that matters when reading it: a
 * position whose latest score is too old DROPS OUT of the set the caller is
 * building. It must never be substituted with a zero, a default health factor,
 * or an assumption that nothing changed — the same rule that keeps a degraded
 * price feed from rendering a $120,000 debt as $40.
 *
 * The bound is expressed in TICKS rather than in wall-clock minutes so it
 * follows WATCH_TICK_MS wherever the worker is deployed: three ticks is two
 * misses plus the one in progress, which is the same "this is not jitter"
 * judgement server/workerHeartbeat.ts makes about a missing heartbeat.
 */

/** A cached value plus the tick that produced it. */
export interface StampedScore<T> {
  score: T;
  /** Time the producing tick read this score, epoch ms. */
  at: number;
}

/**
 * Ticks a score may survive before it is treated as unknown.
 *
 * Three. One missed tick is ordinary (a slow RPC, a pool reconnect); at three
 * the position has gone two full cycles without anyone confirming it still
 * looks the way this entry says it does.
 */
export const SCORE_STALE_TICKS = 3;

export function scoreMaxAgeMs(tickMs: number, ticks: number = SCORE_STALE_TICKS): number {
  return tickMs * ticks;
}

/**
 * Is this entry still evidence as of `nowMs`?
 *
 * A stamp in the FUTURE counts as fresh: it can only come from clock skew or a
 * tick that is still settling, and treating "too new" as "too old" would drop a
 * position for being up to date.
 */
export function isScoreFresh(entry: StampedScore<unknown>, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - entry.at <= maxAgeMs;
}

/**
 * Split a score cache into what is still evidence and what is not.
 *
 * Returns the fresh VALUES (every caller wants the score, not the entry) and
 * the stale KEYS, so a caller can say which positions it dropped and why
 * instead of quietly shrinking its own working set.
 */
export function freshScores<T>(
  entries: Iterable<readonly [string, StampedScore<T>]>,
  nowMs: number,
  maxAgeMs: number,
): { fresh: T[]; staleKeys: string[] } {
  const fresh: T[] = [];
  const staleKeys: string[] = [];
  for (const [key, entry] of entries) {
    if (isScoreFresh(entry, nowMs, maxAgeMs)) fresh.push(entry.score);
    else staleKeys.push(key);
  }
  return { fresh, staleKeys };
}
