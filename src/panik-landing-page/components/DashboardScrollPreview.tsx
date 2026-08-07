/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState, useEffect } from "react";
import { 
  ShieldCheck, 
  Wallet, 
  Compass, 
  Eye, 
  Sparkles, 
  ShieldAlert, 
  Settings,
  Activity,
  HelpCircle,
  CheckCircle,
  Sliders,
  Bell,
} from "lucide-react";
import { motion, useScroll, useTransform, AnimatePresence } from "motion/react";
import { calculateDynamicPosition, formatCurrency } from "../utils";

const SIDEBAR_TABS = [
  { id: "portfolio", label: "Portfolio", icon: Wallet },
  { id: "compass", label: "Compass", icon: Compass },
  { id: "watch", label: "Watch", icon: Eye },
  { id: "advisor", label: "Advisor", icon: Sparkles },
] as const;

const LOOP_TABS = ["portfolio", "compass", "watch", "advisor"] as const;

type TabId = typeof SIDEBAR_TABS[number]["id"];

export function DashboardScrollPreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>("portfolio");
  const [isHovered, setIsHovered] = useState(false);
  const [isResolved, setIsResolved] = useState(false);

  const [collateralAmount, setCollateralAmount] = useState<number>(1.2);
  const [borrowAmount, setBorrowAmount] = useState<number>(2000);
  const [assetPrice, setAssetPrice] = useState<number>(3700);

  // Synchronize state values when isResolved changes so the static actions/buttons still work
  useEffect(() => {
    if (isResolved) {
      setBorrowAmount(1000);
      setAssetPrice(3700);
    } else {
      setBorrowAmount(2000);
      setAssetPrice(3300);
    }
  }, [isResolved]);

  const positionState = calculateDynamicPosition(
    "Moonwell",
    collateralAmount,
    borrowAmount,
    assetPrice
  );
  
  // Track scroll progress across the container's scroll zone
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start end", "end start"],
  });

  // Map scroll progress to transform styles for the mockup card itself
  // 0.0 is offscreen bottom. It centers in sticky mode and grows.
  const scale = useTransform(scrollYProgress, [0.0, 0.42], [0.83, 1.0]);
  const rotateX = useTransform(scrollYProgress, [0.0, 0.4], [14, 0]);
  const overlayOpacity = useTransform(scrollYProgress, [0.0, 0.35], [0.9, 0]);
  const y = useTransform(scrollYProgress, [0, 1], [0, 0]); // Zero out default travel to let sticky center handle pinning

  // General content visibility opacities during core scroll reveal - keep always high so it stays fully beautiful
  const workspaceOpacity = useTransform(scrollYProgress, [0.0, 0.15], [0.85, 1.0]);

  // Dynamic entry curves for the custom floating badges (semicircle and eye shapes) matching the mockups
  const leftWidgetOpacity = useTransform(scrollYProgress, [0.12, 0.38], [0, 1]);
  const leftWidgetScale = useTransform(scrollYProgress, [0.12, 0.38], [0.65, 1]);
  const leftWidgetY = useTransform(scrollYProgress, [0.12, 0.38], [30, 0]);

  const rightWidgetOpacity = useTransform(scrollYProgress, [0.15, 0.42], [0, 1]);
  const rightWidgetScale = useTransform(scrollYProgress, [0.15, 0.42], [0.65, 1]);
  const rightWidgetY = useTransform(scrollYProgress, [0.15, 0.42], [30, 0]);

  // Tab dynamic looping handler - cycles every 3 seconds unless hovered
  useEffect(() => {
    if (isHovered) return; // Pause auto-rotation when user is hovering/interacting

    const interval = setInterval(() => {
      setActiveTab((prev) => {
        const currentIndex = LOOP_TABS.indexOf(prev as any);
        if (currentIndex === -1) {
          return LOOP_TABS[0];
        }
        const nextIndex = (currentIndex + 1) % LOOP_TABS.length;
        return LOOP_TABS[nextIndex];
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [isHovered]);

  return (
    <section 
      ref={containerRef} 
      className="relative w-full h-[190vh] sm:h-[210vh] bg-transparent flex flex-col items-center justify-start overflow-visible z-20 mt-12 mb-16"
      id="how-it-works"
    >
      {/* Sticky viewport content container holding the mockup to provide the central lock interaction */}
      <div className="sticky top-[14vh] sm:top-[16vh] h-[68vh] sm:h-[72vh] w-full flex items-center justify-center overflow-visible px-6 z-20">
        
        {/* Background radial soft light flares */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-gradient-to-tr from-panik-orange/10 via-panik-orange/[0.02] to-transparent rounded-full blur-3xl pointer-events-none"></div>

        {/* Outer 3D Perspective Frame Wrapper of Dashboard Mockup */}
        <div className="w-full max-w-5xl relative flex items-center justify-center" style={{ perspective: "1500px" }}>
          
          {/* LEFT INTERACTIVE BADGE: Revised Semicircle Risk Compass (floating bottom-left) */}
          <motion.div
            style={{ 
              opacity: leftWidgetOpacity, 
              scale: leftWidgetScale, 
              y: leftWidgetY,
              transformStyle: "preserve-3d"
            }}
            className="absolute -left-3 sm:-left-12 md:-left-16 lg:-left-24 bottom-[8%] sm:bottom-[15%] z-50 hidden xs:flex flex-col select-none"
          >
            <div className="bg-surface-raised/90 backdrop-blur-xl border border-border-subtle shadow-[0_20px_50px_rgba(0,0,0,0.55)] rounded-lg w-28 h-28 sm:w-34 sm:h-34 flex flex-col justify-center items-center p-3 text-center relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
              
              {/* Compass SVG */}
              <svg width="60" height="42" viewBox="0 0 60 42" className="mt-1">
                <defs>
                  <linearGradient id="compass-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="var(--color-panik-orange)" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="var(--color-panik-orange)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                
                {/* Revised semicircle with flat top and curved bottom tracking */}
                <path 
                  d="M 12 10 A 18 18 0 0 0 48 10 Z" 
                  fill="url(#compass-grad)" 
                  stroke="var(--color-panik-orange)" 
                  strokeWidth="1.5" 
                  strokeOpacity="0.85" 
                />
                
                {/* Embedded compass dial markings */}
                <path 
                  d="M 17 10 A 13 13 0 0 0 43 10" 
                  fill="none" 
                  stroke="white" 
                  strokeWidth="1" 
                  strokeOpacity="0.18" 
                  strokeDasharray="2 2"
                />

                {/* Needle Pivot point in standard top-center location of semicircle */}
                <circle cx="30" cy="10" r="2" fill="var(--color-surface-raised)" stroke="var(--color-panik-orange)" strokeWidth="1.5" />
                
                {/* Compass Needle (Pointer) - rotates gently on timer */}
                <motion.g
                  animate={{ rotate: [-20, 25, -10, 30, -30, 15, -15] }}
                  transition={{ repeat: Infinity, duration: 7, ease: "easeInOut" }}
                  style={{ transformOrigin: "30px 10px" }}
                >
                  {/* Pointing downward needle representation */}
                  <polygon points="30,10 27,22 30,28 33,22" fill="var(--color-panik-orange)" />
                  <circle cx="30" cy="28" r="1.5" fill="var(--color-risk-elevated)" />
                </motion.g>

                {/* Additional micro-technical accents */}
                <line x1="8" y1="10" x2="12" y2="10" stroke="var(--color-panik-orange)" strokeWidth="1.2" strokeOpacity="0.6" />
                <line x1="48" y1="10" x2="52" y2="10" stroke="var(--color-panik-orange)" strokeWidth="1.2" strokeOpacity="0.6" />
              </svg>
              
              {/* Semicircle Compass Labels */}
              <div className="mt-2.5 space-y-0.5">
                <span className="block text-2xs font-mono uppercase tracking-[0.1em] text-text-secondary font-bold">Risk Compass</span>
                <span className="block text-2xs font-mono tracking-wider text-panik-orange font-bold">BEARING SECURED</span>
              </div>
            </div>
          </motion.div>

          {/* RIGHT INTERACTIVE BADGE: Revised Abstract Eye Overlapping Triangles (floating top-right) */}
          <motion.div
            style={{ 
              opacity: rightWidgetOpacity, 
              scale: rightWidgetScale, 
              y: rightWidgetY,
              transformStyle: "preserve-3d"
            }}
            className="absolute -right-3 sm:-right-12 md:-right-16 lg:-right-24 top-[10%] sm:top-[12%] z-50 hidden xs:flex flex-col select-none"
          >
            <div className="bg-surface-raised/90 backdrop-blur-xl border border-border-subtle shadow-[0_20px_50px_rgba(0,0,0,0.55)] rounded-lg w-28 h-28 sm:w-34 sm:h-34 flex flex-col justify-center items-center p-3 text-center relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />

              {/* Overlapping Triangles Eye SVG */}
              <svg width="60" height="42" viewBox="0 0 60 42" className="mt-1">
                <defs>
                  <linearGradient id="tri-orange" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="var(--color-panik-orange)" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="var(--color-panik-orange)" stopOpacity="0.05" />
                  </linearGradient>
                  <linearGradient id="tri-indigo" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="var(--color-indigo-500)" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="var(--color-indigo-500)" stopOpacity="0.05" />
                  </linearGradient>
                </defs>
                
                {/* Left Triangle - Pointing Right (The standard first layer) */}
                <polygon 
                  points="14,10 44,22 14,34" 
                  fill="url(#tri-orange)" 
                  stroke="var(--color-panik-orange)" 
                  strokeWidth="1.5" 
                  strokeOpacity="0.8" 
                />
                
                {/* Right Triangle - Overlapping, pointing leftwards to complete the symmetrical eye outline */}
                <polygon 
                  points="46,10 16,22 46,34" 
                  fill="url(#tri-indigo)" 
                  stroke="var(--color-indigo-500)" 
                  strokeWidth="1.5" 
                  strokeOpacity="0.8" 
                />

                {/* Abstract Pupil/Lens centered in the intersection aperture */}
                <motion.circle 
                  cx="30" 
                  cy="22" 
                  r="3.5" 
                  fill="var(--color-risk-elevated)"
                  animate={{ scale: [1, 1.25, 1], opacity: [0.8, 1, 0.8] }}
                  transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                />
                <circle 
                  cx="30" 
                  cy="22" 
                  r="6.5" 
                  fill="none" 
                  stroke="var(--color-indigo-500)" 
                  strokeWidth="1" 
                  strokeOpacity="0.7" 
                  strokeDasharray="2 2" 
                />
                <circle 
                  cx="30" 
                  cy="22" 
                  r="1.2" 
                  fill="white" 
                />
              </svg>

              {/* Eye Labels */}
              <div className="mt-2.5 space-y-0.5">
                <span className="block text-2xs font-mono uppercase tracking-[0.15em] text-text-secondary font-bold">Sentinel View</span>
                <span className="block text-2xs font-mono tracking-wider text-indigo-500 font-bold">AUTOSHUTTER ARMED</span>
              </div>
            </div>
          </motion.div>

          {/* Animated mockup container */}
          <motion.div
            style={{
              scale,
              rotateX,
              y,
              transformStyle: "preserve-3d"
            }}
            className="w-full h-[480px] sm:h-[560px] md:h-[600px] bg-surface-raised rounded-lg border border-border-subtle shadow-2xl relative overflow-hidden transition-shadow duration-300 hover:shadow-panik-orange/[0.02] shrink-0"
            id="dashboard-scrolling-mockup"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            {/* Top MacOS-Style Window Browser Control Header Bar */}
            <div className="h-11 bg-surface-raised border-b border-border-subtle flex items-center justify-between px-5 select-none shrink-0 z-40 relative">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-risk-critical/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-risk-elevated/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-risk-low/80"></span>
              </div>
          </div>

          {/* Inner Layout Container */}
          <div className="flex h-full w-full bg-surface-base">
            
            {/* Sidebar View */}
            <aside className="w-48 border-r border-surface-overlay bg-surface-sunken p-4 flex flex-col justify-between shrink-0 select-none z-30 font-mono">
              <div className="space-y-6">
                <div className="flex items-center gap-2">
                  <img src="/panik-logo.png" alt="PANIK" width={24} height={24} style={{ objectFit: "contain" }} />
                  <div className="flex flex-col text-left">
                    <span className="font-sans font-black text-2xs tracking-wider text-text-primary leading-none">PANIK</span>
                  </div>
                </div>

                <nav className="space-y-1">
                  {SIDEBAR_TABS.map((tab) => {
                    const IconComponent = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-2xs font-mono uppercase tracking-wider transition-all border cursor-pointer ${
                          isActive 
                            ? "text-text-primary bg-surface-overlay font-black border-border-subtle" 
                            : "text-text-secondary hover:text-text-primary border-transparent hover:bg-white/[0.01]"
                        }`}
                      >
                        <IconComponent className={`w-3.5 h-3.5 static ${isActive ? "text-panik-orange" : "text-text-muted"}`} />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </nav>
              </div>

              <div className="pt-4 border-t border-border-subtle mt-auto">
                <div className="flex items-center gap-1.5 text-2xs font-mono text-text-secondary uppercase font-bold hover:text-text-primary transition-colors cursor-pointer">
                  <span>←</span>
                  <span>Back to Landing</span>
                </div>
              </div>
            </aside>

            {/* Dashboard Workspace */}
            <motion.div 
              style={{ opacity: workspaceOpacity }}
              className="flex-1 p-5 overflow-hidden flex flex-col gap-3 relative"
            >
              
              {/* Header metrics */}
              <div className="flex justify-end items-center pb-2 border-b border-border-subtle shrink-0">
                <div className="flex gap-3 text-2xs font-mono items-center">
                  <div className="text-text-secondary">EST GAS: <span className="text-risk-low font-bold bg-risk-low/10 px-1.5 py-0.5 rounded-sm border border-risk-low/20">2.8 GWEI</span></div>
                  <div className="text-text-secondary border border-border-subtle px-2 py-0.5 rounded-sm bg-white/[0.02] flex items-center gap-1 font-bold">
                    <Wallet className="w-2.5 h-2.5 text-panik-orange" />
                    <span>0x8F94...42fA</span>
                  </div>
                </div>
              </div>
              {/* View Content Area with dynamic crossfade motion */}
              <div className="flex-1 min-h-0 relative">
                <AnimatePresence mode="wait">
                  
                  {/* --- Tab 1: PORTFOLIO SCREEN --- */}
                  {activeTab === "portfolio" && (
                    <motion.div
                      key="portfolio"
                      initial={{ opacity: 0, scale: 0.98, y: 5 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98, y: -5 }}
                      transition={{ duration: 0.15 }}
                      className="flex flex-col gap-3.5 h-full text-left font-sans"
                    >
                      <div className="space-y-0.5">
                        <h2 className="text-sm sm:text-base font-sans font-medium text-text-primary tracking-tight">DeFi Portfolio</h2>
                        <p className="text-2xs text-text-secondary">
                          Insured capital backing and automated flash hedges across monitored vaults
                        </p>
                      </div>

                      <div className="grid grid-cols-4 gap-2">
                        {/* Card 1 */}
                        <div className="bg-surface-raised/90 border border-border-subtle p-2 rounded-md flex flex-col justify-between text-left h-[64px]">
                          <span className="text-2xs font-mono font-bold text-text-secondary uppercase tracking-wider">INSURED CAPITAL</span>
                          <div className="text-xs sm:text-sm font-mono font-black tracking-tight text-text-primary">$18,450</div>
                          <div className="flex items-center gap-1 text-2xs font-mono text-risk-low bg-risk-low/10 px-1.5 py-0.5 rounded-sm border border-risk-low/15 self-start font-bold">
                            <span className="w-1 h-1 rounded-full bg-risk-low" />
                            <span>Guard active</span>
                          </div>
                        </div>

                        {/* Card 2 */}
                        <div className="bg-surface-raised/90 border border-border-subtle p-2 rounded-md flex flex-col justify-between text-left h-[64px]">
                          <span className="text-2xs font-mono font-bold text-text-secondary uppercase tracking-wider">INSURED LIABILITIES</span>
                          <div className="text-xs sm:text-sm font-mono font-black tracking-tight text-text-primary">$9,310</div>
                          <span className="text-2xs font-mono text-text-secondary" style={{ contentVisibility: "auto" }}>Net LTV ratio: 50%</span>
                        </div>

                        {/* Card 3 */}
                        <div className="bg-surface-raised/90 border border-border-subtle p-2 rounded-md flex flex-col justify-between text-left h-[64px]">
                          <span className="text-2xs font-mono font-bold text-text-secondary uppercase tracking-wider">MULTI-CHAIN POOLS</span>
                          <div className="text-xs sm:text-sm font-mono font-black tracking-tight text-panik-orange">4 Pools</div>
                          <span className="text-2xs font-mono text-text-secondary truncate">Aave, Compound, Moonwell</span>
                        </div>

                        {/* Card 4 */}
                        <div className="bg-surface-raised/90 border border-border-subtle p-2 rounded-md flex flex-col justify-between text-left h-[64px]">
                          <span className="text-2xs font-mono font-bold text-text-secondary uppercase tracking-wider">AGGREGATE RISK INDEX</span>
                          <div className="text-xs sm:text-sm font-mono font-black tracking-tight text-text-primary">
                            <span className="text-risk-low">22</span> <span className="text-text-muted">/</span> <span className="text-text-secondary text-2xs">100</span>
                          </div>
                          <span className="text-2xs font-mono text-risk-low font-bold">SECURE HEALTH STATUS</span>
                        </div>
                      </div>

                      {/* Connected DeFi positions & allocation columns */}
                      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0 overflow-hidden">
                        
                        {/* Connected Position List */}
                        <div className="col-span-7 flex flex-col gap-1.5 overflow-y-auto pr-1 scrollbar-none">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className="text-2xs font-mono font-bold tracking-wider text-text-secondary uppercase">
                              LIST OF CONNECTED DEFI POSITIONS
                            </span>
                            <span className="text-2xs font-mono font-bold text-panik-orange uppercase tracking-wide">
                              ACTIVE GUARDRAILS
                            </span>
                          </div>

                          {/* Position 1 */}
                          <div className="bg-surface-raised/60 border border-border-subtle p-2 rounded-md flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-6.5 h-6.5 rounded-sm bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0 overflow-hidden">
                                <img src="/aave-logo.png" alt="Aave" className="w-full h-full object-contain" />
                              </div>
                              <div className="text-left font-mono">
                                <div className="text-2xs font-black text-text-primary">Aave V3 • USDC SUPPLY BUFFER</div>
                                <div className="text-2xs text-text-secondary">
                                  <span className="text-risk-low font-bold">Conforms to Profile</span> • Score: <strong className="text-text-primary">12</strong>
                                </div>
                                <div className="text-2xs text-text-secondary">
                                  Health Factor: <strong className="text-risk-low">2.3</strong>
                                </div>
                              </div>
                            </div>
                            <button className="text-2xs font-mono uppercase tracking-wide border border-panik-orange/25 text-panik-orange px-1.5 py-0.5 rounded-sm bg-panik-orange/5 hover:bg-panik-orange/10 font-bold shrink-0 cursor-pointer">
                              View Risk Breakdown →
                            </button>
                          </div>

                          {/* Position 2 */}
                          <div className="bg-surface-raised/60 border border-border-subtle p-2 rounded-md flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-6.5 h-6.5 rounded-sm bg-risk-low/20 border border-risk-low/30 flex items-center justify-center shrink-0 overflow-hidden">
                                <img src="/compound-logo.png" alt="Compound" className="w-full h-full object-contain" />
                              </div>
                              <div className="text-left font-mono">
                                <div className="text-2xs font-black text-text-primary">Compound • USDT LIQUIDITY YIELD</div>
                                <div className="text-2xs text-text-secondary">
                                  <span className="text-risk-low font-bold">Conforms to Profile</span> • Score: <strong className="text-text-primary">15</strong>
                                </div>
                                <div className="text-2xs text-text-secondary">
                                  Health Factor: <strong className="text-risk-low">2.25</strong>
                                </div>
                              </div>
                            </div>
                            <button className="text-2xs font-mono uppercase tracking-wide border border-panik-orange/25 text-panik-orange px-1.5 py-0.5 rounded-sm bg-panik-orange/5 hover:bg-panik-orange/10 font-bold shrink-0 cursor-pointer">
                              View Risk Breakdown →
                            </button>
                          </div>

                          {/* Position 3 */}
                          <div className="bg-surface-raised/60 border border-border-subtle p-2 rounded-md flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-6.5 h-6.5 rounded-sm bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0 overflow-hidden">
                                <img src="/aave-logo.png" alt="Aave" className="w-full h-full object-contain" />
                              </div>
                              <div className="text-left font-mono">
                                <div className="text-2xs font-black text-text-primary">Aave V3 • wstETH / USDC VAULT</div>
                                <div className="text-2xs text-text-secondary">
                                  <span className="text-panik-orange font-bold">Outside Profile</span> • Score: <strong className="text-text-primary">24</strong>
                                </div>
                                <div className="text-2xs text-text-secondary">
                                  Health Factor: <strong className="text-panik-orange">2.1</strong>
                                </div>
                              </div>
                            </div>
                            <button className="text-2xs font-mono uppercase tracking-wide border border-panik-orange/25 text-panik-orange px-1.5 py-0.5 rounded-sm bg-panik-orange/5 hover:bg-panik-orange/10 font-bold shrink-0 cursor-pointer">
                              View Risk Breakdown →
                            </button>
                          </div>

                        </div>

                        {/* Divider Line */}
                        <div className="col-span-1 flex justify-center py-1">
                          <div className="border-r border-border-subtle w-px h-full" />
                        </div>

                        {/* Asset Weight block */}
                        <div className="col-span-4 flex flex-col gap-1.5 text-left">
                          <div>
                            <span className="block text-2xs font-mono font-bold tracking-wider text-text-secondary uppercase mb-0.5">
                              ASSET ALLOCATION WEIGHT
                            </span>
                            <p className="text-2xs text-text-secondary leading-relaxed">
                              Breakdown of collateral distributions backing protected vaults.
                            </p>
                          </div>

                          {/* Multi-segmented weight bar */}
                          <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden flex mt-0.5 shrink-0">
                            <div className="h-full bg-violet-500" style={{ width: "43.5%" }} />
                            <div className="h-full bg-blue-500" style={{ width: "37.9%" }} />
                            <div className="h-full bg-panik-orange" style={{ width: "10.5%" }} />
                            <div className="h-full bg-risk-low" style={{ width: "8.1%" }} />
                          </div>

                          {/* Legends */}
                          <div className="space-y-1 mt-0.5 font-mono text-2xs overflow-y-auto max-h-[110px] pr-0.5">
                            {/* Legend item 1 */}
                            <div className="flex justify-between items-center bg-white/[0.01] border border-border-subtle rounded-md p-1.5">
                              <div className="flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-violet-500" />
                                <span className="text-text-primary font-medium truncate">wstETH</span>
                              </div>
                              <div className="text-right">
                                <span className="block text-text-primary font-bold">$8,022</span>
                                <span className="text-2xs text-text-secondary">43.5%</span>
                              </div>
                            </div>

                            {/* Legend item 2 */}
                            <div className="flex justify-between items-center bg-white/[0.01] border border-border-subtle rounded-md p-1.5">
                              <div className="flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-blue-500" />
                                <span className="text-text-primary font-medium truncate">USDC Spot</span>
                              </div>
                              <div className="text-right">
                                <span className="block text-text-primary font-bold">$7,000</span>
                                <span className="text-2xs text-text-secondary">37.9%</span>
                              </div>
                            </div>

                            {/* Legend item 3 */}
                            <div className="flex justify-between items-center bg-white/[0.01] border border-border-subtle rounded-md p-1.5">
                              <div className="flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-panik-orange" />
                                <span className="text-text-primary font-medium truncate">ETH Spot</span>
                              </div>
                              <div className="text-right">
                                <span className="block text-text-primary font-bold">$1,928</span>
                                <span className="text-2xs text-text-secondary">10.5%</span>
                              </div>
                            </div>

                            {/* Legend item 4 */}
                            <div className="flex justify-between items-center bg-white/[0.01] border border-border-subtle rounded-md p-1.5">
                              <div className="flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-risk-low" />
                                <span className="text-text-primary font-medium truncate">USDT Pool</span>
                              </div>
                              <div className="text-right">
                                <span className="block text-text-primary font-bold">$1,500</span>
                                <span className="text-2xs text-text-secondary">8.1%</span>
                              </div>
                            </div>

                          </div>
                        </div>

                      </div>
                    </motion.div>
                  )}

                  {/* --- Tab 2: COMPASS SCREEN (Discovery) --- */}
                  {activeTab === "compass" && (
                    <motion.div
                      key="compass"
                      initial={{ opacity: 0, scale: 0.98, y: 5 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98, y: -5 }}
                      transition={{ duration: 0.2 }}
                      className="flex flex-col gap-3.5 h-full text-left overflow-y-auto pr-1 scrollbar-none font-sans"
                    >
                      {/* Compass Header with Profile Level Controls */}
                      <div className="flex justify-between items-center shrink-0">
                        <div>
                          <h2 className="text-sm sm:text-base font-sans font-medium text-text-primary tracking-tight leading-none">Compass</h2>
                          <p className="text-2xs text-text-secondary font-mono mt-1">
                            Find positions matching your risk profile
                          </p>
                        </div>
                        <div className="flex bg-surface-raised border border-border-subtle rounded-md p-0.5 text-2xs font-mono font-bold">
                          <span className="px-2 py-1 text-text-muted transition-colors">CONSERVATIVE</span>
                          <span className="px-2.5 py-1 text-panik-orange bg-panik-orange/10 border border-panik-orange/20 rounded-sm font-black">MODERATE</span>
                          <span className="px-2 py-1 text-text-muted transition-colors">AGGRESSIVE</span>
                        </div>
                      </div>

                      {/* --- Section 1: Recommended For Profile --- */}
                      <div className="space-y-2">
                        <div className="flex items-center text-2xs font-mono font-bold text-text-primary uppercase tracking-wider">
                          <span>RECOMMENDED FOR YOUR MODERATE PROFILE</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {/* Card 1: Aave V3 WstETH/USDC */}
                          <div className="bg-surface-raised/60 border border-border-subtle p-3 rounded-md flex flex-col justify-between text-left relative overflow-hidden">
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <img src="/aave-logo.png" alt="Aave" className="w-7 h-7 rounded-sm shrink-0 object-contain" />
                                <div className="text-left font-mono">
                                  <h4 className="text-2xs font-black text-text-primary leading-tight">Aave V3</h4>
                                  <p className="text-2xs text-text-secondary uppercase tracking-wide leading-none mt-0.5">WSTETH / USDC VAULT</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 text-2xs font-mono text-risk-low bg-risk-low/10 px-1.5 py-0.5 rounded-sm border border-risk-low/25 font-bold">
                                <span>24 LOW</span>
                                <Sliders className="w-2.5 h-2.5 text-risk-low" />
                              </div>
                            </div>

                            <div className="text-2xs font-mono font-bold text-risk-low mb-2.5">
                              APY Rate: 5.2%
                            </div>

                            <div className="border-t border-border-subtle pt-2 mb-2">
                              <div className="grid grid-cols-3 gap-1 text-left font-mono">
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">PROTOCOL INDEX</span>
                                  <span className="text-2xs font-black text-text-primary">18</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POOL COUNT</span>
                                  <span className="text-2xs font-black text-text-primary">12</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POSITION COUNT</span>
                                  <span className="text-2xs font-black text-text-primary">9</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex justify-between items-center text-2xs font-mono pt-1">
                              <span className="text-text-muted text-2xs">Active sentinel protection</span>
                              <button className="text-2xs font-bold text-panik-orange border border-panik-orange/25 px-1.5 py-0.5 rounded-sm bg-panik-orange/5 hover:bg-panik-orange/10 transition-colors uppercase cursor-pointer">
                                Audit &amp; Simulate →
                              </button>
                            </div>
                          </div>

                          {/* Card 2: Compound USDC Borrow */}
                          <div className="bg-surface-raised/60 border border-border-subtle p-3 rounded-md flex flex-col justify-between text-left relative overflow-hidden">
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-sm bg-risk-low/20 border border-risk-low/30 flex items-center justify-center shrink-0 overflow-hidden">
                                  <img src="/compound-logo.png" alt="Compound" className="w-full h-full object-contain" />
                                </div>
                                <div className="text-left font-mono">
                                  <h4 className="text-2xs font-black text-text-primary leading-tight">Compound</h4>
                                  <p className="text-2xs text-text-secondary uppercase tracking-wide leading-none mt-0.5">USDC BORROW MARGIN</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 text-2xs font-mono text-panik-orange bg-panik-orange/10 px-1.5 py-0.5 rounded-sm border border-panik-orange/25 font-bold">
                                <span>31 ELEVATED</span>
                                <Sliders className="w-2.5 h-2.5 text-panik-orange" />
                              </div>
                            </div>

                            <div className="text-2xs font-mono font-bold text-risk-low mb-2.5">
                              APY Rate: 6.9%
                            </div>

                            <div className="border-t border-border-subtle pt-2 mb-2">
                              <div className="grid grid-cols-3 gap-1 text-left font-mono">
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">PROTOCOL INDEX</span>
                                  <span className="text-2xs font-black text-text-primary">16</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POOL COUNT</span>
                                  <span className="text-2xs font-black text-text-primary">14</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POSITION COUNT</span>
                                  <span className="text-2xs font-black text-text-primary">12</span>
                                </div>
                              </div>
                            </div>

                            <div className="flex justify-between items-center text-2xs font-mono pt-1">
                              <span className="text-text-muted text-2xs">Active sentinel protection</span>
                              <button className="text-2xs font-bold text-panik-orange border border-panik-orange/25 px-1.5 py-0.5 rounded-sm bg-panik-orange/5 hover:bg-panik-orange/10 transition-colors uppercase cursor-pointer">
                                Audit &amp; Simulate →
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* --- Section 2: Outside Your Profile --- */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-2xs font-mono font-bold text-risk-critical uppercase tracking-wider">
                          <span className="w-1.5 h-1.5 rounded-full bg-risk-critical" />
                          <span>OUTSIDE YOUR PROFILE</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {/* Card 3: Aave V3 USDC Buffer */}
                          <div className="bg-surface-raised/30 border border-border-subtle p-3 rounded-md flex flex-col justify-between text-left relative overflow-hidden opacity-85">
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <img src="/aave-logo.png" alt="Aave" className="w-7 h-7 rounded-sm shrink-0 object-contain" />
                                <div className="text-left font-mono">
                                  <h4 className="text-2xs font-black text-text-primary leading-tight">Aave V3</h4>
                                  <p className="text-2xs text-text-secondary uppercase tracking-wide leading-none mt-0.5">USDC SUPPLY BUFFER</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 text-2xs font-mono text-risk-low bg-risk-low/5 px-1.5 py-0.5 rounded-sm border border-risk-low/15 leading-none">
                                <span>12 LOW</span>
                                <Sliders className="w-2.5 h-2.5 text-risk-low" />
                              </div>
                            </div>

                            <div className="text-2xs font-mono font-bold text-text-secondary mb-2.5">
                              APY Rate: 8.2%
                            </div>

                            <div className="border-t border-border-subtle pt-2 mb-2">
                              <div className="grid grid-cols-3 gap-1 text-left font-mono">
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">PROTOCOL INDEX</span>
                                  <span className="text-2xs font-black text-text-secondary">12</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POOL COUNT</span>
                                  <span className="text-2xs font-black text-text-secondary">8</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POSITION COUNT</span>
                                  <span className="text-2xs font-black text-text-secondary">4</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Card 4: Compound USDT Yield */}
                          <div className="bg-surface-raised/30 border border-border-subtle p-3 rounded-md flex flex-col justify-between text-left relative overflow-hidden opacity-85">
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-sm bg-risk-low/20 border border-risk-low/30 flex items-center justify-center shrink-0 overflow-hidden">
                                  <img src="/compound-logo.png" alt="Compound" className="w-full h-full object-contain" />
                                </div>
                                <div className="text-left font-mono">
                                  <h4 className="text-2xs font-black text-text-primary leading-tight">Compound</h4>
                                  <p className="text-2xs text-text-secondary uppercase tracking-wide leading-none mt-0.5">USDT LIQUIDITY YIELD</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 text-2xs font-mono text-risk-low bg-risk-low/5 px-1.5 py-0.5 rounded-sm border border-risk-low/15 leading-none">
                                <span>15 LOW</span>
                                <Sliders className="w-2.5 h-2.5 text-risk-low" />
                              </div>
                            </div>

                            <div className="text-2xs font-mono font-bold text-text-secondary mb-2.5">
                              APY Rate: 7.4%
                            </div>

                            <div className="border-t border-border-subtle pt-2 mb-2">
                              <div className="grid grid-cols-3 gap-1 text-left font-mono">
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">PROTOCOL INDEX</span>
                                  <span className="text-2xs font-black text-text-secondary">14</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POOL COUNT</span>
                                  <span className="text-2xs font-black text-text-secondary">10</span>
                                </div>
                                <div>
                                  <span className="block text-2xs text-text-secondary uppercase tracking-wider leading-none mb-1">POSITION COUNT</span>
                                  <span className="text-2xs font-black text-text-secondary">7</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                    </motion.div>
                  )}

                  {/* --- Tab 3: WATCH SCREEN (Continuous Monitoring) --- */}
                  {activeTab === "watch" && (() => {
                    const riskScore = positionState.riskScore;
                    const trendNum = riskScore >= 75 ? 14 : riskScore >= 50 ? 9 : riskScore >= 25 ? 6 : -2;
                    const healthFactorScore = Math.max(5, Math.min(98, Math.round(100 - (positionState.healthFactor / 2.5) * 80)));
                    const assetVolatility = positionState.breakdown.assetVolatility;
                    const protocolSafety = positionState.breakdown.protocolSafety;
                    const systemicMarketStress = positionState.breakdown.systemicMarketStress;
                    const healthFactor = positionState.healthFactor;

                    // Strictly match the screenshot defaults but allow dynamic interaction
                    const isDefaultState = (assetPrice === 3700 && borrowAmount === 2000);
                    const displayRiskScore = isDefaultState ? 44 : riskScore;
                    const displayStatus = isDefaultState ? "ELEVATED" : positionState.status;
                    const trendColorClass = isDefaultState || riskScore <= 44 ? "text-risk-low" : "text-risk-critical";
                    const displayTrendStr = isDefaultState ? "▼ -14 in the last 24 hours" : (
                      riskScore > 44 ? `▲ +${riskScore - 30} in the last 24 hours` : `▼ ${riskScore - 58} in the last 24 hours`
                    );

                    const displayHealthFactor = isDefaultState ? "1.73" : healthFactor.toFixed(2);
                    const displayLTV = isDefaultState ? "45%" : `${Math.round((borrowAmount / (collateralAmount * assetPrice)) * 100)}%`;

                    const displayCollateralHealth = isDefaultState ? 45 : Math.round(positionState.breakdown.positionHealth);
                    const displayAssetVolatilityVal = isDefaultState ? 42 : Math.round(positionState.breakdown.assetVolatility);
                    const displayProtocolSafetyVal = isDefaultState ? 35 : Math.round(positionState.breakdown.protocolSafety);

                    return (
                      <motion.div
                        key="watch"
                        initial={{ opacity: 0, scale: 0.98, y: 5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: -5 }}
                        transition={{ duration: 0.2 }}
                        className="flex flex-col gap-3.5 h-full text-left overflow-y-auto pr-1 scrollbar-none font-sans"
                      >
                        {/* Two Columns Dashboard */}
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pb-4">
                          
                          {/* Left Column (Main Cockpit) */}
                          <div className="md:col-span-8 space-y-3">
                            
                            {/* Moonwell Detail Sandbox status */}
                            <div className="flex justify-between items-end border-b border-border-subtle pb-2 mb-3">
                              <div>
                                <span className="block text-2xs font-mono tracking-widest text-text-muted uppercase font-bold">ACTIVE PROTECTOR</span>
                                <h3 className="text-xs sm:text-base font-mono font-medium text-text-primary tracking-tight leading-none mt-1">Moonwell Detail Sandbox</h3>
                              </div>
                              <div className="flex flex-col items-end leading-none">
                                <span className="text-2xs font-mono text-text-muted uppercase tracking-widest mb-1 font-bold">DAEMON SENTINEL</span>
                                <span className="text-2xs font-mono text-risk-low bg-risk-low/5 px-2 py-1 rounded-sm border border-risk-low/30 flex items-center font-bold">
                                  SECURE WATCH
                                </span>
                              </div>
                            </div>
 
                            {/* Combined Panik Risk Index & Top Risk Drivers Panel to perfectly match mockup */}
                            <div className="p-3 bg-surface-sunken border border-border-subtle rounded-md flex flex-col sm:flex-row gap-4 relative overflow-hidden text-left">
                              
                              {/* Left half: Panik Risk Index */}
                              <div className="flex-1 flex flex-col justify-between pr-0 sm:pr-4 sm:border-r border-border-subtle">
                                <div>
                                  <div className="flex items-center gap-1 text-text-muted font-mono text-2xs uppercase tracking-wider mb-2 font-bold">
                                    <Activity className="w-3.5 h-3.5 text-panik-orange shrink-0" />
                                    <span>Panik Risk Index</span>
                                  </div>
 
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-2xl font-mono font-black tracking-tight text-risk-elevated">
                                      {displayRiskScore}
                                    </span>
                                    <span className="text-2xs font-mono text-text-muted">/ 100</span>
 
                                    <span className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded-sm border text-risk-elevated border-risk-elevated/30 bg-risk-elevated/5 leading-none">
                                      {displayStatus}
                                    </span>
                                  </div>
                                </div>
 
                                <div className="mt-2 pt-2 border-t border-border-subtle">
                                  <div className={`flex items-center gap-1 font-mono text-2xs ${trendColorClass} font-bold`}>
                                    {displayTrendStr}
                                  </div>
                                  <p className="text-2xs text-text-secondary leading-relaxed font-sans mt-1">
                                    Moderate leverage risk. Position is stable but vulnerable to short-term market volatile swings.
                                  </p>
                                </div>
                              </div>
 
                              {/* Right half: Top Risk Drivers */}
                              <div className="flex-1 space-y-3 font-mono">
                                <span className="block text-2xs tracking-wider text-text-muted uppercase font-bold">TOP RISK DRIVERS</span>
                                
                                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                                  {/* Driver 1: Health Factor */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-2xs font-bold">
                                      <span className="text-text-secondary">Health Factor</span>
                                      <span className="text-risk-elevated">45%</span>
                                    </div>
                                    <div className="h-1 bg-white/[0.03] rounded-full overflow-hidden">
                                      <div className="h-full bg-risk-elevated" style={{ width: "45%" }} />
                                    </div>
                                  </div>

                                  {/* Driver 2: Asset Volatility */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-2xs font-bold">
                                      <span className="text-text-secondary">Asset Volatility</span>
                                      <span className="text-blue-500">42%</span>
                                    </div>
                                    <div className="h-1 bg-white/[0.03] rounded-full overflow-hidden">
                                      <div className="h-full bg-blue-500" style={{ width: "42%" }} />
                                    </div>
                                  </div>

                                  {/* Driver 3: Protocol Risk */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-2xs font-bold">
                                      <span className="text-text-secondary">Protocol Risk</span>
                                      <span className="text-risk-low">35%</span>
                                    </div>
                                    <div className="h-1 bg-white/[0.03] rounded-full overflow-hidden">
                                      <div className="h-full bg-risk-low" style={{ width: "35%" }} />
                                    </div>
                                  </div>

                                  {/* Driver 4: Pool Conditions */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-2xs font-bold">
                                      <span className="text-text-secondary">Pool Conditions</span>
                                      <span className="text-panik-orange">48%</span>
                                    </div>
                                    <div className="h-1 bg-white/[0.03] rounded-full overflow-hidden">
                                      <span className="block h-full bg-panik-orange" style={{ width: "48%" }} />
                                    </div>
                                  </div>
                                </div>

                                {/* Footer with Info Icon */}
                                <div className="flex items-start gap-1.5 pt-2 border-t border-border-subtle text-2xs text-text-muted leading-normal font-sans">
                                  <HelpCircle className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                                  <span>
                                    Core parameters compiled from real-time pool triggers &amp; volatility parameters.
                                  </span>
                                </div>
                              </div>

                            </div>
 
                            {/* Core indicators row */}
                            <div className="grid grid-cols-2 gap-3">
                              <div className="bg-surface-sunken/85 border border-border-subtle p-3 rounded-md text-left">
                                <span className="text-2xs font-mono text-text-muted uppercase tracking-wider font-bold">HEALTH FACTOR</span>
                                <div className="text-base font-mono font-black text-risk-low mt-1 mb-0.5">
                                  {displayHealthFactor}
                                </div>
                                <span className="text-2xs font-mono text-text-muted leading-none">Liquidation trigger limit is &lt; 1.00</span>
                              </div>
 
                              <div className="bg-surface-sunken/85 border border-border-subtle p-3 rounded-md text-left">
                                <span className="text-2xs font-mono text-text-muted uppercase tracking-wider font-bold">POSITION LTV</span>
                                <div className="text-base font-mono font-black text-text-primary mt-1 mb-0.5">
                                  {displayLTV}
                                </div>
                                <span className="text-2xs font-mono text-text-muted leading-none">Maximum risk cap parameter: 78%</span>
                              </div>
                            </div>
 
                            {/* PANIK Detailed Auditing Card */}
                            <div className="border border-border-subtle bg-surface-raised/85 p-3 rounded-md font-mono">
                              <span className="block text-2xs font-mono text-text-muted tracking-widest uppercase font-bold mb-3">
                                PANIK DETAILED AUDITING
                              </span>
                              
                              <div className="space-y-3 text-2xs">
                                <div>
                                  <div className="flex justify-between mb-1.5">
                                    <span className="text-text-secondary">Collateral Health</span>
                                    <span className="text-text-primary font-bold">{displayCollateralHealth}%</span>
                                  </div>
                                  <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
                                    <div className="h-full bg-panik-orange" style={{ width: `${displayCollateralHealth}%` }}></div>
                                  </div>
                                </div>
 
                                <div>
                                  <div className="flex justify-between mb-1.5">
                                    <span className="text-text-secondary">Asset Volatility</span>
                                    <span className="text-text-primary font-bold">{displayAssetVolatilityVal}%</span>
                                  </div>
                                  <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
                                    <div className="h-full bg-white/40" style={{ width: `${displayAssetVolatilityVal}%` }}></div>
                                  </div>
                                </div>
 
                                <div>
                                  <div className="flex justify-between mb-1.5 font-mono">
                                    <span className="text-text-secondary">Protocol Exploitation index</span>
                                    <span className="text-text-primary font-bold">{displayProtocolSafetyVal}%</span>
                                  </div>
                                  <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
                                    <div className="h-full bg-risk-critical" style={{ width: `${displayProtocolSafetyVal}%` }}></div>
                                  </div>
                                </div>
                              </div>
                            </div>
 
                          </div>
                          
                          {/* Right Column (Sidebar metrics) */}
                          <div className="md:col-span-4 space-y-3">
                            <div className="bg-surface-raised/50 border border-border-subtle p-4 rounded-md space-y-4">
                              <span className="text-2xs font-mono text-text-primary tracking-widest uppercase block border-b border-border-subtle pb-2 font-black">
                                SIMULATE FLUCTUATION PARAMETERS
                              </span>
 
                              {/* Price Slider */}
                              <div className="space-y-2 bg-white/[0.01] hover:bg-white/[0.03] p-2.5 rounded-md border border-border-subtle transition-colors font-mono">
                                <div className="flex justify-between items-start text-2xs text-text-secondary leading-tight">
                                  <span className="font-mono">
                                    Collateral Asset Mock Price<br />(ETH):
                                  </span>
                                  <span className="text-right font-mono text-text-primary text-xs sm:text-sm font-black leading-none font-mono">
                                    {assetPrice.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}<br />
                                    <span className="text-2xs text-text-muted font-normal">USD</span>
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="2200"
                                  max="4800"
                                  step="20"
                                  value={assetPrice}
                                  onChange={(e) => setAssetPrice(Number(e.target.value))}
                                  className="w-full h-1 bg-white/10 rounded-sm appearance-none cursor-pointer accent-panik-orange"
                                />
                                <div className="flex justify-between text-2xs leading-snug text-text-muted">
                                  <div>
                                    <span className="block">Minus -40% Downside</span>
                                    <span className="block text-white/20">({(assetPrice * 0.6).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })})</span>
                                  </div>
                                  <div className="text-right font-mono">
                                    <span className="block font-mono">Plus +30% Upside</span>
                                    <span className="block text-white/20">({(assetPrice * 1.3).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })})</span>
                                  </div>
                                </div>
                              </div>
 
                              {/* Debt Slider */}
                              <div className="space-y-2 bg-white/[0.01] hover:bg-white/[0.03] p-2.5 rounded-md border border-border-subtle transition-colors font-mono">
                                <div className="flex justify-between items-start text-2xs text-text-secondary leading-tight">
                                  <span className="font-mono">
                                    Borrowed Outstanding<br />Liability:
                                  </span>
                                  <span className="text-right font-mono text-text-primary text-xs sm:text-sm font-black leading-none font-mono">
                                    {borrowAmount.toFixed(1)}<br />
                                    <span className="text-2xs text-text-muted font-normal">USDC</span>
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="1000"
                                  max="3000"
                                  step="50"
                                  value={borrowAmount}
                                  onChange={(e) => setBorrowAmount(Number(e.target.value))}
                                  className="w-full h-1 bg-white/10 rounded-sm appearance-none cursor-pointer accent-panik-orange"
                                />
                                <div className="flex justify-between text-2xs text-text-muted">
                                  <span>Repaid (-50% Debt)</span>
                                  <span>Leveraged (+60% Debt)</span>
                                </div>
                              </div>
                            </div>
                          </div>
 
                        </div>
                      </motion.div>
                    );
                  })()}
 
                  {/* --- Tab 4: ADVISOR SCREEN (Defensive Intervention) --- */}
                  {activeTab === "advisor" && (
                    <motion.div
                      key="advisor"
                      initial={{ opacity: 0, scale: 0.98, y: 5 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98, y: -5 }}
                      transition={{ duration: 0.2 }}
                      className="flex flex-col h-full text-center justify-center items-center font-sans py-6 pr-1"
                    >
                      <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-md flex flex-col items-center text-center max-w-md my-auto">
                        <div className="w-10 h-10 rounded-full bg-panik-orange/10 border border-panik-orange/30 flex items-center justify-center mb-4">
                          <Sparkles className="w-4.5 h-4.5 text-panik-orange" />
                        </div>
                        
                        <span className="text-2xs font-mono tracking-widest text-panik-orange uppercase font-bold mb-1.5">
                          Coming Soon
                        </span>
                        
                        <h3 className="text-base font-sans font-bold text-text-primary tracking-tight mb-2">
                          Adaptive Intelligence at Your Service
                        </h3>
                        
                        <p className="text-xs text-text-secondary leading-relaxed max-w-sm">
                          Our AI-powered guardrail recommendations, automated health rating models, and simulated action guides are currently undergoing extensive parameter audits on Base. Joining the waitlist guarantees early access to this feature upon release.
                        </p>
                      </div>
                    </motion.div>
                  )}

                </AnimatePresence>
              </div>

            </motion.div>

          </div>

          {/* Premium Bottom Smoky Overlay to blend out the lower panel when collapsed */}
          <motion.div 
            style={{ opacity: overlayOpacity }}
            className="absolute inset-x-0 bottom-0 h-[240px] bg-gradient-to-t from-surface-base via-surface-base/90 to-transparent pointer-events-none z-30 flex items-end justify-center pb-8"
          />

        </motion.div>

      </div>
    </div>
  </section>
  );
}
