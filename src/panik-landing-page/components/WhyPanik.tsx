/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Bell, Gauge, WifiOff, type LucideIcon } from "lucide-react";
import { Card } from "../../panik-core/ui";
import { SectionHeading } from "./SectionHeading";

/**
 * Three doubts a borrower arrives with, answered in their own words rather
 * than in ours. Each card names the objection in its heading and spends its
 * body on the answer; none of them describes a feature.
 *
 * The icon is a lavender plate, not a risk-coloured one. A warning glyph in a
 * warm hue beside a heading about liquidation is the page reading as a risk
 * statement about nothing, and the ramp is rationed for the one chip in the
 * hero.
 */
const REASONS: { icon: LucideIcon; title: string; body: React.ReactNode }[] = [
  {
    icon: Gauge,
    title: "A health factor is not a warning",
    body: (
      <>
        A reading of <span className="font-mono font-bold">1.4</span> does not tell you how far the
        price can move before you lose the position. PANIK turns it into one number you can act on.
      </>
    ),
  },
  {
    icon: Bell,
    title: "A warning beats a bot",
    body: "A bot closes you out at the worst minute of the day and takes a cut for it. Two minutes of notice leaves the decision, and the collateral, with you.",
  },
  {
    icon: WifiOff,
    title: "A stale price says so",
    body: "When a price source stops updating, the position reads as unknown instead of showing a number we cannot stand behind.",
  },
];

export function WhyPanik() {
  return (
    <section id="why" className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-16 md:px-16 lg:py-24">
      <SectionHeading title="Why PANIK" />
      <div className="grid gap-6 md:grid-cols-3">
        {REASONS.map(({ icon: Icon, title, body }) => (
          <Card key={title} tone="raised" className="flex flex-col gap-4 p-6">
            <span className="flex size-11 shrink-0 items-center justify-center hard-edge bg-highlight">
              <Icon aria-hidden="true" className="size-6 text-text-primary" />
            </span>
            <div className="flex flex-col gap-2">
              <h3 className="text-lg font-black tracking-tight text-text-primary">{title}</h3>
              <p className="text-base text-text-secondary">{body}</p>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
