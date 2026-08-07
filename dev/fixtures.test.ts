/**
 * Invariants for the dev:mock fixtures. These are not tests of the app — they
 * stop the fixtures from drifting into states the real engine can never emit,
 * because a mock that lies is worse than no mock: you tune the UI against
 * numbers production will never send.
 */

import { describe, expect, it } from "vitest";
import {
  MOCK_ADVISOR_RECOMMENDATIONS,
  MOCK_COMPASS_FIXTURES,
  MOCK_POSITIONS,
  MOCK_WALLET,
  mockAdvisor,
  mockHistory,
} from "./fixtures";
import type { Band, SubScores } from "../src/panik-core/lib/live";

// Mirrors of packages/scoring — deliberately restated so a fixture edit is
// checked against the published contract, not against itself.
const bandFor = (s: number): Band =>
  s >= 75 ? "CRITICAL" : s >= 50 ? "HIGH" : s >= 25 ? "ELEVATED" : "LOW";

const WEIGHTS = { positionHealth: 0.4, assetRisk: 0.25, protocolSafety: 0.2, systemicRisk: 0.15 };

/** computeScore.ts: composite, then lifted by the liquidation-proximity floors. */
function expectedTotal(sub: SubScores, hf: number | null): number {
  const weighted = Math.round(
    WEIGHTS.positionHealth * sub.positionHealth +
      WEIGHTS.assetRisk * sub.assetRisk +
      WEIGHTS.protocolSafety * sub.protocolSafety +
      WEIGHTS.systemicRisk * sub.systemicRisk,
  );
  if (hf === null) return weighted;
  if (hf <= 1.1) return Math.max(weighted, 75);
  if (hf <= 1.25) return Math.max(weighted, 50);
  return weighted;
}

/** profile.ts, for the "moderate" profile every fixture is scored under. */
const statusFor = (score: number) =>
  score >= 50 ? "outside" : score >= 40 ? "approaching" : "within";

const scored = [
  ...MOCK_POSITIONS.map((p) => ({ what: `position ${p.protocol}/${p.scoredCollateralSymbol}`, ...p })),
  ...MOCK_COMPASS_FIXTURES.map((c) => ({ what: `compass ${c.id}`, ...c })),
];

describe("dev:mock fixtures — scoring consistency", () => {
  it.each(scored)("$what: band follows total", ({ total, band }) => {
    expect(band).toBe(bandFor(total));
  });

  it.each(scored)("$what: total is its sub-scores at the published weights", (f) => {
    expect(f.total).toBe(expectedTotal(f.subScores, f.healthFactor));
  });

  it.each(MOCK_POSITIONS.map((p) => ({ what: `${p.protocol}/${p.scoredCollateralSymbol}`, ...p })))(
    "$what: profileStatus follows total for the moderate profile",
    ({ total, profileStatus, riskProfile }) => {
      expect(riskProfile).toBe("moderate");
      expect(profileStatus).toBe(statusFor(total));
    },
  );
});

