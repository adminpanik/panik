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
 * products. The dial below is the same square frame, needle and wedge as
 * `src/panik-core/ui/RiskDial.tsx`, at card scale rather than table-row scale,
 * with the same geometry ported by hand for the reason `BAND_COLOR` is copied
 * rather than imported: this file cannot import a React component, so the math
 * that draws it is restated instead, with the source named beside it.
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
 * COLOURS ARE COPIED, DELIBERATELY. The ramp hexes and the surface/text/border
 * values below are the values in `src/index.css` `@theme`, restated because
 * this process cannot read a stylesheet and an SVG cannot resolve a CSS
 * variable. They are the ONLY duplicated design values in the server, and the
 * comment on each one names the token it mirrors so a ramp change has
 * something to grep. The risk hexes specifically mirror `RISK_CHIP` in
 * `src/panik-core/lib/utils.ts`, which is the single place a band becomes
 * pixels everywhere else in the product - this file has to agree with it, not
 * invent a second table.
 *
 * FONTS. The design system sets Archivo for words and Space Mono for every
 * figure, but neither is vendored anywhere in this repo as a font FILE - the
 * browser build pulls both from Google Fonts at runtime
 * (`@import url(fonts.googleapis.com/...)` in `src/index.css`), and resvg has
 * no network and no system fonts inside the container. This file's editable
 * surface is `alertCard.ts`/`alertCard.test.ts` only, so it cannot add the
 * missing `.ttf` files under `server/assets/fonts/`. The three faces already
 * vendored there - Plus Jakarta Sans (Bold/Medium/Regular) and JetBrains Mono
 * (Regular) - are kept as the closest available stand-ins: Plus Jakarta Sans
 * for every word, JetBrains Mono for every figure, which preserves the
 * words/figures split even though neither face is the one the browser draws.
 * Vendoring Archivo and Space Mono under `server/assets/fonts/` is the natural
 * follow-up once that directory is in scope.
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

/**
 * `RISK_CHIP` in `src/panik-core/lib/utils.ts`, restated in hex because that
 * table speaks Tailwind classes (`bg-risk-high`) and an SVG needs the colour
 * itself. These are also `--color-risk-*` in `src/index.css` `@theme`. HIGH is
 * `#FF5C00` on purpose - it used to share a hue with the brand accent and no
 * longer does, see the token's own comment.
 */
const BAND_COLOR: Record<Band, string> = {
  LOW: "#22C55E",
  ELEVATED: "#F59E0B",
  HIGH: "#FF5C00",
  CRITICAL: "#EF4444",
};
/** `--color-risk-unknown`. Used when a band arrives that this table does not hold. */
const UNKNOWN_COLOR = "#9CA3AF";

/**
 * TWO COLOUR CHANNELS, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   * The DIAL'S WEDGE is coloured by the score's BAND. That is the engine's
 *     claim about the number, and it is the same claim the app's dial makes,
 *     which is why it must not be adjusted here: a 15 is LOW, and drawing it as
 *     anything else would mean the card and the dashboard disagree about one
 *     score.
 *   * The HEADLINE is coloured by what the EVENT means for this reader. A
 *     conservative user is warned at 15, and 15 is genuinely LOW - so the wedge
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

/** `--color-surface-base`. The paper the card sits on. */
const PAPER = "#F4F4EF";
/** `--color-surface-raised`. The card's own plate. */
const CARD_SURFACE = "#FFFFFF";
/** `--color-text-primary` and `--color-border-strong` - both black on this look. */
const INK = "#000000";
/** `--color-text-secondary`. */
const TEXT_SECONDARY = "#4A4A4A";
/** `--border-width-hard`. Every structural edge on this look is this thick. */
const HARD = 3;
/** `--shadow-hard`: "6px 6px 0 #000000", the resting offset for a `raised` card. */
const SHADOW_HARD = 6;
/** `--shadow-hard-sm`: "3px 3px 0 #000000", the offset a chip carries. */
const SHADOW_HARD_SM = 3;

