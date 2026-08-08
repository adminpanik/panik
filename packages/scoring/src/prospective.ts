/**
 * Prospective-mode helpers (Compass scenario estimates).
 * "If you open this position at X% LTV, here is your starting health factor
 * and how much the asset must move to trigger liquidation."
 */

/** HF = (collateral value × liquidation threshold) / borrow value — arch line 62. */
export function estimateHealthFactor(
  collateralValueUsd: number,
  borrowValueUsd: number,
  liquidationThreshold: number,
): number | null {
  if (borrowValueUsd <= 0) return null; // no debt → no HF (null sentinel)
  return (collateralValueUsd * liquidationThreshold) / borrowValueUsd;
}

/**
 * The same drawdown, from a health factor that has ALREADY been measured.
 *
 * The formula lives here rather than at the call sites because a health factor
 * is the only input it needs: HF scales linearly with the collateral price, so
 * drop = 1 − 1/HF. Every surface that holds an HF — a live position row, an
 * advisor recommendation — can therefore state "how far can this asset fall"
 * without a second round trip, and without a second copy of the arithmetic
 * drifting away from this one.
 *
 * Floored at 0: an HF at or below 1.00 is already liquidatable, and a negative
 * "required drop" is not a number to show anyone. Callers must distinguish
 * `0` (liquidatable now) from `null` (no debt, so no liquidation at all).
 *
 * The linearity holds exactly when the debt is stable-denominated and the
 * collateral moves as one asset. It is an approximation for a multi-asset or
 * volatile-debt position, so surfaces that render it should say so.
 */
export function drawdownFromHealthFactor(hf: number | null): number | null {
  if (hf === null) return null;
  return Math.max(0, 1 - 1 / hf);
}

/**
 * Fractional price drop of the collateral that brings HF to 1.0
 * (e.g. 0.28 = a 28% drop triggers liquidation). Null when no debt.
 */
export function liquidationDrawdown(
  collateralValueUsd: number,
  borrowValueUsd: number,
  liquidationThreshold: number,
): number | null {
  return drawdownFromHealthFactor(
    estimateHealthFactor(collateralValueUsd, borrowValueUsd, liquidationThreshold),
  );
}
