/**
 * The smallest repay worth signing.
 *
 * A repay costs gas now to avoid a liquidation penalty later. Below some size
 * the gas exceeds the penalty it prevents, and the advice becomes "spend a
 * dollar to save a dime". The advisor had no such gate, so a position sitting a
 * hair under its target health factor would be told to repay $2.
 *
 * The break-even, with the repay R in dollars and everything else in basis
 * points of R:
 *
 *   R * (penaltyAvoided - flashFee - slippage) / 10000  >=  gasUsd
 *   R                                                   >=  gasUsd * 10000 / (penaltyAvoided - flashFee - slippage)
 *
 * Only the penalty term is non-zero in Phase 2: the repay is wallet-funded, so
 * there is no flash-loan fee and nothing is swapped. The other two are inputs
 * rather than constants because Phase 3 (collateral-funded deleverage) pays
 * both, and a floor that silently ignored them would be too low exactly where
 * the costs are highest.
 *
 * This is a DUST GUARD, not a profitability model. It exists to stop the
 * advisor recommending an action that cannot pay for itself; it is not used to
 * rank actions, size them, or quote a saving to the user. That is why the
 * penalty constants below can be provisional without the gate being wrong.
 */

import type { Protocol } from "../types";

/**
 * Liquidation penalty (bonus paid to the liquidator) per protocol, in basis
 * points of the repaid debt.
 *
 * ALL FOUR ARE PROVISIONAL until they are measured against a fork in Phase 3.
 * They are used only by `repayUsdFloor`, whose output is compared against a
 * repay of tens or hundreds of dollars, so being 200bps out moves the floor by
 * a couple of dollars and changes no recommendation a user would notice. Do not
 * reuse them anywhere a user-facing number is derived from them without
 * measuring first.
 *
 * Each value carries the quality of its source, because that is the thing a
 * later reader needs and the thing a bare number hides.
 */
export const LIQUIDATION_PENALTY_BPS: Record<Protocol, number> = {
  /**
   * 5%. Source quality: DOCUMENTED PROTOCOL PARAMETER, not read from chain.
   * Aave V3 sets a per-reserve liquidation bonus; non-e-mode reserves commonly
   * sit at 5% or above. E-mode reserves run far lower (roughly 1% to 4%), so on
   * an e-mode position this number is optimistic and the real floor is higher.
   * Erring optimistic is the safe direction for a dust guard: it suppresses
   * less, so it cannot silence advice about a repay that was worth making.
   */
  aave_v3: 500,
  /**
   * 7%. Source quality: THIRD-PARTY. Taken from third-party write-ups of
   * Moonwell's Base markets rather than from the comptroller's
   * `liquidationIncentiveMantissa`, which is the authoritative reading and is
   * not made yet.
   */
  moonwell: 700,
  /**
   * 5%. Source quality: DERIVED FROM A PUBLISHED FORMULA, at one representative
   * market. Morpho Blue's liquidation incentive factor is per-market and a
   * function of the market's LLTV; the published formula lands near 5% at an
   * LLTV of 0.86. A market at a different LLTV carries a different incentive,
   * which this single constant does not express.
   */
  morpho: 500,
  /**
   * 5%. Source quality: UNVERIFIED ON BASE. Compound III sets a per-collateral
   * liquidation factor and penalty; neither was read for the Base deployment.
   * 5% is a conservative stand-in chosen to match the others, not a reading.
   */
  compound_v3: 500,
};

/**
 * Gas assumed for one repay when the caller does not supply a live figure, in
 * USD.
 *
 * 0.25 covers a Base transaction from calm to congested at the time of writing.
 * It is deliberately a rough band and not a live reading: the engine has no
 * chain access, and the number's only job is to place a floor that is a few
 * dollars rather than a few cents. A live gas price is a DISPLAY-TIME
 * refinement, and the surfaces that could supply one (the exit flow, after a
 * successful simulation) already do their own arithmetic on it.
 */
export const DEFAULT_GAS_USD = 0.25;

export interface RepayFloorInput {
  /** Cost of the repay transaction, in USD. */
  gasUsd: number;
  /** Liquidation penalty the repay avoids, in bps of the repaid debt. */
  penaltyAvoidedBps: number;
  /** Flash-loan fee, bps. Zero for a wallet-funded repay (Phase 2). */
  flashFeeBps?: number;
  /** Swap slippage allowance, bps. Zero when nothing is swapped (Phase 2). */
  slippageBps?: number;
}

const BPS = 10_000;

/**
 * The smallest repay, in USD, whose avoided penalty covers its costs.
 *
 * Returns null when the costs charged as a percentage of the repay already
 * equal or exceed the penalty avoided. That is not a floor of zero and it is
 * not a floor of infinity: it means no repay of any size pays for itself, so
 * the answer is "do not recommend this", which a number cannot say. A caller
 * that reads null as 0 would recommend every repay in exactly the case where
 * none is worth making.
 *
 * Zero gas gives a floor of zero: with nothing to pay for, any repay clears.
 */
export function repayUsdFloor({
  gasUsd,
  penaltyAvoidedBps,
  flashFeeBps = 0,
  slippageBps = 0,
}: RepayFloorInput): number | null {
  if (!Number.isFinite(gasUsd) || gasUsd < 0) return null;
  if (!Number.isFinite(penaltyAvoidedBps) || !Number.isFinite(flashFeeBps)) return null;
  if (!Number.isFinite(slippageBps)) return null;
  const netBps = penaltyAvoidedBps - flashFeeBps - slippageBps;
  if (netBps <= 0) return null;
  if (gasUsd === 0) return 0;
  return (gasUsd * BPS) / netBps;
}

/**
 * `repayUsdFloor` for a protocol, using that protocol's provisional liquidation
 * penalty and the wallet-funded cost shape (no flash fee, no slippage).
 */
export function protocolRepayUsdFloor(
  protocol: Protocol,
  gasUsd: number = DEFAULT_GAS_USD,
): number | null {
  return repayUsdFloor({
    gasUsd,
    penaltyAvoidedBps: LIQUIDATION_PENALTY_BPS[protocol],
  });
}
