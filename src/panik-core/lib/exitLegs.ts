/**
 * Exit/Reduce leg derivation - the money math behind the ExitFlow modal, kept
 * out of the component so it can be tested without a DOM or a chain.
 *
 * This module deliberately has NO runtime imports of its own beyond two leaf
 * modules of the scoring engine (`advisor/repayMath` for the repay sizing and
 * `advisor/fallback` for the one percent formatter). It must not reach wagmi,
 * viem or React, or a `.test.ts` under vitest's node environment would drag the
 * whole app bundle in behind it.
 *
 * The rule that shapes everything here: amounts are BigInt in the token's OWN
 * units, decimals come from the token, and a dollar figure never becomes an
 * amount. Converting the advisor's `repayUsd` back into token units would need
 * a price the execution path does not have; the engine emits a fraction of the
 * leg's debt instead, and that fraction is what a repay is built from.
 */

import {
  hfAfterRepayFraction,
  repayAmountFromFraction,
  repayFractionFloorFromAmount,
  repayUsdFromFraction,
  REPAY_FRACTION_SCALE,
} from "../../../packages/scoring/src/advisor/repayMath";
import { fmtPct } from "../../../packages/scoring/src/advisor/fallback";
import type { LiveProtocol } from "./live";

/** ExitTypes.ProtocolId on-chain enum. */
export const PROTOCOL_ID: Record<LiveProtocol, number> = {
  aave_v3: 0,
  moonwell: 1,
  compound_v3: 2,
  morpho: 3,
};

/** Amount sentinel: type(uint256).max = "full" per the executor ABI. */
export const AMOUNT_FULL = 2n ** 256n - 1n;

export interface ExitLegInput {
  protocol: number;
  asset: `0x${string}`;
  repayAmount: bigint;
  withdrawAmount: bigint;
  data: `0x${string}`;
}

/** One reserve as the chain reports it, in that token's own units. */
export interface ExitReserveState {
  reserve: `0x${string}`;
  symbol: string;
  /** From the token contract, never assumed. */
  decimals: number;
  /** aToken balance (supplied collateral). */
  aBalance: bigint;
  /** Stable + variable debt, summed. */
  debt: bigint;
}

export interface ExitLegPlan {
  protocol: LiveProtocol;
  /**
   * `full` closes the position outright. `full_repay` clears the debt and
   * leaves every deposit where it is, so the position stays open, unlevered.
   * `partial` repays the advisor's sized fraction of each debt leg.
   */
  kind: "full" | "partial" | "full_repay";
  /**
   * Fraction of each debt leg to repay, from the advisor (`RepayPlan`).
   * Required for a partial exit: without it there is no size, and guessing one
   * from the dollar figure is the price dependency this design removes.
   */
  repayFraction?: number;
}

export interface ExitLegView {
  reserve: `0x${string}`;
  symbol: string;
  decimals: number;
  /** `AMOUNT_FULL` on a full exit or a full repay, else exact units of `reserve`. */
  repay: bigint;
  /** `AMOUNT_FULL` on a full exit, else 0n (a full repay withdraws nothing). */
  withdraw: bigint;
  debt: bigint;
  aBalance: bigint;
  /**
   * Exact units of `reserve` the wallet must hold to fund this repay - the
   * sentinel resolved against the live debt, so it is a number a balance can
   * actually be compared to. 0n when this leg repays nothing.
   */
  repayFunding: bigint;
}

export interface ExitPlanResult {
  legs: ExitLegInput[];
  views: ExitLegView[];
  /**
   * Symbols with real debt that were dropped because the requested fraction
   * rounded to less than one unit of the token. Surfaced rather than silently
   * skipped: an empty exit and a too-small exit are different problems.
   */
  dust: string[];
}

/**
 * Build the executor legs for an exit or a reduce.
 *
 * Full exit: the `AMOUNT_FULL` sentinel on every side that has a balance, which
 * is what the executor expects and what closes a position exactly despite
 * interest accruing between the read and the signature.
 *
 * Full repay: the same sentinel on every DEBT side, and nothing withdrawn. The
 * sentinel rather than `repayFraction = 1` on purpose. A fraction is applied to
 * the debt this module READ, and debt accrues interest between that read and the
 * signature, so a fraction of 1 would leave a few units of debt behind and the
 * position would not actually be unlevered - the one thing the user asked for.
 * The sentinel is resolved protocol-side at execution, so it absorbs whatever
 * accrued. `repayFunding` still resolves to the read debt, because that is the
 * number a wallet balance can be compared against, and the approval it sizes
 * carries an accrual buffer of its own (`withAccrualBuffer`).
 *
 * Partial (reduce): EVERY reserve with debt is repaid by the same fraction, in
 * that reserve's own units. Health factor is L/D, so scaling every debt leg by
 * f scales D by f and lands the health factor exactly where the advisor
 * promised. Repaying one chosen asset instead would only work when that one
 * asset happens to carry enough debt, and it silently under-delivers when it
 * does not. Collateral is untouched (wallet-funded model).
 */
