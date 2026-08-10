/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useAccount } from "wagmi";
import {
  ShieldAlert,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  RefreshCw, 
  Layers, 
  Wallet, 
  Sliders,
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
  Plus,
} from "lucide-react";
import {
  bandOfHealthFactor,
  bandOfScore,
  calculateDynamicPosition,
  formatCompactUsd,
  formatCurrency,
  formatUsd,
  limitEventCopy,
  limitStateCopy,
  liquidationOutlook,
  RISK_CHIP,
  RISK_FILL,
  RISK_TEXT,
} from "./lib/utils";
/**
 * The user's alert level, from the engine rather than a literal. A VALUE import
 * from `packages/scoring` — allowed here only because it is a DEEP import of
 * `profile.ts`, whose sole import is type-only. The package barrel pulls viem
 * and must never reach a browser bundle (see lib/live.ts).
 */
import { ALERT_THRESHOLD } from "../../packages/scoring/src/profile";
/**
 * The composite weights, from the engine for the same reason: `params.ts` has no
 * imports at all. Three surfaces on this file used to hard-code 40/25/20/15, one
 * of them inside an InfoTip that TEACHES the number — a re-weight in the engine
 * would have had the UI stating a wrong one with no visual tell.
 */
import { COMPOSITE_WEIGHTS } from "../../packages/scoring/src/params";
import { PositionState } from "./lib/types";
import { LivePositions, positionKey } from "./components/LivePositions";
import { Sparkline } from "./components/Sparkline";
import { OpenPositionModal } from "./components/OpenPositionModal";
import { InfoTip } from "./components/InfoTip";
import { Button, Card, EmptyState, RiskChip, Skeleton, Stat, TabPanel } from "./ui";
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
  type PoolYield,
} from "./lib/live";
import { AdvisorPanel } from "./components/AdvisorPanel";
import { ExitFlow, type ExitPrefill } from "./components/ExitFlow";
import { DelegationManager } from "./components/DelegationManager";
import { OpenFlow } from "./components/OpenFlow";
import { AdvisorPopup } from "./components/AdvisorPopup";
import type { AdvisorOpenPlan } from "./lib/live";
import { ALL_PROTOCOLS, ProtocolLogo, ProtocolMarks } from "./components/ProtocolLogo";
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
 * The four weighted sub-scores behind a composite, in weight order, stated ONCE
 * for the two surfaces that list them: Watch's score breakdown and Compass's
 * risk-breakdown panel.
 *
 * Watch used to render them twice on one screen under two names, with two
 * different numbers for the same quantity, and the Compass panel hand-typed a
 * third copy of the labels and the weights. The table is the fix: label, hint
 * and weight exist in one place, and the value is read out of a breakdown by an
 * accessor, so no surface can invent its own.
 *
 * `key` is the engine's own sub-score name, which is also the key into
 * COMPOSITE_WEIGHTS — so the weight is READ from the engine rather than retyped,
 * and a re-weight there moves every InfoTip and every panel label at once.
 *
 * "Market stress", not "Pool conditions": the quantity is market-wide (sector
 * TVL flows, broad drawdowns), and calling it a pool property was the third
 * name on this screen for something that is not a pool.
 */
interface RiskDriver {
  /** Engine sub-score name — indexes COMPOSITE_WEIGHTS and the live sub-scores. */
  key: keyof typeof COMPOSITE_WEIGHTS;
  label: string;
  /** The same driver named in one word, for the panel's four narrow cells. */
  short: string;
  hint: string;
  /** The panel's cells are half the width and get their own, shorter, hint. */
  panelHint: string;
  of: (b: PositionState["breakdown"]) => number;
}

const RISK_DRIVERS: RiskDriver[] = [
  {
    key: "positionHealth",
    label: "Position health",
    short: "Position",
    hint: "How close your health factor and your LTV sit to the protocol's liquidation point.",
    panelHint: "Distance to liquidation: health factor plus current LTV.",
    of: (b) => b.positionHealth,
  },
  {
    key: "assetRisk",
    label: "Asset volatility",
    short: "Asset",
    hint: "How sharply your collateral's price has moved recently (30d vol, drawdown, correlation). Volatile collateral erodes your buffer faster.",
    panelHint: "Collateral price volatility, 90d drawdown, and BTC correlation.",
    of: (b) => b.assetVolatility,
  },
  {
    key: "protocolSafety",
    label: "Protocol risk",
    short: "Protocol",
    hint: "Audit posture, governance timelock, and market controls of the protocol holding this position.",
    panelHint: "Protocol safety: audits, governance timelock, market controls.",
    of: (b) => b.protocolSafety,
  },
  {
    key: "systemicRisk",
    label: "Market stress",
    short: "Systemic",
    hint: "Market-wide stress: sector TVL flows and broad drawdowns that hit every position at once.",
    panelHint: "Market-wide stress: sector TVL flows and capital flight.",
    of: (b) => b.systemicMarketStress,
  },
];

/**
 * A driver's share of the composite, as a whole percent. Rounded because the
 * weights are fractions and `0.15 * 100` is not a number anyone wants printed.
 */
function driverWeightPct(driver: RiskDriver): number {
  return Math.round(COMPOSITE_WEIGHTS[driver.key] * 100);
}

/** Tailwind's `md`. The nav swaps here, so the JS query and the CSS agree. */
const DESKTOP_MQ = "(min-width: 48rem)";

/**
 * Tailwind's `lg`. Where the Portfolio grid becomes two columns, which is the
 * only thing the chart's height should follow: below it the card is full bleed
 * and a 220px chart is most of a phone viewport.
 */
const WIDE_MQ = "(min-width: 64rem)";

/**
 * A CSS breakpoint, as a boolean. Used where a value is not expressible as a
 * class pair — a `height` prop on a chart — and, for the nav, where two copies
 * of the markup cannot both exist: two tablists would duplicate every `tab-*` id
 * the panels point at with `aria-labelledby` and would both write into the same
 * `tabRefs` map, so the roving tabindex would try to focus whichever mounted
 * last, which on a phone is the `display: none` one and a silent no-op.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

interface NavTabsProps {
  /** "sidebar" = vertical rail (desktop), "bar" = bottom tab bar (phone). */
  variant: "sidebar" | "bar";
  activeTab: SidebarTab;
  onSelect: (id: SidebarTab) => void;
  tabRefs: React.MutableRefObject<Partial<Record<SidebarTab, HTMLButtonElement | null>>>;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * The application tablist — ARIA APG tabs, one instance mounted at a time.
 * Roving tabindex: only the selected tab is in the page tab order, so Tab
 * reaches the nav once and the arrows move within it instead of forcing five
 * stops past it. Activation follows focus because each panel is mounted on
 * demand and switching is free.
 *
 * `aria-orientation` tracks the variant, which is the contract for which arrow
 * keys a screen reader announces. The handler accepts both axes either way, so
 * a horizontal bar still responds to Up/Down and nothing regresses on the swap.
 */
