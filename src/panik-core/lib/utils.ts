/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PositionState } from "./types";
import type { AdvisorAction, Band, LiveProtocol, ProfileStatus } from "./live";
/**
 * A VALUE import from the engine, which every other import in panik-core is
 * careful not to be, and the exception is deliberate: `prospective.ts` has no
 * imports of its own, so it drags nothing behind it. The rule this protects
 * against is the BARREL, which reaches viem through the chain adapters.
 * Deep-importing the one module keeps the liquidation formula AND its rounding in
 * `packages/scoring`, instead of retyping `1 - 1/hf` here and rounding it to a
 * second number the engine's own prose then disagrees with.
 */
import {
  drawdownToLiquidation,
  formatDrawdownPct,
} from "../../../packages/scoring/src/prospective";

/**
 * A protocol id in the product's own words.
 *
 * This table existed SIX times, character for character, in `AppDemo`,
 * `AdvisorPanel`, `AdvisorPopup`, `DelegationManager`, `OpenFlow` and
 * `LivePositions` - three typed against the union and three as a loose
 * `Record<string, string>`. A protocol added to the engine needed six edits,
 * and whichever copy was missed put a raw `compound_v3` on screen.
 *
 * `Record<LiveProtocol, …>` rather than a loose index, so a protocol added to
 * the engine is a compile error here instead of an enum leaking to the UI. The
 * value type is the literal union because `VaultPreset.protocol` is that union
 * and the Watch simulator assigns a label straight into it.
 *
 * Callers reading a protocol off the wire keep their `?? protocol` fallback:
 * the type says what this build knows, not what an API response can contain.
 */
export const PROTOCOL_LABEL: Record<
  LiveProtocol,
  "Aave V3" | "Moonwell" | "Morpho" | "Compound V3"
> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

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
/**
 * True when a market-context term of an ACTIVE-path score could not be read for
 * this leg, so at least one sub-score is null.
 *
 * DERIVED, not stored a second time: this is the exact condition
 * `ActiveAdapter` sets `marketContextUnavailable` from
 * (packages/scoring/src/adapters/active.ts), and the advisor's `numbers` payload
 * carries the sub-scores without the flag. One predicate over the sub-scores is
 * the only version that cannot disagree with itself.
 */
export function marketContextMissing(sub: {
  assetRisk: number | null;
  systemicRisk: number | null;
}): boolean {
  return sub.assetRisk === null || sub.systemicRisk === null;
}

/**
 * The one wording for a sub-score the engine could not read, and its
 * explanation. Plain language: the reader is being told a part of the score is
 * missing, not which provider threw.
 */
/**
 * The one wording for a leg whose USD conversion could not be read, and its
 * explanation.
 *
 * A degraded leg REPLACES its money line with this rather than printing the
 * `formatUsd` unknown glyph into a labelled slot: "Collateral $…" is
 * indistinguishable from a clipped string, so the honest statement got read as a
 * broken layout. A sentence cannot be misread that way, and no branch of it can
 * emit "$0".
 *
 * `components/LivePositions.tsx` states the same two things with its own copy of
 * these strings; pointing it here is a mechanical follow-up outside this change's
 * file scope.
 */
export const USD_UNAVAILABLE_LABEL = "USD amounts unavailable";
export const USD_UNAVAILABLE_HINT =
  "A price feed this position's USD conversion depends on was missing or stale. The PANIK score and health factor are unaffected - they are ratios - so only the dollar amounts are unknown.";

export const MARKET_CONTEXT_MISSING_LABEL = "Market risk not measured";
export const MARKET_CONTEXT_MISSING_HINT =
  "We could not read the market data for this asset or protocol, so those parts are left out. The score is weighted over what we could measure, and your position health is unaffected.";

/**
 * `AdvisorAction` in English. The union is an engine enum and it was reaching
 * the screen verbatim, in caps, as `EXIT` / `REDUCE` / `MONITOR` / `HOLD` — the
 * same class of leak `LIMIT_STATE` exists to stop, and shouting is not what
 * makes a label read as a label (see the typography section of the design
 * system: sentence case throughout).
 *
 * `Record<AdvisorAction, string>` rather than a `?:` chain, so an action added
 * to the engine breaks the build here instead of falling through to the raw
 * token.
 */
export const ADVISOR_ACTION: Record<AdvisorAction, string> = {
  EXIT: "Exit",
  REDUCE: "Reduce",
  REBALANCE: "Move",
  MONITOR: "Watch",
  HOLD: "Hold",
  OPEN: "Open",
};

