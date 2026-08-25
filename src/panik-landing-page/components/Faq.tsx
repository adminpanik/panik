/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

/**
 * Four questions a reader asks before signing up, and the answers stay inside
 * what the product can currently do.
 *
 * The last one refuses to name a number on purpose. The warning arrives when
 * the buffer the reader chose is crossed, so "two minutes" is a property of
 * how fast the market moved that day, not a promise this page is in a position
 * to make. The hero's Telegram badge illustrates one alert; this answers what
 * the reader would actually be signing up for.
 */
const FAQS = [
  {
    id: "wallet",
    question: "Do I have to connect a wallet?",
    answer:
      "No. Paste any public address and PANIK reads the borrows open against it. Connecting a wallet only saves you the paste, and nothing in the product asks you to sign a transaction.",
  },
  {
    id: "markets",
    question: "Which lending markets do you read?",
    answer:
      "Aave, Compound and Moonwell on Base. A position we cannot price is reported as unknown rather than scored, so a market going quiet never comes back as a clean bill of health.",
  },
  {
    id: "custody",
    question: "Can PANIK move my funds or close a position?",
    answer:
      "No. PANIK holds no keys and has no permission over your collateral. It watches positions and sends warnings; repaying, topping up or closing stays with you.",
  },
  {
    id: "timing",
    question: "How early does the warning actually arrive?",
    answer:
      "You pick the price buffer that triggers a message, so the notice you get is the time it takes the collateral to cover that last stretch. A slow drift gives you hours and a sharp move gives you minutes, which is why the alert names the buffer it fired on.",
  },
];

/**
 * A real disclosure: one row open at a time, `aria-expanded` on the control,
 * and the panel simply mounted or not. No height animation, in a system that
 * has no transitions.
 */
export function Faq() {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section
      id="faq"
      className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-12 md:flex-row md:gap-12 md:px-16 md:py-16"
    >
      <div className="md:w-80 md:shrink-0">
        <SectionHeading
          eyebrow="FAQ"
          title="Asked before signing up"
          note="Everything else lives in the docs."
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {FAQS.map((faq) => {
          const isOpen = openId === faq.id;
          return (
            <div key={faq.id} className="hard-edge bg-surface-raised shadow-hard">
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${faq.id}`}
                  id={`faq-control-${faq.id}`}
                  onClick={() => setOpenId(isOpen ? null : faq.id)}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3 text-left text-base font-bold text-text-primary"
                >
                  <span>{faq.question}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-5 shrink-0 ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
              </h3>
              {isOpen ? (
                <div
                  id={`faq-panel-${faq.id}`}
                  role="region"
                  aria-labelledby={`faq-control-${faq.id}`}
                  className="px-4 pb-4"
                >
                  <div aria-hidden="true" className="mb-4 h-px w-full bg-border-subtle" />
                  <p className="text-base text-text-secondary">{faq.answer}</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