export function buildExitLegs(
  reserves: readonly ExitReserveState[],
  plan: ExitLegPlan,
): ExitPlanResult {
  const legs: ExitLegInput[] = [];
  const views: ExitLegView[] = [];
  const dust: string[] = [];

  for (const r of reserves) {
    let repay = 0n;
    let withdraw = 0n;

    if (plan.kind === "full") {
      if (r.debt > 0n) repay = AMOUNT_FULL;
      if (r.aBalance > 0n) withdraw = AMOUNT_FULL;
    } else if (plan.kind === "full_repay") {
      // Debt only. `withdraw` stays 0n so the collateral is left deposited.
      if (r.debt > 0n) repay = AMOUNT_FULL;
    } else if (r.debt > 0n) {
      // `repayAmountFromFraction` owns the clamp (a fraction above 1 cannot
      // over-repay) and the floor (never more than was quoted). Null means the
      // fraction rounds to nothing against this debt.
      const amount =
        plan.repayFraction === undefined
          ? null
          : repayAmountFromFraction(r.debt, plan.repayFraction);
      if (amount === null) {
        dust.push(r.symbol);
        continue;
      }
      repay = amount;
    }

    if (repay === 0n && withdraw === 0n) continue;

    legs.push({
      protocol: PROTOCOL_ID[plan.protocol],
      asset: r.reserve,
      repayAmount: repay,
      withdrawAmount: withdraw,
      data: "0x",
    });
    views.push({
      reserve: r.reserve,
      symbol: r.symbol,
      decimals: r.decimals,
      repay,
      withdraw,
      debt: r.debt,
      aBalance: r.aBalance,
      repayFunding: repay === 0n ? 0n : repay === AMOUNT_FULL ? r.debt : repay,
    });
  }

  return { legs, views, dust };
}

/**
 * A token amount for DISPLAY, in the token's own decimals. BigInt throughout:
 * the naive `Number(v) / 10 ** decimals` silently loses the low digits of any
 * 18-decimal balance above ~9 WETH-ish magnitudes, and this string sits next to
 * an amount the user is about to sign for.
 *
 * Trailing zeros are dropped, so 1,000 USDC reads "1,000" rather than
 * "1,000.00".
 */