/**
 * The Advisor's one AI disclosure, for the whole panel.
 *
 * Provenance used to be stated per BLOCK: a marker under the lead sentence and
 * another inside every disclosure, each naming which of the engine and the model
 * phrased the paragraph above it, one of them carrying a tooltip about the
 * guardrails, plus a banner line at the top saying that the blocks do this. Six
 * markers and two tooltips on a screen whose job is "here is what to do", for a
 * distinction the reader cannot act on: the recommendation, the numbers and the
 * action are the engine's either way.
 *
 * One line survives because the summaries genuinely are model-phrased and saying
 * so is an obligation rather than a design choice (EU AI Act Article 50, in
 * force since 2026-08-02). It states the fact and stops: which legs passed which
 * checks is an implementation detail, and the second clause is scope, not
 * marketing, because without it the line reads as "the advice is AI-generated",
 * which is false.
 */
export const AI_PROSE_NOTE =
  "Summaries are worded by AI. Every number and recommendation is decided by the risk engine.";

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

/**
 * `ProfileStatus` in English. The enum itself — "within" / "approaching" /
 * "outside" — is a database column describing a position's relation to the
 * limit the user's profile sets, and it was reaching the screen verbatim: the
 * alert log rendered `approaching → outside`, which reads as a state-machine
 * dump and tells a user nothing about their money.
 *
 * TWO tables, because the same fact is two different sentences depending on
 * where it lands:
 *   STATE  — what a position IS right now      -> a position row's status line
 *   EVENT  — what just HAPPENED to it          -> a row in the alert log
 *
 * Neither table contains the enum tokens, so no branch of either can put
 * "approaching" or "outside" back on screen. `Record<ProfileStatus, string>`
 * is what stops a status added to the engine from silently falling through to
 * the raw value the way a `?:` chain would.
 */
const LIMIT_STATE: Record<ProfileStatus, string> = {
  within: "under your risk limit",
  approaching: "nearing your risk limit",
  outside: "over your risk limit",
};

const LIMIT_EVENT: Record<ProfileStatus, string> = {
  within: "back under your risk limit",
  approaching: "nearing your risk limit",
  outside: "crossed your risk limit",
};

/**
 * Where a position stands right now. Lower case: this is a clause inside a
 * sentence ("Liquidates if cbBTC falls 25%, nearing your risk limit"), not a
 * label.
 *
 * Takes a loose `string` because `from_status` arrives straight off a DB row
 * and may hold a value this build has never heard of. The fallback still reads
 * as English, which is the whole point of this module.
 */
export function limitStateCopy(status: string): string {
  return LIMIT_STATE[status as ProfileStatus] ?? "measured against your risk limit";
}

/**
 * What an alert row records, as one phrase. The DESTINATION is the event; the
 * origin is noise on a line that gets scanned, not read — `from_status` is
 * deliberately not a parameter here. It stays recoverable on the row's hover
 * via `limitStateCopy`, so nothing is deleted, only demoted.
 */
export function limitEventCopy(status: string): string {
  return LIMIT_EVENT[status as ProfileStatus] ?? "changed against your risk limit";
}

export interface LiquidationOutlook {
  /** Prose clause for a position row: "Liquidates if cbBTC falls 4.8%". */
  sentence: string;
  /**
   * Compact VALUE for a labelled strip, where the asset is already named — a
   * value and nothing else. It used to carry its qualifying clause, and the stat
   * tile rendering it is a truncated 24px line, so the one state where that
   * clause is load-bearing came out as "0%, liquidatab…".
   */
  strip: string;
  /**
   * The clause that qualifies `strip`, for the sub-line beside it. Null unless a
   * bare figure would read as the opposite of the truth: "0%" for
   * liquidatable-now, "none" for no-debt.
   */
  stripNote: string | null;
  /**
   * The same fact for a strip that has NO sub-line to hang `stripNote` on: a
   * label and a value that are each self-sufficient.
   *
   * The Advisor card is exactly that shape — one flex row of label/value pairs —
   * and it was joining the two halves back together, so a debt-free leg rendered
   * "Drop to liquidation: none, no debt" and a liquidatable one "0%, liquidatable
   * now". A field named `value` holds a value; a clause in it is the thing that
   * gets clipped the moment something truncates.
   *
   * The two special cases answer a DIFFERENT question, so they get a different
   * label rather than a qualified number: there is no drop to state, and "0%"
   * under "Drop to liquidation" reads as the exact inverse of the truth.
   */
  statLabel: string;
  statValue: string;
  /** The exact health factor, plus the assumption the drop rests on. */
  hover: string;
}

/** The label `statValue` answers to when a drawdown is the thing being stated. */
const DROP_LABEL = "Drop to liquidation";
/** ...and when there is no drawdown to state, because the two are not the same question. */
const LIQUIDATION_RISK_LABEL = "Liquidation risk";

