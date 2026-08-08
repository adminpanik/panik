/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ProtocolStats {
  name: string;
  logo: string;
  badge: "Blue-Chip" | "Native" | "Emerging";
  tvl: string;
  auditCount: number;
  exploitHistory: string;
  marketShare: string;
  description: string;
}

export interface RiskBreakdown {
  positionHealth: number; // 0 - 100 (where 100 is high risk/near liquidation)
  assetVolatility: number; // 0 - 100
  protocolSafety: number; // 0 - 100 (exploit history, code complexity)
  systemicMarketStress: number; // 0 - 100
}

export interface PositionState {
  protocol: "Aave V3" | "Moonwell" | "Morpho" | "Compound V3";
  assetPair: string;
  riskScore: number; // calculated overall score (0 - 100)
  status: "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";
  collateralValue: number;
  borrowValue: number;
  /**
   * Null when there is no debt — the same sentinel the engine uses. It was
   * `number`, which forced the Watch simulator to substitute 9.99 for a
   * debt-free position and made the no-debt branch of `liquidationOutlook`
   * unreachable on that surface.
   */
  healthFactor: number | null;
  liquidationPrice: number;
  currentPrice: number;
  recommendation: string;
  breakdown: RiskBreakdown;
}

export interface WaitlistEntry {
  email: string;
  timestamp: string;
  position: number;
  source: string;
}
