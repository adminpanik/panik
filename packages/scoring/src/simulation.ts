/**
 * Market-event simulation — the ONE place a scored price is allowed to be
 * imagined, and the ONE place that fact is described in words.
 *
 * WHAT IS SIMULATED AND WHAT IS NOT. We do not control Aave's Base Sepolia
 * oracle, so no operator action can move a real on-chain health factor. What an
 * armed simulation does is override the PRICE at the scoring boundary: the
 * engine scores the position as if the collateral had moved by X%, and every
 * consumer downstream then reacts for real. Bands flip, the watch worker records
 * a genuine transition, alerts dispatch, the advisor sizes a real repay, and the
 * exit the user signs afterwards is a real transaction against real balances.
 * Only the price is imagined. Nothing here writes to a chain, and nothing here
 * makes an exit less real.
 *
 * EXPIRY IS PART OF THE FEATURE, not a convenience. A simulation left on forever
 * eventually gets mistaken for reality, and this product's entire value is that
 * its numbers are true. `activeSimulation()` is therefore the only supported way
 * to read a scenario: it returns null once `expiresAt` has passed, so an expired
 * scenario stops affecting scores with nobody doing anything, including after a
 * process restart that reloaded the row from the database.
 *
 * NO IMPORTS AT RUNTIME, deliberately, for the same reason `prospective.ts` has
 * none: browser surfaces deep-import this module for the scenario magnitudes and
 * the marker copy, and the package barrel reaches viem through the chain
 * adapters. The single `import type` below is erased before any bundler sees it.
 */

import type { ActiveReading } from "./adapters/activeAave";

/**
 * The scenario set. These magnitudes are the product's, not this module's: they
 * were chosen for the Watch tab's price scenarios and are anchored to the event
 * set in docs/technical-docs/BACKTEST_METHODOLOGY.md. They live HERE because the
 * simulator and the Watch preview must offer the same three numbers, and two
 * literals that are meant to be equal are two literals that drift.
 *
 * `pct` is a fractional change, so -0.4 is "down 40%" and the multiplier applied
 * to the price is 1 + pct = 0.6.
 */
export const MARKET_SCENARIOS = [
  { key: "current", label: "Current", pct: 0, note: "market price" },
  { key: "stress", label: "Stress", pct: -0.2, note: "sharp correction" },
  { key: "crash", label: "Crash", pct: -0.4, note: "FTX week, Nov 2022" },
  { key: "blackswan", label: "Black swan", pct: -0.55, note: "ETH, Jun 2022" },
] as const;

export type MarketScenarioKey = (typeof MARKET_SCENARIOS)[number]["key"];

/** The scenarios an operator can ARM. "current" is the absence of one. */
export const ARMABLE_SCENARIO_KEYS: readonly MarketScenarioKey[] = [
  "stress",
  "crash",
  "blackswan",
];

/** Label for a scenario key, or "Custom" for a per-asset percentage set. */
export const CUSTOM_SCENARIO_KEY = "custom";

export function scenarioByKey(key: string): (typeof MARKET_SCENARIOS)[number] | null {
  return MARKET_SCENARIOS.find((s) => s.key === key) ?? null;
}

/** Duration bounds, in minutes. The default is bounded on purpose — see header. */
export const SIMULATION_MIN_MINUTES = 1;
export const SIMULATION_DEFAULT_MINUTES = 60;
export const SIMULATION_MAX_MINUTES = 240;

/**
 * A price multiplier this module will act on. Anything else is refused rather
 * than coerced: 0 would report every position as instantly liquidatable and a
 * negative or non-finite value is not a price at all. An out-of-range entry
 * leaves its asset UNSIMULATED, which is the honest reading of "we were handed
 * something we cannot interpret".
 */
export function isUsableMultiplier(m: unknown): m is number {
  return typeof m === "number" && Number.isFinite(m) && m > 0;
}

export function multiplierFromPct(pct: number): number {
  return 1 + pct;
}

/** Inverse of `multiplierFromPct`, for rendering an armed scenario back as a %. */
export function pctFromMultiplier(multiplier: number): number {
  return multiplier - 1;
}

/**
 * An armed scenario. `multipliers` is keyed by collateral/borrow SYMBOL exactly
 * as the chain readers report it ("cbBTC", "WETH", "USDC"), so a leg whose
 * symbol is absent from the map is simply not simulated.
 */
