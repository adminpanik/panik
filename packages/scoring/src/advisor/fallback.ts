/**
 * Deterministic 4-section advice templates - the LLM-off path.
 * Every recommendation ALWAYS carries these; the narrator may replace the
 * prose but the engine never depends on the LLM being available.
 */

import { drawdownToLiquidation, formatDrawdownPct } from "../prospective";
import type {
  AdvisorAction,
  AdvisorRecommendation,
  AdvisorSections,
  LegMarketContext,
  RepayPlan,
} from "./types";

export const PROTOCOL_LABEL: Record<string, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/** Dollar amounts we could not establish render as a dash, never as "$0". */
export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "$—";
  const abs = Math.abs(n);
  const rounded =
    abs >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(abs >= 1 ? 0 : 2);
  return `$${rounded}`;
}

/**
 * The debt asset, named only when the reader actually read it: " USDC", or
 * " of USDC" with a prefix, or nothing at all. The symbol used to be hardcoded,
 * and this sentence is where a user learns which token to hold before the
 * repay - so naming the wrong one is worse than naming none.
 */
function repayAssetPhrase(plan: RepayPlan, prefix = ""): string {
  // Truthiness, not `!== null`: this prose is also rendered from a plan that
  // arrived over the wire, and a plan serialised before the field existed drops
  // it entirely. "of undefined debt" is the one outcome worse than silence.
  return plan.repayAssetSymbol ? `${prefix} ${plan.repayAssetSymbol}` : "";
}

export function fmtHf(hf: number | null): string {
  return hf === null ? "no debt" : hf.toFixed(2);
}

export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Name the sub-score (or TVL signal) most responsible for the current score. */
export function dominantDriver(
  rec: Pick<AdvisorRecommendation, "numbers">,
  ctx?: LegMarketContext,
): string {
  const s = rec.numbers.subScores;
  // A null sub-score was not measured on this read. It is skipped rather than
  // ranked, because ranking it needs a number and every number available is a
  // claim: 0 would name a calm market the engine never saw. Order is load
  // bearing - the sort is stable, so ties resolve to the earlier driver.
  const drivers = (
    [
      [`position health (${Math.round(s.positionHealth)}/100)`, s.positionHealth],
      s.assetRisk === null
        ? null
        : [`asset volatility risk (${Math.round(s.assetRisk)}/100)`, s.assetRisk],
      [`protocol safety (${Math.round(s.protocolSafety)}/100)`, s.protocolSafety],
      s.systemicRisk === null
        ? null
        : [`systemic TVL stress (${Math.round(s.systemicRisk)}/100)`, s.systemicRisk],
    ] as ([string, number] | null)[]
  ).filter((d): d is [string, number] => d !== null);
  drivers.sort((a, b) => b[1] - a[1]);
  let out = drivers[0]?.[0] ?? "composite risk";
  const tvl = ctx?.protocolTvl7dPct;
  if (typeof tvl === "number" && tvl < 0) {
    out += `; protocol TVL ${fmtPct(tvl)} over 7d`;
  }
  return out;
}

function positionSection(rec: AdvisorRecommendation): string {
  const { numbers, protocol } = rec;
  const label = PROTOCOL_LABEL[protocol] ?? protocol;
  const dd = drawdownToLiquidation(numbers.healthFactor);
  // `formatDrawdownPct`, not `fmtPct`: this figure is also rendered by the
  // Advisor card's numbers strip, and two rounding policies on one card printed
  // one health factor as two different drops.
  const liq =
    dd === null
      ? "No debt, so no liquidation risk."
      : `A ${formatDrawdownPct(dd)} ${numbers.scoredCollateralSymbol} price drop would trigger liquidation.`;
  // Degraded: the health factor and LTV are ratios and remain exact, only the
  // dollar magnitudes are unknown. Say that, rather than printing "$0".
  const size = numbers.usdValuesUnavailable
    ? `Your ${label} position's USD values are unavailable (degraded price feed) - the health factor below is still exact`
    : `Your ${label} position holds ${fmtUsd(numbers.collateralValueUsd)} collateral against ` +
      `${fmtUsd(numbers.borrowValueUsd)} debt`;
  return (
    `${size} (health factor ${fmtHf(numbers.healthFactor)}, ` +
    `PANIK score ${numbers.total} - ${numbers.band}). ${liq}`
  );
}

function marketSection(rec: AdvisorRecommendation, ctx?: LegMarketContext): string {
  const s = rec.numbers.subScores;
  // Say which terms are missing rather than letting the sentence imply the
  // score weighed all four. The composite is renormalised over the measured
  // ones (computeScore.ts), so it is a real score of less information.
  const unmeasured = [
    s.assetRisk === null ? "asset volatility" : null,
    s.systemicRisk === null ? "systemic TVL" : null,
  ].filter((x): x is string => x !== null);
  const caveat =
    unmeasured.length > 0
      ? ` Market data for ${unmeasured.join(" and ")} was unavailable on this read, so the score covers only the terms that were measured.`
      : "";
  return `The score is being driven by ${dominantDriver(rec, ctx)}.${caveat}`;
}

