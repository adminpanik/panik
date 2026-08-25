/**
 * The alert CARD - one PNG, rendered here, that says the same thing the message
 * says in the shape the app says it.
 *
 * WHY AN IMAGE AT ALL. A Telegram notification is a strip of text on a lock
 * screen, and the thing a reader needs from it in the first half second is not
 * a sentence: it is "how bad, and whose". The dial answers the first before any
 * word is read, which is exactly the job it does in the app - and drawing it
 * the same way here is the point. A second visual language for the same
 * quantity would teach the user that the chat and the dashboard are two
 * products.
 *
 * WHY LOCAL RENDERING. `@resvg/resvg-js` rasterises an SVG in-process. No
 * headless browser, no image service, no third party being told which wallet is
 * about to be liquidated - the card is built from facts we already hold and
 * never leaves this process until Telegram gets it.
 *
 * NOTHING HERE IS ALLOWED TO BREAK AN ALERT. `renderAlertCard` catches
 * everything and returns null: a missing font file, a corrupt logo, an OOM in
 * the rasteriser, a resvg version that dislikes an attribute. The dispatcher
 * treats null as "send the text", which is the product working. An alert that
 * did not arrive because its decoration failed is the worst possible trade in a
 * liquidation warner, so the failure mode is spelled out in code rather than
 * left to a try/catch someone might later tidy away.
 *
 * COLOURS ARE COPIED, DELIBERATELY. The five ramp hexes and the three text
 * greys below are the values in `src/index.css @theme`, restated because this
 * process cannot read a stylesheet and an SVG cannot resolve a CSS variable.
 * They are the ONLY duplicated design values in the server, and the comment on
 * each one names the token it mirrors so a ramp change has something to grep.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CARD_HEADLINE,
  escapeHtml,
  protocolLabel,
  truncateWallet,
} from "../packages/scoring/src/watch/alertMessage";
import type { Band, ProfileStatus, Protocol, RiskProfile } from "../packages/scoring/src/types";

/** `--color-risk-*` in src/index.css. HIGH is the brand orange, by design. */
const BAND_COLOR: Record<Band, string> = {
  LOW: "#10B981",
  ELEVATED: "#F59E0B",
  HIGH: "#F97316",
  CRITICAL: "#F87171",
};
/** `--color-risk-unknown`. Used when a band arrives that this table does not hold. */
const UNKNOWN_COLOR = "#7A8699";

/**
 * TWO COLOUR CHANNELS, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   * The ARC is coloured by the score's BAND. That is the engine's claim about
 *     the number, and it is the same claim the app's dial makes, which is why
 *     it must not be adjusted here: a 15 is LOW, and drawing it as anything
 *     else would mean the card and the dashboard disagree about one score.
 *   * The HEADLINE is coloured by what the EVENT means for this reader. A
 *     conservative user is warned at 15, and 15 is genuinely LOW - so the arc
 *     is green and the sentence beside it is amber, because "nearing your
 *     limit" is a warning whatever the absolute band says.
 *
 * Collapsing the two produced the bug this table exists to prevent: a green
 * "Nearing your risk limit", a warning painted in the colour of reassurance.
 * That is the one direction this product can never be wrong in.
 *
 * The single exception runs the other way, and only ever escalates. A CRITICAL
 * band under "over your limit" keeps critical red rather than being toned down
 * to the high orange, because there the band is the WORSE of the two claims and
 * muting it would be the same mistake inverted.
 */
const EVENT_COLOR: Record<ProfileStatus, string> = {
  approaching: BAND_COLOR.ELEVATED,
  outside: BAND_COLOR.HIGH,
  within: BAND_COLOR.LOW,
};

function headlineColor(status: ProfileStatus, band: Band): string {
  if (status === "outside" && band === "CRITICAL") return BAND_COLOR.CRITICAL;
  return EVENT_COLOR[status] ?? EVENT_COLOR.approaching;
}

