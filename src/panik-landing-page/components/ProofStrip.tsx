/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Card } from "../../panik-core/ui";

/**
 * Three figures the product will be able to stand behind, and they are NOT
 * filled in yet.
 *
 * The bracketed placeholders are the point. The page this replaces printed
 * "94% recall" and a five-digit position count next to a chart, and nothing in
 * the codebase produced either number: they were typed into a component. A
 * bracket is a number that is visibly missing, which is a thing a reviewer can
 * catch; a plausible figure is not. They stay bracketed until the backtest
 * report is published and the count comes from the engine rather than from a
 * constant in this file.
 */
const FIGURES = [
  { label: "Lending markets covered on Base", value: "[PROTOCOLS]" },
  { label: "Wallet positions run through the engine", value: "[POSITIONS SCORED]" },
  { label: "Past liquidations flagged in testing", value: "[BACKTEST RECALL]" },
];

export function ProofStrip() {
  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-12 md:px-16">
      <div className="grid gap-6 md:grid-cols-3">
        {FIGURES.map((figure) => (
          <Card key={figure.label} tone="raised" className="flex flex-col justify-between gap-2">
            <span className="label-type text-xs text-text-secondary">{figure.label}</span>
            <span className="font-mono text-2xl font-bold tracking-tight break-words text-text-primary">
              {figure.value}
            </span>
          </Card>
        ))}
      </div>
      <p className="font-mono text-xs text-text-secondary">
        Numbers land with the backtest report.
      </p>
    </section>
  );
}
