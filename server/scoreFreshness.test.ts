/**
 * The score-cache freshness bound.
 *
 * The property under test is a negative one, and it is the reason the file
 * exists: a position whose latest score is too old must LEAVE the caller's set.
 * Not be zeroed, not be defaulted to a safe health factor, not be carried
 * forward as "probably still fine". The relayer compares these health factors
 * against a user's signed trigger, so "unknown" and "unchanged" are not the
 * same answer and the difference is somebody's collateral.
 */

import { describe, expect, it } from "vitest";
import {
  SCORE_STALE_TICKS,
  freshScores,
  isScoreFresh,
  scoreMaxAgeMs,
  type StampedScore,
} from "./scoreFreshness";

const T0 = 1_800_000_000_000;
const TICK = 60_000;
const MAX_AGE = scoreMaxAgeMs(TICK);

interface Leg {
  wallet: string;
  healthFactor: number | null;
}

function entry(at: number, healthFactor: number | null = 1.4): StampedScore<Leg> {
  return { score: { wallet: "0xabc", healthFactor }, at };
}

describe("scoreMaxAgeMs", () => {
  it("scales with the worker's own tick, in ticks not minutes", () => {
    expect(scoreMaxAgeMs(TICK)).toBe(TICK * SCORE_STALE_TICKS);
    expect(scoreMaxAgeMs(15_000)).toBe(15_000 * SCORE_STALE_TICKS);
  });

  it("accepts an explicit tick budget", () => {
    expect(scoreMaxAgeMs(TICK, 1)).toBe(TICK);
  });
});

describe("isScoreFresh", () => {
  it("accepts a score from this tick", () => {
    expect(isScoreFresh(entry(T0), T0, MAX_AGE)).toBe(true);
  });

  it("accepts a score exactly at the bound", () => {
    expect(isScoreFresh(entry(T0 - MAX_AGE), T0, MAX_AGE)).toBe(true);
  });

  it("rejects a score one millisecond past the bound", () => {
    expect(isScoreFresh(entry(T0 - MAX_AGE - 1), T0, MAX_AGE)).toBe(false);
  });

  it("rejects the multi-day case that motivated this", () => {
    expect(isScoreFresh(entry(T0 - 3 * 86_400_000), T0, MAX_AGE)).toBe(false);
  });

  it("treats a future stamp as fresh rather than as stale", () => {
    expect(isScoreFresh(entry(T0 + TICK), T0, MAX_AGE)).toBe(true);
  });
});

describe("freshScores", () => {
  it("keeps fresh values and names the stale keys", () => {
    const cache = new Map<string, StampedScore<Leg>>([
      ["0xa:aave_v3", entry(T0)],
      ["0xb:morpho", entry(T0 - TICK)],
      ["0xc:moonwell", entry(T0 - 10 * TICK)],
    ]);
    const { fresh, staleKeys } = freshScores(cache, T0, MAX_AGE);
    expect(fresh).toHaveLength(2);
    expect(staleKeys).toEqual(["0xc:moonwell"]);
  });

  it("DROPS a stale position rather than substituting a value for it", () => {
    const cache = new Map<string, StampedScore<Leg>>([["0xc:moonwell", entry(T0 - 10 * TICK, 0.9)]]);
    const { fresh, staleKeys } = freshScores(cache, T0, MAX_AGE);
    // No entry at all: not a zero health factor, not a null-but-present leg.
    expect(fresh).toEqual([]);
    expect(staleKeys).toEqual(["0xc:moonwell"]);
  });

  it("empties the set entirely when every score has gone stale", () => {
    const cache = new Map<string, StampedScore<Leg>>([
      ["0xa:aave_v3", entry(T0 - 10 * TICK)],
      ["0xb:morpho", entry(T0 - 10 * TICK)],
    ]);
    const { fresh, staleKeys } = freshScores(cache, T0, MAX_AGE);
    expect(fresh).toEqual([]);
    expect(staleKeys).toHaveLength(2);
  });

  it("carries the score through untouched", () => {
    const leg = entry(T0, null);
    const { fresh } = freshScores(new Map([["0xa:aave_v3", leg]]), T0, MAX_AGE);
    // A degraded leg's null health factor stays null: this filter decides
    // whether a score is evidence, never what the score says.
    expect(fresh[0]).toBe(leg.score);
    expect(fresh[0]!.healthFactor).toBeNull();
  });

  it("handles an empty cache without inventing anything", () => {
    const { fresh, staleKeys } = freshScores(new Map<string, StampedScore<Leg>>(), T0, MAX_AGE);
    expect(fresh).toEqual([]);
    expect(staleKeys).toEqual([]);
  });
});
