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

/** Wallet-funded partial-repay plan (Phase 2; flash-loan funding is Phase 3). */
export interface RepayPlan {
  /** Dollars of debt to repay to reach targetHf. */
  repayUsd: number;
  /** Dominant borrow asset to repay with (USDC in practice). */
  repayAssetSymbol: string;
  /** Profile-derived health-factor target. */
  targetHf: number;
  /** HF after the repay (== targetHf by construction; echoed for the UI). */
  projectedHf: number;
  mode: "wallet_funded";
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
  /** Present iff action === "OPEN". */
  openPlan?: OpenPlan;
  /** Present iff action === "REBALANCE". */
  rebalance?: { toProtocol: Protocol; reason: string };
  /** Deterministic 4-section text; the narrator may overwrite prose, never numbers. */
  sections: AdvisorSections;
  numbers: Pick<
    ActiveScore,
    | "total"
    | "band"
    | "healthFactor"
    | "collateralValueUsd"
    | "borrowValueUsd"
    | "subScores"
    | "scoredCollateralSymbol"
  >;
  /** Prefill for the ExitFlow modal (EXIT / REDUCE actions). */
  exitPrefill?: { protocol: Protocol; kind: "full" | "partial"; repayUsd?: number };
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
