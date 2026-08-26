/**
 * The alert CARD - one PNG, rendered here, that says the same thing the message
 * says in the shape the app says it.
 *
 * WHY AN IMAGE AT ALL. A Telegram notification is a strip of text on a lock
 * screen, and the thing a reader needs from it in the first half second is not
 * a sentence: it is "how bad, and whose". The card answers the first before any
 * word is read.
 *
 * THE LAYOUT IS A BLOCK AND A LEDGER. A 260px panel flooded with the band's
 * own colour carries the score at 150px, and that block is the whole of the
 * card's colour: it is legible as a colour before it is legible as a number,
 * which is what a lock-screen thumbnail actually delivers. Everything to its
 * right is black on white and reads in order - whose product this is, what
 * happened, which position, and then the two facts a reader acts on, set in a
 * ruled row along the bottom like a statement line. The dial this replaces was
 * the app's table-row instrument blown up to poster size; at that scale a
 * needle and a wedge are decoration around a number the panel now states
 * outright.
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
 * ONE COLOUR CHANNEL, AND IT IS THE PANEL. An earlier version coloured the
 * headline text by what the alert EVENT meant (amber for "nearing", orange for
 * "over") and the dial by the BAND. That put a risk hue on a whole sentence,
 * which the design system rules out, and it put colour in a second place that
 * could drift from the first. Text on this card is black at every status and
 * every band; the left panel is the only thing that carries the ramp.
 *
 * SCALE. The card is drawn at its own 800x360 size in SVG user units and
 * rasterised at `RENDER_SCALE` (2x) for a screen that is always retina - see
 * `renderAlertCard`'s `fitTo`. Structural weights are stated at card scale
 * (`HARD` 6, `SHADOW` 12), which is `--border-width-hard` and `--shadow-hard`
 * doubled: this is a poster viewed at phone size, where the app's 3px edge
 * disappears.
 *
 * FONTS. Archivo (`--font-sans`) for every word, Space Mono (`--font-mono`)
 * for every figure - the score, the buffer percentage, the address - the same
 * split the app uses. Vendored under `server/assets/fonts/`:
 * `Archivo-Regular.ttf` / `-Bold.ttf` and `SpaceMono-Regular.ttf` / `-Bold.ttf`.
 * Archivo ships from Google Fonts only as a variable font, and
 * `@resvg/resvg-js` 2.6.2 does not honour a requested `font-weight` against a
 * variable font's `wght` axis - it always draws the font's default named
 * instance regardless of what the SVG asks for (verified by rendering the same
 * text at weight 400 and 700 against the raw variable file and getting
 * byte-identical PNGs). The two Archivo files here are that variable font
 * instanced at `wght=400`/`700` with `fonttools.varLib.instancer`; see
 * `server/assets/fonts/README.md` for the full provenance. Weight 900 is not
 * vendored, so the headline and the band word are set at 700, the heaviest
 * face the container actually holds.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assetName,
  CARD_HEADLINE,
  escapeHtml,
  protocolLabel,
  truncateWallet,
} from "../packages/scoring/src/watch/alertMessage";
import { drawdownToLiquidation, formatDrawdownPct } from "../packages/scoring/src/prospective";
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
/** `--color-risk-unknown`, and the word that goes with it. */
const UNKNOWN_COLOR = "#9CA3AF";
const UNKNOWN_LABEL = "UNKNOWN";
/**
 * What the numeral says when the score is not a number this card can state.
 * A zero would read as "perfectly safe", which is the one lie this product
 * must never tell.
 */
const UNKNOWN_SCORE = "?";

/** `--color-surface-base`. The paper the card sits on. */
const PAPER = "#F4F4EF";
/** `--color-surface-raised`. The card's own plate. */
const CARD_SURFACE = "#FFFFFF";
/** `--color-text-primary` and `--color-border-strong` - both black on this look. */
const INK = "#000000";
/** `--color-text-muted`. Captions in the ledger row, and nothing else. */
const TEXT_MUTED = "#6B6B6B";

