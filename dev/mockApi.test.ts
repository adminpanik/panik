/**
 * `/api/history` must answer per wallet, the same way `/api/positions` does.
 *
 * It used to return the seeded wallet's fixture snapshots for ANY wallet,
 * including one that has never held a position. That made the Portfolio tab's
 * "Aggregate PANIK risk score" card draw a full 30-day curve and a trend
 * caption ("up 17 over 30d") next to a score the same render correctly called
 * "Not measured" for an unbound address, which is exactly the "state a fact
 * the code does not know" failure docs/DESIGN_SYSTEM.md exists to stop.
 */

import { describe, expect, it } from "vitest";
import { handle } from "./mockApi";
import { MOCK_WALLET } from "./fixtures";

const urlFor = (wallet: string) => new URL(`http://localhost/api/history?wallet=${wallet}`);

describe("/api/history", () => {
  it("answers the seeded wallet with its real alert and snapshot history", () => {
    const body = handle(urlFor(MOCK_WALLET)) as { alerts: unknown[]; snapshots: unknown[] };
    expect(body.snapshots.length).toBeGreaterThan(0);
    expect(body.alerts.length).toBeGreaterThan(0);
  });

  it("answers an unseeded wallet with no history, never the seeded wallet's", () => {
    const unknown = "0x0000000000000000000000000000000000000001";
    const body = handle(urlFor(unknown)) as { alerts: unknown[]; snapshots: unknown[] };
    expect(body.snapshots).toEqual([]);
    expect(body.alerts).toEqual([]);
  });

  it("is case-insensitive on the seeded wallet, like /api/positions", () => {
    const body = handle(urlFor(MOCK_WALLET.toUpperCase())) as { snapshots: unknown[] };
    expect(body.snapshots.length).toBeGreaterThan(0);
  });
});
