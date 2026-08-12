import React from "react";
import type { Band, DegradableSubScores } from "../lib/live";
import { marketContextMissing, RISK_TEXT } from "../lib/utils";
import { InfoTip } from "../components/InfoTip";

/**
 * A position's PANIK score as a dial: the number in the middle, the arc
 * showing how much of the 0-100 journey to liquidation it has travelled.
 *
 * Why an arc and not the tinted pill this replaced. The pill stated "52 HIGH"
 * and left the reader to know what 52 was out of, which is exactly the fact
 * that makes the number actionable — 52 is not "bad", it is "halfway", and
 * halfway is a distance you can reason about. The arc is that denominator,
 * drawn. It is also the honest geometry for this quantity: the score really is
 * a proportion of a fixed range with a wall at the top, which is what a radial
 * gauge is for. (Gauges deserve their bad reputation when the maximum is
 * arbitrary or the needle is decoration. Here 100 is a real ceiling.)
 *
 * Colour appears exactly ONCE per dial, on the arc. The numeral is neutral ink:
 * 18.1:1 beats the 4-5:1 a saturated numeral gets on these surfaces, and it
 * holds the page's colour budget flat, four rows spending four hued elements
 * rather than twelve.
 *
 * The band word sits in the explanation rather than under the dial. Severity is
 * still not carried by hue alone, which WCAG 1.4.1 forbids: the numeral is the
 * non-chromatic channel, and 19 against 75 says the same thing the words did.
 * The accessible name still leads with "score N of 100, BAND", so a screen
 * reader gets the label without the sighted reader paying for a caption under
 * every row.
 */

const SIZE = 44;
const STROKE = 3;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The score's accessible name, leading with the answer. The ONE place this
 * wording exists: the dial's own tooltip opens with it, and any control that
 * wraps a `plain` dial must open its `aria-label` with it too, so every
 * surface announces the score in the same vocabulary. Nothing but a shared
 * builder holds those copies together - an aria string is invisible to
 * screenshots, tsc, and the design checklist's computed-style scan.
 */
export function riskScoreLabel(score: number, band: Band): string {
  return `PANIK risk score ${score} of 100, ${band}.`;
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
  const pct = Math.max(0, Math.min(100, score)) / 100;

  const dial = (
    <span className={`relative inline-flex shrink-0 ${RISK_TEXT[band]}`} style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {/* Track. Recessive on purpose - it is the axis, not the datum. */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="var(--color-border-subtle)"
          strokeWidth={STROKE}
        />
        {/* Arc. Rotated to start at twelve o'clock, because a gauge that
            starts anywhere else is read as starting at zero anyway. */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-sans font-bold tabular-nums text-text-primary">
        {score}
      </span>
    </span>
  );

  if (plain) return dial;

  // Everything below is the tooltip's, and only the wrapped path pays for it.
  const term = (v: number | null) => (v === null ? "not measured" : String(Math.round(v)));
  // The published weights only describe the score when all four terms were
  // read. With one dropped the composite is renormalised over the rest, so
  // quoting 40/25/20/15 would be stating arithmetic the number did not follow.
  const degraded = subScores ? marketContextMissing(subScores) : false;

  // The accessible name has to lead with the answer. It is the label for a
  // focusable element, so it replaces the numeral and the word for a screen
  // reader rather than adding to them — starting it with the explanation would
  // bury the score behind a sentence about scores.
  //
  // The four component names are the product's own, verbatim from the
  // RISK_DRIVERS table in AppDemo: a dial announcing "asset risk" and
  // "systemic risk" beside a panel labelling the same two figures "Asset
  // volatility" and "Market stress" is one quantity under two names, and the
  // name a screen reader gets is the one nothing else can check. The table
  // stays where it is; only the words are shared.
  const explanation =
    `${riskScoreLabel(score, band)} ` +
    (subScores
      ? `Position health ${term(subScores.positionHealth)}, Asset volatility ${term(subScores.assetRisk)}, ` +
        `Protocol risk ${term(subScores.protocolSafety)}, Market stress ${term(subScores.systemicRisk)}. `
      : "") +
    (degraded ? "Weighted over the parts we could measure. " : "Weighted 40/25/20/15. ") +
    "Higher means closer to liquidation; your risk profile sets where alerts fire.";

  return (
    <InfoTip text={explanation} className="cursor-help rounded-full">
      {dial}
    </InfoTip>
  );
}
