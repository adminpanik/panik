import { clamp } from "./math";
import { COMPOSITE_WEIGHTS, CRASH_REGIME, LIQUIDATION_PROXIMITY_FLOORS } from "./params";
import { scoreAssetRisk } from "./subscores/assetRisk";
import { scorePositionHealth } from "./subscores/positionHealth";
import { scoreProtocolSafety } from "./subscores/protocolSafety";
import { scoreSystemicRisk } from "./subscores/systemicRisk";
import type {
  Band,
  DegradableSubScores,
  DegradedScoreResult,
  DegradedScoringInput,
  PositionHealthInput,
  ScoreResult,
  ScoringInput,
  SubScores,
} from "./types";

/** Band mapping — arch §Bands. */
export function bandFor(score: number): Band {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "ELEVATED";
  return "LOW";
}

/**
 * Summation order of the composite. It is part of the arithmetic (floating
 * point addition is not associative) and of `dominantDriver`'s tie-breaking,
 * so it is fixed here rather than left to object-key iteration.
 */
const COMPOSITE_ORDER = [
  "positionHealth",
  "assetRisk",
  "protocolSafety",
  "systemicRisk",
] as const;

/**
 * Weighted composite over the sub-scores that were actually MEASURED.
 *
 * A null term is dropped and the surviving weights are renormalised, so the
 * score answers "how risky is the part we can see" instead of imputing a value
 * for the part we cannot: 0 would read as a calm market and 100 as a crashing
 * one, and the engine knows neither. Position health (0.4) and protocol safety
 * (0.2) need no I/O, so the divisor can never approach zero.
 *
 * With every term present the division is skipped entirely — the weights sum to
 * 1.0000000000000002 in binary floating point, so dividing by it would shift
 * the composite by an ulp and flip Math.round at exact .5 boundaries.
 */
function composite(subScores: DegradableSubScores): number {
  let weighted = 0;
  let availableWeight = 0;
  let missing = false;
  for (const key of COMPOSITE_ORDER) {
    const sub = subScores[key];
    if (sub === null) {
      missing = true;
      continue;
    }
    weighted += COMPOSITE_WEIGHTS[key] * sub;
    availableWeight += COMPOSITE_WEIGHTS[key];
  }
  return missing ? weighted / availableWeight : weighted;
}

/** Composite + the HF escalations, shared by both entry points below. */
function totalAndBand(
  positionHealth: PositionHealthInput,
  subScores: DegradableSubScores,
  opts: { crashRegime?: boolean },
): { total: number; band: Band } {
  let total = Math.round(clamp(composite(subScores), 0, 100));

  // Liquidation-proximity floor — see params.ts for the calibration evidence.
  // A position near its liquidation point is dangerous no matter how calm the
  // market inputs look (the Mar-2023 USDC depeg positions scored ~40 without this).
  const hf = positionHealth.healthFactor;
  if (hf !== null) {
    for (const floor of LIQUIDATION_PROXIMITY_FLOORS) {
      if (hf <= floor.hfAtOrBelow) {
        total = Math.max(total, floor.minScore);
        break;
      }
    }

    // Crash-regime escalation — see params.ts. In a saturated sell-off, a
    // position further from liquidation than the static floor is still "exit
    // now": HF erodes in hours mid-crash. Gated on high asset risk so it stays
    // silent in calm markets and stablecoin depegs.
    // (An acute short-horizon drawdown trigger was tested as v2 and REJECTED —
    // the static floor already catches fast crashes under dense monitoring, and
    // the trigger added far more false alarms than catches. See BACKTEST_RESULTS.)
    // An unmeasured asset risk cannot open this gate: escalating to CRITICAL on
    // a term the engine did not read would be asserting a crash it never saw.
    if (
      opts.crashRegime !== false &&
      subScores.assetRisk !== null &&
      subScores.assetRisk >= CRASH_REGIME.assetRiskAtOrAbove &&
      hf <= CRASH_REGIME.hfAtOrBelow
    ) {
      total = Math.max(total, CRASH_REGIME.minScore);
    }
    // (A stablecoin peg-deviation escalation was tested as well and REJECTED:
    // a depeg reprices the collateral via the oracle, so HF already drops and the
    // static floor catches it — the peg term was redundant and only added false
    // alarms (recall 97%→97%, false-alarm 27%→38%). See BACKTEST_RESULTS.)
  }

  return { total, band: bandFor(total) };
}

/**
 * Composite Panik Risk Score — arch §Composite Score.
 * Pure function: same input, same output, no I/O. Both scoring modes
 * (prospective/Compass, active/Watch) call this with adapter-built input.
 */
export function computeScore(
  input: ScoringInput,
  opts: { crashRegime?: boolean } = {},
): ScoreResult {
  const subScores: SubScores = {
    positionHealth: scorePositionHealth(input.positionHealth),
    assetRisk: scoreAssetRisk(input.assetRisk),
    protocolSafety: scoreProtocolSafety(input.protocol),
    systemicRisk: scoreSystemicRisk(input.systemicRisk),
  };
  return { ...totalAndBand(input.positionHealth, subScores, opts), subScores };
}

/**
 * `computeScore` for callers whose market-context providers can fail per leg
 * (active mode): a null input yields a null sub-score and drops that term from
 * the composite rather than aborting the read. Identical to `computeScore`
 * when nothing is missing — the shared helper above is the only place the
 * weights, floors and crash gate live, so the two can never drift.
 */
export function computeScoreFromAvailable(
  input: DegradedScoringInput,
  opts: { crashRegime?: boolean } = {},
): DegradedScoreResult {
  const subScores: DegradableSubScores = {
    positionHealth: scorePositionHealth(input.positionHealth),
    assetRisk: input.assetRisk === null ? null : scoreAssetRisk(input.assetRisk),
    protocolSafety: scoreProtocolSafety(input.protocol),
    systemicRisk:
      input.systemicRisk === null ? null : scoreSystemicRisk(input.systemicRisk),
  };
  return { ...totalAndBand(input.positionHealth, subScores, opts), subScores };
}
