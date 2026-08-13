/**
 * The four sub-scores' names, their published shares of the composite, and the
 * one sentence that states those shares. Naming policy for a domain value is a
 * product decision, and `packages/scoring` owns the value, so it owns the name.
 *
 * Three surfaces used to hand-type these words: the Telegram alert copy
 * (`watch/alertMessage.ts`), the app's `RISK_DRIVERS` table, and `RiskDial`'s
 * tooltip - which also hard-coded "Weighted 40/25/20/15" beside an engine
 * constant that could be re-weighted without it. A dial announcing "asset risk"
 * beside a panel labelling the same figure "Asset volatility" is one quantity
 * under two names, and the name a screen reader gets is the one nothing else
 * can check.
 *
 * Deliberately leaf-shaped: the only runtime import is `params.ts`, which has
 * none of its own. That keeps the module deep-importable from the browser
 * bundle, which the package barrel is not (it reaches viem through the chain
 * adapters).
 */

import { COMPOSITE_WEIGHTS } from "./params";
import type { SubScores } from "./types";

/** A sub-score's key, which is the engine's own name for it. */
export type DriverKey = keyof SubScores;

/**
 * The product's label for each sub-score, in weight order.
 *
 * "Market stress", not "Pool conditions" or "systemic risk": the quantity is
 * market-wide (sector TVL flows, broad drawdowns), and calling it a pool
 * property was a third name for something that is not a pool.
 *
 * Sentence case, because these are labels rather than clauses; a surface that
 * needs one mid-sentence keeps the capital rather than lower-casing it into a
 * second spelling.
 */
export const DRIVER_LABEL: Record<DriverKey, string> = {
  positionHealth: "Position health",
  assetRisk: "Asset volatility",
  protocolSafety: "Protocol risk",
  systemicRisk: "Market stress",
};

/** Weight order, from `DRIVER_LABEL`, so no caller re-lists the four keys. */
export const DRIVER_KEYS = Object.keys(DRIVER_LABEL) as DriverKey[];

/**
 * Each driver's share of the composite as a whole percent. Rounded here rather
 * than at the call sites: the weights are fractions and `0.15 * 100` is not a
 * number anyone wants printed.
 */
export const DRIVER_WEIGHT_PCT: Record<DriverKey, number> = {
  positionHealth: Math.round(COMPOSITE_WEIGHTS.positionHealth * 100),
  assetRisk: Math.round(COMPOSITE_WEIGHTS.assetRisk * 100),
  protocolSafety: Math.round(COMPOSITE_WEIGHTS.protocolSafety * 100),
  systemicRisk: Math.round(COMPOSITE_WEIGHTS.systemicRisk * 100),
};

/**
 * How the composite is weighted, in one sentence, built from the weights
 * themselves.
 *
 * A HOVER fact, never a visible label beside a sub-score: printed on the
 * surface it reads as a promise about the arithmetic the score followed, and
 * the engine renormalises over the terms it could read, so that promise is only
 * kept when all four came back. A surface with a degraded score says so instead.
 */
export const COMPOSITE_WEIGHT_SENTENCE = `Weighted ${DRIVER_KEYS.map(
  (k) => DRIVER_WEIGHT_PCT[k],
).join("/")}.`;