/** `--color-surface-base`, `--color-text-*`, `--color-border-subtle`. */
const SURFACE = "#09090B";
const TEXT_PRIMARY = "#F8FAFC";
const TEXT_SECONDARY = "#94A3B8";
const TEXT_MUTED = "#7A8699";
const BORDER_SUBTLE = "rgba(255,255,255,0.08)";

/** Logical size. The raster is 2x this, for a screen that is always retina. */
const WIDTH = 800;
/**
 * Shorter than it was, because the card lost a line rather than gaining
 * whitespace: the limit sub-line moved out entirely (it belongs in the message,
 * where it has room to explain itself) and the label folded into the identity
 * line. Keeping 420 would have left the content floating in a band of empty
 * ground, which reads as a rendering fault rather than as restraint.
 */
const HEIGHT = 360;
const SCALE = 2;

/**
 * The right column: where it starts, and how much room it has.
 *
 * `CARD_CONTENT_WIDTH` is what every line on that column must fit inside, and
 * it is exported because the truncation tests assert against it rather than
 * against a number they retype.
 */
const CONTENT_LEFT = 330;
/**
 * Right margin. Generous, because the width estimate below is an estimate: the
 * padding is the slack that keeps a slightly-under-measured line off the edge
 * rather than one pixel inside it.
 */
const CONTENT_RIGHT_PAD = 56;
export const CARD_CONTENT_WIDTH = WIDTH - CONTENT_LEFT - CONTENT_RIGHT_PAD;

/** Type sizes. The identity lines share the address's size on purpose. */
const HEADLINE_SIZE = 34;
const IDENTITY_SIZE = 22;

/**
 * The identity stack's rhythm, in baseline offsets.
 *
 * The gap before the address is bigger than the one inside the name/platform
 * pair, and that is the structure rather than decoration: the first two lines
 * are what the reader CALLS this position, and the third is what it actually
 * IS. Grouping by spacing says so without a label or a rule.
 */
const HEADLINE_BASELINE = 168;
const IDENTITY_STEP = 32;
const ADDRESS_GAP = 48;
/** Rough cap height and descender at `IDENTITY_SIZE`, for centring the stack. */
const CAP = 16;
const DESCENDER = 5;

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "assets", "fonts");

/**
 * The three faces the card draws with, vendored under `server/assets/fonts`.
 *
 * resvg has no system fonts to fall back on inside the container, so a missing
 * file is not a substituted face - it is a card with no text on it. They are
 * therefore loaded once, eagerly, and a failure is surfaced to the caller as
 * "no card" rather than as a silently blank image.
 */
const FONT_FILES = [
  join(FONT_DIR, "PlusJakartaSans-Bold.ttf"),
  // The identity line is set at 500, and 500 has to EXIST: with only 400 and
  // 700 loaded, fontdb resolves a declared 500 to one of them, so the markup
  // would be claiming a weight the image does not have.
  join(FONT_DIR, "PlusJakartaSans-Medium.ttf"),
  join(FONT_DIR, "PlusJakartaSans-Regular.ttf"),
  join(FONT_DIR, "JetBrainsMono-Regular.ttf"),
];

/**
 * `public/panik-mark.svg`'s path `d`, extracted once. Null when the file
 * cannot be read or the path cannot be found; the card then omits the mark
 * but still carries the "PANIK" wordmark, which is the part that actually
 * has to survive - see `alertCardSvg`.
 */
let brandMarkD: string | null | undefined;
function brandMarkPath(): string | null {
  if (brandMarkD === undefined) {
    try {
      const svg = readFileSync(join(HERE, "..", "public", "panik-mark.svg"), "utf8");
      const match = svg.match(/<path[^>]*\sd="([^"]+)"/);
      brandMarkD = match ? match[1] : null;
    } catch {
      brandMarkD = null;
    }
  }
  return brandMarkD;
}