/**
 * The card's own footprint, unchanged from the layout this replaces so every
 * position below - the dial's centre, the content column, the drill chip's
 * right edge - keeps the numbers the tests already hold it to.
 */
const CARD_W = 800;
const CARD_H = 360;
/** Room around the card for the page to show and the shadow to fall into. */
const PAGE_MARGIN = 24;
const WIDTH = CARD_W + PAGE_MARGIN * 2 + SHADOW_HARD;
const HEIGHT = CARD_H + PAGE_MARGIN * 2 + SHADOW_HARD;
/** Logical size above; the raster is 2x this, for a screen that is always retina. */
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
export const CARD_CONTENT_WIDTH = CARD_W - CONTENT_LEFT - CONTENT_RIGHT_PAD;

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
 * See the file header for why these - not Archivo/Space Mono - are what
 * actually gets loaded.
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
/** Only weight vendored for the mono face - every mono run below stays 400. */
const MONO = "JetBrains Mono";
const SANS = "Plus Jakarta Sans";

/** `label-type`'s `letter-spacing: 0.06em`, in px at `size`. */
function labelTracking(size: number): number {
  return Math.round(size * 0.06 * 100) / 100;
}

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

/**
 * The dial's geometry: a square frame, a needle, a filled wedge and a plate
 * with the number on it. Hand-ported from `src/panik-core/ui/RiskDial.tsx`
 * (`at`, `needleTip`, `wedgePath`) rather than imported, because this process
 * cannot import a React component - see the file header. The footprint (a
 * `SIZE`-wide square centred where the old ring sat) is unchanged from the
 * design this replaces, so nothing else on the card had to move.
 */
const DIAL_CX = 168;
const DIAL_SIZE = 172;
const DIAL_C = DIAL_SIZE / 2;
/** Past the corner (`√2 · DIAL_C`), so the wedge is clipped, never drawn short. */
const DIAL_WEDGE_R = Math.ceil(DIAL_C * Math.SQRT2) + 1;
/** Half the frame's inner width: the distance from the centre to the frame. */
const DIAL_INNER = DIAL_C - HARD;
const NUMERAL_SIZE = 40;
const NUMERAL_PAD = 28;
const PLATE_W = Math.round(estimateTextWidth("100", NUMERAL_SIZE) + NUMERAL_PAD * 2);
const PLATE_H = Math.round(NUMERAL_SIZE * 1.4);

/** A point on the dial at `r`, `turn` of the way clockwise from twelve o'clock. */
function dialAt(cy: number, turn: number, r: number): readonly [number, number] {
  const t = turn * 2 * Math.PI;
  return [DIAL_CX + r * Math.sin(t), cy - r * Math.cos(t)];
}

/**
 * The needle's tip: where the ray at `turn` meets the INNER EDGE OF THE FRAME,
 * not a point on a circle inscribed in it, so the hand always reaches the
 * frame regardless of angle. See `RiskDial.tsx`'s `needleTip` for the full
 * derivation.
 */
function dialNeedleTip(cy: number, turn: number): readonly [number, number] {
  const t = turn * 2 * Math.PI;
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  const r = Math.min(
    Math.abs(dx) < 1e-9 ? Infinity : DIAL_INNER / Math.abs(dx),
    Math.abs(dy) < 1e-9 ? Infinity : DIAL_INNER / Math.abs(dy),
  );
  return [DIAL_CX + dx * r, cy + dy * r];
}

/**
 * The sector from twelve o'clock to `turn`, as a path. The sweep is capped
 * just short of a full revolution: at exactly 1 the start and end points
 * coincide and SVG resolves the arc to nothing, so a score of 100 - the one
 * score that most needs to be unmissable - would draw an empty wedge.
 */
