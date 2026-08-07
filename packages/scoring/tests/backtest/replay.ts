/**
 * Per-position backtest replay for the June-2022 ETH crash.
 *
 * Reconstruction (exact for WETH-collateral / stablecoin-debt positions):
 *   debt is a stablecoin ≈ $1, and a position is liquidated when HF crosses 1.0,
 *   so at the first LiquidationCall HF ≈ 1.0. With quantities ~constant over the
 *   short pre-event window, HF(t) = WETH(t) / WETH(t_liq). No per-wallet balance
 *   accounting or interest indices needed — only the public price series.
 *
 * Conservative simplification: systemic-risk inputs are held flat (TVL signal
 * unavailable offline), so S_systemic_risk = 0. This *under*-warns, making the
 * lead-time numbers a floor, not a flattering ceiling.
 */

import { computeScore } from "../../src/computeScore";
import type { Band, ScoreResult, ScoringInput } from "../../src/types";
import {
  COHORT,
  DAILY_START,
  WBTC_DAILY,
  WETH_DAILY,
  WETH_HOURLY,
  WETH_HOURLY_START,
  WETH_LIQ_THRESHOLD,
  WETH_MAX_LTV,
  type CohortPosition,
} from "../fixtures/ethCrash2022";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function clampIdx(i: number, len: number): number {
  return Math.min(len - 1, Math.max(0, i));
}

function hourIdx(ts: number): number {
  return clampIdx(Math.floor((ts - WETH_HOURLY_START) / HOUR_MS), WETH_HOURLY.length);
}

function dayIdx(ts: number): number {
  return clampIdx(Math.floor((ts - DAILY_START) / DAY_MS), WETH_DAILY.length);
}

function returns(series: number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, from); i <= to; i++) {
    const prev = series[i - 1] as number;
    if (prev > 0) out.push((series[i] as number) / prev - 1);
  }
  return out;
}

/** AssetRiskInput from the real daily series as known at timestamp `ts`. */
function assetRiskAt(ts: number) {
  const d = dayIdx(ts);
  const from30 = Math.max(0, d - 30);
  const from90 = Math.max(0, d - 90);
  const weth90 = WETH_DAILY.slice(from90, d + 1);
  return {
    dailyReturns30d: returns(WETH_DAILY, from30, d),
    btcReturns30d: returns(WBTC_DAILY, from30, d),
    prices90d: weth90, // ordered → true peak-to-trough max drawdown
  };
}

/** Pre-event the off-chain TVL signal is unavailable → held flat (S_systemic = 0). */
const FLAT_SYSTEMIC = {
  sectorTvlNow: 100e9,
  sectorTvl7dAgo: 100e9,
  protocolTvlNow: 5e9,
  protocolTvl7dAgo: 5e9,
};

/** Reconstructed PANIK input for a position at a given hour. */
export function inputAt(anchorPrice: number, ts: number, hf: number): ScoringInput {
  return {
    protocol: "aave_v3",
    positionHealth: {
      healthFactor: hf,
      currentLtv: Math.min(WETH_LIQ_THRESHOLD / hf, 0.95),
      maxLtv: WETH_MAX_LTV,
    },
    assetRisk: assetRiskAt(ts),
    systemicRisk: FLAT_SYSTEMIC,
  };
}

export interface PositionResult {
  wallet: string;
  totalDebtUsd: number;
  anchorPrice: number;
  hfAtStart: number;
  bandAtStart: Band;
  leadCriticalH: number | null; // hours of CRITICAL warning before liquidation
  leadAlertH: number | null; // hours of HIGH-or-CRITICAL warning
  hfAtCritical: number | null; // HF when CRITICAL first fired (lower = later/closer)
}

const isAlert = (b: Band) => b === "HIGH" || b === "CRITICAL";

/** Replay one position over [anchor − hoursBefore, anchor]. */
export function replayPosition(
  pos: CohortPosition,
  scoreFn: (i: ScoringInput) => ScoreResult = computeScore,
  hoursBefore = 96,
): PositionResult {
  const anchorTs = Date.parse(pos.firstLiqIso);
  const aIdx = hourIdx(anchorTs);
  const anchorPrice = WETH_HOURLY[aIdx] as number;
  const startIdx = Math.max(0, aIdx - hoursBefore);

  let leadCriticalH: number | null = null;
  let leadAlertH: number | null = null;
  let hfAtCritical: number | null = null;
  let bandAtStart: Band = "LOW";
  let hfAtStart = 0;

  for (let h = startIdx; h <= aIdx; h++) {
    const ts = WETH_HOURLY_START + h * HOUR_MS;
    const hf = (WETH_HOURLY[h] as number) / anchorPrice;
    const r = scoreFn(inputAt(anchorPrice, ts, hf));
    if (h === startIdx) {
      bandAtStart = r.band;
      hfAtStart = hf;
    }
    if (leadAlertH === null && isAlert(r.band)) leadAlertH = aIdx - h;
    if (leadCriticalH === null && r.band === "CRITICAL") {
      leadCriticalH = aIdx - h;
      hfAtCritical = hf;
    }
  }

  return {
    wallet: pos.wallet,
    totalDebtUsd: pos.totalDebtUsd,
    anchorPrice,
    hfAtStart,
    bandAtStart,
    leadCriticalH,
    leadAlertH,
    hfAtCritical,
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Positions that began the replay window already this close to liquidation were
 * caught by the static floors regardless; the crash-regime change can only help
 * those that started healthier than the HIGH floor (HF > 1.25). */
export const HEALTHY_START_HF = 1.25;

export interface Scorecard {
  n: number;
  caughtCritical: number; // positions that ever hit CRITICAL before liquidation
  medianLeadCriticalH: number;
  medianLeadAlertH: number;
  medianHfAtCritical: number;
  /** Uncensored metric: median CRITICAL lead for positions that started healthy. */
  healthyStartN: number;
  medianLeadCriticalHealthyStartH: number;
  results: PositionResult[];
}

export function runBacktest(
  scoreFn: (i: ScoringInput) => ScoreResult = computeScore,
  hoursBefore = 96,
): Scorecard {
  const results = COHORT.map((p) => replayPosition(p, scoreFn, hoursBefore));
  const crit = results.filter((r) => r.leadCriticalH !== null);
  const healthyStart = results.filter(
    (r) => r.hfAtStart > HEALTHY_START_HF && r.leadCriticalH !== null,
  );
  return {
    n: results.length,
    caughtCritical: crit.length,
    medianLeadCriticalH: median(crit.map((r) => r.leadCriticalH as number)),
    medianLeadAlertH: median(
      results.filter((r) => r.leadAlertH !== null).map((r) => r.leadAlertH as number),
    ),
    medianHfAtCritical: median(crit.map((r) => r.hfAtCritical as number)),
    healthyStartN: healthyStart.length,
    medianLeadCriticalHealthyStartH: median(
      healthyStart.map((r) => r.leadCriticalH as number),
    ),
    results,
  };
}