export interface AlertCardInput {
  /** 0-100. Rounded for display, exactly as the message rounds it. */
  score: number;
  band: Band;
  /** Drives the headline. `within` is the all-clear. */
  status: ProfileStatus;
  profile: RiskProfile;
  /** The WATCHED wallet, not the subscriber's. */
  wallet: string;
  protocol: Protocol;
  /** The subscriber's own name for the wallet, or null. */
  label?: string | null;
  /**
   * The chain this score was read from, as `ScoringChainConfig.label` spells it
   * ("Base", "Base Sepolia").
   *
   * Threaded in rather than assumed, because the honest answer differs per
   * worker: a testnet worker scores Base Sepolia, and a card that says "Base"
   * over a Sepolia position is a false claim about where someone's money is.
   * Omitted means the caller does not know, and the segment is then dropped -
   * never guessed, which is the same rule the message body follows.
   */
  chainLabel?: string | null;
  simulated?: boolean;
}

/**
 * Advance width of one character, as a fraction of the font size.
 *
 * An ESTIMATE, and deliberately so: the exact answer needs the font's `hmtx`
 * table, and parsing a TTF to place one line of text would make the renderer's
 * failure surface bigger than the thing it renders. Four buckets get within a
 * few percent for Latin text at these sizes, and every one of them is rounded
 * UP rather than down - the cost of over-estimating is a label clipped one
 * character early, and the cost of under-estimating is a name running off the
 * edge of the card, which is the bug this exists to prevent.
 */
function charWidth(ch: string): number {
  if (" .,:;'`|!ijltfrI[]()".includes(ch)) return 0.32;
  if ("mwMW@%".includes(ch)) return 0.92;
  if (ch >= "A" && ch <= "Z") return 0.68;
  return 0.58;
}

/** Estimated rendered width of `text`, in px, at `fontSize`. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += charWidth(ch);
  return em * fontSize;
}

/**
 * Cut a string so its rendered width fits `maxWidth`, with an ellipsis when it
 * had to give something up.
 *
 * Width rather than character count, which is what the joined single line got
 * wrong: "Simulation target" and "My extremely long-term leveraged cbBTC
 * position" are both "a label", and a budget in characters cannot tell a narrow
 * one from a wide one. The ellipsis is measured too, so the result including
 * its three dots is what fits.
 */
export function clipToWidth(text: string, fontSize: number, maxWidth: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (estimateTextWidth(t, fontSize) <= maxWidth) return t;

  const ellipsis = "...";
  const budget = maxWidth - estimateTextWidth(ellipsis, fontSize);
  let width = 0;
  let cut = 0;
  for (const ch of t) {
    const next = width + charWidth(ch) * fontSize;
    if (next > budget) break;
    width = next;
    cut += ch.length;
  }
  return `${t.slice(0, cut).trimEnd()}${ellipsis}`;
}

