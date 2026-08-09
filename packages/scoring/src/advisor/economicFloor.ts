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
 * Only the penalty term is non-zero for a WALLET-FUNDED repay: it comes out of
 * the wallet, so there is no flash-loan fee and nothing is swapped. The other
 * two are inputs rather than constants because a COLLATERAL-FUNDED deleverage
 * pays both, and a floor that silently ignored them would be too low exactly
 * where the costs are highest.
 *
 * This is a DUST GUARD, not a profitability model. It exists to stop the
 * advisor recommending an action that cannot pay for itself; it is not used to
 * rank actions, size them, or quote a saving to the user.
 */

import type { Protocol } from "../types";

/**
 * The fork that produced every constant in this file labelled "fork-measured".
 *
 * A number without its provenance is a number nobody can re-check, and half the
 * values here are chain readings while the other half are not. The label is the
 * point: a later reader must be able to tell at a glance which is which.
 */
export const FORK_MEASUREMENT = {
  chain: "Base mainnet",
  /** Pinned fork block for `executor/test/fork/deleverager.fork.spec.ts`. */
  block: 49_691_000,
  /** The PR whose fork suite read these values off chain. */
  source: "PR #33 (PanikDeleverager fork suite)",
} as const;

/**
 * Aave V3 non-e-mode liquidation bonus per collateral asset, in bps of the
 * repaid debt, on the 1e4 scale Aave itself uses (10500 => a 5% bonus).
 *
 * FORK-MEASURED: read from `getConfiguration` on the Base pool at
 * `FORK_MEASUREMENT.block`. E-mode reserves carry a materially lower bonus and
 * are not covered by these two readings.
 */
export const AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS: Record<string, number> = {
  /** liquidationBonus 10500 => 500 bps of penalty. */
  WETH: 500,
  /** liquidationBonus 10750 => 750 bps of penalty. */
  cbBTC: 750,
};

/**
 * Liquidation penalty (bonus paid to the liquidator) per protocol, in basis
 * points of the repaid debt.
 *
 * Each value carries the quality of its source, because that is the thing a
 * later reader needs and the thing a bare number hides. Two of the four are now
 * chain readings; two are not, and are still labelled as such.
 *
 * They are used only by the floor functions below, whose output is compared
 * against a repay of tens or hundreds of dollars, so being 200bps out moves the
 * floor by a couple of dollars. Do not reuse them anywhere a user-facing number
 * is derived from them without measuring the specific market first.
 */
export const LIQUIDATION_PENALTY_BPS: Record<Protocol, number> = {
  /**
   * 5%. Source quality: FORK-MEASURED (see `FORK_MEASUREMENT`). The Base pool
   * reports liquidationBonus 10500 on WETH and 10750 on cbBTC, both non-e-mode
   * (`AAVE_NON_EMODE_LIQUIDATION_BONUS_BPS`). The LOWER of the two is used
   * here, because a single per-protocol number cannot know which collateral a
   * leg holds and the lower penalty is the one that yields the higher floor: it
   * cannot claim a repay pays for itself on a market where it does not.
   * E-mode reserves run lower still, so an e-mode position's true floor is
   * higher than this and the guard under-suppresses there.
   */
  aave_v3: 500,
  /**
   * 7%. Source quality: THIRD-PARTY, NOT FORK-MEASURED. The Deleverager fork
   * suite exercised Moonwell but captured no liquidation-incentive reading, so
   * this is unchanged: it comes from third-party write-ups of Moonwell's Base
   * markets rather than from the comptroller's `liquidationIncentiveMantissa`,
   * which is the authoritative reading and has still not been made.
   */
  moonwell: 700,
  /**
   * 5%. Source quality: DERIVED FROM A PUBLISHED FORMULA, NOT FORK-MEASURED, at
   * one representative market. Morpho Blue's liquidation incentive factor is
   * per-market and a function of the market's LLTV; the published formula lands
   * near 5% at an LLTV of 0.86. A market at a different LLTV carries a
   * different incentive, which this single constant does not express.
   */
  morpho: 500,
  /**
   * 5%. Source quality: FORK-MEASURED (see `FORK_MEASUREMENT`). Compound III's
   * `getAssetInfoByAddress` reports liquidationFactor 0.95e18 on both WETH and
   * cbBTC in the Base USDC comet, and the penalty is `1e18 - liquidationFactor`
   * = 0.05e18 = 5%.
   */
  compound_v3: 500,
};

/**
 * Flash-loan fee by source, in bps of the borrowed amount.
 *
 * FORK-MEASURED: Aave's is `FLASHLOAN_PREMIUM_TOTAL` read off the Base pool at
 * `FORK_MEASUREMENT.block`; the other two charge nothing and the fork suite
 * confirms the repaid amount equals the borrowed amount.
 */
export const FLASH_FEE_BPS = {
  /** Balancer V2 vault: no premium. First choice in the Deleverager. */
  balancer_v2: 0,
  /** Morpho singleton `flashLoan`: no premium. Second choice. */
  morpho_singleton: 0,
  /** Aave V3 `FLASHLOAN_PREMIUM_TOTAL` = 5 bps. Last resort. */
  aave_v3: 5,
} as const;

