/**
 * Telegram alert copy for a profile-relative status transition.
 *
 * Pure + deterministic so it is unit-testable in-package; the HTTP send lives
 * in server/telegram.ts. House style: hyphens only, never em dashes.
 *
 * TELEGRAM HTML, and only four tags' worth of it. `formatAlert` and
 * `formatResolution` emit `parse_mode: "HTML"` markup; the dispatcher opts in
 * (server/watchDispatch.ts) and every other sender still posts plain text.
 * Three rules make that safe rather than merely pretty:
 *
 *   * ESCAPE EVERY INTERPOLATED VALUE. `escapeHtml` runs over the wallet label
 *     (typed by the user), the asset symbols and protocol names (read off a
 *     chain), and the simulation label (typed by an operator). Telegram parses
 *     the body it is sent, so an unescaped `<` in a label is not a rendering
 *     bug - it is a malformed entity that makes Telegram reject the whole send
 *     with a 400, and the alert is never delivered.
 *   * ONLY `<b>` AND `<code>`. Telegram accepts a whitelist and errors on
 *     anything outside it, so the smaller the set the fewer ways a send can
 *     fail. It is also the design: the subject, the score line's numbers and
 *     the closing instruction are bold, the address is monospace, and nothing
 *     else is marked at all. Bold everywhere is bold nowhere.
 *   * NEWLINES STAY NEWLINES. HTML mode preserves them; `<br>` is not in the
 *     whitelist and would be a 400.
 *
 * NO EMOJI, anywhere. The pictograms this file used to carry were removed after
 * the first real delivered alert was read back: a column of coloured glyphs in
 * front of every fact reads as a toy next to a message about someone's money,
 * and the emoji were also doing a job they cannot do - a 🚨 is not a severity
 * scale, and the fact lines were the same glyphs whether the news was bad or
 * fine. `formatWelcome` was de-emojied first; this brings the alert, the
 * all-clear and the simulation marker onto the same plain professional voice.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP:
 *
 *   1. Say what happened and for WHOM, first. A watchlist made "your position"
 *      ambiguous - the reader may be watching ten wallets - so the subject is
 *      the subscriber's own LABEL plus the address, never a bare pronoun.
 *   2. Never contradict yourself. A score of 15 described as LOW, next to a
 *      limit of 25, with an alert attached, is three facts that argue. The
 *      score line names the WARN boundary (`warnFrom`), which is the number the
 *      position actually crossed.
 *   3. Round for humans. Every number that reaches a chat is rounded here:
 *      scores and drivers to integers, health factor to two decimals, dollars
 *      to whole dollars. A driver printed as 38.41310180298047 is the engine
 *      talking to itself out loud.
 *   4. Omit rather than invent. A fact we do not hold gets no line - never a
 *      zero, never a dash. The floor is the other half of that rule: the
 *      subject and the score line are built ONLY from columns the transition
 *      row always has, so no combination of missing snapshot facts can produce
 *      a message that is all advice and no facts.
 */

import { TARGET_HF } from "../advisor/repayMath";
import { COMPOSITE_WEIGHTS } from "../params";
import { ALERT_THRESHOLD, warnFrom } from "../profile";
import { drawdownToLiquidation, formatDrawdownPct } from "../prospective";
import { DRIVER_KEYS, DRIVER_LABEL } from "../scoreVocabulary";
import { simulationAlertLine, SIMULATION_ALERT_FOOTER } from "../simulation";
import type { SimulationMark } from "../simulation";
import type { DegradableSubScores, ProfileStatus, Protocol, RiskProfile } from "../types";
import type { WatchTransition } from "./loop";

/**
 * The three characters Telegram's HTML parser reads as markup.
 *
 * Deliberately not a general-purpose HTML escaper: quotes are left alone
 * because this file emits no attributes, and a label reading `"hax"` should
 * reach the user as `"hax"` rather than as a mouthful of entities. Order
 * matters - `&` first, or the ampersands introduced by the other two get
 * escaped a second time and the user reads `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const b = (content: string): string => `<b>${content}</b>`;

/** Health factor below which we explicitly flag "close to liquidation". */
const NEAR_LIQUIDATION_HF = 1.15;

/** Longest label we will print. Agrees with `WATCHLIST_LABEL_MAX` server-side. */
const LABEL_MAX = 60;

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
  within: "under your limit",
  approaching: "nearing your limit",
  outside: "over your limit",
};