export interface MarketSimulation {
  /** Row id, carried onto every snapshot and transition scored under it. */
  id: string;
  /** A `MarketScenarioKey`, or `CUSTOM_SCENARIO_KEY` for per-asset percentages. */
  scenario: string;
  /** Human label for the marker: "Crash", "Black swan", "Custom". */
  label: string;
  /** SYMBOL -> price multiplier. 0.6 = that asset is priced 40% lower. */
  multipliers: Record<string, number>;
  /** Who armed it (admin email). Recorded so history can be read honestly. */
  setBy: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. Past this instant the scenario is dead, with no action required. */
  expiresAt: number;
}

/**
 * What was actually done to ONE leg, recorded on the score so the marker,
 * the alert text and the persisted history all describe the same event.
 *
 * The three multipliers are kept separately rather than collapsed to one because
 * they answer different questions: the collateral and borrow figures explain the
 * dollar amounts on screen, and `healthFactorMultiplier` explains the band. When
 * collateral and debt move together (a same-asset market) the net is 1 and the
 * distance to liquidation genuinely does not change, which is a true thing the
 * UI should be able to say.
 */
/**
 * The least a surface needs in order to mark something as simulated: the name
 * of the scenario.
 *
 * Deliberately this small. The alert dispatcher reads its marker back out of a
 * database row that stores the id and the label and nothing else, and a wider
 * requirement would have forced it to invent the missing fields - a zero
 * `expiresAt` and a 1.0 multiplier, neither of which it knows - purely to
 * satisfy a type. Inventing plausible values to get a marker printed is the
 * shape of bug this whole feature exists to prevent, so the type asks for what
 * is genuinely known instead. `SimulationStamp` satisfies it structurally.
 */
export interface SimulationMark {
  label: string;
}

export interface SimulationStamp extends SimulationMark {
  id: string;
  scenario: string;
  collateralMultiplier: number;
  borrowMultiplier: number;
  /** collateralMultiplier / borrowMultiplier. 1 = this leg's HF is untouched. */
  healthFactorMultiplier: number;
  expiresAt: number;
}

/** Milliseconds left, floored at 0. */
export function simulationRemainingMs(sim: MarketSimulation, nowMs: number): number {
  return Math.max(0, sim.expiresAt - nowMs);
}

export function isSimulationExpired(sim: MarketSimulation, nowMs: number): boolean {
  return nowMs >= sim.expiresAt;
}

/**
 * THE READ. Every consumer must go through this rather than touching a
 * `MarketSimulation` directly, because this is where expiry is enforced: a row
 * that outlived its window resolves to null, and a scenario with no usable
 * multiplier resolves to null too (an "active" simulation that changes nothing
 * is a marker on screen with no number behind it, which is its own small lie).
 */
export function activeSimulation(
  sim: MarketSimulation | null | undefined,
  nowMs: number,
): MarketSimulation | null {
  if (!sim) return null;
  if (isSimulationExpired(sim, nowMs)) return null;
  const usable = Object.values(sim.multipliers).some(
    (m) => isUsableMultiplier(m) && m !== 1,
  );
  return usable ? sim : null;
}

/**
 * The multiplier for one asset symbol. 1 (no change) when the scenario says
 * nothing about this asset or says something unusable. Symbol matching is
 * case-insensitive because the readers and the operator's typing disagree about
 * "cbBTC" more often than is worth arguing with.
 */
export function simulationMultiplierFor(
  sim: MarketSimulation,
  symbol: string | null | undefined,
): number {
  if (!symbol) return 1;
  const wanted = symbol.trim().toLowerCase();
  for (const [key, value] of Object.entries(sim.multipliers)) {
    if (key.trim().toLowerCase() === wanted && isUsableMultiplier(value)) return value;
  }
  return 1;
}