/** The raster multiplier. The SVG's own units are the card's 800x360 space. */
const RENDER_SCALE = 2;

// ── Geometry. Every number below is in the card's own 800x360 space. ─────────

const WIDTH = 800;
const HEIGHT = 360;

/**
 * The panel is inset unevenly on purpose: 24 at the top and left, 36 at the
 * right and bottom, which is 24 of ground plus the 12 the hard shadow falls
 * into. Symmetrical margins would either clip the shadow or leave the card
 * looking pushed off-centre.
 */
const PANEL_X = 24;
const PANEL_Y = 24;
const PANEL_W = 740;
const PANEL_H = 300;
/** `--border-width-hard` and `--shadow-hard`, at card scale. See the header. */
const HARD = 6;
const SHADOW = 12;

/** The panel's INNER box: what the border encloses. */
const IN_L = PANEL_X + HARD;
const IN_T = PANEL_Y + HARD;
const IN_R = PANEL_X + PANEL_W - HARD;
const IN_B = PANEL_Y + PANEL_H - HARD;

/** The score panel, border-box: its own 6px right edge is inside this width. */
const LEFT_W = 260;
const LEFT_PAD_X = 22;
const LEFT_TEXT_X = IN_L + LEFT_PAD_X;
/** Where the band fill stops and the black rule between the columns starts. */
const LEFT_RULE_X = IN_L + LEFT_W - HARD;
/** The right column, and the gutter every line on it is set inside. */
const RIGHT_L = IN_L + LEFT_W;
const COL_PAD_X = 24;
const CONTENT_X = RIGHT_L + COL_PAD_X;
/**
 * What every line on the right column must fit inside. Exported because the
 * truncation tests assert against it rather than against a number they retype.
 */
export const CARD_CONTENT_WIDTH = IN_R - COL_PAD_X - CONTENT_X;

/**
 * The left panel's three lines, top to bottom, as baselines.
 *
 * Stated rather than accumulated from line heights: the panel is a fixed block
 * with three fixed things in it, and a chain of derived offsets would let a
 * change to the label quietly move the score.
 */
const SCORE_LABEL_SIZE = 13;
const SCORE_LABEL_BASELINE = 59;
const SCORE_SIZE = 150;
const SCORE_BASELINE = 222;
const BAND_SIZE = 22;
const BAND_BASELINE = 294;

/** The header row: the mark, the wordmark, and the drill tag opposite them. */
const HEADER_TOP = IN_T + 16;
const MARK_SIZE = 26;
/** `public/panik-mark.svg` is drawn on a 1024 grid. */
const MARK_VIEWBOX = 1024;
const MARK_GAP = 10;
const WORDMARK_SIZE = 13;
/** The mark's vertical centre. Everything in the header row sits on it. */
const HEADER_MID = HEADER_TOP + MARK_SIZE / 2;

/** The ledger row along the bottom: a rule, then two cells split down a rule. */
const ROW_H = 68;
const ROW_TOP = IN_B - ROW_H;
const CELL_TOP = ROW_TOP + HARD;
const CAPTION_SIZE = 12;
const CAPTION_BASELINE = CELL_TOP + 24;
const VALUE_SIZE = 17;
/** The space between a value's words and its figure, set rather than typed. */
const FIGURE_GAP = 5;
const ADDRESS_SIZE = 16;
const VALUE_BASELINE = CELL_TOP + 45;
/** Half the right column, border-box, so cell one's own rule is inside it. */
const CELL_W = (IN_R - RIGHT_L) / 2;
const CELL_RULE_X = RIGHT_L + CELL_W - HARD;
const CELL_2_X = RIGHT_L + CELL_W + COL_PAD_X;

/** The middle band, between the header and the ledger row. */
const MID_TOP = HEADER_TOP + MARK_SIZE;
const MID_BOTTOM = ROW_TOP;
const HEADLINE_SIZE = 40;
/** `line-height: 1`, which is what the approved layout sets. */
const HEADLINE_LEADING = HEADLINE_SIZE;
/**
 * Where the baseline sits inside a 1em line box, for Archivo's own ascent and
 * descent. Negative half-leading: at `line-height: 1` the glyph box is taller
 * than the line box and overflows it evenly, top and bottom.
 */