/**
 * The same clause with the reader's PROFILE named in it, for the headline.
 *
 * The profile belongs in the first line because it is half of what makes the
 * alert legible: "nearing your limit" invites the question the score line then
 * answers, and "nearing your conservative limit" has already begun answering
 * it. Inside the body the shorter form is used, where the profile has just been
 * stated and repeating it reads as a machine filling a template.
 */
function limitClause(status: ProfileStatus, profile: RiskProfile): string {
  if (status === "within") return `back under your ${profile} limit`;
  if (status === "approaching") return `nearing your ${profile} limit`;
  return `over your ${profile} limit`;
}

/** Position facts the dispatcher reads from the latest score snapshot. */
export interface AlertExtras {
  /**
   * The subscriber's own name for the watched wallet
   * (`watch_subscriptions.label`), or null when they never gave it one.
   *
   * This is the whole reason the drain selects the subscription row: with a
   * watchlist, "your position is nearing your limit" no longer identifies
   * anything, and the address alone is not what the reader called it. The label
   * is user-written text and is normalised on the way in (whitespace collapsed,
   * length capped) because it is being pasted into the FIRST line of a message
   * whose layout is the only structure a plain-text chat has.
   */
  label?: string | null;
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
 * A sub-score as a user reads it: a whole number out of 100.
 *
 * The engine keeps sub-scores as full-precision floats because the composite is
 * a weighted sum of them and rounding four terms before adding them moves the
 * total. Nothing a person reads needs that precision, and the unrounded form
 * shipped once: "Asset volatility 38.41310180298047" went out in a real alert.
 */
function outOf100(value: number): string {
  return String(Math.round(value));
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
      return `${asset} is moving at crash-level volatility (${outOf100(assetRisk)} of 100 on asset risk) and liquidation is only a ${pct} drop away.`;
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
      `${PROTOCOL_LABEL[f.protocol] ?? f.protocol} is carrying elevated protocol risk (${outOf100(f.subScores.protocolSafety)} of 100 on audits, governance and market controls).`,
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
  return DRIVER_KEYS.map((key) => ({ key, value: subScores[key] }))
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
 * Falls back to `driver:<key>`, which is not a sentence but a marker: the
 * dominant-driver case is rendered by `explainLine` as ONE line carrying every
 * driver, because a "why now" that repeats the top driver and is then followed
 * by a list starting with that same driver is the same fact said twice.
 * Null only when there is nothing measured to report at all.
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
    text: `${DRIVER_LABEL[top.key]} is the largest contributor to this score, at ${outOf100(top.value)} of 100.`,
  };
}

/**
 * Sub-score breakdown, on demand (7.1). Unmeasured terms are OMITTED, never
 * printed as 0 - "not measured" and "measured, and calm" are different facts.
 * Lower-cased because this phrase is always used mid-sentence.
 */
export function formatSubScores(subScores: DegradableSubScores): string | null {
  const parts = drivers(subScores).map(
    (d) => `${DRIVER_LABEL[d.key].toLowerCase()} ${outOf100(d.value)}`,
  );
  return parts.length === 0 ? null : parts.join(", ");
}

/** First letter up, for a phrase that has become the start of a sentence. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The explanation, as ONE line.
 *
 * Two shapes, because the two cases carry different news. When a named trigger
 * fired (a thin buffer, a degraded feed) the sentence is that trigger's, and
 * the drivers follow it as context. When nothing named fired, the reason IS the
 * dominant driver, and the line says so once and then lists the rest - the old
 * two-line form printed the top driver in the "why now" sentence and again at
 * the head of the breakdown, with fourteen decimal places on both copies.
 */
