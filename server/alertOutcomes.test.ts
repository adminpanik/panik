/**
 * Observed alert quality (7.3).
 *
 * The arithmetic is three counters and a division, and it is still worth a test
 * for one reason: the denominator and the null. Rating false alarms against
 * every alert instead of every DECIDED alert flatters the number by however many
 * positions have not moved yet, and reporting "0%" from zero evidence is the
 * unknown-rendered-as-zero bug in the one place nobody would question it.
 */

import { describe, expect, it } from "vitest";
import { fetchAlertOutcomes, toOutcomeStats } from "./alertOutcomes";

const ALICE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    query: (async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    }) as never,
  };
}

describe("alertOutcomes", () => {
  it("rates false alarms against DECIDED alerts, not against every alert", () => {
    const stats = toOutcomeStats({
      alerts: 10,
      escalated: 3,
      false_alarms: 1,
      pending: 6,
      first_alert_at: "2026-08-01T00:00:00.000Z",
      last_alert_at: "2026-08-23T00:00:00.000Z",
    });
    expect(stats.decided).toBe(4);
    expect(stats.falseAlarmRate).toBe(0.25);
    expect(stats.pending).toBe(6);
    expect(stats.firstAlertAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("reports an unknown rate as null, never as zero", () => {
    const stats = toOutcomeStats({ alerts: 4, escalated: 0, false_alarms: 0, pending: 4 });
    expect(stats.falseAlarmRate).toBeNull();
    expect(stats.firstAlertAt).toBeNull();
  });

  it("counts one owner or everybody, through the same statement", async () => {
    const db = fakeDb([{ alerts: 2, escalated: 1, false_alarms: 1, pending: 0 }]);
    const mine = await fetchAlertOutcomes(db, ALICE.toUpperCase());
    const all = await fetchAlertOutcomes(db, null);
    expect(db.calls[0].values).toEqual([ALICE]);
    expect(db.calls[1].values).toEqual([null]);
    // One statement for both, so the per-user figure and the product-wide one
    // can never be computed two different ways.
    expect(db.calls[0].sql).toBe(db.calls[1].sql);
    expect(mine.falseAlarmRate).toBe(0.5);
    expect(all.falseAlarmRate).toBe(0.5);
  });
});
