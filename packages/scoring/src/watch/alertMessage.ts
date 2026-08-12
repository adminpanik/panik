/**
 * Telegram alert copy for a profile-relative status transition.
 *
 * Pure + deterministic so it is unit-testable in-package; the HTTP send lives
 * in server/telegram.ts. Plain text (no MarkdownV2) so addresses, dots and
 * hyphens need no escaping; emojis are literal text and need no escaping
 * either. House style: hyphens only, never em dashes.
 *
 * Emoji layout: the header emoji doubles as the severity signal in the push
 * notification preview (🚨 outside, ⚠️ approaching); each fact line gets a
 * stable pictogram so the eye can find a field without reading labels; the
 * health-factor heart flips to 💔 below the near-liquidation threshold.
 */

import { TARGET_HF } from "../advisor/repayMath";
import { COMPOSITE_WEIGHTS } from "../params";
import { ALERT_THRESHOLD } from "../profile";
import { drawdownToLiquidation, formatDrawdownPct } from "../prospective";
import { simulationAlertLine } from "../simulation";
import type { SimulationMark } from "../simulation";
import type { DegradableSubScores, ProfileStatus, Protocol, RiskProfile } from "../types";
import type { WatchTransition } from "./loop";

/** Health factor below which we explicitly flag "near liquidation". */
const NEAR_LIQUIDATION_HF = 1.15;

const PROTOCOL_LABEL: Record<Protocol, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/**
 * Profile-relative status in plain words. `ProfileStatus` is an engine enum and
 * never reaches a user (DESIGN_SYSTEM "no internal enum values"), and these are
 * the SAME phrasings as `LIMIT_STATE` / `LIMIT_EVENT` in the app's
 * `lib/utils.ts` so the two surfaces describe one position the same way. They
 * are restated rather than imported because `packages/scoring` cannot depend on
 * `src/`; the words are chosen so no enum token appears as a substring, which
 * keeps "is an enum leaking?" a mechanical grep.
 */
const LIMIT_STATE: Record<ProfileStatus, string> = {
  within: "under your risk limit",
  approaching: "nearing your risk limit",
  outside: "over your risk limit",
};

/** `LIMIT_EVENT.within` - what a recovery IS, not where it ended up. */
const BACK_UNDER_LIMIT = "back under your risk limit";

/** Sub-score labels, matching the app's RISK_DRIVERS so both surfaces agree. */
const DRIVER_LABEL: Record<keyof DegradableSubScores, string> = {
  positionHealth: "position health",
  assetRisk: "asset volatility",
  protocolSafety: "protocol risk",
  systemicRisk: "market stress",
};

/** Position facts the dispatcher reads from the latest score snapshot. */
export interface AlertExtras {
  /** Protocol health factor; null = no debt (should not normally alert). */
  healthFactor?: number | null;
  collateralUsd?: number | null;
  borrowUsd?: number | null;
  /**
   * Set when the transition was produced under a market simulation. Callers
   * normally leave this alone: `formatAlert` reads the stamp off the transition
   * itself, which is the record of what was true when the crossing happened.
   * This is the path for a caller that reconstructs the transition from a
   * database row, where the label is all that was persisted.
   */
  simulation?: SimulationMark | null;
  /**
   * The advisor's own triggers for this leg plus the facts needed to phrase
   * them, so the alert can say WHY it fired (7.1). Omitted when the dispatcher
   * has no scored leg in hand - the alert then says less, never something
   * invented.
   */
  why?: WhyNowInput;
}

// ── 7.1 "why now" ───────────────────────────────────────────────────────────

/**
 * Facts a trigger needs to become a sentence. Shaped as a subset of
 * `AdvisorRecommendation["numbers"]` so the dispatcher can spread it straight
 * in rather than copying fields one by one (and disagreeing with itself later).
 */
export interface WhyNowFacts {
  healthFactor: number | null;
  scoredCollateralSymbol: string;
  subScores: DegradableSubScores;
  protocol: Protocol;
  profile: RiskProfile;
}

export interface WhyNowInput {
  /** `AdvisorRecommendation.triggers`, unmodified. */
  triggers: readonly string[];
  facts: WhyNowFacts;
}

/** The trigger that fired, and the sentence explaining it. */
export interface WhyNow {
  /** The raw trigger, for logging/telemetry. NEVER shown to a user. */
  trigger: string;
  text: string;
}