/**
 * The flash fee a collateral-funded deleverage may pay on each protocol, in
 * bps, taken as the WORST case of the route the Deleverager actually walks.
 *
 * The contract tries Balancer V2 (0) then the Morpho singleton (0) then Aave
 * (5 bps), so the typical cost is zero and the ceiling is Aave's premium. A
 * dust guard takes the ceiling: sizing the floor off the free path would let it
 * recommend a repay that stops paying for itself the moment Balancer is short
 * of liquidity.
 *
 * Morpho Blue is the exception and it is zero for a structural reason, not an
 * optimistic one: that leg repays inside the protocol's own `onMorphoRepay`
 * callback and never takes a flash loan at all.
 */
export const DELEVERAGE_FLASH_FEE_BPS: Record<Protocol, number> = {
  aave_v3: FLASH_FEE_BPS.aave_v3,
  moonwell: FLASH_FEE_BPS.aave_v3,
  compound_v3: FLASH_FEE_BPS.aave_v3,
  morpho: 0,
};

/**
 * Gas a full collateral-funded deleverage burns, in GAS UNITS, per protocol.
 *
 * FORK-MEASURED: `receipt.gasUsed` from the Deleverager fork suite at
 * `FORK_MEASUREMENT.block`, one successful deleverage per protocol.
 *
 * Units, not dollars, and deliberately so. Turning these into USD needs a gas
 * price and an ETH price, and this package reaches neither chain nor price
 * feed. Inventing either to produce a tidier constant is exactly the failure
 * the honesty rules exist to stop, so the conversion is `gasUsdFromUnits` and
 * the caller supplies the two live readings.
 */
export const DELEVERAGE_GAS_UNITS: Record<Protocol, number> = {
  aave_v3: 693_320,
  compound_v3: 532_172,
  moonwell: 1_167_280,
  morpho: 348_959,
};

/**
 * Swap slippage a collateral-funded deleverage is allowed, in bps.
 *
 * 1%, matching `DEFAULT_SLIPPAGE_BPS` in the delegation UI, which is the
 * default a fresh standing permission is granted with. It is an ALLOWANCE and
 * therefore a ceiling on the cost, not a prediction of it: the executor clamps
 * the user's choice to the contract's own immutable ceiling and a swap that
 * would exceed the limit reverts rather than settling worse.
 */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 100;

/** Wei per ETH, for `gasUsdFromUnits`. */
const WEI_PER_ETH = 1_000_000_000_000_000_000n;
/** Pico-ETH per ETH: the grid the wei math is reduced onto before it leaves BigInt. */
const PICO_PER_ETH = 1_000_000_000_000n;

/**
 * `gasUnits x gasPrice x ethUsd`, in USD.
 *
 * The wei arithmetic happens entirely in BigInt and is reduced to an integer
 * count of PICO-ETH before anything becomes a double: a wei-scale product does
 * not survive `Number()` (1e6 gas at 100 gwei is 1e17 wei, already past the
 * exact-integer range of a double), while pico-ETH for the same transaction is
 * 1e11 and exact. The grid is chosen from the small end, not the large one:
 * Base gas prices sit near 0.01 gwei, where a whole deleverage costs single-
 * digit micro-ETH, and a coarser grid would quantise the answer itself. One
 * pico-ETH is under a millionth of a cent at any ETH price this sees.
 *
 * Null, never 0, for any input the engine cannot use: an unknown gas cost and a
 * free transaction are different facts, and a caller that read the second for
 * the first would place the economic floor at zero and wave through every dust
 * repay. Zero is returned only for a genuinely zero reading.
 */
export function gasUsdFromUnits(
  gasUnits: number,
  gasPriceWei: bigint,
  ethUsd: number,
): number | null {
  if (!Number.isFinite(gasUnits) || gasUnits < 0) return null;
  if (gasPriceWei < 0n) return null;
  if (!Number.isFinite(ethUsd) || ethUsd < 0) return null;
  const picoEth = (BigInt(Math.round(gasUnits)) * gasPriceWei * PICO_PER_ETH) / WEI_PER_ETH;
  return (Number(picoEth) / Number(PICO_PER_ETH)) * ethUsd;
}

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
 * `repayUsdFloor` for a protocol, using that protocol's liquidation penalty and
 * the wallet-funded cost shape (no flash fee, no slippage).
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

/**
 * `repayUsdFloor` for a COLLATERAL-FUNDED deleverage on a protocol: the same
 * avoided penalty, now charged the two costs a wallet-funded repay does not
 * pay. The flash fee is the worst case of the route the Deleverager walks
 * (`DELEVERAGE_FLASH_FEE_BPS`) and the slippage is the swap allowance.
 *
 * `gasUsd` defaults to `DEFAULT_GAS_USD`, and that default is WRONG-SIZED here
 * in the direction of a lower floor: it is a rough band for one plain Base
 * transaction, while a deleverage burns 348,959 to 1,167,280 units
 * (`DELEVERAGE_GAS_UNITS`, fork-measured). The engine cannot fix that on its
 * own because a real figure needs a live gas price and ETH price it has no way
 * to read. A caller that holds both should convert with `gasUsdFromUnits` and
 * pass the result; until one does, the guard suppresses less than it should,
 * which is the same direction the wallet-funded floor already errs in.
 */
export function collateralFundedRepayUsdFloor(
  protocol: Protocol,
  gasUsd: number = DEFAULT_GAS_USD,
  slippageBps: number = DEFAULT_SWAP_SLIPPAGE_BPS,
): number | null {
  return repayUsdFloor({
    gasUsd,
    penaltyAvoidedBps: LIQUIDATION_PENALTY_BPS[protocol],
    flashFeeBps: DELEVERAGE_FLASH_FEE_BPS[protocol],
    slippageBps,
  });
}
