import { describe, expect, it } from "vitest";
import { ASSET_RISK_WEIGHTS } from "../src/params";
import { scoreAssetRisk } from "../src/subscores/assetRisk";
import { scorePositionHealth } from "../src/subscores/positionHealth";
import { scoreProtocolSafety } from "../src/subscores/protocolSafety";
import { scoreSystemicRisk } from "../src/subscores/systemicRisk";
import { bandFor } from "../src/computeScore";

// ── GOLDEN VALUES from arch §Sub-Scores 3 ────────────────────────────────
describe("S_protocol_safety (static config — arch step 4)", () => {
  it("Aave V3 ≈ 10 (exact 9.75; arch's '≈11' comment is loose rounding)", () => {
    expect(scoreProtocolSafety("aave_v3")).toBeCloseTo(9.75, 2);
    expect(bandFor(scoreProtocolSafety("aave_v3"))).toBe("LOW");
  });
  it("Moonwell = 46 exactly (arch '≈46')", () => {
    expect(scoreProtocolSafety("moonwell")).toBeCloseTo(46, 2);
    expect(bandFor(scoreProtocolSafety("moonwell"))).toBe("ELEVATED");
  });
  it("Moonwell scores meaningfully riskier than Aave (the demo's credibility moment)", () => {
    expect(scoreProtocolSafety("moonwell")).toBeGreaterThan(
      scoreProtocolSafety("aave_v3") + 30,
    );
  });
  it("Morpho = 20.5, Compound V3 = 18.85 (added 2026-06-13, pending Q3 verification)", () => {
    expect(scoreProtocolSafety("morpho")).toBeCloseTo(20.5, 2);
    expect(scoreProtocolSafety("compound_v3")).toBeCloseTo(18.85, 2);
  });
  it("protocol risk ordering: Aave < Compound V3 < Morpho < Moonwell", () => {
    expect(scoreProtocolSafety("aave_v3")).toBeLessThan(scoreProtocolSafety("compound_v3"));
    expect(scoreProtocolSafety("compound_v3")).toBeLessThan(scoreProtocolSafety("morpho"));
    expect(scoreProtocolSafety("morpho")).toBeLessThan(scoreProtocolSafety("moonwell"));
  });
});

// ── arch step 2: mock HF values 1.0 / 1.5 / 2.0+ ─────────────────────────
describe("S_position_health (HF_CEIL = 2.0)", () => {
  const ltvZero = { currentLtv: 0, maxLtv: 0.8 };

  it("HF 1.0 → HF_score 100 (liquidation boundary)", () => {
    // 0.7 × 100 + 0.3 × 0 = 70
    expect(scorePositionHealth({ healthFactor: 1.0, ...ltvZero })).toBe(70);
  });
  it("HF 1.5 → HF_score 50", () => {
    expect(scorePositionHealth({ healthFactor: 1.5, ...ltvZero })).toBe(35);
  });
  it("HF 2.0+ → HF_score 0", () => {
    expect(scorePositionHealth({ healthFactor: 2.0, ...ltvZero })).toBe(0);
    expect(scorePositionHealth({ healthFactor: 3.5, ...ltvZero })).toBe(0);
  });
  it("HF below 1.0 clamps to 100 (already liquidatable)", () => {
    expect(scorePositionHealth({ healthFactor: 0.85, ...ltvZero })).toBe(70);
  });
  it("LTV component mixes at 30%", () => {
    // HF 1.5 → 50 ⇒ 35; LTV 0.62/0.82 → 75.6 ⇒ +22.68 ⇒ 57.68
    expect(
      scorePositionHealth({ healthFactor: 1.5, currentLtv: 0.62, maxLtv: 0.82 }),
    ).toBeCloseTo(57.68, 1);
  });
  it("zero debt (null HF — the Aave uint256.max case) → 0", () => {
    expect(
      scorePositionHealth({ healthFactor: null, currentLtv: 0, maxLtv: 0.8 }),
    ).toBe(0);
  });
});

