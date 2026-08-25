/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { PanikLogoMark } from "./PanikLogo";

/**
 * The mark in its box: a 56px white plate with the 3px black edge and the 6px
 * black shadow, which is the lockup the nav, the closing band, the footer and
 * the signup's success step all open with.
 *
 * It is here rather than retyped at those four sites because it had already
 * drifted at the second one: the nav carried a `md:size-14` step the other
 * three did not, so the mark was 48px on a phone and 56px everywhere else for
 * no reason anybody could name. One size, and the plate cannot disagree with
 * itself.
 *
 * Not `Card tone="raised"`, which is the same three utilities: `Card` bakes in
 * `p-4` and appends the caller's classes, so a `p-0` passed through
 * `className` would tie with it on specificity and be settled by Tailwind's
 * emit order. A plate whose padding depends on that is worse than three
 * utilities named once.
 */
export function MarkPlate() {
  return (
    <span className="flex size-14 shrink-0 items-center justify-center hard-edge bg-surface-raised shadow-hard">
      <PanikLogoMark size={28} />
    </span>
  );
}
