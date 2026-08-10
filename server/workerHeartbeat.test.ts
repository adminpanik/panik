/**
 * The dead-man's heartbeat (Phase 4.B).
 *
 * The property under test is unusual: what must fire is the ABSENCE of an
 * event. Every other alert in this system is triggered by an observation, so
 * every other alert is silenced by a worker that dies — and a dead worker
 * produces no observations at all, which is indistinguishable from a healthy
 * quiet system. These tests assert the inversion works: a loop that stops
 * reporting pages, and a loop that has NEVER reported pages too, because "no
 * row" is the same silence as "an old row".
 */

import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_GRACE_CYCLES,
  MemoryHeartbeatStore,
  expectedByMs,
  heartbeatAlerts,
  heartbeatStale,
  type HeartbeatRecord,
} from "./workerHeartbeat";

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

function record(over: Partial<HeartbeatRecord> = {}): HeartbeatRecord {
  const at = over.at ?? T0;
  const intervalMs = over.intervalMs ?? MINUTE;
  return {
    loop: over.loop ?? "watch",
    at,
    intervalMs,
    expectedByMs: over.expectedByMs ?? expectedByMs(at, intervalMs),
  };
}

describe("expectedByMs", () => {
  it("allows exactly one extra cycle of grace", () => {
    expect(expectedByMs(T0, MINUTE)).toBe(T0 + MINUTE * (1 + HEARTBEAT_GRACE_CYCLES));
  });
});

describe("heartbeatStale", () => {
  it("is false while the loop is inside its grace window", () => {
    const r = record();
    expect(heartbeatStale(r, T0)).toBe(false);
    // A tick that overruns its own period is ordinary, not an outage.
    expect(heartbeatStale(r, T0 + MINUTE + 1)).toBe(false);
    expect(heartbeatStale(r, r.expectedByMs)).toBe(false);
  });

  it("is true once the grace window has passed", () => {
    const r = record();
    expect(heartbeatStale(r, r.expectedByMs + 1)).toBe(true);
  });
});

describe("heartbeatAlerts — ABSENCE is the page", () => {
  it("stays silent while every expected loop is fresh", () => {
    const records = [
      record({ loop: "watch", intervalMs: MINUTE }),
      record({ loop: "dispatch", intervalMs: 15_000 }),
    ];
    expect(heartbeatAlerts(records, ["watch", "dispatch"], T0)).toEqual([]);
  });

  it("fires when a loop stops reporting", () => {
    const records = [record({ loop: "watch", at: T0 })];
    const alerts = heartbeatAlerts(records, ["watch"], T0 + 5 * MINUTE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("worker.heartbeat_missing");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.key).toBe("worker.heartbeat:watch");
    expect(alerts[0]!.summary).toContain("watch");
    expect(alerts[0]!.detail?.overdueMs).toBeGreaterThan(0);
  });

  it("fires for an expected loop that has NO record at all", () => {
    // The whole failure mode: a loop that never started writes no row, so a
    // detector keyed only on existing rows would report an all-clear.
    const alerts = heartbeatAlerts([record({ loop: "watch" })], ["watch", "monitor"], T0);
    expect(alerts.map((a) => a.detail?.loop)).toEqual(["monitor"]);
    expect(alerts[0]!.summary).toContain("never reported");
    expect(alerts[0]!.detail?.lastSeen).toBeNull();
  });

  it("does not report a missing loop during the boot grace window", () => {
    // A rolling deploy is not an outage.
    const opts = { bootedAt: T0, expectedIntervalMs: { monitor: 5 * MINUTE } };
    expect(heartbeatAlerts([], ["monitor"], T0 + MINUTE, opts)).toEqual([]);
    expect(heartbeatAlerts([], ["monitor"], T0 + 11 * MINUTE, opts)).toHaveLength(1);
  });

  it("still reports a STALE loop during the boot grace window", () => {
    // Boot grace covers "has not started yet". A loop that used to report and
    // stopped is an outage whatever the process uptime says.
    const alerts = heartbeatAlerts(
      [record({ loop: "watch", at: T0 - 60 * MINUTE })],
      ["watch"],
      T0,
      { bootedAt: T0, expectedIntervalMs: { watch: MINUTE } },
    );
    expect(alerts).toHaveLength(1);
  });

  it("reports every dead loop independently", () => {
    const alerts = heartbeatAlerts(
      [record({ loop: "watch", at: T0 - 60 * MINUTE }), record({ loop: "dispatch", at: T0 })],
      ["watch", "dispatch", "monitor"],
      T0,
    );
    expect(alerts.map((a) => a.detail?.loop).sort()).toEqual(["monitor", "watch"]);
  });
});

describe("MemoryHeartbeatStore", () => {
  it("records the latest ping per loop with its expiry", async () => {
    const store = new MemoryHeartbeatStore();
    await store.ping("watch", MINUTE, T0);
    await store.ping("watch", MINUTE, T0 + MINUTE);
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at).toBe(T0 + MINUTE);
    expect(rows[0]!.expectedByMs).toBe(expectedByMs(T0 + MINUTE, MINUTE));
  });

  it("round-trips through the detector", async () => {
    const store = new MemoryHeartbeatStore();
    await store.ping("monitor", 5 * MINUTE, T0);
    expect(heartbeatAlerts(await store.list(), ["monitor"], T0 + MINUTE)).toEqual([]);
    expect(heartbeatAlerts(await store.list(), ["monitor"], T0 + 60 * MINUTE)).toHaveLength(1);
  });
});
