/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PositionState } from "./types";
import type { Band } from "./live";

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

/**
 * The one place a risk band turns into pixels. Every band gets the same tint
 * recipe so the hue is the only variable: 10% fill, full-strength label, 25%
 * edge. Risk never appears as a solid fill, which is what keeps HIGH (orange)
 * from being mistaken for the brand accent on a button.
 *
 * UNKNOWN is a band, not an absence of one. A position we could not price is
 * not a safe position, and rendering it in the same neutral grey as chrome was
 * a silent safety claim.
 */
export const RISK_CHIP: Record<Band | "UNKNOWN", string> = {
  LOW: "bg-risk-low/10 text-risk-low border-risk-low/25",
  ELEVATED: "bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25",
  HIGH: "bg-risk-high/10 text-risk-high border-risk-high/25",
  CRITICAL: "bg-risk-critical/10 text-risk-critical border-risk-critical/25",
  // No fill: the grey is dark enough that a 10% wash of itself drags the label to
  // 4.26:1 on the lightest surface. Unfilled, it clears 4.5:1 on all four, and the
  // dashed edge carries the "not measured" distinction without relying on hue.
  UNKNOWN: "text-risk-unknown border-risk-unknown/40 border-dashed",
};

/**
 * The two halves of `RISK_CHIP` a chip does not use: a bare label colour and a
 * bare bar fill. Both existed as hand-written `x < 25 ? … : x < 50 ? …` chains
 * at nine call sites, and every one of those chains was missing its HIGH
 * branch — so a 50-74 score was painted CRITICAL red next to a chip reading
 * HIGH. Keeping the mapping in one table beside RISK_CHIP is what makes that
 * impossible to reintroduce: `Record<Band, …>` will not compile with a band
 * left out.
 *
 * A fill is a solid, so it is only ever used for a PROGRESS BAR, never for a
 * surface behind text. The "risk is always a tint" rule in index.css is about
 * chips and containers; a 6px bar has no text on it to fail contrast against.
 */
export const RISK_TEXT: Record<Band, string> = {
  LOW: "text-risk-low",
  ELEVATED: "text-risk-elevated",
  HIGH: "text-risk-high",
  CRITICAL: "text-risk-critical",
};

export const RISK_FILL: Record<Band, string> = {
  LOW: "bg-risk-low",
  ELEVATED: "bg-risk-elevated",
  HIGH: "bg-risk-high",
  CRITICAL: "bg-risk-critical",
};

/**
 * Composite score -> band, using the engine's cut points (arch §Bands, and
 * `bandFor` in packages/scoring/src/computeScore.ts).
 *
 * Deliberately NOT an import of `bandFor`: that module also pulls the four
 * sub-score scorers and the parameter tables, which would drag the scoring
 * engine into a browser bundle whose only question is which of four class
 * strings to emit. The `Band` TYPE is imported (see lib/live), so a band added
 * to the engine still breaks this file at compile time.
 */
export function bandOfScore(score: number): Band {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "ELEVATED";
  return "LOW";
}

/**
 * Health factor -> band. A DIFFERENT ramp from `bandOfScore` on purpose: a
 * health factor is a distance to liquidation (1.00 is the wall), not a 0-100
 * score, and the product has always cut it at 1.3 / 1.7. It never returns
 * HIGH, because these two cut points describe three states, not four.
 */
export function bandOfHealthFactor(healthFactor: number): Band {
  if (healthFactor < 1.3) return "CRITICAL";
  if (healthFactor < 1.7) return "ELEVATED";
  return "LOW";
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

/**
 * Whole-dollar USD, and the one place the "never render an unknown value as
 * $0" rule is enforced.
 *
 * That rule is a SAFETY requirement in a liquidation product — a position we
 * could not price is not a position worth nothing — and it was living as three
 * separate `fmtUsd` consts in three components that disagreed about it: one
 * returned the ellipsis, one took `number` and so could not express the case
 * at all, and three more call sites interpolated the arithmetic inline with no
 * null branch whatsoever. A rule enforced in three unconnected copies is a
 * rule that will be missing from the fourth.
 *
 * `en-US` is pinned rather than left to the host locale: the figures sit in
 * tabular columns beside `formatCurrency`, which is already pinned, and a
 * German browser rendering "1.234" next to "$1,234" is the kind of drift that
 * only shows up in a screenshot from a user.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "$…";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** $36.27m / $609.9k style compact USD (TVL figures). */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}b`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}
