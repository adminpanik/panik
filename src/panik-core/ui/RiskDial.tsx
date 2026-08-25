import React, { useId } from "react";
import type { Band, DegradableSubScores } from "../lib/live";
import { marketContextMissing, RISK_SCORE_NAME, RISK_TEXT } from "../lib/utils";
/**
 * The score's vocabulary, from the engine that owns the score. A DEEP import of
 * a leaf module (its only runtime import is `params.ts`, which has none), for
 * the reason every other deep import in panik-core exists: the package barrel
 * reaches viem through the chain adapters and must never enter a browser
 * bundle. See `scoreVocabulary.ts` for why the words live there.
 */
import {
  COMPOSITE_WEIGHT_SENTENCE,
  DRIVER_KEYS,
  DRIVER_LABEL,
} from "../../../packages/scoring/src/scoreVocabulary";
import { InfoTip } from "../components/InfoTip";

/**
 * A position's PANIK score as a dial: a square block with a black needle, a
 * wedge showing how much of the 0-100 journey to liquidation it has travelled,
 * and the number itself on a plate in the middle.
 *
 * Why a gauge and not the tinted pill this replaced. The pill stated "52 HIGH"
 * and left the reader to know what 52 was out of, which is exactly the fact
 * that makes the number actionable — 52 is not "bad", it is "halfway", and
 * halfway is a distance you can reason about. The wedge is that denominator,
 * drawn. It is also the honest geometry for this quantity: the score really is
 * a proportion of a fixed range with a wall at the top, which is what a radial
 * gauge is for. (Gauges deserve their bad reputation when the maximum is
 * arbitrary or the needle is decoration. Here 100 is a real ceiling.)
 *
 * WHY IT IS SQUARE NOW, and why the ring became a filled wedge. Nothing in this
 * system has a rounded edge, and a 44px circle sitting in a grid of hard-edged
 * blocks was the one element that did. The wedge is also a better read than the
 * stroked arc at this size: a solid sector reaching the frame is legible at a
 * glance across four table rows, where 3px of arc had to be looked for. The
 * needle is what makes it a reading rather than a pie chart — it points at one
 * position on the dial, which is the thing the score is.
 *
 * Colour appears exactly ONCE per dial, on the wedge, and it is the only place
 * it appears: the numeral, the needle, the frame and the plate are all black
 * ink. That is what holds the page's colour budget flat, four rows spending
 * four hued elements rather than twelve, and it is why the numeral is legible
 * on every band — black on a white plate is 21:1 regardless of what the wedge
 * behind it is doing.
 *
 * The band word sits in the explanation rather than under the dial. Severity is
 * still not carried by hue alone, which WCAG 1.4.1 forbids: the numeral and the
 * needle's position are both non-chromatic channels, and 19 against 75 says the
 * same thing the words did. The accessible name still leads with "score N of
 * 100, BAND", so a screen reader gets the label without the sighted reader
 * paying for a caption under every row.
 */

/**
 * The block, and the geometry inside it. All of it in one place because the
 * numbers are load-bearing on each other: the plate has to be wide enough for
 * "100" at the 11px floor (three Space Mono digits are ~20px), the frame has to
 * clear the plate, and the wedge radius has to overshoot the corners so the
 * sector clips against the frame as a straight edge rather than stopping short
 * of it as a visible curve.
 */
const SIZE = 56;
/**
 * Every black line here: the frame, the plate's edge and the needle.
 *
 * THE JS MIRROR OF `--border-width-hard`, and the one place in the product that
 * has to keep a second copy of that number. SVG geometry is arithmetic, not
 * paint: the clip rect, the frame's inset and the needle's length are all
 * computed FROM the edge width, and a `var()` cannot be subtracted from 56 in
 * an attribute. Change the token and change this in the same edit.
 */
const HARD = 3;
const C = SIZE / 2;
/** Past the corner (√2 · 28 ≈ 39.6), so the wedge is clipped, never drawn short. */
const WEDGE_R = 40;
const PLATE_W = 30;
const PLATE_H = 18;

