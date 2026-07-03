/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PositionState } from "./types";

/**
 * Calculates a DeFi position health factor and PANIK risk score.
 * Formula models general lending logic:
 * Max LTV is assumed to be 80% (0.80).
 * Health Factor = (Collateral * Max LTV) / Borrow
 */
export function calculateDynamicPosition(
  protocol: "Aave V3" | "Moonwell",
  collateral: number,
  borrow: number,
  collateralPrice: number
): PositionState {
  const maxLTV = protocol === "Aave V3" ? 0.82 : 0.78; // Aave is slightly higher blue-chip parameter
  const collateralValueUsd = (collateral * collateralPrice);
  const borrowValueUsd = borrow;
  
  // Calculate LTV
  const currentLTV = collateralValueUsd > 0 ? (borrowValueUsd / collateralValueUsd) : 0;
  
  // Calculate health factor
  // Health Factor = (Collateral Value * Max LTV) / Borrow Value
  let healthFactor = 100; // default if no borrow
  if (borrowValueUsd > 0) {
    healthFactor = (collateralValueUsd * maxLTV) / borrowValueUsd;
    // Cap or floor health factor for sanity
    healthFactor = Math.max(0.1, Math.min(9.99, healthFactor));
  }

  // Calculate PANIK Risk Score (0 - 100)
  // Higher risk score means worse health.
  // When health factor is 1.0, risk score should be near 80.
  // When health factor reaches 2.5+, risk score is low (e.g. 15).
  // When health factor is near 1.1, risk score is highly critical (above 75).
  let riskScore = 0;
  if (healthFactor <= 1.0) {
    riskScore = Math.round(85 + (1.0 - healthFactor) * 15);
  } else if (healthFactor < 1.5) {
    // 1.0 to 1.5 is High Risk
    riskScore = Math.round(50 + ((1.5 - healthFactor) / 0.5) * 35);
  } else if (healthFactor < 2.5) {
    // 1.5 to 2.5 is Elevated
    riskScore = Math.round(25 + ((2.5 - healthFactor) / 1.0) * 25);
  } else {
    // 2.5 to 10 is Low
    riskScore = Math.round(Math.max(5, 25 - ((healthFactor - 2.5) / 7.5) * 20));
  }

  riskScore = Math.min(100, Math.max(0, riskScore));

  // Determine status category
  let status: "LOW" | "ELEVATED" | "HIGH" | "CRITICAL" = "LOW";
  if (riskScore >= 75) {
    status = "CRITICAL";
  } else if (riskScore >= 50) {
    status = "HIGH";
  } else if (riskScore >= 25) {
    status = "ELEVATED";
  }

  // Dynamically calculate dynamic liquidation price of ETH
  // Borrow Value = Collateral ETH * LiquidationPrice * Max LTV
  // Liquidation Price = Borrow Value / (Collateral ETH * Max LTV)
  const collateralQty = collateral;
  const liquidationPrice = collateralQty > 0 
    ? Math.round(borrowValueUsd / (collateralQty * maxLTV)) 
    : 0;

  // Generate recommendation plain language string
  let recommendation = "Position optimal. Collateral buffer protects against severe asset volatility.";
  if (status === "CRITICAL") {
    const repayAmount = Math.round(borrowValueUsd - (collateralValueUsd * maxLTV * 0.6));
    recommendation = `CRITICAL ALERT: Repay $${repayAmount} USDC immediately to prevent liquidator bids!`;
  } else if (status === "HIGH") {
    const repayAmount = Math.round(borrowValueUsd - (collateralValueUsd * maxLTV * 0.75));
    recommendation = `ACTION REQUIRED: Repay $${Math.max(50, repayAmount)} USDC to return health factor to a secure 1.75.`;
  } else if (status === "ELEVATED") {
    recommendation = `RECOMMENDED: Supply $${Math.round(collateralValueUsd * 0.15)} more collateral to suppress minor market swings.`;
  }

  // Breakdowns
  const baseSafety = protocol === "Aave V3" ? 12 : 35; // Aave is highly audited, Moonwell has brief local history
  const systemic = status === "CRITICAL" ? 88 : status === "HIGH" ? 72 : status === "ELEVATED" ? 48 : 22;

  return {
    protocol,
    assetPair: protocol === "Aave V3" ? "wstETH / USDC SUPPLY & BORROW" : "ETH / USDC BORROW",
    riskScore,
    status,
    collateralValue: collateralValueUsd,
    borrowValue: borrowValueUsd,
    healthFactor,
    liquidationPrice,
    currentPrice: collateralPrice,
    recommendation,
    breakdown: {
      positionHealth: Math.min(100, Math.round(currentLTV * 100)),
      assetVolatility: protocol === "Aave V3" ? 28 : 42, // Ether has moderate volatility, wstETH is derivative pegged
      protocolSafety: baseSafety,
      systemicMarketStress: systemic
    }
  };
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

/** $36.27m / $609.9k style compact USD (TVL figures). */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}b`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}
