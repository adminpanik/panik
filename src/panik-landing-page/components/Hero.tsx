/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { ScrollReveal } from "./ScrollReveal";

interface HeroProps {
  subscriberCount: number;
  hasSubscribed: boolean;
  onLaunchMockup: () => void;
  onOpenWaitlistModal: (initialEmail?: string) => void;
}

export function Hero({ subscriberCount, hasSubscribed, onLaunchMockup, onOpenWaitlistModal }: HeroProps) {
  const sectionRef = useRef<HTMLDivElement>(null);

  // Track the scroll position of the Hero section as it scrolls up
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });

  // Map the scroll progress to shrinking size overlay and fading opacity
  const textScale = useTransform(scrollYProgress, [0, 0.35], [1.0, 0.45]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.3], [1.0, 0]);

  return (
    <section 
      ref={sectionRef}
      id="hero" 
      className="relative min-h-[95vh] pt-24 pb-20 px-6 flex flex-col justify-center items-center bg-transparent z-10"
    >
      {/* Absolute Decorative Grid Elements */}
      <div className="absolute inset-0 panik-dot-bg opacity-30 pointer-events-none"></div>
      
      {/* Dynamic Grid Overlay lines */}
      <div className="absolute top-0 left-0 w-full h-full bg-cover opacity-15 pointer-events-none panik-grid-bg"></div>

      <div className="max-w-4xl mx-auto w-full flex flex-col items-center text-center relative z-20 pt-8 pointer-events-none" id="hero-content-wrapper">
        
        {/* Main centered text blocks - mouse events pass through to interactive globe */}
        <ScrollReveal className="flex flex-col items-center w-full pointer-events-none" id="hero-pitch-container" duration={0.6} yOffset={15} once={true}>
          
          {/* Scroll Animate Container wrapping only the typography to let it shrink/fade into background */}
          <motion.div 
            style={{ scale: textScale, opacity: textOpacity }}
            className="flex flex-col items-center pointer-events-none w-full"
          >
            {/* Heading - centered display style */}
            <h1 className="font-display font-medium text-4xl md:text-display tracking-tight leading-[1.05] text-text-primary max-w-3xl mb-6 select-none">
              Institutional-grade risk intelligence. Built for your <span className="text-panik-orange font-semibold">DeFi positions.</span>
            </h1>

            {/* Subheading - centered readable layout */}
            <p className="text-text-secondary font-sans text-sm sm:text-base leading-relaxed max-w-2xl mb-10 select-none">
              Panik scores your DeFi positions against your personal risk tolerance using the Panik Risk Scoring Engine. Know your risk before you enter. Act before it costs you.
            </p>
          </motion.div>

          {/* Centered Swapped CTA Buttons kept outside of shrink-fade wrappers to remain visible */}
          <div className="w-full max-w-xl mt-6 mb-12 flex flex-col items-center pointer-events-auto relative z-30">
            <div className="flex flex-col sm:flex-row items-center gap-5 justify-center w-full px-4">
              
              <button
                type="button"
                onClick={() => {
                  const target = document.querySelector('#scoring');
                  if (target) {
                    const navHeight = 80;
                    const elementPosition = target.getBoundingClientRect().top + window.scrollY;
                    window.scrollTo({ top: elementPosition - navHeight, behavior: 'smooth' });
                  }
                }}
                className="w-full sm:w-auto h-13 px-7 bg-transparent border border-border-subtle hover:border-border-strong hover:bg-white/[0.04] text-text-primary font-mono text-xs uppercase tracking-wider rounded-md transition-all duration-300 cursor-pointer pointer-events-auto active:scale-[0.98]"
              >
                <span>HOW IT WORKS</span>
              </button>

              {!hasSubscribed && (
                <a
                  href="/try"
                  className="w-full sm:w-auto h-13 px-9 bg-panik-orange hover:bg-panik-orange/95 text-surface-base font-mono text-xs uppercase tracking-widest font-extrabold rounded-md flex items-center justify-center gap-2.5 cursor-pointer transition-all duration-300 transform hover:scale-[1.03] active:scale-[0.98] pointer-events-auto shadow-lg shadow-panik-orange/20 panik-glow-orange shrink-0 no-underline"
                  id="hero-btn-try-now"
                >
                  <span>TRY IT NOW →</span>
                </a>
              )}

            </div>
          </div>

        </ScrollReveal>

      </div>
    </section>
  );
}