/**
 * The collateral the buffer is measured against. `(proxy)` is an engine detail,
 * and an unnamed asset becomes a phrase rather than a blank.
 */
function assetName(symbol: string): string {
  return symbol.replace(" (proxy)", "").trim() || "your collateral";
}

/** "38%" of price drop left, or null when the engine declines to state one. */
function dropPct(hf: number | null): string | null {
  const drop = drawdownToLiquidation(hf);
  if (drop === null || drop <= 0) return null;
  return formatDrawdownPct(drop);
}

/**
 * Severity-ordered trigger table, first match wins - the same shape as
 * `advisor/rules.ts`, which is where these triggers are produced. A builder
 * returning null means "this trigger fired but its VALUE is unavailable", and
 * selection falls through to the next one: an alert that says less beats an
 * alert that makes a number up.
 *
 * Triggers with no entry here (`band:`, `profile:`, `debt:none`,
 * `protocol:tvl`) fall through to the dominant-driver sentence. `protocol:tvl`
 * is deliberately absent: its percentage lives only inside the trigger string,
 * and re-parsing a string to quote a number at a user is how the number and the
 * fact drift apart. It gets a sentence when the dispatcher carries the value.
 */
const WHY_NOW_RULES: ReadonlyArray<{
  prefix: string;
  build: (f: WhyNowFacts) => string | null;
}> = [
  {
    // Crash regime: thin buffer AND collateral moving like a crash.
    prefix: "regime:crash",
    build: (f) => {
      const pct = dropPct(f.healthFactor);
      const assetRisk = f.subScores.assetRisk;
      if (pct === null || assetRisk === null) return null;
      const asset = assetName(f.scoredCollateralSymbol);
      return `${asset} is moving at crash-level volatility (${assetRisk} / 100 on asset risk) and liquidation is only a ${pct} drop away.`;
    },
  },
  {
    // Liquidation-proximity floor: the buffer itself is what fired the alert.
    prefix: "floor:hf<=",
    build: (f) => {
      const pct = dropPct(f.healthFactor);
      if (pct === null || f.healthFactor === null) return null;
      return `Liquidation is a ${pct} ${assetName(f.scoredCollateralSymbol)} drop away, at a health factor of ${f.healthFactor.toFixed(2)}.`;
    },
  },
  {
    prefix: "collateral:unpriced",
    build: () =>
      "We could not price the collateral in this position on this read, so its dollar value is unverified. The risk score and health factor are not affected.",
  },
  {
    prefix: "prices:degraded",
    build: () =>
      "The price feed for this position is degraded, so we are not stating its dollar value. The risk score and health factor are not affected.",
  },
  {
    prefix: "promoted:reduce_to_exit",
    build: (f) =>
      `Getting back to a health factor of ${TARGET_HF[f.profile]} now takes repaying almost the whole debt, which is a full exit in all but name.`,
  },
  {
    prefix: "target:hf=",
    build: (f) => {
      const pct = dropPct(f.healthFactor);
      if (pct === null) return null;
      return `Your buffer is under the ${f.profile} target: liquidation is a ${pct} ${assetName(f.scoredCollateralSymbol)} drop away, against a target health factor of ${TARGET_HF[f.profile]}.`;
    },
  },
  {
    prefix: "repay:amount_unavailable",
    build: () =>
      "This position needs a repay, but without a price for it we will not put a dollar figure on one.",
  },
  {
    prefix: "protocol:safety",
    build: (f) =>
      `${PROTOCOL_LABEL[f.protocol] ?? f.protocol} is carrying elevated protocol risk (${f.subScores.protocolSafety} / 100 on audits, governance and market controls).`,
  },
  {
    prefix: "repay:below_floor",
    build: () =>
      "The repay that would fix this costs more in gas than the liquidation penalty it avoids, so there is no repay worth making yet.",
  },
  {
    prefix: "market:unavailable",
    build: () =>
      "Some market inputs were unavailable on this read, so this score is weighted over the position itself.",
  },
];

/** Sub-score contributions, largest share of the composite first. */
function drivers(
  subScores: DegradableSubScores,
): Array<{ key: keyof DegradableSubScores; value: number }> {
  return (Object.keys(DRIVER_LABEL) as Array<keyof DegradableSubScores>)
    .map((key) => ({ key, value: subScores[key] }))
    .filter((d): d is { key: keyof DegradableSubScores; value: number } => d.value !== null)
    .sort((a, b) => COMPOSITE_WEIGHTS[b.key] * b.value - COMPOSITE_WEIGHTS[a.key] * a.value);
}

