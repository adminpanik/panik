/**
 * ProspectiveAdapter — Compass "what if" scoring (SYSTEM_ARCHITECTURE §3.6).
 * Builds a ScoringInput from a hypothetical position instead of chain reads;
 * the scoring core is shared with active mode.
 */

import { computeScore } from "../computeScore";
import { marketParams, PROTOCOL_DEFILLAMA_SLUG } from "../markets";
import { estimateHealthFactor, liquidationDrawdown } from "../prospective";
import type { AssetRiskProvider, SystemicRiskProvider } from "../providers/types";
import type { Protocol, ScoreResult, ScoringInput } from "../types";

export interface ProspectiveScenario {
  protocol: Protocol;
  /** Collateral asset symbol as listed in MARKETS (e.g. "WETH"). */
  collateralSymbol: string;
  collateralValueUsd: number;
  borrowValueUsd: number;
}

export interface ProspectiveProviders {
  assetRisk: AssetRiskProvider;
  systemic: SystemicRiskProvider;
}

export interface ProspectiveScore extends ScoreResult {
  /** Scenario starting health factor (null = no debt). */
  healthFactor: number | null;
  /** Collateral price drop that triggers liquidation (0–1, null = no debt). */
  liquidationDrawdown: number | null;
}

export async function scoreProspective(
  scenario: ProspectiveScenario,
  providers: ProspectiveProviders,
): Promise<ProspectiveScore> {
  const market = marketParams(scenario.protocol, scenario.collateralSymbol);
  if (!market) {
    throw new Error(
      `Unknown market: ${scenario.protocol} / ${scenario.collateralSymbol}`,
    );
  }

  const healthFactor = estimateHealthFactor(
    scenario.collateralValueUsd,
    scenario.borrowValueUsd,
    market.liquidationThreshold,
  );
  const currentLtv =
    scenario.collateralValueUsd > 0
      ? scenario.borrowValueUsd / scenario.collateralValueUsd
      : 0;

  const [assetRisk, systemicRisk] = await Promise.all([
    providers.assetRisk.getAssetRiskInput(market.coingeckoId),
    providers.systemic.getSystemicRiskInput(
      PROTOCOL_DEFILLAMA_SLUG[scenario.protocol],
    ),
  ]);

  const input: ScoringInput = {
    protocol: scenario.protocol,
    positionHealth: { healthFactor, currentLtv, maxLtv: market.maxLtv },
    assetRisk,
    systemicRisk,
  };

  return {
    ...computeScore(input),
    healthFactor,
    liquidationDrawdown: liquidationDrawdown(
      scenario.collateralValueUsd,
      scenario.borrowValueUsd,
      market.liquidationThreshold,
    ),
  };
}
