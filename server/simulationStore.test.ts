/**
 * The cache in front of the simulation row, and the validation in front of the
 * operator.
 *
 * The cache is the piece that decides whether a scenario can outlive its
 * window, so its failure directions are tested explicitly: a database outage
 * may run a scenario to its natural end, and must never extend one past it or
 * invent one.
 */

import { describe, expect, it, vi } from "vitest";
import {
  SimulationCache,
  rowToSimulation,
  simulationWire,
  validateArmInput,
  type ArmSimulationInput,
  type SimulationRow,
} from "./simulationStore";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");

function row(overrides: Partial<SimulationRow> = {}): SimulationRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    scenario: "crash",
    label: "Crash",
    multipliers: { cbBTC: 0.6 },
    set_by: "admin.panik@gmail.com",
    started_at: "2026-08-10T12:00:00.000Z",
    expires_at: "2026-08-10T13:00:00.000Z",
    cleared_at: null,
    cleared_by: null,
    ...overrides,
  };
}

function arm(overrides: Partial<ArmSimulationInput> = {}): ArmSimulationInput {
  return {
    scenario: "crash",
    label: "Crash",
    multipliers: { cbBTC: 0.6 },
    durationMinutes: 60,
    setBy: "admin.panik@gmail.com",
    ...overrides,
  };
}

describe("rowToSimulation", () => {
  it("converts timestamps to epoch ms so expiry is a comparison", () => {
    const sim = rowToSimulation(row());
    expect(sim.startedAt).toBe(T0);
    expect(sim.expiresAt).toBe(T0 + 60 * 60_000);
    expect(sim.multipliers).toEqual({ cbBTC: 0.6 });
  });

  it("survives a row whose multipliers column came back null", () => {
    expect(rowToSimulation(row({ multipliers: null as never })).multipliers).toEqual({});
  });
});

describe("validateArmInput", () => {
  it("accepts a well-formed scenario", () => {
    expect(validateArmInput(arm())).toBeNull();
  });

  it("refuses a duration outside the bounded window", () => {
    expect(validateArmInput(arm({ durationMinutes: 0 }))).toMatch(/duration/);
    expect(validateArmInput(arm({ durationMinutes: 241 }))).toMatch(/duration/);
    expect(validateArmInput(arm({ durationMinutes: NaN }))).toMatch(/duration/);
    expect(validateArmInput(arm({ durationMinutes: 240 }))).toBeNull();
  });

  it("refuses a scenario that would change nothing", () => {
    // An "armed" simulation that moves no number would light the marker over
    // figures that are real: a marker that lies about itself.
    expect(validateArmInput(arm({ multipliers: {} }))).toMatch(/at least one asset/);
    expect(validateArmInput(arm({ multipliers: { cbBTC: 1 } }))).toMatch(/actually move/);
  });

  it("refuses a multiplier that is not a price, rather than coercing it", () => {
    // Rejecting instead of clamping: an operator who asked for 40% and silently
    // got 20% would demonstrate the wrong thing and never find out.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(validateArmInput(arm({ multipliers: { cbBTC: bad } }))).toMatch(/positive number/);
    }
    expect(validateArmInput(arm({ multipliers: { cbBTC: 0.001 } }))).toMatch(/between 0.01 and 10/);
    expect(validateArmInput(arm({ multipliers: { cbBTC: 11 } }))).toMatch(/between 0.01 and 10/);
  });

  it("requires a scenario key and a label for the marker to name", () => {
    expect(validateArmInput(arm({ scenario: "  " }))).toMatch(/scenario/);
    expect(validateArmInput(arm({ label: "" }))).toMatch(/label/);
  });
});

describe("SimulationCache", () => {
  it("serves the armed scenario and refreshes past its TTL", async () => {
    let now = T0;
    const currentRow = vi.fn(async () => row());
    const cache = new SimulationCache({ currentRow }, () => now, 10_000);

    // First read is a miss: the refresh is fired but not awaited, so nothing is
    // served until it lands. Scoring is never blocked on the database.
    expect(cache.current()).toBeNull();
    await cache.refresh();
    expect(cache.current()?.label).toBe("Crash");

    const calls = currentRow.mock.calls.length;
    now += 5_000;
    cache.current();
    expect(currentRow.mock.calls.length).toBe(calls); // inside the TTL
    now += 6_000;
    cache.current();
    expect(currentRow.mock.calls.length).toBeGreaterThan(calls);
  });

  it("expires a cached scenario even with the store unreachable", async () => {
    // THE failure direction that matters. A database outage may let a scenario
    // run to its natural end; it must never extend one past its window.
    let now = T0;
    let fail = false;
    const cache = new SimulationCache(
      {
        currentRow: async () => {
          if (fail) throw new Error("supabase down");
          return row();
        },
      },
      () => now,
      10_000,
      () => {},
    );
    await cache.refresh();
    expect(cache.current()).not.toBeNull();

    fail = true;
    now = T0 + 59 * 60_000;
    expect(cache.current()).not.toBeNull(); // still inside the window
    now = T0 + 60 * 60_000;
    expect(cache.current()).toBeNull(); // window closed, nobody did anything
    now = T0 + 10 * 60 * 60_000;
    expect(cache.current()).toBeNull();
  });

  it("keeps the previous value when a refresh throws, rather than inventing one", async () => {
    let now = T0;
    let fail = false;
    const cache = new SimulationCache(
      {
        currentRow: async () => {
          if (fail) throw new Error("supabase down");
          return row();
        },
      },
      () => now,
      10_000,
      () => {},
    );
    await cache.refresh();
    fail = true;
    now += 20_000;
    await cache.refresh();
    expect(cache.current()?.id).toBe(row().id);
  });

  it("reports nothing armed when the store says so", async () => {
    const cache = new SimulationCache({ currentRow: async () => null }, () => T0);
    await cache.refresh();
    expect(cache.current()).toBeNull();
  });

  it("treats a cleared row as no scenario the moment it is adopted", async () => {
    const cache = new SimulationCache({ currentRow: async () => null }, () => T0);
    cache.set(rowToSimulation(row()));
    expect(cache.current()).not.toBeNull();
    cache.set(null);
    expect(cache.current()).toBeNull();
  });

  it("does not stack concurrent refreshes", async () => {
    const currentRow = vi.fn(async () => row());
    const cache = new SimulationCache({ currentRow }, () => T0, 0);
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(currentRow).toHaveBeenCalledTimes(1);
  });
});

describe("simulationWire", () => {
  it("sends the browser what the marker needs and nothing else", () => {
    const wire = simulationWire(rowToSimulation(row()));
    expect(wire).toEqual({
      id: row().id,
      scenario: "crash",
      label: "Crash",
      multipliers: { cbBTC: 0.6 },
      startedAt: T0,
      expiresAt: T0 + 60 * 60_000,
    });
    // The operator's identity is NOT on the wire: it is an audit record, and
    // the marker has no use for it.
    expect(JSON.stringify(wire)).not.toContain("admin.panik");
  });
});
