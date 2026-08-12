/**
 * Advisor types - Phase 2 recommendation engine (SYSTEM_ARCHITECTURE §6 Slice 3).
 * The engine is deterministic and pure: rules decide the action, math computes
 * the amounts, the LLM (advisorNarrator) only rephrases the sections. Same
 * "narrate, never decide" contract as the wallet profiler.
 */

import type { ActiveScore } from "../adapters/active";
import type { Protocol, RiskProfile } from "../types";

export type AdvisorAction = "HOLD" | "MONITOR" | "REDUCE" | "EXIT" | "REBALANCE" | "OPEN";

export type Urgency = "info" | "warning" | "critical";

/**
 * What the user has to bring to a collateral-funded repay, priced.
 *
 * Every field is a cost the wallet-funded plan does not pay, which is the whole
 * reason the user is being shown two routes. Present only on a
 * `collateral_funded` plan; a wallet-funded repay swaps nothing and borrows
 * nothing, so quoting it a flash fee of 0 would invite a surface to print "0%
 * flash fee" as if it were a feature of that route rather than the absence of a
 * mechanism.
 */
export interface RepayCosts {
  /**
   * Flash-loan fee, in bps of the repaid amount, as the WORST case of the route
   * the Deleverager walks. See `DELEVERAGE_FLASH_FEE_BPS`.
   */
  flashFeeBps: number;
  /**
   * Swap slippage ALLOWANCE, in bps. A ceiling enforced on chain, not a
   * prediction: a swap that would settle worse reverts.
   */
  slippageBps: number;
  /**
   * Gas the deleverage burns, in GAS UNITS, fork-measured per protocol. Units
   * rather than dollars because pricing them needs a live gas price and ETH
   * price the engine cannot read - see `DELEVERAGE_GAS_UNITS` and
   * `gasUsdFromUnits`. A surface without both readings must say gas is priced
   * at signing, never print a dollar figure it does not have.
   */
  gasUnits: number;
}

/** A sized partial repay, in one of the two ways it can be funded. */
export interface RepayPlan {
  /**
   * Dollars of debt to repay to reach targetHf. FOR DISPLAY ONLY. The dollar
   * figure cannot be turned back into token units without a price, so nothing
   * that moves money may derive an amount from it - use `repayFraction`.
   */
  repayUsd: number;
  /**
   * The leg's largest borrow asset, which is what the repay is denominated in.
   * Null when the reader could not establish one: this used to be hardcoded to
   * "USDC", which named the wrong token for every wallet that borrowed anything
   * else. Prose must omit the asset rather than guess it.
   */
  repayAssetSymbol: string | null;
  /**
   * The same repay expressed as a fraction of THIS leg's debt, in (0, 1],
   * quantised to 1/`REPAY_FRACTION_SCALE`. This is the executable form: an
   * execution path multiplies it by the live on-chain debt to get an amount in
   * the debt asset's own units, in BigInt, with no price and no float.
   * See `repayFractionOfDebt` for the rounding and clamping rule.
   */
  repayFraction: number;
  /** Profile-derived health-factor target. */
  targetHf: number;
  /**
   * The same target as the collateral price drop the position survives once the
   * repay lands: d* = 1 - 1/targetHf, so 1.75 is "survives a 42.9% drop".
   *
   * The two fields are one target in two forms and are derived from each other
   * (`TARGET_DRAWDOWN` in `repayMath.ts`); they can never disagree. This one is
   * carried rather than left to each consumer to compute, because the formula
   * has exactly one home (`drawdownToLiquidation`) and a consumer reaching for
   * it is a consumer about to write a second copy.
   */
  targetDrawdown: number;
  /**
   * HF after the repay (== targetHf by construction on a sized repay).
   *
   * Null when the plan clears the debt outright: a position with no debt has no
   * health factor at all, which is the same thing `ActiveScore.healthFactor`
   * says with a null. Echoing `targetHf` here instead would print a ratio the
   * position will never hold.
   */
  projectedHf: number | null;
  /**
   * Where the money to repay comes from. The two are not variants of one
   * action; they ask different things of the user and they move different
   * assets.
   *
   * `wallet_funded` - the user pays from their own wallet, in the debt asset.
   * Nothing is sold, the collateral is untouched, and the position ends up
   * smaller by exactly what they put in. It needs them to HOLD the debt asset.
   *
   * `collateral_funded` - the user's own collateral funds the repay. A flash
   * loan (or, on Morpho Blue, the protocol's own repay callback) covers the
   * debt, enough collateral is sold to settle it, and the leftover stays
   * deposited. It needs no capital in the wallet at all, and it costs a flash
   * fee, swap slippage and materially more gas - see `costs`.
   */
  mode: "wallet_funded" | "collateral_funded";
  /**
   * The costs peculiar to a collateral-funded repay. Present iff
   * `mode === "collateral_funded"`; see `RepayCosts` for why it is absent
   * rather than zeroed on the wallet-funded plan.
   */
  costs?: RepayCosts;
}

