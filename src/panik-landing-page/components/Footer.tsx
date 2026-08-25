/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Card } from "../../panik-core/ui";
import { MarkPlate } from "./MarkPlate";

/**
 * Three columns, and EVERY LINK IN THEM GOES SOMEWHERE THAT EXISTS today: a
 * section of this page, the product, or an account we actually run.
 *
 * That is why the columns are uneven and why the third is "Elsewhere" rather
 * than the "Legal" the mockup carried. Terms and Privacy pages have not been
 * written; a footer link to a page that 404s is a worse promise than an absent
 * one, and padding the grid to a tidy three-by-three would have meant either
 * inventing those pages or pointing two labels at one anchor. The risk notice
 * below is a real document, so it is the legal item that ships. When the other
 * two exist they join that column and the heading goes back.
 */
const LINK_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Live score", href: "/app" },
      { label: "How it works", href: "#how" },
      { label: "Why PANIK", href: "#why" },
    ],
  },
  {
    heading: "Answers",
    links: [
      { label: "FAQ", href: "#faq" },
      { label: "Risk notice", href: "#risk-notice" },
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
        <div className="grid gap-8 sm:grid-cols-3 md:gap-16">
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
        The one thing on this page that has to survive being skimmed: what
        PANIK does not do. `lead` is the lavender plate, which is the loudest
        card tone available and is nowhere near the risk ramp, so the notice can
        be unmissable without reading as a warning about a position.
      */}
      <Card id="risk-notice" tone="lead">
        <p className="text-sm text-text-primary">
          PANIK watches positions and sends warnings. It never moves your funds, it is not financial
          advice, and a warning can arrive late or not at all if a price source goes quiet.
        </p>
      </Card>

      <p className="font-mono text-xs text-text-secondary">
        Copyright {new Date().getFullYear()} PANIK. Built on Base.
      </p>
    </footer>
  );
}