/** The dial, drawn the way `src/panik-core/ui/RiskDial.tsx` draws it. */
function dial(score: number, color: string): string {
  const cx = 168;
  const cy = HEIGHT / 2;
  const r = 86;
  const stroke = 14;
  const circumference = 2 * Math.PI * r;
  // Clamped, because an out-of-range score must not draw an arc longer than
  // the circle - the geometry IS the claim "this much of the way to 100".
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${BORDER_SUBTLE}" stroke-width="${stroke}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
          stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}"
          stroke-dashoffset="${(circumference * (1 - pct)).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy}" fill="${TEXT_PRIMARY}" font-family="Plus Jakarta Sans" font-weight="700"
        font-size="76" text-anchor="middle" dominant-baseline="central">${Math.round(score)}</text>`;
}

/**
 * The drill chip's word, and the room it needs.
 *
 * ONE WORD, because the chip is a TAG and not a sentence. "SIMULATED DRILL" in
 * a 228px pill was, on a real phone, the widest amber object on the card and
 * visually heavier than the brand lockup it sits opposite - which inverts the
 * hierarchy: what a reader must recognise first is whose warning this is, and
 * only then that this particular one is a rehearsal. The full explanation is not
 * lost, it is where it always belonged: the message says "Simulated event
 * (label) - prices in this alert are from an armed drill, not the market", both
 * above the body and again in the footer, where there is room to say it once
 * properly rather than to shout an abbreviation.
 */
const DRILL_LABEL = "DRILL";
const DRILL_SIZE = 14;
const DRILL_TRACKING = 1.2;
/** Breathing room either side of the word inside the pill. */
const DRILL_PAD = 14;
/**
 * Wide enough for the word and no wider. DERIVED, not typed: the 228 this
 * replaces was measured for a longer label, and a pill still sized for text it
 * no longer holds is exactly how the chip came to outweigh the logo.
 */
export const DRILL_CHIP_WIDTH = Math.round(
  estimateTextWidth(DRILL_LABEL, DRILL_SIZE) + DRILL_LABEL.length * DRILL_TRACKING + DRILL_PAD * 2,
);
/** The chip's right edge, level with the card's other right-hand margin. */
const DRILL_CHIP_RIGHT = 760;

/**
 * The drill chip. On the CARD as well as in the text, because the card is what
 * a push notification previews: a marker that only exists in the body reaches
 * the reader after they have already believed the picture.
 */
function drillChip(): string {
  // Right-aligned, so it sits opposite the brand lockup rather than replacing
  // it: a card with no logo on it is not obviously ours, and "ours" is half of
  // why a reader trusts the warning.
  const x = DRILL_CHIP_RIGHT - DRILL_CHIP_WIDTH;
  const y = 40;
  return `
  <rect x="${x}" y="${y}" width="${DRILL_CHIP_WIDTH}" height="32" rx="16" fill="rgba(245,158,11,0.12)" stroke="rgba(245,158,11,0.35)"/>
  <text x="${x + DRILL_PAD}" y="${y + 21}" fill="#F59E0B" font-family="Plus Jakarta Sans" font-weight="700"
        font-size="${DRILL_SIZE}" letter-spacing="${DRILL_TRACKING}">${DRILL_LABEL}</text>`;
}

/** The card as SVG. Pure and deterministic, so it is testable without a rasteriser. */
export function alertCardSvg(input: AlertCardInput): string {
  // Arc = what the score IS. Headline = what the event MEANS. See EVENT_COLOR.
  const arcColor = BAND_COLOR[input.band] ?? UNKNOWN_COLOR;
  const eventColor = headlineColor(input.status, input.band);
  const headline = CARD_HEADLINE[input.status] ?? CARD_HEADLINE.approaching;
  const markPath = brandMarkPath();
  const left = CONTENT_LEFT;

  /**
   * WHICH position, STACKED: the reader's own name for it, then what it is,
   * then the address.
   *
   *   "Wallet name"        their word for it - only when they gave one
   *   Aave V3 - Base       what it actually is
   *                        (a gap, because the address is a different KIND of
   *   0x12a5...2305         fact: the other two are how it gets referred to)
   *
   * It replaced a single joined line ("name - protocol - chain"), which read
   * well for "Cold wallet" and broke for "My extremely long-term leveraged
   * cbBTC position": one line cannot both keep a user-typed name intact and
   * guarantee the protocol beside it stays on the card. Stacking turns the
   * long-name case into a truncation problem on ONE line instead of a layout
   * problem for all three.
   *
   * The quotation marks stay. They say "your word, not ours" in a way no font
   * size can, which is the whole reason the label could be demoted off its own
   * headline in the first place.
   *
   * BRIGHT BUT NOT BIG: primary ink at medium weight, at the same size as the
   * address, against a 34px coloured headline. The size gap is what holds the
   * hierarchy, so the colour costs nothing - two large elements per card, the
   * dial's number and the event headline, and no more.
   */
  // Everything interpolated is escaped: the label is typed by a user and the
  // protocol can fall back to a raw enum, and an unescaped "&" is a malformed
  // SVG that resvg refuses whole. Escaping happens AFTER clipping, so a cut can
  // never land inside an entity.
  const address = escapeHtml(truncateWallet(input.wallet));
  const chain = input.chainLabel?.trim()
    ? clipToWidth(input.chainLabel, IDENTITY_SIZE, CARD_CONTENT_WIDTH)
    : null;
  const platform = escapeHtml(
    clipToWidth(
      chain ? `${protocolLabel(input.protocol)} - ${chain}` : protocolLabel(input.protocol),
      IDENTITY_SIZE,
      CARD_CONTENT_WIDTH,
    ),
  );
  // The NAME is clipped and the quotes go on afterwards, so a truncated label
  // still closes: clipping the already-quoted string eats the closing quote and
  // leaves a dangling one, which reads as a broken card rather than as a name.
  const quotes = estimateTextWidth('""', IDENTITY_SIZE);
  const name = input.label?.trim()
    ? `"${escapeHtml(clipToWidth(input.label, IDENTITY_SIZE, CARD_CONTENT_WIDTH - quotes))}"`
    : null;

  /**
   * The stack, centred in the room left under the headline, so BOTH variants
   * are deliberate: dropping the name line must not leave the two that remain
   * hanging off the top of a half-empty card.
   */
  const stackHeight = CAP + (name ? IDENTITY_STEP : 0) + ADDRESS_GAP + DESCENDER;
  const first = Math.round(
    HEADLINE_BASELINE + (HEIGHT - HEADLINE_BASELINE - stackHeight) / 2 + CAP,
  );
  const identityLine = (y: number, content: string) =>
    `<text x="${left}" y="${y}" fill="${TEXT_PRIMARY}" font-family="Plus Jakarta Sans" font-weight="500" font-size="${IDENTITY_SIZE}">${content}</text>`;

  const nameLine = name ? identityLine(first, name) : "";
  const platformBaseline = name ? first + IDENTITY_STEP : first;
  const platformLine = identityLine(platformBaseline, platform);
  const addressY = platformBaseline + ADDRESS_GAP;

  // One vertical rhythm down the right column; y positions are stated rather
  // than accumulated so a change to one line cannot silently shift the rest.
  // The mark is drawn from its path, not omitted along with the wordmark: a
  // card missing the icon still has to say "PANIK", which is what the test
  // named after this guards.
  const icon = markPath
    ? `<path d="${markPath}" fill="${TEXT_MUTED}" transform="translate(${left} 40) scale(${30 / 1024})"/>`
    : "";
  const brand = `${icon}
       <text x="${left + 40}" y="62" fill="${TEXT_MUTED}" font-family="Plus Jakarta Sans" font-weight="700" font-size="17" letter-spacing="2.4">PANIK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${SURFACE}"/>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="${BORDER_SUBTLE}"/>
  ${dial(input.score, arcColor)}
  ${brand}
  ${input.simulated ? drillChip() : ""}
  <text x="${left}" y="${HEADLINE_BASELINE}" fill="${eventColor}" font-family="Plus Jakarta Sans" font-weight="700" font-size="${HEADLINE_SIZE}">${escapeHtml(headline)}</text>
  ${nameLine}
  ${platformLine}
  <text x="${left}" y="${addressY}" fill="${TEXT_SECONDARY}" font-family="JetBrains Mono" font-size="${IDENTITY_SIZE}">${address}</text>
</svg>`;
}

/**
 * The card as a PNG, or null.
 *
 * NEVER THROWS. Every caller is on the path between a position crossing its
 * limit and a person being told about it, and nothing on that path may depend
 * on an image renderer.
 */
export function renderAlertCard(
  input: AlertCardInput,
  log?: { error(message: string): void },
): Buffer | null {
  try {
    // Required lazily so a broken or missing native binary cannot take down the
    // worker at import time - the dispatcher must still boot and send text.
    // `createRequire` because this file is ESM and resvg-js is a CJS addon.
    const { Resvg } = createRequire(import.meta.url)("@resvg/resvg-js") as typeof import("@resvg/resvg-js");
    const resvg = new Resvg(alertCardSvg(input), {
      background: SURFACE,
      fitTo: { mode: "width", value: WIDTH * SCALE },
      font: {
        // The container has no fonts of its own; these three are the whole
        // typographic system for this image.
        fontFiles: FONT_FILES,
        loadSystemFonts: false,
        defaultFontFamily: "Plus Jakarta Sans",
      },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    log?.error(`alert card render failed, sending text only: ${(err as Error).message.slice(0, 160)}`);
    return null;
  }
}