/**
 * The dominant trigger behind an alert and the value that fired it (7.1).
 *
 * Ties do not arise: the table is a strict severity order and the FIRST
 * matching trigger wins regardless of the order the advisor happened to push
 * them in, so `["protocol:safety", "floor:hf<=1.1"]` and the reverse both
 * resolve to the proximity floor.
 *
 * Falls back to the largest sub-score contribution, which is a fact the engine
 * always holds. Null only when there is nothing measured to report at all.
 */
export function whyNow(input: WhyNowInput): WhyNow | null {
  for (const rule of WHY_NOW_RULES) {
    const trigger = input.triggers.find((t) => t.startsWith(rule.prefix));
    if (trigger === undefined) continue;
    const text = rule.build(input.facts);
    if (text !== null) return { trigger, text };
  }
  const top = drivers(input.facts.subScores)[0];
  if (top === undefined) return null;
  return {
    trigger: `driver:${top.key}`,
    text: `${DRIVER_LABEL[top.key]} is the largest contributor to this score, at ${top.value} / 100.`,
  };
}

/**
 * Sub-score breakdown, on demand (7.1). Unmeasured terms are OMITTED, never
 * printed as 0 - "not measured" and "measured, and calm" are different facts.
 */
export function formatSubScores(subScores: DegradableSubScores): string | null {
  const parts = drivers(subScores).map((d) => `${DRIVER_LABEL[d.key]} ${d.value}`);
  return parts.length === 0 ? null : `🧩 Risk drivers: ${parts.join(", ")}`;
}

/** 0xabcdef...1234 */
export function truncateWallet(wallet: string): string {
  const w = wallet.trim();
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}...${w.slice(-4)}`;
}

function usd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Welcome message sent when a user connects their Telegram via the /start <code>
 * deep-link. Plain text, hyphens only (house style). Shared by both webhook
 * handlers (Railway api-server + Vercel fallback) so the copy never drifts.
 */
export function formatWelcome(wallet: string): string {
  return [
    "👋 Welcome to PANIK alerts.",
    "",
    `🔗 This chat is now linked to wallet ${truncateWallet(wallet)}.`,
    "",
    "🛡️ I'll message you here the moment this position drifts toward its liquidation limit. Alerts are debounced and deduped, so only real risk reaches you - never spam.",
    "",
    "Commands:",
    "🔕 /stop - pause alerts anytime",
    "",
    "Stay safe out there. 🧡",
  ].join("\n");
}

/**
 * The shared fact block: wallet, protocol, score vs limit, health factor, the
 * price-drop buffer and position size. Every omission is deliberate - a line
 * whose value is unknown is dropped, never filled with a zero.
 */
function factLines(t: WatchTransition, extras: AlertExtras): string[] {
  const limit = ALERT_THRESHOLD[t.profile];
  const wallet = truncateWallet(t.wallet);
  const protocol = PROTOCOL_LABEL[t.protocol] ?? t.protocol;

  const lines: string[] = [];
  lines.push(`👛 Wallet ${wallet}`);
  lines.push(`🏦 Protocol ${protocol}`);
  lines.push(`📊 Risk score ${t.score} / 100 (${t.band}), your ${t.profile} limit is ${limit}`);

  const hfValue = extras.healthFactor;
  if (hfValue != null && Number.isFinite(hfValue)) {
    // Consequence first, ratio behind it (DESIGN_SYSTEM: "lead with the
    // consequence, not the ratio"). A chat message has no hover, so the exact
    // health factor stays on its own line rather than being deleted. The buffer
    // needs the scored collateral's name, which only the advisor facts carry.
    const symbol = extras.why?.facts.scoredCollateralSymbol;
    if (symbol !== undefined) {
      const pct = dropPct(hfValue);
      lines.push(
        pct === null
          ? `🛟 Can be liquidated at today's ${assetName(symbol)} price`
          : `🛟 Liquidates if ${assetName(symbol)} falls ${pct}`,
      );
    }
    const hf = hfValue.toFixed(2);
    lines.push(
      hfValue < NEAR_LIQUIDATION_HF
        ? `💔 Health factor ${hf} - near liquidation`
        : `❤️ Health factor ${hf}`,
    );
  }

  const collateral = usd(extras.collateralUsd);
  const borrow = usd(extras.borrowUsd);
  if (collateral && borrow) lines.push(`💰 Position ${collateral} collateral / ${borrow} debt`);

  return lines;
}

