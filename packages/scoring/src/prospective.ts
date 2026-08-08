/**
 * Prospective-mode helpers (Compass scenario estimates), plus the ONE
 * liquidation-drawdown formula and the ONE rounding policy for it.
 *
 * "If you open this position at X% LTV, here is your starting health factor
 * and how much the asset must move to trigger liquidation."
 *
 * This module has no imports of its own, deliberately: it is arithmetic and one
 * formatter, so a browser surface can deep-import it without dragging the chain
 * adapters (and viem) in behind the package barrel. `advisor/fallback` and
 * `src/panik-core/lib/utils` both read it, which is what keeps the figure on a
 * stat strip and the figure in the engine's prose the same number.
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
 * Collateral price drop (fraction 0-1) that triggers liquidation, from a health
 * factor that has already been measured: liquidation sits at HF = 1 and HF
 * scales linearly with the collateral price, so a drop of 1 - 1/HF erases the
 * buffer. Every surface holding an HF can therefore state "how far can this
 * asset fall" without a second round trip or a second copy of the arithmetic.
 *
 * Null for a health factor this formula cannot describe: `null` (no debt, so no
 * liquidation to be a distance from) and any HF at or below 0, where 1 - 1/HF
 * is not a drawdown at all (HF -1 would report a 200% drop). Callers must
 * distinguish `0` — liquidatable now — from `null`.
 *
 * The linearity holds exactly when the debt is stable-denominated and the
 * collateral moves as one asset. It is an approximation for a multi-asset or
 * volatile-debt position, so surfaces that render it should say so.
 */
export function drawdownToLiquidation(hf: number | null): number | null {
  if (hf === null || hf <= 0) return null;
  return Math.max(0, 1 - 1 / hf);
}

/**
 * A drawdown fraction as a percentage a person can act on.
 *
 * The rounding lives beside the formula because the same drop is printed by two
 * layers — the UI's stat strips and the engine's own prose — and when each
 * carried its own policy one card stated one health factor as "17%" in the strip
 * and "17.4%" in the explanation one click away.
 *
 * One decimal below 10%, none above it. The precision is not cosmetic: at the
 * shallow end 4.8% and 5.4% are a different afternoon, and rounding both to "5%"
 * throws away the distinction exactly where it matters most. Above 10% the
 * decimal is noise on an estimate that rests on a linearity assumption. The
 * one-decimal branch is re-checked AFTER rounding so 9.96% prints "10%" rather
 * than "10.0%", the only value in the UI carrying a decimal it is not entitled to.
 *
 * Two bounds rather than a bare number: a drop under 0.1% would print "0.0%",
 * which reads as "no drop needed", and a drop of exactly 0 is not a short
 * distance to liquidation but none at all.
 */
export function formatDrawdownPct(drop: number): string {
  if (drop <= 0) return "0%";
  if (drop < 0.001) return "under 0.1%";
  const pct = drop * 100;
  const oneDp = Number(pct.toFixed(1));
  return oneDp < 10 ? `${oneDp.toFixed(1)}%` : `${Math.round(pct)}%`;
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
  return drawdownToLiquidation(
    estimateHealthFactor(collateralValueUsd, borrowValueUsd, liquidationThreshold),
  );
}
