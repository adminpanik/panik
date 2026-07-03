/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { ScrollReveal } from "./ScrollReveal";
import { Clock, AlertTriangle, ShieldCheck, Database, HelpCircle, Flame, ArrowRight, Eye } from "lucide-react";

export function BacktestResults() {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  // Tooltip content definitions
  const tooltipContent: Record<string, { title: string; text: string }> = {
    recall: {
      title: "Pooled Recall",
      text: "The percentage of liquidated wallets that crossed the warning threshold before their liquidation event, indicating successful risk mitigation.",
    },
    falseAlarm: {
      title: "False-Alarm Rate",
      text: "Wallets that triggered temporary high-stress warning states but safely avoided liquidation through user intervention, repayments, or market recoveries.",
    },
  };

  return (
    <section id="backtest" className="relative py-28 px-6 bg-[#09090B] overflow-hidden border-t border-white/[0.04]">
      {/* Background soft lighting grid */}
      <div className="absolute top-1/2 left-1/4 -translate-y-1/2 w-[550px] h-[550px] bg-gradient-to-tr from-panik-orange/[0.025] to-transparent rounded-full blur-3xl pointer-events-none"></div>

      <div className="max-w-6xl mx-auto relative z-10">
        
        {/* Section Header */}
        <ScrollReveal duration={0.6}>
          <div className="max-w-3xl mb-16 text-left">
            <span className="text-[10px] font-mono tracking-widest text-[#F97316] uppercase font-medium">
              HISTORICAL VALIDATION
            </span>
            <h2 className="font-sans font-extrabold text-4xl sm:text-5xl tracking-tight leading-tight text-[#F8FAFC] mt-3 mb-4">
              Empirical Risk Telemetry
            </h2>
            <p className="text-[#94A3B8] text-sm sm:text-base max-w-xl leading-relaxed">
              Performance measured against real historical liquidations. We backtested the Risk Scoring Engine on active consensus failures to verify alert calibration and warning windows.
            </p>
          </div>
        </ScrollReveal>

        {/* Narrative Flow Stats Section */}
        <ScrollReveal duration={0.65} delay={0.1}>
          <div className="relative flex flex-col lg:flex-row items-stretch justify-between gap-4 mb-16">
            
            {/* Step 1: Validated On */}
            <div className="flex-1 bg-[#111318]/40 border border-white/[0.05] rounded-xl p-6 flex flex-col justify-between text-left transition-all duration-300 hover:border-white/[0.1] hover:bg-[#111318]/60 relative group">
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.01] to-transparent pointer-events-none rounded-xl" />
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2 text-white/50">
                    <Flame className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-mono uppercase tracking-wider font-bold">01 // Validation Baseline</span>
                  </div>
                </div>
                <div className="text-[10.5px] font-mono text-[#475569] uppercase font-semibold mb-1">VALIDATED ON</div>
                <div className="text-3xl font-mono font-black text-white leading-none">4 Crashes</div>
              </div>
              <p className="text-[11px] text-[#94A3B8] mt-4 leading-relaxed font-sans">
                Tested on June 2022 cascade, UST depeg, FTX collapse, and USDC depeg.
              </p>
              
              {/* Connector Arrow (Desktop only) */}
              <div className="hidden lg:flex absolute top-1/2 -right-2.5 -translate-y-1/2 z-20 items-center justify-center bg-[#09090B] border border-white/[0.08] w-5 h-5 rounded-full text-white/20 group-hover:text-panik-orange transition-colors">
                <ArrowRight className="w-3 h-3" />
              </div>
            </div>

            {/* Step 2: Analyzed */}
            <div className="flex-1 bg-[#111318]/40 border border-white/[0.05] rounded-xl p-6 flex flex-col justify-between text-left transition-all duration-300 hover:border-white/[0.1] hover:bg-[#111318]/60 relative group">
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.01] to-transparent pointer-events-none rounded-xl" />
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2 text-white/50">
                    <Database className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-mono uppercase tracking-wider font-bold">02 // Data Scope</span>
                  </div>
                </div>
                <div className="text-[10.5px] font-mono text-[#475569] uppercase font-semibold mb-1">ANALYZED</div>
                <div className="text-3xl font-mono font-black text-white leading-none">6.8K+ Wallets</div>
              </div>
              <p className="text-[11px] text-[#94A3B8] mt-4 leading-relaxed font-sans">
                Unique positions evaluated historically block-by-block via archive RPC.
              </p>

              {/* Connector Arrow (Desktop only) */}
              <div className="hidden lg:flex absolute top-1/2 -right-2.5 -translate-y-1/2 z-20 items-center justify-center bg-[#09090B] border border-white/[0.08] w-5 h-5 rounded-full text-white/20 group-hover:text-panik-orange transition-colors">
                <ArrowRight className="w-3 h-3" />
              </div>
            </div>

            {/* Step 3: Achieved (CORE RESULT - Highlighted) */}
            <div className="flex-1 bg-gradient-to-b from-[#111318]/80 to-[#F97316]/[0.02] border border-panik-orange/30 rounded-xl p-6 flex flex-col justify-between text-left shadow-[0_0_20px_-5px_rgba(249,115,22,0.1)] relative group">
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2 text-panik-orange">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-mono uppercase tracking-wider font-bold">03 // Core Result</span>
                  </div>
                  {/* Tooltip trigger button */}
                  <button 
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveTooltip(activeTooltip === "recall" ? null : "recall");
                    }}
                    onMouseEnter={() => setActiveTooltip("recall")}
                    onMouseLeave={() => setActiveTooltip(null)}
                    className="w-4.5 h-4.5 rounded-full bg-white/[0.03] border border-white/[0.08] hover:border-panik-orange hover:text-panik-orange flex items-center justify-center text-white/40 cursor-pointer transition-colors relative"
                    aria-label="More info about Recall"
                  >
                    <HelpCircle className="w-2.5 h-2.5" />
                    
                    {/* Tooltip text box */}
                    {activeTooltip === "recall" && (
                      <div className="absolute bottom-full mb-2 right-1/2 translate-x-1/2 w-48 bg-[#111318] border border-white/[0.1] rounded-lg p-2.5 text-[10px] text-[#94A3B8] font-sans font-normal normal-case tracking-normal shadow-2xl leading-normal z-50 pointer-events-none text-left">
                        <strong className="block text-white mb-0.5">{tooltipContent.recall.title}</strong>
                        {tooltipContent.recall.text}
                      </div>
                    )}
                  </button>
                </div>
                <div className="text-[10.5px] font-mono text-panik-orange/80 uppercase font-semibold mb-1">ACHIEVED</div>
                <div className="text-3.5xl font-mono font-black text-white leading-none">89% Recall</div>
              </div>
              <p className="text-[11px] text-[#94A3B8] mt-4 leading-relaxed font-sans">
                Of doomed positions successfully flagged before their liquidation.
              </p>

              {/* Connector Arrow (Desktop only) */}
              <div className="hidden lg:flex absolute top-1/2 -right-2.5 -translate-y-1/2 z-20 items-center justify-center bg-[#09090B] border border-white/[0.08] w-5 h-5 rounded-full text-white/20 group-hover:text-panik-orange transition-colors">
                <ArrowRight className="w-3 h-3" />
              </div>
            </div>

            {/* Step 4: With (CORE RESULT - Highlighted) */}
            <div className="flex-1 bg-gradient-to-b from-[#111318]/80 to-[#F97316]/[0.02] border border-panik-orange/30 rounded-xl p-6 flex flex-col justify-between text-left shadow-[0_0_20px_-5px_rgba(249,115,22,0.1)] relative group">
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2 text-panik-orange">
                    <Clock className="w-3.5 h-3.5" />
                    <span className="text-[9px] font-mono uppercase tracking-wider font-bold">04 // Outcome</span>
                  </div>
                </div>
                <div className="text-[10.5px] font-mono text-panik-orange/80 uppercase font-semibold mb-1">WITH</div>
                <div className="text-3.5xl font-mono font-black text-white leading-none">44h Lead Time</div>
              </div>
              <p className="text-[11px] text-[#94A3B8] mt-4 leading-relaxed font-sans">
                Median warning window for healthy positions (2.6x increase over baseline).
              </p>
            </div>

          </div>
        </ScrollReveal>

        {/* Comparison and Multi-Event Detail Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Block: Table comparison */}
          <div className="lg:col-span-7">
            <ScrollReveal className="w-full bg-[#0A0C10] border border-white/[0.08] rounded-2xl p-6 shadow-2xl" duration={0.7} delay={0.15}>
              <h3 className="font-sans font-bold text-lg text-white mb-2 text-left">Algorithmic Baseline vs. Panik</h3>
              <p className="text-[#94A3B8] text-xs mb-6 text-left">
                Performance metrics comparing static liquidation proximities to our volume-gated escalation model.
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-sans">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-[#475569] font-mono text-[10px] uppercase tracking-wider">
                      <th className="pb-3 font-medium">Validation Metric</th>
                      <th className="pb-3 text-center font-medium">Static Floors (Baseline)</th>
                      <th className="pb-3 text-right font-medium text-panik-orange">Escalation Model (Shipped)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04] text-white/90">
                    <tr>
                      <td className="py-3.5 font-medium">Critical warning lead time (Median)</td>
                      <td className="py-3.5 text-center text-[#94A3B8]">17 Hours</td>
                      <td className="py-3.5 text-right font-bold text-panik-orange">44 Hours</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">$40M Whale warning lead time</td>
                      <td className="py-3.5 text-center text-[#94A3B8]">17 Hours</td>
                      <td className="py-3.5 text-right font-bold text-panik-orange">44 Hours</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">Median Health Factor at alert trigger</td>
                      <td className="py-3.5 text-center text-[#94A3B8]">1.09</td>
                      <td className="py-3.5 text-right font-bold">1.22</td>
                    </tr>
                    <tr>
                      <td className="py-3.5 font-medium">Doomed positions flagged before crash</td>
                      <td className="py-3.5 text-center text-[#94A3B8]">65%</td>
                      <td className="py-3.5 text-right font-bold text-[#10B981]">89%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </ScrollReveal>
          </div>

          {/* Right Block: Multi-event stats */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            <ScrollReveal className="w-full bg-[#0A0C10] border border-white/[0.08] rounded-2xl p-6 shadow-2xl" duration={0.7} delay={0.2}>
              <h3 className="font-sans font-bold text-lg text-white mb-2 text-left">Validation Event Coverage</h3>
              <p className="text-[#94A3B8] text-xs mb-6 text-left">
                Observed recall rates across distinct volatility regimes.
              </p>

              <div className="space-y-4">
                
                {/* Event 1 */}
                <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex justify-between items-center">
                  <div className="text-left font-mono">
                    <span className="block text-[11px] text-white font-bold">June 2022 (ETH/stETH)</span>
                    <span className="text-[9px] text-[#475569]">Asset-led liquidation cascade</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-sm font-mono font-bold text-[#10B981]">88% Recall</span>
                    <span className="text-[9px] text-[#94A3B8]">34% False-Alarm</span>
                  </div>
                </div>

                {/* Event 2 */}
                <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex justify-between items-center">
                  <div className="text-left font-mono">
                    <span className="block text-[11px] text-white font-bold">FTX Collapse (Nov 2022)</span>
                    <span className="text-[9px] text-[#475569]">Acute solvency shock</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-sm font-mono font-bold text-[#10B981]">53% Recall</span>
                    <span className="text-[9px] text-[#94A3B8]">27% False-Alarm</span>
                  </div>
                </div>

                {/* Event 3 */}
                <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex justify-between items-center">
                  <div className="text-left font-mono">
                    <span className="block text-[11px] text-white font-bold">UST/LUNA Depeg (May 2022)</span>
                    <span className="text-[9px] text-[#475569]">Algorithm run & depeg</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-sm font-mono font-bold text-[#10B981]">94% Recall</span>
                    <span className="text-[9px] text-[#94A3B8]">20% False-Alarm</span>
                  </div>
                </div>

                {/* Event 4 */}
                <div className="bg-white/[0.02] border border-white/[0.04] rounded-xl p-3 flex justify-between items-center">
                  <div className="text-left font-mono">
                    <span className="block text-[11px] text-white font-bold">USDC Depeg (Mar 2023)</span>
                    <span className="text-[9px] text-[#475569]">Frictional peg deviation</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-sm font-mono font-bold text-[#10B981]">97% Recall</span>
                    <span className="text-[9px] text-[#94A3B8]">41% False-Alarm</span>
                  </div>
                </div>

              </div>
            </ScrollReveal>
          </div>

        </div>

        {/* Honest read footnote */}
        <ScrollReveal duration={0.6} delay={0.25}>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8 max-w-2xl mx-auto border-t border-white/[0.03] pt-6 font-sans">
            <span className="text-[10px] font-mono text-[#F59E0B] bg-[#F59E0B]/10 border border-[#F59E0B]/20 px-2 py-0.5 rounded font-bold uppercase flex items-center gap-1 shrink-0">
              <AlertTriangle className="w-3 h-3 text-[#F59E0B]" />
              27% Pooled False-Alarm Rate
            </span>
            <p className="text-[11px] text-[#475569] text-center sm:text-left leading-relaxed">
              To achieve early triggers, warning telemetry captures active positions that ultimately ride out volatility (false alarm). This transparency is core to our risk intelligence values.
            </p>
          </div>
        </ScrollReveal>

      </div>
    </section>
  );
}
