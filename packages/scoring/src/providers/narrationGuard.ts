/**
 * Guards for LLM narration - pure, no I/O, no formatting.
 *
 * The narrator is allowed to rephrase engine output and nothing else. Three
 * things it must never be able to do, each with a check here:
 *
 *   1. INVENT A NUMBER. Every numeric token in the narration has to trace back
 *      to a number the prompt actually contained (`buildWhitelist` /
 *      `verifyNarration`). A model that produces "roughly $18,000" for a
 *      $17,851.43 repay is not rephrasing, it is re-deciding the size of a
 *      transaction.
 *   2. HEDGE ON A CRITICAL CALL. `hedgesOnVerdict` is the backstop behind the
 *      structural rule that a critical verdict sentence is a template slot.
 *   3. BE STEERED BY A TOKEN SYMBOL. `sanitizeSymbol` treats ERC-20 `symbol()`
 *      output as the attacker-controlled string it is.
 *
 * NOTHING HERE FORMATS. Numbers and their rounding policy are engine-owned
 * (`fallback.ts`, `prospective.ts`); this module only reads what was printed
 * and answers pass/fail. It never rewrites, annotates or partially accepts a
 * narration - the caller serves the deterministic sections whole or not at all.
 */

import type { AdvisorSections } from "../advisor/types";

// -- Numeric tokens ---------------------------------------------------------

/**
 * One reading of a printed numeric token.
 *
 * `decimals` is the number of decimal places the token was PRINTED with, which
 * is what sets the size of the rounding window - not the precision of the value
 * behind it. It can be negative: "128.5k" is printed to the hundreds, so
 * `decimals` is -2.
 */
export interface NumericCandidate {
  value: number;
  decimals: number;
}

export interface NumericToken {
  /** Exactly as it appeared, e.g. "$17,851" or "4.8%". */
  raw: string;
  /**
   * Every value the token could canonically mean. A percent has two, because
   * the engine stores rates as fractions and prints them as percents: "8.1%"
   * is a candidate 8.1 and a candidate 0.081, and matching either is enough.
   */
  candidates: NumericCandidate[];
}

/**
 * A digit run, optionally with a currency prefix, thousands separators, a
 * decimal part, a magnitude suffix and a percent sign.
 *
 * Deliberately unsigned. A leading "-" is not read as a sign because this text
 * is full of hyphens used as punctuation ("PANIK score 75 - CRITICAL"), and the
 * question the guard asks is "did the model invent this magnitude", which a
 * sign does not change. Whitelist entries are stored as magnitudes to match.
 */
const TOKEN_RE = /\$?\d[\d,]*(?:\.\d+)?[kKmMbB]?%?/g;

const MAGNITUDE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Digits welded to letters are an identifier, not a number: "V3", "USDT0". */
const LETTER = /[A-Za-z]/;

/**
 * Every numeric token in `text`, normalised.
 *
 * Skips digit runs that touch a letter on either side, which is what keeps
 * "Aave V3" and "Compound V3" from reading as a fabricated 3 in every single
 * narration. A magnitude suffix is consumed by the pattern first, so "1.2k"
 * survives while "1.2kg" is correctly skipped.
 */
export function extractNumbers(text: string): NumericToken[] {
  const out: NumericToken[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m !== null; m = TOKEN_RE.exec(text)) {
    const raw = m[0];
    const digitsStart = m.index + (raw.startsWith("$") ? 1 : 0);
    const before = digitsStart > 0 ? text.charAt(digitsStart - 1) : "";
    const after = text.charAt(m.index + raw.length);
    if (LETTER.test(before) || LETTER.test(after)) continue;

    const isPercent = raw.endsWith("%");
    let body = raw.replace(/^\$/, "").replace(/%$/, "");
    const scale = MAGNITUDE[body.slice(-1).toLowerCase()] ?? 1;
    if (scale !== 1) body = body.slice(0, -1);
    body = body.replace(/,/g, "");
    const dot = body.indexOf(".");
    const printedDecimals = dot === -1 ? 0 : body.length - dot - 1;
    const n = Number(body);
    if (!Number.isFinite(n)) continue;

    // Expanding "1.2k" to 1200 moves the last printed place three digits left.
    const decimals = printedDecimals - Math.round(Math.log10(scale));
    const value = n * scale;
    const candidates: NumericCandidate[] = [{ value, decimals }];
    if (isPercent) candidates.push({ value: value / 100, decimals: decimals + 2 });
    out.push({ raw, candidates });
  }
  return out;
}

