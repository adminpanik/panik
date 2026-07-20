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
import { fallbackSections, overallHeadline, PROTOCOL_LABEL, fmtPct } from "./fallback";
import { REDUCE_TO_EXIT_RATIO, repayToTargetHf, TARGET_HF } from "./repayMath";
import {
  ACTION_SEVERITY,
  type AdvisorAction,
  type AdvisorOverall,
  type AdvisorRecommendation,
  type LegMarketContext,
  type Urgency,
} from "./types";

/** Protocol-safety sub-score at/above which a rebalance is suggested. */
export const REBALANCE_SAFETY_GATE = 60;

function numbersOf(score: ActiveScore): AdvisorRecommendation["numbers"] {
  return {
    total: score.total,
    band: score.band,
    healthFactor: score.healthFactor,
    collateralValueUsd: score.collateralValueUsd,
    borrowValueUsd: score.borrowValueUsd,
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
): AdvisorRecommendation {
  const status = statusFor(profile, score.total);
  const triggers: string[] = [`band:${score.band}`, `profile:${status}`];
  const hf = score.healthFactor;
  const hasDebt = hf !== null && score.borrowValueUsd >= ALERT_POLICY.minBorrowUsd;

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
      score.subScores.assetRisk >= CRASH_REGIME.assetRiskAtOrAbove
    ) {
      triggers.push("regime:crash");
    }
    return finish("EXIT", "critical", {
      exitPrefill: { protocol: score.protocol, kind: "full" },
    });
  }

  // Rule 2 - defensive crash-regime catch below the CRITICAL band boundary.
  if (
    hf !== null &&
    hf <= CRASH_REGIME.hfAtOrBelow &&
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
    const repayUsd = hf !== null ? repayToTargetHf(score.borrowValueUsd, hf, targetHf) : 0;
    if (repayUsd > 0) {
      const repayPlan = {
        repayUsd: Math.round(repayUsd),
        repayAssetSymbol: "USDC",
        targetHf,
        projectedHf: targetHf,
        mode: "wallet_funded" as const,
      };
      // Repaying ~everything IS a full exit - promote.
      if (repayUsd > REDUCE_TO_EXIT_RATIO * score.borrowValueUsd) {
        triggers.push("promoted:reduce_to_exit");
        return finish("EXIT", "warning", {
          repayPlan,
          exitPrefill: { protocol: score.protocol, kind: "full" },
        });
      }
      triggers.push(`target:hf=${targetHf}`);
      return finish("REDUCE", "warning", {
        repayPlan,
        exitPrefill: { protocol: score.protocol, kind: "partial", repayUsd: repayPlan.repayUsd },
      });
    }
    // HF already at/above target - the score is driven by non-position risk.
    triggers.push("hf:above_target");
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

  // Rule 6 - within profile.
  return finish("HOLD", "info");
}

/** Advise every leg of a wallet and derive the overall verdict. */
export function adviseWallet(
  scores: ActiveScore[],
  profile: RiskProfile,
  ctxByProtocol?: Partial<Record<Protocol, LegMarketContext>>,
): { overall: AdvisorOverall; recommendations: AdvisorRecommendation[] } {
  const recommendations = scores.map((s) => adviseLeg(s, profile, ctxByProtocol?.[s.protocol]));
  const worst = recommendations.reduce<AdvisorRecommendation | null>(
    (acc, r) => (acc === null || ACTION_SEVERITY[r.action] > ACTION_SEVERITY[acc.action] ? r : acc),
    null,
  );
  const action = worst?.action ?? "HOLD";
  const urgency = worst?.urgency ?? "info";
  return {
    overall: { action, urgency, headline: overallHeadline(action, recommendations) },
    recommendations,
  };
}