function explainLine(why: WhyNowInput): string | null {
  const explained = whyNow(why);
  if (!explained) return null;
  const ranked = drivers(why.facts.subScores);

  if (explained.trigger.startsWith("driver:")) {
    const top = ranked[0];
    if (top === undefined) return null;
    const rest = ranked.slice(1).map((d) => `${DRIVER_LABEL[d.key].toLowerCase()} ${outOf100(d.value)}`);
    const head = `Main driver: ${DRIVER_LABEL[top.key].toLowerCase()} (${outOf100(top.value)} of 100).`;
    return rest.length === 0 ? head : `${head} ${sentenceCase(rest.join(", "))}.`;
  }

  const breakdown = formatSubScores(why.facts.subScores);
  return breakdown === null
    ? `Why now: ${explained.text}`
    : `Why now: ${explained.text} Risk drivers: ${breakdown}.`;
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
 * A user-written label, safe to put in the first line of a chat message.
 *
 * Newlines and runs of whitespace are collapsed because the message's only
 * structure is its line breaks, and an over-long label is cut rather than
 * allowed to push the address off the readable part of a push preview. Nothing
 * is escaped: the send is plain text with no parse mode, so there is no markup
 * for a label to break out of.
 */
function cleanLabel(label: string | null | undefined): string | null {
  if (typeof label !== "string") return null;
  const collapsed = label.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= LABEL_MAX ? collapsed : `${collapsed.slice(0, LABEL_MAX - 3).trimEnd()}...`;
}

/**
 * WHICH position this is about: the reader's own name for it, the address, and
 * the protocol.
 *
 * Built only from the transition row and the subscription, so it is available
 * for every message ever sent. The label goes FIRST and the address stays
 * beside it, for the reason the app's wallet switcher does the same thing: a
 * name alone cannot be checked against a wallet, and an address alone is not
 * what anyone called it.
 */
function subjectOf(t: WatchTransition, extras: AlertExtras): string {
  // Monospace, because an address is a string to COMPARE, not to read: a
  // proportional font makes 0x12a5 and 0x12ab the same shape at a glance. It
  // sits inside the bold subject line, which Telegram has allowed since nested
  // entities landed in Bot API 4.5.
  const wallet = `<code>${escapeHtml(truncateWallet(t.wallet))}</code>`;
  const label = cleanLabel(extras.label);
  const protocol = escapeHtml(PROTOCOL_LABEL[t.protocol] ?? t.protocol);
  const who = label ? `${escapeHtml(label)} (${wallet})` : wallet;
  return `${who} on ${protocol}`;
}

/**
 * The score, the user's limit, and - when the position is merely APPROACHING -
 * the boundary that actually fired the alert.
 *
 * That last clause is the fix for the message that argued with itself. A real
 * alert read "Risk score 15 / 100 (LOW), your conservative limit is 25", which
 * tells a reader that a low score below their limit has alarmed us and leaves
 * them to guess why. The number comes from `warnFrom`, the same function
 * `statusFor` decides with, so it is the boundary that was crossed rather than
 * a second copy of the arithmetic. The band is gone with it: "LOW" was the word
 * doing most of the contradicting, and it is derivable from the score anyway.
 */
function scoreLine(t: WatchTransition): string {
  const limit = ALERT_THRESHOLD[t.profile];
  // The three numbers are the line's whole argument, and they are what a reader
  // scans for; the words around them are scaffolding. Nothing else in the fact
  // block is marked, so this is where the eye lands.
  const base = `Risk score ${b(String(Math.round(t.score)))} of 100. Your ${t.profile} limit is ${b(String(limit))}`;
  return t.to === "approaching"
    ? `${base}, and alerts warn from ${b(String(warnFrom(t.profile)))}.`
    : `${base}.`;
}

/**
 * The optional facts: the price-drop buffer, the health factor and the position
 * size. Every omission is deliberate - a line whose value is unknown is
 * dropped, never filled with a zero.
 *
 * Optional is the operative word. Nothing here is load-bearing, which is what
 * makes the facts-empty message impossible: `subjectOf` and `scoreLine` above
 * are unconditional and read only columns `watch_transitions` always holds.
 */
function optionalFactLines(extras: AlertExtras): string[] {
  const lines: string[] = [];

  const hfValue = extras.healthFactor;
  if (hfValue != null && Number.isFinite(hfValue)) {
    // Consequence first, ratio behind it (DESIGN_SYSTEM: "lead with the
    // consequence, not the ratio"). A chat message has no hover, so the exact
    // health factor stays on its own line rather than being deleted. The buffer
    // needs the scored collateral's name, which only the advisor facts carry.
    const symbol = extras.why?.facts.scoredCollateralSymbol;
    if (symbol !== undefined) {
      const pct = dropPct(hfValue);
      // The symbol is read off a chain, so it is not ours and gets escaped.
      const asset = escapeHtml(assetName(symbol));
      lines.push(
        pct === null
          ? `Can be liquidated at today's ${asset} price.`
          : `Liquidates if ${asset} falls ${pct}.`,
      );
    }
    const hf = hfValue.toFixed(2);
    lines.push(
      hfValue < NEAR_LIQUIDATION_HF
        ? `Health factor ${hf}, which is close to liquidation.`
        : `Health factor ${hf}.`,
    );
  }

  const collateral = usd(extras.collateralUsd);
  const borrow = usd(extras.borrowUsd);
  if (collateral && borrow) lines.push(`Position ${collateral} collateral and ${borrow} debt.`);

  return lines;
}

/**
 * Welcome message sent when a user connects their Telegram via the /start <code>
 * deep-link. Plain text, hyphens only (house style). Shared by both webhook
 * handlers (Railway api-server + Vercel fallback) so the copy never drifts.
 */
export function formatWelcome(wallet: string): string {
  return [
    "Welcome to PANIK alerts.",
    "",
    `This chat is linked to wallet ${truncateWallet(wallet)}.`,
    "",
    "You will get a message here when this position moves toward its liquidation limit, and again when it recovers. Alerts are deduplicated, so a quiet chat means nothing needs your attention.",
    "",
    "Send /stop at any time to pause alerts.",
  ].join("\n");
}

/**
 * The simulation marker, FIRST - and that placement is the requirement rather
 * than a preference: a push notification shows the opening characters and
 * nothing else, so a marker buried in the body reaches the user only after they
 * have already believed the headline. A crash alert for a crash that did not
 * happen is the worst false alarm a liquidation alerter can send - it teaches
 * the user to discount the next one, which is the real one.
 *
 * The transition's own stamp is the record of what was true at the crossing;
 * `extras` only fills in for the dispatcher reading it back out of a row.
 *
 * Its own function, not part of the fact block, because the ALL-CLEAR needs the
 * same marker under a different headline: "nothing to do" issued against a
 * price that never moved misleads exactly as much as the alert does, and a
 * shared fact block cannot carry two headlines.
 */
function simulationOf(t: WatchTransition, extras: AlertExtras): SimulationMark | null {
  return t.simulation ?? extras.simulation ?? null;
}

/**
 * The marker, bold. `simulationAlertLine` owns the words (simulation.ts is the
 * one place a drill is described, so the banner, the console and this cannot
 * diverge); this owns the markup, and escapes the whole sentence because the
 * scenario label inside it was typed by an operator.
 */
function simulationLine(mark: SimulationMark): string {
  return b(escapeHtml(simulationAlertLine(mark)));
}

/**
 * Build the alert body for a transition INTO approaching/outside. Recovery
 * transitions go to `formatResolution` instead.
 */
export function formatAlert(t: WatchTransition, extras: AlertExtras = {}): string {
  const outside = t.to === "outside";
  const simulation = simulationOf(t, extras);

  const lines: string[] = [];
  if (simulation) {
    lines.push(simulationLine(simulation));
    lines.push("");
  }
  lines.push(b(`${subjectOf(t, extras)} is ${limitClause(t.to, t.profile)}.`));
  lines.push("");
  lines.push(scoreLine(t));
  lines.push(...optionalFactLines(extras));

  // Why this alert, now. Sits directly under the facts it cites.
  const explained = extras.why ? explainLine(extras.why) : null;
  if (explained) {
    lines.push("");
    lines.push(escapeHtml(explained));
  }

  lines.push("");
  lines.push(
    b(
      outside
        ? "Add collateral or repay debt to pull this back under your limit."
        : "Add collateral or repay debt to widen the buffer.",
    ),
  );

  if (simulation) {
    lines.push("");
    lines.push(SIMULATION_ALERT_FOOTER);
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
    lines.push(simulationLine(simulation));
    lines.push("");
  }
  lines.push(b(`${subjectOf(t, extras)} is ${limitClause(t.to, t.profile)}.`));
  lines.push("");
  lines.push(scoreLine(t));
  lines.push(...optionalFactLines(extras));
  lines.push("");
  lines.push(
    t.from === null || t.from === "within"
      ? `What changed: this position is now ${LIMIT_STATE.within}.`
      : `What changed: this position was ${LIMIT_STATE[t.from]}, and is now back under it.`,
  );
  lines.push("");
  lines.push(
    b("Nothing to do. PANIK keeps watching and will message you again if it drifts back toward your limit."),
  );
  if (simulation) {
    lines.push("");
    lines.push(SIMULATION_ALERT_FOOTER);
  }

  return lines.join("\n");
}