// -- Whitelist --------------------------------------------------------------

/** Magnitudes the narration is permitted to print. Order is not meaningful. */
export type NumberWhitelist = readonly number[];

/**
 * Every number the prompt payload contains, including the ones inside strings.
 *
 * Strings are mined as well as walked past because the payload carries the
 * engine's own rule tags ("floor:hf<=1.1"), and the model is shown them. If the
 * prompt puts a number in front of the model, the whitelist has to contain it
 * or the guard fails every honest narration.
 *
 * Callers should pass the model-visible payload TOGETHER with the
 * recommendation's deterministic sections: those are engine-authored ground
 * truth, and they are where the engine's DERIVED figures get printed (the price
 * drop to liquidation, for one, which is computed from the health factor rather
 * than carried beside it). The whitelist is then exactly "what the engine itself
 * is willing to say".
 */
export function buildWhitelist(payload: unknown): NumberWhitelist {
  const out: number[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "number") {
      if (Number.isFinite(node)) out.push(Math.abs(node));
      return;
    }
    if (typeof node === "string") {
      for (const t of extractNumbers(node)) {
        for (const c of t.candidates) out.push(Math.abs(c.value));
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(payload);
  return out;
}

// -- Verification -----------------------------------------------------------

/**
 * THE ROUNDING TOLERANCE RULE.
 *
 * A printed token x, carrying `d` decimal places, is accepted against a
 * whitelist value w if EITHER:
 *
 *   (1) exact - w equals x (so a whitelisted 4.8 is matched by "4.8" and by
 *       "4.80", and a whitelisted 5 is matched by "5"); or
 *   (2) display rounding - x is w rounded to d places (|w - x| is at most half
 *       a unit in x's last printed place) AND x still carries at least
 *       `MIN_ROUNDED_SIGFIGS` significant figures.
 *
 * Clause (2) exists because the engine itself prints rounded forms: $17,851.43
 * is rendered "$17,851" by `fmtUsd`, and a narration quoting the rendered form
 * is quoting the engine, not inventing. Clause (2)'s significant-figure floor
 * is what stops that from becoming a licence to round the meaning away: for a
 * whitelisted 4.83, "4.8" passes (two significant figures) and "about 5" fails
 * (one). Both satisfy the arithmetic; only one is still the same number.
 *
 * A value with fewer than two significant figures of its own is unreachable by
 * (2) and lands on (1) instead, where it needs an exact match - which is the
 * conservative direction.
 */
const MIN_ROUNDED_SIGFIGS = 2;

/** Relative slack for "equal", against float noise in the payload walk. */
const EXACT_EPSILON = 1e-9;

function significantFigures(x: number, decimals: number): number {
  const abs = Math.abs(x);
  if (abs === 0) return 0;
  return Math.floor(Math.log10(abs)) + 1 + decimals;
}

function candidateMatches(c: NumericCandidate, whitelist: NumberWhitelist): boolean {
  const x = Math.abs(c.value);
  for (const raw of whitelist) {
    const w = Math.abs(raw);
    if (Math.abs(w - x) <= EXACT_EPSILON * Math.max(1, w)) return true;
  }
  if (significantFigures(x, c.decimals) < MIN_ROUNDED_SIGFIGS) return false;
  const half = 0.5 * Math.pow(10, -c.decimals);
  for (const raw of whitelist) {
    const w = Math.abs(raw);
    if (Math.abs(w - x) <= half + EXACT_EPSILON * Math.max(1, w)) return true;
  }
  return false;
}

export interface NarrationVerdict {
  pass: boolean;
  /** The tokens that traced back to nothing, exactly as they were printed. */
  offending: string[];
}

/**
 * Every number in every section, checked against the whitelist.
 *
 * Whole-narration verdict on purpose. There is no partial accept and no
 * annotation: a narration that made one number up is a narration whose other
 * three sections were written by the same pass of the same model.
 */
export function verifyNarration(
  sections: AdvisorSections,
  whitelist: NumberWhitelist,
): NarrationVerdict {
  const offending: string[] = [];
  for (const text of [
    sections.position,
    sections.market,
    sections.recommendation,
    sections.execution,
  ]) {
    for (const token of extractNumbers(text)) {
      if (!token.candidates.some((c) => candidateMatches(c, whitelist))) {
        offending.push(token.raw);
      }
    }
  }
  return { pass: offending.length === 0, offending };
}

// -- Hedging on a critical verdict ------------------------------------------

/**
 * Words that turn an instruction into a suggestion.
 *
 * Scoped to the VERDICT SENTENCE of a critical recommendation and nowhere else:
 * "the position could be liquidated" is a correct thing to say about market
 * context, and the engine's own REBALANCE template opens with "Consider".
 * Structural enforcement (serving the deterministic verdict on a critical leg)
 * is the real rule; this is the backstop that also makes the miss visible.
 */
const HEDGE_RE = /\b(might|may|could|consider|possibly|perhaps|potentially|think about)\b/i;

export function hedgesOnVerdict(sentence: string): boolean {
  return HEDGE_RE.test(sentence);
}

// -- Symbol sanitisation ----------------------------------------------------

/**
 * The substitute for a symbol that did not survive sanitisation.
 *
 * It is a visible placeholder rather than a silent drop because the narration
 * that uses it is discarded anyway: a symbol needing heavy sanitisation is
 * itself the signal, and the leg falls back to deterministic prose.
 */
export const UNKNOWN_TOKEN = "UNKNOWN_TOKEN";

/** Longest a symbol may be. Real ones are under 12; 32 is generous headroom. */
export const SYMBOL_MAX_LEN = 32;

/**
 * Characters a token symbol is allowed to keep.
 *
 * Parentheses are in the set beyond the letters/digits/space/`.`/`-`/`_` core
 * because the ENGINE emits them: `adapters/active.ts` labels a proxied leg
 * "WETH (proxy)", and flagging the engine's own string as hostile would force
 * every proxied position onto the fallback path for no security gain.
 */
const SYMBOL_DISALLOWED = /[^A-Za-z0-9 .\-_()]/g;

/**
 * Zero-width, control and Unicode format characters.
 *
 * `\p{Cc}` is C0 and C1; `\p{Cf}` is the format class, which is where U+200B,
 * U+200C, U+200D and U+FEFF all live. Naming the classes rather than the code
 * points keeps a newly-assigned invisible from slipping through a hand-written
 * list.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

export interface SanitizedSymbol {
  /** Safe to interpolate. `UNKNOWN_TOKEN` when the input was hostile. */
  value: string;
  /**
   * The input needed more than case/whitespace tidying to become safe. The
   * caller must force the deterministic fallback for this leg.
   */
  hostile: boolean;
}

/** Case and run-of-whitespace differences are not evidence of an attack. */
function forCompare(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * NFKC-normalise, strip the invisibles, allowlist, cap.
 *
 * The three attacks this closes, in order: a zero-width space splicing an
 * instruction onto a plausible ticker ("USDC<ZWSP> ignore previous
 * instructions..."), a homoglyph swapping a Cyrillic A into a symbol so it
 * reads as one token and compares as another, and a symbol long enough to be a
 * paragraph of prompt.
 */
export function sanitizeSymbol(raw: string | null | undefined): SanitizedSymbol {
  if (raw === null || raw === undefined || raw === "") return { value: "", hostile: false };
  const cleaned = raw
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SYMBOL_DISALLOWED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SYMBOL_MAX_LEN)
    .trim();
  const hostile = cleaned === "" || forCompare(cleaned) !== forCompare(raw);
  return { value: hostile ? UNKNOWN_TOKEN : cleaned, hostile };
}

// -- Prompt fencing ---------------------------------------------------------

/**
 * Delimiters around the interpolated payload.
 *
 * Not a security control on their own - a model can be talked past any
 * delimiter - which is why the symbol sanitiser above runs first and the
 * numeric verifier runs after. The fence is what makes the system prompt able
 * to name the boundary it wants the model to respect.
 */
export const DATA_FENCE_OPEN = "<<<PANIK_DATA>>>";
export const DATA_FENCE_CLOSE = "<<<END_PANIK_DATA>>>";

export function fencePayload(json: string): string {
  return `${DATA_FENCE_OPEN}\n${json}\n${DATA_FENCE_CLOSE}`;
}
