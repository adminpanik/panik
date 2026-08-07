/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  X,
  ChevronDown,
} from "lucide-react";
import { calculateDynamicPosition, formatCompactUsd, formatCurrency, RISK_CHIP } from "./lib/utils";
import { PositionState } from "./lib/types";
import { LivePositions } from "./components/LivePositions";
import { Sparkline } from "./components/Sparkline";
import { OpenPositionModal } from "./components/OpenPositionModal";
import { InfoTip } from "./components/InfoTip";
import { Button, Card, EmptyState, Stat } from "./ui";
import {
  useAdvisor,
  useChainTelemetry,
  useCompassScores,
  useCompassYields,
  useLiveScores,
  useProspective,
  useWalletHistory,
  useWalletPositions,
  useWalletRegistry,
  type LiveProtocol,
} from "./lib/live";
import { AdvisorPanel } from "./components/AdvisorPanel";
import { ExitFlow, type ExitPrefill } from "./components/ExitFlow";
import { OpenFlow } from "./components/OpenFlow";
import { AdvisorPopup } from "./components/AdvisorPopup";
import type { AdvisorOpenPlan } from "./lib/live";
import { ProtocolLogo } from "./components/ProtocolLogo";
import { Onboarding } from "./components/Onboarding";
import {
  forgetRegistration,
  registerWatchedWallet,
  useTelegramLink,
  useWalletOwnership,
  isEvmAddress,
  type RegisterResult,
  type RiskProfile as WatchRiskProfile,
} from "./lib/telegram";
import {
  SEGMENT_LABELS,
  RISK_TIER_LABELS,
  type Segment,
  type RiskTier,
  type ProfileResult,
} from "./lib/profiling";
import { motion, AnimatePresence } from "motion/react";

type SidebarTab = "compass" | "watch" | "advisor" | "portfolio" | "settings";

/** Source of truth for the sidebar: order here is the arrow-key order. */
const TABS: { id: SidebarTab; label: string; icon: typeof Wallet }[] = [
  { id: "portfolio", label: "Portfolio", icon: Wallet },
  { id: "compass", label: "Compass", icon: CompassIcon },
  { id: "watch", label: "Watch", icon: Eye },
  { id: "advisor", label: "Advisor", icon: Sparkles },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

/**
 * Watch tab data source. "positions" = the user's REAL on-chain positions
 * (the business requirement: Watch mirrors what you actually hold), seeded
 * into the stress-test simulator. "recommendations" = the Compass preset
 * catalog for what-if auditing before opening a position.
 */
type WatchSource = "positions" | "recommendations";
type RiskProfile = "conservative" | "moderate" | "aggressive";

/**
 * The user-segment badge is a label, not a measurement. Five cool hues used to
 * distinguish five segments the user can only ever be ONE of at a time, so the
 * hue encoded nothing the word next to it did not already say — it just put a
 * saturated pill in the header competing with the risk chips below it. One
 * neutral style, distinguished by its text, same as the tier badge.
 */
const SEGMENT_BADGE = "bg-white/5 text-text-secondary border-border-subtle";

/**
 * The risk PROFILE badge is one style for all five tiers, distinguished by its
 * label alone. A profile is a preference the user stated, not a danger level the
 * engine measured, so it must not borrow the risk ramp: an "aggressive" profile
 * painted red reads as "your positions are in trouble". The old five-step ramp
 * also put `moderate` and `moderately_aggressive` a dE of 7.8 apart, which is to
 * say it encoded a distinction nobody could see.
 */
const TIER_BADGE = "bg-white/5 text-text-secondary border-border-subtle";

const truncateAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * Settings: the Emergency Auto Repayment card is hidden per business-dev QA
 * (2026-07-03) until the Deleverager actually ships. Code kept intact.
 */
const SHOW_AUTO_REPAY_CARD = false;

const LIVE_PROTOCOL_LABEL: Record<LiveProtocol, "Aave V3" | "Moonwell" | "Morpho" | "Compound V3"> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/** Alert-outcome chip copy for the Portfolio history feed. */
/**
 * Delivery outcome, not risk. "Sent" was green and "queued" amber, which put
 * the risk ramp on a fact about our own plumbing. Only `blocked` keeps a hue:
 * it is the one state where PANIK is failing to reach the user, and that is
 * worth interrupting for.
 */
const NOTIFY_CHANNEL_CHIP: Record<string, { label: string; cls: string }> = {
  telegram: { label: "SENT · TELEGRAM", cls: "text-text-muted border-border-subtle bg-white/[0.03]" },
  skipped: { label: "RECOVERY", cls: "text-text-muted border-border-subtle bg-white/[0.03]" },
  suppressed_cooldown: { label: "MUTED · COOLDOWN", cls: "text-text-muted border-border-subtle bg-white/[0.03]" },
  suppressed_immaterial: { label: "MUTED · NO DEBT", cls: "text-text-muted border-border-subtle bg-white/[0.03]" },
  blocked: { label: "BOT BLOCKED", cls: "text-risk-critical border-risk-critical/25 bg-risk-critical/10" },
};

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Per-wallet onboarding profiles ──────────────────────────────────────────
// Answers persist per wallet so switching BACK to a previously onboarded
// address restores its profile instantly (the quiz is never asked twice).
const PROFILE_STORE_KEY = "panik_profiles_by_wallet";

function loadProfileStore(): Record<string, ProfileResult> {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_STORE_KEY) ?? "{}") as Record<string, ProfileResult>;
  } catch {
    return {};
  }
}

function saveProfileForWallet(wallet: string, result: ProfileResult): void {
  const store = loadProfileStore();
  store[wallet.toLowerCase()] = result;
  localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(store));
}

interface VaultPreset {
  id: string;
  protocol: "Aave V3" | "Moonwell" | "Morpho" | "Compound V3";
  /** Engine identifiers — must match packages/scoring MARKETS + the API's COMPASS_SCENARIOS ids. */
  engineProtocol: "aave_v3" | "moonwell" | "morpho" | "compound_v3";
  collateralSymbol: string;
  assetPair: string;
  collateralAsset: string;
  debtAsset: string;
  defaultCollateral: number;
  defaultBorrow: number;
  defaultPrice: number;
  /** Static fallback; overridden by live DefiLlama pool APY when the API is up. */
  apy: number;
  baseRisk: number; // Offline fallback, overridden by live engine scores when the API is up
  riskStatus: "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";
}

/**
 * Composite weights mirrored from packages/scoring params.COMPOSITE_WEIGHTS
 * (0.40 position / 0.25 asset / 0.20 protocol / 0.15 systemic). Display-only;
 * keep in sync if the engine weights change.
 */
const SUB_SCORE_WEIGHTS = { positionHealth: 0.4, assetRisk: 0.25, protocolSafety: 0.2, systemicRisk: 0.15 } as const;

/**
 * Offline-only sub-score estimates whose WEIGHTED SUM reproduces the composite
 * (the old UI showed fabricated Position/Pool/Protocol numbers that did not
 * reconcile with the headline score - the exact QA complaint). Live engine
 * sub-scores replace these whenever /api/compass is reachable.
 */
function demoSubScores(total: number) {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const positionHealth = clamp(total + 12);
  const assetRisk = clamp(total + 2);
  const protocolSafety = clamp(total - 10);
  const systemicRisk = clamp(
    (total -
      SUB_SCORE_WEIGHTS.positionHealth * positionHealth -
      SUB_SCORE_WEIGHTS.assetRisk * assetRisk -
      SUB_SCORE_WEIGHTS.protocolSafety * protocolSafety) /
      SUB_SCORE_WEIGHTS.systemicRisk,
  );
  return { positionHealth, assetRisk, protocolSafety, systemicRisk };
}

/**
 * Simulator scenario presets (one-tap answers before sliders). Magnitudes are
 * anchored to the backtest event set (docs/technical-docs/BACKTEST_METHODOLOGY.md)
 * rather than arbitrary round numbers.
 */
const PRICE_SCENARIOS = [
  { key: "current", label: "Current", pct: 0, note: "market price" },
  { key: "stress", label: "Stress", pct: -0.2, note: "sharp correction" },
  { key: "crash", label: "Crash", pct: -0.4, note: "FTX week, Nov 2022" },
  { key: "blackswan", label: "Black swan", pct: -0.55, note: "ETH, Jun 2022" },
] as const;
type ScenarioKey = (typeof PRICE_SCENARIOS)[number]["key"] | "custom";

// Engine-supported presets (Aave V3 + Moonwell on Base — the camp scope).
// USD sizes mirror the API's COMPASS_SCENARIOS so live scores map 1:1 by id.
const VAULT_PRESETS: VaultPreset[] = [
  {
    id: "aave-usdc-supply",
    protocol: "Aave V3",
    engineProtocol: "aave_v3",
    collateralSymbol: "USDC",
    assetPair: "USDC SUPPLY BUFFER",
    collateralAsset: "USDC",
    debtAsset: "USDC",
    defaultCollateral: 2000,
    defaultBorrow: 500,
    defaultPrice: 1,
    apy: 8.2,
    baseRisk: 8,
    riskStatus: "LOW",
  },
  {
    id: "moonwell-usdc-supply",
    protocol: "Moonwell",
    engineProtocol: "moonwell",
    collateralSymbol: "USDC",
    assetPair: "USDC LIQUIDITY YIELD",
    collateralAsset: "USDC",
    debtAsset: "USDC",
    defaultCollateral: 1500,
    defaultBorrow: 300,
    defaultPrice: 1,
    apy: 7.4,
    baseRisk: 15,
    riskStatus: "LOW",
  },
  {
    id: "aave-wsteth-vault",
    protocol: "Aave V3",
    engineProtocol: "aave_v3",
    collateralSymbol: "wstETH",
    assetPair: "wstETH / USDC VAULT",
    collateralAsset: "wstETH",
    debtAsset: "USDC",
    defaultCollateral: 4,
    defaultBorrow: 4500,
    defaultPrice: 2000,
    apy: 5.2,
    baseRisk: 41,
    riskStatus: "ELEVATED",
  },
  {
    id: "aave-weth-borrow",
    protocol: "Aave V3",
    engineProtocol: "aave_v3",
    collateralSymbol: "WETH",
    assetPair: "WETH / USDC BORROW",
    collateralAsset: "WETH",
    debtAsset: "USDC",
    defaultCollateral: 3,
    defaultBorrow: 2000,
    defaultPrice: 1667,
    apy: 6.9,
    baseRisk: 22,
    riskStatus: "LOW",
  },
  {
    id: "moonwell-weth-debt",
    protocol: "Moonwell",
    engineProtocol: "moonwell",
    collateralSymbol: "WETH",
    assetPair: "WETH / USDC DEBT",
    collateralAsset: "WETH",
    debtAsset: "USDC",
    defaultCollateral: 1.2,
    defaultBorrow: 1300,
    defaultPrice: 1667,
    apy: 5.7,
    baseRisk: 52,
    riskStatus: "HIGH",
  },
  {
    id: "moonwell-cbeth-max",
    protocol: "Moonwell",
    engineProtocol: "moonwell",
    collateralSymbol: "cbETH",
    assetPair: "cbETH MAX LEVERAGE",
    collateralAsset: "cbETH",
    debtAsset: "USDC",
    defaultCollateral: 0.8,
    defaultBorrow: 1050,
    defaultPrice: 1888,
    apy: 12.5,
    baseRisk: 76,
    riskStatus: "CRITICAL",
  },
  {
    id: "morpho-weth-loop",
    protocol: "Morpho",
    engineProtocol: "morpho",
    collateralSymbol: "WETH",
    assetPair: "WETH / USDC MARKET (86% LLTV)",
    collateralAsset: "WETH",
    debtAsset: "USDC",
    defaultCollateral: 2.4,
    defaultBorrow: 2400,
    defaultPrice: 1667,
    apy: 7.8,
    baseRisk: 38,
    riskStatus: "ELEVATED",
  },
  {
    id: "compound-weth-borrow",
    protocol: "Compound V3",
    engineProtocol: "compound_v3",
    collateralSymbol: "WETH",
    assetPair: "WETH / USDC COMET",
    collateralAsset: "WETH",
    debtAsset: "USDC",
    defaultCollateral: 1.8,
    defaultBorrow: 1500,
    defaultPrice: 1667,
    apy: 6.1,
    baseRisk: 30,
    riskStatus: "ELEVATED",
  }
];

