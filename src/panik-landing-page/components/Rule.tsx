/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";

/**
 * The full-bleed 3px black rule between two sections, which is how this page is
 * divided: no section sits in a card and none of them is tinted, so the rule is
 * the whole structure.
 *
 * A filled box rather than a border on the section itself. `hard-edge` sets all
 * four sides at once, so a caller zeroing three of them is relying on which
 * utility Tailwind emits last; a box with a height and a fill cannot lose an
 * argument it is not having. `h-0.75` is 3px off the spacing scale, which is
 * the same 3px `--border-width-hard` carries everywhere else on the page but
 * reaches it by a different route: the spacing multiplier, not the border
 * token. That is why this component exists at all rather than the class string
 * being retyped. Closing the gap properly means a `rule` utility in
 * `src/index.css` reading `--border-width-hard` the way `hard-edge` does, and
 * the token file is deliberately untouched on this branch.
 *
 * `className` exists for the ONE rule on the page that turns: the divider
 * inside the hero's position card, which is horizontal while the card is
 * stacked and vertical once it is side by side. A responsive variant beats an
 * unprefixed utility whatever the emit order, so `sm:w-0.75` overriding
 * `w-full` is safe in a way that a second base `w-*` would not be.
 */
export function Rule({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`h-0.75 w-full bg-border-strong ${className}`} />;
}
