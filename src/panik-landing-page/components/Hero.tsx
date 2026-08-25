/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { ArrowRight } from "lucide-react";
import { Button, Card, RiskChip } from "../../panik-core/ui";
import { MarkPlate } from "./MarkPlate";
import type { WaitlistCta } from "./cta";

/**
 * The hero, and one object beside it: the message PANIK sends.
 *
 * It replaces a collage of three blocks (a position card, a cobalt ALERT SENT
 * panel and a lavender badge) that each stated a fragment of the same event and
 * left the reader assembling it. The product's output is a Telegram message, so
 * the illustration is a Telegram message.
 *
 * THE CHIP IS THE ONLY PLACE ON THIS PAGE THAT SPENDS RISK COLOUR. One HIGH
 * band through `RiskChip`, so the band still becomes pixels in exactly one place
 * (`RISK_CHIP` in panik-core/lib/utils). Nothing else on the page is on the
 * ramp, so no other block can be misread as a claim about a position.
 *
 * The figures are a sample. The page has no wallet to score, and both numbers
 * are quantities the engine would report about one position rather than the same
 * quantity printed twice.
 */
export function Hero({ cta }: { cta: WaitlistCta }) {
  return (
    <section className="mx-auto grid max-w-7xl items-center gap-12 px-6 pt-16 pb-16 md:px-16 lg:grid-cols-2 lg:pt-32 lg:pb-24">
      <div className="flex flex-col gap-6">
        <h1 className="text-4xl font-black uppercase tracking-tight md:text-display">
          We warn you before the liquidation
        </h1>
        <p className="max-w-xl text-base text-text-secondary md:text-lg">
          PANIK scores your lending positions on Base, shows the price drop that would liquidate
          each one, and messages you before it gets there.
        </p>
        <Button size="lg" className="self-start" onClick={cta.onClick} disabled={cta.disabled}>
          {cta.label}
          <ArrowRight aria-hidden="true" className="size-5" />
        </Button>
      </div>

      <Card tone="raised" className="flex w-full flex-col gap-4 lg:max-w-xl lg:justify-self-end">
        <div className="flex items-center gap-4">
          <MarkPlate />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-lg font-bold tracking-tight text-text-primary">PANIK</span>
            <span className="font-mono text-xs text-text-secondary">14:32</span>
          </div>
          <RiskChip band="HIGH">HIGH</RiskChip>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-base font-bold text-text-primary">
            cbBTC is down <span className="font-mono font-bold">3.9%</span> in the last hour.
          </p>
          <p className="text-base text-text-secondary">
            Your Aave v3 position liquidates if it falls{" "}
            <span className="font-mono font-bold text-text-primary">4.8%</span>. Exit plan ready.
          </p>
        </div>
      </Card>
    </section>
  );
}