const HEADLINE_BASELINE_IN_LINE = 34.6;
/** Two lines is the room the card has before the ledger row. */
const HEADLINE_MAX_LINES = 2;
const HEADLINE_GAP = 10;
const POSITION_SIZE = 16;
const POSITION_LEADING = 20;
const POSITION_BASELINE_IN_LINE = 15;

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "assets", "fonts");

/**
 * The two faces the card draws with, vendored under `server/assets/fonts`.
 * See the file header for why the Archivo pair is a locally-instanced static
 * copy rather than the upstream variable file.
 *
 * resvg has no system fonts to fall back on inside the container, so a missing
 * file is not a substituted face - it is a card with no text on it. They are
 * therefore loaded once, eagerly, and a failure is surfaced to the caller as
 * "no card" rather than as a silently blank image.
 */
const FONT_FILES = [
  join(FONT_DIR, "Archivo-Bold.ttf"),
  join(FONT_DIR, "Archivo-Regular.ttf"),
  join(FONT_DIR, "SpaceMono-Regular.ttf"),
  join(FONT_DIR, "SpaceMono-Bold.ttf"),
];
const SANS = "Archivo";
const MONO = "Space Mono";

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
  /**
   * The protocol health factor the crossing was measured at. `null` means the
   * position carries no debt; OMITTED means the caller does not hold one, and
   * the two are different claims - the ledger row states "No debt" for the
   * first and drops the cell entirely for the second.
   *
   * The card never does the arithmetic itself: the buffer comes out of
   * `drawdownToLiquidation` in `packages/scoring`, which is the same helper
   * the message body and the app's own outlook read, so the three surfaces
   * cannot disagree about how far this asset can fall.
   */
  healthFactor?: number | null;
  /** The collateral the buffer is measured against, as the engine scored it. */
  collateralSymbol?: string | null;
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
 * Width rather than character count: "Simulation target" and "My extremely
 * long-term leveraged cbBTC position" are both "a label", and a budget in
 * characters cannot tell a narrow one from a wide one. The ellipsis is
 * measured too, so the result including its three dots is what fits.
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
 * The headline, broken on word boundaries into the lines the card has room
 * for. `CARD_HEADLINE` holds three short strings today and all three fit on
 * one line, but the wrap is not decoration: it is what keeps a future headline
 * from running off the plate rather than being silently cut mid-word.
 */
export function wrapHeadline(text: string): string[] {
  if (estimateTextWidth(text, HEADLINE_SIZE) <= CARD_CONTENT_WIDTH) return [text];

  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(next, HEADLINE_SIZE) > CARD_CONTENT_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= HEADLINE_MAX_LINES) return lines;
  // Past the room the card has, the tail is cut rather than dropped: an
  // ellipsis says "there was more", a missing line says nothing at all.
  const kept = lines.slice(0, HEADLINE_MAX_LINES - 1);
  const rest = lines.slice(HEADLINE_MAX_LINES - 1).join(" ");
  return [...kept, clipToWidth(rest, HEADLINE_SIZE, CARD_CONTENT_WIDTH)];
}

/** One cell of the ledger row: a muted caption over a value line. */
interface LedgerCell {
  caption: string;
  /** Set in Archivo, the words part of the value. */
  words: string;
  /** Set in Space Mono beside the words, or null when the value is only words. */
  figure: string | null;
}

/**
 * The liquidation cell, or null when this card holds no answer to state.
 *
 * Three genuinely different statements, and they are the same three
 * `liquidationOutlook` makes in the app, from the same engine helper:
 *
 *   omitted HF  -> the caller does not know. The cell is dropped and the
 *                  wallet cell takes the whole row; an empty cell with a
 *                  caption over it claims a fact nobody has.
 *   null HF     -> no debt, so there is no liquidation to be a distance from.
 *   HF <= 1     -> liquidatable at today's price. "falls 0%" would read as
 *                  "perfectly safe", the exact inverse of the truth.
 *   HF > 1      -> the buffer, rounded the one way the engine rounds it.
 */
