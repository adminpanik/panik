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

/** `public/panik-logo.png`, inlined. Null when it cannot be read; the card then omits it. */
let logoDataUri: string | null | undefined;
function logo(): string | null {
  if (logoDataUri === undefined) {
    try {
      const png = readFileSync(join(HERE, "..", "public", "panik-logo.png"));
      logoDataUri = `data:image/png;base64,${png.toString("base64")}`;
    } catch {
      logoDataUri = null;
    }
  }
  return logoDataUri;
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
 * Cut a string to something that will not run off the card.
 *
 * Character counting rather than text measurement, because measuring needs the
 * font metrics and the whole point of this module is that it does the cheap
 * thing reliably. The budgets below were read off the rendered PNGs at each
 * size; they are conservative, so a wide string is trimmed slightly early
 * rather than colliding with the edge.
 */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}...`;
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
 * The drill chip. On the CARD as well as in the text, because the card is what
 * a push notification previews: a marker that only exists in the body reaches
 * the reader after they have already believed the picture.
 */
function drillChip(): string {
  // Right-aligned, so it sits opposite the brand lockup rather than replacing
  // it: a card with no logo on it is not obviously ours, and "ours" is half of
  // why a reader trusts the warning.
  const x = 532;
  const y = 40;
  return `
  <rect x="${x}" y="${y}" width="228" height="32" rx="16" fill="rgba(245,158,11,0.12)" stroke="rgba(245,158,11,0.35)"/>
  <text x="${x + 16}" y="${y + 21}" fill="#F59E0B" font-family="Plus Jakarta Sans" font-weight="700"
        font-size="14" letter-spacing="1.2">SIMULATED DRILL</text>`;
}

/** The card as SVG. Pure and deterministic, so it is testable without a rasteriser. */
export function alertCardSvg(input: AlertCardInput): string {
  // Arc = what the score IS. Headline = what the event MEANS. See EVENT_COLOR.
  const arcColor = BAND_COLOR[input.band] ?? UNKNOWN_COLOR;
  const eventColor = headlineColor(input.status, input.band);
  const headline = CARD_HEADLINE[input.status] ?? CARD_HEADLINE.approaching;
  const mark = logo();
  const left = 330;

  // Everything interpolated below is escaped: the label is typed by a user and
  // the protocol name can fall back to a raw enum, and an unescaped "&" is a
  // malformed SVG that resvg refuses whole.
  const label = input.label ? clip(input.label, 30) : null;
  const address = escapeHtml(truncateWallet(input.wallet));
  const protocol = escapeHtml(clip(protocolLabel(input.protocol), 24));

  /**
   * WHICH position, in one line: the reader's own name for the wallet, the
   * protocol, and the chain.
   *
   * The label used to be set large, bold and near-white ON ITS OWN, which gave a
   * nickname somebody typed into a text field the typography of product
   * vocabulary: "Simulation target" read as a PANIK term for a kind of position
   * rather than as what this reader happens to call this wallet. Quotation marks
   * say "your word, not ours" in a way no font size can, and folding it in
   * beside the protocol and the chain puts it back among the other two thirds of
   * the same fact.
   *
   * It is BRIGHT but not big. Primary ink and a medium weight at the same 22px
   * as the address, against a 34px coloured headline: the size gap is what keeps
   * the hierarchy, so lifting the colour costs nothing. Two large elements per
   * card and no more - the dial's number and the event headline.
   *
   * The chain segment is dropped when the caller does not name one, rather than
   * defaulting to the mainnet everyone assumes.
   */
  const chain = input.chainLabel ? escapeHtml(clip(input.chainLabel, 20)) : null;
  const identity = [label ? `"${escapeHtml(label)}"` : null, protocol, chain]
    .filter((part): part is string => part !== null)
    .join(" · ");

  // One vertical rhythm down the right column; y positions are stated rather
  // than accumulated so a change to one line cannot silently shift the rest.
  const brand = mark
    ? `<image x="${left}" y="40" width="30" height="30" href="${mark}"/>
       <text x="${left + 40}" y="62" fill="${TEXT_MUTED}" font-family="Plus Jakarta Sans" font-weight="700" font-size="17" letter-spacing="2.4">PANIK</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${SURFACE}"/>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="${BORDER_SUBTLE}"/>
  ${dial(input.score, arcColor)}
  ${brand}
  ${input.simulated ? drillChip() : ""}
  <text x="${left}" y="176" fill="${eventColor}" font-family="Plus Jakarta Sans" font-weight="700" font-size="34">${escapeHtml(headline)}</text>
  <text x="${left}" y="234" fill="${TEXT_PRIMARY}" font-family="Plus Jakarta Sans" font-weight="500" font-size="22">${identity}</text>
  <text x="${left}" y="276" fill="${TEXT_SECONDARY}" font-family="JetBrains Mono" font-size="22">${address}</text>
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
