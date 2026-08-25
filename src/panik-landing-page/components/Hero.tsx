/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { ArrowRight } from "lucide-react";
import { Button, RiskChip } from "../../panik-core/ui";
import { PanikLogoMark } from "./PanikLogo";
import { Rule } from "./Rule";
import type { WaitlistCta } from "./cta";

/**
 * The hero, and the fragment of product beside it.
 *
 * THE FRAGMENT IS THE ONLY PLACE ON THIS PAGE THAT SPENDS RISK COLOUR. One
 * HIGH chip, rendered by `RiskChip` so the band still becomes pixels in exactly
 * one place (`RISK_CHIP` in panik-core/lib/utils), against the Portfolio tab's
 * own handful. Everything else that wants to be loud here is cobalt or
 * lavender, neither of which is on the ramp, so no other block on the page can
 * be misread as a claim about a position.
 *
 * The numbers in it are an illustration of the product's output, which is why
 * they are a named pair and a stated buffer rather than a live reading: the
 * page has no wallet to score. The same figure appears twice on purpose (the
 * sentence and the big readout are one quantity, not two), which is the only
 * way this card can obey "never show the same quantity twice with different
 * numbers".
 *
 * "See a live score" is an underlined brand link rather than a second bordered
 * block. It navigates to another page, so it has to be an anchor, and the
 * `Button` primitive renders a `<button>`; mirroring its variant string onto an
 * `<a>` would put a second copy of the control skin on the landing page, which
 * is the drift the primitive exists to prevent. The system's answer for a
 * navigation is a 3px cobalt underline, so that is what it gets.
 */
export function Hero({ cta }: { cta: WaitlistCta }) {
  return (
    <section className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-12 md:px-16 md:py-16 lg:grid-cols-2">
      <div className="flex flex-col gap-6">
        <p className="flex items-center gap-3 label-type text-xs text-text-primary">
          <span aria-hidden="true" className="size-3 shrink-0 hard-edge bg-brand" />
          Liquidation early warning for Base
        </p>
        <h1 className="text-4xl font-black uppercase tracking-tight md:text-display">
          We warn you before the liquidation
        </h1>
        <p className="max-w-xl text-base text-text-secondary md:text-lg">
          PANIK scores your lending positions on Base, shows the price drop that would liquidate
          each one, and messages you before it gets there.
        </p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-6">
            <Button size="lg" onClick={cta.onClick} disabled={cta.disabled}>
              {cta.label}
              <ArrowRight aria-hidden="true" className="size-5" />
            </Button>
            <a href="/app" className="flex h-6 items-center text-sm font-bold text-text-primary">
              See a live score
            </a>
          </div>
          <p className="text-sm text-text-secondary">No wallet connection needed to start.</p>
        </div>
      </div>

      <div className="flex w-full flex-col gap-4 lg:max-w-xl lg:justify-self-end">
        <span className="self-start hard-edge bg-highlight px-4 py-2 font-mono text-xs font-bold tracking-widest text-text-primary shadow-hard-sm">
          TELEGRAM, 2 MIN BEFORE
        </span>

        {/*
          The `raised` tone's three utilities, written out rather than taken
          from `Card`, and it is the padding that forces it: `Card` bakes in
          `p-4` and APPENDS the caller's classes, so a `p-0` passed through
          `className` ties with it and Tailwind's emit order settles it. It was
          settled the wrong way here (measured: 16px, not 0), which left this
          card's divider floating short of its own edges. This divider has to
          run the full height of the card, so the padding has to belong to the
          two halves and not to the box around them.
        */}
        <div className="flex flex-col gap-4 hard-edge bg-surface-raised shadow-hard sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs font-bold tracking-widest text-text-secondary">
                AAVE V3 / BASE
              </span>
              <RiskChip band="HIGH">HIGH</RiskChip>
            </div>
            <p className="font-mono text-lg font-bold tracking-tight text-text-primary">
              cbBTC / USDC
            </p>
            <p className="text-sm text-text-primary">
              Liquidates if cbBTC falls <span className="font-mono font-bold">4.8%</span>
            </p>
          </div>
          <Rule className="sm:h-auto sm:w-0.75" />
          <div className="flex flex-col items-start justify-center gap-1 p-4 sm:items-end">
            <span className="font-mono text-4xl font-bold tracking-tight text-text-primary">
              4.8%
            </span>
            <span className="font-mono text-xs font-bold tracking-widest text-text-secondary">
              PRICE BUFFER
            </span>
          </div>
        </div>

        <div className="flex w-64 flex-col justify-between gap-6 hard-edge bg-brand p-4 shadow-hard sm:self-end">
          <PanikLogoMark size={36} className="text-white" />
          <div className="flex flex-col gap-1">
            <span className="font-mono text-lg font-bold tracking-wide text-white">ALERT SENT</span>
            <span className="font-mono text-2xs font-bold tracking-widest text-white">
              BEFORE THE PRICE GOT THERE
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