/**
 * The simulation marker, FIRST, above the siren - and that placement is the
 * requirement rather than a preference: a push notification shows the opening
 * characters and nothing else, so a marker buried in the body reaches the user
 * only after they have already believed the headline. A crash alert for a crash
 * that did not happen is the worst false alarm a liquidation alerter can send -
 * it teaches the user to discount the next one, which is the real one.
 *
 * The transition's own stamp is the record of what was true at the crossing;
 * `extras` only fills in for the dispatcher reading it back out of a row.
 *
 * Its own function, not part of `factLines`, because the ALL-CLEAR needs the
 * same marker under a different headline: "nothing to do" issued against a
 * price that never moved misleads exactly as much as the alert does, and a
 * shared fact block cannot carry two headlines.
 */
function simulationOf(t: WatchTransition, extras: AlertExtras): SimulationMark | null {
  return t.simulation ?? extras.simulation ?? null;
}

/**
 * Bookended on purpose. The closing line of either message tells the user what
 * to do (or not do), and under a simulation that is answering a price which did
 * not move; the marker has to be the last thing read as well as the first, so
 * no crop of the message shows an instruction without the reason it was issued.
 */
const SIMULATION_FOOTER =
  "🧪 Reminder: the price move above is simulated. Nothing has happened to the market.";

/**
 * Build the alert body for a transition INTO approaching/outside. Recovery
 * transitions go to `formatResolution` instead.
 */
export function formatAlert(t: WatchTransition, extras: AlertExtras = {}): string {
  const outside = t.to === "outside";
  const simulation = simulationOf(t, extras);

  const lines: string[] = [];
  if (simulation) {
    lines.push(simulationAlertLine(simulation));
    lines.push("");
  }
  lines.push(
    outside
      ? `🚨 Panik alert - position ${LIMIT_STATE.outside}`
      : `⚠️ Panik alert - position ${LIMIT_STATE.approaching}`,
  );
  lines.push("");
  lines.push(...factLines(t, extras));

  // Why this alert, now. Sits directly under the facts it cites.
  const why = extras.why;
  const explained = why ? whyNow(why) : null;
  if (why && explained) {
    lines.push("");
    lines.push(`🔎 Why now: ${explained.text}`);
    const breakdown = formatSubScores(why.facts.subScores);
    if (breakdown) lines.push(breakdown);
  }

  lines.push("");
  lines.push(
    outside
      ? "⛔ Your position has crossed your risk threshold and is trending toward liquidation. Act now: add collateral or repay debt to pull it back."
      : "⏳ This position is getting close to your liquidation comfort zone. Consider adding collateral or repaying debt before it crosses the line.",
  );

  if (simulation) {
    lines.push("");
    lines.push(SIMULATION_FOOTER);
  }

  return lines.join("\n");
}

/**
 * Resolution notification (7.2): a position we alerted on is back inside the
 * user's limit. Sent only for transitions INTO "within", and only when an alert
 * actually went out - see `alertPolicy.decideSend`, which rate-limits these so a
 * flapping position cannot turn the all-clear into its own spam.
 *
 * "What changed" is stated from the transition itself (`from` -> `to`) and the
 * current facts. The engine does not hold the previous score, so the message
 * does not claim a delta it cannot compute.
 */
export function formatResolution(t: WatchTransition, extras: AlertExtras = {}): string {
  const simulation = simulationOf(t, extras);
  const lines: string[] = [];
  if (simulation) {
    lines.push(simulationAlertLine(simulation));
    lines.push("");
  }
  lines.push(`✅ Panik all clear - position ${BACK_UNDER_LIMIT}`);
  lines.push("");
  lines.push(...factLines(t, extras));
  lines.push("");
  lines.push(
    t.from === null || t.from === "within"
      ? `🔁 What changed: this position is now ${LIMIT_STATE.within}.`
      : `🔁 What changed: this position was ${LIMIT_STATE[t.from]}, and is now ${BACK_UNDER_LIMIT}.`,
  );
  lines.push("");
  lines.push(
    "🛡️ Nothing to do. I'll keep watching and message you again if it drifts back toward your limit.",
  );
  if (simulation) {
    lines.push("");
    lines.push(SIMULATION_FOOTER);
  }

  return lines.join("\n");
}
