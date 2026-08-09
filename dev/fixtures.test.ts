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
import type {
  Band,
  DegradableSubScores,
  HistorySnapshot,
  LiveWalletPosition,
} from "../src/panik-core/lib/live";

// Mirrors of packages/scoring — deliberately restated so a fixture edit is
// checked against the published contract, not against itself.
const bandFor = (s: number): Band =>
  s >= 75 ? "CRITICAL" : s >= 50 ? "HIGH" : s >= 25 ? "ELEVATED" : "LOW";

const WEIGHTS = { positionHealth: 0.4, assetRisk: 0.25, protocolSafety: 0.2, systemicRisk: 0.15 };

/**
 * computeScore.ts: composite, then lifted by the liquidation-proximity floors.
 *
 * A null sub-score is DROPPED and the surviving weights renormalise, exactly as
 * `composite()` does. Treating it as 0 instead is the bug this whole path exists
 * to prevent, so the mirror has to reproduce the real rule and not a convenient
 * one. The undegraded branch skips the division for the same reason the engine
 * does: the four weights sum to 1.0000000000000002 in binary floating point.
 */
function expectedTotal(sub: DegradableSubScores, hf: number | null): number {
  const terms = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((k) => ({
    weight: WEIGHTS[k],
    value: sub[k],
  }));
  const measured = terms.filter((t) => t.value !== null);
  const sum = measured.reduce((a, t) => a + t.weight * (t.value as number), 0);
  const availableWeight = measured.reduce((a, t) => a + t.weight, 0);
  const weighted = Math.round(
    measured.length === terms.length ? sum : sum / availableWeight,
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

  // The engine cannot emit two legs on one protocol for one wallet:
  // scripts/api-server.ts registers exactly ONE reader per protocol, and
  // ActiveAdapter.scoreWallet (packages/scoring/src/adapters/active.ts) returns
  // at most one ActiveReading per reader. So (wallet, protocol) is the natural
  // key — and it is literally the React key LivePositions.tsx renders rows with
  // (`${p.wallet}:${p.protocol}`). A duplicate here is impossible data that
  // shows up in the browser as "Encountered two children with the same key"
  // and a dropped row, which is exactly how it was found. Guard it.
  it("emits at most one leg per (wallet, protocol) — the LivePositions row key", () => {
    const keys = MOCK_POSITIONS.map((p) => `${p.wallet}:${p.protocol}`);
    expect(new Set(keys).size).toBe(keys.length);
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

  it("has a position whose market context could not be read", () => {
    const degraded = MOCK_POSITIONS.filter((p) => p.marketContextUnavailable);
    expect(degraded).toHaveLength(1);
    const p = degraded[0]!;
    // At least one market-context term is null, and null is the ONLY
    // representation of "not measured": a 0 here is a real sub-score meaning
    // "as calm as this term gets", which is what made a dead feed read as good
    // news. The two terms that need no I/O can never be null.
    expect(p.subScores.assetRisk === null || p.subScores.systemicRisk === null).toBe(true);
    expect(p.subScores.positionHealth).not.toBeNull();
    expect(p.subScores.protocolSafety).not.toBeNull();
    // The composite is renormalised over the surviving weights, so the headline
    // number stays real and printable — only the sub-score is unknown.
    expect(p.total).toBeGreaterThan(0);
    expect(p.band).toBe(bandFor(p.total));
  });

  it("degrades market context and USD pricing on different legs", () => {
    // The two failures are independent in the engine (one is a provider
    // lookup, the other a price feed), so the fixtures must exercise them
    // apart. Merged onto one leg, no surface ever renders either alone.
    const marketOnly = MOCK_POSITIONS.filter(
      (p) => p.marketContextUnavailable && !p.usdValuesUnavailable,
    );
    const usdOnly = MOCK_POSITIONS.filter(
      (p) => p.usdValuesUnavailable && !p.marketContextUnavailable,
    );
    expect(marketOnly).toHaveLength(1);
    expect(usdOnly).toHaveLength(1);
  });

  it("keeps every sub-score of an undegraded leg a number", () => {
    for (const p of MOCK_POSITIONS.filter((x) => !x.marketContextUnavailable)) {
      expect(p.subScores.assetRisk).not.toBeNull();
      expect(p.subScores.systemicRisk).not.toBeNull();
    }
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

  it("offers a collateral-funded route the engine could really size", () => {
    const rec = MOCK_ADVISOR_RECOMMENDATIONS.find((r) => r.collateralFundedAlternative);
    expect(rec, "no leg carries a collateral-funded alternative").toBeDefined();
    const wallet = rec?.repayPlan;
    const collateral = rec?.collateralFundedAlternative;
    // Both routes, never one instead of the other: the engine cannot see a
    // wallet balance, so it emits each and the client picks.
    expect(wallet?.mode).toBe("wallet_funded");
    expect(collateral?.mode).toBe("collateral_funded");
    expect(rec?.triggers).toContain("repay:collateral_funded_available");
    // Selling collateral shrinks both sides of HF, so it always repays more.
    expect(collateral?.repayUsd).toBeGreaterThan(wallet?.repayUsd ?? 0);
    expect(collateral?.targetHf).toBe(wallet?.targetHf);
    // The costs are what makes this route a choice rather than a free lunch,
    // and the wallet-funded plan pays none of them - so it carries none.
    expect(wallet?.costs).toBeUndefined();
    expect(collateral?.costs?.flashFeeBps).toBeGreaterThanOrEqual(0);
    expect(collateral?.costs?.gasUnits).toBeGreaterThan(0);
  });
});

/**
 * AppDemo.tsx `riskHistory`: bucket snapshots by day, weight each protocol by
 * its snapshot collateral, round. This is the number the "Risk index history"
 * card prints in its header and ends its sparkline on.
 *
 * Restated here rather than imported, for the same reason the band thresholds
 * are: a fixture checked against a helper it shares with the code under test
 * only proves the two agree with each other.
 */
function chartPoint(daySnapshots: readonly HistorySnapshot[]): number {
  let weighted = 0;
  let weight = 0;
  for (const s of daySnapshots) {
    const w = Math.max(1, Number(s.collateral_usd ?? 0));
    weighted += s.total * w;
    weight += w;
  }
  return Math.round(weighted / weight);
}

/**
 * AppDemo.tsx `liveMacro.aggregate`: the "Aggregate risk index" stat card.
 * A leg with no USD carries no dollar weight — its score is exact, its size is
 * not, and weighting by a number we do not have is how a $0 gets invented.
 */
function aggregateIndex(positions: readonly LiveWalletPosition[]): number {
  const usd = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : v);
  const capital = positions.reduce((a, p) => a + usd(p.collateralValueUsd), 0);
  if (capital <= 0) return 0;
  return Math.round(positions.reduce((a, p) => a + p.total * usd(p.collateralValueUsd), 0) / capital);
}

describe("dev:mock fixtures — history", () => {
  const { alerts, snapshots } = mockHistory(Date.UTC(2026, 7, 7));
  const lastDay = snapshots.at(-1)!.created_at;
  const latest = snapshots.filter((s) => s.created_at === lastDay);

  it("draws a real sparkline: 30 distinct days", () => {
    expect(new Set(snapshots.map((s) => s.created_at.slice(0, 10))).size).toBe(30);
    expect(snapshots.length).toBeGreaterThanOrEqual(30);
  });

  it("keeps every snapshot's total band-able and its dollars honest", () => {
    for (const s of snapshots) {
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.total).toBeLessThanOrEqual(100);
      // Present or absent, never a fabricated zero: "$0" is the reading a
      // six-figure debt must never be reported as. Absent is spelled null.
      for (const v of [s.collateral_usd, s.borrow_usd]) {
        if (v === null) continue;
        expect(Number.isFinite(Number(v))).toBe(true);
        expect(Number(v)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("writes null, not zero, for the degraded leg's dollars", () => {
    const degraded = MOCK_POSITIONS.find((p) => p.usdValuesUnavailable)!;
    const rows = snapshots.filter((s) => s.protocol === degraded.protocol);
    expect(rows).toHaveLength(30);
    for (const s of rows) {
      expect(s.collateral_usd).toBeNull();
      expect(s.borrow_usd).toBeNull();
      // The ratio survives what the pricing does not.
      expect(Number(s.health_factor)).toBeGreaterThan(1);
    }
  });

  /**
   * The chart and the stat card are weighted averages over what is supposed to
   * be the same set. While this fixture covered only two of the four legs they
   * silently were not, and the Portfolio showed 57 in one card and 66 in the
   * next. Covering every protocol is the precondition for the assertion below.
   */
  it("covers exactly the protocols the positions list holds", () => {
    expect(new Set(snapshots.map((s) => s.protocol))).toEqual(
      new Set(MOCK_POSITIONS.map((p) => p.protocol)),
    );
    expect(latest).toHaveLength(MOCK_POSITIONS.length);
  });

  it("ends on today's live scores, so the chart meets the dashboard", () => {
    for (const s of latest) {
      expect(s.total).toBe(MOCK_POSITIONS.find((p) => p.protocol === s.protocol)?.total);
    }
  });

  it("ends on today's live collateral, so the two are weighted alike", () => {
    for (const s of latest) {
      const live = MOCK_POSITIONS.find((p) => p.protocol === s.protocol)!;
      expect(s.collateral_usd === null ? null : Number(s.collateral_usd)).toBe(
        live.collateralValueUsd,
      );
    }
  });

  /**
   * THE guard. Everything above is a precondition for it: two cards side by
   * side on the Portfolio must not print two different values for one metric.
   * Per-protocol equality alone does not catch that — the old version of this
   * test passed while the cards read 57 and 66 — because a chart weighted over
   * a SUBSET can agree on every leg it contains and still land somewhere else.
   */
  it("ends on the same number the Aggregate risk index card shows", () => {
    expect(chartPoint(latest)).toBe(aggregateIndex(MOCK_POSITIONS));
  });

  it("has a handful of alerts whose bands follow their scores", () => {
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    for (const a of alerts) expect(a.band).toBe(bandFor(a.score));
  });
});
