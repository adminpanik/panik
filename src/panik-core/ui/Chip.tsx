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

export function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={CHIP}>
      {children}
    </span>
  );
}
