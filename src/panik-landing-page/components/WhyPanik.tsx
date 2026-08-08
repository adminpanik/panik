/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ScrollReveal } from "./ScrollReveal";

interface TooltipInfo {
  title: string;
  status: string;
  details: string;
  colorClass: string;
}

const logTemplates = [
  { type: "[ERR]", text: "PASSIVE_STATE_ONLY – No execution relay linked. Cannot trigger emergency sa..." },
  { type: "[WARN]", text: "audit_sentry offline – coverage gap at depth 2" },
  { type: "[INFO]", text: "sentry_tracker OK – monitoring 0x4f2a···8e1d" },
  { type: "[ERR]", text: "atomic_repay unreachable – blind spot confirmed" },
  { type: "[WARN]", text: "coverage_path 25pct – 3 modules unlinked" },
  { type: "[INFO]", text: "scanner_heartbeat nominal – cycle 4.5s" }
];

export function WhyPanik() {
  const [activeIdx, setActiveIdx] = useState<number>(4);
  const [hoveredNode, setHoveredNode] = useState<TooltipInfo | null>(null);
  const [displayCoverage, setDisplayCoverage] = useState(25);
  const [panikStep, setPanikStep] = useState(0);

  const panikRowRef = useRef<HTMLDivElement>(null);
  const [animateStep, setAnimateStep] = useState(0);
  const [showPulse, setShowPulse] = useState(false);
  const [showBadge, setShowBadge] = useState(false);

  useEffect(() => {
    let timeouts: any[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setAnimateStep(0);
            setShowPulse(false);
            setShowBadge(false);
            
            timeouts.push(setTimeout(() => setAnimateStep(1), 0));
            timeouts.push(setTimeout(() => setAnimateStep(2), 160));
            timeouts.push(setTimeout(() => setAnimateStep(3), 320));
            timeouts.push(setTimeout(() => setAnimateStep(4), 480));
            timeouts.push(setTimeout(() => setAnimateStep(5), 640));
            timeouts.push(setTimeout(() => setShowPulse(true), 800));
            timeouts.push(setTimeout(() => setShowBadge(true), 900));
          } else {
            if (entry.boundingClientRect.top > 0) {
              setAnimateStep(0);
              setShowPulse(false);
              setShowBadge(false);
              timeouts.forEach(clearTimeout);
              timeouts = [];
            }
          }
        });
      },
      { threshold: 0.80 }
    );

    if (panikRowRef.current) {
      observer.observe(panikRowRef.current);
    }

    return () => {
      observer.disconnect();
      timeouts.forEach(clearTimeout);
    };
  }, []);

  // Smoothly animate the coverage path count and progress indicator whenever activeIdx has changed
  useEffect(() => {
    const targets = [15, 25, 40, 30, 100];
    const targetVal = targets[activeIdx];
    const startVal = displayCoverage;
    let start: number | null = null;
    const duration = 1200; // 1.2s ease-out fill animation

    const step = (timestamp: number) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      
      // outQuart easing
      const ease = 1 - Math.pow(1 - progress, 4);
      const currentVal = Math.round(startVal + (targetVal - startVal) * ease);
      setDisplayCoverage(currentVal);
      
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    };
    
    const animationFrameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationFrameId);
  }, [activeIdx]);

  // Sequential stage node lighting for the PANIK card
  useEffect(() => {
    if (activeIdx === 4) {
      setPanikStep(0);
      const timers = [
        setTimeout(() => setPanikStep(1), 180),
        setTimeout(() => setPanikStep(2), 360),
        setTimeout(() => setPanikStep(3), 540),
        setTimeout(() => setPanikStep(4), 720),
        setTimeout(() => setPanikStep(5), 900),
      ];
      return () => timers.forEach(clearTimeout);
    } else {
      setPanikStep(0);
    }
  }, [activeIdx]);

  const comparisons = [
    {
      tool: "PROTOCOL DASHBOARDS",
      miss: "Only display data for their own specific smart contracts. No aggregate cross-protocol overview.",
      isPanik: false,
      coverage: 15,
      stages: { choose: true, open: false, monitor: false, alert: false, act: false }
    },
    {
      tool: "PORTFOLIO TRACKERS",
      miss: "Purely passive visualizations. Cannot execute fallback actions or alert on live liquidation multipliers.",
      isPanik: false,
      coverage: 25,
      stages: { choose: true, open: false, monitor: true, alert: false, act: false },
      hasCriticalGap: true
    },
    {
      tool: "POSITION MANAGERS",
      miss: "Automate swaps blindly without quantifying risk parameters or contract audit vulnerabilities first.",
      isPanik: false,
      coverage: 40,
      stages: { choose: false, open: true, monitor: false, alert: false, act: true, actTainted: true }
    },
    {
      tool: "YIELD VAULTS",
      miss: "Apply static risk parameters uniformly to all depositors. Absolutely no personalized context.",
      isPanik: false,
      coverage: 30,
      stages: { choose: false, open: true, monitor: true, monitorTainted: true, alert: false, act: false }
    },
    {
      tool: "PANIK",
      miss: "Covers the entire position lifecycle in real time, personalized to your exact boundaries.",
      isPanik: true,
      coverage: 100,
      stages: { choose: true, open: true, monitor: true, alert: true, act: true }
    }
  ];

  return (
    <section id="why-panik" className="relative py-28 px-6 bg-surface-base overflow-hidden border-t border-b border-border-subtle">
      
      {/* Premium inline styling injecting keyframes and precise CSS for hardware accelerated animations */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes radarRotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .radar-sweep-anim {
          animation: radarRotate 4.5s linear infinite;
        }
        @keyframes activeRing {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50% { transform: scale(1.18); opacity: 0; }
        }
        .animate-active-ring {
          animation: activeRing 2.5s cubic-bezier(0.16, 1, 0.3, 1) infinite;
        }
        @keyframes hbPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgb(from var(--color-risk-low) r g b / 0.5); }
          60% { box-shadow: 0 0 0 8px rgb(from var(--color-risk-low) r g b / 0); }
        }
        .animate-scanner-dot {
          animation: hbPulse 1.8s ease infinite;
        }
        @keyframes nodePingHighlight {
          0% { transform: scale(1); filter: brightness(1); box-shadow: 0 0 0 0 transparent; }
          2% { transform: scale(1.1); filter: brightness(1.8); box-shadow: 0 0 10px currentColor; }
          12% { transform: scale(1); filter: brightness(1.1); box-shadow: 0 0 0 0 transparent; }
          100% { transform: scale(1); filter: brightness(1); }
        }
        .animated-ping-sentry-tracker {
          animation: nodePingHighlight 4.5s linear infinite;
          animation-delay: 2.89s;
        }
        .animated-ping-audit-sentry {
          animation: nodePingHighlight 4.5s linear infinite;
          animation-delay: 4.12s;
        }
        .animated-ping-warning-node {
          animation: nodePingHighlight 4.5s linear infinite;
          animation-delay: 0.77s;
        }
        .animated-ping-atomic-repay {
          animation: nodePingHighlight 4.5s linear infinite;
          animation-delay: 1.43s;
        }
        @keyframes flowDashRotate {
          to { stroke-dashoffset: -18; }
        }
        .radar-flow-dashes {
          animation: flowDashRotate 1.2s linear infinite;
        }
        @keyframes borderGlowPulse {
          0%, 100% { border-color: rgb(from var(--color-panik-orange) r g b / 0.30); box-shadow: 0 0 0 0 transparent; }
          50% { border-color: rgb(from var(--color-panik-orange) r g b / 0.70); box-shadow: 0 0 8px rgb(from var(--color-panik-orange) r g b / 0.08); }
        }
        .animate-border-glow {
          animation: borderGlowPulse 2.2s ease-in-out infinite;
        }
        @keyframes alertBlinkAnim {
          0%, 100% { opacity: 1; border-color: rgb(from var(--color-risk-elevated) r g b / 0.50); }
          50% { opacity: 0.35; border-color: rgb(from var(--color-risk-elevated) r g b / 0.12); }
        }
        .animate-alert-blink {
          animation: alertBlinkAnim 1.4s ease-in-out infinite;
        }
        @keyframes slowSpin {
          to { transform: rotate(360deg); }
        }
        .animate-slow-spin-dashed {
          animation: slowSpin 14s linear infinite;
        }
        .animate-logo-spin {
          animation: slowSpin 8s linear infinite;
        }
      `}} />

      {/* Ambient Radial Mesh Backgrounds */}
      <div className="absolute top-1/2 left-1/4 -translate-y-1/2 w-[550px] h-[550px] bg-gradient-to-tr from-panik-orange/[0.025] to-transparent rounded-full blur-3xl pointer-events-none"></div>

      <div className="max-w-7xl mx-auto relative z-10">
        
        {/* Headline and Subtext Block */}
        <ScrollReveal duration={0.6}>
          <div className="max-w-3xl mb-16 text-left">
            <span className="text-2xs font-mono tracking-widest text-panik-orange uppercase font-medium">
              THE GAP
            </span>
            <h2 className="font-sans font-extrabold text-4xl tracking-tight leading-tight text-text-primary mt-3 mb-4">
              Every DeFi tool sees <br />
              <span className="text-text-muted">part of </span>
              <span className="text-text-primary">the picture.</span>
            </h2>
            <p className="text-text-secondary text-sm sm:text-base max-w-xl leading-relaxed">
              Siloed interfaces leave your funds vulnerable. <span className="text-panik-orange font-semibold">PANIK</span> integrates state monitoring, audit history mapping, and action suggestions into a cohesive unit.
            </p>
          </div>
        </ScrollReveal>

        {/* Side-by-Side Dual Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-14 items-start pt-2">
          
          {/* Left Column (Radar Scanning Terminal) - Sticky */}
          <div className="lg:col-span-5 lg:sticky lg:top-[90px] z-20">
            <ScrollReveal
              className="w-full max-w-[460px] bg-surface-sunken border border-border-subtle rounded-lg flex flex-col justify-between overflow-hidden shadow-[inset_0_1px_0_rgb(from var(--color-risk-low) r g b / 0.08),0_12px_40px_rgba(0,0,0,0.65)]"
              duration={0.7}
              delay={0.12}
            >
              {/* Card Header Row */}
              <div className="flex justify-between items-center px-5 h-12 border-b border-border-subtle select-none">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-scanner-dot absolute inline-flex h-full w-full rounded-full bg-risk-low"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-risk-low"></span>
                  </span>
                  <span className="text-2xs font-mono tracking-[0.09em] text-risk-low uppercase font-bold">
                    INTELLIGENCE SCANNER
                  </span>
                </div>
                
                <div className="flex items-center gap-3">
                  <span className="text-2xs font-mono text-text-muted uppercase font-medium">COVERAGE PATH</span>
                  
                  {/* Circular Arc Donut Progress */}
                  <div 
                    className="relative w-11 h-11 rounded-full flex items-center justify-center transition-all"
                    style={{
                      background: `conic-gradient(var(--color-risk-low) 0deg, var(--color-risk-low) ${displayCoverage * 3.6}deg, rgba(255,255,255,0.07) ${displayCoverage * 3.6}deg, rgba(255,255,255,0.07) 360deg)`
                    }}
                  >
                    <div className="absolute inset-[3px] rounded-full bg-surface-sunken flex items-center justify-center">
                      <span className="text-2xs font-mono font-bold text-risk-low">
                        {displayCoverage}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Main Radar Screen Canvas Bounded Box */}
              <div className="relative flex items-center justify-center w-full h-[340px] select-none overflow-hidden bg-surface-sunken/40">
                
                {/* Center Anchor Wrapper for perfect coordinate alignment */}
                <div className="relative w-[340px] h-[340px] shrink-0">

                  {/* 1. Radar Sweep Conic Gradient Rotating Element */}
                  <div className="absolute inset-0 pointer-events-none rounded-full overflow-hidden">
                    <div className="w-[340px] h-[340px] rounded-full radar-sweep-anim origin-center">
                      <div className="absolute inset-0 rounded-full" style={{
                        background: 'conic-gradient(from 270deg, rgb(from var(--color-risk-low) r g b / 0.4) 0deg, rgb(from var(--color-risk-low) r g b / 0.15) 15deg, rgb(from var(--color-risk-low) r g b / 0.05) 45deg, transparent 90deg, transparent 360deg)'
                      }} />
                    </div>
                  </div>

                  {/* 2. Concentric Circles & Axes background grid */}
                  <svg className="w-[340px] h-[340px] absolute inset-0 pointer-events-none" viewBox="0 0 340 340">
                    {/* Concentric rings */}
                    <circle cx="170" cy="170" r="42" stroke="rgb(from var(--color-risk-low) r g b / 0.12)" strokeWidth="0.5" fill="none" />
                    <circle cx="170" cy="170" r="85" stroke="rgb(from var(--color-risk-low) r g b / 0.10)" strokeWidth="0.5" fill="none" />
                    <circle cx="170" cy="170" r="127" stroke="rgb(from var(--color-risk-low) r g b / 0.08)" strokeWidth="0.5" strokeDasharray="3 3" fill="none" />
                    <circle cx="170" cy="170" r="170" stroke="rgb(from var(--color-risk-low) r g b / 0.06)" strokeWidth="0.5" fill="none" />

                    {/* Faint coordinates label markings */}
                    <text x="215" y="173" className="text-2xs font-mono font-medium fill-text-muted">25</text>
                    <text x="258" y="173" className="text-2xs font-mono font-medium fill-text-muted">50</text>
                    <text x="300" y="173" className="text-2xs font-mono font-medium fill-text-muted">75</text>
                    <text x="323" y="173" className="text-2xs font-mono font-medium fill-text-muted">100</text>

                    {/* Axis indicators */}
                    <line x1="170" y1="0" x2="170" y2="340" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
                    <line x1="0" y1="170" x2="340" y2="170" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />

                    {/* Wedge A: Audit Sentry Blind Spot Arc (~30deg to ~90deg) */}
                    <path 
                      d="M 170 170 L 317.2 85 A 170 170 0 0 0 170 0 Z" 
                      fill="rgb(from var(--color-risk-critical) r g b / 0.04)" 
                      stroke="rgb(from var(--color-risk-critical) r g b / 0.15)" 
                      strokeWidth="0.5" 
                      className="transition-all duration-500" 
                      style={{ 
                        opacity: activeIdx === 4 ? 0 : (activeIdx === 1 ? 0.95 : 0.45) 
                      }}
                    />

                    {/* Wedge B: Atomic Repay Blind Spot Arc (~220deg to ~290deg) */}
                    <path 
                      d="M 170 170 L 39.8 279.3 A 170 170 0 0 0 228.1 329.8 Z" 
                      fill="rgb(from var(--color-risk-critical) r g b / 0.04)" 
                      stroke="rgb(from var(--color-risk-critical) r g b / 0.15)" 
                      strokeWidth="0.5" 
                      className="transition-all duration-500" 
                      style={{ 
                        opacity: activeIdx === 4 ? 0 : (activeIdx === 2 || activeIdx === 0 ? 0.95 : 0.45) 
                      }}
                    />

                    {/* Connection Lines Flows */}
                    {/* Sentry Tracker (98, 80) -> Alert Node (230, 280) */}
                    <line 
                      x1="98" y1="80" x2="230" y2="280" 
                      stroke="rgb(from var(--color-risk-low) r g b / 0.35)" 
                      strokeWidth="1.5" 
                      strokeLinecap="round"
                      strokeDasharray="5 4" 
                      className="radar-flow-dashes"
                    />

                    {/* Alert Node (230, 280) -> Atomic Repay (115, 290) */}
                    <line 
                      x1="230" y1="280" x2="115" y2="290" 
                      stroke="rgb(from var(--color-risk-critical) r g b / 0.22)" 
                      strokeWidth="1.2" 
                      strokeLinecap="round"
                      strokeDasharray="3 6" 
                    />

                    {/* Sentry Tracker (98, 80) -> Audit Sentry (265, 115) - active only when PANIK row is in place */}
                    <line 
                      x1="98" y1="80" x2="265" y2="115" 
                      stroke="var(--color-risk-low)" 
                      strokeWidth="1.8" 
                      strokeLinecap="round"
                      style={{ opacity: activeIdx === 4 ? 0.75 : 0 }}
                      className="transition-opacity duration-700" 
                    />
                  </svg>

                  {/* 3. Center origin monitoring dot */}
                  <div className="absolute left-[170px] top-[170px] -translate-x-1/2 -translate-y-1/2 z-30">
                    <div className="w-2.5 h-2.5 rounded-full bg-panik-orange relative flex items-center justify-center">
                      <div className="absolute inset-[-14px] rounded-full border border-panik-orange/20" />
                    </div>
                  </div>

                  {/* 4. Overlay Radar Nodes (positioned perfectly relative to standard coordinates offset) */}
                  
                  {/* Node 1: Sentry Tracker (ACTIVE status always) */}
                  <div 
                    className="radar-node absolute pointer-events-auto cursor-pointer z-35 group"
                    style={{ left: "98px", top: "80px", transform: "translate(-50%, -50%)" }}
                    onMouseEnter={() => setHoveredNode({
                      title: "SENTRY TRACKER",
                      status: "ACTIVE",
                      details: "Real-time on-chain tracker streaming secure validation heartbeats block-by-block.",
                      colorClass: "text-risk-low"
                    })}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <div className="relative w-[34px] h-[34px] rounded-full bg-surface-sunken border border-risk-low/45 flex items-center justify-center text-risk-low animated-ping-sentry-tracker">
                      <svg viewBox="0 0 20 20" className="w-4.5 h-4.5">
                        <polyline points="2,8 6,8 8,4 10,12 12,6 14,8 18,8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <div className="absolute inset-[-4px] rounded-full border border-risk-low/20 animate-active-ring" />
                    </div>
                    
                    <div className="absolute top-[38px] left-1/2 -translate-x-1/2 flex flex-col items-center">
                      <span className="text-2xs font-mono text-text-muted whitespace-nowrap font-medium tracking-wider">SENTRY TRACKER</span>
                      <span className="text-2xs font-mono text-risk-low font-bold">ACTIVE</span>
                    </div>
                  </div>

                  {/* Node 2: Audit Sentry (BLIND SPOT normally, ACTIVE on PANIK) */}
                  <div 
                    className="radar-node absolute pointer-events-auto cursor-pointer z-35 group"
                    style={{ left: "265px", top: "115px", transform: "translate(-50%, -50%)" }}
                    onMouseEnter={() => setHoveredNode({
                      title: "AUDIT SENTRY",
                      status: activeIdx === 4 ? "ACTIVE" : "BLIND SPOT",
                      details: activeIdx === 4 
                        ? "Continuous inspection mapping active contracts directly against audited parameters."
                        : "Siloed dashboard gap: execution metrics evaluated without audit safety checking.",
                      colorClass: activeIdx === 4 ? "text-risk-low" : "text-risk-critical"
                    })}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <div className={`relative w-[34px] h-[34px] rounded-full bg-surface-sunken border transition-all duration-500 flex items-center justify-center animated-ping-audit-sentry ${
                      activeIdx === 4 
                        ? "border-risk-low text-risk-low" 
                        : "border-risk-critical/25 text-risk-critical/50"
                    }`}>
                      <svg viewBox="0 0 20 20" className="w-4.5 h-4.5">
                        <circle cx="10" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        <path d="M3,18 C3,14 17,14 17,18" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                      </svg>

                      {/* Standard red indicator dot when blind spot is active */}
                      {activeIdx !== 4 && (
                        <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-risk-critical flex items-center justify-center border border-risk-critical shadow">
                           <span className="text-2xs font-bold text-text-primary leading-none">!</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="absolute top-[38px] left-1/2 -translate-x-1/2 flex flex-col items-center">
                      <span className="text-2xs font-mono text-text-muted whitespace-nowrap font-medium tracking-wider">AUDIT SENTRY</span>
                      <span className={`text-2xs font-mono font-bold ${activeIdx === 4 ? "text-risk-low" : "text-risk-critical/70"}`}>
                        {activeIdx === 4 ? "ACTIVE" : "BLIND SPOT"}
                      </span>
                    </div>
                  </div>

                  {/* Node 3: Unnamed Alert Node (Triangle indicator warning anomaly status) */}
                  <div 
                    className="radar-node absolute pointer-events-auto cursor-pointer z-35 group"
                    style={{ left: "230px", top: "280px", transform: "translate(-50%, -50%)" }}
                    onMouseEnter={() => setHoveredNode({
                      title: "ALERT DETECTOR",
                      status: "WARNING STATE",
                      details: "Real-time state anomaly detected. Disconnected in secondary dashboards.",
                      colorClass: "text-risk-elevated"
                    })}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <div className="w-[30px] h-[30px] rounded-full bg-surface-sunken border border-risk-elevated/35 flex items-center justify-center text-risk-elevated animated-ping-warning-node animate-alert-blink">
                      <svg viewBox="0 0 20 20" className="w-4 h-4">
                        <path d="M10,3 L18,17 H2 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
                        <line x1="10" y1="10" x2="10" y2="13" stroke="currentColor" strokeWidth="1.5"/>
                        <circle cx="10" cy="15.5" r="0.8" fill="currentColor"/>
                      </svg>
                    </div>
                  </div>

                  {/* Node 4: Atomic Repay (BLIND SPOT normally, ACTIVE on PANIK) */}
                  <div 
                    className="radar-node absolute pointer-events-auto cursor-pointer z-35 group"
                    style={{ left: "115px", top: "290px", transform: "translate(-50%, -50%)" }}
                    onMouseEnter={() => setHoveredNode({
                      title: "ATOMIC REPAY",
                      status: activeIdx === 4 ? "ACTIVE" : "BLIND SPOT",
                      details: activeIdx === 4 
                        ? "Automated atomic repayment and protective safehousing configured active."
                        : "Portfolio track hazard: action trigger bypassed. Emergency rescue unreachable.",
                      colorClass: activeIdx === 4 ? "text-risk-low" : "text-risk-critical"
                    })}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <div className={`relative w-[34px] h-[34px] rounded-full bg-surface-sunken border transition-all duration-500 flex items-center justify-center animated-ping-atomic-repay ${
                      activeIdx === 4 
                        ? "border-risk-low text-risk-low" 
                        : "border-risk-critical/25 text-risk-critical/50"
                    }`}>
                      <svg viewBox="0 0 20 20" className="w-4.5 h-4.5">
                        <path d="M13,2 L8,11 H12 L7,20" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>

                      {/* Standard red indicator dot when blind spot is active */}
                      {activeIdx !== 4 && (
                        <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-risk-critical flex items-center justify-center border border-risk-critical shadow">
                           <span className="text-2xs font-bold text-text-primary leading-none">!</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="absolute top-[38px] left-1/2 -translate-x-1/2 flex flex-col items-center">
                      <span className="text-2xs font-mono text-text-muted whitespace-nowrap font-medium tracking-wider">ATOMIC REPAY</span>
                      <span className={`text-2xs font-mono font-bold ${activeIdx === 4 ? "text-risk-low" : "text-risk-critical/70"}`}>
                        {activeIdx === 4 ? "ACTIVE" : "BLIND SPOT"}
                      </span>
                    </div>
                  </div>

                  {/* Floating details overlay on Node Hover */}
                  <AnimatePresence>
                    {hoveredNode && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-5 left-5 right-5 bg-surface-sunken/95 border border-border-subtle p-3.5 rounded-md backdrop-blur-md z-45 shadow-[0_8px_32px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.02)] select-none text-left"
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-2xs font-mono font-bold tracking-wider text-text-primary">
                            {hoveredNode.title}
                          </span>
                          <span className={`text-2xs font-mono font-bold uppercase ${hoveredNode.colorClass}`}>
                            {hoveredNode.status}
                          </span>
                        </div>
                        <p className="text-2xs text-text-secondary leading-relaxed">
                          {hoveredNode.details}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>

                </div>

              </div>

              {/* Bottom Scrolling Terminal Log Strip */}
              <TerminalLog />
            </ScrollReveal>
          </div>

          {/* Right Column (Lifecycle Journey Match Matrix) */}
          <div className="lg:col-span-7 flex flex-col z-10 w-full lm-panel">
            
            <style dangerouslySetInnerHTML={{__html: `
              .lm-panel {
                font-family: 'Inter', sans-serif;
                width: 100%;
              }
              .lm-title {
                font-family: 'JetBrains Mono', monospace;
                font-size: 10px;
                font-weight: 500;
                color: var(--color-text-muted);
                letter-spacing: 0.09em;
                margin-bottom: 16px;
                text-transform: uppercase;
              }
              .lm-header-row {
                display: flex;
                align-items: center;
                border-bottom: 0.5px solid rgba(255,255,255,0.06);
                padding-bottom: 10px;
                margin-bottom: 10px;
                width: 100%;
              }
              .lm-header-label {
                font-family: 'JetBrains Mono', monospace;
                font-size: 9px;
                font-weight: 500;
                color: var(--color-text-muted);
                text-transform: uppercase;
                letter-spacing: 0.07em;
                text-align: center;
                width: 100%;
              }
              .lm-row {
                display: flex;
                align-items: flex-start;
                min-height: 100px;
                padding: 20px 0;
                border-bottom: 0.5px solid rgba(255,255,255,0.05);
                background: transparent;
                transition: background 0.15s ease;
                width: 100%;
                cursor: pointer;
              }
              .lm-row-active, .lm-row:hover {
                background: rgba(255,255,255,0.02);
              }
              .lm-left-col {
                width: 30%;
                max-width: 200px;
                flex-shrink: 0;
                display: flex;
                flex-direction: column;
                justify-content: flex-start;
                padding-left: 0;
                padding-right: 12px;
              }
              .lm-row-portfolio {
                border-left: 2px solid rgb(from var(--color-panik-orange) r g b / 0.35) !important;
                padding-left: 12px !important;
                margin-left: -14px !important;
              }
              .lm-row-portfolio .lm-right-col {
                left: 14px !important;
              }
              .lm-right-col {
                width: 70%;
                position: relative;
                align-self: center;
              }
              .lm-track-grid {
                display: grid;
                grid-template-columns: repeat(5, minmax(60px, 1fr));
                column-gap: 8px;
                align-items: center;
                position: relative;
                width: 100%;
              }
              .lm-row .lm-track-grid,
              .lm-panik-card .lm-track-grid {
                margin-top: 12px;
              }
              .lm-cell {
                display: flex;
                justify-content: center;
                align-items: center;
                min-width: 48px;
                position: relative;
                z-index: 2;
              }
              .lm-node {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                transition: border-color 0.15s ease;
              }
              .lm-node:hover {
                border-color: rgba(255, 255, 255, 0.45) !important;
              }

              /* STATE A - COVERED (white) */
              .lm-node-covered {
                background: rgba(255,255,255,0.10);
                border: 1px solid rgba(255,255,255,0.35);
              }
              .lm-node-covered::after {
                content: '';
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--color-text-primary);
              }

              /* STATE B - NOT COVERED (hollow) */
              .lm-node-hollow {
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(255,255,255,0.08);
              }

              /* STATE C - DANGEROUS (red) */
              .lm-node-dangerous {
                background: rgb(from var(--color-risk-critical) r g b / 0.10);
                border: 1px solid rgb(from var(--color-risk-critical) r g b / 0.35);
                position: relative;
              }
              .lm-node-dangerous::after {
                content: '';
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--color-risk-critical);
              }
              .lm-node-dangerous .lm-tooltip {
                visibility: hidden;
                position: absolute;
                bottom: calc(100% + 8px);
                left: 50%;
                transform: translateX(-50%);
                background: var(--color-surface-raised);
                border: 0.5px solid rgba(255,255,255,0.10);
                border-radius: 6px;
                padding: 6px 10px;
                color: var(--color-text-secondary);
                font-family: 'Inter', sans-serif;
                font-size: 11px;
                white-space: nowrap;
                z-index: 100;
                opacity: 0;
                transition: opacity 0.15s ease, visibility 0.15s ease;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
              }
              .lm-node-dangerous:hover .lm-tooltip {
                visibility: visible;
                opacity: 1;
              }

              /* STATE D - PARTIAL (amber) */
              .lm-node-partial {
                background: rgb(from var(--color-risk-elevated) r g b / 0.08);
                border: 1px solid rgb(from var(--color-risk-elevated) r g b / 0.25);
              }
              .lm-node-partial::after {
                content: '';
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--color-risk-elevated);
              }

              /* STATE E - PANIK COVERED (orange) */
              .lm-node-panik {
                width: 32px !important;
                height: 32px !important;
                border-radius: 50% !important;
                background: rgb(from var(--color-panik-orange) r g b / 0.15);
                border: 1px solid rgb(from var(--color-panik-orange) r g b / 0.55);
                opacity: 0.15;
                transition: opacity 0.3s ease, border-color 0.15s ease;
              }
              .lm-node-panik::after {
                content: '';
                width: 8px !important;
                height: 8px !important;
                border-radius: 50% !important;
                background: var(--color-panik-orange);
              }
              .lm-node-panik.lm-light-up {
                opacity: 1;
              }
              @keyframes lm-pulse-glow {
                0% {
                  box-shadow: 0 0 0 0 rgb(from var(--color-panik-orange) r g b / 0.5);
                }
                100% {
                  box-shadow: 0 0 0 10px rgb(from var(--color-panik-orange) r g b / 0);
                }
              }
              .lm-node-panik.lm-pulse {
                animation: lm-pulse-glow 0.4s ease-out;
              }

              /* Connector Lines Base */
              .lm-connector-wrapper {
                position: absolute;
                top: 28px;
                transform: translateY(-50%);
                height: 24px;
                z-index: 1;
                pointer-events: none;
                display: flex;
                align-items: center;
                justify-content: center;
              }
              .lm-conn-1 { left: 10%; width: 20%; }
              .lm-conn-2 { left: 30%; width: 20%; }
              .lm-conn-3 { left: 50%; width: 20%; }
              .lm-conn-4 { left: 70%; width: 20%; }

              .lm-line-active {
                width: 100%;
                height: 1.5px;
                background: rgba(255,255,255,0.22);
              }

              .lm-line-broken-container {
                width: 100%;
                height: 24px;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
              }
              .lm-line-broken-left {
                width: 40%;
                height: 1.5px;
                background: rgba(255,255,255,0.18);
              }
              .lm-line-broken-right {
                width: 40%;
                height: 1.5px;
                border-top: 1.5px dashed rgb(from var(--color-risk-critical) r g b / 0.18);
              }
               .lm-gap-marker {
                font-family: 'JetBrains Mono', monospace;
                font-size: 8px;
                font-weight: 600;
                color: var(--color-risk-critical);
                background: rgb(from var(--color-risk-critical) r g b / 0.12);
                border: 0.5px solid rgb(from var(--color-risk-critical) r g b / 0.30);
                border-radius: 4px;
                padding: 2px 6px;
                white-space: nowrap;
                position: absolute;
                left: 50%;
                bottom: calc(50% + 8px);
                transform: translateX(-50%);
                z-index: 10;
                transition: border-color 0.15s ease;
                cursor: pointer;
                pointer-events: auto;
              }
              .lm-gap-marker:hover {
                border-color: var(--color-risk-critical);
              }

              /* Critical Gap Marker */
              .lm-critical-gap-marker {
                font-family: 'JetBrains Mono', monospace;
                font-size: 7px;
                font-weight: 600;
                color: var(--color-panik-orange);
                background: rgb(from var(--color-panik-orange) r g b / 0.12);
                border: 0.5px solid rgb(from var(--color-panik-orange) r g b / 0.35);
                border-radius: 4px;
                padding: 3px 8px;
                white-space: nowrap;
                position: absolute;
                left: 50%;
                bottom: calc(50% + 8px);
                transform: translateX(-50%);
                z-index: 10;
                transition: border-color 0.15s ease;
                cursor: pointer;
                pointer-events: auto;
                min-width: max-content;
              }
              .lm-critical-gap-marker:hover {
                border-color: var(--color-panik-orange);
              }

              /* Uncovered start dashed continuation */
              .lm-line-uncovered {
                width: 100%;
                height: 1.5px;
                border-top: 1.5px dashed rgb(from var(--color-risk-critical) r g b / 0.18);
              }

              /* PANIK active connectors with draw animation */
              .lm-svg-draw-path {
                stroke-dasharray: 100;
                stroke-dashoffset: 100;
                transition: stroke-dashoffset 140ms ease-out;
              }
              .lm-svg-draw-path.lm-draw-anim {
                stroke-dashoffset: 0;
              }

              /* Separator */
              .lm-separator {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                margin-top: 28px;
                margin-bottom: 24px;
                position: relative;
              }
              .lm-separator-line-left {
                width: calc(50% - 120px);
                height: 1px;
                background: linear-gradient(to right, transparent, rgb(from var(--color-panik-orange) r g b / 0.40));
              }
              .lm-separator-line-right {
                width: calc(50% - 120px);
                height: 1px;
                background: linear-gradient(to left, transparent, rgb(from var(--color-panik-orange) r g b / 0.40));
              }
              .lm-separator-pill {
                font-family: 'JetBrains Mono', monospace;
                font-size: 9px;
                font-weight: 600;
                color: var(--color-panik-orange);
                letter-spacing: 0.09em;
                background: rgb(from var(--color-panik-orange) r g b / 0.08);
                border: 0.5px solid rgb(from var(--color-panik-orange) r g b / 0.25);
                border-radius: 20px;
                padding: 5px 14px;
                white-space: nowrap;
                text-align: center;
              }

              /* PANIK Card Redesign */
              .lm-panik-card {
                background: rgb(from var(--color-panik-orange) r g b / 0.07);
                border: 0.5px solid rgb(from var(--color-panik-orange) r g b / 0.35);
                border-radius: 12px;
                border-left: 3px solid var(--color-panik-orange);
                padding: 20px 20px 20px 18px;
                box-shadow: 0 0 0 1px rgb(from var(--color-panik-orange) r g b / 0.05),
                            0 4px 28px rgb(from var(--color-panik-orange) r g b / 0.08),
                            inset 0 1px 0 rgb(from var(--color-panik-orange) r g b / 0.08);
                width: 100%;
                display: flex;
                align-items: flex-start;
                position: relative;
                transition: box-shadow 0.20s ease;
                cursor: pointer;
                margin-bottom: 8px;
              }
              .lm-panik-card:hover {
                box-shadow: 0 0 0 1px rgb(from var(--color-panik-orange) r g b / 0.10),
                            0 4px 32px rgb(from var(--color-panik-orange) r g b / 0.14);
              }
              .lm-panik-left-title {
                display: flex;
                align-items: center;
                justify-content: flex-start;
              }
              .lm-panik-spin-logo {
                display: inline-flex;
                transform-origin: center;
                animation: lm-spin 8s linear infinite;
              }
              .lm-panik-name {
                font-family: 'JetBrains Mono', monospace;
                font-size: 14px;
                font-weight: 700;
                color: var(--color-panik-orange);
                letter-spacing: 0.10em;
                margin-left: 10px;
              }
              .lm-panik-desc {
                font-family: 'Inter', sans-serif;
                font-size: 13px;
                font-weight: 400;
                color: rgb(from var(--color-panik-orange) r g b / 0.80);
                line-height: 1.6;
                margin-top: 6px;
                max-width: 230px;
              }
              .lm-panik-badge {
                position: absolute;
                top: 14px;
                right: 20px;
                font-family: 'JetBrains Mono', monospace;
                font-size: 9px;
                font-weight: 600;
                color: var(--color-risk-low);
                background: rgb(from var(--color-risk-low) r g b / 0.10);
                border: 0.5px solid rgb(from var(--color-risk-low) r g b / 0.30);
                border-radius: 4px;
                padding: 4px 10px;
                white-space: nowrap;
                opacity: 0;
                transform: scale(0.85);
              }
              .lm-panik-badge.lm-badge-show {
                opacity: 1;
                transform: scale(1);
                transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
              }
              .lm-status-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: rgba(255,255,255,0.18);
                display: inline-block;
                margin-right: 8px;
                flex-shrink: 0;
              }
              .lm-row-title-container {
                display: flex;
                align-items: center;
                margin-bottom: 5px;
              }
              .lm-tool-name {
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                color: var(--color-text-secondary);
                letter-spacing: 0.07em;
              }
              .lm-row-desc {
                font-family: 'Inter', sans-serif;
                font-size: 12px;
                font-weight: 400;
                color: var(--color-text-muted);
                line-height: 1.6;
                max-width: 230px;
              }
              @keyframes lm-spin {
                to { transform: rotate(360deg); }
              }
            `}} />

            {/* Stage Path Label Header (LIFECYCLE MATRIX label) */}
            <div className="lm-title">
              LIFECYCLE MATRIX
            </div>

            {/* COLUMN HEADER ROW (appears ONCE, never repeated) */}
            <div className="lm-header-row">
              <div className="lm-left-col" />
              <div className="lm-right-col">
                <div className="lm-track-grid">
                  <div className="lm-header-label">CHOOSE</div>
                  <div className="lm-header-label">OPEN</div>
                  <div className="lm-header-label">MONITOR</div>
                  <div className="lm-header-label">ALERT</div>
                  <div className="lm-header-label">ACT</div>
                </div>
              </div>
            </div>

            {/* Competitor Rows & PANIK Row Container */}
            <div className="w-full flex flex-col">
              
              {/* ROW 1 — PROTOCOL DASHBOARDS */}
              <div 
                className={`lm-row ${activeIdx === 0 ? "lm-row-active" : ""}`}
                onClick={() => setActiveIdx(0)}
                onMouseEnter={() => setActiveIdx(0)}
              >
                <div className="lm-left-col">
                  <div className="lm-row-title-container">
                    <span className="lm-status-dot"></span>
                    <span className="lm-tool-name">PROTOCOL DASHBOARDS</span>
                  </div>
                  <p className="lm-row-desc">
                    Only display data for their own specific smart contracts. No aggregate cross-protocol overview.
                  </p>
                </div>
                <div className="lm-right-col">
                  {/* Connectors */}
                  {/* CHOOSE to OPEN */}
                  <div className="lm-connector-wrapper lm-conn-1">
                    <div className="lm-line-broken-container">
                      <div className="lm-line-broken-left"></div>
                      <span className="lm-gap-marker">GAP</span>
                      <div className="lm-line-broken-right"></div>
                    </div>
                  </div>
                  {/* OPEN to MONITOR */}
                  <div className="lm-connector-wrapper lm-conn-2">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* MONITOR to ALERT */}
                  <div className="lm-connector-wrapper lm-conn-3">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* ALERT to ACT */}
                  <div className="lm-connector-wrapper lm-conn-4">
                    <div className="lm-line-uncovered"></div>
                  </div>

                  {/* Track Grid with Nodes */}
                  <div className="lm-track-grid">
                    <div className="lm-cell">
                      <div className="lm-node lm-node-covered"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ROW 2 — PORTFOLIO TRACKERS */}
              <div 
                className={`lm-row lm-row-portfolio ${activeIdx === 1 ? "lm-row-active" : ""}`}
                onClick={() => setActiveIdx(1)}
                onMouseEnter={() => setActiveIdx(1)}
              >
                <div className="lm-left-col">
                  <div className="lm-row-title-container">
                    <span className="lm-status-dot"></span>
                    <span className="lm-tool-name">PORTFOLIO TRACKERS</span>
                  </div>
                  <p className="lm-row-desc">
                    Purely passive visualizations. Cannot execute fallback actions or alert on live liquidation multipliers.
                  </p>
                </div>
                <div className="lm-right-col">
                  {/* Connectors */}
                  {/* CHOOSE to OPEN */}
                  <div className="lm-connector-wrapper lm-conn-1">
                    <div className="lm-line-broken-container">
                      <div className="lm-line-broken-left"></div>
                      <span className="lm-gap-marker">GAP</span>
                      <div className="lm-line-broken-right"></div>
                    </div>
                  </div>
                  {/* OPEN to MONITOR */}
                  <div className="lm-connector-wrapper lm-conn-2">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* MONITOR to ALERT */}
                  <div className="lm-connector-wrapper lm-conn-3">
                    <div className="lm-line-broken-container">
                      <div className="lm-line-broken-left"></div>
                      <span className="lm-critical-gap-marker">CRITICAL GAP</span>
                      <div className="lm-line-broken-right"></div>
                    </div>
                  </div>
                  {/* ALERT to ACT */}
                  <div className="lm-connector-wrapper lm-conn-4">
                    <div className="lm-line-uncovered"></div>
                  </div>

                  {/* Track Grid with Nodes */}
                  <div className="lm-track-grid">
                    <div className="lm-cell">
                      <div className="lm-node lm-node-covered"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-covered"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ROW 3 — POSITION MANAGERS */}
              <div 
                className={`lm-row ${activeIdx === 2 ? "lm-row-active" : ""}`}
                onClick={() => setActiveIdx(2)}
                onMouseEnter={() => setActiveIdx(2)}
              >
                <div className="lm-left-col">
                  <div className="lm-row-title-container">
                    <span className="lm-status-dot"></span>
                    <span className="lm-tool-name">POSITION MANAGERS</span>
                  </div>
                  <p className="lm-row-desc">
                    Automate swaps blindly without quantifying risk parameters or contract audit vulnerabilities first.
                  </p>
                </div>
                <div className="lm-right-col">
                  {/* Connectors */}
                  {/* CHOOSE to OPEN */}
                  <div className="lm-connector-wrapper lm-conn-1">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* OPEN to MONITOR */}
                  <div className="lm-connector-wrapper lm-conn-2">
                    <div className="lm-line-broken-container">
                      <div className="lm-line-broken-left"></div>
                      <span className="lm-gap-marker">GAP</span>
                      <div className="lm-line-broken-right"></div>
                    </div>
                  </div>
                  {/* MONITOR to ALERT */}
                  <div className="lm-connector-wrapper lm-conn-3">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* ALERT to ACT */}
                  <div className="lm-connector-wrapper lm-conn-4">
                    <div className="lm-line-uncovered"></div>
                  </div>

                  {/* Track Grid with Nodes */}
                  <div className="lm-track-grid">
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-covered"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-dangerous">
                        <span className="lm-tooltip">Executes without risk scoring</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ROW 4 — YIELD VAULTS */}
              <div 
                className={`lm-row ${activeIdx === 3 ? "lm-row-active" : ""}`}
                onClick={() => setActiveIdx(3)}
                onMouseEnter={() => setActiveIdx(3)}
              >
                <div className="lm-left-col">
                  <div className="lm-row-title-container">
                    <span className="lm-status-dot"></span>
                    <span className="lm-tool-name">YIELD VAULTS</span>
                  </div>
                  <p className="lm-row-desc">
                    Apply static risk parameters uniformly to all depositors. Absolutely no personalized context.
                  </p>
                </div>
                <div className="lm-right-col">
                  {/* Connectors */}
                  {/* CHOOSE to OPEN */}
                  <div className="lm-connector-wrapper lm-conn-1">
                    <div className="lm-line-uncovered"></div>
                  </div>
                  {/* OPEN to MONITOR */}
                  <div className="lm-connector-wrapper lm-conn-2">
                    <div className="lm-line-active"></div>
                  </div>
                  {/* MONITOR to ALERT */}
                  <div className="lm-connector-wrapper lm-conn-3">
                    <div className="lm-line-broken-container">
                      <div className="lm-line-broken-left"></div>
                      <span className="lm-gap-marker">GAP</span>
                      <div className="lm-line-broken-right"></div>
                    </div>
                  </div>
                  {/* ALERT to ACT */}
                  <div className="lm-connector-wrapper lm-conn-4">
                    <div className="lm-line-uncovered"></div>
                  </div>

                  {/* Track Grid with Nodes */}
                  <div className="lm-track-grid">
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-covered"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-partial"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                    <div className="lm-cell">
                      <div className="lm-node lm-node-hollow"></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* THE SEPARATOR */}
              <div className="lm-separator">
                <div className="lm-separator-line-left"></div>
                <div className="lm-separator-pill">UNIFIED RESOLUTION PLATFORM</div>
                <div className="lm-separator-line-right"></div>
              </div>

              {/* THE PANIK ROW */}
              <div 
                ref={panikRowRef}
                className={`lm-panik-card ${activeIdx === 4 ? "lm-row-active" : ""}`}
                onClick={() => setActiveIdx(4)}
                onMouseEnter={() => setActiveIdx(4)}
              >
                {/* Visual Accent Title Info */}
                <div className="lm-left-col">
                  <div className="lm-panik-left-title">
                    <div className="lm-panik-spin-logo">
                      <svg width="20" height="20" viewBox="0 0 20 20">
                        <circle cx="10" cy="10" r="6" stroke="var(--color-panik-orange)" strokeWidth="1.5" fill="none"/>
                        <line x1="10" y1="1" x2="10" y2="4" stroke="var(--color-panik-orange)" strokeWidth="1.5"/>
                        <line x1="10" y1="16" x2="10" y2="19" stroke="var(--color-panik-orange)" strokeWidth="1.5"/>
                        <line x1="1" y1="10" x2="4" y2="10" stroke="var(--color-panik-orange)" strokeWidth="1.5"/>
                        <line x1="16" y1="10" x2="19" y2="10" stroke="var(--color-panik-orange)" strokeWidth="1.5"/>
                      </svg>
                    </div>
                    <span className="lm-panik-name">PANIK</span>
                  </div>
                  <p className="lm-panik-desc">
                    Covers the entire position lifecycle in real time, personalized to your exact boundaries.
                  </p>
                </div>

                <div className="lm-right-col">
                  {/* Connectors */}
                  {/* CHOOSE to OPEN */}
                  <div className="lm-connector-wrapper lm-conn-1">
                    <svg width="100%" height="1.5" viewBox="0 0 100 1.5" preserveAspectRatio="none" className="overflow-visible">
                      <line
                        x1="0" y1="0.75" x2="100" y2="0.75"
                        stroke="var(--color-panik-orange)"
                        strokeWidth="1.5"
                        className={`lm-svg-draw-path ${animateStep >= 2 ? 'lm-draw-anim' : ''}`}
                      />
                    </svg>
                  </div>
                  {/* OPEN to MONITOR */}
                  <div className="lm-connector-wrapper lm-conn-2">
                    <svg width="100%" height="1.5" viewBox="0 0 100 1.5" preserveAspectRatio="none" className="overflow-visible">
                      <line
                        x1="0" y1="0.75" x2="100" y2="0.75"
                        stroke="var(--color-panik-orange)"
                        strokeWidth="1.5"
                        className={`lm-svg-draw-path ${animateStep >= 3 ? 'lm-draw-anim' : ''}`}
                      />
                    </svg>
                  </div>
                  {/* MONITOR to ALERT */}
                  <div className="lm-connector-wrapper lm-conn-3">
                    <svg width="100%" height="1.5" viewBox="0 0 100 1.5" preserveAspectRatio="none" className="overflow-visible">
                      <line
                        x1="0" y1="0.75" x2="100" y2="0.75"
                        stroke="var(--color-panik-orange)"
                        strokeWidth="1.5"
                        className={`lm-svg-draw-path ${animateStep >= 4 ? 'lm-draw-anim' : ''}`}
                      />
                    </svg>
                  </div>
                  {/* ALERT to ACT */}
                  <div className="lm-connector-wrapper lm-conn-4">
                    <svg width="100%" height="1.5" viewBox="0 0 100 1.5" preserveAspectRatio="none" className="overflow-visible">
                      <line
                        x1="0" y1="0.75" x2="100" y2="0.75"
                        stroke="var(--color-panik-orange)"
                        strokeWidth="1.5"
                        className={`lm-svg-draw-path ${animateStep >= 5 ? 'lm-draw-anim' : ''}`}
                      />
                    </svg>
                  </div>

                  {/* Track Grid with Nodes */}
                  <div className="lm-track-grid">
                    <div className="lm-cell">
                      <div className={`lm-node lm-node-panik ${animateStep >= 1 ? "lm-light-up" : ""} ${showPulse ? "lm-pulse" : ""}`}></div>
                    </div>
                    <div className="lm-cell">
                      <div className={`lm-node lm-node-panik ${animateStep >= 2 ? "lm-light-up" : ""} ${showPulse ? "lm-pulse" : ""}`}></div>
                    </div>
                    <div className="lm-cell">
                      <div className={`lm-node lm-node-panik ${animateStep >= 3 ? "lm-light-up" : ""} ${showPulse ? "lm-pulse" : ""}`}></div>
                    </div>
                    <div className="lm-cell">
                      <div className={`lm-node lm-node-panik ${animateStep >= 4 ? "lm-light-up" : ""} ${showPulse ? "lm-pulse" : ""}`}></div>
                    </div>
                    <div className="lm-cell">
                      <div className={`lm-node lm-node-panik ${animateStep >= 5 ? "lm-light-up" : ""} ${showPulse ? "lm-pulse" : ""}`}></div>
                    </div>
                  </div>
                </div>

                {/* 100% CORE SHIELD badge */}
                <div className={`lm-panik-badge ${showBadge ? 'lm-badge-show' : ''}`}>
                  ✓ 100% CORE SHIELD
                </div>
              </div>

            </div>

          </div>

        </div>
      </div>
    </section>
  );
}

function TerminalLog() {
  const [logs, setLogs] = useState<string[]>([logTemplates[0].text]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentLineIndex((prev) => {
        const nextIdx = (prev + 1) % logTemplates.length;
        setLogs((current) => {
          const nextLines = [...current, logTemplates[nextIdx].text];
          if (nextLines.length > 3) {
            nextLines.shift();
          }
          return nextLines;
        });
        return nextIdx;
      });
    }, 3200);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="bg-surface-base border-t border-border-subtle p-3 rounded-none font-mono text-2xs relative overflow-hidden h-[72px] flex flex-col justify-between shrink-0">
      <div className="flex items-center justify-between mb-1.5 text-2xs text-text-muted uppercase tracking-widest leading-none shrink-0 select-none">
        <span>SYSTEM REGULAR TELEMETRY</span>
      </div>
      
      {/* scrolling typed lines feed */}
      <div className="flex-1 overflow-hidden relative flex flex-col justify-end space-y-1">
        <AnimatePresence initial={false}>
          {logs.map((textLine, index) => {
            const isLatest = index === logs.length - 1;
            
            // Deduce the level type based on original templates
            const matchedTemplate = logTemplates.find(t => t.text === textLine) || { type: "[INFO]" };
            const typeLabel = matchedTemplate.type;
            const isRedColor = typeLabel === "[ERR]";
            const isAmberColor = typeLabel === "[WARN]";
            const isTealColor = typeLabel === "[INFO]";

            const colorClass = isLatest
              ? isRedColor ? "text-risk-critical" : isAmberColor ? "text-risk-elevated" : "text-risk-low/80"
              : "text-text-muted";

            return (
              <motion.div
                key={textLine + "-" + index}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className={`truncate pr-2 ${colorClass}`}
              >
                {isLatest ? (
                  <TypewriterText label={typeLabel} text={textLine} colorClass={colorClass} />
                ) : (
                  <div className="flex gap-2">
                    <span className="font-bold shrink-0">{typeLabel}</span>
                    <span className="truncate">{textLine}</span>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

function TypewriterText({ label, text, colorClass }: { label: string; text: string; colorClass: string }) {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    setDisplayed("");
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.substring(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
      }
    }, 12);
    return () => clearInterval(interval);
  }, [text]);

  return (
    <span className="flex gap-2 leading-relaxed h-3.5">
      <span className="font-bold shrink-0">{label}</span>
      <span className="truncate">
        {displayed}
      </span>
    </span>
  );
}
