/**
 * Advisor decision rules - deterministic, severity-ordered, first match wins.
 * Mirrors the calibrated escalation structure in params.ts (proximity floors,
 * crash regime) and the profile-relative status from profile.ts. The LLM never
 * participates here; it only narrates the result.
 */

import type { ActiveScore } from "../adapters/active";
import { MARKETS, marketParams } from "../markets";
import { ALERT_POLICY, CRASH_REGIME, LIQUIDATION_PROXIMITY_FLOORS, PROTO_FLOOR } from "../params";
import { statusFor } from "../profile";
import { scoreProtocolSafety } from "../subscores/protocolSafety";
import type { Protocol, RiskProfile } from "../types";
import {
  collateralFundedRepayUsdFloor,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  DELEVERAGE_FLASH_FEE_BPS,
  DELEVERAGE_GAS_UNITS,
  protocolRepayUsdFloor,
} from "./economicFloor";
import { fallbackSections, overallHeadline, PROTOCOL_LABEL, fmtPct } from "./fallback";
import {
  collateralFundedRepayToTargetHf,
  reduceToExitRatio,
  repayFractionOfDebt,
  repayToTargetDrawdown,
  TARGET_DRAWDOWN,
  TARGET_HF,
} from "./repayMath";
import {
  ACTION_SEVERITY,
  type AdvisorAction,
  type AdvisorAlternative,
  type AdvisorOverall,
  type AdvisorRecommendation,
  type LegMarketContext,
  type RepayPlan,
  type Urgency,
} from "./types";

/** Protocol-safety sub-score at/above which a rebalance is suggested. */
export const REBALANCE_SAFETY_GATE = 60;

/**
 * The MARKET half of CRASH_REGIME: a saturated sell-off, said without reference
 * to how close this particular position is to liquidation.
 *
 * An unmeasured asset risk never opens the gate - no reading is not a crash
 * reading, the same rule computeScore.ts holds for the score itself.
 */
export function crashMarketRegime(assetRisk: number | null): boolean {
  return assetRisk !== null && assetRisk >= CRASH_REGIME.assetRiskAtOrAbove;
}

/**
 * The full CRASH_REGIME conjunction: a saturated sell-off AND a position close
 * enough to liquidation that hours of further erosion reach it.
 *
 * The one copy. It was written out inline in rules 1 and 2 and the sizing in
 * rule 3 now asks a related question, which is three places for two gates to
 * drift apart in.
 */
function inCrashRegime(hf: number | null, assetRisk: number | null): boolean {
  return hf !== null && hf <= CRASH_REGIME.hfAtOrBelow && crashMarketRegime(assetRisk);
}

/**
 * Per-call inputs the engine cannot read for itself.
 *
 * `gasUsd` is the cost of one repay transaction, and it exists because the
 * economic floor is meaningless without it while the engine has no chain
 * access. Omitted, `economicFloor.DEFAULT_GAS_USD` stands in.
 */
export interface AdviseOptions {
  gasUsd?: number;
  /**
   * Swap slippage allowance for a collateral-funded repay, in bps. Omitted,
   * `economicFloor.DEFAULT_SWAP_SLIPPAGE_BPS` stands in, which is the same 1%
   * a fresh standing permission is granted with. A caller that has read the
   * user's actual permission should pass its figure so the quoted cost is the
   * one the transaction will be held to.
   */
  swapSlippageBps?: number;
}

/**
 * The same protection as the wallet-funded repay, funded by selling the user's
 * own collateral - or undefined when this leg cannot offer one.
 *
 * Three reasons to return undefined, and none of them is a number:
 *  1. the weighted liquidation threshold is unknown. The sizing divides by
 *     `targetHf - WLT`, so a missing WLT cannot be stood in for; a 0 would
 *     silently answer the wallet-funded question and under-size the repay, and
 *     any other guess would size a real transaction off a fabricated chain
 *     parameter. No reading, no option.
 *  2. the target is not reachable by selling collateral (`targetHf <= WLT`, or
 *     the position is already at target), which `collateralFundedRepayToTargetHf`
 *     reports as a repay of 0.
 *  3. the repay does not clear its own economic floor. This route pays a flash
 *     fee, swap slippage and several times the gas of a plain repay, so its
 *     floor is strictly higher than the wallet-funded one and a repay can clear
 *     that one while failing this.
 */