/** A point on the dial at `r`, `turn` of the way clockwise from twelve o'clock. */
function at(turn: number, r: number) {
  const t = turn * 2 * Math.PI;
  return [C + r * Math.sin(t), C - r * Math.cos(t)] as const;
}

/** Twelve o'clock on the wedge's radius: every sector starts here. */
const WEDGE_START = at(0, WEDGE_R);

/** Half the block's inner width: the distance from the centre to the frame. */
const INNER = C - HARD;

/**
 * The needle's tip: where the ray at `turn` meets the INNER EDGE OF THE FRAME,
 * not a point on the circle inscribed in it.
 *
 * The circle was the bug. A fixed radius lands on the frame only at the four
 * compass points; at 45 degrees the frame is √2 · 25 ≈ 35px from the centre and
 * a 25px needle stopped 10px short of it. So the hand reached the edge on a
 * score of 25 and visibly did not on a score of 12 or 38, which reads as the
 * needle's LENGTH carrying a meaning it never had, and is the "on some of the
 * gauges the line doesn't even go to the edge" report. Scaling the ray to the
 * box instead puts the tip on the frame at every score, which is also what the
 * wedge behind it already does (`WEDGE_R` overshoots and is clipped by the same
 * rectangle).
 */
function needleTip(turn: number): readonly [number, number] {
  const t = turn * 2 * Math.PI;
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  // The ray leaves the square through whichever pair of sides it reaches first.
  // A component of the direction at zero would divide by it, and the answer
  // there is "this ray never crosses that pair", which is what Infinity says.
  const r = Math.min(
    Math.abs(dx) < 1e-9 ? Infinity : INNER / Math.abs(dx),
    Math.abs(dy) < 1e-9 ? Infinity : INNER / Math.abs(dy),
  );
  return [C + dx * r, C + dy * r] as const;
}

/**
 * The sector from twelve o'clock to `turn`, as a path.
 *
 * The sweep is capped just short of a full revolution: at exactly 1 the start
 * and end points coincide and SVG resolves the arc to nothing, so a score of
 * 100 — the one score that most needs to be unmissable — would draw an empty
 * dial. Stopping at 0.9999 leaves a hairline the frame covers anyway.
 */
function wedgePath(turn: number): string {
  const sweep = Math.min(turn, 0.9999);
  const [x0, y0] = WEDGE_START;
  const [x1, y1] = at(sweep, WEDGE_R);
  const largeArc = sweep > 0.5 ? 1 : 0;
  return `M ${C} ${C} L ${x0} ${y0} A ${WEDGE_R} ${WEDGE_R} 0 ${largeArc} 1 ${x1} ${y1} Z`;
}

/**
 * The score's accessible name, leading with the answer. The ONE place this
 * wording exists: the dial's own tooltip opens with it, and any control that
 * wraps a `plain` dial must open its `aria-label` with it too, so every
 * surface announces the score in the same vocabulary. Nothing but a shared
 * builder holds those copies together - an aria string is invisible to
 * screenshots, tsc, and the design checklist's computed-style scan.
 */
export function riskScoreLabel(score: number, band: Band): string {
  return `${RISK_SCORE_NAME} ${score} of 100, ${band}.`;
}

