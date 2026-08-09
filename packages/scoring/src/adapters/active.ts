/**
 * ActiveAdapter — Watch-mode scoring (SYSTEM_ARCHITECTURE §3.6).
 * Chain readers supply position health; the SAME providers and scoring core
 * as prospective mode supply everything else. Mode = adapter swap, no fork.
 */

import { computeScoreFromAvailable } from "../computeScore";
import { PROTOCOL_DEFILLAMA_SLUG, SYMBOL_TO_COINGECKO } from "../markets";
import type { AssetRiskProvider, SystemicRiskProvider } from "../providers/types";
import type {
  AssetRiskInput,
  DegradableSubScores,
  DegradedScoreResult,
  Protocol,
  SystemicRiskInput,
} from "../types";
import type { ActiveReading } from "./activeAave";

export interface ActiveReader {
  read(wallet: string): Promise<ActiveReading | null>;
}

export interface ActiveScore extends Omit<DegradedScoreResult, "subScores"> {
  protocol: Protocol;
  wallet: string;
  healthFactor: number | null;
  /** null when the reader could not establish a USD denomination. */
  collateralValueUsd: number | null;
  /** null when the reader could not establish a USD denomination. */
  borrowValueUsd: number | null;
  /**
   * True when the dollar magnitudes are withheld because a price input was
   * missing or stale. The composite score, band and HF are unaffected — see
   * `ActiveReading.usdValuesUnavailable`.
   */
  usdValuesUnavailable: boolean;
  /**
   * `assetRisk` / `systemicRisk` are null when this leg's provider lookup
   * failed. Never 0 — see `DegradableSubScores`.
   */
  subScores: DegradableSubScores;
  /**
   * True when a market-context provider threw for THIS leg. The composite is
   * then weighted over the terms that were measured; position health (exact,
   * from the chain read) and protocol safety (a static table) are unaffected,
   * and so is every other leg of the wallet.
   */
  marketContextUnavailable: boolean;
  /** Asset whose market risk was scored (dominant collateral). */
  scoredCollateralSymbol: string;
  /** True when collateral discovery failed and WETH was used as proxy. */
  assetRiskIsProxy: boolean;
}

export class ActiveAdapter {
  constructor(
    private readonly readers: ActiveReader[],
    private readonly providers: {
      assetRisk: AssetRiskProvider;
      systemic: SystemicRiskProvider;
    },
    /**
     * Optional: notified when an individual reader OR one leg's market-context
     * provider throws. Every such failure is isolated, so this callback is the
     * only place the failure is visible — never let it stay silent.
     */
    private readonly onReaderError?: (error: unknown) => void,
  ) {}

  /**
   * One leg's market context. Each provider is settled on its own: a bad
   * CoinGecko id (the `moonwell` vs `moonwell-artemis` incident) must cost that
   * leg its asset-risk term, not the wallet its entire score.
   */
  private async marketContext(
    coingeckoId: string,
    protocol: Protocol,
  ): Promise<{ assetRisk: AssetRiskInput | null; systemicRisk: SystemicRiskInput | null }> {
    const [asset, systemic] = await Promise.allSettled([
      this.providers.assetRisk.getAssetRiskInput(coingeckoId),
      this.providers.systemic.getSystemicRiskInput(PROTOCOL_DEFILLAMA_SLUG[protocol]),
    ]);
    if (asset.status === "rejected") this.onReaderError?.(asset.reason);
    if (systemic.status === "rejected") this.onReaderError?.(systemic.reason);
    return {
      assetRisk: asset.status === "fulfilled" ? asset.value : null,
      systemicRisk: systemic.status === "fulfilled" ? systemic.value : null,
    };
  }

  /**
   * Scores every position the wallet holds across registered protocols.
   * Never throws: both failure surfaces — the chain/API readers and the
   * market-context providers — are isolated to the leg they belong to.
   */
  async scoreWallet(wallet: string): Promise<ActiveScore[]> {
    // Per-reader isolation: a single protocol's failure (e.g. the Morpho API
    // being down) must not drop the other protocols' legs for this wallet.
    const settled = await Promise.allSettled(this.readers.map((r) => r.read(wallet)));
    const readings = settled.map((s) => {
      if (s.status === "fulfilled") return s.value;
      this.onReaderError?.(s.reason);
      return null;
    });
    const scores: ActiveScore[] = [];

    for (const reading of readings) {
      if (!reading) continue;

      const symbol = reading.dominantCollateralSymbol;
      const coingeckoId = symbol ? SYMBOL_TO_COINGECKO[symbol] : undefined;
      const assetRiskIsProxy = !coingeckoId;

      const { assetRisk, systemicRisk } = await this.marketContext(
        coingeckoId ?? "ethereum",
        reading.protocol,
      );

      scores.push({
        ...computeScoreFromAvailable({
          protocol: reading.protocol,
          positionHealth: reading.positionHealth,
          assetRisk,
          systemicRisk,
        }),
        protocol: reading.protocol,
        wallet,
        healthFactor: reading.positionHealth.healthFactor,
        collateralValueUsd: reading.collateralValueUsd,
        borrowValueUsd: reading.borrowValueUsd,
        usdValuesUnavailable: reading.usdValuesUnavailable === true,
        marketContextUnavailable: assetRisk === null || systemicRisk === null,
        scoredCollateralSymbol: assetRiskIsProxy ? "WETH (proxy)" : (symbol as string),
        assetRiskIsProxy,
      });
    }
    return scores;
  }
}
