/**
 * Bridge from the deterministic wallet profiler to the Advisor's slim
 * personalization view. Pure projection - no new judgment happens here.
 */

import type { ProfileClassification } from "../classify/types";
import type { WalletInsights } from "./types";

export function insightsFromClassification(c: ProfileClassification): WalletInsights {
  return {
    profile: c.profile,
    archetype: c.archetype,
    protocols: c.features.protocols,
    topProtocol: c.features.topProtocol,
    topCollateralSymbol: c.features.topCollateralSymbol,
    liquidations: c.features.liquidations,
    lendingAgeDays: c.features.lendingAgeDays,
    borrowToDepositRatio: c.features.borrowToDepositRatio,
    stableBorrowPct: c.features.stableBorrowPct,
    daysSinceLastActivity: c.features.daysSinceLastActivity,
    confidence: c.confidence,
  };
}
