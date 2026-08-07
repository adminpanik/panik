/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { ShieldAlert, Crosshair, ChevronDown, ChevronRight, Compass, Eye, Zap, Shield, Menu, X } from "lucide-react";
import { PanikLogoMark } from "./PanikLogo";

interface NavigationProps {
  onScrollTo: (sectionId: string) => void;
  subscriberCount: number;
  onOpenWaitlistModal: () => void;
  hasSubscribed?: boolean;
}

export function Navigation({ onScrollTo, subscriberCount, onOpenWaitlistModal, hasSubscribed = false }: NavigationProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileMenuOpen]);

  const handleMobileNav = useCallback((sectionId: string) => {
    onScrollTo(sectionId);
    setMobileMenuOpen(false);
  }, [onScrollTo]);

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 h-20 bg-surface-base/80 backdrop-blur-xl border-b border-border-subtle transition-all duration-300">
        <div className="max-w-7xl mx-auto h-full px-6 flex items-center justify-between">
          
          {/* Logo Brand */}
          <div 
            onClick={() => onScrollTo("hero")} 
            className="flex items-center gap-3 cursor-pointer group"
            id="nav-logo-container"
          >
            <PanikLogoMark size={32} />
            <span className="font-display font-medium text-lg tracking-[0.1em] text-text-primary group-hover:text-text-primary transition-colors uppercase">
              PANIK
            </span>
          </div>

          {/* Center Links (Desktop) */}
          <div className="hidden md:flex items-center gap-7 text-2xs font-mono tracking-wider text-text-secondary select-none">
            
            {/* Products Dropdown (Aave style) */}
            <div className="relative group py-5">
              <button 
                onClick={() => onScrollTo("products")}
                className="flex items-center gap-1.5 hover:text-text-primary transition-colors cursor-pointer uppercase font-medium"
              >
                <span>Products</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60 group-hover:rotate-180 transition-transform duration-300" />
              </button>
              
              {/* Dropdown Panel */}
              <div className="absolute top-full left-1/2 -translate-x-1/2 w-80 bg-surface-raised border border-border-subtle rounded-md p-4.5 shadow-2xl opacity-0 translate-y-2 pointer-events-none group-hover:opacity-100 group-hover:translate-y-0 group-hover:pointer-events-auto transition-all duration-300 z-50 backdrop-blur-xl">
                <span className="block text-2xs font-mono text-text-muted tracking-widest uppercase mb-3">PANIK SUITE</span>
                <div className="space-y-4">
                  <div 
                    className="group/item cursor-pointer" 
                    onClick={() => {
                      onScrollTo("products");
                      window.dispatchEvent(new CustomEvent("panik-activate-product", { detail: { index: 0 } }));
                    }}
                  >
                    <div className="flex items-center gap-2 text-text-primary font-sans text-xs font-semibold group-hover/item:text-panik-orange transition-colors">
                      <Compass className="w-3.5 h-3.5 text-panik-orange" />
                      <span>Compass</span>
                    </div>
                    <span className="block text-2xs text-text-secondary mt-0.5 font-sans leading-normal">Surfaces calibrated risk profiles before you commit capital.</span>
                  </div>
                  
                  <div 
                    className="group/item cursor-pointer" 
                    onClick={() => {
                      onScrollTo("products");
                      window.dispatchEvent(new CustomEvent("panik-activate-product", { detail: { index: 1 } }));
                    }}
                  >
                    <div className="flex items-center gap-2 text-text-primary font-sans text-xs font-semibold group-hover/item:text-panik-orange transition-colors">
                      <Eye className="w-3.5 h-3.5 text-panik-orange" />
                      <span>Watch</span>
                    </div>
                    <span className="block text-2xs text-text-secondary mt-0.5 font-sans leading-normal">Continuous 60-second auditing on live collateral pools.</span>
                  </div>

                  <div 
                    className="group/item cursor-pointer" 
                    onClick={() => {
                      onScrollTo("products");
                      window.dispatchEvent(new CustomEvent("panik-activate-product", { detail: { index: 2 } }));
                    }}
                  >
                    <div className="flex items-center gap-2 text-text-primary font-sans text-xs font-semibold group-hover/item:text-panik-orange transition-colors">
                      <Zap className="w-3.5 h-3.5 text-panik-orange" />
                      <span>Advisor</span>
                    </div>
                    <span className="block text-2xs text-text-secondary mt-0.5 font-sans leading-normal">Plain-language recommendations with precise transaction costs.</span>
                  </div>
                </div>
              </div>
            </div>

            <span className="text-white/5 select-none">•</span>
            
            <button 
              onClick={() => onScrollTo("scoring")} 
              className="hover:text-text-primary transition-colors cursor-pointer uppercase font-medium"
              id="btn-nav-how-it-works"
            >
              How it works
            </button>
            
            <span className="text-white/5 select-none">•</span>

            <button 
              onClick={() => onScrollTo("backtest")} 
              className="hover:text-text-primary transition-colors cursor-pointer uppercase font-medium"
              id="btn-nav-backtest"
            >
              Performance
            </button>
            
            <span className="text-white/5 select-none">•</span>

            <button
              onClick={() => onScrollTo("faq")}
              className="hover:text-text-primary transition-colors cursor-pointer uppercase font-medium"
              id="btn-nav-faq"
            >
              FAQ
            </button>
          </div>

          {/* Right Area (Desktop) — persistent CTA */}
          <div className="hidden md:flex items-center gap-4">
            {!hasSubscribed && (
              <button
                type="button"
                onClick={onOpenWaitlistModal}
                className="h-9 px-5 bg-panik-orange hover:bg-panik-orange/90 text-surface-base font-mono text-2xs uppercase tracking-wider font-semibold rounded-md flex items-center gap-2 transition-all duration-300 cursor-pointer shadow-md shadow-panik-orange/20"
              >
                JOIN WAITLIST →
              </button>
            )}
          </div>

          {/* Hamburger Menu (Mobile/Tablet Toggle) */}
          <button 
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)} 
            className="md:hidden p-2 text-text-secondary hover:text-text-primary transition-colors"
            id="btn-mobile-menu-toggle"
            aria-label="Toggle Menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

        </div>
      </nav>

      {/* Mobile/Tablet Drawer — Backdrop + Slide-in Panel */}
      <div 
        className={`fixed inset-0 top-20 z-45 md:hidden transition-opacity duration-300 ${
          mobileMenuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Dimming backdrop — click to close */}
        <div 
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation menu"
        />

        {/* Slide-in drawer panel */}
        <div 
          ref={drawerRef}
          className={`absolute top-0 right-0 h-full w-full max-w-[340px] bg-surface-base/95 backdrop-blur-xl border-l border-border-subtle shadow-2xl transform transition-transform duration-300 ease-out ${
            mobileMenuOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex flex-col h-full p-8 pt-10">
            {/* Navigation Links */}
            <div className="space-y-2 flex-1">
              
              {/* CTA — visually distinct */}
              {!hasSubscribed && (
                <button
                  type="button"
                  onClick={() => { onOpenWaitlistModal(); setMobileMenuOpen(false); }}
                  className="w-full h-14 bg-panik-orange hover:bg-panik-orange/90 text-surface-base font-mono text-xs uppercase tracking-wider font-bold rounded-md flex items-center justify-center gap-2.5 transition-all duration-300 cursor-pointer shadow-lg shadow-panik-orange/20 mb-6"
                >
                  JOIN WAITLIST →
                </button>
              )}

              <button 
                onClick={() => handleMobileNav("products")}
                className="block w-full text-left py-4 px-4 rounded-md text-sm font-mono text-text-primary hover:text-panik-orange hover:bg-white/[0.03] transition-all duration-200"
              >
                <span className="text-panik-orange/50 text-xs mr-3">01</span>
                PRODUCTS
              </button>

              <button 
                onClick={() => handleMobileNav("scoring")}
                className="block w-full text-left py-4 px-4 rounded-md text-sm font-mono text-text-primary hover:text-panik-orange hover:bg-white/[0.03] transition-all duration-200"
              >
                <span className="text-panik-orange/50 text-xs mr-3">02</span>
                HOW IT WORKS
              </button>

              <button 
                onClick={() => handleMobileNav("backtest")}
                className="block w-full text-left py-4 px-4 rounded-md text-sm font-mono text-text-primary hover:text-panik-orange hover:bg-white/[0.03] transition-all duration-200"
              >
                <span className="text-panik-orange/50 text-xs mr-3">03</span>
                PERFORMANCE
              </button>

              <button
                onClick={() => handleMobileNav("faq")}
                className="block w-full text-left py-4 px-4 rounded-md text-sm font-mono text-text-primary hover:text-panik-orange hover:bg-white/[0.03] transition-all duration-200"
              >
                <span className="text-panik-orange/50 text-xs mr-3">04</span>
                FREQUENTLY ASKED QUESTIONS
              </button>
            </div>

            {/* Footer accent in drawer */}
            <div className="pt-6 border-t border-border-subtle">
              <span className="flex items-center gap-1.5 text-panik-orange bg-panik-orange/10 border border-panik-orange/20 px-2.5 py-1 rounded-sm text-2xs font-mono font-bold w-fit">
                BUILT ON BASE
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
