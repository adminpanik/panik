import { annualizedVol, clamp, maxDrawdown, pearsonCorr } from "../math";
import { ASSET_RISK_WEIGHTS, VOL_CEIL } from "../params";
import type { AssetRiskInput } from "../types";

/**
 * 90-day drawdown, 0–1. Prefers the ordered series (true peak-to-trough max
 * drawdown); falls back to the deprecated extremes, which are order-blind and
 * therefore only an upper bound — a pure rally reads as a full drawdown there.
 */
function drawdown90d(input: AssetRiskInput): number {
  if (input.prices90d && input.prices90d.length > 0) {
    return maxDrawdown(input.prices90d);
  }
  const max = input.maxPrice90d ?? 0;
  const min = input.minPrice90d ?? 0;
  return max > 0 ? (max - min) / max : 0;
}

/** S_asset_risk (25% of composite) — arch §Sub-Scores 2. */
export function scoreAssetRisk(input: AssetRiskInput): number {
  const vol30d = annualizedVol(input.dailyReturns30d);
  const drawdown = drawdown90d(input);
  const corrBtc = pearsonCorr(input.dailyReturns30d, input.btcReturns30d);

  const volScore = clamp((vol30d / VOL_CEIL) * 100, 0, 100);
  const drawdownScore = clamp(drawdown * 100, 0, 100);
  const corrPenalty = clamp(corrBtc, 0, 1) * 100;

  return clamp(
    ASSET_RISK_WEIGHTS.vol * volScore +
      ASSET_RISK_WEIGHTS.drawdown * drawdownScore +
      ASSET_RISK_WEIGHTS.corr * corrPenalty,
    0,
    100,
  );
}
