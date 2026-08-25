/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { SectionHeading } from "./SectionHeading";

/**
 * Three steps, and each one is something the reader does rather than something
 * the system does. The protocol names are the three the engine actually reads
 * on Base; if a fourth is added, this sentence is one of the places that has to
 * change, which is why it names them instead of saying "all major markets".
 */
const STEPS = [
  {
    title: "Paste an address",
    body: "Drop in any wallet address, or connect one if you prefer. PANIK reads its open borrows on Aave, Compound and Moonwell.",
  },
  {
    title: "Read the buffer",
    body: "Each position comes back with a risk band and a price buffer: how far the collateral can fall before the protocol steps in.",
  },
  {
    title: "Get the message",
    body: "Link Telegram once and pick the buffer you want to hear about. The message names the position, the price and the room left.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-16 md:px-16 lg:py-24">
      <SectionHeading eyebrow="How it works" title="Three steps, about a minute" />
      <ol className="grid gap-8 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-6">
            <div className="flex items-start gap-4">
              <span
                aria-hidden="true"
                className="flex size-12 shrink-0 items-center justify-center bg-text-primary font-mono text-lg font-bold text-white"
              >
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="text-lg font-extrabold tracking-tight text-text-primary">
                  {step.title}
                </h3>
                <p className="text-base text-text-secondary">{step.body}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
