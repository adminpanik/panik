/**
 * The blind-scoring detector.
 *
 * The property under test is the one a multi-day outage disproved: liveness is
 * not health. A worker that ticks on schedule and scores nothing is the failure
 * mode every other signal in this system reads as fine, so these tests pin the
 * three edges that decide whether the page is trustworthy — it needs a RUN of
 * empty ticks (not one), it needs wallets to have been watched (an empty
 * registry is not blindness), and it must clear itself the moment a single leg
 * is scored again.
 */

import { describe, expect, it } from "vitest";
import { SCORING_BLIND_TICKS, ScoringBlindWatch, type ScoringTick } from "./scoringBlind";
import { ALERT_REPEAT_MS, repeatWindowFor, type MonitorAlert } from "./monitorAlerts";

const T0 = 1_800_000_000_000;
const TICK = 60_000;

function tick(over: Partial<ScoringTick> = {}): ScoringTick {
  return {
    legsScored: over.legsScored ?? 0,
    walletsWatched: over.walletsWatched ?? 3,
    at: over.at ?? T0,
  };
}

/** Feed `n` empty ticks one interval apart, returning every alert produced. */
function runEmpty(watch: ScoringBlindWatch, n: number, walletsWatched = 3): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (let i = 0; i < n; i++) {
    out.push(...watch.observe(tick({ at: T0 + i * TICK, walletsWatched })));
  }
  return out;
}

describe("ScoringBlindWatch", () => {
  it("stays silent while the pass is producing legs", () => {
    const watch = new ScoringBlindWatch();
    for (let i = 0; i < 10; i++) {
      expect(watch.observe(tick({ legsScored: 4, at: T0 + i * TICK }))).toEqual([]);
    }
    expect(watch.blindTicks).toBe(0);
  });

  it("does not page on a single empty tick", () => {
    const watch = new ScoringBlindWatch();
    expect(watch.observe(tick())).toEqual([]);
    expect(watch.blindTicks).toBe(1);
  });

  it("stays silent until the threshold run is complete", () => {
    const watch = new ScoringBlindWatch();
    expect(runEmpty(watch, SCORING_BLIND_TICKS - 1)).toEqual([]);
  });

  it("pages on the threshold-th consecutive empty tick", () => {
    const watch = new ScoringBlindWatch();
    const alerts = runEmpty(watch, SCORING_BLIND_TICKS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("scoring.blind");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.detail?.consecutiveTicks).toBe(SCORING_BLIND_TICKS);
    expect(alerts[0]!.detail?.walletsWatched).toBe(3);
  });

  it("dates the condition from the FIRST empty tick, not the one that paged", () => {
    const watch = new ScoringBlindWatch();
    const alerts = runEmpty(watch, SCORING_BLIND_TICKS);
    expect(alerts[0]!.detail?.blindSince).toBe(new Date(T0).toISOString());
    expect(alerts[0]!.detail?.blindForMs).toBe((SCORING_BLIND_TICKS - 1) * TICK);
  });

  it("keeps one stable key so the ledger can suppress the repeats", () => {
    const watch = new ScoringBlindWatch();
    const alerts = runEmpty(watch, SCORING_BLIND_TICKS + 4);
    expect(alerts.length).toBeGreaterThan(1);
    expect(new Set(alerts.map((a) => a.key)).size).toBe(1);
  });

  it("repeats hourly through the standard critical window", () => {
    const watch = new ScoringBlindWatch();
    const [alert] = runEmpty(watch, SCORING_BLIND_TICKS);
    expect(repeatWindowFor(alert!)).toBe(ALERT_REPEAT_MS.critical);
  });

  it("clears itself when a single leg is scored again", () => {
    const watch = new ScoringBlindWatch();
    runEmpty(watch, SCORING_BLIND_TICKS);
    expect(watch.observe(tick({ legsScored: 1, at: T0 + 10 * TICK }))).toEqual([]);
    expect(watch.blindTicks).toBe(0);
    // And the next run has to earn the page from scratch.
    expect(watch.observe(tick({ at: T0 + 11 * TICK }))).toEqual([]);
  });

  it("re-dates a later outage rather than reusing the first one's start", () => {
    const watch = new ScoringBlindWatch();
    runEmpty(watch, SCORING_BLIND_TICKS);
    watch.observe(tick({ legsScored: 2, at: T0 + 10 * TICK }));
    const later = T0 + 20 * TICK;
    const alerts: MonitorAlert[] = [];
    for (let i = 0; i < SCORING_BLIND_TICKS; i++) {
      alerts.push(...watch.observe(tick({ at: later + i * TICK })));
    }
    expect(alerts[0]!.detail?.blindSince).toBe(new Date(later).toISOString());
  });

  it("treats an empty registry as nothing to score, not as blindness", () => {
    const watch = new ScoringBlindWatch();
    expect(runEmpty(watch, SCORING_BLIND_TICKS * 3, 0)).toEqual([]);
    expect(watch.blindTicks).toBe(0);
  });

  it("does not carry an empty-registry run into a populated one", () => {
    const watch = new ScoringBlindWatch();
    runEmpty(watch, SCORING_BLIND_TICKS, 0);
    // First populated empty tick starts the run at 1, so no page yet.
    expect(watch.observe(tick({ walletsWatched: 5 }))).toEqual([]);
    expect(watch.blindTicks).toBe(1);
  });

  it("honours a custom threshold", () => {
    const watch = new ScoringBlindWatch(2);
    expect(runEmpty(watch, 1)).toEqual([]);
    expect(runEmpty(watch, 1)).toHaveLength(1);
  });

  it("stays operator-only: no userMessage, no wallet", () => {
    const watch = new ScoringBlindWatch();
    const [alert] = runEmpty(watch, SCORING_BLIND_TICKS);
    expect(alert!.userMessage).toBeUndefined();
    expect(alert!.wallet).toBeUndefined();
  });
});