export function formatTokenAmount(value: bigint, decimals: number, dp = 2): string {
  if (value < 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const scale = 10n ** BigInt(dp);
  // Round half up at the display precision, in integer math.
  const scaled = (value * scale + base / 2n) / base;
  const whole = scaled / scale;
  const fraction = dp > 0 ? (scaled % scale).toString().padStart(dp, "0").replace(/0+$/, "") : "";
  return fraction ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

/**
 * Interest-accrual headroom on every amount the user approves, in percent.
 *
 * Debt accrues between the read and the signature, so an approval sized to the
 * amount read can come up a few units short at execution. 2% is the buffer the
 * approval runner has always applied; it lives here because the wallet cap has
 * to invert it, and a second literal 2% in the cap would be free to drift.
 */
export const ACCRUAL_BUFFER_PCT = 2n;

/** amount + 2% (interest can accrue between approval and execution). */
export function withAccrualBuffer(amount: bigint): bigint {
  return amount + (amount * ACCRUAL_BUFFER_PCT) / 100n;
}

/**
 * The largest repay a balance can fund once the accrual buffer is taken out:
 * the greatest `a` with `withAccrualBuffer(a) <= balance`.
 *
 * Solved rather than approximated. `balance * 100 / 102` floors, and the floor
 * of the buffer itself means that quotient can land one unit either side of the
 * true answer, so both directions are walked. Each loop runs at most a couple
 * of times, and the result is exact in the token's own units, which is what the
 * "never execute more than the wallet holds" rule needs.
 */
export function maxAmountWithinBuffer(balance: bigint): bigint {
  if (balance <= 0n) return 0n;
  let amount = (balance * 100n) / (100n + ACCRUAL_BUFFER_PCT);
  while (amount > 0n && withAccrualBuffer(amount) > balance) amount -= 1n;
  while (withAccrualBuffer(amount + 1n) <= balance) amount += 1n;
  return amount;
}

/** One debt leg's live debt and what the wallet holds of that same asset. */
export interface RepayFundingBalance {
  /** Live debt on this leg, in the debt asset's own units. */
  debt: bigint;
  /** Wallet balance of that asset, same units. */
  balance: bigint;
}

/**
 * The advisor's repay, cut down to what the wallet can actually pay for.
 *
 * A wallet-funded repay is pulled from the user, so a shortfall in ANY debt
 * asset blocks the whole atomic transaction. The flow used to stop there: a
 * disabled button, a line saying how much was missing, and no way forward. But
 * a smaller repay is still a real reduction, and the user is entitled to know
 * exactly how much protection the money they DO hold buys.
 *
 * Every debt leg is scaled by the SAME fraction, for the reason `buildExitLegs`
 * gives: health factor is L/D, so scaling every leg by f scales D by f and
 * lands the health factor where the arithmetic says. So the cap is the minimum
 * over the legs, and it floors at every step (`repayFractionFloorFromAmount`,
 * then `repayAmountFromFraction` again when the legs are rebuilt) so the
 * executed amount can never exceed the balance it was derived from.
 *
 * Returns null when there is no cap to apply: the wallet already covers the
 * request, or some leg cannot fund even one step of the fraction grid, which is
 * a shortfall the existing "you need more X" message already explains better
 * than a repay of nothing would.
 */
export interface WalletRepayCap {
  /** What the advisor sized, unchanged. */
  requestedFraction: number;
  /** The largest fraction the wallet funds, on the engine's grid. */
  appliedFraction: number;
  /** Dollars the applied fraction repays. Null when the leg is unpriced. */
  appliedRepayUsd: number | null;
  /** Health factor after the capped repay. Null when it clears the debt. */
  appliedHf: number | null;
  /** Health factor the full suggestion would have reached. */
  requestedHf: number | null;
}

export function capRepayToWallet(input: {
  rows: readonly RepayFundingBalance[];
  requestedFraction: number;
  /** The leg's total debt in USD, from the engine. Null when unpriced. */
  borrowUsd: number | null;
  /** Health factor before the repay, from the engine. */
  healthFactor: number | null;
}): WalletRepayCap | null {
  const { rows, requestedFraction, borrowUsd, healthFactor } = input;
  if (!Number.isFinite(requestedFraction) || requestedFraction <= 0) return null;

  let applied = requestedFraction;
  for (const { debt, balance } of rows) {
    if (debt <= 0n) continue;
    const fundable = repayFractionFloorFromAmount(maxAmountWithinBuffer(balance), debt);
    if (fundable === null) return null;
    if (fundable < applied) applied = fundable;
  }
  if (applied >= requestedFraction) return null;

  return {
    requestedFraction,
    appliedFraction: applied,
    appliedRepayUsd: repayUsdFromFraction(borrowUsd, applied),
    appliedHf: hfAfterRepayFraction(healthFactor, applied),
    requestedHf: hfAfterRepayFraction(healthFactor, requestedFraction),
  };
}

/** `getSwapConfig(asset)` as the executor reports it, narrowed to what is shown. */
export interface SwapConfigRead {
  enabled: boolean;
  /** Minimum output as basis points of the oracle-implied value. */
  minOutBps: number;
}

const BPS = 10_000;

/**
 * How far below the oracle price a swap of this asset is allowed to settle,
 * as a fraction. Null when the config is unusable, which is not the same as
 * "no slippage" and must never render as 0%.
 */
export function swapSlippageFloor(config: SwapConfigRead | null): number | null {
  if (config === null || !config.enabled) return null;
  const { minOutBps } = config;
  if (!Number.isInteger(minOutBps) || minOutBps <= 0 || minOutBps > BPS) return null;
  return (BPS - minOutBps) / BPS;
}

/**
 * The one sentence shown when the wallet cannot cover a repay on its own.
 *
 * Wallet-funded means the user must hold the debt asset before signing, and a
 * user holding the wrong asset needs to know two things: how much is missing,
 * and what getting it will cost them. The percentage is the deployed slippage
 * floor read from `getSwapConfig`, formatted by the engine's one percent
 * formatter so it rounds like every other percentage in the product.
 *
 * A disabled or unreadable swap route says so rather than going quiet: "no
 * route" is a harder blocker than a bad rate, and hiding it leaves the user
 * staring at a disabled button.
 */
export function swapAcquisitionNote(input: {
  symbol: string;
  decimals: number;
  /** Units of the debt asset still missing from the wallet. */
  shortfall: bigint;
  config: SwapConfigRead | null;
}): string | null {
  const { symbol, decimals, shortfall, config } = input;
  if (shortfall <= 0n) return null;
  const need = `You need ${formatTokenAmount(shortfall, decimals)} more ${symbol} in your wallet before you can do this.`;
  if (config !== null && !config.enabled) {
    return `${need} There is no swap route set up for ${symbol} on chain, so you will have to bring it in another way.`;
  }
  const floor = swapSlippageFloor(config);
  if (floor === null) return need;
  const protection =
    floor === 0
      ? `at the oracle price, with no slippage allowed at all`
      : `to within ${fmtPct(floor)} of the oracle price`;
  return `${need} Swapping another asset for ${symbol} is one way to get it, and that swap is held ${protection}.`;
}

/** Re-exported so a caller can name the scale it is trusting. */
export { REPAY_FRACTION_SCALE };