/**
 * A second outcome the user may pick INSTEAD of the recommendation's primary
 * action, without the engine changing its mind about what it recommends.
 *
 * It exists because "I want zero debt" and "I want out entirely" are different
 * intents. Above `REDUCE_TO_EXIT_RATIO` a sized repay is so close to the whole
 * debt that the advisor promotes it to a full EXIT, and that promotion used to
 * discard the repay: a user who wanted to be unlevered while keeping collateral
 * deposited and earning was only ever offered the door.
 *
 * The primary action is unchanged (alerting keys off `action`/`urgency`), so
 * this is strictly additive: a consumer that ignores it behaves as before.
 */
export interface AdvisorAlternative {
  /** The only alternative the engine emits today. */
  kind: "full_repay";
  /**
   * The whole debt. `repayFraction` is exactly 1 and nothing is withdrawn, so
   * taking this leaves the position open with the collateral still deposited
   * and no debt left to liquidate.
   */
  plan: RepayPlan;
}

/** Sized open-position suggestion produced by the opportunity scanner. */
export interface OpenPlan {
  protocol: Protocol;
  collateralSymbol: string;
  collateralUsd: number;
  borrowUsd: number;
  projectedScore: number;
  projectedHf: number | null;
  /** Net supply APY (fraction, e.g. 0.042) - null when yields unavailable. */
  apy: number | null;
}

/** The 4-section advice format (docs name it in §6 Slice 3; defined here). */
export interface AdvisorSections {
  /** 1. Position status - HF, band, distance to liquidation. */
  position: string;
  /** 2. Market context - which signal drives the score, with its value. */
  market: string;
  /** 3. What to do - the action with concrete amounts. */
  recommendation: string;
  /** 4. How to do it - what the action button will sign. */
  execution: string;
}

/** Extra per-leg market context for rules/narration (all optional). */
export interface LegMarketContext {
  /** 7d protocol TVL change, fraction (e.g. -0.08). */
  protocolTvl7dPct?: number | null;
  /** 7d sector TVL change, fraction. */
  sectorTvl7dPct?: number | null;
}

/**
 * Slim wallet-history view for personalization, derived from the profiler's
 * deterministic classification (never from the LLM).
 */
export interface WalletInsights {
  profile: RiskProfile;
  archetype: string;
  /** Protocol slugs the wallet has actually used (e.g. "aave", "moonwell"). */
  protocols: string[];
  topProtocol: string | null;
  topCollateralSymbol: string | null;
  liquidations: number;
  lendingAgeDays: number;
  borrowToDepositRatio: number;
  stableBorrowPct: number;
  daysSinceLastActivity: number;
  /** 0-1 classifier confidence; low = thin history, personalize gently. */
  confidence: number;
}