describe("S_asset_risk", () => {
  it("stablecoin profile (flat prices, no vol) → 0", () => {
    expect(
      scoreAssetRisk({
        dailyReturns30d: Array(30).fill(0),
        btcReturns30d: Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.01 : -0.01)),
        maxPrice90d: 1,
        minPrice90d: 1,
      }),
    ).toBe(0);
  });
  it("volatile, BTC-correlated, drawn-down asset scores high", () => {
    const volatile = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.06 : -0.06));
    const score = scoreAssetRisk({
      dailyReturns30d: volatile,
      btcReturns30d: volatile, // corr = 1
      maxPrice90d: 100,
      minPrice90d: 40, // 60% drawdown
    });
    // vol ≈ 116% annualised → volScore 100; dd 60; corr 100
    // 0.5×100 + 0.35×60 + 0.15×100 = 86
    expect(score).toBeCloseTo(86, 0);
  });
  it("uncorrelated asset takes no corr penalty (negative corr clamps to 0)", () => {
    const a = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.02 : -0.02));
    const b = a.map((x) => -x);
    const withPenalty = scoreAssetRisk({
      dailyReturns30d: a, btcReturns30d: a, maxPrice90d: 1, minPrice90d: 1,
    });
    const withoutPenalty = scoreAssetRisk({
      dailyReturns30d: a, btcReturns30d: b, maxPrice90d: 1, minPrice90d: 1,
    });
    expect(withPenalty - withoutPenalty).toBeCloseTo(15, 5);
  });

  // The drawdown term is 35% of S_asset_risk and gates CRASH_REGIME at 60,
  // so a rally must never be priced as a crash.
  describe("drawdown term uses the ordered series", () => {
    const flat = Array(30).fill(0);
    const at = (prices90d: number[]) =>
      scoreAssetRisk({ dailyReturns30d: flat, btcReturns30d: flat, prices90d });

    const cases: [string, number[], number][] = [
      ["monotonic 2x rally → no drawdown", [100, 140, 180, 200], 0],
      ["50% crash → full 50 points of drawdown", [200, 150, 100], 0.5],
      ["crash then recovery → peak-to-trough, not endpoints", [200, 100, 195], 0.5],
      ["rally then 25% fade → measured from the later peak", [100, 400, 300], 0.25],
    ];

    it.each(cases)("%s", (_label, prices90d, drawdown) => {
      // Flat returns → vol 0 and corr 0, so the score is the drawdown term alone.
      expect(at(prices90d)).toBeCloseTo(ASSET_RISK_WEIGHTS.drawdown * drawdown * 100, 6);
    });

    it("scores a rally far below a crash of the same amplitude", () => {
      const rally = [100, 120, 150, 180, 200];
      const crash = [...rally].reverse();
      expect(at(rally)).toBe(0);
      expect(at(crash)).toBeGreaterThan(at(rally));
    });

    it("falls back to the order-blind extremes only when the series is absent", () => {
      const legacy = scoreAssetRisk({
        dailyReturns30d: flat,
        btcReturns30d: flat,
        maxPrice90d: 200,
        minPrice90d: 100,
      });
      expect(legacy).toBeCloseTo(ASSET_RISK_WEIGHTS.drawdown * 50, 6);
      // Series wins when both are supplied — the rally is not a 50% drawdown.
      expect(
        scoreAssetRisk({
          dailyReturns30d: flat,
          btcReturns30d: flat,
          prices90d: [100, 150, 200],
          maxPrice90d: 200,
          minPrice90d: 100,
        }),
      ).toBe(0);
    });
  });
});

// ── arch step 5: verify near-zero on stable data ─────────────────────────
describe("S_systemic_risk", () => {
  it("stable TVL → 0", () => {
    expect(
      scoreSystemicRisk({
        sectorTvlNow: 50e9, sectorTvl7dAgo: 50e9,
        protocolTvlNow: 2e9, protocolTvl7dAgo: 2e9,
      }),
    ).toBe(0);
  });
  it("growing TVL → 0 (gains are not stress)", () => {
    expect(
      scoreSystemicRisk({
        sectorTvlNow: 55e9, sectorTvl7dAgo: 50e9,
        protocolTvlNow: 2.2e9, protocolTvl7dAgo: 2e9,
      }),
    ).toBe(0);
  });
  it("−20% sector drop saturates sector term → 60", () => {
    expect(
      scoreSystemicRisk({
        sectorTvlNow: 40e9, sectorTvl7dAgo: 50e9,
        protocolTvlNow: 2e9, protocolTvl7dAgo: 2e9,
      }),
    ).toBe(60);
  });
  it("−15% protocol flight saturates protocol term → 40", () => {
    expect(
      scoreSystemicRisk({
        sectorTvlNow: 50e9, sectorTvl7dAgo: 50e9,
        protocolTvlNow: 1.7e9, protocolTvl7dAgo: 2e9,
      }),
    ).toBe(40);
  });
  it("FTX-style event (both floors breached) → 100", () => {
    expect(
      scoreSystemicRisk({
        sectorTvlNow: 30e9, sectorTvl7dAgo: 50e9,
        protocolTvlNow: 1e9, protocolTvl7dAgo: 2e9,
      }),
    ).toBe(100);
  });
});
