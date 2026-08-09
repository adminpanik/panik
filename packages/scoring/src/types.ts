/**
 * Scoring core types. The core is pure: it never fetches data.
 * Adapters (prospective = Compass scenario, active = chain reads) build
 * a ScoringInput and call computeScore. See SYSTEM_ARCHITECTURE.md §3.6.
 */

export type Protocol = "aave_v3" | "moonwell" | "morpho" | "compound_v3";

export type Band = "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export type ProfileStatus = "within" | "approaching" | "outside";

export interface PositionHealthInput {
  /**
   * Protocol health factor. `null` = position has no debt.
   * (Adapters must map Aave's no-debt sentinel `type(uint256).max` to null —
   * never feed the raw sentinel into the formula.)
   */
  healthFactor: number | null;
  /** Current loan-to-value, 0–1 (e.g. 0.62). */
  currentLtv: number;
  /** Protocol max LTV for the collateral, 0–1 (e.g. 0.82 on Aave). */
  maxLtv: number;
}

interface AssetRiskReturns {
  /** Last 30 daily returns of the collateral asset (fractional, e.g. 0.021). */
  dailyReturns30d: number[];
  /** Last 30 daily returns of BTC over the same window. */
  btcReturns30d: number[];
}

/**
 * The drawdown term is 35% of `S_asset_risk` and gates `CRASH_REGIME` at 60,
 * so it must never default to "no drawdown" just because a caller forgot to
 * supply it. Making both shapes optional let
 * `scoreAssetRisk({dailyReturns30d: [], btcReturns30d: []})` compile under
 * strict and silently return 0 risk on 35% of the sub-score — hence the union:
 * one of the two drawdown sources is REQUIRED at the type level.
 */
export type AssetRiskInput = AssetRiskReturns &
  (
    | {
        /**
         * Ordered 90-day daily closes of the collateral asset (oldest →
         * newest). Preferred input: only an ordered series yields a true
         * peak-to-trough max drawdown. Providers fetch the full series
         * already — always pass it. The extremes may accompany it (they are
         * ignored) so a caller can migrate one field at a time.
         */
        prices90d: number[];
        maxPrice90d?: number;
        minPrice90d?: number;
      }
    | {
        prices90d?: undefined;
        /**
         * @deprecated 90-day price extremes — order-blind fallback used only
         * when `prices90d` is absent. (max − min) / max is an UPPER BOUND on
         * the real drawdown: it cannot tell a 2x rally from a 50% crash.
         */
        maxPrice90d: number;
        /** @deprecated See `maxPrice90d`. */
        minPrice90d: number;
      }
  );

export interface SystemicRiskInput {
  /** DeFi lending sector TVL now and 7 days ago (USD). */
  sectorTvlNow: number;
  sectorTvl7dAgo: number;
  /** This protocol's TVL now and 7 days ago (USD). */
  protocolTvlNow: number;
  protocolTvl7dAgo: number;
}

export interface ScoringInput {
  protocol: Protocol;
  positionHealth: PositionHealthInput;
  assetRisk: AssetRiskInput;
  systemicRisk: SystemicRiskInput;
}

export interface SubScores {
  positionHealth: number;
  assetRisk: number;
  protocolSafety: number;
  systemicRisk: number;
}

export interface ScoreResult {
  /** Composite Panik Risk Score, integer 0–100. Higher = more risk. */
  total: number;
  band: Band;
  subScores: SubScores;
}

/**
 * Sub-scores of a leg whose market-context providers may have failed on this
 * read. `null` means NOT MEASURED and is never 0: "unmeasured" and "measured,
 * and calm" are different facts, and rendering the first as the second is how a
 * degraded feed becomes an all-clear. Only the two provider-fed terms can be
 * null — position health and protocol safety need no I/O.
 */
export interface DegradableSubScores
  extends Omit<SubScores, "assetRisk" | "systemicRisk"> {
  assetRisk: number | null;
  systemicRisk: number | null;
}

/** `ScoringInput` where either market-context provider may have been unavailable. */
export interface DegradedScoringInput
  extends Omit<ScoringInput, "assetRisk" | "systemicRisk"> {
  assetRisk: AssetRiskInput | null;
  systemicRisk: SystemicRiskInput | null;
}

export interface DegradedScoreResult extends Omit<ScoreResult, "subScores"> {
  subScores: DegradableSubScores;
}
