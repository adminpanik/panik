import React from "react";

/**
 * `brand` is for a figure that is a count, not a judgement. The three risk
 * tones are for figures that ARE a risk statement — a number that changes
 * colour with its own value. Anything else stays neutral: colouring a dollar
 * amount by band implies the amount is the risk, and it is not.
 */
const STAT_TONE = {
  default: "text-text-primary",
  brand: "text-panik-orange",
  low: "text-risk-low",
  elevated: "text-risk-elevated",
  critical: "text-risk-critical",
} as const;

interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Secondary line under the figure: a ratio, a breakdown, a qualifier. */
  sub?: React.ReactNode;
  tone?: keyof typeof STAT_TONE;
}

export function Stat({ label, value, sub, tone = "default" }: StatProps) {
  return (
    <div>
      <span className="flex items-center gap-1 text-2xs font-mono font-bold uppercase text-text-muted">
        {label}
      </span>
      <span
        className={`mt-2 block text-2xl font-mono font-bold tabular-nums ${STAT_TONE[tone]}`}
      >
        {value}
      </span>
      {sub && <span className="mt-2 block text-2xs font-mono text-text-secondary">{sub}</span>}
    </div>
  );
}
