/**
 * Advisor decision rules - deterministic, severity-ordered, first match wins.
 * Mirrors the calibrated escalation structure in params.ts (proximity floors,
 * crash regime) and the profile-relative status from profile.ts. The LLM never
 * participates here; it only narrates the result.
 */

import type { ActiveScore } from "../adapters/active";
import { MARKETS } from "../markets";
import { ALERT_POLICY, CRASH_REGIME, LIQUIDATION_PROXIMITY_FLOORS, PROTO_FLOOR } from "../params";
import { statusFor } from "../profile";
import { scoreProtocolSafety } from "../subscores/protocolSafety";
import type { Protocol, RiskProfile } from "../types";
import { protocolRepayUsdFloor } from "./economicFloor";
import { fallbackSections, overallHeadline, PROTOCOL_LABEL, fmtPct } from "./fallback";
import {
  REDUCE_TO_EXIT_RATIO,
  repayFractionOfDebt,
  repayToTargetHf,
  TARGET_HF,
} from "./repayMath";
import {
  ACTION_SEVERITY,
  type AdvisorAction,
  type AdvisorAlternative,
  type AdvisorOverall,
  type AdvisorRecommendation,
  type LegMarketContext,
  type Urgency,
} from "./types";

/** Protocol-safety sub-score at/above which a rebalance is suggested. */
export const REBALANCE_SAFETY_GATE = 60;

/**
 * Per-call inputs the engine cannot read for itself.
 *
 * `gasUsd` is the cost of one repay transaction, and it exists because the
 * economic floor is meaningless without it while the engine has no chain
 * access. Omitted, `economicFloor.DEFAULT_GAS_USD` stands in.
 */
export interface AdviseOptions {
  gasUsd?: number;
}

function numbersOf(score: ActiveScore): AdvisorRecommendation["numbers"] {
  return {
    total: score.total,
    band: score.band,
    healthFactor: score.healthFactor,
    collateralValueUsd: score.collateralValueUsd,
    borrowValueUsd: score.borrowValueUsd,
    usdValuesUnavailable: score.usdValuesUnavailable,
    subScores: score.subScores,
    scoredCollateralSymbol: score.scoredCollateralSymbol,
  };
}

/**
 * Safest OTHER supported protocol listing the same collateral symbol
 * (lowest protocol-safety risk sub-score). Null when nothing qualifies.
 */
export function safestAlternativeProtocol(
  current: Protocol,
  collateralSymbol: string,
): Protocol | null {
  const symbol = collateralSymbol.replace(" (proxy)", "");
  const candidates = (Object.keys(MARKETS) as Protocol[]).filter(
    (p) => p !== current && MARKETS[p][symbol] !== undefined,
  );
  candidates.sort((a, b) => scoreProtocolSafety(a) - scoreProtocolSafety(b));
  return candidates[0] ?? null;
}