function liquidationCell(input: AlertCardInput): LedgerCell | null {
  if (input.healthFactor === undefined) return null;
  if (input.healthFactor === null) {
    return { caption: "LIQUIDATION RISK", words: "No debt", figure: null };
  }
  const drop = drawdownToLiquidation(input.healthFactor);
  if (drop === null || drop <= 0) {
    return { caption: "LIQUIDATION RISK", words: "Liquidatable now", figure: null };
  }
  const asset = assetName(input.collateralSymbol ?? "");
  return {
    caption: "LIQUIDATES IF",
    words: `${asset} falls`,
    figure: formatDrawdownPct(drop),
  };
}

/**
 * The drill tag, and the room it needs.
 *
 * ONE WORD, because it is a TAG and not a sentence. The full explanation is
 * not lost, it is where it belongs: the message says "Simulated event (label) -
 * prices in this alert are from an armed drill, not the market", both above the
 * body and again in the footer, where there is room to say it properly.
 *
 * BLACK AND WHITE, never the ramp. `SimulationChip` in
 * `src/panik-core/ui/SimulationMarker.tsx` spends no colour on a simulation
 * marker because a simulation is not a risk band - a simulated position can be
 * perfectly safe - and on this card the ramp belongs to the score panel alone.
 * It sits in the header row opposite the brand lockup, which is the one place
 * on the card with nothing else in it.
 */
const DRILL_LABEL = "DRILL";
const DRILL_SIZE = 11;
const DRILL_TRACKING = labelTracking(DRILL_SIZE);
const DRILL_HEIGHT = 22;
const DRILL_PAD = 9;
/**
 * Wide enough for the word and no wider. DERIVED, not typed: a pill still
 * sized for text it no longer holds is how a tag comes to outweigh a logo.
 */
export const DRILL_CHIP_WIDTH = Math.round(
  estimateTextWidth(DRILL_LABEL, DRILL_SIZE) + DRILL_LABEL.length * DRILL_TRACKING + DRILL_PAD * 2,
);

/**
 * The drill tag. On the CARD as well as in the text, because the card is what
 * a push notification previews: a marker that only exists in the body reaches
 * the reader after they have already believed the picture.
 */
function drillTag(): string {
  const x = IN_R - COL_PAD_X - DRILL_CHIP_WIDTH;
  const y = HEADER_MID - DRILL_HEIGHT / 2;
  return `
  <rect x="${x}" y="${y}" width="${DRILL_CHIP_WIDTH}" height="${DRILL_HEIGHT}" fill="${INK}"/>
  <text x="${x + DRILL_PAD}" y="${HEADER_MID + DRILL_SIZE * 0.36}" fill="${CARD_SURFACE}" font-family="${SANS}" font-weight="700"
        font-size="${DRILL_SIZE}" letter-spacing="${DRILL_TRACKING}">${DRILL_LABEL}</text>`;
}