export function AppDemo() {
  // Navigation tabs exactly reflecting the Figma screenshot
  const [activeTab, setActiveTab] = useState<SidebarTab>("portfolio");

  // Arrow / Home / End navigation for the tablist. Focus has to be moved
  // explicitly: the roving tabindex means the newly selected tab is the only
  // one focusable, and without this the browser would leave focus on a button
  // that just became tabindex="-1".
  const tabRefs = useRef<Partial<Record<SidebarTab, HTMLButtonElement | null>>>({});
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const i = TABS.findIndex((t) => t.id === activeTab);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    const id = TABS[next].id;
    setActiveTab(id);
    tabRefs.current[id]?.focus();
  };
  const [tooltipStep, setTooltipStep] = useState<number | null>(() => {
    const onboarded = localStorage.getItem("panik_onboarded") === "true";
    const tourSeen = localStorage.getItem("panik_tour_seen") === "true";
    return (onboarded && !tourSeen) ? 1 : null;
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string>("moonwell-weth-debt");
  const [selectedRiskProfile, setSelectedRiskProfile] = useState<RiskProfile>(
    () => (localStorage.getItem("panik_risk_profile") as RiskProfile | null) ?? "moderate"
  );
  const [selectedRiskBreakdownPreset, setSelectedRiskBreakdownPreset] = useState<VaultPreset | null>(null);
  // Demo-only open-position flow (no signing; see OpenPositionModal).
  const [openPositionPreset, setOpenPositionPreset] = useState<VaultPreset | null>(null);
  // Watch tab: market/preset selector dropdown
  const [watchDropOpen, setWatchDropOpen] = useState<boolean>(false);
  const watchDropRef = useRef<HTMLDivElement>(null);

  // ── First-time onboarding (no backend — localStorage-persisted) ──────────
  const [showOnboarding, setShowOnboarding] = useState<boolean>(
    () => localStorage.getItem("panik_onboarded") !== "true"
  );
  const [onboardedWallet, setOnboardedWallet] = useState<string | null>(
    () => localStorage.getItem("panik_wallet")
  );
  const [userSegment, setUserSegment] = useState<Segment | null>(
    () => localStorage.getItem("panik_user_segment") as Segment | null
  );
  const [riskTier, setRiskTier] = useState<RiskTier | null>(
    () => localStorage.getItem("panik_risk_tier") as RiskTier | null
  );

  const handleOnboardingComplete = (result: ProfileResult, wallet: string) => {
    saveProfileForWallet(wallet.trim(), result); // per-wallet memory (wallet-switch flow)
    localStorage.setItem("panik_onboarded", "true");
    localStorage.setItem("panik_risk_profile", result.riskProfile3); // 3-level (Compass)
    localStorage.setItem("panik_risk_tier", result.riskTier);         // 5-level (display)
    localStorage.setItem("panik_user_segment", result.segment);
    localStorage.setItem("panik_risk_score", String(result.riskScore));
    localStorage.setItem("panik_wallet", wallet);
    setSelectedRiskProfile(result.riskProfile3);
    setUserSegment(result.segment);
    setRiskTier(result.riskTier);
    setOnboardedWallet(wallet);
    setShowOnboarding(false);
    
    // Start the tutorial tour if they haven't seen it yet
    if (localStorage.getItem("panik_tour_seen") !== "true") {
      setTooltipStep(1);
    }

    // Register this wallet for monitoring (never blocks entry). Asks for an
    // ownership signature, which a pasted hardware / cold / Safe / other-browser
    // address simply cannot produce. That used to fail SILENTLY: dashboard
    // works, user believes they are covered, no alert ever arrives. Now the
    // failure raises a persistent banner with a retry.
    void enableMonitoring(wallet.trim(), result.riskProfile3);
  };

  // Backfill: users onboarded before per-wallet profiles existed only have
  // the flat localStorage keys. Persist their profile into the store once so
  // they can switch away and back without redoing the quiz.
  useEffect(() => {
    if (!onboardedWallet || !userSegment || !riskTier) return;
    if (loadProfileStore()[onboardedWallet.toLowerCase()]) return;
    saveProfileForWallet(onboardedWallet, {
      riskScore: Number(localStorage.getItem("panik_risk_score") ?? 50),
      riskTier,
      riskTierLabel: RISK_TIER_LABELS[riskTier],
      riskProfile3: selectedRiskProfile,
      segment: userSegment,
      segmentLabel: SEGMENT_LABELS[userSegment],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardedWallet, userSegment, riskTier]);

  // Saved per-wallet profiles for the wallet-switch flow. Recomputed whenever
  // the overlay opens so a just-saved profile is seen.
  const savedProfiles = useMemo(
    () => loadProfileStore(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onboardedWallet, showOnboarding],
  );

  // Telemetry simulation
  const [blockNumber, setBlockNumber] = useState<number>(19384910);
  const [gasPrice, setGasPrice] = useState<number>(2.8);
  const [secTillUpdate, setSecTillUpdate] = useState<number>(60);
  const [logs, setLogs] = useState<string[]>([
    "08:04:12 UTC - Risk engine initialized on Base RPC node.",
    "08:04:13 UTC - Position listener bound. Connected presets loaded.",
    "08:04:15 UTC - Status OK. Integrity rate: 99.8%"
  ]);

  // Settings tab preferences (auto-repayment trigger).
  const [automaticRepayTarget, setAutomaticRepayTarget] = useState<number>(30);
  const [isRepayActive, setIsRepayActive] = useState<boolean>(true);

  // ── LIVE data (scoring API; every hook degrades gracefully offline) ──────
  // Declared FIRST — the memos below consume these (const = TDZ).
  const { positions: livePositions, updatedAt: liveUpdatedAt, offline: liveOffline } = useLiveScores();
  const { scores: compassLive } = useCompassScores();
  const { pools: poolYields } = useCompassYields();
  const chainTel = useChainTelemetry();

  // Once a user has onboarded with their OWN wallet, the dashboard follows that
  // wallet (its live Base positions) instead of the seeded validation registry.
  // boundMode hides the registry selector entirely. (SIWE later proves ownership.)
  const boundMode = Boolean(onboardedWallet);
  const ownLive = useWalletPositions(onboardedWallet, selectedRiskProfile);

  // AI Advisor (Phase 2): live report for the onboarded wallet. Null while
  // offline or pre-onboarding - the tab keeps its Coming-Soon fallback then.
  const advisorLive = useAdvisor(onboardedWallet, selectedRiskProfile);
  // Atomic Exit modal (Phase 2): opened from Advisor CTAs with a prefill.
  const [exitPrefill, setExitPrefill] = useState<ExitPrefill | null>(null);
  // In-app open flow (Phase 2): opened from Advisor opportunity CTAs.
  const [openFlowPlan, setOpenFlowPlan] = useState<AdvisorOpenPlan | null>(null);

  // Telegram alert linking (Connect Telegram lives in the Settings tab).
  // Each wallet-scoped write signs its OWN action-bound, single-use proof: a
  // "register my wallet" signature must not double as authorization to
  // redirect this wallet's liquidation alerts to a stranger's Telegram.
  const { getProof } = useWalletOwnership();
  const telegramLink = useTelegramLink(getProof);

  // ── Monitoring status (the alerts this product exists to send) ───────────
  // Registration needs a signature the wallet must actually be able to produce.
  // When it fails the user is UNMONITORED, so the failure is surfaced instead
  // of swallowed. Null = fine (or not attempted yet).
  const [monitoringError, setMonitoringError] = useState<string | null>(null);
  const [monitoringBusy, setMonitoringBusy] = useState(false);
  const [monitoringTarget, setMonitoringTarget] = useState<{ wallet: string; profile: WatchRiskProfile } | null>(null);

  const enableMonitoring = useCallback(
    async (wallet: string, profile: WatchRiskProfile) => {
      setMonitoringTarget({ wallet, profile });
      setMonitoringBusy(true);
      const result = await registerWatchedWallet(wallet, profile, getProof);
      setMonitoringError(result.ok ? null : result.error);
      setMonitoringBusy(false);
    },
    [getProof],
  );

  const retryMonitoring = useCallback(() => {
    if (!monitoringTarget) return;
    // Clear the session dedupe first, or the retry would short-circuit.
    forgetRegistration(monitoringTarget.wallet, monitoringTarget.profile);
    void enableMonitoring(monitoringTarget.wallet, monitoringTarget.profile);
  }, [monitoringTarget, enableMonitoring]);
  const telegramEligible = boundMode && !!onboardedWallet && isEvmAddress(onboardedWallet);
  // Fallback = the real production bot (getMe-verified), so the UI never
  // shows a dead handle even when VITE_TELEGRAM_BOT_USERNAME is unset.
  const telegramBotUsername = (import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined) || "PanikDeFi_Bot";
  // Reflect an existing Telegram link on load (card shows "Connected as @handle").
  useEffect(() => {
    if (telegramEligible && onboardedWallet) void telegramLink.check(onboardedWallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardedWallet, telegramEligible]);

  // A user portfolio is ONE wallet. In boundMode that's the onboarded wallet;
  // otherwise (ops view) the registry holds the validation cohort with a selector.
  const [selectedWallet, setSelectedWallet] = useState<string | "all" | null>(null); // null = not yet initialised
  const registry = useWalletRegistry();
  const wallets = useMemo(() => {
    if (boundMode) return [{ wallet: onboardedWallet as string, label: "Your wallet" }];
    // Registry is the source of truth: wallets with zero readable positions
    // still get a pill (their panel shows "no open positions" honestly).
    if (registry) return registry.map((r) => ({ wallet: r.wallet, label: r.label }));
    if (!livePositions) return [];
    const seen = new Map<string, { wallet: string; label: string | null }>();
    for (const p of livePositions) {
      if (!seen.has(p.wallet)) seen.set(p.wallet, { wallet: p.wallet, label: p.label });
    }
    return [...seen.values()];
  }, [boundMode, onboardedWallet, registry, livePositions]);

  useEffect(() => {
    // boundMode: the selection ALWAYS tracks the onboarded wallet. (Previously
    // a registry wallet selected before onboarding finished stuck around,
    // making the header show a different address than the onboarding chip.)
    if (boundMode && onboardedWallet) {
      if (selectedWallet !== onboardedWallet) setSelectedWallet(onboardedWallet);
      return;
    }
    if (selectedWallet === null && wallets.length > 0) {
      setSelectedWallet(wallets[0]!.wallet);
    }
  }, [boundMode, onboardedWallet, wallets, selectedWallet]);

  const portfolioPositions = useMemo(() => {
    // boundMode: ownLive is already this one wallet's positions — no filtering.
    if (boundMode) return ownLive.positions;
    if (!livePositions) return null;
    return selectedWallet && selectedWallet !== "all"
      ? livePositions.filter((p) => p.wallet === selectedWallet)
      : livePositions;
  }, [boundMode, ownLive.positions, livePositions, selectedWallet]);

  // Presets with LIVE engine scores overlaid (fallback: static baseRisk).
  // Defined before activePreset so Compass, Portfolio and Watch all read
  // the same live-updated objects.
  const presetsWithLive = useMemo(
    () =>
      VAULT_PRESETS.map((p) => {
        const live = compassLive?.[p.id];
        return live ? { ...p, baseRisk: live.total, riskStatus: live.band } : p;
      }),
    [compassLive],
  );

  // Risk-breakdown panel source data (QA fix: the panel used to fabricate
  // Position/Pool/Protocol sub-scores from baseRisk offsets, so its numbers
  // never reconciled with the headline score). Live engine values when
  // /api/compass is up; weighted-consistent demo estimates otherwise.
  const breakdownData = useMemo(() => {
    const p = selectedRiskBreakdownPreset;
    if (!p) return null;
    const live = compassLive?.[p.id] ?? null;
    const subs = live
      ? {
          positionHealth: Math.round(live.subScores.positionHealth),
          assetRisk: Math.round(live.subScores.assetRisk),
          protocolSafety: Math.round(live.subScores.protocolSafety),
          systemicRisk: Math.round(live.subScores.systemicRisk),
        }
      : demoSubScores(p.baseRisk);
    // null HF = no debt (live); the demo fallback keeps the old derivation.
    const healthFactor = live ? live.healthFactor : Math.round((2.5 - p.baseRisk / 60) * 100) / 100;
    const drawdown = live ? live.liquidationDrawdown : 0.28;
    return {
      isLive: Boolean(live),
      subs,
      healthFactor,
      liqPrice: drawdown != null ? p.defaultPrice * (1 - drawdown) : null,
      bufferPct: drawdown != null ? Math.round(drawdown * 100) : null,
      poolYield: poolYields?.[p.id] ?? null,
    };
  }, [selectedRiskBreakdownPreset, compassLive, poolYields]);

  // Portfolio history: alert feed + score series for the selected wallet.
  const historyWallet = boundMode
    ? onboardedWallet
    : selectedWallet && selectedWallet !== "all"
      ? selectedWallet
      : null;
  const walletHistory = useWalletHistory(historyWallet);

  // 30d aggregate risk series: bucket snapshots by day, protocols weighted by
  // collateral USD (same weighting the macro Aggregate Risk Index uses).
  const riskHistory = useMemo(() => {
    const snaps = walletHistory?.snapshots;
    if (!snaps || snaps.length < 2) return null;
    const byDay = new Map<string, { weighted: number; weight: number }>();
    for (const s of snaps) {
      const day = s.created_at.slice(0, 10);
      const w = Math.max(1, Number(s.collateral_usd ?? 0));
      const cur = byDay.get(day) ?? { weighted: 0, weight: 0 };
      cur.weighted += s.total * w;
      cur.weight += w;
      byDay.set(day, cur);
    }
    const days = [...byDay.keys()].sort();
    if (days.length < 2) {
      // Single day of data: fall back to the raw intra-day series.
      return { xStart: "earlier today", series: snaps.map((s) => s.total) };
    }
    return {
      xStart: `${days.length}d ago`,
      series: days.map((d) => {
        const b = byDay.get(d)!;
        return Math.round(b.weighted / b.weight);
      }),
    };
  }, [walletHistory]);

  // Portfolio macro metrics from the SELECTED wallet's live positions
  const liveMacro = useMemo(() => {
    if (!portfolioPositions || portfolioPositions.length === 0) return null;
    // Legs whose USD values are unavailable (degraded price feed) carry no
    // dollar weight here — their scores and health factors are still exact, so
    // `pricesDegraded` marks the totals as an UNDERSTATEMENT rather than truth.
    const usd = (v: number | null) => (v === null || !Number.isFinite(v) ? 0 : v);
    const capital = portfolioPositions.reduce((a, p) => a + usd(p.collateralValueUsd), 0);
    const debt = portfolioPositions.reduce((a, p) => a + usd(p.borrowValueUsd), 0);
    const aggregate =
      capital > 0
        ? Math.round(
            portfolioPositions.reduce((a, p) => a + p.total * usd(p.collateralValueUsd), 0) / capital,
          )
        : 0;
    return {
      capital,
      debt,
      ltv: capital > 0 ? debt / capital : 0,
      positions: portfolioPositions.length,
      protocols: new Set(portfolioPositions.map((p) => p.protocol)).size,
      aggregate,
      pricesDegraded: portfolioPositions.some((p) => p.usdValuesUnavailable),
    };
  }, [portfolioPositions]);

  // Collateral allocation for the SELECTED wallet (mock weights when offline)
  const allocation = useMemo(() => {
    const bySymbol: Record<string, number> = {};
    for (const p of portfolioPositions ?? []) {
      bySymbol[p.scoredCollateralSymbol] =
        (bySymbol[p.scoredCollateralSymbol] ?? 0) + (p.collateralValueUsd ?? 0);
    }
    const src: { symbol: string; usd: number }[] =
      portfolioPositions && portfolioPositions.length > 0
        ? Object.keys(bySymbol)
            .map((symbol) => ({ symbol, usd: bySymbol[symbol] ?? 0 }))
            .sort((a, b) => b.usd - a.usd)
            .slice(0, 4)
        : [
            { symbol: "wstETH (LST Locked)", usd: 8022 },
            { symbol: "USDC Spot", usd: 7000 },
            { symbol: "ETH Spot", usd: 1928 },
            { symbol: "USDT Pool", usd: 1500 },
          ];
    const total = src.reduce((a, b) => a + b.usd, 0) || 1;
    const colors = ["bg-indigo-500", "bg-sky-500", "bg-panik-orange", "bg-risk-low"];
    return src.map((a, i) => ({ ...a, pct: (a.usd / total) * 100, color: colors[i % 4] as string }));
  }, [portfolioPositions]);

  // Load selected preset for Watch/Simulator tab (Recommendations source)
  const activePreset = presetsWithLive.find(p => p.id === selectedPresetId) || presetsWithLive[4];

  // Watch source: defaults to the user's REAL positions (Watch mirrors what
  // you actually hold); Recommendations keeps the Compass-derived sandbox.
  const [watchSource, setWatchSource] = useState<WatchSource>("positions");
  const [selectedLivePositionKey, setSelectedLivePositionKey] = useState<string | null>(null);

  // Real positions mapped into simulator-market shape. The engine scores in
  // USD, so the mock price is only a display anchor: the token amount is
  // derived from it such that amount x price reproduces the position's exact
  // on-chain USD value. baseRisk carries the watch-worker's actual live score,
  // making the simulator's "Current" scenario mirror the real position.
  const watchPositionMarkets = useMemo(
    () =>
      (portfolioPositions ?? []).map((pos) => {
        const base =
          presetsWithLive.find(
            (p) => p.engineProtocol === pos.protocol && p.collateralSymbol === pos.scoredCollateralSymbol,
          ) ?? presetsWithLive.find((p) => p.engineProtocol === pos.protocol);
        const price = base?.defaultPrice ?? (/USD/i.test(pos.scoredCollateralSymbol) ? 1 : 2000);
        const key = `${pos.wallet}:${pos.protocol}:${pos.scoredCollateralSymbol}`;
        const preset: VaultPreset = {
          id: `live:${key}`,
          protocol: LIVE_PROTOCOL_LABEL[pos.protocol],
          engineProtocol: pos.protocol,
          collateralSymbol: pos.scoredCollateralSymbol,
          assetPair: `${pos.scoredCollateralSymbol} / USDC · YOUR POSITION`,
          collateralAsset: pos.scoredCollateralSymbol,
          debtAsset: "USDC",
          // Degraded legs have no USD magnitude to anchor the simulator with;
          // the sliders start at 0 rather than at a fabricated size.
          defaultCollateral:
            price > 0 && pos.collateralValueUsd !== null
              ? Number((pos.collateralValueUsd / price).toFixed(price < 10 ? 0 : 4))
              : 0,
          defaultBorrow: Math.round(pos.borrowValueUsd ?? 0),
          defaultPrice: price,
          apy: base?.apy ?? 0,
          baseRisk: pos.total,
          riskStatus: pos.band,
        };
        return { key, position: pos, preset };
      }),
    [portfolioPositions, presetsWithLive],
  );

  const selectedPositionMarket =
    watchPositionMarkets.find((m) => m.key === selectedLivePositionKey) ?? watchPositionMarkets[0] ?? null;
  const watchingOwnPosition = watchSource === "positions" && selectedPositionMarket !== null;
  // The single market object the whole simulator reads (real position or preset).
  const activeMarket = watchingOwnPosition ? selectedPositionMarket.preset : activePreset;

  // Simulator parameters (sliders + direct numeric inputs)
  const [collateralAmount, setCollateralAmount] = useState<number>(activePreset.defaultCollateral);
  const [borrowAmount, setBorrowAmount] = useState<number>(activePreset.defaultBorrow);
  const [assetPrice, setAssetPrice] = useState<number>(activePreset.defaultPrice);
  // Borrowed-asset price (USDC presets default $1; movable for depeg scenarios
  // like the Mar 2023 USDC/SVB event in the backtest set).
  const [debtPrice, setDebtPrice] = useState<number>(1);
  // Which one-tap scenario chip the price currently matches ("custom" = slider).
  const [activeScenario, setActiveScenario] = useState<ScenarioKey>("current");
  const borrowUsd = borrowAmount * debtPrice;

  // Recommendations internal sub-tab
  const [recommendationsSubTab, setRecommendationsSubTab] = useState<"advisor" | "breakdown">("advisor");
  const [advisorNotifyChecked, setAdvisorNotifyChecked] = useState<boolean>(
    () => localStorage.getItem("panik_advisor_notify") === "true"
  );

  // Synchronize slider state when the active market changes. Keyed on
  // activeMarket.id so switching source (positions vs recommendations),
  // selecting a different real position, or picking another preset all reseed
  // the sliders. Real positions seed the sliders with their on-chain values.
  useEffect(() => {
    setCollateralAmount(activeMarket.defaultCollateral);
    setBorrowAmount(activeMarket.defaultBorrow);
    setAssetPrice(activeMarket.defaultPrice);
    setDebtPrice(1);
    setActiveScenario("current");
    addLog(
      watchingOwnPosition
        ? `Loaded YOUR live position: ${activeMarket.protocol} (${activeMarket.collateralAsset}/${activeMarket.debtAsset})`
        : `Position simulation loaded: ${activeMarket.protocol} (${activeMarket.collateralAsset}/${activeMarket.debtAsset})`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket.id]);

  // Close Watch market dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (watchDropRef.current && !watchDropRef.current.contains(e.target as Node)) {
        setWatchDropOpen(false);
      }
    };
    if (watchDropOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [watchDropOpen]);

  // Calculate dynamic maths based on sliders
  // We check if it is USD backing vs ETH backing to pass safe arguments to the calculator
  const calculateResult = () => {
    // If protocol is Aave V3 or Moonwell, we support official maths
    const protocolName: "Aave V3" | "Moonwell" = (activeMarket.protocol === "Aave V3") ? "Aave V3" : "Moonwell";
    return calculateDynamicPosition(
      protocolName,
      collateralAmount,
      borrowUsd,
      assetPrice
    );
  };

  // Scenario helpers (#3): one-tap price presets before free-form sliders.
  const scenarioPrice = (pct: number) => {
    const target = activeMarket.defaultPrice * (1 + pct);
    return activeMarket.defaultPrice < 10 ? Math.round(target * 100) / 100 : Math.round(target);
  };
  const applyScenario = (key: ScenarioKey, pct: number) => {
    setAssetPrice(scenarioPrice(pct));
    setActiveScenario(key);
    addLog(`Scenario applied: ${key} (${Math.round(pct * 100)}% ${activeMarket.collateralAsset} move)`);
  };

  // LIVE Watch scoring: sliders → the real engine (debounced /api/prospective,
  // live CoinGecko vol + DefiLlama TVL context). Falls back to the local
  // mock formula when the API is offline.
  const prospectiveArgs = useMemo(
    () => ({
      protocol: activeMarket.engineProtocol,
      symbol: activeMarket.collateralSymbol,
      collateralUsd: Math.max(0, Math.round(collateralAmount * assetPrice * 100) / 100),
      borrowUsd: Math.max(0, Math.round(borrowUsd * 100) / 100),
    }),
    [activeMarket.engineProtocol, activeMarket.collateralSymbol, collateralAmount, assetPrice, borrowUsd],
  );
  const liveWatch = useProspective(prospectiveArgs);

  const recommendationFor = (status: PositionState["status"]): string => {
    if (status === "CRITICAL")
      return `CRITICAL ALERT: Repay ${activeMarket.debtAsset} debt immediately to prevent liquidator bids!`;
    if (status === "HIGH")
      return `ACTION REQUIRED: Repay part of the ${activeMarket.debtAsset} debt to restore a secure buffer.`;
    if (status === "ELEVATED")
      return `RECOMMENDED: Supply more ${activeMarket.collateralAsset} to suppress minor market swings.`;
    return "Position optimal. Collateral buffer protects against severe asset volatility.";
  };

  const positionState: PositionState = liveWatch
    ? {
        protocol: activeMarket.protocol,
        assetPair: activeMarket.assetPair,
        riskScore: liveWatch.total,
        status: liveWatch.band,
        collateralValue: collateralAmount * assetPrice,
        borrowValue: borrowUsd,
        healthFactor: liveWatch.healthFactor ?? 9.99,
        liquidationPrice:
          liveWatch.liquidationDrawdown !== null
            ? Math.round(assetPrice * (1 - liveWatch.liquidationDrawdown))
            : 0,
        currentPrice: assetPrice,
        recommendation: recommendationFor(liveWatch.band),
        breakdown: {
          positionHealth: Math.round(liveWatch.subScores.positionHealth),
          assetVolatility: Math.round(liveWatch.subScores.assetRisk),
          protocolSafety: Math.round(liveWatch.subScores.protocolSafety),
          systemicMarketStress: Math.round(liveWatch.subScores.systemicRisk),
        },
      }
    : calculateResult();

  // Dynamic parameters for redesigned Panik Risk Index
  const diff = positionState.riskScore - activeMarket.baseRisk;
  const trendNum = diff !== 0 ? diff : (positionState.riskScore >= 75 ? 14 : positionState.riskScore >= 50 ? 9 : positionState.riskScore >= 25 ? 6 : -2);
  const healthFactorScore = Math.max(5, Math.min(98, Math.round(100 - (positionState.healthFactor / 2.5) * 80)));

  const addLog = (message: string) => {
    const timestamp = new Date().toUTCString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, "$1");
    setLogs(prev => [...prev.slice(-30), `${timestamp} UTC - ${message}`]);
  };

  // LIVE chain telemetry: real Base block number + gas price via the API
  // (the previous random-walk simulation is gone).
  useEffect(() => {
    if (chainTel.blockNumber) {
      setBlockNumber(chainTel.blockNumber);
      addLog(`Block ${chainTel.blockNumber.toLocaleString()} confirmed on Base. Oracle parameters refreshed.`);
    }
    if (chainTel.gasGwei !== null) {
      setGasPrice(+chainTel.gasGwei.toFixed(4));
    }
  }, [chainTel.blockNumber, chainTel.gasGwei]);

  // Refresh countdown (display only — the live feeds poll on their own cadence)
  useEffect(() => {
    const interval = setInterval(() => {
      setSecTillUpdate(prev => (prev <= 1 ? 60 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab === "watch") {
      addLog(`Parameter simulated delta: Volatility Price $${assetPrice} USD | Borrows Debt ${borrowAmount}`);
    }
  }, [assetPrice, borrowAmount]);

  // Custom simulation handlers for Watch Cockpit
  const handleSimulateCollateralInflow = () => {
    const boost = +(collateralAmount * 1.5).toFixed(2);
    setCollateralAmount(boost);
    addLog(`Automation Trigger: Deposited emergency defensive buffer of +${(boost - collateralAmount).toFixed(2)} ${activeMarket.collateralAsset}`);
  };

  const handleSimulateFlashRepay = () => {
    const currentDebt = borrowAmount;
    const reducedDebt = +(borrowAmount * 0.5).toFixed(2);
    setBorrowAmount(reducedDebt);
    addLog(`Automation Trigger: Executed flash loan repayment of -${(currentDebt - reducedDebt).toFixed(2)} ${activeMarket.debtAsset} to lower systemic margins.`);
  };

  // Profile-based filtering for Compass — runs on LIVE engine scores when
  // the API is up (presetsWithLive), static fallbacks otherwise.
  const getProfileThresholds = () => {
    switch (selectedRiskProfile) {
      case "conservative":
        return {
          recommended: presetsWithLive.filter(p => p.baseRisk < 20),
          outside: presetsWithLive.filter(p => p.baseRisk >= 20)
        };
      case "aggressive":
        return {
          recommended: presetsWithLive.filter(p => p.baseRisk >= 50),
          outside: presetsWithLive.filter(p => p.baseRisk < 50)
        };
      case "moderate":
      default:
        return {
          recommended: presetsWithLive.filter(p => p.baseRisk >= 20 && p.baseRisk < 50),
          outside: presetsWithLive.filter(p => p.baseRisk < 20 || p.baseRisk >= 50)
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

  const TOUR_STEPS = [
    { step: 1, label: "Start here", body: "This is your Panik dashboard. Use the sidebar to navigate between tools." },
    { step: 2, label: "Connect your wallet", body: "Link your wallet so Panik can read your live on-chain positions." },
    { step: 3, label: "Open your first position in Compass", body: "Go to Compass to browse risk-scored positions matched to your profile." },
  ];
  const currentTourStep = TOUR_STEPS.find((s) => s.step === tooltipStep) ?? null;
  const dismissTour = () => {
    setTooltipStep(null);
    localStorage.setItem("panik_tour_seen", "true");
  };

  return (
    <>
    {/* Onboarding overlay. First run: mandatory (no cancel). Wallet-switch
        (header chip): cancellable, and a previously onboarded wallet restores
        its saved profile without re-asking the quiz. */}
    {showOnboarding && (
      <Onboarding
        onComplete={handleOnboardingComplete}
        savedProfiles={savedProfiles}
        onCancel={onboardedWallet ? () => setShowOnboarding(false) : undefined}
      />
    )}

    <div className="flex h-screen w-screen overflow-hidden bg-surface-base text-text-primary font-sans antialiased text-sm">

      {/* 1. LEFT SIDEBAR PANEL (exactly modeled after the Figma UI) */}
      <aside className="w-64 h-full shrink-0 flex flex-col justify-between border-r border-border-subtle bg-surface-base p-6 z-30">
        
        {/* Sidebar Header Brand block */}
        <div className="space-y-8">
          <div className="flex items-center gap-2.5">
            <img src="/panik-logo.png" alt="PANIK" width={32} height={32} style={{ objectFit: "contain" }} />
            <div className="flex flex-col">
              <span className="font-display font-extrabold text-lg tracking-widest text-text-primary leading-none">PANIK</span>
              <span className="text-2xs font-mono tracking-widest text-text-muted uppercase mt-0.5">RISK INTELLIGENCE</span>
            </div>
          </div>

          {/* Nav List Link Items — ARIA APG tabs, vertical orientation.
              Roving tabindex: only the selected tab is in the page tab order,
              so Tab reaches the sidebar once and the arrows move within it
              instead of forcing five stops past it. Activation follows focus
              because each panel is already mounted on demand and switching is
              free. */}
          <nav
            role="tablist"
            aria-orientation="vertical"
            aria-label="Application sections"
            className="space-y-1"
            onKeyDown={onTabKeyDown}
          >
            {TABS.map(({ id, label, icon: Icon }) => {
              const selected = activeTab === id;
              return (
                <button
                  key={id}
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={selected}
                  aria-controls={`panel-${id}`}
                  tabIndex={selected ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  onClick={() => setActiveTab(id)}
                  className={`w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-xs font-mono uppercase tracking-wider text-left transition-all cursor-pointer ${
                    selected
                      ? "bg-white/[0.06] border border-border-subtle text-text-primary font-bold"
                      : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
                  }`}
                >
                  <Icon className={`w-4 h-4 ${selected ? "text-text-primary" : "text-text-secondary"}`} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer Bottom exit button */}
        <div className="space-y-4">
          <a
            href="/"
            className="flex items-center gap-2 text-xs font-mono text-text-secondary hover:text-text-primary transition-colors cursor-pointer pt-2 group"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-text-muted group-hover:-translate-x-0.5 transition-transform" />
            <span>Back to Landing</span>
          </a>
        </div>
      </aside>

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 h-full flex flex-col overflow-hidden bg-surface-base relative">
        
        {/* TOP STATUS BAR (Gas feeds, Block Number precisely simulating real active smart contracts) */}
        <header className="h-16 shrink-0 border-b border-border-subtle px-8 flex items-center justify-between bg-surface-raised/40 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            {/* User segment badge (from onboarding profiling) */}
            {userSegment && (
              <span
                title={`Your DeFi profile: ${SEGMENT_LABELS[userSegment]}`}
                className={`hidden md:flex items-center px-2.5 py-1 rounded-md border text-2xs font-mono font-bold ${SEGMENT_BADGE}`}
              >
                {SEGMENT_LABELS[userSegment]}
              </span>
            )}

            {/* Risk-appetite tier badge (5-level) */}
            {riskTier && (
              <span
                title={`Your risk appetite: ${RISK_TIER_LABELS[riskTier]}`}
                className={`flex items-center px-2.5 py-1 rounded-md border text-2xs font-mono font-bold ${TIER_BADGE}`}
              >
                {RISK_TIER_LABELS[riskTier]}
              </span>
            )}
          </div>

          <div className="flex items-center gap-6 text-2xs font-mono text-text-muted">
            <div className="hidden md:flex items-center gap-1.5">
              <span>EST GAS:</span>
              {/* Gas is a market reading, not a verdict on this wallet. It was
                  painted with the safe-risk green, which put a risk colour on a
                  number that carries no risk statement at all. */}
              <strong className="text-text-secondary bg-white/[0.03] px-2 py-0.5 rounded-sm border border-border-subtle tabular-nums">{gasPrice} GWEI</strong>
            </div>
            <div className="h-4 w-px bg-white/10 hidden md:block"></div>
            <button
              type="button"
              onClick={() => setShowOnboarding(true)}
              title="Change wallet - a previously onboarded address restores its saved profile instantly"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/[0.02] hover:bg-white/[0.06] border border-border-subtle text-2xs font-semibold text-text-secondary transition-colors cursor-pointer group"
            >
              {/* Identifier, not an action and not a status: the whole chip
                  stays neutral so the eye skips it on the way to the data. */}
              <Wallet className="w-3.5 h-3.5 text-text-muted" />
              <span>
                {selectedWallet && selectedWallet !== "all"
                  ? truncateAddress(selectedWallet)
                  : selectedWallet === "all"
                    ? `Registry (${wallets.length} wallets)`
                    : "Connect wallet"}
              </span>
              <RefreshCw className="w-3 h-3 text-text-muted group-hover:text-text-primary transition-colors" />
            </button>
          </div>
        </header>

        {/* PAGE VIEWS SWITCH */}
        <div className="flex-1 overflow-y-auto p-8">
          <AnimatePresence mode="wait">
            
            {/* VIEW A: COMPASS TAB (Fully interactive and identical to the requested design layout!) */}
            {activeTab === "compass" && (
              <motion.div
                key="compass"
                role="tabpanel"
                id="panel-compass"
                aria-labelledby="tab-compass"
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
                    <p className="text-text-secondary font-mono text-xs">
                      Find and open positions matched to your risk profile
                    </p>
                  </div>

                  {/* High Fidelity Risk Profile Toggle matching Figma */}
                  <div className="bg-white/[0.02] border border-border-subtle p-1 rounded-md flex items-center max-w-sm">
                    <button
                      onClick={() => setSelectedRiskProfile("conservative")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "conservative"
                          ? "bg-white/10 text-text-primary font-bold border border-border-subtle"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Conservative
                    </button>
                    <button
                      onClick={() => setSelectedRiskProfile("moderate")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "moderate"
                          ? "bg-white/10 text-text-primary font-bold border border-border-subtle"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Moderate
                    </button>
                    <button
                      onClick={() => setSelectedRiskProfile("aggressive")}
                      className={`px-3 py-1.5 text-2xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                        selectedRiskProfile === "aggressive"
                          ? "bg-white/10 text-text-primary font-bold border border-border-subtle"
                          : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      Aggressive
                    </button>
                  </div>
                </div>

                {/* Section 1: Recommended for your chosen Profile */}
                <div className="space-y-4">
                  <h2 className="text-base font-mono font-bold text-text-primary tracking-wide uppercase">
                    Recommended for your {selectedRiskProfile.toUpperCase()} Profile
                  </h2>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {recommended.map((preset) => (
                      <div
                        key={preset.id}
                        onClick={() => setSelectedRiskBreakdownPreset(preset)}
                        className="bg-surface-raised/60 hover:bg-surface-overlay/70 border border-border-subtle rounded-lg p-5 relative overflow-hidden transition-all hover:border-border-strong shadow-xl group cursor-pointer"
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <ProtocolLogo protocol={preset.protocol} size="w-8 h-8" />
                            <div>
                              <h3 className="text-sm font-mono font-bold text-text-primary tracking-wide group-hover:text-text-primary transition-colors">
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

                        {/* Yield reality: live APY + TVL + 30d trend (DefiLlama via /api/poolhistory) */}
                        {(() => {
                          const py = poolYields?.[preset.id];
                          return (
                            <>
                              <div className="mb-2 flex items-baseline justify-between">
                                <span className="text-xs text-risk-low font-mono font-bold tabular-nums">
                                  APY Rate: {(py?.apy ?? preset.apy).toFixed(1)}%
                                </span>
                                {py && (
                                  <span className="text-2xs font-mono text-text-secondary uppercase tabular-nums">
                                    TVL {formatCompactUsd(py.tvlUsd)}
                                  </span>
                                )}
                              </div>
                              <div className="border-t border-border-subtle pt-3 mt-2">
                                {py ? (
                                  <>
                                    <Sparkline
                                      data={py.apySeries}
                                      stroke="var(--color-sky-400)"
                                      height={36}
                                      axes={{ yFormat: (v) => `${v < 0.1 && v > 0 ? v.toFixed(2) : v.toFixed(1)}%`, xStart: "30d ago", xEnd: "today" }}
                                    />
                                    <span className="block text-2xs font-mono uppercase text-text-secondary mt-1">
                                      Supply APY, last 30 days
                                    </span>
                                  </>
                                ) : (
                                  <span className="block text-2xs font-mono text-text-muted py-3">
                                    30d yield history unavailable
                                  </span>
                                )}
                              </div>
                            </>
                          );
                        })()}

                        {/* One primary per card. Five cards used to put five solid
                            and five outlined buttons on one screen, which is ten
                            things competing to be the next step. Simulating is the
                            secondary path, so it reads as a link. */}
                        <div className="mt-5 pt-3 border-t border-border-subtle flex justify-between items-center" onClick={(e) => e.stopPropagation()}>
                          <Button onClick={() => setOpenPositionPreset(preset)}>
                            Open Position
                          </Button>
                          <Button
                            variant="quiet"
                            onClick={() => {
                              setSelectedPresetId(preset.id);
                              setWatchSource("recommendations");
                              setActiveTab("watch");
                            }}
                          >
                            Audit &amp; Simulate →
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Section 2: Vaults outside the core profile limits */}
                <div className="space-y-4 pt-4">
                  <h2 className="text-base font-mono font-bold text-text-secondary tracking-wide uppercase">
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

                        {/* Yield reality (muted): live APY + TVL + 30d trend */}
                        {(() => {
                          const py = poolYields?.[preset.id];
                          return (
                            <>
                              <div className="mb-2 flex items-baseline justify-between">
                                <span className="text-xs text-text-muted font-mono tabular-nums">
                                  APY Rate: {(py?.apy ?? preset.apy).toFixed(1)}%
                                </span>
                                {py && (
                                  <span className="text-2xs font-mono text-text-muted uppercase tabular-nums">
                                    TVL {formatCompactUsd(py.tvlUsd)}
                                  </span>
                                )}
                              </div>
                              <div className="border-t border-border-subtle pt-3 mt-2">
                                {py ? (
                                  <>
                                    <Sparkline
                                      data={py.apySeries}
                                      stroke="var(--color-text-muted)"
                                      height={36}
                                      className="opacity-70"
                                      axes={{ yFormat: (v) => `${v < 0.1 && v > 0 ? v.toFixed(2) : v.toFixed(1)}%`, xStart: "30d ago", xEnd: "today" }}
                                    />
                                    <span className="block text-2xs font-mono uppercase text-text-muted font-bold mt-1">
                                      Supply APY, last 30 days
                                    </span>
                                  </>
                                ) : (
                                  <span className="block text-2xs font-mono text-white/20 py-3">
                                    30d yield history unavailable
                                  </span>
                                )}
                              </div>
                            </>
                          );
                        })()}

                        <div className="mt-5 pt-3 border-t border-border-subtle flex justify-between items-center" onClick={(e) => e.stopPropagation()}>
                          <span className="text-2xs font-mono text-text-muted">Outside safety triggers</span>
                          {/* No primary here on purpose: nothing on this card is a
                              recommended next step. */}
                          <Button
                            variant="quiet"
                            onClick={() => {
                              setSelectedPresetId(preset.id);
                              setWatchSource("recommendations");
                              setActiveTab("watch");
                            }}
                          >
                            Force Audit →
                          </Button>
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
                role="tabpanel"
                id="panel-watch"
                aria-labelledby="tab-watch"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="max-w-6xl space-y-6"
              >
                {/* Source toggle. Business requirement: Watch mirrors the
                    positions this wallet actually holds on-chain (Current
                    Positions). Recommendations keeps the Compass-derived
                    what-if sandbox for markets you could open. */}
                <div className="flex items-center gap-1 p-1 bg-black/30 border border-border-subtle rounded-md w-max">
                  {([
                    { key: "positions", label: "Current Positions", count: watchPositionMarkets.length as number | null },
                    { key: "recommendations", label: "Recommendations", count: null as number | null },
                  ] as const).map((opt) => {
                    const active = watchSource === opt.key;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => setWatchSource(opt.key)}
                        aria-pressed={active}
                        className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-2xs font-mono font-bold transition-all cursor-pointer ${
                          active ? "bg-white/10 text-text-primary" : "text-text-muted hover:text-text-secondary"
                        }`}
                      >
                        {opt.key === "positions" ? <Eye className="w-3.5 h-3.5" /> : <CompassIcon className="w-3.5 h-3.5" />}
                        <span>{opt.label}</span>
                        {opt.count !== null && opt.count > 0 && (
                          <span className={`text-2xs px-1.5 py-0.5 rounded-full tabular-nums ${active ? "bg-white/15" : "bg-white/10 text-text-muted"}`}>
                            {opt.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {watchSource === "positions" && watchPositionMarkets.length === 0 ? (
                  /* Positions mode with nothing on-chain: honest empty state */
                  <div className="bg-surface-raised/50 border border-border-subtle rounded-lg p-8 flex flex-col items-start gap-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-md bg-white/[0.06] border border-border-subtle flex items-center justify-center shrink-0">
                        <Eye className="w-4.5 h-4.5 text-text-primary" />
                      </div>
                      <div>
                        <h2 className="text-lg font-display font-extrabold text-text-primary">No open positions to watch yet</h2>
                        <p className="text-2xs font-mono text-text-secondary">Watch mirrors the positions this wallet holds on-chain.</p>
                      </div>
                    </div>
                    <p className="text-xs font-sans text-text-secondary max-w-lg leading-relaxed">
                      Once you open a position it appears here automatically - live-scored by the
                      PANIK engine, with the stress-test simulator preloaded to your real collateral
                      and debt. In the meantime, browse risk-scored markets under Recommendations.
                    </p>
                    <div className="flex flex-wrap gap-2.5">
                      <button
                        onClick={() => setWatchSource("recommendations")}
                        className="px-4 py-2 rounded-md font-mono text-xs font-bold text-text-primary bg-white/[0.06] border border-border-subtle hover:bg-white/10 cursor-pointer transition-all"
                      >
                        Browse Recommendations →
                      </button>
                      <button
                        onClick={() => setActiveTab("compass")}
                        className="px-4 py-2 rounded-md font-mono text-xs font-bold text-surface-base bg-text-primary hover:opacity-90 cursor-pointer transition-all"
                      >
                        Open a Position in Compass
                      </button>
                    </div>
                  </div>
                ) : (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Simulator Area (lg:col-span-8) */}
                <div className="col-span-1 lg:col-span-8 space-y-6">
                  
                  {/* Active Simulator Header widget */}
                  <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg relative overflow-hidden backdrop-blur-xl">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-white/[0.03] rounded-full blur-2xl pointer-events-none"></div>
                    <div className="flex justify-between items-center mb-4.5 border-b border-border-subtle pb-3">
                      {/* Market selector - mode-aware. Positions mode lists the
                          wallet's real on-chain positions; Recommendations lists
                          the Compass preset catalog. */}
                      <div className="relative" ref={watchDropRef}>
                        <span className="block text-2xs font-mono tracking-widest text-text-primary uppercase mb-1">
                          {watchingOwnPosition ? "YOUR POSITION · SCORED ON-CHAIN" : "POSITION SIMULATOR · MARKET"}
                        </span>
                        <button
                          id="watch-market-selector"
                          onClick={() => setWatchDropOpen(v => !v)}
                          className="group flex items-center gap-2 cursor-pointer"
                          aria-haspopup="listbox"
                          aria-expanded={watchDropOpen}
                        >
                          <h2 className="text-lg font-display font-extrabold text-text-primary tracking-wide group-hover:text-text-muted transition-colors">
                            {activeMarket.protocol} · {activeMarket.assetPair}
                          </h2>
                          <ChevronDown
                            className={`w-4 h-4 text-text-muted group-hover:text-text-muted transition-all duration-200 ${watchDropOpen ? "rotate-180" : ""}`}
                          />
                        </button>

                        {/* Dropdown panel */}
                        <AnimatePresence>
                          {watchDropOpen && (
                            <motion.ul
                              role="listbox"
                              aria-label="Select market"
                              initial={{ opacity: 0, y: -6, scale: 0.97 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -6, scale: 0.97 }}
                              transition={{ duration: 0.14 }}
                              className="absolute left-0 top-full mt-2 z-50 w-80 bg-surface-raised border border-border-subtle rounded-md shadow-2xl overflow-hidden"
                            >
                              {watchingOwnPosition
                                ? watchPositionMarkets.map(({ key, position, preset }) => {
                                    const isActive = key === selectedPositionMarket?.key;
                                    const riskCls = RISK_CHIP[preset.riskStatus];
                                    return (
                                      <li
                                        key={key}
                                        role="option"
                                        aria-selected={isActive}
                                        onClick={() => {
                                          setSelectedLivePositionKey(key);
                                          setWatchDropOpen(false);
                                        }}
                                        className={`flex items-center justify-between gap-3 px-4 py-3 cursor-pointer transition-colors ${
                                          isActive
                                            ? "bg-white/[0.06] border-l-2 border-l-border-strong"
                                            : "hover:bg-white/[0.04] border-l-2 border-l-transparent"
                                        }`}
                                      >
                                        <div className="min-w-0">
                                          <span className="block text-2xs font-mono text-text-muted uppercase tracking-wider">{preset.protocol}</span>
                                          <span className={`block text-sm font-mono font-semibold truncate tabular-nums ${
                                            isActive ? "text-text-primary" : "text-text-secondary"
                                          }`}>{preset.collateralSymbol} · {position.collateralValueUsd === null ? "size unavailable (prices degraded)" : `${formatCurrency(position.collateralValueUsd)} supplied`}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded-sm border ${riskCls}`}>
                                            {preset.riskStatus}
                                          </span>
                                          <span className="text-2xs font-mono text-text-muted tabular-nums">{preset.baseRisk}</span>
                                        </div>
                                      </li>
                                    );
                                  })
                                : presetsWithLive.map((p) => {
                                    const isActive = p.id === selectedPresetId;
                                    const riskCls = RISK_CHIP[p.riskStatus];
                                    return (
                                      <li
                                        key={p.id}
                                        role="option"
                                        aria-selected={isActive}
                                        onClick={() => {
                                          setSelectedPresetId(p.id);
                                          setWatchDropOpen(false);
                                        }}
                                        className={`flex items-center justify-between gap-3 px-4 py-3 cursor-pointer transition-colors ${
                                          isActive
                                            ? "bg-white/[0.06] border-l-2 border-l-border-strong"
                                            : "hover:bg-white/[0.04] border-l-2 border-l-transparent"
                                        }`}
                                      >
                                        <div className="min-w-0">
                                          <span className="block text-2xs font-mono text-text-muted uppercase tracking-wider">{p.protocol}</span>
                                          <span className={`block text-sm font-mono font-semibold truncate ${
                                            isActive ? "text-text-primary" : "text-text-secondary"
                                          }`}>{p.assetPair}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded-sm border ${riskCls}`}>
                                            {p.riskStatus}
                                          </span>
                                          <span className="text-2xs font-mono text-text-muted tabular-nums">{p.baseRisk}</span>
                                        </div>
                                      </li>
                                    );
                                  })}
                            </motion.ul>
                          )}
                        </AnimatePresence>
                      </div>
                      <div className="flex items-center gap-2.5">
                        {/* Simulate-to-open path: the simulator is where conviction
                            forms, so the open action must be one click away here. */}
                        <button
                          onClick={() => setOpenPositionPreset(activeMarket)}
                          className="px-3 py-1.5 rounded-md font-mono text-2xs font-bold text-surface-base bg-text-primary hover:opacity-90 cursor-pointer transition-all"
                        >
                          Open This Position
                        </button>
                        {!liveWatch && (
                          <span className="text-2xs font-mono text-text-muted bg-white/[0.04] px-2.5 py-0.5 rounded-sm border border-border-subtle flex items-center font-bold">
                            Demo
                          </span>
                        )}
                      </div>
                    </div>

                    {/* REDESIGNED PANIK RISK INDEX CARD (Primary intelligence focal point) */}
                    <div className="mb-6 p-5 bg-surface-sunken border border-border-subtle rounded-md flex flex-col md:flex-row gap-6 relative overflow-hidden text-left">
                      <div className="absolute top-0 left-0 w-24 h-24 bg-white/[0.01] rounded-full blur-xl pointer-events-none"></div>
                      
                      {/* Left: Score display & interpretation */}
                      <div className="flex-1 md:max-w-[280px] flex flex-col justify-between">
                        <div>
                          <div className="flex items-center gap-1.5 text-text-muted font-mono text-2xs uppercase tracking-wider mb-2">
                            <Activity className="w-3.5 h-3.5 text-text-primary shrink-0" />
                            <span>Panik Risk Index</span>
                            <InfoTip text="0-100 composite of position health, asset risk, protocol safety, and market stress. Higher means closer to liquidation; your risk profile sets where alerts fire." />
                          </div>

                          <div className="flex items-baseline gap-2 mb-2">
                            <span className={`text-4xl font-mono font-black tracking-tight tabular-nums ${
                              positionState.riskScore < 25 ? "text-risk-low" :
                              positionState.riskScore < 50 ? "text-risk-elevated" :
                              "text-risk-critical"
                            }`}>
                              {positionState.riskScore}
                            </span>
                            <span className="text-xs font-mono text-text-muted tabular-nums">/ 100</span>

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

                          {/* Dollar-framed verdict: what this scenario means in money, not percentages */}
                          {(() => {
                            const cv = positionState.collateralValue;
                            const lp = positionState.liquidationPrice;
                            if (borrowUsd <= 0 || cv <= 0) return null;
                            if (positionState.healthFactor <= 1.0) {
                              return (
                                <p className="text-2xs font-sans leading-relaxed text-risk-critical font-semibold">
                                  At this simulated price your {formatCurrency(cv)} collateral is past the
                                  liquidation threshold - liquidators could seize it.
                                </p>
                              );
                            }
                            if (lp > 0 && lp < positionState.currentPrice) {
                              const dropPct = Math.round((1 - lp / positionState.currentPrice) * 100);
                              return (
                                <p className="text-2xs font-sans leading-relaxed text-text-secondary">
                                  A further <span className="text-text-primary font-semibold tabular-nums">-{dropPct}%</span>{" "}
                                  {activeMarket.collateralAsset} move (to{" "}
                                  <span className="text-text-primary font-semibold tabular-nums">{formatCurrency(lp)}</span>) puts
                                  your <span className="text-text-primary font-semibold tabular-nums">{formatCurrency(cv)}</span> collateral
                                  up for liquidation.
                                </p>
                              );
                            }
                            return null;
                          })()}
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
                              <span className="text-text-secondary flex items-center gap-1">
                                Health Factor
                                <InfoTip text="Your distance to liquidation, scaled 0-100. The heaviest input to the composite score (40% weight)." />
                              </span>
                              <span className={`font-bold tabular-nums ${
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
                              <span className="text-text-secondary flex items-center gap-1">
                                Asset Volatility
                                <InfoTip text="How sharply your collateral's price has moved recently (30d vol, drawdown, correlation). Volatile collateral erodes your buffer faster. 25% weight." />
                              </span>
                              <span className="text-blue-400 font-bold tabular-nums">{positionState.breakdown.assetVolatility}%</span>
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
                              <span className="text-text-secondary flex items-center gap-1">
                                Protocol Risk
                                <InfoTip text="Audit posture, governance timelock, and market controls of the protocol holding this position. 20% weight." />
                              </span>
                              <span className="text-risk-low font-bold tabular-nums">{positionState.breakdown.protocolSafety}%</span>
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
                              <span className="text-text-secondary flex items-center gap-1">
                                Pool Conditions
                                <InfoTip text="Market-wide stress: sector TVL flows and broad drawdowns that hit every position at once. 15% weight." />
                              </span>
                              <span className={`font-bold tabular-nums ${
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
                        <span className="flex items-center gap-1.5 text-2xs font-mono text-text-secondary uppercase tracking-wider mb-1">
                          HEALTH FACTOR
                          <InfoTip text="Collateral value times the protocol's liquidation threshold, divided by your debt. Below 1.00 the protocol can liquidate you. The buffer matters more than the raw number." />
                        </span>
                        <div className="flex items-baseline gap-1">
                          <span className={`text-4xl font-mono font-bold tracking-tight tabular-nums ${
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
                        <span className="flex items-center gap-1.5 text-2xs font-mono text-text-secondary uppercase tracking-wider mb-1">
                          POSITION LTV
                          <InfoTip text="Debt as a share of your collateral's value. The closer this gets to the protocol's maximum, the smaller your cushion before liquidation." />
                        </span>
                        <div className="flex items-baseline gap-1">
                          <span className="text-4xl font-mono font-bold tracking-tight text-text-primary tabular-nums">
                            {Math.round((borrowUsd / (collateralAmount * assetPrice)) * 100)}%
                          </span>
                        </div>
                        <span className="text-2xs font-mono text-text-muted block mt-2">Maximum risk cap parameter: {activeMarket.protocol === "Aave V3" ? "82%" : "78%"}</span>
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
                            <span className="text-text-primary font-bold tabular-nums">{positionState.breakdown.positionHealth}%</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-text-primary" style={{ width: `${positionState.breakdown.positionHealth}%` }}></div>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-2xs font-mono mb-1">
                            <span className="text-text-secondary">Asset Volatility</span>
                            <span className="text-text-primary font-bold tabular-nums">{positionState.breakdown.assetVolatility}%</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-white/40" style={{ width: `${positionState.breakdown.assetVolatility}%` }}></div>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-2xs font-mono mb-1">
                            <span className="text-text-secondary">Protocol Risk</span>
                            <span className="text-text-primary font-bold tabular-nums">{positionState.breakdown.protocolSafety}%</span>
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
                  
                  {/* Scenario presets (#3): the answer first, sliders second */}
                  <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
                    <span className="text-2xs font-mono text-text-primary tracking-widest uppercase block border-b border-border-subtle pb-2">
                      Price Scenarios
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {PRICE_SCENARIOS.map((s) => {
                        const price = scenarioPrice(s.pct);
                        const maxLTV = activeMarket.protocol === "Aave V3" ? 0.82 : 0.78;
                        const estHf = borrowUsd > 0 ? (collateralAmount * price * maxLTV) / borrowUsd : Infinity;
                        const active = activeScenario === s.key;
                        const liquidated = Number.isFinite(estHf) && estHf < 1;
                        return (
                          <button
                            key={s.key}
                            onClick={() => applyScenario(s.key, s.pct)}
                            className={`text-left p-2.5 rounded-md border transition-all cursor-pointer ${
                              active
                                ? "bg-white/[0.06] border-border-strong"
                                : "bg-white/[0.01] border-border-subtle hover:bg-white/[0.04]"
                            }`}
                          >
                            <div className="flex items-baseline justify-between">
                              <span className={`text-2xs font-mono font-bold uppercase tracking-wider ${active ? "text-text-primary" : "text-text-secondary"}`}>
                                {s.label}
                              </span>
                              {s.pct !== 0 && (
                                <span className="text-2xs font-mono text-risk-critical/80 tabular-nums">{Math.round(s.pct * 100)}%</span>
                              )}
                            </div>
                            <span className="block text-2xs font-mono text-text-secondary mt-1 tabular-nums">
                              {formatCurrency(price)}
                              {borrowUsd > 0 && (
                                <span className={`ml-1.5 font-bold tabular-nums ${liquidated ? "text-risk-critical" : estHf < 1.3 ? "text-risk-elevated" : "text-risk-low"}`}>
                                  {liquidated ? "LIQUIDATED" : `HF ~${estHf.toFixed(2)}`}
                                </span>
                              )}
                            </span>
                            <span className="block text-2xs font-mono text-text-muted mt-0.5">{s.note}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-2xs font-mono text-text-muted leading-relaxed">
                      Crash and black-swan magnitudes mirror the backtest event set. HF preview is an
                      estimate; the headline score uses the live engine.
                    </p>
                  </div>

                  {/* Advanced parameters (#4): direct inputs for amounts + prices */}
                  <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-4">
                    <span className="text-2xs font-mono text-text-primary tracking-widest uppercase block border-b border-border-subtle pb-2">
                       Simulate Fluctuation Parameters
                    </span>

                    {/* Collateral amount */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between items-center text-xs font-mono text-text-secondary">
                        <span>Collateral Deposited ({activeMarket.collateralAsset}):</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultCollateral < 10 ? 0.1 : 100}
                          value={collateralAmount}
                          onChange={(e) => setCollateralAmount(Math.max(0, Number(e.target.value)))}
                          className="w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-text-primary text-xs font-mono focus:border-border-strong tabular-nums"
                          aria-label="Collateral amount"
                        />
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={activeMarket.defaultCollateral * 2.5}
                        step={activeMarket.defaultCollateral < 10 ? 0.05 : 50}
                        value={Math.min(collateralAmount, activeMarket.defaultCollateral * 2.5)}
                        onChange={(e) => setCollateralAmount(Number(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                        id="watch-collateral-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Withdrawn (0)</span>
                        <span>Topped up (2.5x) - worth {formatCurrency(collateralAmount * assetPrice)}</span>
                      </div>
                    </div>

                    {/* Collateral price */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between items-center text-xs font-mono text-text-secondary">
                        <span>Collateral Asset Price ({activeMarket.collateralAsset}):</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultPrice < 10 ? 0.01 : 10}
                          value={assetPrice}
                          onChange={(e) => {
                            setAssetPrice(Math.max(0, Number(e.target.value)));
                            setActiveScenario("custom");
                          }}
                          className={`w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-mono focus:border-border-strong tabular-nums ${
                            assetPrice < activeMarket.defaultPrice * 0.8 ? "text-risk-critical font-bold" : "text-text-primary"
                          }`}
                          aria-label="Collateral asset price in USD"
                        />
                      </div>
                      <input
                        type="range"
                        min={Math.round(activeMarket.defaultPrice * 0.4)}
                        max={Math.round(activeMarket.defaultPrice * 1.3)}
                        step={activeMarket.defaultPrice < 10 ? "0.05" : "20"}
                        value={assetPrice}
                        onChange={(e) => {
                          setAssetPrice(Number(e.target.value));
                          setActiveScenario("custom");
                        }}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                        id="watch-price-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Minus -60% Downside ({formatCurrency(activeMarket.defaultPrice * 0.4)})</span>
                        <span>Plus +30% Upside ({formatCurrency(activeMarket.defaultPrice * 1.3)})</span>
                      </div>
                    </div>

                    {/* Borrowed amount */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between items-center text-xs font-mono text-text-secondary">
                        <span>Borrowed Amount ({activeMarket.debtAsset}):</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultBorrow < 10 ? 0.1 : 50}
                          value={borrowAmount}
                          onChange={(e) => setBorrowAmount(Math.max(0, Number(e.target.value)))}
                          className={`w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-mono focus:border-border-strong tabular-nums ${
                            borrowAmount > activeMarket.defaultBorrow * 1.2 ? "text-risk-critical font-bold" : "text-text-primary"
                          }`}
                          aria-label="Borrowed amount"
                        />
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.round(activeMarket.defaultBorrow * 1.6)}
                        step={activeMarket.defaultBorrow < 10 ? "0.1" : "50"}
                        value={Math.min(borrowAmount, activeMarket.defaultBorrow * 1.6)}
                        onChange={(e) => setBorrowAmount(Number(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                        id="watch-borrow-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Fully repaid (0)</span>
                        <span>Leveraged (+60% Debt)</span>
                      </div>
                    </div>

                    {/* Borrowed asset price (depeg scenarios) */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex justify-between items-center text-xs font-mono text-text-secondary">
                        <span>Borrowed Asset Price ({activeMarket.debtAsset}):</span>
                        <input
                          type="number"
                          min={0}
                          step={0.005}
                          value={debtPrice}
                          onChange={(e) => setDebtPrice(Math.max(0, Number(e.target.value)))}
                          className={`w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-mono focus:border-border-strong tabular-nums ${
                            Math.abs(debtPrice - 1) > 0.02 ? "text-risk-elevated font-bold" : "text-text-primary"
                          }`}
                          aria-label="Borrowed asset price in USD"
                        />
                      </div>
                      <input
                        type="range"
                        min={0.85}
                        max={1.05}
                        step={0.005}
                        value={Math.min(Math.max(debtPrice, 0.85), 1.05)}
                        onChange={(e) => setDebtPrice(Number(e.target.value))}
                        className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                        id="watch-debt-price-slider"
                      />
                      <div className="flex justify-between text-2xs font-mono text-white/20">
                        <span>Depeg ($0.85 - USDC hit $0.87 in Mar 2023)</span>
                        <span>Premium ($1.05)</span>
                      </div>
                    </div>
                  </div>

                </div>

                </div>
                )}

              </motion.div>
            )}

            {/* VIEW C: ADVISOR TAB (Autonomous Alert Rules Configuration & Diagnosing Engine) */}
            {activeTab === "advisor" && (
              <motion.div
                key="advisor"
                role="tabpanel"
                id="panel-advisor"
                aria-labelledby="tab-advisor"
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

                {advisorLive.report ? (
                  <AdvisorPanel
                    report={advisorLive.report}
                    onExit={(prefill) => setExitPrefill(prefill)}
                    onOpen={(plan) => setOpenFlowPlan(plan)}
                  />
                ) : (
                <div className="bg-surface-raised/50 border border-border-subtle p-12 rounded-lg flex flex-col items-center text-center max-w-2xl mx-auto my-8">
                  <div className="w-12 h-12 rounded-full bg-white/[0.06] border border-border-subtle flex items-center justify-center mb-6">
                    <Sparkles className="w-5 h-5 text-text-primary" />
                  </div>
                  
                  <span className="text-2xs font-mono tracking-widest text-text-primary uppercase font-bold mb-2">
                    Coming Soon
                  </span>
                  
                  <h3 className="text-lg font-display font-bold text-text-primary tracking-tight mb-3">
                    Adaptive Intelligence at Your Service
                  </h3>
                  
                  <p className="text-sm text-text-secondary leading-relaxed font-sans max-w-md">
                    Our AI-powered guardrail recommendations, automated health rating models, and simulated action guides are currently undergoing extensive parameter audits on Base. Joining the waitlist guarantees early access to this feature upon release.
                  </p>

                  <label className="mt-6 flex items-center gap-3 cursor-pointer select-none group">
                    <input
                      type="checkbox"
                      checked={advisorNotifyChecked}
                      onChange={(e) => {
                        setAdvisorNotifyChecked(e.target.checked);
                        localStorage.setItem("panik_advisor_notify", String(e.target.checked));
                      }}
                      className="w-4 h-4 rounded-sm border border-border-subtle bg-surface-raised accent-text-primary cursor-pointer"
                    />
                    <span className="text-xs font-mono text-text-secondary group-hover:text-text-primary transition-colors">
                      Notify me when Advisor goes live
                    </span>
                  </label>
                </div>
                )}
              </motion.div>
            )}

            {/* VIEW D: PORTFOLIO TAB (Aggregate Vaults Portfolio Under Protective Firewall) */}
            {activeTab === "portfolio" && (
              <motion.div
                key="portfolio"
                role="tabpanel"
                id="panel-portfolio"
                aria-labelledby="tab-portfolio"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="space-y-6 max-w-5xl"
              >
                <div className="border-b border-border-subtle pb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-display font-extrabold tracking-tight text-text-primary mb-1">DeFi Portfolio</h1>
                    <p className="text-text-secondary font-mono text-xs">Real-time risk monitoring across your connected DeFi positions</p>
                  </div>
                  {/* Primary action: opening positions lives in Compass; this is
                      the pointer Portfolio was missing (UX journey fix). */}
                  <Button onClick={() => setActiveTab("compass")} className="shrink-0">
                    + Open Position
                  </Button>
                </div>

                {/* Empty-wallet path: don't leave a fresh wallet at a dead end.
                    "clear", not "problem" — we read the wallet successfully and
                    there is genuinely nothing at risk on it. */}
                {portfolioPositions !== null && portfolioPositions.length === 0 && (
                  <EmptyState
                    tone="clear"
                    title="No positions yet"
                    hint={`Browse risk-scored opportunities matched to your ${selectedRiskProfile} profile and open your first position.`}
                    action={
                      <Button variant="quiet" onClick={() => setActiveTab("compass")}>
                        Explore Compass →
                      </Button>
                    }
                  />
                )}

                {/* Wallet selector — a portfolio is ONE wallet; ALL = ops/registry view */}
                {wallets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-2xs font-mono uppercase tracking-widest text-text-secondary">Wallet:</span>
                    {wallets.map((w) => (
                      <button
                        key={w.wallet}
                        onClick={() => setSelectedWallet(w.wallet)}
                        title={w.label ?? w.wallet}
                        className={`px-3 py-1.5 rounded-md text-2xs font-mono border transition-all cursor-pointer ${
                          selectedWallet === w.wallet
                            ? "bg-white/10 text-text-primary border-border-strong font-bold"
                            : "bg-white/[0.02] text-text-secondary border-border-subtle hover:text-text-primary"
                        }`}
                      >
                        {w.wallet.slice(0, 6)}…{w.wallet.slice(-4)}
                      </button>
                    ))}
                    {/* Registry/ops view — hidden once the user is bound to their own wallet. */}
                    {!boundMode && (
                      <button
                        onClick={() => setSelectedWallet("all")}
                        className={`px-3 py-1.5 rounded-md text-2xs font-mono border transition-all cursor-pointer ${
                          selectedWallet === "all"
                            ? "bg-white/10 text-text-primary border-border-strong font-bold"
                            : "bg-white/[0.02] text-text-secondary border-border-subtle hover:text-text-primary"
                        }`}
                      >
                        ALL (registry)
                      </button>
                    )}
                  </div>
                )}

                {/* Macro metrics columns — computed from LIVE positions when available */}
                {(() => {
                  const aggregate = liveMacro?.aggregate ?? 22;
                  // The verdict is carried by the WORD, not by a hue. A 28px
                  // numeral repainted red is the single loudest thing a
                  // dashboard can emit, and it was firing on a summary figure
                  // while the four per-position bands — the numbers a user can
                  // actually act on — sat in 11px chips beside it.
                  const aggregateVerdict =
                    aggregate >= 50
                      ? "Elevated portfolio risk"
                      : aggregate >= 25
                        ? "Watch status"
                        : "Secure health status";
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-5">
                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Monitored Capital
                              <InfoTip text="Total collateral value PANIK is watching for this wallet across all protocols." />
                            </>
                          }
                          value={liveMacro ? `$${Math.round(liveMacro.capital).toLocaleString()}` : "$18,450"}
                          sub="Guard active"
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Monitored Liabilities
                              <InfoTip text="Total borrowed across your positions. Net LTV is liabilities divided by capital - lower means safer." />
                            </>
                          }
                          value={liveMacro ? `$${Math.round(liveMacro.debt).toLocaleString()}` : "$9,310"}
                          sub={`Net LTV ratio: ${liveMacro ? `${Math.round(liveMacro.ltv * 100)}%` : "50%"}`}
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label="Protocols Watched"
                          value={liveMacro ? `${liveMacro.positions} Positions` : "4 Pools"}
                          sub={liveMacro ? `Aave V3, Moonwell · ${liveMacro.protocols} protocols` : "Aave, Moonwell"}
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Aggregate Risk Index
                              <InfoTip text="Collateral-weighted average PANIK score across this wallet's positions. Bigger positions move it more." />
                            </>
                          }
                          value={`${aggregate} / 100`}
                          sub={aggregateVerdict}
                        />
                      </Card>
                    </div>
                  );
                })()}

                {/* Dual Column: LIVE positions (left) + live allocation (right).
                    Portfolio is 100% live — hypothetical scenarios live in
                    Compass (discovery) and Watch (sandbox), not here. */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-4">
                  {/* Left Column: the selected wallet's REAL positions */}
                  <div className="lg:col-span-7">
                    <LivePositions
                      positions={portfolioPositions}
                      updatedAt={boundMode ? ownLive.updatedAt : liveUpdatedAt}
                      offline={boundMode ? ownLive.offline : liveOffline}
                      onStressTest={(pos) => {
                        // Bridge: open THIS real position in the Watch simulator.
                        setSelectedLivePositionKey(`${pos.wallet}:${pos.protocol}:${pos.scoredCollateralSymbol}`);
                        setWatchSource("positions");
                        setActiveTab("watch");
                      }}
                    />
                  </div>

                  {/* Right Column: Asset Allocation visual breakdown (lg:col-span-5) */}
                  <Card className="lg:col-span-5 space-y-6">
                    <div>
                      <h3 className="text-sm font-mono tracking-widest text-text-muted font-bold uppercase mb-2">
                        Asset Allocation Weight
                      </h3>
                      <p className="text-xs text-text-secondary leading-relaxed font-sans">
                        Breakdown of collateral asset distributions backing the protected portfolio vault lines.
                      </p>
                    </div>

                    {/* Segmented bar; the swatch on each row below is its legend,
                        which is why those dots stay while decorative ones went. */}
                    <div className="h-4 w-full bg-white/[0.03] rounded-full overflow-hidden flex border border-border-subtle">
                      {allocation.map((a) => (
                        <div
                          key={a.symbol}
                          className={`h-full ${a.color}`}
                          style={{ width: `${a.pct.toFixed(1)}%` }}
                          title={`${a.symbol}: ${a.pct.toFixed(1)}%`}
                        ></div>
                      ))}
                    </div>

                    {/* Asset distribution — computed from LIVE positions (mock when offline) */}
                    <div className="space-y-3">
                      {allocation.map((a) => (
                        <div key={a.symbol} className="flex justify-between items-center gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${a.color}`}></span>
                            <span className="font-mono text-xs font-bold text-text-primary truncate">
                              {a.symbol}
                            </span>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-mono text-xs font-bold text-text-primary tabular-nums">${Math.round(a.usd).toLocaleString()}</span>
                            <span className="block text-2xs font-mono text-text-secondary tabular-nums">{a.pct.toFixed(1)}% weight</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    <p className="text-2xs font-mono text-text-muted leading-relaxed">
                      All positions undergo continuous drift analysis against current collateral price benchmarks.
                    </p>
                  </Card>
                </div>

                {/* History row: risk-index chart + alert feed (DeBank/Zerion-style
                    net-worth-chart + activity-feed layout, adapted to risk). */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Risk index over time (score_snapshots via /api/history) */}
                  <Card className="lg:col-span-7">
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="text-sm font-mono tracking-widest text-text-muted font-bold uppercase">
                        Risk Index History
                      </h3>
                      {riskHistory && (
                        <span className="text-lg font-mono font-bold tabular-nums text-text-primary">
                          {riskHistory.series[riskHistory.series.length - 1]} / 100
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-secondary leading-normal mb-4 font-sans">
                      Aggregate PANIK score of this wallet over time, protocols weighted by collateral.
                    </p>
                    {riskHistory ? (
                      // Series colour is cool and fixed: repainting 30 days of history in
                      // today's band colour claims the whole series was that band. The
                      // current band is already stated in the chip above.
                      <Sparkline
                        data={riskHistory.series}
                        height={110}
                        stroke="var(--color-sky-400)"
                        axes={{ yFormat: (v) => String(Math.round(v)), xStart: riskHistory.xStart, xEnd: "today" }}
                      />
                    ) : (
                      <div className="py-8 text-center text-2xs font-mono text-text-muted leading-relaxed">
                        Score history builds as the watch worker monitors this wallet (every 60s).
                        <br />Check back after a few scoring cycles.
                      </div>
                    )}
                  </Card>

                  {/* Alert history (watch_transitions IS the alert log) */}
                  <Card className="lg:col-span-5">
                    <h3 className="text-sm font-mono tracking-widest text-text-muted font-bold uppercase mb-1">
                      Alert History
                    </h3>
                    <p className="text-xs text-text-secondary leading-normal mb-4 font-sans">
                      Every risk-status change PANIK detected, and what was sent.
                    </p>
                    {walletHistory?.alerts?.length ? (
                      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                        {walletHistory.alerts.slice(0, 12).map((a, i) => {
                          const chip = a.notify_channel
                            ? NOTIFY_CHANNEL_CHIP[a.notify_channel] ?? { label: a.notify_channel.toUpperCase(), cls: "text-text-muted border-border-subtle bg-white/[0.03]" }
                            : { label: "QUEUED", cls: "text-text-muted border-border-subtle bg-white/[0.03]" };
                          return (
                            <div key={`${a.created_at}-${i}`} className="flex items-start gap-2.5 bg-white/[0.02] border border-border-subtle p-3 rounded-md">
                              {/* The glyph carries the transition; the words next
                                  to it name the band. Painting the icon too gave
                                  this log twelve coloured marks for a history the
                                  user is skimming, not acting on. */}
                              {a.to_status === "outside" ? (
                                <Flame className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />
                              ) : a.to_status === "approaching" ? (
                                <ShieldAlert className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="text-2xs font-mono font-bold text-text-primary truncate">
                                    {LIVE_PROTOCOL_LABEL[a.protocol] ?? a.protocol}
                                    <span className="text-text-muted font-normal"> · {a.from_status ?? "start"} → {a.to_status}</span>
                                  </span>
                                  <span className="text-2xs font-mono text-text-muted shrink-0 tabular-nums">{timeAgo(a.created_at)}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-2xs font-mono text-text-muted tabular-nums">score {a.score} ({a.band})</span>
                                  <span className={`text-2xs font-mono px-1.5 py-0.5 rounded-sm border ${chip.cls}`}>{chip.label}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-8 text-center text-2xs font-mono text-text-muted leading-relaxed">
                        No alerts yet - PANIK messages you the moment a position
                        <br />crosses your profile's risk limit.
                      </div>
                    )}
                  </Card>
                </div>

              </motion.div>
            )}

            {/* VIEW E: SETTINGS TAB (Sentry preferences + Telegram alert dispatcher) */}
            {activeTab === "settings" && (
              <motion.div
                key="settings"
                role="tabpanel"
                id="panel-settings"
                aria-labelledby="tab-settings"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="max-w-5xl space-y-6"
              >
                <div className="border-b border-border-subtle pb-3">
                  <span className="block text-2xs font-mono tracking-widest text-text-primary uppercase">Sentry System Preferences</span>
                  <h2 className="text-lg font-display font-extrabold text-text-primary tracking-wide">Settings &amp; Endpoints</h2>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Main settings column */}
                  <div className="lg:col-span-8 space-y-6">

                    {/* Telegram alerts dispatcher (the real Connect flow) */}
                    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
                      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
                        <Bell className="w-4 h-4 text-text-primary" />
                        <h3 className="text-2xs font-mono uppercase tracking-widest text-text-primary font-bold">
                          Web3 Telegram Alerts Dispatcher
                        </h3>
                      </div>
                      <p className="text-xs text-text-secondary leading-relaxed font-sans">
                        Get a Telegram message when this wallet nears your {selectedRiskProfile} risk limit. PANIK only
                        pings you on a real transition toward liquidation - debounced, deduped, and rate-limited, never on noise.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-3 pt-1">
                        <div className="flex-1 h-10 px-3 flex items-center bg-surface-base/80 border border-border-subtle rounded-md font-mono text-2xs truncate">
                          {telegramLink.status === "connected" ? (
                            <span className="text-risk-low flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              Connected
                            </span>
                          ) : (
                            <span className="text-text-muted">
                              {telegramEligible ? `Linking ${onboardedWallet?.slice(0, 6)}...${onboardedWallet?.slice(-4)}` : "No EVM wallet onboarded"}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={!telegramEligible || telegramLink.status === "requesting" || telegramLink.status === "signing"}
                          onClick={() => onboardedWallet && telegramLink.connect(onboardedWallet)}
                          className="h-10 px-4 rounded-md text-2xs font-mono font-extrabold uppercase tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-text-primary text-surface-base hover:opacity-90 cursor-pointer"
                        >
                          {telegramLink.status === "signing" ? "Sign in wallet..." :
                           telegramLink.status === "requesting" ? "Opening..." :
                           telegramLink.status === "connected" ? "Reconnect" :
                           telegramLink.status === "opened" ? "Waiting..." : "Connect Telegram"}
                        </button>
                      </div>
                      {telegramEligible && telegramLink.status !== "connected" && (
                        <p className="text-2xs font-mono text-text-muted">
                          Sign to prove wallet ownership - free, no transaction, no gas.
                        </p>
                      )}
                      {!telegramEligible && (
                        <p className="text-2xs font-mono text-text-muted">Onboard with an EVM wallet (0x...) to enable alerts.</p>
                      )}
                      {telegramLink.status === "connected" && (
                        <p className="text-2xs font-mono text-risk-low">
                          Alerts are on. Send /stop in the bot anytime to pause them.
                        </p>
                      )}
                      {telegramLink.status === "opened" && (
                        <div className="space-y-1.5 pt-1.5 border-t border-border-subtle">
                          <p className="text-2xs font-mono text-risk-low flex items-center">
                            Waiting for you to press Start in @{telegramBotUsername} - this confirms automatically.
                          </p>
                          <p className="text-2xs font-sans text-text-secondary leading-relaxed">
                            If the link didn't open automatically, copy this command, open <strong className="text-text-primary">@{telegramBotUsername}</strong> in Telegram, and send it:
                          </p>
                          <div className="flex items-center bg-surface-base/80 border border-border-subtle rounded-sm px-2.5 py-1.5 font-mono text-2xs text-risk-low select-all break-all">
                            /start {telegramLink.code}
                          </div>
                        </div>
                      )}
                      {telegramLink.status === "error" && telegramLink.error && (
                        <p className="text-2xs font-mono text-risk-critical">{telegramLink.error}</p>
                      )}
                    </div>

                    {/* Emergency auto repayment trigger (interactive preference).
                        Hidden per business-dev QA (2026-07-03) until the
                        Deleverager ships - flip SHOW_AUTO_REPAY_CARD to restore. */}
                    {SHOW_AUTO_REPAY_CARD && (
                    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
                      <div className="flex justify-between items-center border-b border-border-subtle pb-2.5">
                        <div className="flex items-center gap-2">
                          <Sliders className="w-4 h-4 text-text-primary" />
                          <h3 className="text-2xs font-mono uppercase tracking-widest text-text-primary font-bold">
                            Emergency Auto Repayment Trigger
                          </h3>
                        </div>
                        <button
                          type="button"
                          aria-pressed={isRepayActive}
                          onClick={() => setIsRepayActive((v) => !v)}
                          className={`w-9 h-5 rounded-full p-[2px] transition-colors cursor-pointer ${isRepayActive ? "bg-text-primary" : "bg-white/15"}`}
                        >
                          <div className={`bg-white w-4 h-4 rounded-full transition-transform ${isRepayActive ? "translate-x-4" : "translate-x-0"}`} />
                        </button>
                      </div>
                      <p className="text-xs text-text-secondary leading-relaxed font-sans">
                        Set the share of borrowed liability PANIK should target for emergency repayment when a position
                        enters extreme risk. Execution ships with the Deleverager; this stores your preference.
                      </p>
                      <div className={`bg-surface-base/60 p-3 rounded-md border border-border-subtle space-y-1.5 transition-opacity ${isRepayActive ? "" : "opacity-40 pointer-events-none"}`}>
                        <div className="flex justify-between text-2xs font-mono text-text-secondary">
                          <span>Auto target repayment chunk:</span>
                          <span className="text-text-primary font-bold tabular-nums">{automaticRepayTarget}% of liability</span>
                        </div>
                        <input
                          type="range"
                          min={10}
                          max={80}
                          step={5}
                          value={automaticRepayTarget}
                          onChange={(e) => setAutomaticRepayTarget(Number(e.target.value))}
                          className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                        />
                      </div>
                    </div>
                    )}
                  </div>

                  {/* Integration sidebar */}
                  <div className="lg:col-span-4 space-y-4">
                    <div className="bg-white/[0.01] border border-border-subtle p-5 rounded-lg space-y-2">
                      <h4 className="text-2xs font-mono font-bold text-text-primary uppercase tracking-widest">How to connect alerts</h4>
                      <ol className="text-2xs text-text-secondary space-y-1.5 list-decimal pl-4 font-sans leading-relaxed">
                        <li>Click <span className="text-text-primary font-semibold">Connect Telegram</span> - it opens <span className="text-text-primary font-semibold">@{telegramBotUsername}</span>.</li>
                        <li>Press <span className="text-text-primary">Start</span> in the chat to confirm.</li>
                        <li>Alerts fire when your wallet nears its risk limit.</li>
                        <li>Send <span className="text-text-primary">/stop</span> any time to mute them.</li>
                      </ol>
                    </div>
                    <div className="p-3 bg-white/[0.02] border border-border-subtle rounded-lg font-sans text-2xs text-text-secondary leading-relaxed">
                      We store only your Telegram chat id and wallet. No private keys, ever. Send /stop to disable instantly.
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
                      <span className="flex items-center gap-1.5 text-2xs font-mono text-text-muted uppercase tracking-widest">
                        Panik Risk Score
                        <InfoTip text="0-100 composite of the four weighted components below. LOW under 25, ELEVATED under 50, HIGH under 75, CRITICAL above." />
                      </span>
                      <div className="flex items-center gap-1.5">
                        {/* Live is the default and needs no badge. Only the
                            fixture case is worth calling out, because it is the
                            one the reader would otherwise get wrong. */}
                        {!breakdownData?.isLive && (
                          <span className="text-2xs font-mono px-2 py-0.5 rounded-sm border bg-white/[0.04] text-text-muted border-border-subtle">
                            DEMO
                          </span>
                        )}
                        <span className={`text-2xs font-mono font-bold px-2.5 py-0.5 rounded-sm border ${
                          selectedRiskBreakdownPreset.baseRisk < 25 ? "bg-risk-low/10 text-risk-low border-risk-low/25" :
                          selectedRiskBreakdownPreset.baseRisk < 50 ? "bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25" :
                          "bg-risk-critical/10 text-risk-critical border-risk-critical/25"
                        }`}>
                          {selectedRiskBreakdownPreset.riskStatus}
                        </span>
                      </div>
                    </div>
                    
                    <div className="flex items-baseline justify-center gap-1.5">
                      <span className="text-4xl font-mono font-bold text-text-primary tracking-tighter tabular-nums">
                        {selectedRiskBreakdownPreset.baseRisk}
                      </span>
                      <span className="text-xs font-mono text-text-muted tabular-nums">/ 100</span>
                    </div>

                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          selectedRiskBreakdownPreset.baseRisk < 25 ? "bg-risk-low" :
                          selectedRiskBreakdownPreset.baseRisk < 50 ? "bg-risk-elevated" :
                          "bg-risk-critical"
                        }`}
                        style={{ width: `${selectedRiskBreakdownPreset.baseRisk}%` }}
                      ></div>
                    </div>

                    {/* Score components: the engine's real weighted sub-scores.
                        The composite above IS the weighted sum of these four. */}
                    {breakdownData && (
                      <>
                        <div className="grid grid-cols-4 gap-2 pt-2 text-center text-xs font-mono">
                          <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                            <span className="flex items-center justify-center gap-1 text-2xs text-text-muted uppercase mb-0.5">
                              Position ×40%
                              <InfoTip text="Distance to liquidation: health factor plus current LTV." />
                            </span>
                            <strong className="text-text-primary tabular-nums">{breakdownData.subs.positionHealth}</strong>
                          </div>
                          <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                            <span className="flex items-center justify-center gap-1 text-2xs text-text-muted uppercase mb-0.5">
                              Asset ×25%
                              <InfoTip text="Collateral price volatility, 90d drawdown, and BTC correlation." />
                            </span>
                            <strong className="text-text-primary tabular-nums">{breakdownData.subs.assetRisk}</strong>
                          </div>
                          <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                            <span className="flex items-center justify-center gap-1 text-2xs text-text-muted uppercase mb-0.5">
                              Protocol ×20%
                              <InfoTip text="Protocol safety: audits, governance timelock, market controls." />
                            </span>
                            <strong className="text-text-primary tabular-nums">{breakdownData.subs.protocolSafety}</strong>
                          </div>
                          <div className="bg-white/[0.02] border border-border-subtle p-2 rounded-md">
                            <span className="flex items-center justify-center gap-1 text-2xs text-text-muted uppercase mb-0.5">
                              Systemic ×15%
                              <InfoTip text="Market-wide stress: sector TVL flows and capital flight." />
                            </span>
                            <strong className="text-text-primary tabular-nums">{breakdownData.subs.systemicRisk}</strong>
                          </div>
                        </div>
                        <p className="text-2xs font-mono text-text-muted leading-relaxed">
                          The headline score is the weighted sum of these four components.
                        </p>
                      </>
                    )}
                  </div>

                  {/* 10 Risk Dimensions Table/Cards Grid */}
                  <div className="space-y-3">
                    <span className="block text-2xs font-mono text-text-muted tracking-wider uppercase">
                      Liquidation & Pool Metrics
                    </span>
                    
                    <div className="grid grid-cols-2 gap-3">
                      {/* Dimension 1: LTV */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          1. LTV Rating
                          <InfoTip text="Debt as a share of collateral value. Closer to the protocol's max means a smaller cushion." />
                        </span>
                        <span className="text-base font-mono font-bold text-text-primary mt-1 tabular-nums">
                          {Math.round((selectedRiskBreakdownPreset.defaultBorrow / (selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)) * 100)}%
                        </span>
                      </div>

                      {/* Dimension 2: Health Factor (live engine value when available) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          2. Health Factor
                          <InfoTip text="Below 1.00 the protocol can liquidate this position. No debt means no liquidation risk." />
                        </span>
                        {breakdownData?.healthFactor == null ? (
                          <span className="text-base font-mono font-bold mt-1 text-risk-low">No debt</span>
                        ) : (
                          <span className={`text-base font-mono font-bold mt-1 tabular-nums ${
                            breakdownData.healthFactor < 1.3 ? "text-risk-critical" :
                            breakdownData.healthFactor < 1.7 ? "text-risk-elevated" : "text-risk-low"
                          }`}>
                            {breakdownData.healthFactor.toFixed(2)}
                          </span>
                        )}
                      </div>

                      {/* Dimension 3: Liquidation Price (from the engine's drawdown when live) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          3. Liquidation Price
                          <InfoTip text="The collateral price at which this position becomes liquidatable." />
                        </span>
                        <span className="text-sm font-mono font-bold text-text-primary mt-1 tabular-nums">
                          {breakdownData?.liqPrice != null ? formatCurrency(breakdownData.liqPrice) : "-"}
                        </span>
                      </div>

                      {/* Dimension 4: Buffer to Liquidation */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          4. Buffer to Liquidation
                          <InfoTip text="How far the collateral price must fall before liquidation. Your real safety margin - the most decision-useful number here." />
                        </span>
                        <span className="text-base font-mono font-bold text-text-primary mt-1 tabular-nums">
                          {breakdownData?.bufferPct != null ? `${breakdownData.bufferPct}%` : "-"}
                        </span>
                      </div>

                      {/* Dimension 5: Collateral Value */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">5. Collateral Value</span>
                        <span className="text-xs font-mono font-bold text-text-primary mt-1 truncate tabular-nums">
                          {selectedRiskBreakdownPreset.defaultCollateral} {selectedRiskBreakdownPreset.collateralAsset} ({formatCurrency(selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)})
                        </span>
                      </div>

                      {/* Dimension 6: Borrowed Amount */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-mono text-text-muted uppercase">6. Borrowed Amount</span>
                        <span className="text-xs font-mono font-bold text-text-primary mt-1 truncate tabular-nums">
                          {selectedRiskBreakdownPreset.defaultBorrow} {selectedRiskBreakdownPreset.debtAsset}
                        </span>
                      </div>

                      {/* Dimension 7: Pool Utilization */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md col-span-2 flex justify-between items-center text-xs font-mono">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          7. Pool Borrow Utilization
                          <InfoTip text="Share of the pool's supplied funds currently borrowed. Very high utilization can delay withdrawals and spike rates." />
                        </span>
                        <span className="text-xs font-mono font-bold text-risk-low tabular-nums">
                          {72 + (selectedRiskBreakdownPreset.baseRisk % 12)}% (Optimal range)
                        </span>
                      </div>

                      {/* Dimension 8: Supply APY with 30d trend (DefiLlama) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          8. Supply APY (30d)
                          <InfoTip text="What suppliers earn in this pool right now, with the last 30 days' trend." />
                        </span>
                        {breakdownData?.poolYield ? (
                          <>
                            <span className="text-base font-mono font-bold text-risk-low mt-1 tabular-nums">
                              {breakdownData.poolYield.apy.toFixed(2)}%
                            </span>
                            <Sparkline data={breakdownData.poolYield.apySeries} stroke="var(--color-sky-400)" height={24} className="mt-1" />
                          </>
                        ) : (
                          <span className="text-base font-mono font-bold text-text-muted mt-1 tabular-nums">
                            {selectedRiskBreakdownPreset.apy.toFixed(1)}%
                          </span>
                        )}
                      </div>

                      {/* Dimension 9: Pool TVL with 30d trend (DefiLlama) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-mono text-text-muted uppercase">
                          9. Pool TVL (30d)
                          <InfoTip text="Total value locked in this pool. Falling TVL can signal capital flight." />
                        </span>
                        {breakdownData?.poolYield ? (
                          <>
                            <span className="text-base font-mono font-bold text-text-primary mt-1 tabular-nums">
                              {formatCompactUsd(breakdownData.poolYield.tvlUsd)}
                            </span>
                            <Sparkline data={breakdownData.poolYield.tvlSeries} stroke="var(--color-sky-400)" height={24} className="mt-1" />
                          </>
                        ) : (
                          <span className="text-base font-mono font-bold text-text-muted mt-1">-</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Dimension 8, 9, 10: Risk Signals */}
                  <div className="space-y-3.5">
                    <span className="block text-2xs font-mono text-text-muted tracking-wider uppercase">
                      Risk Signals & Drivers
                    </span>

                    <div className="space-y-2 text-xs font-mono">
                      {/* Dimension 10: Protocol Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">10. Protocol Security Signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.protocol === "Aave V3" && "Aave V3 safety module is funded and active. Dynamic interest-rate curves and isolation mode in place. Governance secured by multi-sig and timelock."}
                          {selectedRiskBreakdownPreset.protocol === "Moonwell" && "Moonwell markets run on Base with a 48-hour governance timelock on system parameters. Collateral factors monitored continuously."}
                          {selectedRiskBreakdownPreset.protocol === "Morpho" && "Morpho Blue markets are isolated and immutable. Oracle and LLTV are fixed at market creation, so live parameters cannot be changed by governance."}
                          {selectedRiskBreakdownPreset.protocol === "Compound V3" && "Compound III (Comet) isolates a single borrowable asset against monitored collateral. Parameter changes pass a governance timelock."}
                        </p>
                      </div>

                      {/* Dimension 11: Pool Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">11. Pool Liquidity Signal</span>
                        <p className="text-text-secondary">
                          Primary pool depth exceeds $82,000,000 in active vault lines. Slippage parameters on decentralized exchanges index &lt; 0.15% depth buffer. No oracle drift.
                        </p>
                      </div>

                      {/* Dimension 12: Position Signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted uppercase mb-1 font-bold">12. Position Watch Signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.baseRisk < 20 
                            ? "Position health maintains normal volatility parameters. No automated hedges currently required."
                            : "Position health has entered an elevated stress range. Consider reducing leverage or adding collateral before the health factor approaches 1.25."
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
                      setWatchSource("recommendations");
                      setActiveTab("watch");
                      setSelectedRiskBreakdownPreset(null);
                    }}
                    className="flex-1 py-3 text-center text-xs font-mono font-bold text-text-primary bg-white/[0.06] border border-border-subtle rounded-md cursor-pointer hover:bg-white/10 transition-all"
                  >
                    Open Simulator
                  </button>
                  <button
                    onClick={() => setOpenPositionPreset(selectedRiskBreakdownPreset)}
                    className="flex-1 py-3 text-center text-xs font-mono font-bold text-surface-base bg-text-primary rounded-md cursor-pointer hover:opacity-90 transition-all shadow-lg"
                  >
                    Open Position
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

      </div>

      {/* Demo-only open-position flow (no signing, no funds - see component) */}
      {openPositionPreset && (() => {
        const isFromWatch = activeTab === "watch" && openPositionPreset.id === activeMarket.id;
        const customCollateralUsd = isFromWatch ? collateralAmount * assetPrice : undefined;
        const customBorrowPct = isFromWatch && (collateralAmount * assetPrice > 0)
          ? (borrowUsd / (collateralAmount * assetPrice)) * 100
          : undefined;
        return (
          <OpenPositionModal
            target={{
              protocol: openPositionPreset.protocol,
              assetPair: openPositionPreset.assetPair,
              collateralAsset: openPositionPreset.collateralAsset,
              debtAsset: openPositionPreset.debtAsset,
              baseRisk: openPositionPreset.baseRisk,
              apy: poolYields?.[openPositionPreset.id]?.apy ?? openPositionPreset.apy,
              customCollateralUsd,
              customBorrowPct,
            }}
            onClose={() => setOpenPositionPreset(null)}
          />
        );
      })()}

      {/* Alerts-inactive banner. The one failure this product cannot afford is
          the silent one: onboarding completes, the dashboard looks alive, and
          the wallet was never added to watched_wallets, so no liquidation alert
          will ever be sent. Persistent (no dismiss) until monitoring is on. */}
      {monitoringError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[210] w-full max-w-xl px-4">
          <div
            role="alert"
            className="flex items-center gap-3 bg-surface-overlay border border-risk-critical/40 rounded-md px-4 py-3 shadow-2xl shadow-black/60"
          >
            <ShieldAlert className="w-4 h-4 shrink-0 text-risk-critical" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono font-bold text-risk-critical uppercase tracking-wider">
                Alerts inactive
              </p>
              <p className="text-2xs text-text-secondary mt-0.5">
                {monitoringError} Verify wallet ownership to enable liquidation alerts.
              </p>
            </div>
            <button
              onClick={retryMonitoring}
              disabled={monitoringBusy}
              className="shrink-0 px-3 py-1.5 rounded-md bg-text-primary hover:opacity-90 disabled:opacity-50 text-2xs font-mono font-bold uppercase tracking-wider text-black transition-colors cursor-pointer"
            >
              {monitoringBusy ? "Verifying..." : "Retry"}
            </button>
          </div>
        </div>
      )}

      {/* Atomic Exit / Reduce flow (Phase 2) - real transactions, user-signed */}
      {exitPrefill && (
        <ExitFlow prefill={exitPrefill} onClose={() => setExitPrefill(null)} />
      )}

      {/* In-app open flow (Phase 2) - Base mainnet, user-signed */}
      {openFlowPlan && (
        <OpenFlow
          plan={openFlowPlan}
          riskProfile={selectedRiskProfile}
          onClose={() => setOpenFlowPlan(null)}
          // A position opened but not monitored is the same silent failure as
          // an unregistered onboarding — route it to the same banner.
          onMonitoring={(wallet, profile, result: RegisterResult) => {
            setMonitoringTarget({ wallet, profile });
            setMonitoringError(result.ok ? null : result.error);
          }}
        />
      )}

      {/* Advisor popup (Phase 2) - fires on action changes / market shifts */}
      <AdvisorPopup
        report={advisorLive.report}
        onExit={(prefill) => setExitPrefill(prefill)}
        onOpen={(plan) => setOpenFlowPlan(plan)}
        onView={() => setActiveTab("advisor")}
      />

      {/* First-run onboarding tooltip tour */}
      {currentTourStep && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] w-full max-w-sm px-4">
          <div className="bg-surface-raised border border-border-subtle rounded-md p-4 shadow-2xl shadow-black/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-2xs font-mono text-text-primary uppercase tracking-widest font-bold">
                Step {currentTourStep.step} of {TOUR_STEPS.length}
              </span>
              <button onClick={dismissTour} className="text-text-muted hover:text-text-primary transition-colors text-2xs font-mono uppercase cursor-pointer">
                Skip tour
              </button>
            </div>
            <p className="text-sm font-display font-semibold text-text-primary mb-0.5">{currentTourStep.label}</p>
            <p className="text-xs text-text-secondary font-sans leading-relaxed mb-4">{currentTourStep.body}</p>
            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                {TOUR_STEPS.map((s) => (
                  <span key={s.step} className={`h-1 w-6 rounded-full transition-colors ${s.step <= currentTourStep.step ? "bg-text-primary" : "bg-white/10"}`} />
                ))}
              </div>
              <button
                onClick={() => {
                  if (tooltipStep !== null && tooltipStep < TOUR_STEPS.length) {
                    setTooltipStep(tooltipStep + 1);
                  } else {
                    dismissTour();
                  }
                }}
                className="h-8 px-4 bg-text-primary hover:opacity-90 text-surface-base font-mono text-2xs uppercase tracking-wider rounded-md cursor-pointer transition-colors"
              >
                {tooltipStep === TOUR_STEPS.length ? "Done" : "Next →"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
    </>
  );
}
