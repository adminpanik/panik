/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A neutral marker beside a thing: "Your wallet", "Showing in Portfolio",
 * "Demo".
 *
 * NOT `RiskChip`. That one is a band becoming pixels and owns the risk ramp;
 * this carries no state and no hue, which is why it can be sprinkled without
 * spending the screen's colour budget.
 *
 * It exists because the same eleven utilities were hand-typed on four spans
 * across three files, and two of them had already drifted apart on horizontal
 * padding (`px-2` against `px-2.5`). Nobody can see 2px, but nobody can keep
 * four copies equal either.
 *
 * `title` is optional and is the only thing that varies: `DemoChip` uses it to
 * say which part of a surface is not real, and the wallet markers need no
 * hover at all because the word is the whole fact.
 */

import React from "react";

/**
 * `shrink-0` is in the shared string on purpose: every site so far puts this
 * in a flex row next to text that truncates, and a marker that shrinks reads
 * as "Your wall…". `inline-flex` rather than `flex` so the chip is still
 * inline-level outside a flex parent; inside one it blockifies to the same
 * thing.
 */
const CHIP =
  "shrink-0 inline-flex items-center rounded-sm border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-2xs font-sans font-bold text-text-muted";

export function Chip({
  children,
  title,
  className = "",
}: {
  children: React.ReactNode;
  title?: string;
  /**
   * Where the chip SITS, and nothing about how it looks.
   *
   * A chip in a flex COLUMN stretches to the column's width, so the Compass
   * lead's marker needs `self-start` to be a chip rather than a bar. That was a
   * wrapper `<div className="flex">` around it, which is a whole element to
   * make one property say what it already says one level down.
   *
   * `self-start` is not in the shared string because it would be wrong at the
   * commonest site: every other chip sits in a flex ROW beside a control, and
   * `align-self: flex-start` there lifts a 22px chip to the top of a 34px
   * button.
   *
   * Appended, so a utility passed here wins on ORDER rather than on
   * specificity. That is only safe for a property the base string does not set,
   * which is why this is documented as positioning: the skin (`bg-*`, the
   * border, the type) is the primitive's whole reason to exist, and a caller
   * overriding one of those would be a tie broken by Tailwind's emit order.
   */
  className?: string;
}) {
  return (
    <span title={title} className={`${CHIP} ${className}`}>
      {children}
    </span>
  );
}