export interface AdvisorRecommendation {
  protocol: Protocol;
  wallet: string;
  action: AdvisorAction;
  urgency: Urgency;
  /** Machine-readable rule tags, e.g. ["band:CRITICAL", "floor:hf<=1.10"]. */
  triggers: string[];
  /** Present iff action === "REDUCE" (or a promoted EXIT retains it for context). */
  repayPlan?: RepayPlan;
  /**
   * A declinable second outcome for this leg. Present only where the engine has
   * one to offer (today: an EXIT promoted from a near-total REDUCE), and the UI
   * must show it as a quiet secondary beside the primary action, never instead
   * of it. See `AdvisorAlternative`.
   */
  alternative?: AdvisorAlternative;
  /**
   * The SAME protection as `repayPlan`, funded by the user's own collateral
   * instead of their wallet. Both plans are emitted together, and that is a
   * deliberate design decision rather than an oversight:
   *
   * choosing between the two routes turns entirely on whether the wallet holds
   * enough of the debt asset to fund the sized repay, and this engine has no
   * wallet-balance input. `ActiveScore` carries positions, prices and ratios;
   * it carries no ERC-20 balances, and `AdviseOptions` supplies none. An engine
   * that picked one route would therefore be picking it from a guess about the
   * user's wallet, and guessing wrong is not a cosmetic error: it tells someone
   * holding no USDC to go and repay in USDC, or charges someone who already
   * holds it a flash fee and a swap they never needed. So the engine sizes both
   * and the CALLER, which can read balances on chain, picks.
   *
   * Absent when the leg cannot support one: an unknown weighted liquidation
   * threshold (the sizing divides by `targetHf - WLT`), a target unreachable by
   * selling collateral, or a repay too small to cover the flash fee, slippage
   * and gas it would pay. Absent means "no such option here", never "free".
   */
  collateralFundedAlternative?: RepayPlan;
  /** Present iff action === "OPEN". */
  openPlan?: OpenPlan;
  /** Present iff action === "REBALANCE". */
  rebalance?: { toProtocol: Protocol; reason: string };
  /** Deterministic 4-section text; the narrator may overwrite prose, never numbers. */
  sections: AdvisorSections;
  /**
   * Where the `sections` above actually came from, per leg.
   *
   * Absent or `"fallback"` means the engine wrote them. The UI labels an
   * AI-phrased block and must not label a deterministic one: a report-level
   * "narrated" flag cannot answer that question, because a report is narrated
   * when ANY leg is and the guards reject legs individually.
   *
   * On a critical leg `"narrated"` still means the verdict sentence is the
   * engine's - see `AdvisorNarrator`.
   */
  narrationSource?: "narrated" | "fallback";
  numbers: Pick<
    ActiveScore,
    | "total"
    | "band"
    | "healthFactor"
    | "collateralValueUsd"
    | "borrowValueUsd"
    | "usdValuesUnavailable"
    | "subScores"
    | "scoredCollateralSymbol"
  >;
  /**
   * Prefill for the ExitFlow modal (EXIT / REDUCE actions). `repayUsd` is the
   * display figure; `repayFraction` is the one the transaction is built from
   * (see `RepayPlan`), and a partial prefill without it cannot be sized.
   */
  exitPrefill?: {
    protocol: Protocol;
    /**
     * `full` closes the position; `full_repay` clears the debt and leaves the
     * collateral deposited; `partial` repays the sized fraction. The engine only
     * ever prefills the primary action, so `full_repay` reaches the flow from
     * `alternative`, built at the call site.
     */
    kind: "full" | "partial" | "full_repay";
    repayUsd?: number;
    repayFraction?: number;
    /**
     * The three engine-owned readings the flow needs to describe a repay it had
     * to CUT DOWN to what the wallet holds: the leg's total debt in dollars,
     * the health factor before the repay, and the collateral the drop is quoted
     * against. All display only.
     *
     * They are carried rather than recomputed because the flow reaches the
     * chain and not the scorer: it knows the debt in token units and nothing
     * about its dollar value, its health factor or its collateral. Without them
     * a capped repay could only say how much it was repaying, never what that
     * buys, which is the question the user is actually asking.
     */
    borrowUsd?: number | null;
    healthFactor?: number | null;
    collateralSymbol?: string;
  };
  /** Prefill for the OpenFlow modal (OPEN actions). */
  openPrefill?: OpenPlan;
}

export interface AdvisorOverall {
  action: AdvisorAction;
  urgency: Urgency;
  headline: string;
}

export interface AdvisorReport {
  wallet: string;
  profile: RiskProfile;
  overall: AdvisorOverall;
  /** One recommendation per active protocol leg. */
  recommendations: AdvisorRecommendation[];
  /** OPEN suggestions from the opportunity scanner (top 3). */
  opportunities: AdvisorRecommendation[];
  walletInsights?: WalletInsights;
  /** True when LLM prose replaced the deterministic sections. */
  narrated: boolean;
  updatedAt: number;
}

/** Severity order for computing the overall action (worst leg wins). */
export const ACTION_SEVERITY: Record<AdvisorAction, number> = {
  EXIT: 5,
  REDUCE: 4,
  REBALANCE: 3,
  MONITOR: 2,
  OPEN: 1,
  HOLD: 0,
};
