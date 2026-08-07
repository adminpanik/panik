import React from "react";

/**
 * A stat value is always neutral. It used to accept a `tone`, which is how a
 * dashboard ends up with a giant orange "4 Positions" next to a giant red
 * "57 / 100": once the figure itself carries hue, every card competes, and the
 * one element that genuinely encodes a risk band — the chip on a position row —
 * stops being the loudest thing on the screen.
 *
 * A band still has a home. It is the RiskChip, and it is small on purpose.
 */
interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Secondary line under the figure: a ratio, a breakdown, a qualifier. */
  sub?: React.ReactNode;
}

export function Stat({ label, value, sub }: StatProps) {
  return (
    <div>
      <span className="flex items-center gap-1 text-xs font-sans font-medium text-text-muted">
        {label}
      </span>
      <span className="mt-2 block text-2xl font-sans font-bold tabular-nums text-text-primary">
        {value}
      </span>
      {sub && <span className="mt-2 block text-xs font-sans text-text-secondary">{sub}</span>}
    </div>
  );
}