export function RiskDial({
  score,
  band,
  subScores,
  plain = false,
}: {
  score: number;
  band: Band;
  /**
   * The four weighted components. Shown in the explanation, not on the dial.
   * The two market-context terms may be null on an active-mode score, and a
   * null must not reach `Math.round` here: it returns 0, which is the BEST
   * reading either term has, so an unread feed would announce a calm market.
   */
  subScores?: DegradableSubScores;
  /**
   * Render the dial alone, without the `InfoTip` wrapper.
   *
   * For callers that put the dial INSIDE a control of their own: `InfoTip`'s
   * anchor is itself focusable, so the default shape would nest a tab stop
   * inside a button. The owning control then carries the accessible name, and
   * it must OPEN with `riskScoreLabel(score, band)` - the exported builder,
   * not a re-typed copy - so a screen reader gets the same answer first that
   * the wrapper gives here.
   */
  plain?: boolean;
}) {
  const turn = Math.max(0, Math.min(100, score)) / 100;
  const [nx, ny] = needleTip(turn);
  /**
   * Per instance, because a `url(#…)` reference resolves against the whole
   * DOCUMENT: a Portfolio row renders one dial each, so a fixed id would put
   * four `clipPath`s under one name and every dial after the first would clip
   * against the first one's rect. It draws correctly today only because all the
   * rects are identical, which is a coincidence that ends the moment `SIZE`
   * becomes a prop. Duplicate ids are also invalid HTML.
   */
  const clipId = useId();

  /**
   * `RISK_TEXT[band]` sets `currentColor` on the wrapper and the wedge is the
   * only thing that reads it. The band still becomes pixels in exactly one
   * table (lib/utils), and nothing here can paint a numeral by accident.
   */
  const dial = (
    <span
      className={`relative inline-flex shrink-0 ${RISK_TEXT[band]}`}
      style={{ width: SIZE, height: SIZE }}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <defs>
          {/* Keeps the sector inside the frame, so it ends on the block's own
              straight edge instead of a curve of its own. */}
          <clipPath id={clipId}>
            <rect x={HARD} y={HARD} width={SIZE - HARD * 2} height={SIZE - HARD * 2} />
          </clipPath>
        </defs>
        <rect x={0} y={0} width={SIZE} height={SIZE} fill="var(--color-surface-raised)" />
        <path d={wedgePath(turn)} fill="currentColor" clipPath={`url(#${clipId})`} />
        {/* The needle, under the plate so it reads as a hand coming out from
            behind it rather than as a spoke crossing the number. */}
        <line
          x1={C}
          y1={C}
          x2={nx}
          y2={ny}
          stroke="var(--color-border-strong)"
          strokeWidth={HARD}
        />
        <rect
          x={C - PLATE_W / 2}
          y={C - PLATE_H / 2}
          width={PLATE_W}
          height={PLATE_H}
          fill="var(--color-surface-raised)"
          stroke="var(--color-border-strong)"
          strokeWidth={HARD}
        />
        <rect
          x={HARD / 2}
          y={HARD / 2}
          width={SIZE - HARD}
          height={SIZE - HARD}
          fill="none"
          stroke="var(--color-border-strong)"
          strokeWidth={HARD}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-2xs font-bold tabular-nums text-text-primary">
        {score}
      </span>
    </span>
  );

  if (plain) return dial;

  // Everything below is the tooltip's, and only the wrapped path pays for it.
  const term = (v: number | null) => (v === null ? "not measured" : String(Math.round(v)));
  // The published weights only describe the score when all four terms were
  // read. With one dropped the composite is renormalised over the rest, so
  // quoting them would be stating arithmetic the number did not follow.
  const degraded = subScores ? marketContextMissing(subScores) : false;

  // The accessible name has to lead with the answer. It is the label for a
  // focusable element, so it replaces the numeral and the word for a screen
  // reader rather than adding to them — starting it with the explanation would
  // bury the score behind a sentence about scores.
  //
  // The four component names and the weight sentence are read from the engine,
  // not retyped: a dial announcing "asset risk" beside a panel labelling the
  // same figure "Asset volatility" is one quantity under two names, and the
  // name a screen reader gets is the one nothing else can check.
  const explanation =
    `${riskScoreLabel(score, band)} ` +
    (subScores
      ? `${DRIVER_KEYS.map((k) => `${DRIVER_LABEL[k]} ${term(subScores[k])}`).join(", ")}. `
      : "") +
    (degraded ? "Weighted over the parts we could measure. " : `${COMPOSITE_WEIGHT_SENTENCE} `) +
    "Higher means closer to liquidation; your risk profile sets where alerts fire.";

  return (
    <InfoTip text={explanation} className="cursor-help">
      {dial}
    </InfoTip>
  );
}
