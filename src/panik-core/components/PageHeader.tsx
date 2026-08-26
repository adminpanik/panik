/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The top of a tab: which page this is, and the one thing to do on it.
 *
 * ONE COMPONENT FOR FIVE TABS, because five hand-typed headers is five answers
 * to "what does a page title look like" and the app already had four of them:
 * Portfolio ran an `h1` at `text-2xl font-extrabold` over a hairline with a
 * button beside it, Compass ran the same `h1` with a three-button profile group
 * where the button goes, Advisor ran the `h1` alone, Settings ran a copy of
 * Portfolio's inside its own centred column, and Watch had no heading at all.
 * Moving between tabs restated the same rank at two weights, two paddings and
 * two positions, which is the drift a shared component cannot have.
 *
 * 72px, which is the header height the design system sets, and a 3px black rule
 * under it rather than the old hairline: everything structural on this look is
 * drawn at `--border-width-hard`, and a 1px rule under a 28px heading read as a
 * seam rather than as the edge of a band.
 *
 * EXACTLY ONE ACTION, and it is optional. A header with two buttons has no
 * primary; a header with a segmented control in the action slot (which is what
 * Compass had) puts a chooser where every other tab puts a verb. Controls that
 * change what the page SHOWS belong in the page, under this rule, where the
 * thing they change is.
 */

import React from "react";

export function PageHeader({
  title,
  action,
}: {
  title: string;
  /**
   * The page's single primary control, or nothing. A `Button`, always: the slot
   * is sized and aligned for a 48px control and anything else in it is a second
   * treatment for the one element on the page that has to look the same on all
   * five tabs.
   */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-18 shrink-0 items-center justify-between gap-4 border-b-[3px] border-solid border-border-strong">
      {/* 28px from `sm` up, 20px below it. Measured at 390: "PORTFOLIO" at 28px
          is 208px and the action beside it is 165px, which is 15px past the
          358px the padded column has, so the title ellipsised to "PORTFOL…" -
          a page heading that cannot say which page it is. 20px is 118px and
          both fit whole.

          Truncates rather than wraps at any width. A two-line heading would
          take the header past the 72px every other tab is drawn at, so the
          elastic half is the words, and this is the one size step that keeps it
          from ever having to give. */}
      <h1 className="min-w-0 truncate font-sans text-lg font-black uppercase tracking-tight text-text-primary sm:text-2xl">
        {title}
      </h1>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
