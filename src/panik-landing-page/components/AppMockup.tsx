/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  ShieldAlert, 
  Activity, 
  ArrowLeft, 
  RefreshCw, 
  Layers, 
  Wallet, 
  HelpCircle, 
  Sliders, 
  TrendingDown, 
  Cpu, 
  ShieldCheck,
  Flame,
  CheckCircle2,
  ListFilter,
  Compass as CompassIcon,
  Eye,
  Settings as SettingsIcon,
  Sparkles,
  Search,
  Bell,
  CheckCircle,
  FileText,
  X
} from "lucide-react";
import { calculateDynamicPosition, formatCurrency } from "../utils";
import { RISK_CHIP } from "../../panik-core/lib/utils";
import { PositionState } from "../types";
import { motion, AnimatePresence } from "motion/react";

function ProtocolLogo({ protocol, size = "w-6 h-6" }: { protocol: string; size?: string }) {
  if (protocol.toLowerCase().includes("aave")) {
    return (
      <img src="/aave-logo.png" alt="Aave" className={`rounded-md shrink-0 ${size} object-contain`} />
    );
  }
  if (protocol.toLowerCase().includes("compound")) {
    return (
      <div className={`rounded-md overflow-hidden shrink-0 ${size} flex items-center justify-center bg-surface-sunken border border-border-subtle p-1.5`}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 30 H85 V42 H15 Z" fill="#00D395" />
          <path d="M15 48 H85 V60 H15 Z" fill="#00D395" opacity="0.8" />
          <path d="M15 66 H85 V78 H15 Z" fill="#00D395" opacity="0.6" />
        </svg>
      </div>
    );
  }
  if (protocol.toLowerCase().includes("moonwell")) {
    return (
      <div className={`rounded-md overflow-hidden shrink-0 ${size} flex items-center justify-center bg-[#1D6AF3] p-1.5 border border-border-subtle`}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Moonwell Left Crescent */}
          <path d="M 42,28 C 28,31 16,42 16,50 C 16,58 28,69 42,72 C 32,66 26,59 26,50 C 26,41 32,34 42,28 Z" fill="#FFFFFF" />
          {/* Moonwell Right Crescent */}
          <path d="M 58,28 C 72,31 84,42 84,50 C 84,58 72,69 58,72 C 68,66 74,59 74,50 C 74,41 68,34 58,28 Z" fill="#FFFFFF" />
        </svg>
      </div>
    );
  }
  if (protocol.toLowerCase().includes("gmx")) {
    return (
      <div className={`rounded-md overflow-hidden shrink-0 ${size} flex items-center justify-center bg-surface-base border border-border-subtle p-1.5`}>
        <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="gmx-gradient" x1="16" y1="77" x2="66" y2="25" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--color-indigo-500)" />   {/* Royal Violet */}
              <stop offset="40%" stopColor="var(--color-blue-500)" />  {/* Bright Blue */}
              <stop offset="100%" stopColor="var(--color-cyan-400)" /> {/* Neon Cyan */}
            </linearGradient>
          </defs>
          {/* Main GMX Left & Center Hook Symbol */}
          <path 
            d="M 50,18 
               L 16,77 
               H 58 
               L 50,63 
               H 37 
               L 50,40 
               L 58,54 
               H 69 
               L 50,21 
               Z" 
            fill="url(#gmx-gradient)" 
          />
          {/* Separate GMX Right-Hand Slanted Guard Bar */}
          <path 
            d="M 66,46 
               L 54,46 
               L 72,77 
               H 84 
               Z" 
            fill="url(#gmx-gradient)" 
          />
        </svg>
      </div>
    );
  }
  return (
    <div className={`rounded-md bg-panik-orange/15 border border-panik-orange/30 flex items-center justify-center font-mono font-bold text-xs text-panik-orange shrink-0 ${size}`}>
      {protocol[0]}
    </div>
  );
}

interface AppMockupProps {
  onBackToLanding: () => void;
  onJoinWaitlist: (email: string) => void;
  hasSubscribed: boolean;
}

type SidebarTab = "compass" | "watch" | "advisor" | "portfolio";
type RiskProfile = "conservative" | "moderate" | "aggressive";

interface VaultPreset {
  id: string;
  protocol: "Aave V3" | "Moonwell" | "Compound" | "GMX";
  assetPair: string;
  collateralAsset: string;
  debtAsset: string;
  defaultCollateral: number;
  defaultBorrow: number;
  defaultPrice: number;
  apy: number;
  baseRisk: number; // For compass display
  riskStatus: "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";
  protocolCount: number;
  poolCount: number;
  positionCount: number;
}

const VAULT_PRESETS: VaultPreset[] = [
  {
    id: "aave-usdc-supply",
    protocol: "Aave V3",
    assetPair: "USDC SUPPLY BUFFER",
    collateralAsset: "USDC",
    debtAsset: "USDT",
    defaultCollateral: 2000,
    defaultBorrow: 500,
    defaultPrice: 1,
    apy: 8.2,
    baseRisk: 12,
    riskStatus: "LOW",
    protocolCount: 12,
    poolCount: 8,
    positionCount: 4
  },
  {
    id: "compound-usdt-supply",
    protocol: "Compound",
    assetPair: "USDT LIQUIDITY YIELD",
    collateralAsset: "USDT",
    debtAsset: "USDC",
    defaultCollateral: 1500,
    defaultBorrow: 300,
    defaultPrice: 1,
    apy: 7.4,
    baseRisk: 15,
    riskStatus: "LOW",
    protocolCount: 14,
    poolCount: 10,
    positionCount: 7
  },
  {
    id: "aave-wsteth-supply",
    protocol: "Aave V3",
    assetPair: "wstETH / USDC VAULT",
    collateralAsset: "wstETH",
    debtAsset: "USDC",
    defaultCollateral: 2.1,
    defaultBorrow: 4500,
    defaultPrice: 3820,
    apy: 5.2,
    baseRisk: 24,
    riskStatus: "LOW",
    protocolCount: 18,
    poolCount: 12,
    positionCount: 9
  },
  {
    id: "compound-usdc-borrow",
    protocol: "Compound",
    assetPair: "USDC BORROW MARGIN",
    collateralAsset: "USDC",
    debtAsset: "ETH",
    defaultCollateral: 5000,
    defaultBorrow: 1.1,
    defaultPrice: 3700,
    apy: 6.9,
    baseRisk: 31,
    riskStatus: "ELEVATED",
    protocolCount: 16,
    poolCount: 14,
    positionCount: 12
  },
  {
    id: "moonwell-eth-borrow",
    protocol: "Moonwell",
    assetPair: "ETH / USDC DEBT",
    collateralAsset: "ETH",
    debtAsset: "USDC",
    defaultCollateral: 1.2,
    defaultBorrow: 2000,
    defaultPrice: 3700,
    apy: 5.7,
    baseRisk: 58,
    riskStatus: "HIGH",
    protocolCount: 22,
    poolCount: 18,
    positionCount: 18
  },
  {
    id: "gmx-leveraged-eth",
    protocol: "GMX",
    assetPair: "ETH DEFI MAX LEVERAGE",
    collateralAsset: "ETH",
    debtAsset: "USDC",
    defaultCollateral: 0.8,
    defaultBorrow: 2200,
    defaultPrice: 3700,
    apy: 18.5,
    baseRisk: 78,
    riskStatus: "CRITICAL",
    protocolCount: 45,
    poolCount: 24,
    positionCount: 32
  }
];