/**
 * THE PRICE BOUNDARY. Rewrites one leg's reading as if its collateral and debt
 * carried the scenario's prices, and returns the stamp describing what was done.
 * `stamp` is null when this leg is untouched, which is the signal every surface
 * downstream uses to decide whether it is looking at a simulated number.
 *
 * Health factor is moved EXPLICITLY rather than being left to fall out of the
 * dollar figures, and that is the whole correctness of this function. HF,
 * `currentLtv` and `maxLtv` are denomination-free ratios each reader computes
 * itself (Aave hands us its own HF from `getUserAccountData`); they are not
 * derived from `collateralValueUsd`. Scaling only the dollar fields would move
 * the money on screen and leave the band, the score, the alert and the advisor
 * exactly where they were, which is the failure this feature exists to avoid.
 *
 *   collateral' = collateral x mc
 *   borrow'     = borrow x md
 *   HF'         = HF x (mc / md)          liquidation sits at HF = 1
 *   currentLtv' = currentLtv x (md / mc)
 *
 * This is the same linearity `drawdownToLiquidation` already documents and
 * rests on, and it carries the same caveat: exact for a single collateral asset
 * against a stable-denominated debt, an approximation for a multi-asset or
 * volatile-debt position. `maxLtv` is a protocol parameter, not a price, and is
 * left alone.
 *
 * A null dollar field stays null. A price we imagined does not turn an amount we
 * could not read into one we can: "simulated" and "unavailable" are different
 * states and collapsing them would put a made-up number where the UI has spent
 * some effort refusing to print a zero.
 */
export function applySimulationToReading(
  reading: ActiveReading,
  sim: MarketSimulation | null | undefined,
  nowMs: number,
): { reading: ActiveReading; stamp: SimulationStamp | null } {
  const active = activeSimulation(sim, nowMs);
  if (!active) return { reading, stamp: null };

  const mc = simulationMultiplierFor(active, reading.dominantCollateralSymbol);
  const md = simulationMultiplierFor(active, reading.dominantBorrowSymbol);
  if (mc === 1 && md === 1) return { reading, stamp: null };

  const hfMultiplier = mc / md;
  const hf = reading.positionHealth.healthFactor;
  const ltv = reading.positionHealth.currentLtv;

  return {
    reading: {
      ...reading,
      positionHealth: {
        ...reading.positionHealth,
        healthFactor: hf === null ? null : hf * hfMultiplier,
        currentLtv: ltv / hfMultiplier,
      },
      collateralValueUsd:
        reading.collateralValueUsd === null ? null : reading.collateralValueUsd * mc,
      borrowValueUsd: reading.borrowValueUsd === null ? null : reading.borrowValueUsd * md,
    },
    stamp: {
      id: active.id,
      label: active.label,
      scenario: active.scenario,
      collateralMultiplier: mc,
      borrowMultiplier: md,
      healthFactorMultiplier: hfMultiplier,
      expiresAt: active.expiresAt,
    },
  };
}

/**
 * Marker copy. Centralised so the banner, the alert and the admin console cannot
 * describe the same event three different ways, and so the sentence that keeps
 * this honest — real prices have not moved — is impossible to ship without.
 */
export const SIMULATION_MARKER_TITLE = "Simulated market prices";

export const SIMULATION_MARKER_BODY =
  "A market event is being simulated for a demonstration. Prices below are imagined, so scores, bands and alerts follow from them. Real market prices have not moved.";

/** Short form, for a chip beside an affected figure. */
export const SIMULATION_CHIP_LABEL = "Simulated price";

/**
 * The exit is NOT simulated and must never be marked as though it were. A user
 * who reads "simulated" beside a button that signs a real transaction learns the
 * wrong thing about the one moment this product exists for.
 */
export const SIMULATION_EXIT_NOTE =
  "Exits remain real. Signing one moves real funds.";

/**
 * The line every alert sent under a simulation carries.
 *
 * This is not decoration. A Telegram message about a crash that did not happen
 * is the worst false alarm a liquidation alerter can send: it is the "believes
 * protected but is not" failure inverted, and a user who is burned by one learns
 * to discount the next alert, which is the real one. `formatAlert` refuses to
 * build a body without this line whenever a stamp is present.
 */
export function simulationAlertLine(mark: SimulationMark): string {
  return `🧪 SIMULATED MARKET EVENT (${mark.label}). This alert was produced from imagined prices for a demonstration. Real market prices have not moved and your position has not actually changed.`;
}

/**
 * "58 minutes" / "1 minute" / "under a minute". Minute granularity, no seconds:
 * the product forbids live tickers, and a countdown that changes every second is
 * one. The operator console renders the same value more often; users see a fact
 * that stays still long enough to read.
 */
export function formatSimulationRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 1) return "under a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
