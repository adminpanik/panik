/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { ShieldAlert, BookOpen, Twitter, Github, Globe } from "lucide-react";
import { PanikLogoMark } from "./PanikLogo";

interface FooterProps {
  onScrollTo: (sectionId: string) => void;
}

export function Footer({ onScrollTo }: FooterProps) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-[#0A0A0B] border-t border-white/[0.05] py-16 px-6 relative overflow-hidden">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8 relative z-10">
        
        {/* Left footer: logo and subtitle */}
        <div className="flex flex-col items-center md:items-start text-center md:text-left">
          <div 
            onClick={() => onScrollTo("hero")}
            className="flex items-center gap-2.5 cursor-pointer group mb-3"
            id="footer-brand-container"
          >
            <PanikLogoMark size={24} />
            <span className="font-display font-bold text-lg tracking-wider text-[#F0F4FF] group-hover:text-white transition-colors">
              PANIK
            </span>
          </div>
          <p className="text-xs text-panik-text-secondary font-mono max-w-sm leading-relaxed">
            DeFi risk intelligence layer. Your positions, protected against systemic liquidation vectors.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-8 text-[11px] font-mono tracking-wider text-panik-text-secondary">
          <button 
            type="button"
            onClick={() => onScrollTo("scoring")} 
            className="hover:text-white uppercase transition-colors py-1 cursor-pointer"
          >
            How It Works
          </button>
          <button 
            type="button"
            onClick={() => onScrollTo("products")} 
            className="hover:text-white uppercase transition-colors py-1 cursor-pointer"
          >
            Products
          </button>
          <button 
            type="button"
            onClick={() => onScrollTo("backtest")} 
            className="hover:text-white uppercase transition-colors py-1 cursor-pointer"
          >
            Performance
          </button>
          <button
            type="button"
            onClick={() => onScrollTo("faq")} 
            className="hover:text-white uppercase transition-colors py-1 cursor-pointer"
          >
            FAQ
          </button>
          <span className="text-white/10 hidden sm:inline">•</span>
          <span className="flex items-center gap-1.5 text-panik-orange bg-panik-orange/10 border border-panik-orange/20 px-2.5 py-0.5 rounded text-[9px] font-bold">
            BUILT ON BASE
          </span>
        </div>

        {/* Right footer: socials */}
        <div className="flex items-center gap-4">
          <a
            href="https://x.com/panik_fi"
            target="_blank"
            rel="noreferrer noopener"
            className="w-8 h-8 rounded-lg bg-white/[0.01] border border-white/[0.06] flex items-center justify-center hover:border-panik-orange hover:text-panik-orange transition-colors"
            aria-label="Twitter / X Profile"
          >
            <Twitter className="w-4 h-4" />
          </a>
        </div>

      </div>

      {/* Disclaimers & Copyright bar */}
      <div className="max-w-7xl mx-auto mt-12 pt-6 border-t border-white/[0.03] flex flex-col sm:flex-row justify-between items-center gap-4 text-[10px] font-mono text-panik-text-secondary">
        <div>
          © {currentYear} PANIK Intelligence. All rights reserved.
        </div>
        <div className="text-center sm:text-right max-w-lg leading-normal">
          DISCLAIMER: PANIK is a non-custodial risk intelligence telemetry provider. All analytics, simulations, and recommendation outputs are for informational and educational purposes only, and do not constitute financial, legal, or investment advice. Smart contract interactions and capital locked in decentralized protocols carry inherent risks, including code vulnerabilities and liquidation.
        </div>
      </div>
    </footer>
  );
}
