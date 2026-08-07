/**
 * ActiveAdapter — Watch-mode scoring (SYSTEM_ARCHITECTURE §3.6).
 * Chain readers supply position health; the SAME providers and scoring core
 * as prospective mode supply everything else. Mode = adapter swap, no fork.
 */

import { computeScore } from "../computeScore";
import { PROTOCOL_DEFILLAMA_SLUG, SYMBOL_TO_COINGECKO } from "../markets";
import type { AssetRiskProvider, SystemicRiskProvider } from "../providers/types";
import type { Protocol, ScoreResult, ScoringInput } from "../types";
import type { ActiveReading } from "./activeAave";

export interface ActiveReader {
  read(wallet: string): Promise<ActiveReading | null>;
}

export interface ActiveScore extends ScoreResult {
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
    /** Optional: notified when an individual reader throws (others continue). */
    private readonly onReaderError?: (error: unknown) => void,
  ) {}

  /** Scores every position the wallet holds across registered protocols. */
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

      const [assetRisk, systemicRisk] = await Promise.all([
        this.providers.assetRisk.getAssetRiskInput(coingeckoId ?? "ethereum"),
        this.providers.systemic.getSystemicRiskInput(
          PROTOCOL_DEFILLAMA_SLUG[reading.protocol],
        ),
      ]);

      const input: ScoringInput = {
        protocol: reading.protocol,
        positionHealth: reading.positionHealth,
        assetRisk,
        systemicRisk,
      };

      scores.push({
        ...computeScore(input),
        protocol: reading.protocol,
        wallet,
        healthFactor: reading.positionHealth.healthFactor,
        collateralValueUsd: reading.collateralValueUsd,
        borrowValueUsd: reading.borrowValueUsd,
        usdValuesUnavailable: reading.usdValuesUnavailable === true,
        scoredCollateralSymbol: assetRiskIsProxy ? "WETH (proxy)" : (symbol as string),
        assetRiskIsProxy,
      });
    }
    return scores;
  }
}