function dialWedgePath(cy: number, turn: number): string {
  const sweep = Math.min(turn, 0.9999);
  const [x0, y0] = dialAt(cy, 0, DIAL_WEDGE_R);
  const [x1, y1] = dialAt(cy, sweep, DIAL_WEDGE_R);
  const largeArc = sweep > 0.5 ? 1 : 0;
  return `M ${DIAL_CX} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${DIAL_WEDGE_R} ${DIAL_WEDGE_R} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

/**
 * The dial, drawn the way `RiskDial.tsx` draws it: a white square, a black
 * frame and needle, and colour exactly ONCE - the wedge, clipped to the
 * frame's inner edge. The numeral sits on a white plate in primary ink
 * regardless of the band, which is what keeps it legible on every one of them.
 */
const DIAL_CLIP_ID = "alert-card-dial-clip";

function dial(cy: number, score: number, color: string): string {
  const turn = Math.max(0, Math.min(100, score)) / 100;
  const tip = dialNeedleTip(cy, turn);
  const frameX = DIAL_CX - DIAL_C;
  const frameY = cy - DIAL_C;
  return `
  <defs>
    <clipPath id="${DIAL_CLIP_ID}">
      <rect x="${(frameX + HARD).toFixed(2)}" y="${(frameY + HARD).toFixed(2)}" width="${DIAL_SIZE - HARD * 2}" height="${DIAL_SIZE - HARD * 2}"/>
    </clipPath>
  </defs>
  <rect x="${frameX.toFixed(2)}" y="${frameY.toFixed(2)}" width="${DIAL_SIZE}" height="${DIAL_SIZE}" fill="${CARD_SURFACE}"/>
  <path id="alert-card-wedge" d="${dialWedgePath(cy, turn)}" fill="${color}" clip-path="url(#${DIAL_CLIP_ID})"/>
  <line x1="${DIAL_CX}" y1="${cy}" x2="${tip[0].toFixed(2)}" y2="${tip[1].toFixed(2)}" stroke="${INK}" stroke-width="${HARD}"/>
  <rect x="${(DIAL_CX - PLATE_W / 2).toFixed(2)}" y="${(cy - PLATE_H / 2).toFixed(2)}" width="${PLATE_W}" height="${PLATE_H}" fill="${CARD_SURFACE}" stroke="${INK}" stroke-width="${HARD}"/>
  <rect x="${(frameX + HARD / 2).toFixed(2)}" y="${(frameY + HARD / 2).toFixed(2)}" width="${DIAL_SIZE - HARD}" height="${DIAL_SIZE - HARD}" fill="none" stroke="${INK}" stroke-width="${HARD}"/>
  <text x="${DIAL_CX}" y="${cy}" fill="${INK}" font-family="${MONO}" font-weight="400"
        font-size="${NUMERAL_SIZE}" text-anchor="middle" dominant-baseline="central">${Math.round(score)}</text>`;
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
 *
 * NEUTRAL, not amber. `SimulationChip` in `src/panik-core/ui/SimulationMarker.tsx`
 * spends no colour on a simulation marker because a simulation is not a risk
 * band - a simulated position can be perfectly safe - so this chip is built
 * from the same white-plate, black-edge recipe as `Chip.tsx` rather than from
 * the risk ramp.
 */
const DRILL_LABEL = "DRILL";
const DRILL_SIZE = 14;
const DRILL_TRACKING = labelTracking(DRILL_SIZE);
/** Breathing room either side of the word inside the chip. */
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

/** The wordmark beside the mark. Also used for its tracking, so it is one number. */
const WORDMARK_SIZE = 17;
const WORDMARK_TRACKING = labelTracking(WORDMARK_SIZE);

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
  <rect x="${x + SHADOW_HARD_SM}" y="${y + SHADOW_HARD_SM}" width="${DRILL_CHIP_WIDTH}" height="32" fill="${INK}"/>
  <rect x="${x}" y="${y}" width="${DRILL_CHIP_WIDTH}" height="32" fill="${CARD_SURFACE}" stroke="${INK}" stroke-width="${HARD}"/>
  <text x="${x + DRILL_PAD}" y="${y + 21}" fill="${INK}" font-family="${SANS}" font-weight="700"
        font-size="${DRILL_SIZE}" letter-spacing="${DRILL_TRACKING}">${DRILL_LABEL}</text>`;
}

