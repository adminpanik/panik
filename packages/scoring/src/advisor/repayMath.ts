/**
 * Partial-repay math for the Advisor (wallet-funded model, Phase 2).
 *
 * HF = L / D where L = liquidation-weighted collateral (Aave: totalCollateralBase
 * x currentLiquidationThreshold) and D = total debt. Repaying R dollars of debt
 * without touching collateral gives HF' = L / (D - R). Solving L/(D-R) = T:
 *
 *   R = D * (1 - HF_now / T)
 *
 * Only HF and borrowUsd are needed - both already on every ActiveScore leg -
 * so no per-asset liquidation-threshold decomposition is required.
 */

import type { RiskProfile } from "../types";

/**
 * Health-factor target per risk profile. Conservative matches HF_CEIL (the HF
 * at which the position-health sub-score reads zero risk).
 */
export const TARGET_HF: Record<RiskProfile, number> = {
  conservative: 2.0,
  moderate: 1.75,
  aggressive: 1.5,
};

/** Above this fraction of total debt, a REDUCE is promoted to a full EXIT. */
export const REDUCE_TO_EXIT_RATIO = 0.9;

/**
 * Dollars of debt to repay (collateral untouched) to lift HF to `targetHf`.
 * Returns 0 when already at/above target or when there is no debt.
 */
export function repayToTargetHf(
  borrowUsd: number,
  hfNow: number,
  targetHf: number,
): number {
  if (borrowUsd <= 0 || hfNow <= 0 || hfNow >= targetHf) return 0;
  const repay = borrowUsd * (1 - hfNow / targetHf);
  return Math.min(Math.max(repay, 0), borrowUsd);
}

/**
 * Phase 3 (flash-loan / collateral-funded) variant, documented for the
 * Deleverager: selling collateral to repay changes both numerator and
 * denominator - HF' = (L - LT_w*R) / (D - R) = T gives R = (T*D - L)/(T - LT_w),
 * with L = HF_now * D and LT_w the weighted liquidation threshold.
 * Unused in Phase 2 (wallet-funded repays leave collateral untouched).
 */
export function collateralFundedRepayToTargetHf(
  borrowUsd: number,
  hfNow: number,
  targetHf: number,
  weightedLiquidationThreshold: number,
): number {
  if (borrowUsd <= 0 || hfNow <= 0 || hfNow >= targetHf) return 0;
  if (targetHf <= weightedLiquidationThreshold) return 0; // unreachable target
  const l = hfNow * borrowUsd;
  const repay = (targetHf * borrowUsd - l) / (targetHf - weightedLiquidationThreshold);
  return Math.min(Math.max(repay, 0), borrowUsd);
}
