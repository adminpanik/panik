/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { Compass, Eye, Zap, ShieldCheck, ChevronRight } from "lucide-react";
import { motion, AnimatePresence, useScroll } from "motion/react";

export function HowItWorks() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"]
  });

  // Programmatic scroll-to-index handler
  const handleScrollToPhase = (index: number) => {
    if (!sectionRef.current) return;
    const rect = sectionRef.current.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    
    // Calculate the trigger scroll positions in our compact content section
    const totalHeight = rect.height - window.innerHeight;
    const phaseOffsets = [0.05, 0.5, 0.95]; // targets for each phase trigger
    
    const targetScrollY = rect.top + scrollTop + (totalHeight * phaseOffsets[index]);
    window.scrollTo({
      top: targetScrollY,
      behavior: "smooth"
    });
  };

  useEffect(() => {
    const unsubscribe = scrollYProgress.on("change", (latest) => {
      if (latest < 0.35) {
        setActiveIndex(0);
      } else if (latest < 0.70) {
        setActiveIndex(1);
      } else {
        setActiveIndex(2);
      }
    });
    return () => unsubscribe();
  }, [scrollYProgress]);

  useEffect(() => {
    const handleActivate = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && typeof customEvent.detail.index === "number") {
        setTimeout(() => {
          handleScrollToPhase(customEvent.detail.index);
        }, 100);
      }
    };
    window.addEventListener("panik-activate-product", handleActivate);
    return () => window.removeEventListener("panik-activate-product", handleActivate);
  }, []);

  const steps = [
    {
      step: "01",
      title: "COMPASS",
      subtitle: "CHOOSE POSITIONS THAT MATCH YOUR RISK APPETITE.",
      icon: <Compass className="w-5 h-5 text-panik-orange shrink-0" />,
      description: "Tell Panik your risk tolerance once. Get curated position recommendations scored against your profile, with worst-case scenarios simulated before you commit any capital."
    },
    {
      step: "02",
      title: "WATCH",
      subtitle: "YOUR POSITIONS MONITORED CONTINUOUSLY.",
      icon: <Eye className="w-5 h-5 text-panik-orange shrink-0" />,
      description: "Every open position is scored against your personal risk boundaries in real time. Alerts fire only when correlated risk factors move together, not every time a single metric crosses a threshold."
    },
    {
      step: "03",
      title: "ADVISOR",
      subtitle: "KNOW EXACTLY WHAT TO DO AND WHY.",
      icon: <Zap className="w-5 h-5 text-panik-orange shrink-0 animate-pulse" />,
      description: "When a position needs attention, Panik surfaces one specific recommendation with full reasoning, backed by live on-chain data."
    }
  ];

  return (
    <div 
      ref={sectionRef} 
      id="products" 
      className="relative h-[250vh] bg-[#09090B] w-full"
    >
      {/* Scope-contained Styles for Advanced Outer Outline Tracing and Fluid Liquid Numeric Fill */}
      <style>{`
        .card-outline-svg {
          stroke: transparent;
          stroke-width: 1.5px;
          stroke-dasharray: 100;
          stroke-dashoffset: 100;
          transition: stroke-dashoffset 1.4s cubic-bezier(0.25, 1, 0.2, 1), stroke 0.3s ease-out;
        }
        .group:hover .card-outline-svg {
          stroke: #F97316;
          stroke-dashoffset: 0;
          filter: drop-shadow(0 0 3px rgba(249, 115, 22, 0.4));
        }
      `}</style>

      {/* Absolute Ambient Glow in Section background */}
      <div className="absolute top-[30vh] left-1/4 w-[500px] h-[500px] bg-panik-orange/[0.02] rounded-full blur-3xl pointer-events-none z-0"></div>
      <div className="absolute bottom-[30vh] right-1/4 w-[500px] h-[500px] bg-red-500/[0.01] rounded-full blur-3xl pointer-events-none z-0"></div>

      {/* STICKY CONTAINER - Locks the screen inside viewport as user scrolls the height */}
      <div className="sticky top-0 h-screen w-full flex flex-col justify-center overflow-hidden py-16 px-6 z-10">
        
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-12 select-none shrink-0 border-b border-white/[0.03] pb-6">
          <h2 className="font-display font-medium text-3xl sm:text-4xl tracking-tight text-[#F8FAFC] mt-4 mb-3 leading-tight">
            From entry to exit. <br />
            <span className="text-panik-text-secondary font-semibold">Every step covered.</span>
          </h2>
        </div>

        {/* 3 Step Interactive Horizontal Morphing Cards Carousel Grid */}
        <div className="max-w-6xl mx-auto w-full flex items-stretch gap-4 md:gap-6 h-[460px] relative">
          
          {steps.map((item, idx) => {
            const isActive = activeIndex === idx;
            
            return (
              <motion.div
                key={idx}
                onClick={() => {
                  if (!isActive) handleScrollToPhase(idx);
                }}
                className={`relative rounded-2xl border flex flex-col justify-between p-6 md:p-8 transition-all duration-500 overflow-hidden ${
                  isActive 
                    ? "flex-[3] sm:flex-[3.5] bg-[#0C0E14] border-white/[0.12] hover:border-panik-orange/55 shadow-2xl hover:shadow-[0_0_25px_rgba(249,115,22,0.12)] brightness-100 cursor-default" 
                    : "panik-glass flex-[0.5] sm:flex-[0.38] bg-[#0A0C11]/50 hover:bg-[#0E1119]/80 border-white/[0.04] hover:border-panik-orange/25 opacity-40 hover:opacity-75 cursor-pointer select-none"
                }`}
                animate={{
                  flexGrow: isActive ? 3.5 : 0.4
                }}
                transition={{
                  type: "spring",
                  stiffness: 170,
                  damping: 26
                }}
              >
                {/* Custom Card Outline Glow Effect Originating from Top and Encompassing borders */}
                <div className="absolute inset-0 rounded-2xl pointer-events-none overflow-hidden z-30">
                  <svg className="absolute inset-0 w-full h-full" fill="none">
                    <rect
                      x="0.5"
                      y="0.5"
                      width="calc(100% - 1px)"
                      height="calc(100% - 1px)"
                      rx="15"
                      ry="15"
                      className="card-outline-svg"
                      vectorEffect="non-scaling-stroke"
                      pathLength="100"
                    />
                  </svg>
                </div>

                {/* Horizontal active indicator bar */}
                <div 
                  className={`absolute top-0 left-6 right-6 h-[1.5px] transition-all duration-500 bg-gradient-to-r from-transparent via-panik-orange to-transparent ${
                    isActive ? "opacity-100 scale-x-100" : "opacity-0 scale-x-50 group-hover:opacity-100 group-hover:scale-x-100"
                  }`}
                />

                {/* --- CASE A: CARD IS ACTIVE (Normal expanded contents displayed beautifully) --- */}
                {isActive && (
                  <motion.div 
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22, delay: 0.05, ease: "easeOut" }}
                    className="flex flex-col justify-between h-full w-full"
                  >
                    <div>
                      {/* Brand Label Header inside Active view */}
                      <div className="flex justify-between items-center mb-8">
                        <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-white/[0.03] border border-white/[0.08] shadow-inner">
                          {item.icon}
                        </div>
                        
                        {/* Dynamic Step Fill Effect */}
                        <div className="relative select-none pr-1">
                          {/* Base low-opacity background number */}
                          <span className="font-mono text-4xl sm:text-5xl font-extrabold text-white/[0.05] select-none tracking-tighter block transition-colors duration-500 group-hover:text-white/[0.09]">
                            {item.step}
                          </span>
                          {/* Low opacity orange overlay container that fills from bottom up on card hover */}
                          <div className="absolute inset-x-0 bottom-0 top-0 h-0 group-hover:h-full transition-all duration-[1600ms] ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden pointer-events-none select-none flex items-end">
                            <span className="font-mono text-4xl sm:text-5xl font-extrabold text-[#F97316]/55 select-none tracking-tighter block leading-none select-none pb-[2px]">
                              {item.step}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Header values */}
                      <h3 className="font-display font-medium text-2xl text-white tracking-tight">
                        {item.title}
                      </h3>
                      
                      <p className="font-mono text-[10px] text-panik-orange mt-1.5 uppercase tracking-wider font-semibold">
                        {item.subtitle}
                      </p>

                      {/* Paragraph text */}
                      <p className="text-panik-text-secondary text-xs sm:text-sm leading-relaxed mt-5 max-w-xl">
                        {item.description}
                      </p>
                    </div>

                    {/* Active Section Footer */}
                    <div className="mt-8 pt-4.5 border-t border-white/[0.04] flex items-center justify-end text-[10px] font-mono text-panik-text-secondary">
                      {activeIndex < 2 && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleScrollToPhase(idx + 1);
                          }}
                          className="flex items-center gap-1 text-panik-orange hover:text-orange-400 font-bold uppercase tracking-wider transition-colors"
                        >
                          <span>Next Module</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* --- CASE B: CARD IS INACTIVE & SHRUNK (Sleek vertical index tabs) --- */}
                {!isActive && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col items-center justify-between h-full py-2 w-full text-center"
                  >
                    {/* Big Mono step index at top */}
                    <span className="font-mono text-xs font-extrabold text-panik-orange/65 font-bold tracking-widest block bg-white/[0.02] border border-white/[0.08] px-1.5 py-0.5 rounded">
                      {item.step}
                    </span>

                    {/* Centered micro-logo indicator */}
                    <div className="opacity-45 hover:opacity-75 transition-opacity my-3">
                      {React.cloneElement(item.icon, { className: "w-4.5 h-4.5 text-panik-orange/70" })}
                    </div>

                    {/* Sideways Vertical cybernetic Title block */}
                    <div className="flex-1 flex items-center justify-center py-4">
                      <span 
                        className="block font-display font-extrabold text-xs tracking-[0.25em] text-[#F0F4FF]/30 select-none uppercase"
                        style={{ writingMode: "vertical-rl" }}
                      >
                        {item.title}
                      </span>
                    </div>

                    {/* Bottom visual dots spacer */}
                    <div className="w-1.5 h-1.5 rounded-full bg-white/[0.08] mx-auto mt-4" />
                  </motion.div>
                )}

              </motion.div>
            );
          })}

        </div>

        {/* Phase Indicator Pips at the absolute bottom of viewport */}
        <div className="flex items-center justify-center gap-3.5 mt-8 shrink-0 select-none">
          {steps.map((_, idx) => (
            <button
              key={idx}
              onClick={() => handleScrollToPhase(idx)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                activeIndex === idx 
                  ? "w-8 bg-panik-orange" 
                  : "w-2 bg-white/10 hover:bg-white/20"
              }`}
              title={`Jump to Phase ${idx + 1}`}
            />
          ))}
        </div>

      </div>
    </div>
  );
}
