/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Button } from "../../panik-core/ui";
import { MarkPlate } from "./MarkPlate";
import type { WaitlistCta } from "./cta";

/**
 * Every link points at a section that exists on this page. The nav this
 * replaces carried "Products" and "Performance" items aimed at ids that had
 * been renamed, so two of its five links scrolled nowhere.
 */
const NAV_LINKS = [
  { href: "#why", label: "Why PANIK" },
  { href: "#how", label: "How it works" },
  { href: "#faq", label: "FAQ" },
];

/**
 * Below `md` the bar is the mark and the one button, and the links simply go
 * away rather than folding into a hamburger sheet: the three destinations are
 * the next three screens of this page, so a reader on a phone reaches them by
 * scrolling. A menu that duplicates the scroll order is a second way to do one
 * thing and a third overlay to keep honest.
 */
export function Navigation({ cta }: { cta: WaitlistCta }) {
  return (
    <header id="top">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4 md:px-16">
        <a href="#top" className="flex items-center gap-4 no-underline">
          <MarkPlate />
          {/* Below `md` the mark carries the brand on its own. The wordmark and
              a button whose label cannot wrap do not both fit beside a 48px
              plate at 390px, and the mark is the half that still identifies the
              page. The footer prints the full lockup at every width. */}
          <span className="hidden text-2xl font-black tracking-tight text-text-primary md:inline">
            PANIK
          </span>
        </a>
        <nav aria-label="Primary" className="flex items-center gap-6 lg:gap-8">
          <ul className="hidden items-center gap-6 md:flex lg:gap-8">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                {/* `h-6` rather than the 13px the type would give on its own:
                    a 12px link is a 13px tap target, and the floor is 24px
                    (WCAG 2.2 SC 2.5.8). */}
                <a
                  href={link.href}
                  className="label-type flex h-6 items-center whitespace-nowrap text-xs text-text-primary"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          <Button onClick={cta.onClick} disabled={cta.disabled} className="whitespace-nowrap">
            {cta.label}
          </Button>
        </nav>
      </div>
    </header>
  );
}