/** The card as SVG. Pure and deterministic, so it is testable without a rasteriser. */
export function alertCardSvg(input: AlertCardInput): string {
  // A score that is not a number and a band this table does not hold are the
  // same failure to a reader: the card cannot say how bad it is. Both take the
  // unknown grey and the unknown word, so the panel is never a calm colour
  // standing in for an answer nobody has.
  const scoreKnown = Number.isFinite(input.score);
  const bandKnown = scoreKnown && input.band in BAND_COLOR;
  const panelColor = bandKnown ? BAND_COLOR[input.band] : UNKNOWN_COLOR;
  const bandWord = bandKnown ? input.band : UNKNOWN_LABEL;
  const scoreText = scoreKnown
    ? String(Math.round(Math.max(0, Math.min(100, input.score))))
    : UNKNOWN_SCORE;

  const headlineLines = wrapHeadline(CARD_HEADLINE[input.status] ?? CARD_HEADLINE.approaching);

  /**
   * WHICH position, on one line: the reader's own name for it, then what it
   * actually is. "Main wallet, Aave V3 on Base".
   *
   * No quotation marks around the name. It sits in a plain 16px line under a
   * 40px headline, which already says "this is a label, not the statement" -
   * punctuation added nothing a reader needed to tell the two apart, and a
   * clipped name left the opening quote dangling with no closing one.
   *
   * The protocol and chain are budgeted FIRST and the name gets what is left,
   * because the name is the part a user typed and the part that can be
   * arbitrarily long: a card that keeps "My extremely long-term leveraged
   * cbBTC position" intact and loses "Aave V3 on Base" has kept the wrong half.
   */
  const chain = input.chainLabel?.trim()
    ? clipToWidth(input.chainLabel, POSITION_SIZE, CARD_CONTENT_WIDTH)
    : null;
  const platform = clipToWidth(
    chain ? `${protocolLabel(input.protocol)} on ${chain}` : protocolLabel(input.protocol),
    POSITION_SIZE,
    CARD_CONTENT_WIDTH,
  );
  const nameBudget =
    CARD_CONTENT_WIDTH - estimateTextWidth(`, ${platform}`, POSITION_SIZE);
  // Below about two characters' worth there is no name left to show, only an
  // ellipsis, so the name line is dropped rather than reduced to punctuation.
  const name =
    input.label?.trim() && nameBudget > POSITION_SIZE * 2
      ? clipToWidth(input.label, POSITION_SIZE, nameBudget)
      : null;
  const position = escapeHtml(name ? `${name}, ${platform}` : platform);

  // Everything interpolated is escaped: the label is typed by a user and the
  // protocol can fall back to a raw enum, and an unescaped "&" is a malformed
  // SVG that resvg refuses whole. Escaping happens AFTER clipping, so a cut can
  // never land inside an entity.
  const address = escapeHtml(truncateWallet(input.wallet));

  // The middle band is centred on what it holds, so a one-line headline and a
  // two-line one are both deliberate rather than one of them hanging off a
  // half-empty card.
  const blockHeight =
    headlineLines.length * HEADLINE_LEADING + HEADLINE_GAP + POSITION_LEADING;
  const blockTop = MID_TOP + (MID_BOTTOM - MID_TOP - blockHeight) / 2;
  const headline = headlineLines
    .map(
      (line, i) =>
        `<text x="${CONTENT_X}" y="${(blockTop + i * HEADLINE_LEADING + HEADLINE_BASELINE_IN_LINE).toFixed(1)}" fill="${INK}" font-family="${SANS}" font-weight="700" font-size="${HEADLINE_SIZE}">${escapeHtml(line)}</text>`,
    )
    .join("\n  ");
  const positionY = (
    blockTop +
    headlineLines.length * HEADLINE_LEADING +
    HEADLINE_GAP +
    POSITION_BASELINE_IN_LINE
  ).toFixed(1);

  // The mark is drawn from its path, not omitted along with the wordmark: a
  // card missing the icon still has to say "PANIK", which is what the test
  // named after this guards. Black, not muted grey - the mark is a brand
  // element, not a demoted one.
  const markPath = brandMarkPath();
  const icon = markPath
    ? `<path d="${markPath}" fill="${INK}" transform="translate(${CONTENT_X} ${HEADER_TOP}) scale(${MARK_SIZE / MARK_VIEWBOX})"/>`
    : "";

  const liquidation = liquidationCell(input);
  const walletX = liquidation ? CELL_2_X : CONTENT_X;
  const caption = (x: number, text: string) =>
    `<text x="${x}" y="${CAPTION_BASELINE}" fill="${TEXT_MUTED}" font-family="${SANS}" font-weight="700" font-size="${CAPTION_SIZE}" letter-spacing="${labelTracking(CAPTION_SIZE)}">${text}</text>`;
  /**
   * The figure rides inside the value's own `<text>` as a `tspan` rather than
   * as a second run placed at the first one's estimated end: the words are
   * Archivo 400 and the figure is Space Mono 700, and only the renderer knows
   * exactly where the words stop. `dx` sets the gap explicitly, because a
   * literal trailing space before a `tspan` is whitespace an SVG may collapse.
   */
  const ledgerValue = (x: number, c: LedgerCell) =>
    `${caption(x, escapeHtml(c.caption))}
  <text x="${x}" y="${VALUE_BASELINE}" fill="${INK}" font-family="${SANS}" font-weight="400" font-size="${VALUE_SIZE}">${escapeHtml(c.words)}${
      c.figure === null
        ? ""
        : `<tspan font-family="${MONO}" font-weight="700" dx="${FIGURE_GAP}">${escapeHtml(c.figure)}</tspan>`
    }</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  <rect x="${PANEL_X + SHADOW}" y="${PANEL_Y + SHADOW}" width="${PANEL_W}" height="${PANEL_H}" fill="${INK}"/>
  <rect x="${PANEL_X + HARD / 2}" y="${PANEL_Y + HARD / 2}" width="${PANEL_W - HARD}" height="${PANEL_H - HARD}" fill="${CARD_SURFACE}" stroke="${INK}" stroke-width="${HARD}"/>

  <rect id="alert-card-panel" x="${IN_L}" y="${IN_T}" width="${LEFT_W - HARD}" height="${IN_B - IN_T}" fill="${panelColor}"/>
  <rect x="${LEFT_RULE_X}" y="${IN_T}" width="${HARD}" height="${IN_B - IN_T}" fill="${INK}"/>
  <text x="${LEFT_TEXT_X}" y="${SCORE_LABEL_BASELINE}" fill="${INK}" font-family="${SANS}" font-weight="700" font-size="${SCORE_LABEL_SIZE}" letter-spacing="${labelTracking(SCORE_LABEL_SIZE)}">RISK SCORE</text>
  <text x="${LEFT_TEXT_X}" y="${SCORE_BASELINE}" fill="${INK}" font-family="${MONO}" font-weight="700" font-size="${SCORE_SIZE}">${scoreText}</text>
  <text x="${LEFT_TEXT_X}" y="${BAND_BASELINE}" fill="${INK}" font-family="${SANS}" font-weight="700" font-size="${BAND_SIZE}" letter-spacing="${(BAND_SIZE * 0.02).toFixed(2)}">${bandWord}</text>

  ${icon}
  <text x="${CONTENT_X + MARK_SIZE + MARK_GAP}" y="${HEADER_MID + WORDMARK_SIZE * 0.36}" fill="${INK}" font-family="${SANS}" font-weight="700" font-size="${WORDMARK_SIZE}" letter-spacing="${labelTracking(WORDMARK_SIZE)}">PANIK</text>
  ${input.simulated ? drillTag() : ""}

  ${headline}
  <text x="${CONTENT_X}" y="${positionY}" fill="${INK}" font-family="${SANS}" font-weight="400" font-size="${POSITION_SIZE}">${position}</text>

  <rect x="${RIGHT_L}" y="${ROW_TOP}" width="${IN_R - RIGHT_L}" height="${HARD}" fill="${INK}"/>${
    liquidation
      ? `
  <rect x="${CELL_RULE_X}" y="${CELL_TOP}" width="${HARD}" height="${IN_B - CELL_TOP}" fill="${INK}"/>
  ${ledgerValue(CONTENT_X, liquidation)}`
      : ""
  }
  ${caption(walletX, "WALLET")}
  <text x="${walletX}" y="${VALUE_BASELINE}" fill="${INK}" font-family="${MONO}" font-weight="400" font-size="${ADDRESS_SIZE}">${address}</text>
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
      fitTo: { mode: "width", value: WIDTH * RENDER_SCALE },
      font: {
        // The container has no fonts of its own; these are the whole
        // typographic system for this image. See the file header for the
        // Archivo variable-font caveat.
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
