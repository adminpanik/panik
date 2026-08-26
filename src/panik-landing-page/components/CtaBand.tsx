/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Button } from "../../panik-core/ui";
import { MarkPlate } from "./MarkPlate";
import type { WaitlistCta } from "./cta";

/**
 * The one full-bleed band on the page, and it is cobalt because cobalt is the
 * brand accent and is nowhere on the risk ramp: the loudest rectangle here can
 * be the sign-up without ever reading as a warning about a position.
 *
 * The mark sits on a white plate rather than a black one. A black box on
 * cobalt would need a white offset shadow to be seen, and there is no white
 * shadow in the system; the white plate with the black edge and the black
 * shadow is the same mark box the nav and the footer carry, at no cost.
 */
export function CtaBand({ cta }: { cta: WaitlistCta }) {
  return (
    <section className="bg-brand">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-6 py-16 md:flex-row md:items-center md:px-16 lg:py-24">
        <div className="flex items-center gap-6">
          <MarkPlate />
          <h2 className="text-2xl font-black uppercase tracking-tight text-white md:text-4xl">
            Know before it happens
          </h2>
        </div>
        <Button variant="secondary" onClick={cta.onClick} disabled={cta.disabled}>
          {cta.label}
        </Button>
      </div>
    </section>
  );
}
