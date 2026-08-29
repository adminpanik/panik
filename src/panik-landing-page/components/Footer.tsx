/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { MarkPlate } from "./MarkPlate";

/**
 * Two columns, and EVERY LINK IN THEM GOES SOMEWHERE THAT EXISTS today: a
 * section of this page, or an account we actually run.
 *
 * That is why the columns are uneven and why the second is "Elsewhere" rather
 * than the "Legal" the mockup carried. Terms and Privacy pages have not been
 * written; a footer link to a page that 404s is a worse promise than an absent
 * one, and padding the grid to a tidy three-by-three would have meant either
 * inventing those pages or pointing two labels at one anchor.
 */
const LINK_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "#how" },
      { label: "Why PANIK", href: "#why" },
    ],
  },
  {
    heading: "Elsewhere",
    links: [
      { label: "Follow on X", href: "https://x.com/panik_fi" },
      { label: "Built on Base", href: "https://base.org" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-16 md:px-16 lg:py-24">
      <div className="flex flex-col justify-between gap-8 md:flex-row md:items-start">
        <a href="#top" className="flex items-center gap-4 no-underline">
          <MarkPlate />
          <span className="text-2xl font-black tracking-tight text-text-primary">PANIK</span>
        </a>
        <div className="grid gap-8 sm:grid-cols-2 md:gap-16">
          {LINK_COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading} className="flex flex-col gap-3">
              <p className="label-type text-xs text-text-secondary">{column.heading}</p>
              {column.links.map((link) => {
                /* Derived rather than a flag on the row: a link that leaves the
                   site is exactly a link whose href does, and the two cannot
                   disagree if only one of them is written down. */
                const external = link.href.startsWith("http");
                return (
                  <a
                    key={link.label}
                    href={link.href}
                    className="flex h-6 items-center text-sm text-text-primary"
                    {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
                  >
                    {link.label}
                  </a>
                );
              })}
            </nav>
          ))}
        </div>
      </div>

      {/*
       * One sentence, plain, no jargon: what the product does, what it does
       * not do, and that it can be wrong. There is no Terms or Privacy page
       * yet (see the note on `LINK_COLUMNS` above), so this is the only place
       * on the site that tells a reader the product can send a bad warning
       * and never touches their funds without a signature they give it.
       * Full-width rather than folded into the "Elsewhere" column: that
       * column is a link list, and a sentence in it would read as a link.
       */}
      <p className="max-w-2xl text-xs text-text-secondary">
        PANIK scores risk and sends warnings. It does not move funds without your signature, and it
        can be wrong. Nothing here is financial advice.
      </p>

      <p className="font-mono text-xs text-text-secondary">
        Copyright {new Date().getFullYear()} PANIK. Built on Base.
      </p>
    </footer>
  );
}