export function AppMockup({ onBackToLanding, onJoinWaitlist, hasSubscribed }: AppMockupProps) {
  // Navigation tabs exactly reflecting the Figma screenshot
  const [activeTab, setActiveTab] = useState<SidebarTab>("portfolio");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("moonwell-eth-borrow");
  const [selectedRiskProfile, setSelectedRiskProfile] = useState<RiskProfile>("moderate");
  const [selectedRiskBreakdownPreset, setSelectedRiskBreakdownPreset] = useState<VaultPreset | null>(null);

  // Telemetry simulation
  const [blockNumber, setBlockNumber] = useState<number>(19384910);
  const [gasPrice, setGasPrice] = useState<number>(2.8);
  const [secTillUpdate, setSecTillUpdate] = useState<number>(60);
  const [logs, setLogs] = useState<string[]>([
    "08:04:12 UTC - Sentry telemetry daemon initialized on Base RPC node.",
    "08:04:13 UTC - Active guardrail listener bound. Connected presets loaded.",
    "08:04:15 UTC - Status OK. Integrity rate: 99.8%"
  ]);

  // Alert simulation states for Settings
  const [telegramWebhook, setTelegramWebhook] = useState("");
  const [alertSuccessMessage, setAlertSuccessMessage] = useState<string | null>(null);
  const [automaticRepayTarget, setAutomaticRepayTarget] = useState<number>(30);
  const [isRepayActive, setIsRepayActive] = useState<boolean>(true);

  // Load selected preset for Watch/Simulator tab
  const activePreset = VAULT_PRESETS.find(p => p.id === selectedPresetId) || VAULT_PRESETS[4];

  // Simulator Sliders
  const [collateralAmount, setCollateralAmount] = useState<number>(activePreset.defaultCollateral);
  const [borrowAmount, setBorrowAmount] = useState<number>(activePreset.defaultBorrow);
  const [assetPrice, setAssetPrice] = useState<number>(activePreset.defaultPrice);

  // Recommendations internal sub-tab
  const [recommendationsSubTab, setRecommendationsSubTab] = useState<"advisor" | "breakdown">("advisor");

  // Synchronize state values when active position changes
  useEffect(() => {
    setCollateralAmount(activePreset.defaultCollateral);
    setBorrowAmount(activePreset.defaultBorrow);
    setAssetPrice(activePreset.defaultPrice);
    addLog(`Position simulation loaded: ${activePreset.protocol} (${activePreset.collateralAsset}/${activePreset.debtAsset})`);
  }, [selectedPresetId]);

  // Calculate dynamic maths based on sliders
  // We check if it is USD backing vs ETH backing to pass safe arguments to the calculator
  const calculateResult = () => {
    // If protocol is Aave V3 or Moonwell, we support official maths
    const protocolName: "Aave V3" | "Moonwell" = (activePreset.protocol === "Aave V3") ? "Aave V3" : "Moonwell";
    return calculateDynamicPosition(
      protocolName,
      collateralAmount,
      borrowAmount,
      assetPrice
    );
  };

  const positionState = calculateResult();

  // Dynamic parameters for redesigned Panik Risk Index
  const diff = positionState.riskScore - activePreset.baseRisk;
  const trendNum = diff !== 0 ? diff : (positionState.riskScore >= 75 ? 14 : positionState.riskScore >= 50 ? 9 : positionState.riskScore >= 25 ? 6 : -2);
  const healthFactorScore = Math.max(5, Math.min(98, Math.round(100 - (positionState.healthFactor / 2.5) * 80)));

  const addLog = (message: string) => {
    const timestamp = new Date().toUTCString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, "$1");
    setLogs(prev => [...prev.slice(-30), `${timestamp} UTC - ${message}`]);
  };

  // Block timer simulator
  useEffect(() => {
    const interval = setInterval(() => {
      setSecTillUpdate(prev => {
        if (prev <= 1) {
          setBlockNumber(b => b + 1);
          setGasPrice(g => Math.max(1.1, +(g + (Math.random() * 0.8 - 0.4)).toFixed(1)));
          addLog(`Block ${blockNumber + 1} confirmed. Relaying fresh multi-vault index oracle parameters...`);
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [blockNumber]);

  useEffect(() => {
    if (activeTab === "watch") {
      addLog(`Parameter simulated delta: Volatility Price $${assetPrice} USD | Borrows Debt ${borrowAmount}`);
    }
  }, [assetPrice, borrowAmount]);

  // Custom simulation handlers for Watch Cockpit
  const handleSimulateCollateralInflow = () => {
    const boost = +(collateralAmount * 1.5).toFixed(2);
    setCollateralAmount(boost);
    addLog(`Automation Trigger: Deposited emergency defensive buffer of +${(boost - collateralAmount).toFixed(2)} ${activePreset.collateralAsset}`);
  };

  const handleSimulateFlashRepay = () => {
    const currentDebt = borrowAmount;
    const reducedDebt = +(borrowAmount * 0.5).toFixed(2);
    setBorrowAmount(reducedDebt);
    addLog(`Automation Trigger: Executed flash loan repayment of -${(currentDebt - reducedDebt).toFixed(2)} ${activePreset.debtAsset} to lower systemic margins.`);
  };

  // Profile-based filtering for Compass tab exactly corresponding to the Figma screen
  // Categorizes mock positions based on risk levels
  const getProfileThresholds = () => {
    switch (selectedRiskProfile) {
      case "conservative":
        return {
          recommended: VAULT_PRESETS.filter(p => p.baseRisk < 20),
          outside: VAULT_PRESETS.filter(p => p.baseRisk >= 20)
        };
      case "aggressive":
        return {
          recommended: VAULT_PRESETS.filter(p => p.baseRisk >= 50),
          outside: VAULT_PRESETS.filter(p => p.baseRisk < 50)
        };
      case "moderate":
      default:
        return {
          recommended: VAULT_PRESETS.filter(p => p.baseRisk >= 20 && p.baseRisk < 50),
          outside: VAULT_PRESETS.filter(p => p.baseRisk < 20 || p.baseRisk >= 50)
        };
    }
  };

  const { recommended, outside } = getProfileThresholds();

  // Color mappings for risk tags matching Figma
  const getFigmaRiskStyle = (risk: number) => {
    if (risk < 25) return "bg-risk-low/10 text-risk-low border border-risk-low/25";
    if (risk < 50) return "bg-risk-elevated/10 text-risk-elevated border border-risk-elevated/25";
    return "bg-risk-critical/10 text-risk-critical border border-risk-critical/25";
  };

  const getFigmaRiskLabel = (risk: number) => {
    if (risk < 25) return "LOW";
    if (risk < 50) return "ELEVATED";
    return "HIGH";
  };

  // Send a test Alert helper for settings tab
  const handleSendTestAlert = () => {
    addLog("Sending test firewall event trigger packet...");
    setAlertSuccessMessage("Telemetry alert dispatched! Connection verified successfully.");
    setTimeout(() => setAlertSuccessMessage(null), 4000);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-base text-text-primary font-sans antialiased text-sm">
      
      {/* 1. LEFT SIDEBAR PANEL (exactly modeled after the Figma UI) */}
      <aside className="w-64 h-full shrink-0 flex flex-col justify-between border-r border-border-subtle bg-surface-base p-6 z-30">
        
        {/* Sidebar Header Brand block */}
        <div className="space-y-8">
          <div className="flex items-center gap-2.5">
            <img src="/panik-logo.png" alt="PANIK" width={32} height={32} style={{ objectFit: "contain" }} />
            <div className="flex flex-col">
              <span className="font-display font-extrabold text-lg tracking-widest text-text-primary leading-none">PANIK</span>
              <span className="text-2xs font-mono tracking-widest text-text-muted uppercase mt-0.5">SENTRY PROTECTION</span>
            </div>
          </div>

          {/* Nav List Link Items */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab("portfolio")}
              className={`w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-xs font-mono uppercase tracking-wider text-left transition-all cursor-pointer ${
                activeTab === "portfolio"
                  ? "bg-white/[0.06] border border-border-subtle text-text-primary font-bold"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
              }`}
            >
              <Wallet className={`w-4 h-4 ${activeTab === "portfolio" ? "text-panik-orange" : "text-text-secondary"}`} />
              <span>Portfolio</span>
            </button>

            <button
              onClick={() => setActiveTab("compass")}
              className={`w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-xs font-mono uppercase tracking-wider text-left transition-all cursor-pointer ${
                activeTab === "compass"
                  ? "bg-white/[0.06] border border-border-subtle text-text-primary font-bold"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
              }`}
            >
              <CompassIcon className={`w-4 h-4 ${activeTab === "compass" ? "text-panik-orange" : "text-text-secondary"}`} />
              <span>Compass</span>
            </button>

            <button
              onClick={() => setActiveTab("watch")}
              className={`w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-xs font-mono uppercase tracking-wider text-left transition-all cursor-pointer ${
                activeTab === "watch"
                  ? "bg-white/[0.06] border border-border-subtle text-text-primary font-bold"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
              }`}
            >
              <Eye className={`w-4 h-4 ${activeTab === "watch" ? "text-panik-orange" : "text-text-secondary"}`} />
              <span>Watch</span>
            </button>

            <button
              onClick={() => setActiveTab("advisor")}
              className={`w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-xs font-mono uppercase tracking-wider text-left transition-all cursor-pointer ${
                activeTab === "advisor"
                  ? "bg-white/[0.06] border border-border-subtle text-text-primary font-bold"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
              }`}
            >
              <Sparkles className={`w-4 h-4 ${activeTab === "advisor" ? "text-panik-orange" : "text-text-secondary"}`} />
              <span>Advisor</span>
            </button>
          </nav>
        </div>

        {/* Sidebar Footer Bottom exit button */}
        <div className="space-y-4">
          <button
            onClick={onBackToLanding}
            className="flex items-center gap-2 text-xs font-mono text-text-secondary hover:text-text-primary transition-colors cursor-pointer pt-2 group"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-panik-orange group-hover:-translate-x-0.5 transition-transform" />
            <span>Back to Landing</span>
          </button>
        </div>
      </aside>

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 h-full flex flex-col overflow-hidden bg-surface-base relative">
        
        {/* TOP STATUS BAR (Gas feeds, Block Number precisely simulating real active smart contracts) */}
        <header className="h-16 shrink-0 border-b border-border-subtle px-8 flex items-center justify-between bg-surface-raised/40 backdrop-blur-md">
          <div className="flex items-center gap-2">
          </div>

          <div className="flex items-center gap-6 text-2xs font-mono text-text-muted">
            <div className="hidden md:flex items-center gap-1.5">
              <span>EST GAS:</span>
              <strong className="text-risk-low bg-risk-low/5 px-2 py-0.5 rounded-sm border border-risk-low/10">{gasPrice} GWEI</strong>
            </div>
            <div className="h-4 w-px bg-white/10 hidden md:block"></div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/[0.02] border border-border-subtle text-2xs font-semibold text-text-secondary">
              <Wallet className="w-3.5 h-3.5 text-panik-orange" />
              <span>0x8F94...42fA</span>
            </div>
          </div>
        </header>

        {/* PAGE VIEWS SWITCH */}
        <div className="flex-1 overflow-y-auto p-8">
          <AnimatePresence mode="wait">
            
            {/* VIEW A: COMPASS TAB (Fully interactive and identical to the requested design layout!) */}
            {activeTab === "compass" && (
              <motion.div
                key="compass"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="space-y-8 max-w-5xl"
              >
                {/* Title Section */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border-subtle pb-5">
                  <div>
                    <h1 className="text-2xl font-display font-extrabold tracking-tight text-text-primary mb-1">Compass</h1>
                    <p className="text-text-secondary font-mono text-xs">Find positions matching your risk profile</p>
                  </div>

                  {/* High Fidelity Risk Profile Toggle matching Figma */}
                  <div className="bg-white/[0.02] border border-border-subtle p-1 rounded-md flex items-center max-w-sm">
                    <button
                      onClick={() => setSelectedRiskProfile("conservative")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "conservative"
                          ? "bg-panik-orange/15 text-panik-orange font-bold border border-panik-orange/30"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Conservative
                    </button>
                    <button
                      onClick={() => setSelectedRiskProfile("moderate")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "moderate"
                          ? "bg-panik-orange/15 text-panik-orange font-bold border border-panik-orange/30"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Moderate
                    </button>
                    <button
                      onClick={() => setSelectedRiskProfile("aggressive")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "aggressive"
                          ? "bg-panik-orange/15 text-panik-orange font-bold border border-panik-orange/30"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Aggressive
                    </button>
                  </div>
                </div>

                {/* Section 1: Recommended for your chosen Profile */}
                <div className="space-y-4">
                  <h2 className="text-base font-mono font-bold text-text-primary tracking-wide uppercase flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-risk-low"></span>
                    Recommended for your {selectedRiskProfile.toUpperCase()} Profile
                  </h2>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {recommended.map((preset) => (
                      <div
                        key={preset.id}
                        onClick={() => setSelectedRiskBreakdownPreset(preset)}
                        className="bg-surface-raised/60 hover:bg-surface-overlay/70 border border-border-subtle rounded-lg p-5 relative overflow-hidden transition-all hover:border-panik-orange/35 shadow-xl group cursor-pointer"
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <ProtocolLogo protocol={preset.protocol} size="w-8 h-8" />
                            <div>
                              <h3 className="text-sm font-mono font-bold text-text-primary tracking-wide group-hover:text-panik-orange transition-colors">
                                {preset.protocol}
                              </h3>
                              <span className="text-2xs font-mono text-text-muted uppercase block">
                                {preset.assetPair}
                              </span>
                            </div>
                          </div>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRiskBreakdownPreset(preset);
                            }}
                            onMouseEnter={() => setSelectedRiskBreakdownPreset(preset)}
                            className={`text-2xs font-mono font-bold py-1 px-2.5 rounded-md flex items-center gap-1.5 cursor-pointer hover:scale-105 active:scale-95 transition-all shadow-sm ${getFigmaRiskStyle(preset.baseRisk)}`}
                            title="Hover or click to view detailed risk breakdown"
                          >
                            <span>{preset.baseRisk} {getFigmaRiskLabel(preset.baseRisk)}</span>
                            <Sliders className="w-3 h-3 text-current stroke-[2.5]" />
                          </button>
                        </div>

                        {/* APY indicator */}
                        <div className="mb-3">
                          <span className="text-xs text-risk-low font-mono font-bold">APY Rate: {preset.apy}%</span>
                        </div>

                        {/* Figma UI submetrics grid layout of Protocol, Pool, Position */}
                        <div className="grid grid-cols-3 gap-2 border-t border-border-subtle pt-4.5 mt-2.5">
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-secondary">Protocol Index</span>
                            <span className="text-sm font-mono font-bold text-text-primary">{preset.protocolCount}</span>
                          </div>
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-secondary">Pool Count</span>
                            <span className="text-sm font-mono font-bold text-text-primary">{preset.poolCount}</span>
                          </div>
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-secondary">Position Count</span>
                            <span className="text-sm font-mono font-bold text-text-primary">{preset.positionCount}</span>
                          </div>
                        </div>

                        {/* Direct action links to load this into simulator watch window */}
                        <div className="mt-5 pt-3 border-t border-border-subtle flex justify-between items-center opacity-80 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                          <span className="text-2xs font-mono text-text-muted">Active sentinel protection</span>
                          <button
                            onClick={() => {
                              setSelectedPresetId(preset.id);
                              setActiveTab("watch");
                            }}
                            className="text-xs font-mono font-bold text-panik-orange hover:text-risk-elevated transition-colors bg-panik-orange/10 border border-panik-orange/25 px-3 py-1 rounded-md cursor-pointer flex items-center gap-1"
                          >
                            <span>Audit & Simulate →</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 2: Vaults outside the core profile limits */}
                <div className="space-y-4 pt-4">
                  <h2 className="text-base font-mono font-bold text-text-secondary tracking-wide uppercase flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-risk-critical/60"></span>
                    Outside Your Profile
                  </h2>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {outside.map((preset) => (
                      <div
                        key={preset.id}
                        onClick={() => setSelectedRiskBreakdownPreset(preset)}
                        className="bg-surface-raised/25 border border-border-subtle rounded-lg p-5 relative overflow-hidden transition-all hover:bg-surface-raised/45 hover:border-border-strong cursor-pointer group"
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <ProtocolLogo protocol={preset.protocol} size="w-8 h-8 opacity-60 group-hover:opacity-100 transition-opacity" />
                            <div>
                              <h3 className="text-sm font-mono font-bold text-text-muted group-hover:text-text-primary transition-colors">
                                {preset.protocol}
                              </h3>
                              <span className="text-2xs font-mono text-text-muted uppercase block">
                                {preset.assetPair}
                              </span>
                            </div>
                          </div>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRiskBreakdownPreset(preset);
                            }}
                            onMouseEnter={() => setSelectedRiskBreakdownPreset(preset)}
                            className={`text-2xs font-mono py-1 px-2.5 rounded-md opacity-60 hover:opacity-100 flex items-center gap-1.5 cursor-pointer hover:scale-105 active:scale-95 transition-all shadow-sm ${getFigmaRiskStyle(preset.baseRisk)}`}
                            title="Hover or click to view detailed risk breakdown"
                          >
                            <span>{preset.baseRisk} {getFigmaRiskLabel(preset.baseRisk)}</span>
                            <Sliders className="w-3 h-3 text-current stroke-[2.5]" />
                          </button>
                        </div>

                        {/* APY indicator */}
                        <div className="mb-3">
                          <span className="text-xs text-text-muted font-mono">APY Rate: {preset.apy}%</span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 border-t border-border-subtle pt-4 mt-2">
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-muted font-bold">Protocol Index</span>
                            <span className="text-sm font-mono font-bold text-text-muted">{preset.protocolCount}</span>
                          </div>
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-muted font-bold">Pool Count</span>
                            <span className="text-sm font-mono font-bold text-text-muted">{preset.poolCount}</span>
                          </div>
                          <div>
                            <span className="block text-2xs font-mono uppercase text-text-muted font-bold">Position Count</span>
                            <span className="text-sm font-mono font-bold text-text-muted">{preset.positionCount}</span>
                          </div>
                        </div>

                        <div className="mt-5 pt-3 border-t border-border-subtle flex justify-between items-center" onClick={(e) => e.stopPropagation()}>
                          <span className="text-2xs font-mono text-text-muted">Outside safety triggers</span>
                          <button
                            onClick={() => {
                              setSelectedPresetId(preset.id);
                              setActiveTab("watch");
                            }}
                            className="text-xs font-mono font-semibold text-text-muted hover:text-text-primary transition-colors bg-white/[0.02] hover:bg-white/[0.05] border border-border-subtle px-3 py-1 rounded-md cursor-pointer"
                          >
                            <span>Force Audit →</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </motion.div>
            )}

            {/* VIEW B: WATCH TAB (The high-fidelity mathematical simulator control cockpit!) */}
            {activeTab === "watch" && (
              <motion.div
                key="watch"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="grid grid-cols-1 lg:grid-cols-12 gap-8 max-w-6xl"
              >
                
                {/* Simulator Area (lg:col-span-8) */}
                <div className="col-span-1 lg:col-span-8 space-y-6">
                  
                  {/* Active Simulator Header widget */}
                  <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg relative overflow-hidden backdrop-blur-xl">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-panik-orange/5 rounded-full blur-2xl pointer-events-none"></div>
                    <div className="flex justify-between items-center mb-4.5 border-b border-border-subtle pb-3">
                      <div>
                        <span className="block text-2xs font-mono tracking-widest text-panik-orange uppercase">ACTIVE PROTECTOR</span>
                        <h2 className="text-lg font-display font-extrabold text-text-primary tracking-wide">
                          {activePreset.protocol} Detail Sandbox
                        </h2>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="text-2xs font-mono text-text-secondary uppercase">DAEMON SENTINEL</span>
                        <span className="text-2xs font-mono text-risk-low bg-risk-low/10 px-2.5 py-0.5 rounded-sm border border-risk-low/25 flex items-center font-bold mt-1">
                          SECURE WATCH
                        </span>
                      </div>
                    </div>

                    {/* REDESIGNED PANIK RISK INDEX CARD (Primary intelligence focal point) */}
                    <div className="mb-6 p-5 bg-surface-sunken border border-border-subtle rounded-md flex flex-col md:flex-row gap-6 relative overflow-hidden text-left">
                      <div className="absolute top-0 left-0 w-24 h-24 bg-white/[0.01] rounded-full blur-xl pointer-events-none"></div>
                      
                      {/* Left: Score display & interpretation */}
                      <div className="flex-1 md:max-w-[280px] flex flex-col justify-between">
                        <div>
                          <div className="flex items-center gap-1.5 text-text-muted font-mono text-2xs uppercase tracking-wider mb-2">
                            <Activity className="w-3.5 h-3.5 text-panik-orange shrink-0" />
                            <span>Panik Risk Index</span>
                          </div>

                          <div className="flex items-baseline gap-2 mb-2">
                            <span className={`text-4xl font-mono font-black tracking-tight ${
                              positionState.riskScore < 25 ? "text-risk-low" :
                              positionState.riskScore < 50 ? "text-risk-elevated" :
                              "text-risk-critical"
                            }`}>
                              {positionState.riskScore}
                            </span>
                            <span className="text-xs font-mono text-text-muted">/ 100</span>

                            <span className={`ml-auto text-2xs font-mono font-bold px-2 py-0.5 rounded-sm border ${RISK_CHIP[positionState.status]}`}>
                              {positionState.status === "CRITICAL" ? "CRITICAL THREAT" :
                               positionState.status === "HIGH" ? "HIGH RISK" :
                               positionState.status === "ELEVATED" ? "ELEVATED" : "LOW RISK"}
                            </span>
                          </div>
                        </div>

                        {/* Plain language summary & trend indicators */}
                        <div className="mt-3 pt-3 border-t border-border-subtle space-y-2.5">
                          <div className="flex items-center gap-1.5 font-mono text-2xs">
                            {trendNum > 0 ? (
                              <span className="text-risk-elevated font-bold flex items-center gap-1">
                                <span>▲</span>
                                <span>+{trendNum} in the last 24 hours</span>
                              </span>
                            ) : (
                              <span className="text-risk-low font-bold flex items-center gap-1">
                                <span>▼</span>
                                <span>{trendNum} in the last 24 hours</span>
                              </span>
                            )}
                          </div>
                          
                          <p className="text-2xs text-text-secondary leading-relaxed font-sans">
                            {positionState.status === "CRITICAL" && "Extreme liquidation danger. Spot price is dangerously close to your liquidation benchmark."}
                            {positionState.status === "HIGH" && "Liquidation threat is high due to current leverage ratios. Repayment or buffer injection strongly advised."}
                            {positionState.status === "ELEVATED" && "Moderate leverage risk. Position is stable but vulnerable to short-term market volatile swings."}
                            {positionState.status === "LOW" && "Safe operating range. Robust collateral buffer easily withstands active market swings."}
                          </p>
                        </div>
                      </div>

                      {/* Right: Top Risk Drivers section */}
                      <div className="flex-1 border-t md:border-t-0 md:border-l border-border-subtle pt-4 md:pt-0 md:pl-6 space-y-4">
                        <span className="block text-2xs font-mono tracking-widest text-text-muted uppercase select-none">
                          Top Risk Drivers
                        </span>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                          {/* Driver 1: Health Factor */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-2xs font-mono">
                              <span className="text-text-secondary">Health Factor</span>
                              <span className={`font-bold ${
                                healthFactorScore > 75 ? "text-risk-critical" :
                                healthFactorScore > 40 ? "text-risk-elevated" : "text-risk-low"
                              }`}>
                                {healthFactorScore}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden relative">
                              <div 
                                className={`h-full rounded-full transition-all duration-300 ${
                                  healthFactorScore > 75 ? "bg-risk-critical" :
                                  healthFactorScore > 40 ? "bg-risk-elevated" : "bg-risk-low"
                                }`}
                                style={{ width: `${healthFactorScore}%` }}
                              ></div>
                            </div>
                          </div>

                          {/* Driver 2: Asset Volatility */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-2xs font-mono">
                              <span className="text-text-secondary">Asset Volatility</span>
                              <span className="text-blue-400 font-bold">{positionState.breakdown.assetVolatility}%</span>
                            </div>
                            <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden relative">
                              <div 
                                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                                style={{ width: `${positionState.breakdown.assetVolatility}%` }}
                              ></div>
                            </div>
                          </div>

                          {/* Driver 3: Protocol Risk */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-2xs font-mono">
                              <span className="text-text-secondary">Protocol Risk</span>
                              <span className="text-risk-low font-bold">{positionState.breakdown.protocolSafety}%</span>
                            </div>
                            <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden relative">
                              <div 
                                className="h-full bg-risk-low rounded-full transition-all duration-300"
                                style={{ width: `${positionState.breakdown.protocolSafety}%` }}
                              ></div>
                            </div>
                          </div>

                          {/* Driver 4: Pool Conditions */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-2xs font-mono">
                              <span className="text-text-secondary">Pool Conditions</span>
                              <span className={`font-bold ${
                                positionState.breakdown.systemicMarketStress > 70 ? "text-risk-critical" :
                                positionState.breakdown.systemicMarketStress > 40 ? "text-risk-elevated" : "text-risk-low"
                              }`}>
                                {positionState.breakdown.systemicMarketStress}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden relative">
                              <div 
                                className={`h-full rounded-full transition-all duration-300 ${
                                  positionState.breakdown.systemicMarketStress > 70 ? "bg-risk-critical" :
                                  positionState.breakdown.systemicMarketStress > 40 ? "bg-risk-elevated" : "bg-risk-low"
                                }`}
                                style={{ width: `${positionState.breakdown.systemicMarketStress}%` }}
                              ></div>
                            </div>
                          </div>
                        </div>

                        {/* Explanatory footer line inside bento block */}
                        <div className="pt-2.5 flex items-center gap-1.5 text-2xs font-mono text-text-muted border-t border-border-subtle">
                          <HelpCircle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                          <span>Core parameters compiled from real-time pool triggers & volatility parameters.</span>
                        </div>
                      </div>
                    </div>

                    {/* Central Core Indicators: Health, LTV exactly mirroring the uploaded reference mockup */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      
                      {/* Health Factor */}
                      <div className="bg-surface-sunken/85 border border-border-subtle p-4.5 rounded-md">
                        <span className="block text-2xs font-mono text-text-secondary uppercase tracking-wider mb-1">HEALTH FACTOR</span>
                        <div className="flex items-baseline gap-1">
                          <span className={`text-4xl font-mono font-bold tracking-tight ${
                            positionState.healthFactor < 1.3 ? "text-risk-critical" :
                            positionState.healthFactor < 1.7 ? "text-risk-elevated" :
                            "text-risk-low"
                          }`}>
                            {positionState.healthFactor.toFixed(2)}
                          </span>
                        </div>
                        <span className="text-2xs font-mono text-text-muted block mt-2">Liquidation trigger limit is &lt; 1.00</span>
                      </div>

                      {/* Position LTV */}
                      <div className="bg-surface-sunken/85 border border-border-subtle p-4.5 rounded-md">
                        <span className="block text-2xs font-mono text-text-secondary uppercase tracking-wider mb-1">POSITION LTV</span>
                        <div className="flex items-baseline gap-1">
                          <span className="text-4xl font-mono font-bold tracking-tight text-text-primary">
                            {Math.round((borrowAmount / (collateralAmount * assetPrice)) * 100)}%
                          </span>
                        </div>
                        <span className="text-2xs font-mono text-text-muted block mt-2">Maximum risk cap parameter: {activePreset.protocol === "Aave V3" ? "82%" : "78%"}</span>
                      </div>

                    </div>

                    {/* PANIK Detailed Auditing Card */}
                    <div className="border border-border-subtle bg-surface-raised/85 p-5 rounded-lg mt-6">
                      <span className="block text-2xs font-mono text-text-muted tracking-widest uppercase mb-3.5">
                        PANIK DETAILED AUDITING
                      </span>
                      
                      <div className="space-y-3.5">
                        <div>
                          <div className="flex justify-between text-2xs font-mono mb-1">
                            <span className="text-text-secondary">Collateral Health</span>
                            <span className="text-text-primary font-bold">{positionState.breakdown.positionHealth}%</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-panik-orange" style={{ width: `${positionState.breakdown.positionHealth}%` }}></div>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-2xs font-mono mb-1">
                            <span className="text-text-secondary">Asset Volatility</span>
                            <span className="text-text-primary font-bold">{positionState.breakdown.assetVolatility}%</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-white/40" style={{ width: `${positionState.breakdown.assetVolatility}%` }}></div>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-2xs font-mono mb-1">
                            <span className="text-text-secondary">Protocol Exploitation index</span>
                            <span className="text-text-primary font-bold">{positionState.breakdown.protocolSafety}%</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-risk-critical" style={{ width: `${positionState.breakdown.protocolSafety}%` }}></div>
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>

                </div>

                {/* Automation triggers & Telemetry feed column (lg:col-span-4) */}
                <div className="col-span-1 lg:col-span-4 space-y-6">
                  
                  {/* Slider Adjusters: Completely accessible and non-occluded! */}
                  <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-4">
                    <span className="text-2xs font-mono text-text-primary tracking-widest uppercase block border-b border-border-subtle pb-2">
                       Simulate Fluctuation Parameters
                    </span>

                    {/* Price Slider */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between text-xs font-mono text-text-secondary">
                        <span>Collateral Asset Mock Price ({activePreset.collateralAsset}):</span>
                        <span className={assetPrice < (activePreset.defaultPrice * 0.8) ? "text-risk-critical font-bold" : "text-text-primary"}>
                          {formatCurrency(assetPrice)} USD
                        </span>
                      </div>
                      <input
                        type="range"
                        min={Math.round(activePreset.defaultPrice * 0.6)}
                        max={Math.round(activePreset.defaultPrice * 1.3)}
                        step={activePreset.defaultPrice < 10 ? "0.05" : "20"}
                        value={assetPrice}
                        onChange={(e) => setAssetPrice(Number(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-panik-orange"
                        id="watch-price-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Minus -40% Downside ({formatCurrency(activePreset.defaultPrice * 0.6)})</span>
                        <span>Plus +30% Upside ({formatCurrency(activePreset.defaultPrice * 1.3)})</span>
                      </div>
                    </div>

                    {/* Debt Slider */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between text-xs font-mono text-text-secondary">
                        <span>Borrowed Outstanding Liability:</span>
                        <span className={borrowAmount > (activePreset.defaultBorrow * 1.2) ? "text-risk-critical font-bold" : "text-text-primary"}>
                          {borrowAmount.toFixed(1)} {activePreset.debtAsset}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={Math.round(activePreset.defaultBorrow * 0.5)}
                        max={Math.round(activePreset.defaultBorrow * 1.6)}
                        step={activePreset.defaultBorrow < 10 ? "0.1" : "50"}
                        value={borrowAmount}
                        onChange={(e) => setBorrowAmount(Number(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-panik-orange"
                        id="watch-borrow-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Repaid (-50% Debt)</span>
                        <span>Leveraged (+60% Debt)</span>
                      </div>
                    </div>
                  </div>

                </div>

              </motion.div>
            )}

            {/* VIEW C: ADVISOR TAB (Autonomous Alert Rules Configuration & Diagnosing Engine) */}
            {activeTab === "advisor" && (
              <motion.div
                key="advisor"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="space-y-6 max-w-4xl"
              >
                <div className="border-b border-border-subtle pb-5">
                  <h1 className="text-2xl font-display font-extrabold tracking-tight text-text-primary mb-1">AI Advisor</h1>
                  <p className="text-text-secondary font-mono text-xs">Intelligent decentralized risk modeling and real-time execution guidance</p>
                </div>

                <div className="bg-surface-raised/50 border border-border-subtle p-12 rounded-lg flex flex-col items-center text-center max-w-2xl mx-auto my-8">
                  <div className="w-12 h-12 rounded-full bg-panik-orange/10 border border-panik-orange/30 flex items-center justify-center mb-6">
                    <Sparkles className="w-5 h-5 text-panik-orange" />
                  </div>
                  
                  <span className="text-2xs font-mono tracking-widest text-panik-orange uppercase font-bold mb-2">
                    Coming Soon
                  </span>
                  
                  <h3 className="text-lg font-display font-bold text-text-primary tracking-tight mb-3">
                    Adaptive Intelligence at Your Service
                  </h3>
                  
                  <p className="text-sm text-text-secondary leading-relaxed font-sans max-w-md">
                    Our AI-powered guardrail recommendations, automated health rating models, and simulated action guides are currently undergoing extensive parameter audits on Base. Joining the waitlist guarantees early access to this feature upon release.
                  </p>
                </div>
              </motion.div>
            )}

            {/* VIEW D: PORTFOLIO TAB (Aggregate Vaults Portfolio Under Protective Firewall) */}
            {activeTab === "portfolio" && (
              <motion.div
                key="portfolio"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="space-y-6 max-w-5xl"
              >
                <div className="border-b border-border-subtle pb-5">
                  <h1 className="text-2xl font-display font-extrabold tracking-tight text-text-primary mb-1">DeFi Portfolio</h1>
                  <p className="text-text-secondary font-mono text-xs">Insured capital backing and automated flash hedges across monitored vaults</p>
                </div>

                {/* Macro metrics columns */}
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4.5">
                  <div className="bg-surface-raised/50 border border-border-subtle p-4.5 rounded-lg">
                    <span className="block text-2xs font-mono text-text-muted uppercase font-bold">Insured Capital</span>
                    <span className="text-2xl font-mono font-bold text-text-primary mt-1 block">$18,450</span>
                    <span className="text-2xs font-mono text-risk-low bg-risk-low/5 px-1.5 py-0.5 rounded-sm border border-risk-low/10 inline-block mt-1">● Guard active</span>
                  </div>

                  <div className="bg-surface-raised/50 border border-border-subtle p-4.5 rounded-lg">
                    <span className="block text-2xs font-mono text-text-muted uppercase font-bold">Insured Liabilities</span>
                    <span className="text-2xl font-mono font-bold text-text-primary mt-1 block">$9,310</span>
                    <span className="text-2xs font-mono text-text-secondary mt-1 block">Net LTV ratio: 50%</span>
                  </div>

                  <div className="bg-surface-raised/50 border border-border-subtle p-4.5 rounded-lg">
                    <span className="block text-2xs font-mono text-text-muted uppercase font-bold">Multi-Chain Pools</span>
                    <span className="text-2xl font-mono font-bold text-panik-orange mt-1 block">4 Pools</span>
                    <span className="text-2xs font-mono text-text-secondary mt-1 block">Aave, Compound, Moonwell</span>
                  </div>

                  <div className="bg-surface-raised/50 border border-border-subtle p-4.5 rounded-lg">
                    <span className="block text-2xs font-mono text-text-muted uppercase font-bold">Aggregate Risk Index</span>
                    <span className="text-2xl font-mono font-bold text-risk-low mt-1 block">22 / 100</span>
                    <span className="text-2xs font-mono text-risk-low font-bold block mt-1">SECURE HEALTH STATUS</span>
                  </div>
                </div>

                {/* Dual Column Layout with Asset Visualization */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-4">
                  {/* Left Column: Connected DeFi positions list (lg:col-span-7) */}
                  <div className="lg:col-span-7 bg-white/[0.01] border border-border-subtle rounded-lg p-5.5">
                    <h3 className="text-sm font-mono tracking-widest text-text-muted font-bold uppercase mb-4 flex items-center justify-between">
                      <span>List of Connected DeFi positions</span>
                      <span className="text-2xs text-panik-orange font-normal">Active Guardrails</span>
                    </h3>

                    <div className="space-y-4">
                      {VAULT_PRESETS.map((vault) => {
                        const calculatedHF = +(2.5 - (vault.baseRisk / 60)).toFixed(2);
                        return (
                          <div 
                            key={vault.id} 
                            onClick={() => setSelectedRiskBreakdownPreset(vault)}
                            className="flex flex-col sm:flex-row justify-between sm:items-center p-4 rounded-md border border-border-subtle bg-surface-raised/50 gap-4 hover:border-border-strong hover:bg-surface-raised/70 transition-all cursor-pointer group"
                          >
                            <div className="flex items-center gap-3">
                              <ProtocolLogo protocol={vault.protocol} size="w-8 h-8" />
                              <div>
                                <h4 className="text-xs font-mono font-bold text-text-primary group-hover:text-panik-orange transition-colors">
                                  {vault.protocol} · {vault.assetPair}
                                </h4>
                                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1 text-2xs font-mono text-text-secondary">
                                  <span className={vault.baseRisk < 20 ? "text-risk-low" : "text-risk-elevated"}>
                                    {vault.baseRisk < 20 ? "Conforms to Profile" : "Outside Your Profile"}
                                  </span>
                                  <span className="text-white/20">•</span>
                                  <span>Score: <strong className="text-text-primary">{vault.baseRisk}</strong></span>
                                  <span className="text-white/20">•</span>
                                  <span>Health Factor: <strong className={vault.baseRisk < 20 ? "text-risk-low" : vault.baseRisk < 50 ? "text-risk-elevated" : "text-risk-critical"}>{calculatedHF}</strong></span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-4.5 justify-between sm:justify-start" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => setSelectedRiskBreakdownPreset(vault)}
                                className="px-3.5 py-1.5 rounded-sm bg-panik-orange/10 hover:bg-panik-orange text-2xs font-mono font-bold text-panik-orange hover:text-surface-base border border-panik-orange/30 tracking-wider cursor-pointer transition-all"
                              >
                                View Risk Breakdown →
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right Column: Asset Allocation visual breakdown (lg:col-span-5) */}
                  <div className="lg:col-span-5 bg-white/[0.01] border border-border-subtle rounded-lg p-5.5 flex flex-col justify-between">
                    <div>
                      <h3 className="text-sm font-mono tracking-widest text-text-muted font-bold uppercase mb-4">
                        Asset Allocation Weight
                      </h3>
                      <p className="text-xs text-text-secondary leading-normal mb-5 font-sans">
                        Breakdown of collateral asset distributions backing the protected portfolio vault lines.
                      </p>

                      <div className="space-y-5">
                        {/* Beautiful segmented bar visual indicator representing asset weight allocation */}
                        <div className="h-4.5 w-full bg-white/[0.03] rounded-full overflow-hidden flex border border-border-subtle shadow-lg">
                          <div className="h-full bg-indigo-500 transition-all duration-300 hover:opacity-90" style={{ width: '43.5%' }} title="wstETH: 43.5%"></div>
                          <div className="h-full bg-sky-500 transition-all duration-300 hover:opacity-90" style={{ width: '37.9%' }} title="USDC: 37.9%"></div>
                          <div className="h-full bg-panik-orange transition-all duration-300 hover:opacity-90" style={{ width: '10.5%' }} title="ETH: 10.5%"></div>
                          <div className="h-full bg-risk-low transition-all duration-300 hover:opacity-90" style={{ width: '8.1%' }} title="USDT: 8.1%"></div>
                        </div>

                        {/* Custom asset distribution breakdown list */}
                        <div className="space-y-2.5">
                          {/* wstETH */}
                          <div className="flex justify-between items-center bg-white/[0.02] border border-border-subtle p-3 rounded-md hover:bg-white/[0.04] transition-all">
                            <div className="flex items-center gap-2.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
                              <span className="font-mono text-xs font-bold text-text-primary">wstETH (LST Locked)</span>
                            </div>
                            <div className="text-right">
                              <span className="font-mono text-xs font-bold text-text-primary">$8,022</span>
                              <span className="block text-2xs font-mono text-text-secondary">43.5% weight</span>
                            </div>
                          </div>

                          {/* USDC */}
                          <div className="flex justify-between items-center bg-white/[0.02] border border-border-subtle p-3 rounded-md hover:bg-white/[0.04] transition-all">
                            <div className="flex items-center gap-2.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-sky-500"></span>
                              <span className="font-mono text-xs font-bold text-text-primary">USDC Spot</span>
                            </div>
                            <div className="text-right">
                              <span className="font-mono text-xs font-bold text-text-primary">$7,000</span>
                              <span className="block text-2xs font-mono text-text-secondary">37.9% weight</span>
                            </div>
                          </div>

                          {/* ETH */}
                          <div className="flex justify-between items-center bg-white/[0.02] border border-border-subtle p-3 rounded-md hover:bg-white/[0.04] transition-all">
                            <div className="flex items-center gap-2.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-panik-orange"></span>
                              <span className="font-mono text-xs font-bold text-text-primary">ETH Spot</span>
                            </div>
                            <div className="text-right">
                              <span className="font-mono text-xs font-bold text-text-primary">$1,928</span>
                              <span className="block text-2xs font-mono text-text-secondary">10.5% weight</span>
                            </div>
                          </div>

                          {/* USDT */}
                          <div className="flex justify-between items-center bg-white/[0.02] border border-border-subtle p-3 rounded-md hover:bg-white/[0.04] transition-all">
                            <div className="flex items-center gap-2.5">
                              <span className="w-2.5 h-2.5 rounded-full bg-risk-low"></span>
                              <span className="font-mono text-xs font-bold text-text-primary">USDT Pool</span>
                            </div>
                            <div className="text-right">
                              <span className="font-mono text-xs font-bold text-text-primary">$1,500</span>
                              <span className="block text-2xs font-mono text-text-secondary">8.1% weight</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 p-3 bg-panik-orange/5 border border-panik-orange/15 rounded-md text-2xs font-mono text-text-secondary leading-relaxed">
                      💡 All positions undergo real-time continuous drift analysis against active collateral price benchmarks.
                    </div>
                  </div>
                </div>

              </motion.div>
            )}

          </AnimatePresence>
        </div>

        {/* 3. SLIDE-OUT PANEL FOR DETAILED RISK BREAKDOWN (Linear/Stripe style) */}
        <AnimatePresence>
          {selectedRiskBreakdownPreset && (
            <>
              {/* Overlay backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.5 }}
                exit={{ opacity: 0 }}
                onClick={() => setSelectedRiskBreakdownPreset(null)}
                className="absolute inset-0 bg-surface-base/85 z-40 backdrop-blur-xs cursor-pointer"
              />
              
              {/* Slide-out side panel */}
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", damping: 26, stiffness: 220 }}
                className="absolute right-0 top-0 bottom-0 w-full sm:w-[500px] bg-surface-raised border-l border-border-subtle shadow-[0_0_50px_rgba(0,0,0,0.8)] z-50 flex flex-col overflow-hidden text-sm"
              >
                {/* Panel Header */}
                <div className="shrink-0 p-6 border-b border-border-subtle flex items-center justify-between bg-surface-raised/60 font-sans">
                  <div className="flex items-center gap-3">
                    <ProtocolLogo protocol={selectedRiskBreakdownPreset.protocol} size="w-8 h-8" />
                    <div>
                      <h3 className="font-mono font-bold text-text-primary text-sm uppercase">
                        {selectedRiskBreakdownPreset.protocol} Risk Breakdown
                      </h3>
                      <span className="text-2xs font-mono text-text-secondary uppercase block">
                        {selectedRiskBreakdownPreset.assetPair}
                      </span>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => setSelectedRiskBreakdownPreset(null)}
                    className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary hover:text-text-primary border border-border-subtle cursor-pointer transition-colors"
                    title="Close Panel"
                  >
                    <X className="w-4.5 h-4.5" />
                  </button>
                </div>

                {/* Panel Body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  
                  {/* Scoreboard View */}
                  <div className="bg-surface-raised/40 border border-border-subtle rounded-md p-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-2xs font-mono text-text-muted uppercase tracking-widest">Panik Risk Score</span>
                      <span className={`text-2xs font-mono font-bold px-2.5 py-0.5 rounded-sm border ${
                        selectedRiskBreakdownPreset.baseRisk < 20 ? "bg-risk-low/10 text-risk-low border-risk-low/25" :
                        selectedRiskBreakdownPreset.baseRisk < 50 ? "bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25" :
                        "bg-risk-critical/10 text-risk-critical border-risk-critical/25"
                      }`}>
                        {selectedRiskBreakdownPreset.riskStatus}
                      </span>
                    </div>
                    
                    <div className="flex items-baseline justify-center gap-1.5">
                      <span className="text-4xl font-mono font-bold text-text-primary tracking-tighter">
                        {selectedRiskBreakdownPreset.baseRisk}
                      </span>
                      <span className="text-xs font-mono text-text-muted">/ 100</span>
                    </div>

                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${
                          selectedRiskBreakdownPreset.baseRisk < 20 ? "bg-risk-low" :
                          selectedRiskBreakdownPreset.baseRisk < 50 ? "bg-risk-elevated" :
                          "bg-risk-critical"
                        }`}
                        style={{ width: `${selectedRiskBreakdownPreset.baseRisk}%` }}
                      ></div>
                    </div>

                    {/* Sub scores (Position, Pool, Protocol Score) */}
                    <div className="grid grid-cols-3 gap-2 pt-2 text-center text-xs font-mono">
                      <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                        <span className="block text-2xs text-text-muted uppercase mb-0.5">Position</span>
                        <strong className="text-text-primary">{selectedRiskBreakdownPreset.baseRisk}</strong>
                      </div>
                      <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                        <span className="block text-2xs text-text-muted uppercase mb-0.5">Pool</span>
                        <strong className="text-text-primary">{Math.max(10, selectedRiskBreakdownPreset.baseRisk - 8)}</strong>
                      </div>
                      <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                        <span className="block text-2xs text-text-muted uppercase mb-0.5">Protocol</span>
                        <strong className="text-text-primary">{Math.max(10, selectedRiskBreakdownPreset.baseRisk - 14)}</strong>
                      </div>
                    </div>
                  </div>

                  {/* 10 Risk Dimensions Table/Cards Grid */}
                  <div className="space-y-3">
                    <span className="block text-2xs font-mono text-text-muted tracking-wider uppercase">
                      Liquidation & Pool Metrics
                    </span>
                    
                    <div className="grid grid-cols-2 gap-3">
                      {/* Dimension 1: LTV */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">1. LTV Rating</span>
                        <span className="text-base font-mono font-bold text-text-primary mt-1">
                          {Math.round((selectedRiskBreakdownPreset.defaultBorrow / (selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)) * 100)}%
                        </span>
                      </div>

                      {/* Dimension 2: Health Factor */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">2. Health Factor</span>
                        <span className={`text-base font-mono font-bold mt-1 ${
                          (2.5 - (selectedRiskBreakdownPreset.baseRisk / 60)) < 1.3 ? "text-risk-critical" :
                          (2.5 - (selectedRiskBreakdownPreset.baseRisk / 60)) < 1.70 ? "text-risk-elevated" : "text-risk-low"
                        }`}>
                          {(2.5 - (selectedRiskBreakdownPreset.baseRisk / 60)).toFixed(2)}
                        </span>
                      </div>

                      {/* Dimension 3: Liquidation Price */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">3. Liquidation Price</span>
                        <span className="text-sm font-mono font-bold text-panik-orange mt-1">
                          {formatCurrency(selectedRiskBreakdownPreset.defaultPrice * 0.72)}
                        </span>
                      </div>

                      {/* Dimension 4: Buffer to Liquidation */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">4. Buffer to Liquidation</span>
                        <span className="text-base font-mono font-bold text-text-primary mt-1">
                          {Math.round(((selectedRiskBreakdownPreset.defaultPrice - (selectedRiskBreakdownPreset.defaultPrice * 0.72)) / selectedRiskBreakdownPreset.defaultPrice) * 100)}%
                        </span>
                      </div>

                      {/* Dimension 5: Collateral Value */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">5. Collateral Value</span>
                        <span className="text-xs font-mono font-bold text-text-primary mt-1 truncate">
                          {selectedRiskBreakdownPreset.defaultCollateral} {selectedRiskBreakdownPreset.collateralAsset} ({formatCurrency(selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)})
                        </span>
                      </div>

                      {/* Dimension 6: Borrowed Amount */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">6. Borrowed Amount</span>
                        <span className="text-xs font-mono font-bold text-text-primary mt-1 truncate">
                          {selectedRiskBreakdownPreset.defaultBorrow} {selectedRiskBreakdownPreset.debtAsset}
                        </span>
                      </div>

                      {/* Dimension 7: Pool Utilization */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md col-span-2 flex justify-between items-center text-xs font-mono">
                        <span className="text-2xs font-mono text-text-muted uppercase">7. Pool Borrow Utilization</span>
                        <span className="text-xs font-mono font-bold text-risk-low">
                          {72 + (selectedRiskBreakdownPreset.baseRisk % 12)}% (Optimal range)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Dimension 8, 9, 10: Risk Signals */}
                  <div className="space-y-3.5">
                    <span className="block text-2xs font-mono text-text-muted tracking-wider uppercase">
                      Risk Signals & Drivers
                    </span>

                    <div className="space-y-2 text-xs font-mono">
                      {/* Dimension 8: Protocol Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">8. Protocol Security Signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.protocol === "Aave V3" && "Aave V3 safety module is fully funded. 0 exploits reported. Dynamic interest rate curves active. Multi-sig governance secure."}
                          {selectedRiskBreakdownPreset.protocol === "Compound" && "Compound Protocol holds secure decentralized oracle reserves. Peg deviations are zero. Governance keys held in multi-sig."}
                          {selectedRiskBreakdownPreset.protocol === "Moonwell" && "Moonwell Protocol is fully monitored by Base RPC. 48-hour governance timelock on system variables active."}
                          {selectedRiskBreakdownPreset.protocol === "GMX" && "GMX leverage pool operates with a robust pool backstop. Total locked value represents 120% debt security. Fully backed."}
                        </p>
                      </div>

                      {/* Dimension 9: Pool Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">9. Pool Liquidity Signal</span>
                        <p className="text-text-secondary">
                          Primary pool depth exceeds $82,000,000 in active vault lines. Slippage parameters on decentralized exchanges index &lt; 0.15% depth buffer. No oracle drift.
                        </p>
                      </div>

                      {/* Dimension 10: Position Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">10. Position Watch Signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.baseRisk < 20 
                            ? "Position health maintains normal volatility parameters. No automated hedges currently required."
                            : "Position health has entered an elevated stress variance range. Automatic sentinel flash-loan repayment prepared at under < 1.25 health factor."
                          }
                        </p>
                      </div>
                    </div>
                  </div>



                </div>

                {/* Panel Footer */}
                <div className="shrink-0 p-5 border-t border-border-subtle bg-surface-base flex gap-3 font-sans">
                  <button
                    onClick={() => setSelectedRiskBreakdownPreset(null)}
                    className="flex-1 py-3 text-center text-xs font-mono text-text-secondary bg-white/5 hover:bg-white/10 rounded-md cursor-pointer transition-colors border border-border-subtle"
                  >
                    Close Panel
                  </button>
                  <button
                    onClick={() => {
                      setSelectedPresetId(selectedRiskBreakdownPreset.id);
                      setActiveTab("watch");
                      setSelectedRiskBreakdownPreset(null);
                    }}
                    className="flex-1 py-3 text-center text-xs font-mono font-bold text-surface-base bg-panik-orange rounded-md cursor-pointer hover:opacity-90 transition-all shadow-lg"
                  >
                    Open Simulator ⚡
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

      </div>

    </div>
  );
}
