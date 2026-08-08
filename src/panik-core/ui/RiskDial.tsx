import React from "react";
import type { Band } from "../lib/live";
import { RISK_TEXT } from "../lib/utils";
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
 * Colour appears exactly ONCE per dial, on the arc. The numeral is
 * text-primary and the band word is text-secondary, both neutral ink. That is
 * deliberate on two counts: 18.1:1 beats the 4-5:1 a saturated numeral gets on
 * these surfaces, and it holds the page's colour budget flat — four rows still
 * spend four hued elements, the same as the four chips before them, rather
 * than three each.
 *
 * The band word is not optional decoration. A status is never allowed to be
 * carried by hue alone: at four rows the arcs are the fastest read for someone
 * who can see them, and the word is the whole message for someone who cannot.
 */

const SIZE = 44;
const STROKE = 3;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function RiskDial({
  score,
  band,
  subScores,
}: {
  score: number;
  band: Band;
  /** The four weighted components. Shown in the explanation, not on the dial. */
  subScores?: { positionHealth: number; assetRisk: number; protocolSafety: number; systemicRisk: number };
}) {
  const pct = Math.max(0, Math.min(100, score)) / 100;

  // The accessible name has to lead with the answer. It is the label for a
  // focusable element, so it replaces the numeral and the word for a screen
  // reader rather than adding to them — starting it with the explanation would
  // bury the score behind a sentence about scores.
  const explanation =
    `PANIK risk score ${score} of 100, ${band}. ` +
    (subScores
      ? `Position health ${Math.round(subScores.positionHealth)}, asset risk ${Math.round(subScores.assetRisk)}, ` +
        `protocol safety ${Math.round(subScores.protocolSafety)}, systemic risk ${Math.round(subScores.systemicRisk)}. `
      : "") +
    "Weighted 40/25/20/15. Higher means closer to liquidation; your risk profile sets where alerts fire.";

  return (
    <InfoTip text={explanation} className="cursor-help rounded-full">
      <span className="flex flex-col items-center gap-1">
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
        <span className="text-2xs font-sans font-bold leading-none text-text-secondary">{band}</span>
      </span>
    </InfoTip>
  );
}
