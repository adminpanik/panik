/**
 * Whether a scored leg is worth a persisted `score_snapshots` row.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT: the watch worker's snapshot decision
 * used to compare a fresh score against `lastScored`, a map it had ALREADY
 * overwritten with that same fresh score a line earlier. Every comparison
 * was therefore an object compared against itself, always equal, so a real
 * change in total/band never tripped a snapshot, and only the 15-minute
 * heartbeat ever fired. See scripts/watch-worker.ts, where the caller now
 * captures the previous entry before touching the cache and passes it in
 * here explicitly, rather than this function (or the caller) reading a
 * mutable cache mid-decision.
 */

/** The fields a snapshot decision cares about, nothing else about a score. */
export interface SnapshotComparable {
  total: number;
  band: string;
}

/**
 * @param prev previous PERSISTED score for this wallet/protocol, or
 *   `undefined` if none has been scored yet this run. Must be the entry from
 *   BEFORE the current tick's score was recorded, never the value being
 *   decided about.
 * @param current the score just produced this tick.
 * @param lastSnapshotAtMs epoch ms of the last snapshot written for this key,
 *   or 0 if none has ever been written.
 * @param heartbeatMs max gap allowed between snapshots even with no change.
 * @param nowMs current time, epoch ms.
 */
export function shouldSnapshot(
  prev: SnapshotComparable | undefined,
  current: SnapshotComparable,
  lastSnapshotAtMs: number,
  heartbeatMs: number,
  nowMs: number,
): boolean {
  const changed = !prev || prev.total !== current.total || prev.band !== current.band;
  const heartbeatDue = nowMs - lastSnapshotAtMs >= heartbeatMs;
  return changed || heartbeatDue;
}