/** The card as SVG. Pure and deterministic, so it is testable without a rasteriser. */
export function alertCardSvg(input: AlertCardInput): string {
  // Wedge = what the score IS. Headline = what the event MEANS. See EVENT_COLOR.
  const bandColor = BAND_COLOR[input.band] ?? UNKNOWN_COLOR;
  const eventColor = headlineColor(input.status, input.band);
  const headline = CARD_HEADLINE[input.status] ?? CARD_HEADLINE.approaching;
  const markPath = brandMarkPath();
  const left = CONTENT_LEFT;
  const dialCy = CARD_H / 2;

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
   * PRIMARY INK, NOT BIG: black at medium weight, at the same size as the
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
    HEADLINE_BASELINE + (CARD_H - HEADLINE_BASELINE - stackHeight) / 2 + CAP,
  );
  const identityLine = (y: number, content: string) =>
    `<text x="${left}" y="${y}" fill="${INK}" font-family="${SANS}" font-weight="500" font-size="${IDENTITY_SIZE}">${content}</text>`;

  const nameLine = name ? identityLine(first, name) : "";
  const platformBaseline = name ? first + IDENTITY_STEP : first;
  const platformLine = identityLine(platformBaseline, platform);
  const addressY = platformBaseline + ADDRESS_GAP;

  // One vertical rhythm down the right column; y positions are stated rather
  // than accumulated so a change to one line cannot silently shift the rest.
  // The mark is drawn from its path, not omitted along with the wordmark: a
  // card missing the icon still has to say "PANIK", which is what the test
  // named after this guards. Black, not the muted grey this replaces - the
  // mark is a brand element, not a demoted one.
  const icon = markPath
    ? `<path d="${markPath}" fill="${INK}" transform="translate(${left} 40) scale(${30 / 1024})"/>`
    : "";
  const brand = `${icon}
       <text x="${left + 40}" y="62" fill="${INK}" font-family="${SANS}" font-weight="700" font-size="${WORDMARK_SIZE}" letter-spacing="${WORDMARK_TRACKING}">PANIK</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  <g transform="translate(${PAGE_MARGIN} ${PAGE_MARGIN})">
  <rect x="${SHADOW_HARD}" y="${SHADOW_HARD}" width="${CARD_W}" height="${CARD_H}" fill="${INK}"/>
  <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" fill="${CARD_SURFACE}" stroke="${INK}" stroke-width="${HARD}"/>
  ${dial(dialCy, input.score, bandColor)}
  ${brand}
  ${input.simulated ? drillChip() : ""}
  <text x="${left}" y="${HEADLINE_BASELINE}" fill="${eventColor}" font-family="${SANS}" font-weight="700" font-size="${HEADLINE_SIZE}">${escapeHtml(headline)}</text>
  ${nameLine}
  ${platformLine}
  <text x="${left}" y="${addressY}" fill="${TEXT_SECONDARY}" font-family="${MONO}" font-weight="400" font-size="${IDENTITY_SIZE}">${address}</text>
  </g>
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
      background: PAPER,
      fitTo: { mode: "width", value: WIDTH * SCALE },
      font: {
        // The container has no fonts of its own; these three are the whole
        // typographic system for this image. See the file header for why they
        // are not Archivo/Space Mono.
        fontFiles: FONT_FILES,
        loadSystemFonts: false,
        defaultFontFamily: SANS,
      },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    log?.error(`alert card render failed, sending text only: ${(err as Error).message.slice(0, 160)}`);
    return null;
  }
}