function collateralFundedPlan(
  score: ActiveScore,
  hf: number,
  borrowUsd: number,
  targetHf: number,
  targetDrawdown: number,
  opts?: AdviseOptions,
): RepayPlan | undefined {
  const wlt = score.weightedLiquidationThreshold;
  if (wlt === null || !Number.isFinite(wlt)) return undefined;
  const repayUsd = collateralFundedRepayToTargetHf(borrowUsd, hf, targetHf, wlt);
  if (repayUsd <= 0) return undefined;
  const slippageBps = opts?.swapSlippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
  const floorUsd = collateralFundedRepayUsdFloor(score.protocol, opts?.gasUsd, slippageBps);
  if (floorUsd === null || repayUsd < floorUsd) return undefined;
  // The fraction comes off the UNROUNDED repay, the same rule the wallet-funded
  // plan follows: a display rounding must not reach the executable amount.
  const repayFraction = repayFractionOfDebt(repayUsd, borrowUsd);
  if (repayFraction === null) return undefined;
  return {
    repayUsd: Math.round(repayUsd),
    repayAssetSymbol: score.dominantBorrowSymbol,
    repayFraction,
    targetHf,
    // Both routes end the position at the same target, so they survive the same
    // price drop and quote the same `targetDrawdown`. Passed in rather than
    // re-derived from `targetHf` so all three plans on this recommendation read
    // from the one `TARGET_DRAWDOWN` entry.
    targetDrawdown,
    // A repay that clears the whole debt leaves no health factor at all, which
    // is what a null says here and on `ActiveScore.healthFactor`. Echoing
    // `targetHf` would print a ratio the position will never hold.
    projectedHf: repayFraction >= 1 ? null : targetHf,
    mode: "collateral_funded",
    costs: {
      flashFeeBps: DELEVERAGE_FLASH_FEE_BPS[score.protocol],
      slippageBps,
      gasUnits: DELEVERAGE_GAS_UNITS[score.protocol],
    },
  };
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
  const candidates = (Object.keys(MARKETS) as Protocol[]).filter(
    (p) => p !== current && marketParams(p, collateralSymbol) !== null,
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
    if (inCrashRegime(hf, score.subScores.assetRisk)) {
      triggers.push("regime:crash");
    }
    return finish("EXIT", "critical", {
      exitPrefill: { protocol: score.protocol, kind: "full" },
    });
  }

  // Rule 2 - defensive crash-regime catch below the CRITICAL band boundary.
  if (inCrashRegime(hf, score.subScores.assetRisk)) {
    triggers.push("regime:crash");
    return finish("EXIT", "critical", {
      exitPrefill: { protocol: score.protocol, kind: "full" },
    });
  }

  // Rule 3 - HIGH band or outside the user's profile: partial repay to target.
  if (score.band === "HIGH" || status === "outside") {
    const targetHf = TARGET_HF[profile];
    // The same target, in the form the user is actually offered it: the price
    // drop the position survives after the repay. The dollars are sized from
    // this one; `targetHf` is its ratio form and rides along for the prose and
    // the projected health factor.
    const targetDrawdown = TARGET_DRAWDOWN[profile];
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
    const repayUsd = hf !== null ? repayToTargetDrawdown(borrowUsd, hf, targetDrawdown) : 0;
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
      // The same protection, funded by the user's own collateral rather than
      // their wallet. Emitted BESIDE the wallet-funded plan, never instead of
      // it: the choice between them turns on a wallet balance this engine
      // cannot see. See `AdvisorRecommendation.collateralFundedAlternative`.
      //
      // Scoped to the branch that already recommends a repay. A leg whose
      // wallet-funded repay falls below its floor falls through to MONITOR, and
      // hanging a sized deleverage off "no action needed yet" would be the
      // advisor recommending, in a second field, the thing its action says not
      // to do.
      const collateralFundedAlternative =
        hf !== null
          ? collateralFundedPlan(score, hf, borrowUsd, targetHf, targetDrawdown, opts)
          : undefined;
      if (collateralFundedAlternative) triggers.push("repay:collateral_funded_available");
      const repayPlan = {
        repayUsd: Math.round(repayUsd),
        // The leg's own debt asset, never an assumed stablecoin. Null when the
        // reader could not name it, which the prose then omits.
        repayAssetSymbol: score.dominantBorrowSymbol,
        repayFraction,
        targetHf,
        targetDrawdown,
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
      //
      // This branch is MEASURED UNREACHABLE from a live position, and it stayed
      // unreachable when the deleverager landed: collateral-funded sizing tops
      // out at 0.89891 against a gate of 0.9, with a supremum of exactly 0.9.
      // The numbers and the method are on REDUCE_TO_EXIT_RATIO in repayMath.ts
      // and on issue #28 - do not re-derive them from the algebra. It is kept
      // rather than deleted because the threshold is a live risk constant and
      // moving it is the founder's call, not this branch's.
      //
      // The threshold is regime-dependent. Only the MARKET half of the crash
      // gate is asked here, and that is not a looser reading of it: rule 2 has
      // already returned for everything inside the full conjunction, so the
      // proximity half is false by construction on every leg that gets this far.
      // A leg at HF 1.4 in a saturated sell-off is precisely the one this
      // distinction is for - too far out for rule 2, but in a market where the
      // repay it is about to be quoted may not hold.
      // NOT "regime:crash_market": `whyNow` in watch/alertMessage.ts matches its
      // rules with `startsWith`, and its crash rule is keyed on "regime:crash".
      // A name beginning with that prefix inherits the full-regime sentence,
      // which tells a leg at HF 1.8 that "liquidation is only a 44% drop away" —
      // the exact claim rule 2 already declined to make about it. The market
      // half of the gate must not borrow the whole gate's copy.
      const crashRegime = crashMarketRegime(score.subScores.assetRisk);
      if (crashRegime) triggers.push("regime:market_crash");
      if (repayUsd > reduceToExitRatio(crashRegime) * borrowUsd) {
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
                  targetDrawdown,
                  // No debt left means no health factor, not a very large one.
                  projectedHf: null,
                  mode: "wallet_funded",
                },
              };
        return finish("EXIT", "warning", {
          repayPlan,
          exitPrefill: { protocol: score.protocol, kind: "full" },
          alternative,
          collateralFundedAlternative,
        });
      }
      triggers.push(`target:hf=${targetHf}`);
      return finish("REDUCE", "warning", {
        repayPlan,
        collateralFundedAlternative,
        exitPrefill: {
          protocol: score.protocol,
          kind: "partial",
          repayUsd: repayPlan.repayUsd,
          repayFraction,
          // What the execution flow needs to state the achievable protection
          // when the wallet cannot fund the whole sized repay.
          borrowUsd,
          healthFactor: hf,
          collateralSymbol: score.scoredCollateralSymbol,
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