describe("dev:mock fixtures — render paths", () => {
  it("covers all four live protocols", () => {
    expect(new Set(MOCK_POSITIONS.map((p) => p.protocol))).toEqual(
      new Set(["aave_v3", "moonwell", "morpho", "compound_v3"]),
    );
    for (const p of MOCK_POSITIONS) expect(p.wallet).toBe(MOCK_WALLET);
  });

  it("has a no-debt position: null health factor, zero borrow", () => {
    const p = MOCK_POSITIONS.find((x) => x.healthFactor === null);
    expect(p).toBeDefined();
    expect(p?.borrowValueUsd).toBe(0);
    expect(p?.band).toBe("LOW");
  });

  it("has a HIGH position near the liquidation-proximity floor", () => {
    const p = MOCK_POSITIONS.find((x) => x.band === "HIGH");
    expect(p?.healthFactor).toBeCloseTo(1.2, 2);
  });

  it("has a CRITICAL position", () => {
    const p = MOCK_POSITIONS.find((x) => x.band === "CRITICAL");
    expect(p?.total).toBeGreaterThanOrEqual(75);
    expect(p?.healthFactor).toBeCloseTo(1.05, 2);
  });

  it("has an asset-risk-proxy position", () => {
    expect(MOCK_POSITIONS.some((p) => p.scoredCollateralSymbol.includes("(proxy)"))).toBe(true);
  });

  it("has a degraded-prices position with no USD on either side", () => {
    const degraded = MOCK_POSITIONS.filter((p) => p.usdValuesUnavailable);
    expect(degraded).toHaveLength(1);
    // Never $0 — an unpriced six-figure debt reported as zero is the exact bug
    // this flag exists to prevent.
    expect(degraded[0]?.collateralValueUsd).toBeNull();
    expect(degraded[0]?.borrowValueUsd).toBeNull();
    // The ratios are still exact, so the score and HF must be real numbers.
    expect(degraded[0]?.healthFactor).toBeGreaterThan(1);
    expect(degraded[0]?.total).toBeGreaterThan(0);
  });
});

describe("dev:mock fixtures — advisor invariants", () => {
  const report = mockAdvisor("moderate");

  it("never settles on an all-clear while a leg is unpriced", () => {
    expect(report.overall.action).not.toBe("HOLD");
    expect(report.overall.headline).not.toContain("All positions within your risk profile");
    expect(report.overall.headline).toContain("degraded");
  });

  it("advises every position leg", () => {
    expect(report.recommendations).toHaveLength(MOCK_POSITIONS.length);
  });

  it("treats the degraded leg as real debt, not as dust", () => {
    const rec = MOCK_ADVISOR_RECOMMENDATIONS.find((r) => r.numbers.usdValuesUnavailable);
    expect(rec).toBeDefined();
    expect(rec?.triggers).toContain("prices:degraded");
    expect(rec?.triggers).not.toContain("debt:none");
    // No dollar amount may be invented for a repay the engine cannot size.
    expect(rec?.repayPlan).toBeUndefined();
    expect(rec?.sections.position).not.toContain("$0");
  });

  it("mirrors each leg's numbers from its position fixture", () => {
    for (const rec of MOCK_ADVISOR_RECOMMENDATIONS) {
      const p = MOCK_POSITIONS.find(
        (x) => x.protocol === rec.protocol && x.total === rec.numbers.total,
      );
      expect(p, `no position for ${rec.protocol}/${rec.numbers.total}`).toBeDefined();
      expect(rec.numbers.band).toBe(p?.band);
      expect(rec.numbers.healthFactor).toBe(p?.healthFactor);
      expect(rec.numbers.borrowValueUsd).toBe(p?.borrowValueUsd);
    }
  });
});

describe("dev:mock fixtures — history", () => {
  const { alerts, snapshots } = mockHistory(Date.UTC(2026, 7, 7));

  it("draws a real sparkline: 30 distinct days", () => {
    expect(new Set(snapshots.map((s) => s.created_at.slice(0, 10))).size).toBe(30);
    expect(snapshots.length).toBeGreaterThanOrEqual(30);
  });

  it("keeps every snapshot's band-able total in range and its dollars parseable", () => {
    for (const s of snapshots) {
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.total).toBeLessThanOrEqual(100);
      expect(Number(s.collateral_usd)).toBeGreaterThan(0);
      expect(Number(s.borrow_usd)).toBeGreaterThan(0);
    }
  });

  it("ends on today's live scores, so the chart meets the dashboard", () => {
    const latest = snapshots.filter((s) => s.created_at === snapshots.at(-1)?.created_at);
    for (const s of latest) {
      expect(s.total).toBe(MOCK_POSITIONS.find((p) => p.protocol === s.protocol)?.total);
    }
  });

  it("has a handful of alerts whose bands follow their scores", () => {
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    for (const a of alerts) expect(a.band).toBe(bandFor(a.score));
  });
});
