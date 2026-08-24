/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { ScrollReveal } from "./ScrollReveal";

const METRICS = [
  {
    label: "VALIDATION",
    value: "4 Crashes",
    valueClass: "text-text-primary",
    description: "Tested across major market contractions.",
  },
  {
    label: "DATA SCOPE",
    value: "6.8K+ Wallets",
    valueClass: "text-text-primary",
    description: "Reconstructed block-by-block via archive RPC.",
  },
  {
    label: "CORE RECALL",
    value: "92% Recall",
    valueClass: "text-panik-orange/90",
    description: "Flagged critical before failure, across two crises the thresholds were never tuned on.",
  },
  {
    label: "WARNING WINDOW",
    value: "44h Lead Time",
    valueClass: "text-panik-orange/90",
    description: "Median warning window, offering 2.6x more time to act.",
  },
];

export function BacktestResults() {
  return (
    <section id="backtest" className="relative py-28 px-6 bg-surface-base border-t border-border-subtle">
      <div className="max-w-6xl mx-auto">

        {/* Section Header */}
        <ScrollReveal duration={0.6}>
          <div className="max-w-2xl mb-16">
            <span className="text-2xs font-mono tracking-widest text-panik-orange uppercase font-medium">
              PERFORMANCE
            </span>
            <h2 className="font-sans font-extrabold text-4xl tracking-tight leading-tight text-text-primary mt-3 mb-4">
              Historical Performance
            </h2>
            <p className="text-text-secondary text-sm sm:text-base leading-relaxed">
              We validated the Panik Risk Scoring Engine against historical liquidations across thousands of active wallets. In major market contractions, the engine consistently identifies risk hours before position failure.
            </p>
          </div>
        </ScrollReveal>

        {/* Metric Columns */}
        <ScrollReveal duration={0.65} delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border-subtle mb-16">
            {METRICS.map((m) => (
              <div key={m.label} className="px-0 sm:px-8 py-8 sm:py-0 first:pl-0 last:pr-0">
                <p className="text-2xs font-mono tracking-widest text-text-muted uppercase mb-3">
                  {m.label}
                </p>
                <p className={`font-mono font-black text-2xl leading-none mb-3 ${m.valueClass}`}>
                  {m.value}
                </p>
                <p className="text-text-secondary text-xs leading-relaxed font-sans">
                  {m.description}
                </p>
              </div>
            ))}
          </div>
        </ScrollReveal>

        {/* Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">

          {/* Baseline Comparison Table */}
          <div className="lg:col-span-7">
            <ScrollReveal duration={0.7} delay={0.15}>
              <h3 className="font-sans font-semibold text-base text-text-primary mb-1">Baseline vs. Panik Engine</h3>
              <p className="text-text-secondary text-xs mb-6 leading-relaxed">
                Static liquidation proximity floors compared to the volume-gated escalation model.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-sans">
                  <thead>
                    <tr className="border-b border-border-subtle text-text-muted font-mono text-2xs uppercase tracking-wider">
                      <th className="pb-3 font-medium">Metric</th>
                      <th className="pb-3 text-center font-medium">Static Floors</th>
                      <th className="pb-3 text-right font-medium text-panik-orange">Panik Engine</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle text-text-primary">
                    <tr>
                      <td className="py-3.5 font-medium">Critical warning lead time (Median)</td>
                      <td className="py-3.5 text-center text-text-secondary">17 hours</td>
                      <td className="py-3.5 text-right font-bold text-panik-orange">44 hours</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">$40M whale warning lead time</td>
                      <td className="py-3.5 text-center text-text-secondary">17 hours</td>
                      <td className="py-3.5 text-right font-bold text-panik-orange">44 hours</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">Median health factor at alert trigger</td>
                      <td className="py-3.5 text-center text-text-secondary">1.09</td>
                      <td className="py-3.5 text-right font-bold text-text-primary">1.22</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">Doomed positions flagged (June 2022)</td>
                      <td className="py-3.5 text-center text-text-secondary">49%</td>
                      <td className="py-3.5 text-right font-bold text-risk-low">88%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </ScrollReveal>
          </div>

          {/* Event Coverage Table */}
          <div className="lg:col-span-5">
            <ScrollReveal duration={0.7} delay={0.2}>
              <h3 className="font-sans font-semibold text-base text-text-primary mb-1">Event Coverage</h3>
              <p className="text-text-secondary text-xs mb-6 leading-relaxed">
                Recall rates across distinct volatility regimes.
              </p>
              <table className="w-full text-left text-xs font-sans">
                <thead>
                  <tr className="border-b border-border-subtle text-text-muted font-mono text-2xs uppercase tracking-wider">
                    <th className="pb-3 font-medium">Event</th>
                    <th className="pb-3 text-right font-medium">Recall</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  <tr>
                    <td className="py-3.5">
                      <p className="text-text-primary font-medium">June 2022 (ETH/stETH)</p>
                      <p className="text-text-muted text-2xs mt-0.5">Asset-led cascade. Thresholds were calibrated here.</p>
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-risk-low">88%</td>
                  </tr>
                  <tr>
                    <td className="py-3.5">
                      <p className="text-text-primary font-medium">UST/LUNA Depeg (May 2022)</p>
                      <p className="text-text-muted text-2xs mt-0.5">Algorithm run &amp; depeg. No threshold fitted here.</p>
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-risk-low">94%</td>
                  </tr>
                  <tr>
                    <td className="py-3.5">
                      <p className="text-text-primary font-medium">USDC Depeg (Mar 2023)</p>
                      <p className="text-text-muted text-2xs mt-0.5">Frictional peg deviation. Held out.</p>
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-risk-low">97%</td>
                  </tr>
                  <tr>
                    <td className="py-3.5">
                      <p className="text-text-primary font-medium">Aug 2024 Unwind (Base)</p>
                      <p className="text-text-muted text-2xs mt-0.5">Carry-trade unwind. Held out.</p>
                    </td>
                    <td className="py-3.5 text-right font-mono font-bold text-risk-low">92%</td>
                  </tr>
                  <tr>
                    <td className="py-3.5">
                      <p className="text-text-primary font-medium">FTX Collapse (Nov 2022)</p>
                      <p className="text-text-muted text-2xs mt-0.5">Acute solvency shock. Awaiting re-measurement.</p>
                    </td>
                    <td className="py-3.5 text-right font-mono text-text-muted">Not re-measured</td>
                  </tr>
                </tbody>
              </table>
            </ScrollReveal>
          </div>

        </div>

        {/* Footnote */}
        <ScrollReveal duration={0.6} delay={0.25}>
          <p className="mt-12 pt-6 border-t border-border-subtle text-2xs text-text-muted font-sans leading-relaxed max-w-2xl">
            A 26% false-alarm rate is expected and accepted. To achieve early warnings, the engine flags positions that ultimately recover through repayment or market stabilization. Earlier warnings require broader capture, and this tradeoff is intentional and disclosed. Recall and false-alarm figures are measured on the two held-out crises (1,494 liquidated and 491 surviving borrowers), not on the event the thresholds were calibrated against.
          </p>
        </ScrollReveal>

      </div>
    </section>
  );
}