function recommendationSection(rec: AdvisorRecommendation): string {
  const label = PROTOCOL_LABEL[rec.protocol] ?? rec.protocol;
  switch (rec.action) {
    case "EXIT":
      return `Exit this ${label} position in full. The risk level no longer fits any profile band worth holding through.`;
    case "REDUCE": {
      const p = rec.repayPlan;
      if (!p) return `Reduce this ${label} position.`;
      return (
        `Repay ~${fmtUsd(p.repayUsd)} of${repayAssetPhrase(p)} debt on ${label} to lift your ` +
        `health factor from ${fmtHf(rec.numbers.healthFactor)} to ${p.targetHf.toFixed(2)}.`
      );
    }
    case "REBALANCE": {
      const to = rec.rebalance ? (PROTOCOL_LABEL[rec.rebalance.toProtocol] ?? rec.rebalance.toProtocol) : "a safer protocol";
      return `Consider moving this position from ${label} to ${to}. ${rec.rebalance?.reason ?? ""}`.trim();
    }
    case "MONITOR":
      return `No action needed yet, but this ${label} position is approaching your risk threshold - watch it closely.`;
    case "OPEN": {
      const p = rec.openPlan;
      if (!p) return `Open a position on ${label}.`;
      const borrow = p.borrowUsd > 0 ? `, borrow ~${fmtUsd(p.borrowUsd)}` : " (no borrow)";
      const apy = p.apy !== null ? `, ~${fmtPct(p.apy)} net APY` : "";
      return (
        `Deposit ~${fmtUsd(p.collateralUsd)} ${p.collateralSymbol} on ${label}${borrow}. ` +
        `Projected PANIK score ${p.projectedScore}${apy}.`
      );
    }
    case "HOLD":
      return `Hold. This ${label} position sits comfortably within your risk profile.`;
  }
}

function executionSection(rec: AdvisorRecommendation): string {
  const label = PROTOCOL_LABEL[rec.protocol] ?? rec.protocol;
  switch (rec.action) {
    case "EXIT":
      return `The Exit button pre-selects this ${label} position for a single atomic transaction you sign yourself - debt repaid, collateral withdrawn, proceeds returned as USDC.`;
    case "REDUCE": {
      const p = rec.repayPlan;
      const amt = p
        ? `~${fmtUsd(p.repayUsd)}${repayAssetPhrase(p, " of")}`
        : "the computed amount";
      return `The Reduce button pre-fills a partial exit repaying ${amt} on ${label}; you sign the transaction yourself.`;
    }
    case "REBALANCE":
      return `Exit here first (Exit button), then use the pre-filled Open flow on the safer protocol - two transactions you sign yourself.`;
    case "OPEN":
      return `The Open button pre-fills this position - approve, supply${rec.openPlan && rec.openPlan.borrowUsd > 0 ? ", borrow" : ""} - each step signed from your own wallet on Base.`;
    case "MONITOR":
      return `No transaction needed. Watch alerts will fire if it crosses your threshold.`;
    case "HOLD":
      return `No transaction needed.`;
  }
}

/** Build the deterministic 4 sections for a recommendation. */
export function fallbackSections(
  rec: AdvisorRecommendation,
  ctx?: LegMarketContext,
): AdvisorSections {
  return {
    position: positionSection(rec),
    market: marketSection(rec, ctx),
    recommendation: recommendationSection(rec),
    execution: executionSection(rec),
  };
}

/**
 * One-line overall headline for the report banner / popup widget.
 *
 * `degraded` = at least one leg was scored without usable USD prices. The
 * engine has NOT verified those positions' dollar magnitudes, so the calm
 * "all positions within your risk profile" claim would be an affirmative
 * all-clear it cannot support — it is replaced, never merely appended to.
 */
export function overallHeadline(
  action: AdvisorAction,
  recs: AdvisorRecommendation[],
  degraded = false,
): string {
  const of = (a: AdvisorAction) => recs.filter((r) => r.action === a);
  if (degraded) {
    const legs = recs
      .filter((r) => r.numbers.usdValuesUnavailable)
      .map((r) => PROTOCOL_LABEL[r.protocol] ?? r.protocol)
      .join(", ");
    // The calm actions carry an implicit all-clear, so they are REPLACED.
    if (action === "HOLD" || action === "MONITOR") {
      return `Price feed degraded on ${legs} - health factors still scored, position sizes unverified.`;
    }
    // The alarming ones keep their severity and gain the caveat.
    return `${overallHeadline(action, recs)} Prices degraded on ${legs} - position sizes unverified.`;
  }
  switch (action) {
    case "EXIT": {
      const legs = of("EXIT").map((r) => PROTOCOL_LABEL[r.protocol] ?? r.protocol);
      return `Critical risk: exit recommended on ${legs.join(", ")}.`;
    }
    case "REDUCE": {
      const r = of("REDUCE")[0];
      const amt = r?.repayPlan ? ` - repay ~${fmtUsd(r.repayPlan.repayUsd)}` : "";
      const where = r ? (PROTOCOL_LABEL[r.protocol] ?? r.protocol) : "position";
      return `Risk above your profile: reduce your ${where} exposure${amt}.`;
    }
    case "REBALANCE":
      return `Consider rebalancing to a safer protocol.`;
    case "MONITOR":
      return `Positions approaching your risk threshold - monitoring closely.`;
    default:
      return `All positions within your risk profile.`;
  }
}
