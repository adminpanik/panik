/**
 * OPEN-recommendation scanner. Sizes a hypothetical position per market to the
 * user's profile target HF, scores it with the SAME prospective scorer Compass
 * uses, keeps only scenarios within the profile, and ranks by yield with a
 * wallet-history familiarity boost. Pure orchestration - the caller injects the
 * async scorer so this module does no I/O of its own.
 */

import type { ProspectiveScenario, ProspectiveScore } from "../adapters/prospective";
import { MARKETS } from "../markets";
import { statusFor } from "../profile";
import { scoreProtocolSafety } from "../subscores/protocolSafety";
import type { Protocol, RiskProfile } from "../types";
import { fallbackSections } from "./fallback";
import { borrowForTargetHf, TARGET_HF } from "./repayMath";
import type { AdvisorRecommendation, OpenPlan, WalletInsights } from "./types";

/** Default sizing basis when the user has no stated budget (UI rescales). */
export const DEFAULT_BUDGET_USD = 10_000;

/** Rank boost (in APY points, fraction) for protocols/assets the wallet knows. */
export const FAMILIARITY_BOOST = 0.005;

export type ScenarioScorer = (scenario: ProspectiveScenario) => Promise<ProspectiveScore>;

/** protocol -> collateral symbol -> net supply APY (fraction), e.g. from DefiLlama. */
export type YieldTable = Partial<Record<Protocol, Record<string, number>>>;

/** Map profiler protocol slugs ("aave", "moonwell"...) onto our Protocol ids. */
function familiarProtocols(insights?: WalletInsights): Set<Protocol> {
  const out = new Set<Protocol>();
  if (!insights) return out;
  const slugs = insights.protocols.map((p) => p.toLowerCase());
  const matches: [Protocol, string][] = [
    ["aave_v3", "aave"],
    ["moonwell", "moonwell"],
    ["morpho", "morpho"],
    ["compound_v3", "compound"],
  ];
  for (const [protocol, needle] of matches) {
    if (slugs.some((s) => s.includes(needle))) out.add(protocol);
  }
  return out;
}

export interface FindOpportunitiesInput {
  wallet: string;
  profile: RiskProfile;
  scoreScenario: ScenarioScorer;
  /** Existing leg advice - EXIT legs suppress conflicting opportunities. */
  currentRecommendations?: AdvisorRecommendation[];
  yields?: YieldTable;
  insights?: WalletInsights;
  budgetUsd?: number;
  /** Max results (default 3). */
  limit?: number;
}

/**
 * Scan all supported markets for OPEN suggestions that fit the profile.
 * Scenario sizing: collateral = budget, borrow such that HF == profile target
 * (borrow = collateral * LT / targetHf).
 */
export async function findOpportunities(
  input: FindOpportunitiesInput,
): Promise<AdvisorRecommendation[]> {
  const {
    wallet,
    profile,
    scoreScenario,
    currentRecommendations = [],
    yields,
    insights,
    budgetUsd = DEFAULT_BUDGET_USD,
    limit = 3,
  } = input;

  const targetHf = TARGET_HF[profile];
  const familiar = familiarProtocols(insights);
  const exitLegs = currentRecommendations.filter((r) => r.action === "EXIT");
  const exitProtocols = new Set(exitLegs.map((r) => r.protocol));
  const exitSymbols = new Set(
    exitLegs.map((r) => r.numbers.scoredCollateralSymbol.replace(" (proxy)", "")),
  );

  const candidates: { rec: AdvisorRecommendation; rank: number }[] = [];

  for (const protocol of Object.keys(MARKETS) as Protocol[]) {
    // Don't suggest opening on a protocol the advisor is telling them to leave.
    if (exitProtocols.has(protocol)) continue;

    for (const [symbol, params] of Object.entries(MARKETS[protocol])) {
      // Don't suggest re-entering an asset flagged for exit elsewhere.
      if (exitSymbols.has(symbol)) continue;

      const collateralUsd = budgetUsd;
      const borrowUsd = borrowForTargetHf(collateralUsd, params.liquidationThreshold, targetHf);

      let scored: ProspectiveScore;
      try {
        scored = await scoreScenario({
          protocol,
          collateralSymbol: symbol,
          collateralValueUsd: collateralUsd,
          borrowValueUsd: borrowUsd,
        });
      } catch {
        continue; // provider hiccup on one market never drops the whole scan
      }

      if (statusFor(profile, scored.total) !== "within") continue;

      const apy = yields?.[protocol]?.[symbol] ?? null;
      const openPlan: OpenPlan = {
        protocol,
        collateralSymbol: symbol,
        collateralUsd,
        borrowUsd,
        projectedScore: scored.total,
        projectedHf: scored.healthFactor,
        apy,
      };

      const triggers = [`fit:${profile}`, `score:${scored.total}`];
      let rank = apy ?? 0;
      if (familiar.has(protocol)) {
        rank += FAMILIARITY_BOOST;
        triggers.push("history:familiar_protocol");
      }
      if (insights?.topCollateralSymbol === symbol) {
        rank += FAMILIARITY_BOOST;
        triggers.push("history:familiar_asset");
      }

      const rec: AdvisorRecommendation = {
        protocol,
        wallet,
        action: "OPEN",
        urgency: "info",
        triggers,
        openPlan,
        openPrefill: openPlan,
        sections: { position: "", market: "", recommendation: "", execution: "" },
        numbers: {
          total: scored.total,
          band: scored.band,
          healthFactor: scored.healthFactor,
          collateralValueUsd: collateralUsd,
          borrowValueUsd: borrowUsd,
          usdValuesUnavailable: false, // hypothetical scenario: sized in USD by construction
          subScores: scored.subScores,
          scoredCollateralSymbol: symbol,
        },
      };
      rec.sections = fallbackSections(rec);
      candidates.push({ rec, rank });
    }
  }

  candidates.sort(
    (a, b) =>
      b.rank - a.rank ||
      scoreProtocolSafety(a.rec.protocol) - scoreProtocolSafety(b.rec.protocol),
  );
  return candidates.slice(0, limit).map((c) => c.rec);
}
