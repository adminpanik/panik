import React from "react";

/**
 * A stat value is always neutral. It used to accept a `tone`, which is how a
 * dashboard ends up with a giant orange "4 Positions" next to a giant red
 * "57 / 100": once the figure itself carries hue, every card competes, and the
 * one element that genuinely encodes a risk band stops being the loudest thing
 * on the screen.
 *
 * A band still has a home. It is the RiskChip, and it is small on purpose.
 *
 * THE FIGURE IS SET IN MONO. Space Mono 700, tabular, which is this system's
 * one rule for a numeral: a money value, a percentage, a score and an address
 * all read as READINGS rather than as prose, and a column of them lines up on
 * its own without each call site remembering `tabular-nums`. The label and the
 * subline stay in Archivo, because they are words.
 *
 * TWO SIZES, and 28px is still the default. The scale had no 32 when this was
 * written, so the look's 32 was rendered at 28 rather than inventing a step
 * here; the Portfolio board then asked for 32 on the dashboard's four figures
 * specifically, so `--text-stat` was added to the theme and `size="lg"` reads
 * it. Every other `Stat` in the product is unchanged, which is the point of the
 * prop: an eighth step that one surface opts into is a decision, an eighth step
 * every surface silently gets is drift.
 */
const VALUE_SIZE = {
  md: "text-2xl",
  /**
   * 20px below `md`, 32px from there up.
   *
   * The four dashboard figures sit two-up at 390 rather than stacked, which
   * leaves each card 171px wide and 139px of it inside the padding. "$261,200"
   * at 32px in Space Mono measures 154px, so the phone either truncated a money
   * figure or kept four full-width cards that took a screen and a half to
   * scroll past. `text-lg` measures 96px and leaves room for a seven-figure
   * wallet.
   *
   * Safe to make responsive HERE rather than at the call site: `size="lg"` is
   * read by the Portfolio dashboard's four cards and by nothing else in the
   * product (every other `size="lg"` in the tree is a `Button` or a `Field`).
   */
  lg: "text-lg md:text-stat",
} as const;

interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /**
   * Secondary line under the figure: a ratio, a breakdown, a qualifier.
   *
   * OPTIONAL, and meant to stay that way. A subline earns its place only by
   * carrying something the label and the figure do not already state: a
   * derived ratio, a count the figure is not, the band a score falls in. A
   * card with nothing further to say says nothing further; it does not get a
   * line of filler so the row looks tidy. The row stays tidy anyway, because
   * these cards are grid items and grid items stretch: four cards are the same
   * height whether one, two or none of them have a sub, and the label and
   * figure of all four sit on the same two baselines regardless.
   */
  sub?: React.ReactNode;
  /** `lg` is the dashboard figure at 32px. See `VALUE_SIZE`. */
  size?: keyof typeof VALUE_SIZE;
}

export function Stat({ label, value, sub, size = "md" }: StatProps) {
  /**
   * The dashboard card is 171px wide two-up at 390, and at that width
   * "Liquidation buffer" is 145px of a 139px box: the CAPTION ellipsised, which
   * leaves a figure whose label cannot be read. So the `lg` card, and only it,
   * lets its caption and its sub wrap below `md` and goes back to one line from
   * there up, where the four cards have 250px each and the ragged-block problem
   * the truncation exists to prevent is real again.
   */
  const oneLine = size === "lg" ? "md:truncate" : "truncate";
  return (
    <div>
      <span className={`flex items-center gap-1 label-type text-xs text-text-muted ${oneLine}`}>
        {label}
      </span>
      <span
        className={`mt-2 block font-mono font-bold tabular-nums text-text-primary ${VALUE_SIZE[size]} ${oneLine}`}
      >
        {value}
      </span>
      {/* Every line is exactly one line. A row of stat cards where one subtitle
          wraps leaves the other three with a ragged block of dead space under
          the figure, and the eye reads that raggedness as disorder rather than
          as "this card had more to say". */}
      {sub ? (
        <span className={`mt-2 block font-sans text-sm text-text-secondary ${oneLine}`}>{sub}</span>
      ) : null}
    </div>
  );
}