function NavTabs({ variant, activeTab, onSelect, tabRefs, onKeyDown }: NavTabsProps) {
  const vertical = variant === "sidebar";
  return (
    <nav
      role="tablist"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label="Application sections"
      className={vertical ? "space-y-1" : "flex items-stretch"}
      onKeyDown={onKeyDown}
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
            onClick={() => onSelect(id)}
            className={
              vertical
                ? `relative w-full flex items-center gap-3 px-4.5 py-3 rounded-md text-sm font-sans text-left transition-all cursor-pointer ${
                    selected
                      ? "bg-white/[0.06] border border-border-subtle text-text-primary font-semibold"
                      : "text-text-secondary hover:text-text-primary hover:bg-white/[0.02] border border-transparent"
                  }`
                : /* 56px tall and a fifth of the viewport wide: comfortably past
                     the 24px WCAG 2.5.8 floor and past the 44px that a thumb
                     actually wants for primary navigation. */
                  `flex-1 min-w-0 flex flex-col items-center justify-center gap-1 min-h-14 px-1 text-2xs font-sans transition-colors cursor-pointer ${
                    selected
                      ? "bg-white/[0.06] text-text-primary font-bold"
                      : "text-text-secondary"
                  }`
            }
          >
            {/* No accent rail here on purpose. `--color-panik-orange` and
                `--color-risk-high` are the same hex, so any orange in the
                shell is the same colour a user has just been taught means
                HIGH. The raised surface and the brighter, heavier label
                already answer "where am I" on their own, so the rail was
                buying nothing and costing that ambiguity. Colour in this
                product is either a risk band or a chart category; being
                brand is not a third job it does. */}
            <Icon
              className={`${vertical ? "w-4 h-4" : "w-4.5 h-4.5 shrink-0"} ${
                selected ? "text-text-primary" : "text-text-secondary"
              }`}
            />
            <span className={vertical ? "" : "truncate max-w-full"}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Watch tab data source. "positions" = the user's REAL on-chain positions
 * (the business requirement: Watch mirrors what you actually hold), seeded
 * into the stress-test simulator. "recommendations" = the Compass preset
 * catalog for what-if auditing before opening a position.
 */
type WatchSource = "positions" | "recommendations";
type RiskProfile = "conservative" | "moderate" | "aggressive";

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

/**
 * Alert feed page size. Eight rows is roughly the 320px the old `max-h-80`
 * scroller clamped to, so the card keeps the height it has today and gains a
 * way to reach row nine, which it did not have.
 */
const ALERT_PAGE_SIZE = 8;

/** How long a position row stays emphasised after an alert points at it. */
const HIGHLIGHT_MS = 4000;

/**
 * One alert row's layout, shared by the linked (button) and inert (div) forms.
 *
 * `py-4` is the `p-4` a position row carries, so the two cards standing side by
 * side on Portfolio share one rhythm. At `py-2.5` with 12px content this feed
 * was visibly denser and smaller than the list beside it, which read as a
 * secondary panel rather than the other half of the same dashboard. The rules
 * stay hairlines rather than becoming boxes: a bordered row inside a bordered
 * card is chrome wrapping chrome, and `divide-y` is what this card is for.
 */
const ALERT_ROW_CLS =
  "flex w-full items-baseline justify-between gap-3 py-4 first:pt-0 last:pb-0";

/** Alert-outcome chip copy for the Portfolio history feed. */
const CHIP_QUIET = "text-text-muted border-border-subtle bg-white/[0.03]";

/**
 * Delivery outcome, not risk. "Sent" was green and "queued" amber, which put
 * the risk ramp on a fact about our own plumbing. Only `blocked` keeps a hue:
 * it is the one state where PANIK is failing to reach the user, and that is
 * worth interrupting for.
 */
const NOTIFY_CHANNEL_CHIP: Record<string, { label: string; cls: string }> = {
  suppressed_cooldown: { label: "Muted · cooldown", cls: CHIP_QUIET },
  suppressed_immaterial: { label: "Muted · no debt", cls: CHIP_QUIET },
  blocked: { label: "Bot blocked", cls: "text-risk-critical border-risk-critical/25 bg-risk-critical/10" },
};

/**
 * Outcomes that render NO chip. Same rationale that left only `blocked` hued,
 * taken one step further: a chip that says "Sent · Telegram" on eleven of
 * twelve rows is the expected case drawn twelve times, and the one row that
 * matters — the alert that did not reach you — has to compete with it.
 *
 * `telegram` is delivery succeeding. `skipped` is a recovery, where the row's
 * own "back under your risk limit" already says there was nothing to send.
 * Everything else still renders: queued, both suppressions, blocked, and any
 * channel we do not know.
 * Silence here means "PANIK reached you", so nothing that failed can borrow it.
 */
const DELIVERY_SILENT = new Set(["telegram", "skipped"]);

/** null = delivered as expected, so the row stays one quiet line. */
function deliveryChip(channel: string | null): { label: string; cls: string } | null {
  if (channel === null) return { label: "Queued", cls: CHIP_QUIET };
  if (DELIVERY_SILENT.has(channel)) return null;
  return NOTIFY_CHANNEL_CHIP[channel] ?? { label: channel, cls: CHIP_QUIET };
}

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
      COMPOSITE_WEIGHTS.positionHealth * positionHealth -
      COMPOSITE_WEIGHTS.assetRisk * assetRisk -
      COMPOSITE_WEIGHTS.protocolSafety * protocolSafety) /
      COMPOSITE_WEIGHTS.systemicRisk,
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

/** The three Compass risk profiles, as a table so the toggle is one map. */
const RISK_PROFILES = ["conservative", "moderate", "aggressive"] as const;

/**
 * What the 30d APY sparkline was drawing, as one clause.
 *
 * The chart it replaces plotted a 0.2-point band across a full card width, with
 * a two-label y-axis, a two-label x-axis and a caption underneath: six elements
 * and 36px of height to say "this yield has not moved much". A line whose whole
 * range is smaller than the ink used to draw it is noise rendered as signal,
 * and the only fact a reader could actually take from it is direction — which
 * is a sentence.
 *
 * This is the same trade the Portfolio history card already makes: it dropped
 * the restated score and kept "up 3 over 30d". The shape is still there for
 * anyone who wants it, in the risk-breakdown panel behind the card.
 *
 * Measured against the APY the card is SHOWING, not against the end of the
 * series. The two are the same number in production but need not be — the
 * headline is a separate field on the API row — and a card reading "2.5% APY"
 * over "Up from 2.6%" is a card arguing with itself.
 *
 * 0.1 is the flat threshold, not zero: it is the smallest move that survives
 * one-decimal rounding, so "Up from 2.5%" can never sit under "2.5% APY".
 */
function apyTrendCopy(apy: number, apySeries: number[]): string | null {
  const first = apySeries[0];
  if (first === undefined) return null;
  const delta = apy - first;
  if (Math.abs(delta) < 0.1) return "Flat over 30 days";
  return `${delta > 0 ? "Up" : "Down"} from ${first.toFixed(1)}% 30 days ago`;
}

/**
 * One Compass market.
 *
 * Deliberately shaped like a Portfolio position row, because it is the same
 * kind of object seen from the other side: identity on the left, the band on
 * the right, the money on one line, the verdict on the next, actions at the
 * foot. Nine stacked elements became five.
 *
 * `muted` is the "outside your profile" rendering. It dims the SURFACE only.
 * The old version also dimmed the logo, the title and the risk chip, which put
 * a CRITICAL market's band at 60% opacity — the one card on the page most worth
 * reading clearly was the faintest. Which section it is in already says it is
 * out of profile; the chip's job is to say how far.
 */
function MarketCard({
  preset,
  poolYield,
  muted = false,
  onBreakdown,
  onSimulate,
  onOpen,
}: {
  preset: VaultPreset;
  poolYield: PoolYield | null;
  muted?: boolean;
  onBreakdown: () => void;
  onSimulate: () => void;
  /** Absent on an out-of-profile card: nothing there is a recommended step. */
  onOpen?: () => void;
}) {
  const apy = poolYield?.apy ?? preset.apy;
  const trend = poolYield ? apyTrendCopy(apy, poolYield.apySeries) : null;
  return (
    <div
      onClick={onBreakdown}
      className={`flex cursor-pointer flex-col gap-3 rounded-lg border border-border-subtle p-5 transition-colors hover:border-border-strong ${
        muted
          ? "bg-surface-raised/25 hover:bg-surface-raised/45"
          : "bg-surface-raised/60 hover:bg-surface-overlay/70"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProtocolLogo protocol={preset.protocol} size="w-8 h-8" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-sans font-bold text-text-primary">
              {preset.protocol}
            </h3>
            <span className="block truncate text-xs font-sans text-text-secondary">
              {preset.assetPair}
            </span>
          </div>
        </div>
        {/* The chip is the keyboard route into the breakdown; the card body is
            the mouse route. It no longer opens the panel on MOUSEENTER — a
            500px slide-out with a full-page backdrop was firing on an
            accidental pass of the cursor, so the page moved out from under
            anyone scanning the grid. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onBreakdown();
          }}
          title={`Open the ${preset.protocol} risk breakdown`}
          className="shrink-0 cursor-pointer rounded-sm"
        >
          <RiskChip band={preset.riskStatus}>
            {preset.baseRisk} {preset.riskStatus}
          </RiskChip>
        </button>
      </div>

      {/* The money line, in the Portfolio position row's exact shape: figure in
          primary ink, unit in secondary, each pair unbreakable. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm font-sans tabular-nums text-text-secondary">
        <span className="whitespace-nowrap">
          <span className="font-semibold text-text-primary">{apy.toFixed(1)}%</span> APY
        </span>
        {poolYield && (
          <span className="whitespace-nowrap">
            <span className="font-semibold text-text-primary">
              {formatCompactUsd(poolYield.tvlUsd)}
            </span>{" "}
            TVL
          </span>
        )}
      </div>

      <p className="text-sm font-sans tabular-nums text-text-secondary">
        {trend ?? "30-day yield history unavailable"}
      </p>

      <div
        className={`mt-1 flex items-center gap-3 border-t border-border-subtle pt-3 ${
          onOpen ? "justify-between" : "justify-end"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {onOpen && (
          <Button onClick={onOpen}>
            <Plus className="h-3.5 w-3.5" />
            Open position
          </Button>
        )}
        <Button variant="quiet" onClick={onSimulate}>
          Stress-test →
        </Button>
      </div>
    </div>
  );
}

export function AppDemo() {
  // Navigation tabs exactly reflecting the Figma screenshot
  const [activeTab, setActiveTab] = useState<SidebarTab>("portfolio");
  const isDesktop = useMediaQuery(DESKTOP_MQ);
  const isWide = useMediaQuery(WIDE_MQ);

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
  const [riskTier, setRiskTier] = useState<RiskTier | null>(
    () => localStorage.getItem("panik_risk_tier") as RiskTier | null
  );

  /**
   * The CONNECTED wallet wins over the stored one.
   *
   * `panik_wallet` is a plain localStorage string with no ownership proof
   * behind it, and everything on this dashboard (positions, advisor, history)
   * is keyed on it. `npm run dev:mock` seeds the fixture address into that key
   * (dev/mockApi.ts), the real app then reads it back, and the user spends the
   * session looking at a wallet they have never owned while their own position
   * is invisible. The exit flow, meanwhile, reads the chain for whatever wallet
   * is actually connected, so the dashboard and the Exit button were describing
   * two different accounts.
   *
   * Preferring the connected address is the smallest fix that makes those two
   * agree: it is the only wallet the user can prove and the only one the exit
   * can act on. Proving ownership properly (SIWE-gated identity, watch-only
   * addresses done deliberately rather than by accident) is Issue #51 and is
   * NOT built here.
   */
  const { address: connectedWallet } = useAccount();
  useEffect(() => {
    if (!connectedWallet) return;
    if (onboardedWallet && onboardedWallet.toLowerCase() === connectedWallet.toLowerCase()) return;
    localStorage.setItem("panik_wallet", connectedWallet);
    setOnboardedWallet(connectedWallet);
  }, [connectedWallet, onboardedWallet]);

  const handleOnboardingComplete = (result: ProfileResult, wallet: string) => {
    saveProfileForWallet(wallet.trim(), result); // per-wallet memory (wallet-switch flow)
    localStorage.setItem("panik_onboarded", "true");
    localStorage.setItem("panik_risk_profile", result.riskProfile3); // 3-level (Compass)
    localStorage.setItem("panik_risk_tier", result.riskTier);         // 5-level (display)
    localStorage.setItem("panik_user_segment", result.segment);
    localStorage.setItem("panik_risk_score", String(result.riskScore));
    localStorage.setItem("panik_wallet", wallet);
    setSelectedRiskProfile(result.riskProfile3);
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
  //
  // The segment is READ here rather than held in state. It was a `useState`
  // seeded from localStorage, and after its badge was deleted this effect was
  // the only thing left that ever looked at it — so the component was carrying
  // a render-triggering copy of a string that nothing renders. localStorage is
  // already the source of truth for it; the copy was the derived value.
  useEffect(() => {
    const userSegment = localStorage.getItem("panik_user_segment") as Segment | null;
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
  }, [onboardedWallet, riskTier]);

  // Saved per-wallet profiles for the wallet-switch flow. Recomputed whenever
  // the overlay opens so a just-saved profile is seen.
  const savedProfiles = useMemo(
    () => loadProfileStore(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onboardedWallet, showOnboarding],
  );

  // Live gas price for the header strip. This is the ONLY piece of chain
  // telemetry this component still keeps: the block number, the rolling event
  // log and a one-second refresh countdown were all held in state that nothing
  // rendered. The countdown in particular re-rendered this entire component
  // once a second, forever, to update a number with no reader.
  const [gasPrice, setGasPrice] = useState<number>(2.8);

  // Settings tab preferences (auto-repayment trigger).
  const [automaticRepayTarget, setAutomaticRepayTarget] = useState<number>(30);
  const [isRepayActive, setIsRepayActive] = useState<boolean>(true);

  // ── LIVE data (scoring API; every hook degrades gracefully offline) ──────
  // Declared FIRST — the memos below consume these (const = TDZ).
  const { positions: livePositions, offline: liveOffline } = useLiveScores();
  const { scores: compassLive } = useCompassScores();
  const { pools: poolYields } = useCompassYields();
  const chainTel = useChainTelemetry();

  // Once a user has onboarded with their OWN wallet, the dashboard follows that
  // wallet (its live Base positions) instead of the seeded validation registry.
  // boundMode hides the registry selector entirely. (SIWE later proves ownership.)
  const boundMode = Boolean(onboardedWallet);
  const ownLive = useWalletPositions(onboardedWallet, selectedRiskProfile);

  /**
   * Coverage is a property of the chain being read, and the API is the only
   * thing that knows which chain that was. Until it answers, the four marks
   * stay: that is the default configuration and the claim the product has
   * always made. Once it answers, the row shows exactly what was scanned, so a
   * Base Sepolia user is not told that three protocols with no market there
   * were checked and found empty.
   */
  const coveredProtocols = useMemo(() => {
    const wire = ownLive.chain?.protocols;
    if (!wire || wire.length === 0) return ALL_PROTOCOLS;
    return wire.map((p) => LIVE_PROTOCOL_LABEL[p] ?? p);
  }, [ownLive.chain]);
  const coveredChainLabel = ownLive.chain?.label ?? "Base";
  const coveredProtocolSentence = useMemo(
    () =>
      coveredProtocols.length > 1
        ? `${coveredProtocols.slice(0, -1).join(", ")} and ${coveredProtocols[coveredProtocols.length - 1]}`
        : (coveredProtocols[0] as string),
    [coveredProtocols],
  );

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

  // ── Alert coverage ────────────────────────────────────────────────────────
  // This used to be the subline of the "Monitored capital" stat card, reading
  // "Connect Telegram for alerts". Two things were wrong with that. It is a
  // call to action, and a stat card is a place you READ a number, not a place
  // you action anything — there is nothing to click, so the one sentence on
  // the dashboard telling a user they are unprotected was also the one
  // sentence they could do nothing about. And it made a card titled
  // "Monitored capital" spend half its area on a fact about Telegram.
  //
  // Coverage now states itself in Settings, next to the Connect button that
  // fixes it. The registration-failure case (a pasted address that cannot
  // produce an ownership signature, so no alert will ever fire) already has a
  // persistent app-wide banner with a Retry, so it is not repeated here.

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

  /**
   * Alert row -> the position it is about.
   *
   * It scrolls and highlights rather than opening a panel or switching tabs: the
   * alert's question is "which of my positions, and where does it stand now",
   * and the row in the same column answers both in place. A modal would hide the
   * feed being read down; a tab switch would throw the scroll position away.
   *
   * A Map keyed by protocol, not a scan per row: the feed can hold every alert
   * this wallet ever raised, and `find()` inside the render loop is the shape
   * that turns a long feed into a quadratic one.
   */
  const alertTargets = useMemo(() => {
    const byProtocol = new Map<LiveProtocol, string>();
    for (const p of portfolioPositions ?? []) byProtocol.set(p.protocol, positionKey(p));
    return byProtocol;
  }, [portfolioPositions]);

  /**
   * The emphasis is temporary on purpose: it answers "which row" on arrival and
   * then gets out of the way, because an emphasis left standing is a state nobody
   * can explain twenty seconds later. Focus, the part that matters for a keyboard
   * user, stays put.
   *
   * Keyed on the state, so React's own cleanup handles both unmount and a second
   * alert clicked inside the window; nothing clears a timer by hand.
   */
  const [highlightedPositionKey, setHighlightedPositionKey] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightedPositionKey) return;
    const timer = window.setTimeout(() => setHighlightedPositionKey(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightedPositionKey]);

  /**
   * Feed pagination. The old `.slice(0, 12)` was a CEILING, not a page size:
   * alert 13 was unreachable by any means. "Show more" rather than numbered
   * pages, because nobody thinks in pages of alerts.
   *
   * The card keeps its `lg` scroller as well, and the two are not rival
   * mechanisms: the scroller lets a fixed-height card (a column-alignment
   * requirement) hold more rows than it can show, and paging is what puts rows
   * beyond the first eight into it at all.
   */
  const [alertsShown, setAlertsShown] = useState(ALERT_PAGE_SIZE);
  useEffect(() => setAlertsShown(ALERT_PAGE_SIZE), [historyWallet]);
  const alertsRemaining = Math.max(0, (walletHistory?.alerts.length ?? 0) - alertsShown);

  // 30d aggregate risk series: bucket snapshots by day, protocols weighted by
  // collateral USD (same weighting the macro Aggregate risk index uses).
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

  /**
   * Y-domain for the risk history chart.
   *
   * Neither obvious choice works. The series' own min/max makes every window
   * look equally dramatic, so a 2-point drift and a 20-point climb draw the
   * same shape. A full 0-100 makes the line so flat you cannot see it cross
   * anything, which is the one event the chart exists to show.
   *
   * So: fit the data, force the alert threshold into view (a chart that hides
   * the line you are being measured against is pointless), pad by 15% of the
   * span so nothing touches an edge, and snap to fives so the axis labels are
   * numbers a person would choose. Clamped to the score's real 0-100 range.
   */
  const riskDomain = useMemo<[number, number] | undefined>(() => {
    if (!riskHistory) return undefined;
    const threshold = ALERT_THRESHOLD[selectedRiskProfile];
    const lo = Math.min(...riskHistory.series, threshold);
    const hi = Math.max(...riskHistory.series, threshold);
    const pad = Math.max(4, (hi - lo) * 0.15);
    const snap = 5;
    return [
      Math.max(0, Math.floor((lo - pad) / snap) * snap),
      Math.min(100, Math.ceil((hi + pad) / snap) * snap),
    ];
  }, [riskHistory, selectedRiskProfile]);

  // Portfolio macro metrics from the SELECTED wallet's live positions
  const liveMacro = useMemo(() => {
    if (!portfolioPositions || portfolioPositions.length === 0) return null;
    // Legs whose USD values are unavailable (degraded price feed) carry no
    // dollar weight here — their scores and health factors are still exact, so
    // `unpricedLegs` marks the totals as an UNDERSTATEMENT rather than truth.
    // Counted, not just flagged: a total that silently omits a $128,500 leg is
    // the same "unknown rendered as a zero" the null sub-scores exist to stop,
    // and the cards below say how many legs are missing from the sum.
    //
    // Every figure here is `number | null`, and null is the ONLY thing an
    // unmeasurable total is allowed to become. Mapping a missing price to 0 and
    // summing looks harmless one leg at a time and is catastrophic at the
    // limit: with every leg unpriced `capital` came out 0, which sent the
    // collateral-weighted average to its `: 0` branch, and the wallet whose
    // data we trusted least rendered a serene `0 / 100` with no warning glyph.
    // A total nobody could measure is not a small total.
    const priced = (v: number | null): v is number => v !== null && Number.isFinite(v);
    const collateralValues = portfolioPositions
      .map((p) => p.collateralValueUsd)
      .filter(priced);
    const debtValues = portfolioPositions.map((p) => p.borrowValueUsd).filter(priced);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const capital = collateralValues.length > 0 ? sum(collateralValues) : null;
    const debt = debtValues.length > 0 ? sum(debtValues) : null;
    // Weighted by collateral value, so a leg with no price contributes neither
    // a numerator nor a denominator. With no weight at all there is no average
    // to take, and the honest rendering of that is "we could not measure it",
    // never a number.
    const aggregate =
      capital !== null && capital > 0
        ? Math.round(
            sum(
              portfolioPositions.map((p) =>
                priced(p.collateralValueUsd) ? p.total * p.collateralValueUsd : 0,
              ),
            ) / capital,
          )
        : null;
    return {
      capital,
      debt,
      ltv: capital !== null && capital > 0 && debt !== null ? debt / capital : null,
      positions: portfolioPositions.length,
      protocols: new Set(portfolioPositions.map((p) => p.protocol)).size,
      // The card used to name "Aave V3, Moonwell" from a string literal no
      // matter which protocols the wallet was actually in, and that literal is
      // also what pushed the subtitle onto a second line.
      protocolNames: [
        ...new Set(portfolioPositions.map((p) => LIVE_PROTOCOL_LABEL[p.protocol] ?? p.protocol)),
      ],
      aggregate,
      // The flag OR a missing value: a payload cached before the flag existed
      // carries the null without it, and this count is what tells the reader how
      // much of their wallet the figures above leave out. Counting only the flag
      // would let a leg drop out of every sum with nothing on screen saying so.
      unpricedLegs: portfolioPositions.filter(
        (p) => p.usdValuesUnavailable === true || !priced(p.collateralValueUsd),
      ).length,
    };
  }, [portfolioPositions]);

  /**
   * Collateral allocation for the SELECTED wallet.
   *
   * Positions only. This used to fall back to a hand-typed
   * wstETH/USDC/ETH/USDT split with dollar amounts, so a wallet holding nothing
   * — and a wallet still loading — was shown a complete, plausible portfolio it
   * did not own, under a heading that claims to describe its collateral. The
   * fallback is deleted rather than hidden behind a flag: there is no state in
   * which inventing someone's holdings is the right answer, and the card now
   * simply does not render when there is nothing to break down.
   *
   * A leg the engine could not price is EXCLUDED from the split, not entered at
   * zero. A zero-width segment with a real symbol beside it reads as "you hold
   * none of this", which is a different and false claim; the count of excluded
   * legs is stated on the card instead.
   */
  const allocation = useMemo(() => {
    const bySymbol: Record<string, number> = {};
    for (const p of portfolioPositions ?? []) {
      if (p.collateralValueUsd === null || !Number.isFinite(p.collateralValueUsd)) continue;
      bySymbol[p.scoredCollateralSymbol] =
        (bySymbol[p.scoredCollateralSymbol] ?? 0) + p.collateralValueUsd;
    }
    const src = Object.keys(bySymbol)
      .map((symbol) => ({ symbol, usd: bySymbol[symbol] ?? 0 }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 4);
    const total = src.reduce((a, b) => a + b.usd, 0) || 1;
    // CATEGORICAL, not sequential. Telling cbBTC from WETH from wstETH is data
    // encoding, and a single stepped grey destroys it: four opacities of white
    // say "more of this than that", which the percentages already say, while
    // saying nothing about WHICH asset a segment is.
    //
    // Drawn from the reserved cool chart palette in index.css, which contains
    // no red, amber or green precisely so a series can never be misread as a
    // risk band.
    //
    // Cool-only leaves ~90 degrees of hue for four series, which is not enough
    // on hue alone — measured against a 10px legend dot, sky-400 and cyan-300
    // are the same colour. So each step moves in BOTH lightness and hue, and
    // the one genuinely weak pair is pushed to opposite ends of the list:
    //   0 sky-400    h 233 / L 75   bright blue
    //   1 violet-400 h 294 / L 70   lavender
    //   2 indigo-500 h 277 / L 59   deep indigo
    //   3 cyan-300   h 207 / L 87   pale cyan
    // Adjacent pairs are 61, 16 (but 12 of lightness) and 70 degrees apart;
    // the close pair, sky and cyan, sits at slots 0 and 3.
    //
    // The same class drives the bar segment and its legend dot, so the two are
    // matched by construction rather than by two lists kept in sync by hand.
    const shades = ["bg-sky-400", "bg-violet-400", "bg-indigo-500", "bg-cyan-300"];
    return src.map((a, i) => ({ ...a, pct: (a.usd / total) * 100, color: shades[i % 4] as string }));
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
          // No "· YOUR POSITION" suffix: the eyebrow above the Watch heading
          // already says whose position this is, and the heading was rendering
          // "Aave V3 · wstETH / USDC · YOUR POSITION" under a label reading
          // "YOUR POSITION · SCORED ON-CHAIN".
          assetPair: `${pos.scoredCollateralSymbol} / USDC`,
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
  /**
   * Collateral and debt are the SAME asset (the two USDC supply presets).
   * An absolute price move then rescales both sides of the position at once, so
   * the distance to liquidation is a ratio that does not move, and the price
   * scenarios below would be answering a question this market cannot be asked.
   * What moves it here is the two legs pricing apart, which is the pair of price
   * controls, not a scenario chip.
   */
  const sameAssetMarket = activeMarket.collateralAsset === activeMarket.debtAsset;

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
        // No `?? 9.99`. A debt-free position has no health factor, and the
        // sentinel both invented a 90% drop and hid the no-debt case from every
        // helper downstream.
        healthFactor: liveWatch.healthFactor,
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

  /**
   * How far the simulation has moved the score away from the real thing:
   * simulated score minus the live score of the position or market being
   * simulated. It measures the SLIDERS, not time — nothing on this screen reads
   * a 24-hour history, and this once rendered as "+24 in the last 24 hours".
   *
   * A line with nothing to say says nothing (see the render), which is the only
   * honest rendering of "the simulation matches reality".
   */
  const scoreDelta = positionState.riskScore - activeMarket.baseRisk;

  /**
   * Watch's two core tiles: the drop to liquidation, and the LTV.
   *
   * The drop is the VALUE and the exact health factor is the sub-line — Watch is
   * the surface where someone is tuning the number, so it is worth a line of its
   * own rather than the hover it gets elsewhere. It costs no colour, because a
   * Stat value is always neutral ink.
   *
   * `stripNote` goes in the sub-line too, and when it is there the liquidation
   * price is dropped: at or below HF 1.00 that price IS today's price, so the
   * clause is the only half of the line carrying anything.
   */
  const watchCollateralValue = collateralAmount * assetPrice;
  const watchOutlook = liquidationOutlook(
    positionState.healthFactor,
    activeMarket.collateralAsset,
  );
  // Guarded because the collateral slider goes to 0 and `borrowUsd / 0` rendered
  // "Infinity%".
  const watchLtvPct =
    watchCollateralValue > 0 ? Math.round((borrowUsd / watchCollateralValue) * 100) : null;
  const watchMaxLtvPct = activeMarket.protocol === "Aave V3" ? 82 : 78;
  const watchLiqPrice = positionState.liquidationPrice;
  const watchDropSub = [
    positionState.healthFactor === null
      ? null
      : `Health factor ${positionState.healthFactor.toFixed(2)}`,
    watchOutlook.stripNote,
    watchOutlook.stripNote === null && watchLiqPrice > 0
      ? `${activeMarket.collateralAsset} at ${formatCurrency(watchLiqPrice)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // LIVE chain telemetry: real Base gas price via the API (the previous
  // random-walk simulation is gone). The block number arrives on the same poll
  // and is deliberately not stored: nothing renders it.
  useEffect(() => {
    if (chainTel.gasGwei !== null) {
      setGasPrice(+chainTel.gasGwei.toFixed(4));
    }
  }, [chainTel.gasGwei]);

  // Custom simulation handlers for Watch Cockpit
  const handleSimulateCollateralInflow = () => {
    setCollateralAmount(+(collateralAmount * 1.5).toFixed(2));
  };

  const handleSimulateFlashRepay = () => {
    setBorrowAmount(+(borrowAmount * 0.5).toFixed(2));
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

    {/* `w-full`, not `w-screen`: `100vw` includes the classic scrollbar gutter,
        so `w-screen` is itself a source of the horizontal overflow this shell
        then has to hide. Column on a phone so the tab bar can sit at the
        bottom; row on desktop so the sidebar sits alongside. */}
    <div className="flex flex-col md:flex-row h-screen w-full overflow-hidden bg-surface-base text-text-primary font-sans antialiased text-sm">

      {/* 1. LEFT SIDEBAR PANEL (exactly modeled after the Figma UI) */}
      {isDesktop && (
      <aside className="w-64 h-full shrink-0 flex flex-col justify-between border-r border-border-subtle bg-surface-base p-6 z-30">

        {/* Sidebar Header Brand block */}
        <div className="space-y-8">
          <div className="flex items-center gap-2.5">
            <img src="/panik-logo.png" alt="PANIK" width={32} height={32} style={{ objectFit: "contain" }} />
            <div className="flex flex-col">
              <span className="font-sans font-extrabold text-lg text-text-primary leading-none">PANIK</span>
              <span className="text-2xs font-sans text-text-muted mt-0.5">Risk intelligence</span>
            </div>
          </div>

          <NavTabs
            variant="sidebar"
            activeTab={activeTab}
            onSelect={setActiveTab}
            tabRefs={tabRefs}
            onKeyDown={onTabKeyDown}
          />
        </div>

        {/* Sidebar Footer Bottom exit button */}
        <div className="space-y-4">
          <a
            href="/"
            className="flex items-center gap-2 text-xs font-sans text-text-secondary hover:text-text-primary transition-colors cursor-pointer pt-2 group"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-text-muted group-hover:-translate-x-0.5 transition-transform" />
            <span>Back to landing</span>
          </a>
        </div>
      </aside>
      )}

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-surface-base relative">
        
        {/* TOP STATUS BAR (Gas feeds, Block Number precisely simulating real active smart contracts) */}
        <header className="h-16 shrink-0 border-b border-border-subtle px-4 md:px-8 flex items-center justify-between gap-3 bg-surface-raised/40 backdrop-blur-md">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Brand, phone only. The sidebar carries it on desktop, and with
                the sidebar gone the app had neither a mark nor any way back to
                the landing page. One element does both jobs. */}
            <a
              href="/"
              title="Back to landing"
              className="md:hidden flex items-center gap-2 shrink-0"
            >
              <img src="/panik-logo.png" alt="" width={24} height={24} style={{ objectFit: "contain" }} />
              <span className="font-sans font-extrabold text-sm text-text-primary leading-none">PANIK</span>
            </a>

            {/* The user-segment badge ("Risk Optimizer", "Yield Seeker", …)
                used to sit here. It is gone.

                It was the onboarding quiz's segment output, and it drove
                nothing: no threshold, no recommendation, no filter, no copy.
                Grepping it finds a localStorage write, a backfill into the
                per-wallet profile store, and this badge — and a chip whose only
                job is to be looked at is a chip that answers "what is this
                supposed to be?" with "nothing you can act on". The value is
                still computed and still persisted, so the day something
                actually consumes a segment it is there; it just no longer
                occupies the top-left of every screen claiming to matter.

                The RISK TIER stays, because it does drive things — it is what
                the alert thresholds and every position's `profileStatus` are
                measured against. But it has to say so. A bare word in a box is
                exactly as unexplained as the one above it was, so it now
                carries an InfoTip naming what it changes, and it is a BUTTON:
                the profile is set by the onboarding quiz, so the chip that
                names it is the control that reopens it. */}
            {riskTier && (
              <span className={`flex shrink-0 items-center gap-1.5 px-2.5 py-1 rounded-md border text-2xs font-sans font-bold ${TIER_BADGE}`}>
                <button
                  type="button"
                  onClick={() => setShowOnboarding(true)}
                  title="Change your risk profile"
                  className="cursor-pointer hover:text-text-primary transition-colors"
                >
                  {RISK_TIER_LABELS[riskTier]}
                </button>
                <InfoTip
                  text={`Your risk profile, from the onboarding questions. It sets the limit each position is measured against, so it decides which positions read as "over your risk limit" and when PANIK alerts you. Click it to retake the questions.`}
                />
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 md:gap-6 min-w-0 text-2xs font-sans text-text-muted">
            <div className="hidden md:flex items-center gap-1.5">
              <span>Est. gas</span>
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
              className="flex min-w-0 items-center gap-2 px-3 py-2 md:py-1.5 rounded-md bg-white/[0.02] hover:bg-white/[0.06] border border-border-subtle text-2xs font-semibold text-text-secondary transition-colors cursor-pointer group"
            >
              {/* Identifier, not an action and not a status: the whole chip
                  stays neutral so the eye skips it on the way to the data. */}
              <Wallet className="w-3.5 h-3.5 shrink-0 text-text-muted" />
              {/* The label is the only elastic thing in the header, so it is
                  the only thing allowed to give: "Registry (12 wallets)" must
                  not be able to push the refresh glyph off a 390px screen. */}
              <span className="truncate">
                {selectedWallet && selectedWallet !== "all"
                  ? truncateAddress(selectedWallet)
                  : selectedWallet === "all"
                    ? `Registry (${wallets.length} wallets)`
                    : "Connect wallet"}
              </span>
              <RefreshCw className="w-3 h-3 shrink-0 text-text-muted group-hover:text-text-primary transition-colors" />
            </button>
          </div>
        </header>

        {/* PAGE VIEWS SWITCH */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <AnimatePresence mode="wait">
            
            {/* VIEW A: COMPASS TAB (Fully interactive and identical to the requested design layout!) */}
            {activeTab === "compass" && (
              <TabPanel key="compass" tab="compass" gap="space-y-8">
                {/* No subtitle. "Find and open positions matched to your risk
                    profile" restated the tab you are standing in, the heading
                    above it and the section heading below it, which already
                    names the profile by name. Portfolio's header is an h1 and a
                    button; this one is an h1 and the control that changes what
                    the page shows. */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border-subtle pb-5">
                  <h1 className="text-2xl font-sans font-extrabold tracking-tight text-text-primary">Compass</h1>

                  {/* Three copies of one button became a map over the three
                      profiles, so the selected/unselected treatment cannot
                      drift between them. */}
                  <div className="bg-white/[0.02] border border-border-subtle p-1 rounded-md flex items-center max-w-sm">
                    {RISK_PROFILES.map((profile) => (
                      <button
                        key={profile}
                        onClick={() => setSelectedRiskProfile(profile)}
                        className={`px-3 py-1.5 text-2xs font-sans rounded-md capitalize transition-all cursor-pointer ${
                          selectedRiskProfile === profile
                            ? "bg-white/10 text-text-primary font-bold border border-border-subtle"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        {profile}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Three across at `xl`. Two columns left a permanent orphan:
                    an odd count is the normal case here (three recommended and
                    five outside at the moderate profile), and at two wide the
                    stray card sat alone beside half a row of void. The cards
                    are five elements tall now rather than nine, so three fit
                    the 1120px content column without crushing anything.

                    `lg`, not `md`: at a 768px window the sidebar has already
                    taken 256px, so two columns there were 208px each, which is
                    narrower than "Compound V3" plus its risk chip. */}
                {recommended.length > 0 && (
                  <div className="space-y-4">
                    <h2 className="text-base font-sans font-bold text-text-primary tracking-wide">
                      Recommended for your {selectedRiskProfile} profile
                    </h2>
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
                      {recommended.map((preset) => (
                        <MarketCard
                          key={preset.id}
                          preset={preset}
                          poolYield={poolYields?.[preset.id] ?? null}
                          onBreakdown={() => setSelectedRiskBreakdownPreset(preset)}
                          onOpen={() => setOpenPositionPreset(preset)}
                          onSimulate={() => {
                            setSelectedPresetId(preset.id);
                            setWatchSource("recommendations");
                            setActiveTab("watch");
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Outside the profile's limits. The per-card "Outside safety
                    triggers" caption is gone: it restated this heading eight
                    words later, once per card, and no card without it is any
                    less clearly filed under it. No primary action here either,
                    which is the part that actually says "not recommended". */}
                {outside.length > 0 && (
                  <div className="space-y-4 pt-4">
                    <h2 className="text-base font-sans font-bold text-text-secondary tracking-wide">
                      Outside your profile
                    </h2>
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
                      {outside.map((preset) => (
                        <MarketCard
                          key={preset.id}
                          preset={preset}
                          poolYield={poolYields?.[preset.id] ?? null}
                          muted
                          onBreakdown={() => setSelectedRiskBreakdownPreset(preset)}
                          onSimulate={() => {
                            setSelectedPresetId(preset.id);
                            setWatchSource("recommendations");
                            setActiveTab("watch");
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

              </TabPanel>
            )}

            {/* VIEW B: WATCH TAB (The high-fidelity mathematical simulator control cockpit!) */}
            {activeTab === "watch" && (
              <TabPanel key="watch" tab="watch">
                {/* Source toggle. Business requirement: Watch mirrors the
                    positions this wallet actually holds on-chain (Current
                    Positions). Recommendations keeps the Compass-derived
                    what-if sandbox for markets you could open. */}
                <div className="flex items-center gap-1 p-1 bg-black/30 border border-border-subtle rounded-md w-max">
                  {([
                    { key: "positions", label: "Current positions", count: watchPositionMarkets.length as number | null },
                    { key: "recommendations", label: "Recommendations", count: null as number | null },
                  ] as const).map((opt) => {
                    const active = watchSource === opt.key;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => setWatchSource(opt.key)}
                        aria-pressed={active}
                        className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-2xs font-sans font-bold transition-all cursor-pointer ${
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
                  /* Positions mode with nothing on-chain. `clear`, not
                     `problem`: we read the wallet successfully and it genuinely
                     holds nothing — the same distinction Portfolio's empty
                     wallet makes. One affordance, per the primitive's contract;
                     the source toggle directly above already offers the other
                     one. */
                  <EmptyState
                    tone="clear"
                    title="No open positions to watch"
                    hint="Watch mirrors what this wallet holds on-chain. Open a position and it appears here, preloaded into the simulator with your real collateral and debt."
                    action={
                      <Button onClick={() => setActiveTab("compass")}>
                        <Plus className="h-3.5 w-3.5" />
                        Open position
                      </Button>
                    }
                  />
                ) : (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
                {/* Splits at `xl`, not `lg`. At a 1024px window this grid has
                    704px to work with once the sidebar and page padding are
                    paid for, so a 4/12 rail came out 224px, narrower than its
                    own parameter labels, which then clipped. The rail wants
                    ~300px to hold "Collateral deposited (wstETH):" beside its
                    input. */}
                {/* Simulator Area (xl:col-span-8) */}
                <div className="col-span-1 xl:col-span-8 space-y-6">
                  
                  {/* The simulator's summary, as ONE card. Three depths of
                      container around one subject read as three separate
                      subjects; `Card` has exactly two depths, on purpose. */}
                  <Card tone="raised">
                    {/* Wraps on a phone: side by side, the market name took
                        three lines while the action next to it took three of
                        its own, and neither was readable. Stacked, each gets
                        the full width for one line. */}
                    <div className="flex flex-wrap justify-between items-center gap-3 mb-5 border-b border-border-subtle pb-3">
                      {/* Market selector - mode-aware. Positions mode lists the
                          wallet's real on-chain positions; Recommendations lists
                          the Compass preset catalog. */}
                      <div className="relative" ref={watchDropRef}>
                        {/* Sentence case, and two words. The uppercase
                            letter-spaced style was retired everywhere else in
                            the app, and "SCORED ON-CHAIN" was provenance the
                            risk index's own InfoTip states properly. */}
                        <span className="block text-2xs font-sans text-text-muted mb-1">
                          {watchingOwnPosition ? "Your position" : "Simulated market"}
                        </span>
                        <button
                          id="watch-market-selector"
                          onClick={() => setWatchDropOpen(v => !v)}
                          className="group flex items-center gap-2 cursor-pointer"
                          aria-haspopup="listbox"
                          aria-expanded={watchDropOpen}
                        >
                          <h2 className="text-lg font-sans font-extrabold text-text-primary tracking-wide group-hover:text-text-muted transition-colors">
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
                                          <span className="block text-2xs font-sans text-text-muted">{preset.protocol}</span>
                                          <span className={`block text-sm font-sans font-semibold truncate tabular-nums ${
                                            isActive ? "text-text-primary" : "text-text-secondary"
                                          }`}>{preset.collateralSymbol} · {position.collateralValueUsd === null ? "size unavailable (prices degraded)" : `${formatCurrency(position.collateralValueUsd)} supplied`}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <RiskChip band={preset.riskStatus}>{preset.riskStatus}</RiskChip>
                                          <span className="text-2xs font-sans text-text-muted tabular-nums">{preset.baseRisk}</span>
                                        </div>
                                      </li>
                                    );
                                  })
                                : presetsWithLive.map((p) => {
                                    const isActive = p.id === selectedPresetId;
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
                                          <span className="block text-2xs font-sans text-text-muted">{p.protocol}</span>
                                          <span className={`block text-sm font-sans font-semibold truncate ${
                                            isActive ? "text-text-primary" : "text-text-secondary"
                                          }`}>{p.assetPair}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <RiskChip band={p.riskStatus}>{p.riskStatus}</RiskChip>
                                          <span className="text-2xs font-sans text-text-muted tabular-nums">{p.baseRisk}</span>
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
                        <Button onClick={() => setOpenPositionPreset(activeMarket)} className="shrink-0">
                          <Plus className="h-3.5 w-3.5" />
                          Open position
                        </Button>
                        {!liveWatch && (
                          <span className="text-2xs font-sans text-text-muted bg-white/[0.04] px-2.5 py-0.5 rounded-sm border border-border-subtle flex items-center font-bold">
                            Demo
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Score on the left, its four components on the right.

                        The split is `xl`, not `md`: a Tailwind breakpoint
                        measures the WINDOW, and this block sits inside window
                        minus a 256px sidebar minus the 8/12 simulator column, so
                        at 768px it has ~408px and splitting it there crushed the
                        driver bars to 62px. Everything inside is stepped a
                        breakpoint or two late for the same reason. */}
                    <div className="flex flex-col xl:flex-row gap-6 text-left">
                      {/* Normal flow, not `justify-between`: this column is three
                          short lines, and stretching them to the height of the
                          four bars beside them left a hole in the card. */}
                      <div className="flex-1 xl:max-w-[280px]">
                        <div>
                          {/* No icon. Portfolio's stat labels carry none, and a
                              generic pulse glyph beside the words "risk index"
                              adds no information the words are missing. */}
                          <div className="flex items-center gap-1 text-text-muted font-sans text-2xs mb-2">
                            <span>Risk index</span>
                            <InfoTip text="0-100 composite of position health, asset risk, protocol safety, and market stress. Higher means closer to liquidation; your risk profile sets where alerts fire." />
                          </div>

                          <div className="flex items-baseline gap-2 mb-2">
                            {/* Neutral ink, like every other figure in the
                                product. A 40px saturated numeral is the loudest
                                thing a dashboard can emit, and it was saying in
                                the same hue what the chip beside it says. The
                                chip is the band. */}
                            <span className="text-4xl font-sans font-black tracking-tight tabular-nums text-text-primary">
                              {positionState.riskScore}
                            </span>
                            <span className="text-xs font-sans text-text-muted tabular-nums">/ 100</span>

                            {/* Beside the figure, not `ml-auto`. Below `xl`
                                this column is the full card width, and pushing
                                the band to the far edge left 600px of nothing
                                between a score and the word that reads it. */}
                            <RiskChip band={positionState.status} className="ml-1">
                              {positionState.status === "CRITICAL" ? "CRITICAL THREAT" :
                               positionState.status === "HIGH" ? "HIGH RISK" :
                               positionState.status === "ELEVATED" ? "ELEVATED" : "LOW RISK"}
                            </RiskChip>
                          </div>
                        </div>

                        {/* Plain language summary & trend indicators */}
                        <div className="mt-3 pt-3 border-t border-border-subtle space-y-2.5">
                          {/* Absent when the simulation sits on the real numbers:
                              there is then no delta, and a zero dressed up as a
                              trend is a movement that did not happen. Neutral ink
                              — the arrow says the direction, and the chip six
                              pixels above already says the band. */}
                          {scoreDelta !== 0 && (
                            <p className="flex items-center gap-1 font-sans text-2xs text-text-secondary tabular-nums">
                              {scoreDelta > 0 ? (
                                <ArrowUp className="w-3 h-3 shrink-0" aria-hidden="true" />
                              ) : (
                                <ArrowDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                              )}
                              {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta} vs{" "}
                              {watchingOwnPosition ? "your position" : "this market"} now
                            </p>
                          )}

                          <p className="text-2xs text-text-secondary leading-relaxed font-sans">
                            {/* One clause each: a verdict that needs two
                                sentences is not a verdict, and the brochure
                                language that used to wrap these read as
                                reassurance we had not measured. */}
                            {positionState.status === "CRITICAL" && "Spot price is close to your liquidation benchmark."}
                            {positionState.status === "HIGH" && "Leverage is high. Repay or add collateral."}
                            {positionState.status === "ELEVATED" && "Stable, but exposed to short-term volatility."}
                            {positionState.status === "LOW" && "Collateral buffer is comfortable."}
                          </p>
                        </div>
                      </div>

                      {/* Right: Top Risk Drivers section */}
                      <div className="flex-1 min-w-0 border-t xl:border-t-0 xl:border-l border-border-subtle pt-4 xl:pt-0 xl:pl-6 space-y-4">
                        <span className="block text-2xs font-sans text-text-muted select-none">
                          Score breakdown
                        </span>

                        {/* One row per driver, from RISK_DRIVERS. These were four
                            copies of the same twelve lines, which is how three
                            ended up with a hand-typed colour and one with a
                            number the engine never produced. */}
                        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-x-6 gap-y-4">
                          {RISK_DRIVERS.map((driver) => {
                            const { label, hint, of } = driver;
                            const value = of(positionState.breakdown);
                            return (
                              <div key={label} className="space-y-1.5">
                                <div className="flex justify-between items-center text-2xs font-sans">
                                  <span className="text-text-secondary flex items-center gap-1">
                                    {label}
                                    <InfoTip
                                      text={`${hint} ${driverWeightPct(driver)}% of the score.`}
                                    />
                                  </span>
                                  <span className="font-bold tabular-nums text-text-primary">
                                    {value}%
                                  </span>
                                </div>
                                {/* Neutral fill; the bar LENGTH is the channel.
                                    These four are the parts of one score, not
                                    four verdicts, and the composite has already
                                    been banded once by the chip. `RiskDial` lists
                                    the same four with no hue either. */}
                                <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden relative">
                                  <div
                                    className="h-full rounded-full bg-text-secondary transition-all duration-300"
                                    style={{ width: `${value}%` }}
                                  ></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </Card>

                  {/* The two core numbers, in the app's stat tile. Liquidation
                      distance leads, because the sliders move collateral, price
                      and debt — the health factor is an OUTPUT here as it is
                      everywhere else, and it is the one figure on this screen a
                      non-expert cannot read. Values and sub-lines come from
                      `watchOutlook` beside `scoreDelta`.

                      NO DEBT replaces both tiles with one line rather than
                      printing "LOAN TO VALUE 0%". A position with nothing
                      borrowed has no loan-to-value and no liquidation distance,
                      and a 24px zero is the same lie as a "$0" standing in for an
                      unknown price. It reads the borrowed amount rather than the
                      health factor because the offline fallback formula has no
                      null to offer. */}
                  {borrowUsd <= 0 ? (
                    <EmptyState
                      tone="clear"
                      title="No debt on this position"
                      hint={`Nothing is borrowed against your ${activeMarket.collateralAsset}, so there is nothing to liquidate. Raise the borrowed amount to simulate one.`}
                    />
                  ) : (
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Drop to liquidation
                              <InfoTip text={watchOutlook.hover} />
                            </>
                          }
                          value={watchOutlook.strip}
                          sub={watchDropSub}
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Loan to value
                              <InfoTip text="Debt as a share of your collateral's value. The closer this gets to the protocol's maximum, the smaller your cushion before liquidation." />
                            </>
                          }
                          value={watchLtvPct === null ? "No collateral" : `${watchLtvPct}%`}
                          sub={`${activeMarket.protocol} liquidates above ${watchMaxLtvPct}%`}
                        />
                      </Card>
                    </div>
                  )}

                </div>

                {/* Automation triggers & Telemetry feed column (xl:col-span-4) */}
                <div className="col-span-1 xl:col-span-4 space-y-6">
                  
                  {/* Scenario presets (#3): the answer first, sliders second.
                      Same `Card` as everything else on this tab now — it was a
                      hand-typed copy of the raised tone that had drifted to
                      p-6. */}
                  <Card tone="raised" className="space-y-3">
                    <span className="flex items-center gap-1 text-2xs font-sans text-text-muted border-b border-border-subtle pb-2">
                      Price scenarios
                      <InfoTip text="Crash and black-swan magnitudes mirror the backtest event set. The HF preview on each card is an estimate; the headline score uses the live engine." />
                    </span>
                    {/* A same-asset market gets the reason instead of the chips.
                        Run against USDC collateral and USDC debt, the four
                        scenarios were reporting "black swan -55%, HF ~1.48",
                        which reads as "you survive USDC going to zero": the
                        chips move the collateral price alone, and on this market
                        that is not a crash, it is a depeg between two legs of the
                        same asset. Stating why is the only version that is true;
                        deleting the panel would leave the market looking
                        unfinished, and re-labelling the chips would keep a
                        magnitude nobody can act on. */}
                    {sameAssetMarket ? (
                      <p className="text-xs font-sans text-text-secondary leading-relaxed">
                        Collateral and debt are both {activeMarket.collateralAsset} here, so a move in
                        its price rescales the two sides together and your distance to liquidation
                        stays where it is. Set the two price controls below apart to simulate the
                        move that does change it, a depeg between what you supplied and what you owe.
                      </p>
                    ) : (
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
                              <span className={`text-2xs font-sans font-bold ${active ? "text-text-primary" : "text-text-secondary"}`}>
                                {s.label}
                              </span>
                              {/* The scenario's magnitude, not a measurement
                                  of anything. It defines which button this is
                                  ("Crash" is -40%), so it reads as a label and
                                  is inked like one. Painting it risk-critical
                                  put three permanent red figures on the page
                                  that would say -20/-40/-55 for a debt-free
                                  position in no danger at all. */}
                              {s.pct !== 0 && (
                                <span className="text-2xs font-sans text-text-muted tabular-nums">{Math.round(s.pct * 100)}%</span>
                              )}
                            </div>
                            <span className="block text-2xs font-sans text-text-secondary mt-1 tabular-nums">
                              {formatCurrency(price)}
                              {borrowUsd > 0 && (
                                /* Colour survives on ONE branch. "Liquidated"
                                   is a verdict — this scenario ends the
                                   position — and it is the only thing in this
                                   panel that is. The HF preview beside it is a
                                   reading, so it is inked as one; it used to
                                   run its own green/amber/red ramp cut at 1.3,
                                   a fourth set of thresholds on a screen that
                                   already had three. */
                                /* Leading space, not just the margin: without
                                   it the accessible text of this line is
                                   "$1,667HF ~1.20". */
                                <span className={`ml-1.5 font-bold tabular-nums ${liquidated ? "text-risk-critical" : "text-text-primary"}`}>
                                  {" "}
                                  {liquidated ? "Liquidated" : `HF ~${estHf.toFixed(2)}`}
                                </span>
                              )}
                            </span>
                            <span className="block text-2xs font-sans text-text-muted mt-0.5">{s.note}</span>
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </Card>

                  {/* Advanced parameters (#4): direct inputs for amounts + prices */}
                  <Card tone="raised" className="space-y-4">
                    <span className="text-2xs font-sans text-text-muted block border-b border-border-subtle pb-2">
                      Adjust the position
                    </span>

                    {/* Collateral amount */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Collateral ({activeMarket.collateralAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultCollateral < 10 ? 0.1 : 100}
                          value={collateralAmount}
                          onChange={(e) => setCollateralAmount(Math.max(0, Number(e.target.value)))}
                          className="w-24 shrink-0 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-text-primary text-xs font-sans focus:border-border-strong tabular-nums"
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
                      <div className="flex justify-between text-xs font-sans text-text-muted">
                        <span>0</span>
                        <span>2.5x, worth {formatCurrency(collateralAmount * assetPrice)}</span>
                      </div>
                    </div>

                    {/* Collateral price. Named for the LEG, not the asset: on a
                        USDC-collateral, USDC-debt market "USDC price" was the
                        label on both this control and the debt one below, two
                        sliders reading the same words and driving different
                        halves of the position. The leg is what tells them apart,
                        and it is also what the amount rows above are named for. */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Collateral price ({activeMarket.collateralAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultPrice < 10 ? 0.01 : 10}
                          value={assetPrice}
                          onChange={(e) => {
                            setAssetPrice(Math.max(0, Number(e.target.value)));
                            setActiveScenario("custom");
                          }}
                          /* Neutral. These three inputs used to repaint
                             themselves red or amber once the value passed an
                             arbitrary distance from the preset — a number the
                             USER typed, styled as a risk band. What a
                             simulated price means for this position is the
                             score, the chip and the drop tile's job; the input
                             is a control. */
                          className="w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-sans text-text-primary focus:border-border-strong tabular-nums"
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
                      <div className="flex justify-between text-xs font-sans text-text-muted">
                        <span>-60% ({formatCurrency(activeMarket.defaultPrice * 0.4)})</span>
                        <span>+30% ({formatCurrency(activeMarket.defaultPrice * 1.3)})</span>
                      </div>
                    </div>

                    {/* Borrowed amount */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Borrowed ({activeMarket.debtAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultBorrow < 10 ? 0.1 : 50}
                          value={borrowAmount}
                          onChange={(e) => setBorrowAmount(Math.max(0, Number(e.target.value)))}
                          className="w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-sans text-text-primary focus:border-border-strong tabular-nums"
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
                      <div className="flex justify-between text-xs font-sans text-text-muted">
                        <span>0</span>
                        <span>+60% debt</span>
                      </div>
                    </div>

                    {/* Borrowed asset price (depeg scenarios) */}
                    <div className="space-y-1.5 bg-white/[0.01] hover:bg-white/[0.03] p-3 rounded-md border border-border-subtle transition-colors">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Borrowed price ({activeMarket.debtAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={0.005}
                          value={debtPrice}
                          onChange={(e) => setDebtPrice(Math.max(0, Number(e.target.value)))}
                          className="w-24 bg-black/40 border border-border-strong rounded-sm px-2 py-0.5 text-right text-xs font-sans text-text-primary focus:border-border-strong tabular-nums"
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
                      <div className="flex justify-between text-xs font-sans text-text-muted">
                        <span title="USDC fell to $0.87 during the SVB weekend in March 2023." className="cursor-help">$0.85 depeg</span>
                        <span>$1.05 premium</span>
                      </div>
                    </div>
                  </Card>

                </div>

                </div>
                )}

              </TabPanel>
            )}

            {/* VIEW C: ADVISOR TAB (Autonomous Alert Rules Configuration & Diagnosing Engine) */}
            {activeTab === "advisor" && (
              <TabPanel key="advisor" tab="advisor">
                <div className="border-b border-border-subtle pb-5">
                  <h1 className="text-2xl font-sans font-extrabold tracking-tight text-text-primary">AI Advisor</h1>
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
                  
                  <h3 className="text-lg font-sans font-bold text-text-primary tracking-tight mb-3">
                    Advisor is not live yet
                  </h3>

                  <p className="text-sm text-text-secondary leading-relaxed font-sans max-w-md">
                    Guardrail recommendations and sized action plans are still in parameter audit on Base.
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
                    <span className="text-xs font-sans text-text-secondary group-hover:text-text-primary transition-colors">
                      Notify me when Advisor goes live
                    </span>
                  </label>
                </div>
                )}
              </TabPanel>
            )}

            {/* VIEW D: PORTFOLIO TAB (Aggregate Vaults Portfolio Under Protective Firewall) */}
            {activeTab === "portfolio" && (
              <TabPanel key="portfolio" tab="portfolio">
                <div className="border-b border-border-subtle pb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-sans font-extrabold tracking-tight text-text-primary">DeFi Portfolio</h1>
                  </div>
                  {/* Primary action: opening positions lives in Compass; this is
                      the pointer Portfolio was missing (UX journey fix).

                      `Plus`, from Lucide, verbatim. Every destination in the
                      sidebar pairs a glyph with its label, so the one control
                      on the page that is not a destination was also the only
                      bare word — it read as a heading rather than a button.
                      Plus is the honest glyph here because the outcome really
                      is "a position that did not exist now does"; an arrow
                      would have promised navigation and a sparkle would have
                      promised nothing at all. */}
                  <Button onClick={() => setActiveTab("compass")} className="shrink-0">
                    <Plus className="h-3.5 w-3.5" />
                    Open position
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

                {/* Wallet SELECTOR — a control, and only rendered when there is
                    something to select. In boundMode the list is exactly one
                    wallet with no "All wallets" option beside it, so the row
                    was a label and a single unclickable-in-practice pill
                    printing the same address the top bar prints two inches
                    above it. One address, stated once, in the chip that also
                    lets you change it.

                    The registry/ops view keeps the selector: there the pills
                    are a real choice between wallets and the ALL aggregate. */}
                {!boundMode && wallets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-sans text-text-muted">Wallet</span>
                    {wallets.map((w) => (
                      <button
                        key={w.wallet}
                        onClick={() => setSelectedWallet(w.wallet)}
                        title={w.label ?? w.wallet}
                        /* A hex address is the one string left in the product
                           that mono actually helps: it is scanned character by
                           character, not read as a word. */
                        className={`px-3 py-1.5 rounded-md text-xs font-mono border transition-all cursor-pointer ${
                          selectedWallet === w.wallet
                            ? "bg-white/10 text-text-primary border-border-strong font-bold"
                            : "bg-white/[0.02] text-text-secondary border-border-subtle hover:text-text-primary"
                        }`}
                      >
                        {w.wallet.slice(0, 6)}…{w.wallet.slice(-4)}
                      </button>
                    ))}
                    {/* The ALL aggregate. Its guard now lives on the wrapper. */}
                    <button
                      onClick={() => setSelectedWallet("all")}
                      className={`px-3 py-1.5 rounded-md text-xs font-sans border transition-all cursor-pointer ${
                        selectedWallet === "all"
                          ? "bg-white/10 text-text-primary border-border-strong font-bold"
                          : "bg-white/[0.02] text-text-secondary border-border-subtle hover:text-text-primary"
                      }`}
                    >
                      All wallets
                    </button>
                  </div>
                )}

                {/* Still reading the chain. A reserved block, not a figure:
                    the four cards used to print $18,450 / $9,310 / 50% / 22
                    from string literals whenever `liveMacro` was null, which is
                    exactly the window in which the code knows nothing at all. */}
                {portfolioPositions === null && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
                    {["capital", "liabilities", "protocols", "aggregate"].map((slot) => (
                      <Card key={slot} tone="raised">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="mt-2 h-8 w-32" />
                      </Card>
                    ))}
                  </div>
                )}

                {/* Nothing on this wallet could be priced. Stated once, loudly,
                    above the cards: the aggregate card is the one making a
                    safety claim and it previously carried no caveat whatsoever,
                    so the caveat that mattered most was the one the screen did
                    not have. `problem`, not `clear` — this is "we could not
                    look", which is never good news. */}
                {liveMacro && liveMacro.capital === null && (
                  <EmptyState
                    tone="problem"
                    title="Dollar amounts are unavailable for this wallet"
                    hint="A price feed PANIK converts these positions with is missing or stale, so there is no portfolio total and no combined score to show. Each position's own score and health factor below are unaffected, because they are ratios."
                  />
                )}

                {/* Macro metrics columns. Rendered only when there are real
                    positions to summarise, so every figure below comes from
                    `liveMacro` and there is no literal for it to fall back to.
                    An empty wallet gets the EmptyState above and no cards at
                    all; it used to get this row, which meant "No positions yet"
                    sat directly on top of a dashboard claiming $18,450 of
                    monitored capital. */}
                {liveMacro && (() => {
                  const aggregate = liveMacro.aggregate;
                  // Legs the engine could not price contribute nothing to the
                  // three dollar-weighted figures here, so each one is a FLOOR
                  // and not the wallet. A numeral that quietly drops a position
                  // is the failure this screen is least able to survive, so the
                  // shortfall is stated rather than left to the reader.
                  //
                  // The visible marker is one sub-line, on the capital card,
                  // and it is deliberately short: `Stat` truncates its sub to a
                  // single line, so a caveat long enough to be cut is a caveat
                  // that disappears exactly when the card gets narrow. The
                  // sentence explaining it lives in the tips, which wrap.
                  const unpriced = liveMacro.unpricedLegs;
                  const nothingPriced = liveMacro.capital === null;
                  const unpricedNote =
                    unpriced > 0 ? `${unpriced} position${unpriced === 1 ? "" : "s"} not priced` : null;
                  const unpricedHint = nothingPriced
                    ? " No position on this wallet could be priced, so there is no dollar figure to give. The scores and health factors are still exact."
                    : unpriced > 0
                      ? ` A price feed was missing for ${unpriced === 1 ? "one position" : `${unpriced} positions`}, so ${unpriced === 1 ? "it is" : "they are"} left out of this figure. The scores and health factors are still exact.`
                      : "";
                  // One rendering for "we could not measure this", in the value
                  // slot where a number would otherwise go. The treatment is
                  // `RISK_CHIP.UNKNOWN`, the same dashed unfilled grey a
                  // degraded position row uses, so the marker means the same
                  // thing everywhere: shape, icon and words, no hue, and no
                  // number standing in for a blank. Its explanation rides in
                  // the InfoTip the label already carries rather than buying a
                  // second hover on the same card.
                  const notMeasured = (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Not measured
                    </span>
                  );
                  // The verdict is carried by the WORD, not by a hue. A 28px
                  // numeral repainted red is the single loudest thing a
                  // dashboard can emit, and it was firing on a summary figure
                  // while the four per-position bands — the numbers a user can
                  // actually act on — sat in 11px chips beside it.
                  //
                  // There is no verdict for an unweighable wallet, and this is
                  // the whole point of the change: the old chain took `?? 22`
                  // and then `0` from an all-degraded wallet and read it as
                  // "Secure health status", asserting safety at the moment the
                  // data was least trustworthy.
                  const aggregateVerdict =
                    aggregate === null
                      ? "No priced positions to weigh"
                      : aggregate >= 50
                        ? "Elevated portfolio risk"
                        : aggregate >= 25
                          ? "Watch status"
                          : "Secure health status";
                  // The verdict is still carried by the WORD — the sentence
                  // stays secondary grey, and the 28px figure above it stays
                  // neutral. What the word could not do on its own is be
                  // findable: a user scanning four cards reads four grey
                  // sublines and has to parse each to learn which one is the
                  // warning. The glyph is that findability, and it is the only
                  // thing here that takes the band's hue.
                  //
                  // Absent below 25. "No icon" is the honest rendering of "no
                  // warning" — an icon that is always present and merely
                  // changes colour trains people to stop looking at it, and it
                  // would also spend a fifth risk-hued element on a page whose
                  // whole colour budget is the four position chips.
                  //
                  // Absent for an unscorable wallet too, but for the opposite
                  // reason: a band is a severity, and "we could not measure
                  // this" is not one. The `Not measured` marker in the value
                  // slot carries that state, in grey, on four non-colour axes.
                  const aggregateBand = aggregate === null ? null : bandOfScore(aggregate);
                  const aggregateAlarming = aggregateBand !== null && aggregateBand !== "LOW";
                  // 1 -> 2 -> 4. The old jump straight from 1 to 4 at `sm` gave
                  // each card ~150px at 640px wide, which is narrower than
                  // "Monitored liabilities" and narrower than the figure under
                  // it, so every card in the row ellipsised at once. Four
                  // across is only earned at `xl`.
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Monitored capital
                              <InfoTip
                                text={
                                  "Total collateral value PANIK is watching for this wallet across all protocols." +
                                  unpricedHint
                                }
                              />
                            </>
                          }
                          /* No subline when every leg is priced: the figure and
                             the label already say everything this card knows.
                             When one is not, the sub-line is the only thing
                             standing between this figure and a lie. */
                          sub={unpricedNote}
                          value={liveMacro.capital === null ? notMeasured : formatUsd(liveMacro.capital)}
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Monitored liabilities
                              <InfoTip
                                text={
                                  "Total borrowed across your positions. Net LTV is liabilities divided by capital - lower means safer." +
                                  unpricedHint
                                }
                              />
                            </>
                          }
                          value={liveMacro.debt === null ? notMeasured : formatUsd(liveMacro.debt)}
                          /* No ratio when either side of it is unknown. "Net
                             LTV ratio: 0%" was the reassuring end of the same
                             bug the aggregate card had: a wallet with no
                             readable prices reads as a wallet with no debt. */
                          sub={
                            liveMacro.ltv === null
                              ? "Net LTV ratio not measured"
                              : `Net LTV ratio: ${Math.round(liveMacro.ltv * 100)}%`
                          }
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Protocols watched
                              <InfoTip
                                text={`PANIK covers ${coveredProtocolSentence} on ${coveredChainLabel}. This wallet holds a position on ${liveMacro.protocolNames.join(", ")}; the dimmed marks are covered but empty.`}
                              />
                            </>
                          }
                          /* The card used to contradict its own label: it was
                             titled "Protocols watched", showed a POSITION
                             count, and then put the protocol count in the grey
                             subline underneath. The marks are the value now, so
                             the label matches what the figure shows - and the
                             icons name WHICH protocols, which no arrangement of
                             that sentence ever did.

                             36px, not 24px. These marks ARE this card's value,
                             and at 24px they read as decoration sitting beside
                             three siblings whose values are a 28px numeral —
                             the smallest thing in the row was the only thing in
                             the row carrying the answer. The row box grows with
                             them so all four cards still share one baseline.

                             No subline. The position count moved onto the
                             Positions card's own header, where the list that
                             the number describes actually is; stating it here
                             meant two cards counting the same array through
                             different props, which is a disagreement waiting
                             to happen. */
                          value={
                            <span className="flex h-11 items-center">
                              <ProtocolMarks
                                protocols={liveMacro.protocolNames}
                                covered={coveredProtocols}
                              />
                            </span>
                          }
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          label={
                            <>
                              Aggregate risk index
                              {/* The weighting is by collateral value, so a leg
                                  we could not price carries no weight and drops
                                  out of this average entirely. Its sub-line is
                                  spoken for by the verdict, so the caveat rides
                                  in the tip the label already carries rather
                                  than buying a second line. */}
                              <InfoTip
                                text={
                                  "Collateral-weighted average PANIK score across this wallet's positions. Bigger positions move it more." +
                                  unpricedHint
                                }
                              />
                            </>
                          }
                          value={aggregate === null ? notMeasured : `${aggregate} / 100`}
                          sub={
                            <span className="flex items-center gap-1.5">
                              {aggregateAlarming && aggregateBand !== null && (
                                <AlertTriangle
                                  className={`h-3.5 w-3.5 shrink-0 ${RISK_TEXT[aggregateBand]}`}
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate">{aggregateVerdict}</span>
                            </span>
                          }
                        />
                      </Card>
                    </div>
                  );
                })()}

                {/* ONE grid, two rows. Row 1 is Positions (7) beside the stacked
                    Asset allocation + Alert history (5); row 2 is Risk index
                    history across all 12. Both row-1 items are grid items in the
                    same row, so they end on the same line by definition, and the
                    chart is not paying for that alignment with half the width it
                    could have. The previous arrangement put the chart under
                    Positions, which made the right column's job "be as tall as
                    two cards": at a 1440 window the Alert history ran 339px past
                    the bottom of the list it sits beside, measured.

                    `lg` is the breakpoint, and it is measured on the WINDOW while
                    the split happens in the CONTENT column: at a 1024px window
                    the sidebar and padding leave 698px of content, so the 7 and 5
                    tracks measure 397px and 277px at the moment they first
                    appear. That is wide enough for a position row's three lines
                    and for a legend row's symbol-and-amount pair; `md` would have
                    split at ~442px of content and crushed both. Below `lg` the
                    three cards stack full width in DOM order.

                    The Positions wrapper is `grid` rather than `flex flex-col`
                    for one reason: a single grid child stretches to the row
                    height, so when the right column is the taller of the two the
                    Positions card grows to meet it instead of ending short with
                    its wrapper stretched around empty space. */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-4">
                  {/* Row 1, left: the position list. */}
                  <div className="lg:col-span-7 grid">
                    <LivePositions
                      positions={portfolioPositions}
                      highlightKey={highlightedPositionKey}
                      offline={boundMode ? ownLive.offline : liveOffline}
                      // Only the bound path carries a chain the API vouched
                      // for; the ops registry view claims nothing about one.
                      chain={boundMode ? ownLive.chain : null}
                      onStressTest={(pos) => {
                        // Bridge: open THIS real position in the Watch simulator.
                        setSelectedLivePositionKey(`${pos.wallet}:${pos.protocol}:${pos.scoredCollateralSymbol}`);
                        setWatchSource("positions");
                        setActiveTab("watch");
                      }}
                    />
                  </div>

                  {/* Row 1, right: the narrow pair. Alert history takes
                      `lg:flex-1` and absorbs whatever slack the position list
                      leaves — grid items already stretch to the tallest item in
                      the row, so the two columns end level at any position count,
                      with no magic number to go stale. Below `lg` the cards size
                      to their content as normal. */}
                  <div className="lg:col-span-5 flex flex-col gap-6">
                    {/* Asset allocation: the visual collateral breakdown.
                        Only when there is collateral to break down. A card that
                        renders a bar, four dots, four symbols and four dollar
                        amounts has to be describing something, and when this had
                        no positions to describe it described a wstETH/USDC/ETH/
                        USDT portfolio nobody held. The empty and loading paths
                        are covered by the states above and by the position list
                        beside it, so the honest thing here is to render nothing
                        rather than a heading over four blank rows. */}
                    {allocation.length > 0 && (
                    <Card className="space-y-6">
                      <h3 className="text-sm font-sans font-semibold text-text-primary">
                        Asset allocation
                      </h3>

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

                      {/* Asset distribution, from this wallet's live positions. */}
                      <div className="space-y-3">
                        {allocation.map((a) => (
                          <div key={a.symbol} className="flex justify-between items-center gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${a.color}`}></span>
                              {/* Row content, so 14px. An allocation legend where
                                  the symbol and the dollar amount are both 12px
                                  is a table nobody reads across. */}
                              <span className="font-sans text-sm font-medium text-text-primary truncate">
                                {a.symbol}
                              </span>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="font-sans text-sm font-bold text-text-primary tabular-nums">{formatUsd(a.usd)}</span>
                              <span className="block text-xs font-sans text-text-secondary tabular-nums">{a.pct.toFixed(1)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* A leg with no price is not in this split. Said here
                          rather than left to arithmetic, because percentages
                          that sum to 100 over a subset look exactly like
                          percentages that sum to 100 over the whole wallet. */}
                      {liveMacro && liveMacro.unpricedLegs > 0 && (
                        <p className="text-xs font-sans leading-relaxed text-text-secondary">
                          {liveMacro.unpricedLegs === 1
                            ? "One position could not be priced and is not in this split."
                            : `${liveMacro.unpricedLegs} positions could not be priced and are not in this split.`}
                        </p>
                      )}
                    </Card>
                    )}

                    {/* Alert history (watch_transitions IS the alert log).

                        `lg:flex-1 lg:min-h-0` plus an internal scroller at `lg`:
                        the card's height is set by the layout, never by how many
                        alerts exist, or a wallet with 200 transitions pushes the
                        page to nothing but alerts and the column cannot stay
                        aligned. `min-h-0` is required or a flex child refuses to
                        shrink below its content and the scroller never engages.
                        Below `lg` there is no fixed height to scroll inside, so
                        the page scrolls and paging alone reaches older rows. */}
                    <Card className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
                      <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary mb-4 shrink-0">
                        Alert history
                        <InfoTip text="Every risk-status change PANIK detected. A chip appears only when the alert did not reach you; delivered alerts stay quiet." />
                      </h3>
                      {walletHistory?.alerts?.length ? (
                        <>
                          {/* Rules, not boxes. Bordered, tinted rows inside a Card
                              that is already bordered and tinted is chrome
                              wrapping chrome; a hairline separates rows for free.

                              The list is taken OUT OF FLOW at `lg` (absolute
                              inside a relative flex-1 well) so it contributes
                              nothing to the column's intrinsic height. `flex-1`
                              and `min-h-0` alone were not enough: a flex item
                              still reports its content as its max-content
                              contribution, so the grid row grew with the feed
                              instead of the feed absorbing the row. Measured at
                              2000, "Show 4 older alerts" took the row 168px
                              taller and dragged the position list up to match,
                              handing it 168px of empty space, which is the gap
                              this whole arrangement exists to close. Out of flow,
                              the layout sets the height in both directions and
                              the scroller does the rest. Below `lg` there is no
                              fixed height to scroll inside, so the wrapper is a
                              plain block and the page scrolls. */}
                          <div className="lg:relative lg:flex-1 lg:min-h-0">
                            <div className="divide-y divide-border-subtle lg:absolute lg:inset-0 lg:overflow-y-auto">
                              {walletHistory.alerts.slice(0, alertsShown).map((a, i) => {
                                const chip = deliveryChip(a.notify_channel);
                                const protocolLabel = LIVE_PROTOCOL_LABEL[a.protocol] ?? a.protocol;
                                const event = limitEventCopy(a.to_status);
                                const when = timeAgo(a.created_at);
                                /* The position this alert is ABOUT, if the wallet
                                   still holds it. A closed position has no row to
                                   scroll to, so the alert stays a record rather than
                                   becoming a control: no button, no hover, no
                                   pointer. A control that looks live and does
                                   nothing is worse than a plain line of text. */
                                const target = alertTargets.get(a.protocol) ?? null;
                                /* The score, the band and the ORIGIN status live
                                   here rather than in the row: the band is a pure
                                   function of the score, and "approaching →
                                   outside" is a state-machine dump on the card
                                   whose job is to say what happened to someone's
                                   money. What happened is the destination. */
                                const hover = `PANIK score ${a.score} (${a.band}). ${
                                  a.from_status
                                    ? `Previously ${limitStateCopy(a.from_status)}.`
                                    : "First reading recorded for this position."
                                }${target ? "" : " This position is no longer open."}`;
                                const body = (
                                  <>
                                    {/* Wraps rather than truncates: clipping this
                                        line kept the protocol and ate the event,
                                        which is the half that says whether things
                                        got worse.

                                        14px/600 in primary ink, the same weight a
                                        position row gives its money line. The
                                        protocol and what happened to it are the
                                        content of this row, and content is not
                                        what `text-muted` and 12px are for. */}
                                    <span className="min-w-0 text-left text-sm font-sans font-semibold text-text-primary">
                                      {protocolLabel}
                                      <span className="text-text-secondary font-normal"> {event}</span>
                                      {/* The space is load-bearing: `ml-1` is
                                          margin, not whitespace, so without it a
                                          screen reader and every text scrape run the
                                          event into the chip ("risk limitQueued"). */}
                                      {chip && (
                                        <>{" "}<span className={`ml-1 inline-block align-middle text-2xs font-sans px-1.5 py-0.5 rounded-sm border ${chip.cls}`}>
                                          {chip.label}
                                        </span></>
                                      )}
                                    </span>
                                    {/* Timestamps stay muted. This is what
                                        text-muted is FOR — you glance at it, you do
                                        not read it. */}
                                    <span className="text-xs font-sans text-text-muted shrink-0 tabular-nums">{when}</span>
                                  </>
                                );
                                return target ? (
                                  /* A real <button>, not a div with onClick: it is
                                     in the tab order, Enter and Space activate it,
                                     the global :focus-visible ring applies, and the
                                     accessibility tree calls it a button because it
                                     is one. */
                                  <button
                                    type="button"
                                    key={`${a.created_at}-${i}`}
                                    onClick={() => setHighlightedPositionKey(target)}
                                    title={hover}
                                    aria-label={`${protocolLabel} ${event}${
                                      chip ? `, ${chip.label}` : ""
                                    }, ${when}. Show this position.`}
                                    className={`${ALERT_ROW_CLS} rounded-sm text-left cursor-pointer transition-colors hover:bg-white/[0.03]`}
                                  >
                                    {body}
                                  </button>
                                ) : (
                                  <div key={`${a.created_at}-${i}`} className={ALERT_ROW_CLS} title={hover}>
                                    {body}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          {alertsRemaining > 0 && (
                            /* Counts what is left rather than saying "Show more":
                               the length of a feed is what a reader cannot see,
                               and it names the page size implicitly, so nobody
                               wonders whether this expands by ten rows or ten
                               thousand. */
                            <Button
                              variant="outline"
                              className="mt-3 w-full shrink-0 justify-center"
                              onClick={() => setAlertsShown((n) => n + ALERT_PAGE_SIZE)}
                            >
                              {alertsRemaining <= ALERT_PAGE_SIZE
                                ? `Show ${alertsRemaining} older ${alertsRemaining === 1 ? "alert" : "alerts"}`
                                : `Show ${ALERT_PAGE_SIZE} more of ${alertsRemaining} older alerts`}
                            </Button>
                          )}
                        </>
                      ) : (
                        <div className="py-8 text-center text-xs font-sans text-text-secondary leading-relaxed">
                          No alerts yet - PANIK messages you the moment a position
                          <br />crosses your profile's risk limit.
                        </div>
                      )}
                    </Card>
                  </div>

                  {/* Row 2: risk index over time (score_snapshots via
                      /api/history), across all twelve columns.

                      Full width because this is the one card on the tab whose
                      readability is a function of horizontal room. At a 1440
                      window its 30 daily points had ~21px of x each in a 7-of-12
                      track; across all twelve they have ~34px, which is what
                      makes a crossing of the alert line readable as an event
                      rather than a kink. The y-domain is `riskDomain`, computed
                      from the series and the user's own alert threshold and
                      independent of the width, so the extra room lengthens the
                      line without flattening what it shows. */}
                  <Card className="lg:col-span-12">
                    <div className="flex items-baseline justify-between mb-4">
                      <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary">
                        Risk index history
                        <InfoTip text="Aggregate PANIK score of this wallet over time, protocols weighted by collateral." />
                      </h3>
                      {/* The delta, not the score. "57 / 100" is already the
                          Aggregate risk index card two rows up, and the same
                          figure printed twice reads as two metrics that happen
                          to agree. Direction over the window is the one fact
                          this card knows that the stat card cannot. */}
                      {riskHistory && riskHistory.series.length > 1 && (() => {
                        const s = riskHistory.series;
                        const delta = Math.round(s[s.length - 1] - s[0]);
                        // The WINDOW, not the interval count. 30 daily points
                        // span 29 intervals, and this header used to say "29d"
                        // beside an x-axis reading "30d ago" — two defensible
                        // numbers describing one chart, which reads as a bug.
                        // `riskHistory.xStart` counts days the same way.
                        const days = s.length;
                        return (
                          <span className="text-xs font-sans tabular-nums text-text-secondary">
                            {delta === 0
                              ? `flat over ${days}d`
                              : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} over ${days}d`}
                          </span>
                        );
                      })()}
                    </div>
                    {riskHistory ? (
                      // Series colour is cool and fixed: repainting 30 days of history in
                      // today's band colour claims the whole series was that band. The
                      // current band is already stated in the chip above.
                      // The axis is 0-100 because the SCORE is 0-100. Scaled to
                      // its own min/max the line filled the card whatever it
                      // did, and cropped out the two facts worth having: the
                      // band boundaries, and the level at which PANIK starts
                      // alerting this user. The threshold is the user's own,
                      // read from their profile, and drawn as a neutral
                      // annotation — not a fifth band colour.
                      <Sparkline
                        data={riskHistory.series}
                        /* At 220 the crossings of the alert line are legible,
                           which is the one event this chart exists to show;
                           110px was a sparkline height on a card carrying a
                           y-axis, a threshold and a caption.

                           The card is full width at every size now, so the
                           height tracks how much of it the chart can afford
                           rather than how wide the card is: 150 below `lg`,
                           where the whole page is one narrow column and 220px of
                           chart would push the tab's other cards off screen. */
                        height={isWide ? 220 : 150}
                        stroke="var(--color-chart-series)"
                        domain={riskDomain}
                        reference={{
                          value: ALERT_THRESHOLD[selectedRiskProfile],
                          label: `alert ${ALERT_THRESHOLD[selectedRiskProfile]}`,
                        }}
                        axes={{ yFormat: (v) => String(Math.round(v)), xStart: riskHistory.xStart, xEnd: "today" }}
                      />
                    ) : (
                      <div className="py-8 text-center text-xs font-sans text-text-secondary leading-relaxed">
                        History builds as the watch worker scores this wallet every 60s.
                      </div>
                    )}
                  </Card>
                </div>

              </TabPanel>
            )}

            {/* VIEW E: SETTINGS TAB (Sentry preferences + Telegram alert dispatcher) */}
            {activeTab === "settings" && (
              <TabPanel key="settings" tab="settings">
                <div className="border-b border-border-subtle pb-3">
                  <h2 className="text-lg font-sans font-extrabold text-text-primary tracking-wide">Settings</h2>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Main settings column */}
                  <div className="lg:col-span-8 space-y-6">

                    {/* Telegram alerts dispatcher (the real Connect flow) */}
                    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
                      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
                        <Bell className="w-4 h-4 text-text-primary" />
                        <h3 className="flex items-center gap-1.5 text-2xs font-sans text-text-primary font-bold">
                          Telegram alerts
                          <InfoTip text="Alerts fire only on a real transition toward liquidation: debounced, deduped and rate-limited, never on noise." />
                        </h3>
                      </div>
                      <p className="text-xs text-text-secondary leading-relaxed font-sans">
                        Get a Telegram message when this wallet nears your {selectedRiskProfile} risk limit.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-3 pt-1">
                        <div className="flex-1 h-10 px-3 flex items-center bg-surface-base/80 border border-border-subtle rounded-md font-sans text-xs truncate">
                          {telegramLink.status === "connected" ? (
                            <span className="text-risk-low flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              Connected
                            </span>
                          ) : (
                            /* States COVERAGE, not progress. This used to read
                               "Linking 0x1234...abcd", which describes a
                               handshake that has not been started and reads as
                               "something is happening" on the one screen where
                               the honest answer is "nothing is". The wallet is
                               already named in the top bar, so the words are
                               spent on the fact that matters. */
                            <span className="text-text-secondary">
                              {telegramEligible
                                ? "Not connected. No alerts are being sent"
                                : "No EVM wallet onboarded, so no alerts can be sent"}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={!telegramEligible || telegramLink.status === "requesting" || telegramLink.status === "signing"}
                          onClick={() => onboardedWallet && telegramLink.connect(onboardedWallet)}
                          className="h-10 px-4 rounded-md text-2xs font-sans font-extrabold tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-text-primary text-surface-base hover:opacity-90 cursor-pointer"
                        >
                          {telegramLink.status === "signing" ? "Sign in wallet..." :
                           telegramLink.status === "requesting" ? "Opening..." :
                           telegramLink.status === "connected" ? "Reconnect" :
                           telegramLink.status === "opened" ? "Waiting..." : "Connect Telegram"}
                        </button>
                      </div>
                      {telegramEligible && telegramLink.status !== "connected" && (
                        <p className="text-xs font-sans text-text-secondary">
                          Sign to prove wallet ownership - free, no transaction, no gas.
                        </p>
                      )}
                      {!telegramEligible && (
                        <p className="text-xs font-sans text-text-secondary">Onboard with an EVM wallet (0x...) to enable alerts.</p>
                      )}
                      {telegramLink.status === "connected" && (
                        <p className="text-xs font-sans text-risk-low">
                          Alerts are on. Send /stop in the bot anytime to pause them.
                        </p>
                      )}
                      {telegramLink.status === "opened" && (
                        <div className="space-y-1.5 pt-1.5 border-t border-border-subtle">
                          <p className="text-xs font-sans text-risk-low flex items-center">
                            Waiting for you to press Start in @{telegramBotUsername} - this confirms automatically.
                          </p>
                          <p className="text-xs font-sans text-text-secondary leading-relaxed">
                            If the link didn't open automatically, copy this command, open <strong className="text-text-primary">@{telegramBotUsername}</strong> in Telegram, and send it:
                          </p>
                          <div className="flex items-center bg-surface-base/80 border border-border-subtle rounded-sm px-2.5 py-1.5 font-sans text-xs text-risk-low select-all break-all">
                            /start {telegramLink.code}
                          </div>
                        </div>
                      )}
                      {telegramLink.status === "error" && telegramLink.error && (
                        <p className="text-xs font-sans text-risk-critical">{telegramLink.error}</p>
                      )}
                    </div>

                    {/* Standing exit permission (Phase 2.C) - grant/disclose/revoke
                        a scoped ExitPermit the user signs; the relayer that uses
                        it is Phase 4. */}
                    <DelegationManager riskProfile={selectedRiskProfile} />

                    {/* Emergency auto repayment trigger (interactive preference).
                        Hidden per business-dev QA (2026-07-03) until the
                        Deleverager ships - flip SHOW_AUTO_REPAY_CARD to restore. */}
                    {SHOW_AUTO_REPAY_CARD && (
                    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
                      <div className="flex justify-between items-center border-b border-border-subtle pb-2.5">
                        <div className="flex items-center gap-2">
                          <Sliders className="w-4 h-4 text-text-primary" />
                          <h3 className="text-2xs font-sans text-text-primary font-bold">
                            Emergency auto repayment
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
                        <div className="flex justify-between text-2xs font-sans text-text-secondary">
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

                  {/* Integration sidebar. The four-step "How to connect alerts"
                      list that used to sit above the privacy note is gone: step
                      1 described what pressing the Connect button already does,
                      step 2 is the instruction Telegram itself shows, step 3
                      restated the paragraph beside it, and step 4 restated the
                      note below. The privacy note stays — it is a data-handling
                      commitment and the only place /stop is documented. */}
                  <div className="lg:col-span-4 space-y-4">
                    <div className="p-3 bg-white/[0.02] border border-border-subtle rounded-lg font-sans text-xs text-text-secondary leading-relaxed">
                      We store only your Telegram chat id and wallet. No private keys, ever. Send /stop to disable instantly.
                    </div>
                  </div>
                </div>
              </TabPanel>
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
                      <h3 className="font-sans font-bold text-text-primary text-sm">
                        {selectedRiskBreakdownPreset.protocol} risk breakdown
                      </h3>
                      <span className="text-2xs font-sans text-text-secondary block">
                        {selectedRiskBreakdownPreset.assetPair}
                      </span>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => setSelectedRiskBreakdownPreset(null)}
                    className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary hover:text-text-primary border border-border-subtle cursor-pointer transition-colors"
                    title="Close panel"
                  >
                    <X className="w-4.5 h-4.5" />
                  </button>
                </div>

                {/* Panel Body */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  
                  {/* Scoreboard View */}
                  <div className="bg-surface-raised/40 border border-border-subtle rounded-md p-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="flex items-center gap-1.5 text-2xs font-sans text-text-muted">
                        Panik risk score
                        <InfoTip text="0-100 composite of the four weighted components below. LOW under 25, ELEVATED under 50, HIGH under 75, CRITICAL above." />
                      </span>
                      <div className="flex items-center gap-1.5">
                        {/* Live is the default and needs no badge. Only the
                            fixture case is worth calling out, because it is the
                            one the reader would otherwise get wrong. */}
                        {!breakdownData?.isLive && (
                          <span className="text-2xs font-sans px-2 py-0.5 rounded-sm border bg-white/[0.04] text-text-muted border-border-subtle">
                            DEMO
                          </span>
                        )}
                        {/* Keyed on the band this preset ALREADY carries, not
                            on a band re-derived from its number. The re-derived
                            chain had no HIGH branch, so a preset labelled HIGH
                            (50-74) was painted CRITICAL red while its own text
                            said HIGH — the word and the colour contradicting
                            each other inside one chip, in the panel whose whole
                            job is explaining what the number means. */}
                        <span className={`text-2xs font-sans font-bold px-2.5 py-0.5 rounded-sm border ${RISK_CHIP[selectedRiskBreakdownPreset.riskStatus]}`}>
                          {selectedRiskBreakdownPreset.riskStatus}
                        </span>
                      </div>
                    </div>
                    
                    <div className="flex items-baseline justify-center gap-1.5">
                      <span className="text-4xl font-sans font-bold text-text-primary tracking-tighter tabular-nums">
                        {selectedRiskBreakdownPreset.baseRisk}
                      </span>
                      <span className="text-xs font-sans text-text-muted tabular-nums">/ 100</span>
                    </div>

                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${RISK_FILL[selectedRiskBreakdownPreset.riskStatus]}`}
                        style={{ width: `${selectedRiskBreakdownPreset.baseRisk}%` }}
                      ></div>
                    </div>

                    {/* Score components: the engine's real weighted sub-scores,
                        from the same RISK_DRIVERS table Watch's breakdown reads.
                        These four cells were hand-typed labels and hand-typed
                        weights, so this panel and that one were two tables of
                        the same four rows. */}
                    {breakdownData && (
                      <div className="grid grid-cols-4 gap-2 pt-2 text-center text-xs font-sans">
                        {RISK_DRIVERS.map((driver) => (
                          <div
                            key={driver.key}
                            className="bg-white/[0.02] border border-border-subtle p-2 rounded-md"
                          >
                            <span className="flex items-center justify-center gap-1 text-2xs text-text-muted mb-0.5">
                              {driver.short} ×{driverWeightPct(driver)}%
                              <InfoTip text={driver.panelHint} />
                            </span>
                            <strong className="text-text-primary tabular-nums">
                              {breakdownData.subs[driver.key]}
                            </strong>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* TWO groups, and the split is a data-honesty requirement,
                      not a layout preference.

                      This grid used to hold twelve numbered cells of identical
                      shape: same well, same muted label, same InfoTip, same bold
                      figure. Three of them were arithmetic on hand-written
                      `VAULT_PRESETS` constants and one was arithmetic on the
                      risk score itself, and nothing on screen told them apart
                      from the engine's live readings sitting in the next cell.
                      The `DEMO` badge above does not cover them either: it is
                      keyed on whether the SCORE came back live, and a preset
                      constant is a constant in both cases.

                      So the live readings keep this heading, and the example
                      position the preview is scored against gets its own,
                      stated in words above the cells rather than left for the
                      reader to infer.

                      The 1-12 prefixes went with the split. They were the
                      spec's numbering rather than anything a reader needed, and
                      with two cells deleted and the rest regrouped there is no
                      contiguous sequence left to preserve. */}
                  <div className="space-y-3">
                    <span className="block text-2xs font-sans text-text-muted">
                      Liquidation & pool metrics
                    </span>

                    <div className="grid grid-cols-2 gap-3">
                      {/* Health factor (live engine value when available) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Health factor
                          <InfoTip text="Below 1.00 the protocol can liquidate this position. No debt means no liquidation risk." />
                        </span>
                        {breakdownData?.healthFactor == null ? (
                          <span className="text-base font-sans font-bold mt-1 text-risk-low">No debt</span>
                        ) : (
                          <span className={`text-base font-sans font-bold mt-1 tabular-nums ${RISK_TEXT[bandOfHealthFactor(breakdownData.healthFactor)]}`}>
                            {breakdownData.healthFactor.toFixed(2)}
                          </span>
                        )}
                      </div>

                      {/* Buffer to liquidation (the engine's drawdown) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Buffer to liquidation
                          <InfoTip text="How far the collateral price must fall before liquidation. Your real safety margin - the most decision-useful number here." />
                        </span>
                        <span className="text-base font-sans font-bold text-text-primary mt-1 tabular-nums">
                          {breakdownData?.bufferPct != null ? `${breakdownData.bufferPct}%` : "-"}
                        </span>
                      </div>

                      {/* Supply APY with 30d trend (DefiLlama) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Supply APY (30d)
                          <InfoTip text="What suppliers earn in this pool right now, with the last 30 days' trend." />
                        </span>
                        {breakdownData?.poolYield ? (
                          <>
                            {/* Yield is not a risk band. Green here told the
                                reader a high APY was safe, which is close to
                                the opposite of true — the same mistake the
                                Compass card had already corrected. */}
                            <span className="text-base font-sans font-bold text-text-primary mt-1 tabular-nums">
                              {breakdownData.poolYield.apy.toFixed(2)}%
                            </span>
                            <Sparkline data={breakdownData.poolYield.apySeries} stroke="var(--color-chart-series)" height={24} className="mt-1" />
                          </>
                        ) : (
                          <span className="text-base font-sans font-bold text-text-muted mt-1 tabular-nums">
                            {selectedRiskBreakdownPreset.apy.toFixed(1)}%
                          </span>
                        )}
                      </div>

                      {/* Pool TVL with 30d trend (DefiLlama) */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Pool TVL (30d)
                          <InfoTip text="Total value locked in this pool. Falling TVL can signal capital flight." />
                        </span>
                        {breakdownData?.poolYield ? (
                          <>
                            <span className="text-base font-sans font-bold text-text-primary mt-1 tabular-nums">
                              {formatCompactUsd(breakdownData.poolYield.tvlUsd)}
                            </span>
                            <Sparkline data={breakdownData.poolYield.tvlSeries} stroke="var(--color-chart-series)" height={24} className="mt-1" />
                          </>
                        ) : (
                          <span className="text-base font-sans font-bold text-text-muted mt-1">-</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* The example position, said in words. Every figure below is
                      read from this market's entry in `VAULT_PRESETS`: it is the
                      sample trade the preview is scored against, and the reader
                      does not hold it. Kept rather than deleted because the four
                      numbers are what make the score above legible - a risk
                      figure with no position attached to it explains nothing -
                      but kept UNDER a heading that says what they are. */}
                  <div className="space-y-3">
                    <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                      Example position this preview is scored on
                      <InfoTip text="PANIK previews each market against a sample position of a fixed size. These are that sample's figures, not a position you hold. Open the simulator to score your own numbers." />
                    </span>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Loan to value
                          <InfoTip text="Debt as a share of collateral value. Closer to the protocol's max means a smaller cushion." />
                        </span>
                        <span className="text-base font-sans font-bold text-text-primary mt-1 tabular-nums">
                          {Math.round((selectedRiskBreakdownPreset.defaultBorrow / (selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)) * 100)}%
                        </span>
                      </div>

                      {/* Liquidation price sits with the example, not with the
                          live readings: the drawdown is the engine's, but it is
                          applied to the example's anchor price, so the dollar
                          figure that lands on screen is only as real as the
                          sample it is multiplied against. */}
                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="flex items-center gap-1 text-2xs font-sans text-text-muted">
                          Liquidation price
                          <InfoTip text="The collateral price at which the example position becomes liquidatable." />
                        </span>
                        <span className="text-sm font-sans font-bold text-text-primary mt-1 tabular-nums">
                          {breakdownData?.liqPrice != null ? formatCurrency(breakdownData.liqPrice) : "-"}
                        </span>
                      </div>

                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-sans text-text-muted">Collateral value</span>
                        <span className="text-xs font-sans font-bold text-text-primary mt-1 truncate tabular-nums">
                          {selectedRiskBreakdownPreset.defaultCollateral} {selectedRiskBreakdownPreset.collateralAsset} ({formatCurrency(selectedRiskBreakdownPreset.defaultCollateral * selectedRiskBreakdownPreset.defaultPrice)})
                        </span>
                      </div>

                      <div className="bg-surface-sunken/65 border border-border-subtle p-3 rounded-md flex flex-col justify-between">
                        <span className="text-2xs font-sans text-text-muted">Borrowed amount</span>
                        <span className="text-xs font-sans font-bold text-text-primary mt-1 truncate tabular-nums">
                          {selectedRiskBreakdownPreset.defaultBorrow} {selectedRiskBreakdownPreset.debtAsset}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Dimension 8, 9, 10: Risk Signals */}
                  <div className="space-y-3.5">
                    <span className="block text-2xs font-sans text-text-muted">
                      Risk signals & drivers
                    </span>

                    <div className="space-y-2 text-xs font-sans">
                      {/* Protocol signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted mb-1 font-bold">Protocol security signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.protocol === "Aave V3" && "Aave V3 safety module is funded and active. Dynamic interest-rate curves and isolation mode in place. Governance secured by multi-sig and timelock."}
                          {selectedRiskBreakdownPreset.protocol === "Moonwell" && "Moonwell markets run on Base with a 48-hour governance timelock on system parameters. Collateral factors monitored continuously."}
                          {selectedRiskBreakdownPreset.protocol === "Morpho" && "Morpho Blue markets are isolated and immutable. Oracle and LLTV are fixed at market creation, so live parameters cannot be changed by governance."}
                          {selectedRiskBreakdownPreset.protocol === "Compound V3" && "Compound III (Comet) isolates a single borrowable asset against monitored collateral. Parameter changes pass a governance timelock."}
                        </p>
                      </div>

                      {/* The "Pool liquidity signal" that stood here is deleted.
                          It was one hardcoded sentence, identical for every
                          preset, protocol and market: $82,000,000 of depth,
                          a 0.15% depth buffer, and "No oracle drift" - a live
                          safety claim about an oracle nothing in this codebase
                          checks. Pool TVL above is the real depth reading and it
                          comes from DefiLlama. ("vault lines", the phrase this
                          sentence used, is the same non-referring jargon
                          DESIGN_SYSTEM records deleting once already.) */}

                      {/* Position signals */}
                      <div className="bg-white/[0.01] border border-border-subtle p-3 rounded-md leading-relaxed">
                        <span className="block text-2xs text-text-muted mb-1 font-bold">Position watch signal</span>
                        <p className="text-text-secondary">
                          {selectedRiskBreakdownPreset.baseRisk < 20 
                            ? "Position health maintains normal volatility parameters. No automated hedges currently required."
                            /* "before the health factor approaches 1.25" was
                               the same ratio-nobody-reads problem as the
                               position rows, and in prose rather than in a
                               labelled cell where it at least had an InfoTip
                               beside it. 1.25 IS a 20% cushion (1 - 1/1.25),
                               so this is the same threshold said in the unit
                               the user can check against a price chart. */
                            : "Position health has entered an elevated stress range. Consider reducing leverage or adding collateral while the collateral can still fall 20% before liquidation."
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
                    className="flex-1 py-3 text-center text-xs font-sans text-text-secondary bg-white/5 hover:bg-white/10 rounded-md cursor-pointer transition-colors border border-border-subtle"
                  >
                    Close panel
                  </button>
                  <button
                    onClick={() => {
                      setSelectedPresetId(selectedRiskBreakdownPreset.id);
                      setWatchSource("recommendations");
                      setActiveTab("watch");
                      setSelectedRiskBreakdownPreset(null);
                    }}
                    className="flex-1 py-3 text-center text-xs font-sans font-bold text-text-primary bg-white/[0.06] border border-border-subtle rounded-md cursor-pointer hover:bg-white/10 transition-all"
                  >
                    Open simulator
                  </button>
                  <button
                    onClick={() => setOpenPositionPreset(selectedRiskBreakdownPreset)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-3 text-center text-xs font-sans font-bold text-surface-base bg-text-primary rounded-md cursor-pointer hover:opacity-90 transition-all shadow-lg"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Open position
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

      </div>

      {/* 3. MOBILE NAV — a bottom tab bar, not a drawer.
          Five flat, equal-weight sections that a user switches between
          constantly is the exact shape a tab bar is for: every destination
          stays one thumb-tap away and visibly labelled, and there is no
          open/close state, no focus trap and no scroll lock to get wrong. A
          hamburger drawer would hide five items behind a sixth control, cost
          two taps per switch, and hide which section you are in — which is the
          one thing the nav exists to answer. It also sits last in the DOM,
          matching its position on screen, so focus order tracks reading order.
          `env(safe-area-inset-bottom)` keeps it clear of the home indicator. */}
      {!isDesktop && (
        <div
          className="shrink-0 border-t border-border-subtle bg-surface-base z-30"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <NavTabs
            variant="bar"
            activeTab={activeTab}
            onSelect={setActiveTab}
            tabRefs={tabRefs}
            onKeyDown={onTabKeyDown}
          />
        </div>
      )}

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
              <p className="text-xs font-sans font-bold text-risk-critical">
                Alerts inactive
              </p>
              <p className="text-2xs text-text-secondary mt-0.5">
                {monitoringError} Verify wallet ownership to enable liquidation alerts.
              </p>
            </div>
            <button
              onClick={retryMonitoring}
              disabled={monitoringBusy}
              className="shrink-0 px-3 py-1.5 rounded-md bg-text-primary hover:opacity-90 disabled:opacity-50 text-2xs font-sans font-bold text-black transition-colors cursor-pointer"
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
              <span className="text-2xs font-sans text-text-primary font-bold">
                Step {currentTourStep.step} of {TOUR_STEPS.length}
              </span>
              <button onClick={dismissTour} className="text-text-muted hover:text-text-primary transition-colors text-2xs font-sans cursor-pointer">
                Skip tour
              </button>
            </div>
            <p className="text-sm font-sans font-semibold text-text-primary mb-0.5">{currentTourStep.label}</p>
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
                className="h-8 px-4 bg-text-primary hover:opacity-90 text-surface-base font-sans text-2xs rounded-md cursor-pointer transition-colors"
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