/** Advise a single protocol leg. */
export function adviseLeg(
  score: ActiveScore,
  profile: RiskProfile,
  ctx?: LegMarketContext,
  opts?: AdviseOptions,
): AdvisorRecommendation {
  const status = statusFor(profile, score.total);
  const triggers: string[] = [`band:${score.band}`, `profile:${status}`];
  const hf = score.healthFactor;
  // A non-null HF means there IS debt; the USD gate only filters dust. When the
  // dollar magnitude is unknown (degraded price feed) the gate cannot be
  // evaluated, and defaulting it to "immaterial" is how a real six-figure debt
  // silently became an all-clear — so a degraded leg is exempt, never dropped.
  const borrowUsd = score.borrowValueUsd;
  const hasDebt =
    hf !== null &&
    (score.usdValuesUnavailable || (borrowUsd !== null && borrowUsd >= ALERT_POLICY.minBorrowUsd));
  if (score.usdValuesUnavailable) triggers.push("prices:degraded");
  if (score.marketContextUnavailable) triggers.push("market:unavailable");
  if (score.dominantCollateralUnpriced) triggers.push("collateral:unpriced");

  const base = {
    protocol: score.protocol,
    wallet: score.wallet,
    numbers: numbersOf(score),
  };

  const finish = (
    action: AdvisorAction,
    urgency: Urgency,
    extras: Partial<AdvisorRecommendation> = {},
  ): AdvisorRecommendation => {
    const rec: AdvisorRecommendation = {
      ...base,
      action,
      urgency,
      triggers,
      ...extras,
      sections: { position: "", market: "", recommendation: "", execution: "" },
    };
    rec.sections = fallbackSections(rec, ctx);
    return rec;
  };

  // Zero-debt legs cannot be liquidated (ALERT_POLICY.minBorrowUsd): never
  // escalate past MONITOR regardless of composite score.
  if (!hasDebt) {
    triggers.push("debt:none");
    return status === "within"
      ? finish("HOLD", "info")
      : finish("MONITOR", "info");
  }

  // Rule 1 - CRITICAL band (composite >= 75, incl. HF floors and crash regime).
  if (score.band === "CRITICAL") {
    for (const floor of LIQUIDATION_PROXIMITY_FLOORS) {
      if (hf !== null && hf <= floor.hfAtOrBelow) {
        triggers.push(`floor:hf<=${floor.hfAtOrBelow}`);
        break;
      }
    }
    if (
      hf !== null &&
      hf <= CRASH_REGIME.hfAtOrBelow &&
      score.subScores.assetRisk !== null &&
      score.subScores.assetRisk >= CRASH_REGIME.assetRiskAtOrAbove
    ) {
      triggers.push("regime:crash");
    }
    return finish("EXIT", "critical", {
      exitPrefill: { protocol: score.protocol, kind: "full" },
    });
  }

  // Rule 2 - defensive crash-regime catch below the CRITICAL band boundary.
  // An unmeasured asset risk never opens this gate (computeScore.ts holds the
  // same rule for the score itself): no reading is not a crash reading.
  if (
    hf !== null &&
    hf <= CRASH_REGIME.hfAtOrBelow &&
    score.subScores.assetRisk !== null &&
    score.subScores.assetRisk >= CRASH_REGIME.assetRiskAtOrAbove
  ) {
    triggers.push("regime:crash");
    return finish("EXIT", "critical", {
      exitPrefill: { protocol: score.protocol, kind: "full" },
    });
  }

  // Rule 3 - HIGH band or outside the user's profile: partial repay to target.
  if (score.band === "HIGH" || status === "outside") {
    const targetHf = TARGET_HF[profile];
    // Without a USD magnitude no dollar repay amount can be quoted — and
    // quoting one from a stale/unknown price is exactly the failure mode that
    // would tell a user to repay $200 against a $600k debt. Keep the REDUCE
    // severity, drop the (unquotable) plan and prefill.
    if (borrowUsd === null) {
      if (hf !== null && hf < targetHf) {
        triggers.push(`target:hf=${targetHf}`, "repay:amount_unavailable");
        return finish("REDUCE", "warning");
      }
      triggers.push("hf:above_target");
      return finish("MONITOR", "info");
    }
    const repayUsd = hf !== null ? repayToTargetHf(borrowUsd, hf, targetHf) : 0;
    // The fraction comes off the UNROUNDED repay: `repayUsd` is rounded for
    // display, and letting a display rounding into the executable amount is how
    // the two quietly stop describing the same repay.
    const repayFraction = repayFractionOfDebt(repayUsd, borrowUsd);
    // Below the economic floor the repay costs more gas than the liquidation
    // penalty it avoids, so recommending it is advice that loses money. The
    // leg is not silenced, it just stops being a REDUCE: it carries on through
    // the rebalance and MONITOR rules exactly as a leg whose health factor was
    // already at target does, which is the shape the advisor has always used
    // for "there is no repay worth quoting here".
    const floorUsd = protocolRepayUsdFloor(score.protocol, opts?.gasUsd);
    if (repayUsd > 0 && repayFraction !== null && floorUsd !== null && repayUsd >= floorUsd) {
      const repayPlan = {
        repayUsd: Math.round(repayUsd),
        // The leg's own debt asset, never an assumed stablecoin. Null when the
        // reader could not name it, which the prose then omits.
        repayAssetSymbol: score.dominantBorrowSymbol,
        repayFraction,
        targetHf,
        projectedHf: targetHf,
        mode: "wallet_funded" as const,
      };
      // Repaying ~everything IS a full exit - promote. The recommendation stays
      // EXIT (alerting keys off action/urgency, and the sized repay really is
      // within a rounding error of the whole debt), but the promotion no longer
      // throws the repay away: "clear my debt" and "get me out" are different
      // intents, and a user who wants to be unlevered while leaving collateral
      // deposited was previously offered only the door. Both outcomes are named,
      // neither is hidden.
      if (repayUsd > REDUCE_TO_EXIT_RATIO * borrowUsd) {
        triggers.push("promoted:reduce_to_exit");
        // The WHOLE debt as a fraction of itself. Routed through the engine's
        // one quantiser rather than written as a literal 1, so the alternative
        // and the sized repay are rounded by the same rule; it returns exactly
        // 1 here and null only for a non-positive debt, which this branch has
        // already excluded.
        const fullFraction = repayFractionOfDebt(borrowUsd, borrowUsd);
        const alternative: AdvisorAlternative | undefined =
          fullFraction === null
            ? undefined
            : {
                kind: "full_repay",
                plan: {
                  repayUsd: Math.round(borrowUsd),
                  repayAssetSymbol: score.dominantBorrowSymbol,
                  repayFraction: fullFraction,
                  targetHf,
                  // No debt left means no health factor, not a very large one.
                  projectedHf: null,
                  mode: "wallet_funded",
                },
              };
        return finish("EXIT", "warning", {
          repayPlan,
          exitPrefill: { protocol: score.protocol, kind: "full" },
          alternative,
        });
      }
      triggers.push(`target:hf=${targetHf}`);
      return finish("REDUCE", "warning", {
        repayPlan,
        exitPrefill: {
          protocol: score.protocol,
          kind: "partial",
          repayUsd: repayPlan.repayUsd,
          repayFraction,
        },
      });
    }
    // Two different reasons to arrive here, and they are not the same fact.
    // A sized repay that exists but does not pay for itself is NOT a health
    // factor at target, and labelling it as one would tell a later reader (and
    // the narrator) something untrue about the position.
    if (repayUsd > 0 && repayFraction !== null) {
      triggers.push("repay:below_floor");
    } else {
      // HF already at/above target - the score is driven by non-position risk.
      triggers.push("hf:above_target");
    }
  }

  // Rule 4 - approaching + protocol-specific stress: suggest a rebalance.
  const tvl = ctx?.protocolTvl7dPct ?? null;
  const protocolStressed =
    score.subScores.protocolSafety >= REBALANCE_SAFETY_GATE ||
    (tvl !== null && tvl <= PROTO_FLOOR / 2);
  if ((status === "approaching" || status === "outside") && protocolStressed) {
    const to = safestAlternativeProtocol(score.protocol, score.scoredCollateralSymbol);
    if (to) {
      if (score.subScores.protocolSafety >= REBALANCE_SAFETY_GATE) {
        triggers.push("protocol:safety");
      }
      if (tvl !== null && tvl <= PROTO_FLOOR / 2) triggers.push(`protocol:tvl${fmtPct(tvl)}`);
      const reason =
        tvl !== null && tvl <= PROTO_FLOOR / 2
          ? `${PROTOCOL_LABEL[score.protocol]} TVL is down ${fmtPct(Math.abs(tvl))} over 7 days while ${PROTOCOL_LABEL[to]} scores safer on protocol risk.`
          : `${PROTOCOL_LABEL[to]} carries a materially lower protocol-safety risk for the same collateral.`;
      return finish("REBALANCE", "warning", { rebalance: { toProtocol: to, reason } });
    }
  }

  // Rule 5 - approaching (or outside with no repay lever / no rebalance target).
  if (status === "approaching" || status === "outside") {
    return finish("MONITOR", "info");
  }

  // Rule 6 - within profile. HOLD is an affirmative all-clear, and a leg scored
  // without its market context has not been checked against the market at all,
  // so it stays visible as MONITOR - the same rule a degraded price feed gets.
  return finish(score.marketContextUnavailable ? "MONITOR" : "HOLD", "info");
}

/** Advise every leg of a wallet and derive the overall verdict. */
export function adviseWallet(
  scores: ActiveScore[],
  profile: RiskProfile,
  ctxByProtocol?: Partial<Record<Protocol, LegMarketContext>>,
  opts?: AdviseOptions,
): { overall: AdvisorOverall; recommendations: AdvisorRecommendation[] } {
  const recommendations = scores.map((s) =>
    adviseLeg(s, profile, ctxByProtocol?.[s.protocol], opts),
  );
  const worst = recommendations.reduce<AdvisorRecommendation | null>(
    (acc, r) => (acc === null || ACTION_SEVERITY[r.action] > ACTION_SEVERITY[acc.action] ? r : acc),
    null,
  );
  const action = worst?.action ?? "HOLD";
  const urgency = worst?.urgency ?? "info";
  // A degraded leg must never be summarised as an all-clear: the engine did
  // not verify those dollar magnitudes, so it cannot claim "all positions
  // within your risk profile". The headline says so explicitly.
  const degraded = scores.some((s) => s.usdValuesUnavailable);
  return {
    overall: { action, urgency, headline: overallHeadline(action, recommendations, degraded) },
    recommendations,
  };
}
