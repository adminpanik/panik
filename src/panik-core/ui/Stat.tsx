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
  /**
   * Secondary line under the figure: a ratio, a breakdown, a qualifier.
   *
   * OPTIONAL, and meant to stay that way. A subline earns its place only by
   * carrying something the label and the figure do not already state — a
   * derived ratio, a count the figure is not, the band a score falls in. A
   * card with nothing further to say says nothing further; it does not get a
   * line of filler so the row looks tidy. The row stays tidy anyway, because
   * these cards are grid items and grid items stretch: four cards are the same
   * height whether one, two or none of them have a sub, and the label and
   * figure of all four sit on the same two baselines regardless.
   */
  sub?: React.ReactNode;
}

export function Stat({ label, value, sub }: StatProps) {
  return (
    <div>
      <span className="flex items-center gap-1 truncate text-xs font-sans font-medium text-text-muted">
        {label}
      </span>
      <span className="mt-2 block truncate text-2xl font-sans font-bold tabular-nums text-text-primary">
        {value}
      </span>
      {/* Every line is exactly one line. A row of stat cards where one subtitle
          wraps leaves the other three with a ragged block of dead space under
          the figure, and the eye reads that raggedness as disorder rather than
          as "this card had more to say". */}
      {sub ? (
        <span className="mt-2 block truncate text-xs font-sans text-text-secondary">{sub}</span>
      ) : null}
    </div>
  );
}