/**
 * A health factor, in words a non-expert can act on.
 *
 * "Health factor 1.20" is a ratio whose scale nobody outside DeFi knows: 1.20 is
 * dangerous where 1.20 of almost anything else is fine. The usable number is the
 * one every comparable product leads with, how far the collateral can fall — the
 * SAME fact, converted exactly by the engine's `drawdownToLiquidation` and
 * rounded by `formatDrawdownPct`, the one way the engine's own prose rounds it.
 *
 * Three cases, and they are three genuinely different statements:
 *   null HF  -> no debt. No liquidation price, so no drop is printed; "0%" here
 *               would be the worst possible lie in this product.
 *   HF <= 1  -> already liquidatable. "falls 0%" reads as "perfectly safe", the
 *               exact inverse of the truth, so it gets its own sentence.
 *   HF > 1   -> the drop.
 *
 * The exact health factor is demoted, never deleted: it opens `hover`, which is
 * never null — the no-debt case has an explanation too, and while the helper
 * withheld it all three call sites wrote their own, differently.
 */
export function liquidationOutlook(
  healthFactor: number | null,
  symbol: string,
): LiquidationOutlook {
  const drop = drawdownToLiquidation(healthFactor);

  if (healthFactor === null) {
    // Unchanged wording: no debt cannot be liquidated, and this row has said so
    // in these two words since before the health factor was on screen at all.
    return {
      sentence: "No debt",
      strip: "none",
      stripNote: "no debt",
      statLabel: LIQUIDATION_RISK_LABEL,
      statValue: "None",
      hover:
        "Nothing is borrowed against this collateral, so the protocol has nothing to liquidate.",
    };
  }

  const exact = `Health factor ${healthFactor.toFixed(2)}.`;

  // `null` here is a non-positive health factor, which the engine declines to
  // state a drawdown for; it is liquidatable now either way.
  if (drop === null || drop <= 0) {
    return {
      sentence: `Can be liquidated at today's ${symbol} price`,
      strip: formatDrawdownPct(0),
      stripNote: "liquidatable now",
      statLabel: LIQUIDATION_RISK_LABEL,
      statValue: "Liquidatable now",
      hover: `${exact} At or below 1.00 the protocol can liquidate this position without the price moving at all.`,
    };
  }

  const pct = formatDrawdownPct(drop);
  return {
    sentence: `Liquidates if ${symbol} falls ${pct}`,
    strip: pct,
    stripNote: null,
    statLabel: DROP_LABEL,
    statValue: pct,
    hover:
      `${exact} The drop assumes the debt is priced in dollars and the collateral moves as one asset,` +
      ` which holds for a stablecoin loan against a single asset and is an estimate otherwise.`,
  };
}

/**
 * A PRICE or a dollar amount, with whole dollars at portfolio scale and enough
 * decimals at token-price scale that the figure is still true.
 *
 * `maximumFractionDigits: 0` on its own printed a $0.45 black-swan price as
 * "$0", which is the "never render an unknown value as a zero" rule failing in
 * the other direction: not an unknown dressed as zero, but a real, non-zero
 * number erased into one. A stablecoin market prices everything under a dollar,
 * so that branch is the common case there rather than an edge.
 *
 * The decimal count is derived from the magnitude, so nothing the simulator can
 * produce rounds away. Cents below $10, because that band is entirely
 * stablecoin prices and a $1.30 ceiling printed as "$1" is the same erasure one
 * digit up; more digits still under $1, as far as four. Whole dollars from $10,
 * where a decimal is noise on a portfolio figure and every call site is an
 * amount rather than a price.
 *
 * Four decimals is the floor, and below it the answer is a bound rather than a
 * rounded-down "$0" - the same reason `formatUsd` returns "$…" for an unknown.
 * A hundredth of a cent is already past anything this product prices.
 */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "$…";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 5e-5) return `${value < 0 ? "-" : ""}<$0.0001`;
  const maximumFractionDigits =
    abs === 0 || abs >= 10
      ? 0
      : abs >= 1
        ? 2
        : Math.min(4, Math.max(2, Math.ceil(-Math.log10(abs)) + 1));
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
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

/**
 * $36.3m / $214m / $610k style compact USD (TVL figures).
 *
 * One significant decimal, dropped when it is a zero. A pool holding $214m was
 * rendering as "$214.00m": two digits that cannot change the reader's mind
 * about anything, sitting in the same line as the APY they are there to
 * qualify. "$0.00" precision on a nine-figure number reads as a template that
 * forgot to be filled in, which is the same failure mode as the "APY 0.0%" it
 * sat beside.
 */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const scaled = (divisor: number, suffix: string) => {
    const n = value / divisor;
    return `$${n.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  };
  if (value >= 1e9) return scaled(1e9, "b");
  if (value >= 1e6) return scaled(1e6, "m");
  if (value >= 1e3) return scaled(1e3, "k");
  return `$${Math.round(value)}`;
}
