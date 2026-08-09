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
 * Fixed-point denominator behind `RepayPlan.repayFraction`.
 *
 * The repay is quoted to the user in dollars but EXECUTED in the debt asset's
 * own units, and converting dollars back into token units needs a price - a
 * dependency the execution path does not have and a rounding hazard it does not
 * want. So the engine also emits the repay as a fraction of the leg's own debt,
 * and the execution path multiplies that fraction by the live on-chain debt.
 *
 * The fraction is quantised to 1/1e6 so a consumer can recover an EXACT integer
 * numerator and stay in BigInt for the token math:
 *
 *   repayAmount = debt x repayFractionNumerator(f) / REPAY_FRACTION_SCALE
 *
 * 1e6 is the coarsest scale whose quantisation error stays under a dollar on a
 * $1M debt (1e-6 x $1M = $1), and it is small enough that `f * SCALE` is exact
 * in double precision for every fraction this module emits.
 */
export const REPAY_FRACTION_SCALE = 1_000_000;

/**
 * The repay as a fraction of THIS leg's debt, derived from the same two numbers
 * the dollar figure is: `repayUsd / borrowUsd`.
 *
 * One rounding rule, and it lives here beside the formula: round half up to
 * 1/REPAY_FRACTION_SCALE, then clamp into (0, 1]. A repay can never exceed the
 * debt, and a repay that rounds to nothing is not a repay - both ends are
 * pinned rather than allowed to escape as 1.0000004 or 0.
 *
 * Returns null when there is nothing to repay or no debt to repay it against.
 * Null, never 0: a caller multiplies this into an amount, and a 0 fraction
 * builds a silent no-op leg that looks like a successful reduce.
 */
export function repayFractionOfDebt(repayUsd: number, borrowUsd: number): number | null {
  if (!Number.isFinite(repayUsd) || !Number.isFinite(borrowUsd)) return null;
  if (repayUsd <= 0 || borrowUsd <= 0) return null;
  const scaled = Math.round((repayUsd / borrowUsd) * REPAY_FRACTION_SCALE);
  const clamped = Math.min(Math.max(scaled, 1), REPAY_FRACTION_SCALE);
  return clamped / REPAY_FRACTION_SCALE;
}

/**
 * The same quantisation as `repayFractionOfDebt`, but from an AMOUNT already
 * expressed in the debt asset's own units, and rounding DOWN instead of half up.
 *
 * It exists for the wallet cap: the question there is "what is the largest
 * fraction this balance can actually fund", and rounding that half up produces
 * a fraction the wallet cannot pay. Every other fraction in this module is a
 * quote; this one is a ceiling, so it floors.
 *
 * BigInt throughout, then a single conversion of an integer below 1e6 - the
 * amount and the debt are raw token amounts and an 18-decimal debt does not
 * survive `Number()`.
 *
 * Returns null when there is no debt, or when the amount does not reach one
 * step of the grid. Null, never 0, for the reason `repayFractionOfDebt` gives:
 * a 0 fraction builds a silent no-op leg.
 */
export function repayFractionFloorFromAmount(amount: bigint, debt: bigint): number | null {
  if (debt <= 0n || amount <= 0n) return null;
  const scale = BigInt(REPAY_FRACTION_SCALE);
  const scaled = (amount * scale) / debt;
  if (scaled < 1n) return null;
  return Number(scaled > scale ? scale : scaled) / REPAY_FRACTION_SCALE;
}

/**
 * Dollars a given executable fraction repays, against a debt already priced.
 *
 * The inverse of `repayFractionOfDebt`, and it exists because a CAPPED repay is
 * decided as a fraction (the only form a wallet balance can constrain) and then
 * has to be quoted back to the user in dollars. Deriving those dollars by
 * scaling the advisor's original figure would drift from the fraction that
 * actually executes.
 *
 * One rounding rule, the same one `RepayPlan.repayUsd` carries: whole dollars,
 * round half up. Two figures describing one repay must round identically or the
 * card and the modal quietly disagree.
 *
 * Null when the debt is not a usable dollar figure (a degraded price feed), so
 * the caller states nothing rather than a dollar amount it cannot support.
 */
export function repayUsdFromFraction(borrowUsd: number | null, fraction: number): number | null {
  if (borrowUsd === null || !Number.isFinite(borrowUsd) || borrowUsd <= 0) return null;
  if (!Number.isFinite(fraction) || fraction <= 0) return null;
  return Math.round(borrowUsd * Math.min(fraction, 1));
}

/**
 * Health factor after repaying `fraction` of the debt, collateral untouched.
 *
 * HF = L / D with L the liquidation-weighted collateral, and a wallet-funded
 * repay does not touch collateral, so L is invariant: repaying R = f*D leaves
 * HF' = L / (D - R) = (HF * D) / (D - f*D) = HF / (1 - f). The dollar form and
 * the fraction form are the same identity, so only one of them is written here
 * - the fraction is what executes, and a second copy taking dollars is how the
 * two would eventually disagree on an edge.
 *
 * Null for a fraction of 1 or more: clearing the debt leaves no health factor
 * at all, which is what `RepayPlan.projectedHf` and `ActiveScore.healthFactor`
 * both say with a null. Echoing a very large number instead would print a ratio
 * the position will never hold.
 *
 * The value is returned unrounded. Its ONE display rounding is the consequence
 * phrasing every surface already uses: `drawdownToLiquidation` then
 * `formatDrawdownPct` in `../prospective`, with the exact ratio via `fmtHf`.
 */
export function hfAfterRepayFraction(hfNow: number | null, fraction: number): number | null {
  if (hfNow === null || !Number.isFinite(hfNow) || hfNow <= 0) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) return null;
  return hfNow / (1 - fraction);
}

/**
 * Exact integer numerator of a `repayFraction` over REPAY_FRACTION_SCALE.
 * Null for anything that is not a usable fraction, so a caller cannot turn a
 * NaN or an out-of-contract value into an amount.
 */
export function repayFractionNumerator(fraction: number): bigint | null {
  if (!Number.isFinite(fraction) || fraction <= 0) return null;
  const scaled = Math.round(fraction * REPAY_FRACTION_SCALE);
  if (scaled < 1) return null;
  return BigInt(Math.min(scaled, REPAY_FRACTION_SCALE));
}

/**
 * `fraction x debt`, in the debt asset's OWN units, entirely in BigInt - the
 * conversion the execution path needs and the reason `repayFraction` exists.
 * `debt` is a raw token amount (wei-scale); it is never converted to a Number,
 * so an 18-decimal debt above 2^53 keeps every unit.
 *
 * The division FLOORS, so the result never exceeds the fraction that was
 * quoted. The leftover is at most one unit of the token (sub-dust: 1e-18 WETH,
 * 1e-6 USDC) plus the 1/1e6 quantisation of the fraction itself.
 *
 * Returns null when there is no debt or no usable fraction, and 0n is never
 * returned as a stand-in for those: a caller must be able to tell "repay
 * nothing here" from "this leg rounds to nothing", and only the second is a
 * reason to drop a leg the user asked to reduce.
 */
export function repayAmountFromFraction(debt: bigint, fraction: number): bigint | null {
  if (debt <= 0n) return null;
  const numerator = repayFractionNumerator(fraction);
  if (numerator === null) return null;
  const amount = (debt * numerator) / BigInt(REPAY_FRACTION_SCALE);
  return amount > 0n ? amount : null;
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
