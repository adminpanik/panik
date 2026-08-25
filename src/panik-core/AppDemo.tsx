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
  Plus,
  UserRound,
} from "lucide-react";
import {
  assetLoanToValue,
  calculateDynamicPosition,
  checkedAgo,
  depegAwareOutlook,
  formatCompactUsd,
  formatCurrency,
  formatPlainAmount,
  formatUsd,
  liquidationOutlook,
  type LiquidationOutlook,
  listedLiquidationThreshold,
  loanToValuePct,
  plural,
  LOAN_TO_VALUE_HINT,
  LOAN_TO_VALUE_UNAVAILABLE_HINT,
  PROTOCOL_LABEL,
  RISK_CHIP,
  RISK_PROFILES,
  RISK_SCORE_NAME,
  sameAssetDepegNote,
  simulatedHealthFactor,
  truncateAddress,
  UNLISTED_MARKET_HINT,
} from "./lib/utils";
/**
 * The user's alert level, from the engine rather than a literal. A VALUE import
 * from `packages/scoring` — allowed here only because it is a DEEP import of
 * `profile.ts`, whose sole import is type-only. The package barrel pulls viem
 * and must never reach a browser bundle (see lib/live.ts).
 */
import { ALERT_THRESHOLD, fitsProfile } from "../../packages/scoring/src/profile";
/**
 * The composite weights, from the engine for the same reason: `params.ts` has no
 * imports at all. Three surfaces on this file used to hard-code 40/25/20/15, one
 * of them inside an InfoTip that TEACHES the number — a re-weight in the engine
 * would have had the UI stating a wrong one with no visual tell.
 */
import { COMPOSITE_WEIGHTS } from "../../packages/scoring/src/params";
/**
 * The score's own vocabulary, from the engine that owns the score: the four
 * sub-score names, their shares of the composite, and the sentence stating
 * those shares. Same deep-import terms as the line above (`scoreVocabulary.ts`
 * imports `params.ts` and nothing else).
 */
import {
  COMPOSITE_WEIGHT_SENTENCE,
  DRIVER_LABEL,
  DRIVER_WEIGHT_PCT,
} from "../../packages/scoring/src/scoreVocabulary";
/**
 * The price-scenario magnitudes, from the engine for the same reason again:
 * `simulation.ts` has no runtime imports, and the operator-facing market
 * simulator arms these exact numbers against the live scoring path.
 */
import { MARKET_SCENARIOS } from "../../packages/scoring/src/simulation";
/**
 * The liquidation-drawdown formula, from the engine on the same terms:
 * `prospective.ts` has no imports at all. The breakdown panel needs the
 * FRACTION (to place a liquidation price on the example's anchor price), which
 * `liquidationOutlook` deliberately does not hand back - it returns the rounded
 * prose. Both read this one function, so the price and the percentage beside it
 * cannot come from two different drawdowns.
 */
import { drawdownToLiquidation } from "../../packages/scoring/src/prospective";
// Advisor-parity sizing for a Compass-initiated real open - see requestOpenPosition.
import { borrowForTargetHf, TARGET_HF } from "../../packages/scoring/src/advisor/repayMath";
import { marketParams } from "../../packages/scoring/src/markets";
import type { RiskProfile } from "../../packages/scoring/src/types";
import { PositionState } from "./lib/types";
import { LivePositions, positionKey } from "./components/LivePositions";
import {
  AlertFeed,
  AlertFeedSkeleton,
  AlertHistoryView,
  AlertLogEmptyState,
  ALERT_PREVIEW_COUNT,
} from "./components/AlertHistory";
import { Sparkline, SparklinePlaceholder } from "./components/Sparkline";
import { OpenPositionModal } from "./components/OpenPositionModal";
import { InfoTip } from "./components/InfoTip";
import { CardTitle } from "./components/CardTitle";
import { PageHeader } from "./components/PageHeader";
import {
  Button,
  Card,
  Chip,
  DemoChip,
  EmptyState,
  FIELD_BOX,
  LAYER,
  Listbox,
  RiskChip,
  RiskDial,
  riskScoreLabel,
  SCRIM,
  SimulationBanner,
  Skeleton,
  Stat,
  TabPanel,
} from "./ui";
import {
  useAdvisor,
  useChainTelemetry,
  useCompassScores,
  useCompassYields,
  useProspective,
  useWalletHistory,
  recommendedExitAction,
  useWalletPositions,
  type Band,
  type LiveProtocol,
  type LiveWalletPosition,
  type PoolYield,
} from "./lib/live";
import { AdvisorPanel } from "./components/AdvisorPanel";
import { ExitFlow, type ExitPrefill } from "./components/ExitFlow";
import { DelegationManager } from "./components/DelegationManager";
import { ExitApprovals } from "./components/ExitApprovals";
import { ChainModeSwitch } from "./components/ChainModeSwitch";
import { CHAIN_MODE_LABEL, useChainMode } from "./lib/chainMode";
import { canOpenInApp } from "./lib/openProtocols";
import { OpenFlow } from "./components/OpenFlow";
import { AdvisorPopup } from "./components/AdvisorPopup";
import type { AdvisorOpenPlan } from "./lib/live";
import { ALL_PROTOCOLS, ProtocolLogo, ProtocolMarks } from "./components/ProtocolLogo";
import { Onboarding, type OnboardingMode } from "./components/Onboarding";
import { FirstRunInvite } from "./components/FirstRunInvite";
import {
  forgetRegistration,
  registerWatchedWallet,
  useTelegramLink,
  useWalletOwnership,
  isEvmAddress,
  type MonitoringSeverity,
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
import {
  canActOnViewedWallet,
  deepLinkTab,
  subscriptionFor,
  useWatchlist,
  viewableWallets,
  viewParamWallet,
} from "./lib/watchlist";
import type { SessionState } from "./lib/session";
import { describeMembership, type AccountState } from "./lib/account";
import { WalletsPanel } from "./components/WalletsPanel";
import { WalletSelector } from "./components/WalletSelector";
import { ReadOnlyBanner, SessionCard, SessionNote } from "./components/SessionControls";
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
 * third copy of the labels and the weights. The table is the fix: the value is
 * read out of a breakdown by an accessor, so no surface can invent its own.
 *
 * The label and the weight are the ENGINE's (`scoreVocabulary.ts`), not this
 * file's: `packages/scoring` owns the score, so it owns what the score's parts
 * are called and what share each one carries. `key` is the engine's own
 * sub-score name, which is what indexes both.
 */
interface RiskDriver {
  /** Engine sub-score name — indexes DRIVER_LABEL and the live sub-scores. */
  key: keyof typeof COMPOSITE_WEIGHTS;
  label: string;
  /**
   * ONE sentence per driver, for every surface that explains it, with the
   * driver's share of the composite appended.
   *
   * There used to be two, a long one for Watch and a short one for the
   * breakdown panel, which is how the same sub-score got two definitions a
   * click apart. Both surfaces render these four rows in a column of the same
   * width, so the second variant was answering a question that does not
   * differ.
   *
   * The share is folded in HERE, at module init, rather than at the call sites:
   * both of them appended it the same way from compile-time constants, which
   * rebuilt four strings per surface on every render of a screen whose sliders
   * render continuously.
   */
  hint: string;
  of: (b: PositionState["breakdown"]) => number;
}

/** The half of a driver this file owns: what it measures, and where to read it. */
const RISK_DRIVER_DEFS: Omit<RiskDriver, "label">[] = [
  {
    key: "positionHealth",
    hint: "Distance to liquidation: health factor plus current LTV.",
    of: (b) => b.positionHealth,
  },
  {
    key: "assetRisk",
    hint: "Collateral price volatility, 90d drawdown, and BTC correlation.",
    of: (b) => b.assetVolatility,
  },
  {
    key: "protocolSafety",
    hint: "Protocol safety: audits, governance timelock, market controls.",
    of: (b) => b.protocolSafety,
  },
  {
    key: "systemicRisk",
    hint: "Market-wide stress: sector TVL flows and capital flight.",
    of: (b) => b.systemicMarketStress,
  },
];

const RISK_DRIVERS: RiskDriver[] = RISK_DRIVER_DEFS.map((d) => ({
  ...d,
  label: DRIVER_LABEL[d.key],
  hint: `${d.hint} ${DRIVER_WEIGHT_PCT[d.key]}% of the score.`,
}));

/**
 * What the composite is, for the two surfaces that print it as a headline
 * figure: the Compass risk-breakdown panel and the Watch simulator.
 *
 * One string, because the score is one quantity. Watch called it a "risk index"
 * and described it with a different four-item list than the one it drew two
 * inches to the right, which is the "one name per concept" rule failing on a
 * single screen. It opens with `RISK_SCORE_NAME`'s quantity and quotes the
 * engine's own weight sentence, the same one `RiskDial`'s tooltip carries.
 *
 * The Compass path is the case where the published weights ARE the arithmetic:
 * `CompassLiveScore.subScores` is non-nullable (lib/live.ts), and the offline
 * fallback is constructed so its weighted sum reproduces the composite. Nothing
 * this panel renders can be degraded, so it never needs RiskDial's other
 * branch.
 */
const RISK_SCORE_HINT =
  `0-100 composite of the four components in the score breakdown. ${COMPOSITE_WEIGHT_SENTENCE}` +
  ` LOW under 25, ELEVATED under 50, HIGH under 75, CRITICAL above.` +
  ` Higher means closer to liquidation.`;

/**
 * Collateral and debt are the SAME asset (the two USDC supply presets).
 *
 * An absolute price move then rescales both sides of the position at once, so
 * the distance to liquidation is a ratio that does not move, and any figure
 * quoted as a fall in the collateral's DOLLAR price is not a fact about this
 * market. What moves it is the two legs pricing apart.
 *
 * One predicate for the two surfaces that have to know: the Watch simulator's
 * price scenarios and the Compass risk-breakdown panel.
 */
function isSameAssetMarket(
  market: Pick<VaultPreset, "collateralAsset" | "debtAsset">,
): boolean {
  return market.collateralAsset === market.debtAsset;
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
 * Where you are, as a BLOCK.
 *
 * Two states and no third. The selected tab is a solid cobalt plate with white
 * ink (5.03:1) and the same 3px edge every other box on the screen carries;
 * every other tab is FLAT: no fill, no border, no shadow, black ink, and a
 * lavender wash on hover with no movement. That is the whole treatment, in one
 * map, shared by the desktop rail and the phone bar: the two were separate
 * ternaries inside one `className` expression and had already drifted apart on
 * which property carried the state, the rail using a border plus a weight
 * change and the bar using a weight change alone.
 *
 * The resting state used to be `bg-surface-raised` with an unconditional
 * `hard-edge` on every tab, which made all five tabs read as the same bordered
 * white plate the selected one was supposed to stand apart from. The border
 * now lives on `selected` alone, so it appears exactly where the state does.
 *
 * Cobalt is safe to spend here. It is the brand accent and it shares nothing
 * with the risk ramp, so the loudest block in the shell can never be read as a
 * verdict about a position. The old accent could not do that: it was the same
 * hex as `--color-risk-high`, which is why the rail this replaces had no
 * coloured marker at all.
 *
 * Neither state sets an ink colour on the icon. Lucide draws in `currentColor`,
 * so the glyph follows the label for free; setting it a second time is a second
 * copy of the state that can disagree with the first.
 */
const TAB_STATE = {
  selected: "hard-edge bg-brand text-white",
  resting: "text-text-primary hover:bg-highlight",
} as const;

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
 *
 * The two variants differ in LAYOUT only, which is why the state map above is
 * one map. The rail stacks separated blocks; the bar is one strip whose tabs
 * are divided by the same 3px edge, drawn on the right of each but the last so
 * two adjacent tabs do not stack their borders into a 6px rule.
 */
function NavTabs({ variant, activeTab, onSelect, tabRefs, onKeyDown }: NavTabsProps) {
  const vertical = variant === "sidebar";
  return (
    <nav
      role="tablist"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label="Application sections"
      className={
        vertical
          ? "space-y-2"
          : "flex items-stretch border-t-[3px] border-solid border-border-strong"
      }
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
            className={`cursor-pointer label-type ${
              vertical
                ? /* 48px, the height of every other control in the product. */
                  "flex min-h-12 w-full items-center gap-3 px-4 text-left text-xs"
                : /* 56px tall and a fifth of the viewport wide: comfortably past
                     the 24px WCAG 2.5.8 floor and past the 44px that a thumb
                     actually wants for primary navigation. */
                  "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-r-[3px] border-solid border-border-strong px-1 text-2xs last:border-r-0"
            } ${TAB_STATE[selected ? "selected" : "resting"]}`}
          >
            <Icon className={vertical ? "h-4 w-4 shrink-0" : "h-5 w-5 shrink-0"} aria-hidden="true" />
            <span className="max-w-full truncate">{label}</span>
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

/**
 * A band, as the word the Watch chip wears.
 *
 * The chip used to read the band off a `?:` chain that had grown its own
 * vocabulary: CRITICAL came out "CRITICAL THREAT", HIGH "HIGH RISK", ELEVATED
 * bare, LOW "LOW RISK". Four bands, three different constructions, and "threat"
 * appearing on exactly one of them, which makes the loudest band read as a
 * different KIND of statement rather than as one more step on the same scale.
 *
 * `Record<Band, string>` rather than a chain, for the reason every other table
 * in this product is one: a band added to the engine fails the build here
 * instead of falling through to the raw token. The chain's final `else` was
 * that failure waiting to happen: it painted anything that was not one of the
 * first three as "LOW RISK".
 *
 * `RiskChip` uppercases these itself, so they are written as words.
 */
const BAND_WORD: Record<Band, string> = {
  LOW: "Low risk",
  ELEVATED: "Elevated risk",
  HIGH: "High risk",
  CRITICAL: "Critical risk",
};

/**
 * The Watch simulator's two control skins, written once.
 *
 * Eight controls wore these, as eight hand-typed strings that had already
 * drifted (one number field spelled its utilities in a different order and set
 * `text-text-primary` twice). Both strings were also dark-theme artefacts that
 * had stopped working on paper: the number fields were `bg-black/40`, a 40%
 * black wash that made a typed figure white-on-charcoal inside a white card,
 * and the slider tracks were `bg-white/10`, which on white is nothing at all.
 * A range control whose track is invisible has no length to read a value
 * against.
 *
 * `accent-brand`, not `accent-text-primary`: the thumb is the one moving part
 * of the control and cobalt is what this system paints a control with. It is
 * nowhere on the risk ramp, so a slider dragged to a dangerous price never
 * looks like a verdict about the position.
 *
 * No `focus:` rule on the field. The one global `:focus-visible` ring in
 * index.css draws it, and the rule that was here set the border to the colour
 * it already had.
 *
 * The field COMPOSES `FIELD_BOX` rather than restating it. That constant is
 * exported from ui/TextField for exactly this case, a surface that cannot use
 * the component because its label is an `aria-label` rather than a visible one,
 * and taking it brings the 48px height the design system sets for every input
 * in the product. Hand-rolling the plate is what made these four fields shorter
 * than every other field in the app, and it silently dropped the disabled
 * treatment that comes with the box.
 *
 * The four utilities added to it set properties `FIELD_BOX` does not, so
 * nothing here is two rules deciding a tie by emit order.
 */
const WATCH_NUMBER_FIELD = `w-24 shrink-0 text-right font-mono tabular-nums ${FIELD_BOX}`;

const WATCH_SLIDER = "w-full h-1.5 cursor-pointer appearance-none bg-border-subtle accent-brand";

/** A slider's two end labels: a figure each, so both are set in mono. */
const WATCH_SLIDER_ENDS =
  "flex justify-between font-mono text-xs tabular-nums text-text-muted";

/**
 * What the band MEANS for this position, in one clause.
 *
 * A verdict that needs two sentences is not a verdict. These say what is true
 * and, where there is something to do, what to do; none of them reassures, and
 * none names a number the reading beside it already carries.
 *
 * "Spot price is close to your liquidation benchmark" is what CRITICAL used to
 * say. "Spot" and "benchmark" are both trade jargon with no referent on this
 * screen, and the fact underneath them is the one the whole product is built to
 * state plainly: the price is near the level that liquidates you.
 */
const BAND_VERDICT: Record<Band, string> = {
  LOW: "The collateral here comfortably covers the debt.",
  ELEVATED: "Steady for now, and a short move in the price would change that.",
  HIGH: "There is more debt here than the collateral carries comfortably. Repay some, or add collateral.",
  CRITICAL: "The price is close to the level that liquidates this position.",
};

// RiskProfile is the engine's union (packages/scoring/src/types.ts) - a local
// re-declaration drifted-by-construction the day the engine adds a profile.

/**
 * The risk PROFILE badge is one style for all five tiers, distinguished by its
 * label alone. A profile is a preference the user stated, not a danger level the
 * engine measured, so it must not borrow the risk ramp: an "aggressive" profile
 * painted red reads as "your positions are in trouble". The old five-step ramp
 * also put `moderate` and `moderately_aggressive` a dE of 7.8 apart, which is to
 * say it encoded a distinction nobody could see.
 */
const TIER_BADGE = "bg-white/5 text-text-secondary border-border-subtle";

/**
 * Settings: the Emergency Auto Repayment card is hidden per business-dev QA
 * (2026-07-03) until the Deleverager actually ships. Code kept intact.
 */
const SHOW_AUTO_REPAY_CARD = false;

/** The shared table in lib/utils, under this file's long-standing local name. */
const LIVE_PROTOCOL_LABEL = PROTOCOL_LABEL;

/**
 * When a stale figure was last real, to the minute.
 *
 * Local time and no seconds: the reader is deciding whether to trust a number
 * on their screen right now, and "07:41" answers that. The locale is the
 * browser's, because this is a wall-clock reading rather than a record.
 */
const SCORED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** How long a position row stays emphasised after an alert points at it. */
const HIGHLIGHT_MS = 4000;

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
 *
 * These four USED to be declared here. They now come from the engine, because
 * the operator-facing market simulator arms the same three magnitudes against
 * the live scoring path: a "Crash" that previews -40% in this panel while
 * applying something else to everyone's real score would be the same class of
 * bug as the hardcoded `COMPOSITE_WEIGHTS` this file already had to import.
 * One list, one meaning for the word.
 */
const PRICE_SCENARIOS = MARKET_SCENARIOS;
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
 * Why a Compass score is wearing a Demo badge, said once for the two surfaces
 * that show the same score: the card, and the risk breakdown it opens.
 *
 * `VAULT_PRESETS` carries a listed `baseRisk`/`riskStatus` per market so the
 * grid has something to draw before /api/compass answers, and those constants
 * are what a card falls back to when it never does. They are a plausible
 * reading of a market rather than a measurement of one, and a dial drawn from
 * them is indistinguishable from a live engine read unless the card says so.
 */
const FALLBACK_SCORE_NOTE =
  "This market's score came from the offline fallback, not a live engine read.";

/**
 * One Compass market.
 *
 * Deliberately shaped like a Portfolio position row, because it is the same
 * kind of object seen from the other side: identity on the left, the band on
 * the right, the money on one line, the verdict on the next, actions at the
 * foot. Nine stacked elements became five.
 *
 * `muted` is the "outside your profile" rendering. It dims the SURFACE only.
 * The old version also dimmed the logo, the title and the risk dial, which put
 * a CRITICAL market's band at 60% opacity — the one card on the page most worth
 * reading clearly was the faintest. Which section it is in already says it is
 * out of profile; the dial's job is to say how far.
 *
 * `lead` is the opposite end of the same axis, and it is why the other cards
 * settled a step. Eight cards at one weight is a page with no answer on it: the
 * reader has to compare eight dials before the screen has told them anything.
 * The emphasis is the BORDER, a type step and a marker, never more hue - the
 * dial is still the only coloured thing on any of these cards, and the lead's
 * own claim is a neutral `Chip`.
 */
function MarketCard({
  preset,
  poolYield,
  muted = false,
  lead = false,
  leadNote,
  opensDemo,
  scoreFromFallback,
  onBreakdown,
  onSimulate,
  onOpen,
}: {
  preset: VaultPreset;
  poolYield: PoolYield | null;
  muted?: boolean;
  /** The section's one emphasised card. See the docblock, and `compassLead`. */
  lead?: boolean;
  /** What the lead card CLAIMS, in the words of the thing that measured it. */
  leadNote?: string;
  /**
   * This card's open would land in the DEMO simulator rather than a real
   * transaction. Comes from the same predicate the click routes on, so the
   * label on the card and the screen the click reaches cannot disagree.
   */
  opensDemo: boolean;
  /**
   * The dial on this card is drawn from the LISTED score, because the engine
   * feed is down and there was nothing to overlay. A separate claim from
   * `opensDemo`, about the number rather than the button, which is why the two
   * chips share a word and carry different hovers. The risk breakdown behind
   * this card makes the same claim from the same condition.
   */
  scoreFromFallback: boolean;
  onBreakdown: () => void;
  onSimulate: () => void;
  onOpen: () => void;
}) {
  const apy = poolYield?.apy ?? preset.apy;
  const trend = poolYield ? apyTrendCopy(apy, poolYield.apySeries) : null;
  return (
    <Card
      /* Three depths, in the order the reader should meet them: the lead, the
         rest of its section, and the section that is out of profile. `strong` on
         the lead's edge is the only functional border on the grid, and it is the
         one card whose edge is doing a job.

         The primitive owns all three, so this grid's lead is pixel-for-pixel the
         Advisor's: the two were hand-typed apart at `surface-raised/80` and /50,
         which is one screen's "the thing to read here" being a different object
         from another's. Only the hover is left here, because it is a step up
         from whichever base the tone set. */
      tone={lead ? "lead" : muted ? "set-back" : "raised"}
      onClick={onBreakdown}
      className={`flex cursor-pointer flex-col gap-3 transition-colors hover:border-border-strong ${
        muted ? "hover:bg-surface-raised/45" : "hover:bg-surface-overlay/60"
      }`}
    >
      {/* The claim, in a neutral marker, above the identity it is about. It is
          the one sentence this grid was missing: eight scored markets and
          nothing saying which one the profile actually points at. */}
      {lead && leadNote && <Chip className="self-start">{leadNote}</Chip>}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProtocolLogo protocol={preset.protocol} size="w-8 h-8" />
          <div className="min-w-0">
            {/* One type step on the lead, which is the emphasis a card can
                carry without spending hue or breaking the grid's rhythm. */}
            <h3
              className={`truncate font-sans font-bold text-text-primary ${
                lead ? "text-base" : "text-sm"
              }`}
            >
              {preset.protocol}
            </h3>
            <span className="block truncate text-xs font-sans text-text-secondary">
              {preset.assetPair}
            </span>
          </div>
        </div>
        {/* The dial is the keyboard route into the breakdown; the card body is
            the mouse route. It no longer opens the panel on MOUSEENTER — a
            500px slide-out with a full-page backdrop was firing on an
            accidental pass of the cursor, so the page moved out from under
            anyone scanning the grid.

            The same dial the Portfolio rows carry, for the same reason: the
            score is a proportion of a fixed range and the arc is that
            denominator drawn. `plain` because this button owns the name (see
            the prop's docblock). */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Beside the figure it is about, for the same reason the simulation
              marker travels with the payload it describes: a provenance mark
              reachable only by opening the panel behind this card leaves every
              glance at the grid reading a constant as a measurement. Live is
              the default and wears nothing. */}
          {scoreFromFallback && <DemoChip title={FALLBACK_SCORE_NOTE} />}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBreakdown();
            }}
            aria-label={
              `${riskScoreLabel(preset.baseRisk, preset.riskStatus)} ` +
              (scoreFromFallback ? `${FALLBACK_SCORE_NOTE} ` : "") +
              `Open the ${preset.protocol} risk breakdown.`
            }
            title={`Open the ${preset.protocol} risk breakdown`}
            className="cursor-pointer rounded-full"
          >
            <RiskDial score={preset.baseRisk} band={preset.riskStatus} plain />
          </button>
        </div>
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

      {/* `mt-auto`, so every card in a row puts its actions on the same line
          whatever is above them. Grid items already stretch to the tallest card,
          and the lead is now taller than the rest by a marker; without this the
          three buttons in a row sit at three different heights. */}
      <div
        className="mt-auto flex items-center justify-between gap-3 border-t border-border-subtle pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Button onClick={onOpen}>
            <Plus className="h-3.5 w-3.5" />
            Open position
          </Button>
          {opensDemo && <DemoChip />}
        </div>
        {/* Icon-only, so the primary action is the only labelled button on the
            card. The name lives in `aria-label` and `title` rather than beside
            the glyph; the quiet variant's own padding takes the target to
            44x32, clear of the 24px floor. */}
        <Button
          variant="ghost"
          onClick={onSimulate}
          aria-label="Stress-test this market in the simulator"
          title="Stress-test this market in the simulator"
        >
          <Eye className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

/**
 * One Compass section: its heading, and under it either its cards or the
 * statement that it has none.
 *
 * Recommended and Outside were 36-line near-copies, each carrying its own copy
 * of the eight-prop `MarketCard` call and each testing its own emptiness twice
 * (once to decide whether the section exists, again to decide what goes in it).
 * The two tests are one decision and they live here now: cards if there are
 * cards, otherwise the empty statement if this tab is stating empties, and
 * otherwise nothing at all.
 *
 * `muted` is the out-of-profile section, and it dims the heading and the cards
 * together: the heading IS the "not recommended", so a full-strength heading
 * over dimmed cards would put the emphasis on the warning rather than the
 * markets the profile actually points at.
 */
function MarketSection({
  heading,
  presets,
  statesEmpty,
  emptyTitle,
  emptyHint,
  muted = false,
  leadId,
  leadNote,
  poolYields,
  opensReal,
  scoreFromFallback,
  onBreakdown,
  onSimulate,
  onOpen,
}: {
  heading: string;
  presets: VaultPreset[];
  /** The one card this section emphasises, if it has one. See `compassLead`. */
  leadId?: string;
  /** What that card claims. Travels with the id so neither can appear alone. */
  leadNote?: string;
  /** Whether an empty section is STATED rather than dropped. See its caller. */
  statesEmpty: boolean;
  emptyTitle: string;
  emptyHint?: string;
  muted?: boolean;
  poolYields: Record<string, PoolYield> | null;
  /** The predicate the open click routes on, so card and click agree. */
  opensReal: (preset: VaultPreset) => boolean;
  /** Whether this market's dial is the listed constant. See `MarketCard`. */
  scoreFromFallback: (preset: VaultPreset) => boolean;
  onBreakdown: (preset: VaultPreset) => void;
  onSimulate: (preset: VaultPreset) => void;
  onOpen: (preset: VaultPreset) => void;
}) {
  if (presets.length === 0 && !statesEmpty) return null;
  return (
    <div className={muted ? "space-y-4 pt-4" : "space-y-4"}>
      <h2
        className={`text-base font-sans font-bold tracking-wide ${
          muted ? "text-text-secondary" : "text-text-primary"
        }`}
      >
        {heading}
      </h2>
      {presets.length === 0 ? (
        /* `clear`, not `problem`: nothing failed here, this is the coverage the
           chain and the profile between them produce. */
        <EmptyState tone="clear" title={emptyTitle} hint={emptyHint} />
      ) : (
        /* Three across at `xl`. Two columns left a permanent orphan: an odd
           count is the normal case here (three recommended and five outside at
           the moderate profile), and at two wide the stray card sat alone
           beside half a row of void. The cards are five elements tall now
           rather than nine, so three fit the 1120px content column without
           crushing anything.

           `lg`, not `md`: at a 768px window the sidebar has already taken
           256px, so two columns there were 208px each, which is narrower than
           "Compound V3" plus its risk chip. */
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          {presets.map((preset) => (
            <MarketCard
              key={preset.id}
              preset={preset}
              poolYield={poolYields?.[preset.id] ?? null}
              muted={muted}
              lead={preset.id === leadId}
              leadNote={leadNote}
              opensDemo={!opensReal(preset)}
              scoreFromFallback={scoreFromFallback(preset)}
              onBreakdown={() => onBreakdown(preset)}
              onOpen={() => onOpen(preset)}
              onSimulate={() => onSimulate(preset)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row of the Watch market listbox.
 *
 * ONE component for the two sources Watch reads (the wallet's real positions,
 * and the Compass preset catalog), because the row is the same object seen from
 * two sides: who runs the market, what the leg is, and what it scores. The two
 * branches were verbatim copies differing only in the middle line, which is the
 * shape that lets one of them quietly gain a band the other does not draw.
 *
 * The band lives in `RiskChip`, the one place a band becomes pixels, and the
 * score is neutral ink beside it: a figure is not the thing that carries the
 * hue. Nothing here states the band by colour alone - the chip's own word does.
 */
interface MarketChoice {
  /**
   * What this row IS, and the only thing selection is decided by. Both sources
   * key by something already unique to them (a position's wallet-protocol-asset
   * triple, a preset's id), so an index is a position in the list and never an
   * identity.
   */
  key: string;
  protocol: string;
  /** The leg, already worded by the caller: it is a size on one source and an asset pair on the other. */
  line: string;
  band: Band;
  score: number;
  /** What picking this row does, in the words of whichever source built it. */
  commit: () => void;
}

function MarketOptionRow({ choice, selected }: { choice: MarketChoice; selected: boolean }) {
  return (
    <>
      <div className="min-w-0">
        <span className="block label-type text-xs text-text-muted">{choice.protocol}</span>
        {/* The leg is a size or an asset pair, so it is a reading either way. */}
        <span
          className={`block truncate font-mono text-sm font-bold tabular-nums ${
            selected ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {choice.line}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* The band as a WORD, from the one table. This printed `choice.band`
            straight through, so an engine token reached the screen in the one
            place a reader compares four positions before acting on one. */}
        <RiskChip band={choice.band}>{BAND_WORD[choice.band]}</RiskChip>
        <span className="font-mono text-xs font-bold tabular-nums text-text-muted">
          {choice.score}
        </span>
      </div>
    </>
  );
}

/**
 * Everything the risk-breakdown panel renders, read once so no cell can derive
 * a second version of a figure another cell already shows.
 */
interface BreakdownData {
  /** False = the score came from the offline fallback, not the engine. */
  isLive: boolean;
  subs: Record<keyof typeof COMPOSITE_WEIGHTS, number>;
  /** The health factor as a price move, worded and rounded by the engine. */
  outlook: LiquidationOutlook;
  /** The example's anchor price after the engine's drawdown. Null = no debt. */
  liqPrice: number | null;
  poolYield: PoolYield | null;
}

/**
 * One labelled row of the risk-breakdown panel.
 *
 * The shape is the Portfolio position row's and the Compass card's: a
 * hairline-separated list inside ONE panel, label left at 12px, figure right at
 * 14px. A bordered, tinted well per figure inside a bordered, tinted panel is
 * chrome wrapping chrome, and a dozen of them in a 500px column is what forces
 * the content inside them down to 11px to fit.
 */
function BreakdownRow({
  label,
  hint,
  value,
  note,
  children,
}: {
  label: React.ReactNode;
  /** Methodology, provenance, or the exact ratio behind the figure. */
  hint?: string;
  /** Omitted by a row whose whole content is prose or a chart. */
  value?: React.ReactNode;
  /**
   * One clause the figure does not already state, stacked UNDER it so the
   * qualifier reads as belonging to it. At body size: the thing most often
   * qualified here is a dollar amount, and the money line is not the row's
   * small print.
   *
   * A row whose whole content is prose passes it as `children` instead, which
   * lands in the same place at the same size.
   */
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-1 text-xs font-sans text-text-secondary">
          {label}
          {hint !== undefined && <InfoTip text={hint} />}
        </span>
        {value !== undefined && (
          <span className="shrink-0 text-right">
            {/* MONO, because every value this row carries is a reading: a
                percentage, a dollar amount, a sub-score, or the short phrase
                the engine substitutes when there is no figure to print. A
                column of them lines up on its own, which is the whole reason
                the system has a second face. */}
            <span className="block font-mono text-sm font-bold tabular-nums text-text-primary">
              {value}
            </span>
            {note !== undefined && (
              <span className="mt-0.5 block text-sm font-sans tabular-nums text-text-secondary">
                {note}
              </span>
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** A run of `BreakdownRow`s under its heading. Hairlines, never nested wells. */
function BreakdownSection({
  heading,
  hint,
  children,
}: {
  heading: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      {/* `CardTitle`, so a section heading looks the same here as it does two
          cards over. `heading` is a plain string at all four call sites and
          none of them names an asset, so the uppercase transform is safe. */}
      <CardTitle as="h4" size="sm" muted hint={hint}>
        {heading}
      </CardTitle>
      <div className="divide-y divide-border-subtle border-t border-border-subtle">{children}</div>
    </section>
  );
}

/**
 * The engine's four weighted sub-scores as labelled rows with bars.
 *
 * ONE component for the two surfaces that draw them, the Compass
 * risk-breakdown panel and the Watch score card. They were verbatim copies that
 * had already begun to diverge (only one carried the bar's transition), which
 * is the same drift that once gave three of these rows a hand-typed colour and
 * the fourth a number the engine never produced.
 *
 * Only the accessor differs, so only the accessor is a prop: Compass reads a
 * `Record` keyed by the engine's sub-score name, Watch a `PositionState`
 * breakdown whose field names are its own.
 *
 * These are the parts of ONE score, already banded once by the chip above them,
 * so there is no hue on any of the four: the bar LENGTH is the channel, and
 * four hues here would be four verdicts about one position. The value is a bare
 * 0-100 number rather than "78%" - a sub-score is a risk point on the same
 * scale as the composite, and printing it as a percentage invites "78% of
 * what". The bar carries the denominator.
 */
function ScoreBreakdownSection({ valueOf }: { valueOf: (driver: RiskDriver) => number }) {
  return (
    <BreakdownSection heading="Score breakdown">
      {RISK_DRIVERS.map((driver) => {
        const value = valueOf(driver);
        return (
          <BreakdownRow key={driver.key} label={driver.label} hint={driver.hint} value={value}>
            {/* A visible TRACK and a square bar. The track was `bg-white/[0.03]`
                and the bar `rounded-full`, which is a dark-theme rule and a
                radius this system does not have: on a white card a 3% white
                track is white, so the bar had no length to be read against and
                four sub-scores of 78, 38, 30 and 30 all looked like four bars
                floating in nothing.

                The transition is gone with the rest of the motion in this
                system. It existed for Watch, whose sliders move these four bars
                continuously, and a 300ms ease on a risk figure that is being
                dragged is the bar reporting a value the position no longer
                has. */}
            <div className="h-1.5 w-full overflow-hidden bg-border-subtle">
              <div className="h-full bg-text-primary" style={{ width: `${value}%` }} />
            </div>
          </BreakdownRow>
        );
      })}
    </BreakdownSection>
  );
}

/**
 * The app's ONE slide-in: a dimmed backdrop over the content column, and a
 * 500px panel hung from its right edge.
 *
 * Two surfaces use it (the risk breakdown and Wallets) and until now each wrote
 * the shell out by hand: the same nine utilities on the backdrop, the same
 * eleven on the panel, the same spring, twice. They happened to agree, which is
 * the state a duplicated contract is in right up until an edit lands on one
 * copy. An overlay that dims on one surface and not on the other teaches a
 * reader that the two are different kinds of thing, when they are the same
 * thing showing different content, and nothing about either copy would have
 * failed to make that visible.
 *
 * `absolute`, not `fixed`, and deliberately: it covers the CONTENT COLUMN
 * only, so the sidebar stays lit and reachable and the reader can leave by
 * pressing a tab rather than by finding the close control.
 *
 * The panel's own dismissal contract (focus on open, Escape to close) belongs
 * to the component inside it, which is the thing that knows what closing means.
 *
 * Its rungs come from `LAYER`, which is why it is now above the alerts-inactive
 * banner rather than under it. At 390 that banner covered this panel's heading
 * and its close control, and a notice the app raised on its own does not get to
 * sit on top of the surface the reader deliberately opened.
 */
function Sheet({ onDismiss, children }: { onDismiss: () => void; children: React.ReactNode }) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        exit={{ opacity: 0 }}
        onClick={onDismiss}
        className={`absolute inset-0 ${SCRIM} ${LAYER.scrim} cursor-pointer`}
      />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 26, stiffness: 220 }}
        className={`absolute right-0 top-0 bottom-0 w-full sm:w-[500px] bg-surface-raised border-l border-border-subtle shadow-[0_0_50px_rgba(0,0,0,0.8)] ${LAYER.sheet} flex flex-col overflow-hidden text-sm`}
      >
        {children}
      </motion.div>
    </>
  );
}

/**
 * The risk-breakdown panel's header, body and footer.
 *
 * Its own component because the panel is a self-contained reading surface with
 * a dozen derived figures, and derivations written inline in the tab's JSX are
 * how one quantity ends up computed twice in two cells.
 *
 * What it may claim is bounded by what this codebase measures: the engine's
 * composite and its four sub-scores, DefiLlama's pool APY and TVL, and the
 * example position `VAULT_PRESETS` states. Nothing here asserts a protocol's
 * governance, its safety module, or what monitoring is watching a position -
 * those are string literals keyed on a protocol name, and a static claim is
 * still a claim the code cannot check. This is the panel whose entire job is
 * explaining where a number came from, so it is the last place that may state
 * one it did not read.
 */
function RiskBreakdownPanel({
  preset,
  data,
  opensDemo,
  onClose,
  onSimulate,
  onOpen,
}: {
  preset: VaultPreset;
  data: BreakdownData;
  /** This panel's open lands in the demo simulator, not a signed transaction. */
  opensDemo: boolean;
  onClose: () => void;
  onSimulate: () => void;
  onOpen: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The panel takes focus on open and Escape closes it: the dismissal contract
  // a keyboard user expects from anything that covers the page behind a
  // backdrop. Same shape as `AlertHistoryView`.
  //
  // `preventScroll`, because this mounts on the first frame of the slide-in,
  // while the element is still translated fully off-screen: the browser's
  // default scroll-into-view then fights the spring for the scroll position
  // and the animation visibly stutters.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  const sameAsset = isSameAssetMarket(preset);
  const outlook = data.outlook;
  // The liquidation row's label and hover, from the one helper Watch's
  // equivalent row also reads.
  const liquidationRow = depegAwareOutlook(outlook, preset.collateralAsset, sameAsset);

  const collateralValue = preset.defaultCollateral * preset.defaultPrice;
  const ltvPct = loanToValuePct(preset.defaultBorrow, collateralValue);
  // The protocol's real per-asset limits, from `MARKETS`, or the stated
  // "we hold no parameters for this market" when it lists none.
  const limits = assetLoanToValue(preset.protocol, preset.collateralSymbol);

  /**
   * The dollar value beside a token amount, and ONLY where it says something
   * the token amount does not. At an anchor price of $1 the two are the same
   * number, so "2000 USDC ($2,000)" is one quantity printed twice; at $1,667 a
   * WETH the dollars are the fact most readers are actually after.
   */
  const collateralNote = preset.defaultPrice === 1 ? undefined : formatCurrency(collateralValue);

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-labelledby="risk-breakdown-heading"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="flex h-full flex-col overflow-hidden outline-hidden"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle p-5">
        <div className="flex min-w-0 items-center gap-3">
          <ProtocolLogo protocol={preset.protocol} size="w-8 h-8" />
          <div className="min-w-0">
            <h3
              id="risk-breakdown-heading"
              className="truncate text-sm font-sans font-bold text-text-primary"
            >
              {preset.protocol} risk breakdown
            </h3>
            <span className="block truncate text-xs font-sans text-text-secondary">
              {preset.assetPair}
            </span>
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={onClose}
          aria-label="Close the risk breakdown"
          title="Close the risk breakdown"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        {/* The headline, and the ONE place this panel spends a risk hue. The
            figure is neutral ink at 18.1:1 and the chip beside it carries the
            band, which is the whole of the "never colour a stat value" rule: a
            band stated in three hued elements on one panel leaves nothing on it
            reading as more important than anything else. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1 text-xs font-sans text-text-secondary">
              {RISK_SCORE_NAME}
              <InfoTip text={RISK_SCORE_HINT} />
            </span>
            <div className="flex items-center gap-2">
              {/* Live is the default and needs no badge. Only the fixture case
                  is worth calling out, because it is the one the reader would
                  otherwise get wrong. */}
              {!data.isLive && <DemoChip title={FALLBACK_SCORE_NOTE} />}
              {/* Keyed on the band this preset ALREADY carries, not on a band
                  re-derived from its number: the re-derived chain had no HIGH
                  branch, so a preset labelled HIGH was painted CRITICAL red. */}
              <RiskChip band={preset.riskStatus}>{preset.riskStatus}</RiskChip>
            </div>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-sans font-bold tabular-nums text-text-primary">
              {preset.baseRisk}
            </span>
            <span className="text-sm font-sans text-text-muted tabular-nums">/ 100</span>
          </div>
        </div>

        {/* The engine's four sub-scores, keyed by the engine's own names: this
            panel's `subs` is a Record, Watch's is a PositionState breakdown. */}
        <ScoreBreakdownSection valueOf={(driver) => data.subs[driver.key]} />

        {/* The example the score is ABOUT, said in words above its figures.
            Every number here is the sample trade `VAULT_PRESETS` states plus
            the engine's reading of it; the reader does not hold this position,
            and the heading is where they find that out. */}
        <BreakdownSection
          heading="Example position this preview is scored on"
          hint="PANIK previews each market against a sample position of a fixed size. These are that sample's figures, not a position you hold. Open the simulator to score your own numbers."
        >
          <BreakdownRow
            label={liquidationRow.label}
            hint={liquidationRow.hint}
            value={outlook.statValue}
          />

          <BreakdownRow
            label="Loan to value"
            hint={`${LOAN_TO_VALUE_HINT} ${limits === null ? LOAN_TO_VALUE_UNAVAILABLE_HINT : limits.note}`}
            /* Never a zero standing in for an unknown: a market with no
               collateral value has no loan to value, and "0%" is the reading a
               reader would act on. */
            value={ltvPct === null ? "Unavailable" : `${ltvPct}%`}
          />

          {/* A dollar liquidation price is a fact about markets whose two legs
              can price apart. On USDC collateral against USDC debt it is not
              one: the drawdown on a $1 anchor lands at "$0.29", which says this
              position liquidates when USDC reaches 29 cents, about a pair no
              dollar move can separate. The market gets the move that does
              change it instead, in the wording Watch uses for the same
              reason. */}
          {sameAsset ? (
            <BreakdownRow label="What moves this market">
              <p className="text-sm font-sans text-text-secondary">
                {sameAssetDepegNote(preset.collateralAsset)}
              </p>
            </BreakdownRow>
          ) : (
            <BreakdownRow
              label="Liquidation price"
              hint={`The ${preset.collateralAsset} price at which the example position becomes liquidatable. The drawdown is the engine's; the price it lands on is the example's anchor price.`}
              value={data.liqPrice != null ? formatCurrency(data.liqPrice) : "None"}
            />
          )}

          {/* Grouped, because these sit in a column with `formatCurrency`'s
              output two rows up and "4500" beside "$8,000" reads as two
              different kinds of number. `formatPlainAmount`, not
              `formatTokenAmount`: these are plain constants from
              `VAULT_PRESETS`, not wei, so there is nothing to convert. */}
          <BreakdownRow
            label="Collateral"
            value={formatPlainAmount(preset.defaultCollateral, preset.collateralAsset)}
            note={collateralNote}
          />
          <BreakdownRow
            label="Borrowed"
            value={formatPlainAmount(preset.defaultBorrow, preset.debtAsset)}
          />
        </BreakdownSection>

        {/* The two figures on this panel that are neither the engine's nor the
            example's. Provenance is a question asked once, so it is on the
            heading's hover rather than captioned on every glance. */}
        <BreakdownSection
          heading="Pool metrics"
          hint="Read from DefiLlama, refreshed with the Compass cards. Each figure is drawn over the last 30 days."
        >
          <BreakdownRow
            label="Supply APY"
            /* One rounding rule per quantity: the Compass card this panel opens
               from prints the same APY to one decimal, from the same fallback.

               The fallback says where its number came from. The heading's tip
               names DefiLlama, and a listed constant rendered under that claim
               with nothing beside it is the panel asserting a live read it did
               not get. */
            value={`${(data.poolYield?.apy ?? preset.apy).toFixed(1)}%`}
            note={
              data.poolYield ? undefined : "This market's listed rate; the live pool read failed"
            }
          >
            {data.poolYield && (
              <Sparkline
                data={data.poolYield.apySeries}
                stroke="var(--color-chart-series)"
                height={28}
              />
            )}
          </BreakdownRow>

          <BreakdownRow
            label="Pool TVL"
            hint="Total value locked. A falling TVL can signal capital leaving the market."
            /* No listed constant exists for TVL, and inventing one would be the
               "never render an unknown as a zero" rule failing. The word is the
               honest answer, and it is not the same answer as a small pool. */
            value={data.poolYield ? formatCompactUsd(data.poolYield.tvlUsd) : "Unavailable"}
          >
            {data.poolYield && (
              <Sparkline
                data={data.poolYield.tvlSeries}
                stroke="var(--color-chart-series)"
                height={28}
              />
            )}
          </BreakdownRow>
        </BreakdownSection>
      </div>

      {/* One primary action, and it is the only filled button in the panel. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-subtle bg-surface-base p-4">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button variant="secondary" onClick={onSimulate}>
          Open simulator
        </Button>
        <Button onClick={onOpen}>
          <Plus className="h-3.5 w-3.5" />
          Open position
        </Button>
        {opensDemo && <DemoChip />}
      </div>
    </div>
  );
}

export interface AppDemoProps {
  /**
   * The WALLET session: which address this browser has been told it may be
   * shown, and how the server knows. Owned by AppShell, which has to hold it
   * before this component exists: it is half of the decision about whether the
   * dashboard mounts at all.
   *
   * The rule it does not break: a bare string in localStorage is still never
   * restored as identity. What arrives here came back from the server, which
   * issued it against either a `session-start` signature or a single-use alert
   * token, so the browser is not asserting who it is - it is being told. Scope
   * decides what that is worth (lib/session.ts), and it is never a write
   * permission: every write below still signs its own action-bound proof.
   *
   * Always `resolved` by the time this renders. The shell holds the boot.
   */
  session: SessionState;
  /**
   * The ACCOUNT: a different question, and one this component no longer asks.
   *
   * `session` answers "which wallet may this browser be shown". This answers
   * "who is signed in to PANIK, and has the beta let them in yet". Neither
   * authorizes the other: an account never names a wallet, and every
   * wallet-scoped write below still signs its own action-bound proof.
   */
  account: AccountState;
}

export function AppDemo({ session, account: accountState }: AppDemoProps) {
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
  const [selectedRiskProfile, setSelectedRiskProfile] = useState<RiskProfile>(() => {
    // The one place this user-editable value enters typed code. Anything that
    // is not a known profile (stale build, hand-edited storage) becomes
    // moderate HERE, so no downstream consumer needs its own guard.
    const stored = localStorage.getItem("panik_risk_profile");
    return stored !== null && (RISK_PROFILES as readonly string[]).includes(stored)
      ? (stored as RiskProfile)
      : "moderate";
  });
  const [selectedRiskBreakdownPreset, setSelectedRiskBreakdownPreset] = useState<VaultPreset | null>(null);
  // Demo-only open-position flow (no signing; see OpenPositionModal).
  const [openPositionPreset, setOpenPositionPreset] = useState<VaultPreset | null>(null);

  // ── First-time onboarding (no backend — localStorage-persisted) ──────────
  // Null means closed; the value is WHY it is open, because the three entry
  // points want different things and only the first run is a first run. Read
  // ONCE, at mount: reading the flag live would make the mandatory pass
  // cancellable the moment `handleOnboardingComplete` writes it.
  const [onboardingIntent, setOnboardingIntent] = useState<OnboardingMode | null>(
    () => (localStorage.getItem("panik_onboarded") !== "true" ? "first-run" : null)
  );
  /**
   * The wallet this dashboard is bound to, and it is deliberately NOT seeded
   * from localStorage.
   *
   * `panik_wallet` was a plain string with no ownership proof behind it, and
   * everything here (positions, advisor, history, the aggregate score) is keyed
   * on it. `npm run dev:mock` writes the fixture address into localStorage, the
   * real app read it back on the next load, and the user spent the session
   * looking at a wallet they had never owned while their own position was
   * invisible. Restoring a bare string is indistinguishable from being handed
   * one, so the restore is gone rather than guarded: the dashboard follows the
   * CONNECTED wallet, or an address entered in this session, and nothing else.
   * A returning visitor with neither gets the first-run invitation, which costs
   * one click and cannot show them somebody else's money.
   *
   * This is NOT authentication. A pasted address still proves nothing, and the
   * per-wallet profile store is still a client-side convenience. Real identity
   * (SIWE-gated sessions, watch-only addresses added deliberately rather than by
   * accident) is Issue #51 and is not built here.
   */
  const [onboardedWallet, setOnboardedWallet] = useState<string | null>(null);
  const [riskTier, setRiskTier] = useState<RiskTier | null>(
    () => localStorage.getItem("panik_risk_tier") as RiskTier | null
  );

  /**
   * A connected wallet binds the dashboard to itself, and outranks an address
   * typed into onboarding.
   *
   * It is the only wallet the user can prove and the only one the exit flow can
   * act on: that flow reads the chain for whatever is connected, so any other
   * rule leaves the dashboard and the Exit button describing two accounts.
   */
  const { address: connectedWallet } = useAccount();
  useEffect(() => {
    if (!connectedWallet) return;
    if (onboardedWallet && onboardedWallet.toLowerCase() === connectedWallet.toLowerCase()) return;
    setOnboardedWallet(connectedWallet);
  }, [connectedWallet, onboardedWallet]);

  /**
   * Adopt the identity the server vouched for, WITHOUT outranking a connected
   * wallet. A connected wallet is the only one the exit flow can act on, so it
   * stays the winner; the session fills the gap for a reader who has not
   * connected one, which is the whole case it exists for.
   *
   * A restored identity also ends the first run. It is by definition not one:
   * the person on the other end signed for this browser, or the alert this link
   * came from was sent for them.
   */
  useEffect(() => {
    const restored = session.session;
    if (session.status !== "resolved" || !restored) return;
    setOnboardedWallet((current) => current ?? restored.wallet);
    setOnboardingIntent((intent) => (intent === "first-run" ? null : intent));
  }, [session.status, session.session]);

  /**
   * What a read-only session withholds, in one predicate.
   *
   * It gates AFFORDANCES, never data: the reader is looking at a wallet the
   * server named for them, and hiding the numbers would defeat the alert link
   * they arrived on. What goes is every control whose signature this reader
   * cannot produce, because offering one is the product claiming it can do
   * something for them that it cannot.
   */
  const readOnlySession = session.session?.scope === "readonly";

  const handleOnboardingComplete = (result: ProfileResult, wallet: string) => {
    saveProfileForWallet(wallet.trim(), result); // per-wallet memory (wallet-switch flow)
    localStorage.setItem("panik_onboarded", "true");
    localStorage.setItem("panik_risk_profile", result.riskProfile3); // 3-level (Compass)
    localStorage.setItem("panik_risk_tier", result.riskTier);         // 5-level (display)
    localStorage.setItem("panik_user_segment", result.segment);
    localStorage.setItem("panik_risk_score", String(result.riskScore));
    // The ADDRESS is not persisted. See `onboardedWallet` above: a stored
    // address is restored as identity on the next load, which is the fake
    // wallet this flow exists to stop handing people. What persists is the
    // PROFILE, keyed by wallet, so re-entering the address skips the quiz.
    setSelectedRiskProfile(result.riskProfile3);
    setRiskTier(result.riskTier);
    setOnboardedWallet(wallet);
    setOnboardingIntent(null);
    
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
    [onboardedWallet, onboardingIntent],
  );

  // Settings tab preferences (auto-repayment trigger).
  const [automaticRepayTarget, setAutomaticRepayTarget] = useState<number>(30);
  const [isRepayActive, setIsRepayActive] = useState<boolean>(true);

  // ── LIVE data (scoring API; every hook degrades gracefully offline) ──────
  // Declared FIRST — the memos below consume these (const = TDZ).
  // Which chain the user is looking at (Settings > Network). A DISPLAY
  // preference, persisted in localStorage; see lib/chainMode.ts for why that is
  // legitimate here and is not for the wallet.
  const chainMode = useChainMode();

  const { scores: compassLive, offline: compassFeedDown } = useCompassScores();
  const { pools: poolYields } = useCompassYields();
  const chainTel = useChainTelemetry(chainMode);

  // The dashboard follows ONE wallet: the one bound above. There is no second
  // source any more. It used to fall back to the ops registry (/api/scores +
  // /api/wallets, the seeded validation cohort with a pill selector), and that
  // path could never produce a single row: both endpoints require the admin key
  // server-side and the browser has none, so every unauthenticated visitor with
  // no wallet got four skeleton cards and "Live feed unavailable" forever. That
  // dead end is what the first-run invitation replaces.
  const boundMode = Boolean(onboardedWallet);

  /**
   * The wallets PANIK watches FOR the bound wallet, and the panel that changes
   * them.
   *
   * Read here rather than inside the panel because three surfaces need it and
   * only one of them is the panel: the Portfolio switcher lists it, the Compass
   * header reads the bound wallet's own subscribed profile out of it to tell the
   * truth about what the toggle does, and the panel edits it. One read, one
   * source, and a save updates all three at once.
   */
  const watchlist = useWatchlist(onboardedWallet);
  const [walletsPanelOpen, setWalletsPanelOpen] = useState(false);

  /**
   * Which watched wallet the Portfolio is SHOWING. Null means the bound one.
   *
   * Viewing is not identity. `onboardedWallet` stays the owner, the signer and
   * the address alerts are sent for, whatever is selected here — the two were
   * one variable until this, which is why the distinction is worth a second
   * name rather than a reassignment.
   */
  const [viewedWalletChoice, setViewedWalletChoice] = useState<string | null>(null);
  // A new bound wallet is a new list, so the old selection cannot survive it:
  // leaving it standing would show the previous owner's watched wallet under
  // the new owner's dashboard.
  useEffect(() => setViewedWalletChoice(null), [onboardedWallet]);

  /**
   * `?view=0x…&tab=advisor`, from the "Open PANIK Advisor" button on a Telegram
   * alert.
   *
   * Applied ONCE, and only after the watchlist has been read: the parameter is
   * only honoured for a wallet the user actually watches, and before the list
   * arrives there is nothing to check it against. Anything else - a wallet that
   * was removed, a malformed value, an unknown tab, no parameter at all -
   * leaves the default view standing without a word, because a deep link is not
   * a place to explain a validation failure. Once is deliberate too: after this
   * the user's own selection owns the switcher, and a re-run would keep
   * dragging them back to the wallet the alert was about.
   *
   * The wallet is applied BEFORE the tab, and that order is the point: the
   * Advisor reads `viewedWallet`, so switching tabs first would show the reader
   * their own position under a message about somebody else's.
   */
  const viewParamApplied = useRef(false);
  useEffect(() => {
    if (viewParamApplied.current || !onboardedWallet || watchlist.subscriptions === null) return;
    viewParamApplied.current = true;
    // What a link may name is `viewableWallets`'s list; this only checks it.
    const wallet = viewParamWallet(
      window.location.search,
      watchlist.subscriptions,
      onboardedWallet,
    );
    if (wallet) setViewedWalletChoice(wallet);
    const tab = deepLinkTab(
      window.location.search,
      TABS.map((t) => t.id),
    );
    if (tab) setActiveTab(tab);
  }, [onboardedWallet, watchlist.subscriptions]);

  /**
   * The selection, VALIDATED against the list on every render.
   *
   * A choice is only honoured while the wallet is still watched. Removing a
   * wallet in the panel while the Portfolio is showing it would otherwise leave
   * the dashboard fetching an address the user just deleted, and the fall back
   * to the bound wallet is the only state that is always true.
   *
   * The list of what may be shown is `viewableWallets`'s, not this memo's.
   */
  const viewedWallet = useMemo(() => {
    if (!onboardedWallet) return null;
    const choice = viewedWalletChoice?.toLowerCase();
    if (!choice) return onboardedWallet;
    const stillWatched = (watchlist.subscriptions ?? []).some(
      (s) => s.wallet.toLowerCase() === choice,
    );
    return stillWatched ? choice : onboardedWallet;
  }, [onboardedWallet, viewedWalletChoice, watchlist.subscriptions]);

  /**
   * The dashboard is showing a wallet the user does not own.
   *
   * Everything that ACTS on a wallet is withheld in this state. Watching an
   * address you do not control is the feature; offering to close its positions
   * is a button that cannot work, and a product that renders it has told the
   * reader something false about what it can do for them.
   */
  const viewingWatchOnly =
    viewedWallet !== null &&
    onboardedWallet !== null &&
    viewedWallet.toLowerCase() !== onboardedWallet.toLowerCase();

  /**
   * The stricter half of the same question, and the one an EXIT has to pass.
   *
   * `viewingWatchOnly` compares the shown wallet against the bound one, which
   * catches somebody else's dashboard and misses the commoner case: a wallet
   * pasted at onboarding is the "own" wallet and still has no signer behind it.
   * An exit is signed by the connected key, so the rule is the identity the
   * `useAccount` binding above already states in prose. See
   * `canActOnViewedWallet`.
   */
  const canActOnViewed = canActOnViewedWallet(viewedWallet, connectedWallet);

  /**
   * The alert level the bound wallet is actually SUBSCRIBED at, or null when we
   * have not read the list. Null renders no claim: the Compass hint below it
   * exists to state a fact, and "we could not reach your watchlist" is not one.
   */
  const subscribedProfile = subscriptionFor(watchlist.subscriptions, onboardedWallet)?.profile ?? null;

  /** What the Portfolio switcher may show. The rule lives in `viewableWallets`. */
  const portfolioWalletOptions = useMemo(
    () => viewableWallets(onboardedWallet, watchlist.subscriptions),
    [onboardedWallet, watchlist.subscriptions],
  );

  const ownLive = useWalletPositions(viewedWallet, selectedRiskProfile, chainMode);

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

  /**
   * The armed market simulation, served with the positions it produced.
   *
   * Gated on the client clock as well as on the server's answer. The API stops
   * applying a scenario the instant its window closes, but this response can be
   * up to a poll old, and a marker that outlives the numbers it describes is
   * the same lie as one that arrives late. Both ends check the same expiry.
   */
  const [simulationNow, setSimulationNow] = useState(() => Date.now());
  const activeSimulation =
    ownLive.simulation && simulationNow < ownLive.simulation.expiresAt ? ownLive.simulation : null;

  // Thirty seconds, not one: the remaining time is rendered at minute
  // granularity (the product bans live tickers), so a faster clock would only
  // re-render the same string.
  useEffect(() => {
    if (!ownLive.simulation) return;
    const t = setInterval(() => setSimulationNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [ownLive.simulation]);
  const coveredProtocolSentence = useMemo(
    () =>
      coveredProtocols.length > 1
        ? `${coveredProtocols.slice(0, -1).join(", ")} and ${coveredProtocols[coveredProtocols.length - 1]}`
        : (coveredProtocols[0] as string),
    [coveredProtocols],
  );

  // AI Advisor (Phase 2): live report for the wallet being VIEWED. Null while
  // offline or pre-onboarding - the tab keeps its Coming-Soon fallback then.
  // On a watched wallet the report is read-only; see `watchOnlyNote` at the
  // render, and `portfolioExitActions` below, which it also feeds.
  const advisorLive = useAdvisor(viewedWallet, selectedRiskProfile, chainMode);

  /**
   * The Advisor's EXIT / REDUCE recommendations, keyed by protocol, for the
   * Portfolio's position rows.
   *
   * Built HERE rather than in `LivePositions` because this is the one place that
   * holds both the positions and the advice. A dashboard row showing a CRITICAL
   * score with no way to act on it made the user go and find the Advisor tab;
   * offering the action on the row is only honest if it is the SAME action, with
   * the same sizing and the same words. So the label and the prefill both come
   * from the engine's recommendation, and a protocol the engine said nothing
   * about gets no button at all.
   *
   * `useMemo` because `LivePositions` takes it as a prop and the advisor object
   * is stable between polls; a fresh object per render would be a new prop
   * identity every time the Portfolio re-rendered for any other reason.
   */
  const portfolioExitActions = useMemo(() => {
    const out: Record<string, { label: string; prefill: ExitPrefill }> = {};
    for (const rec of advisorLive.report?.recommendations ?? []) {
      // The Advisor card's own label and prefill, from the one function that
      // derives them. Two vocabularies for one outcome is how a user ends up
      // believing they are two different things.
      const recommended = recommendedExitAction(rec);
      if (recommended) out[rec.protocol] = recommended;
    }
    return out;
  }, [advisorLive.report]);
  // Atomic Exit modal (Phase 2): opened from Advisor CTAs with a prefill.
  const [exitPrefill, setExitPrefill] = useState<ExitPrefill | null>(null);
  // In-app open flow (Phase 2): opened from Advisor opportunity CTAs and from
  // any Compass/Watch "Open position" whose market the selected chain carries.
  const [openFlowPlan, setOpenFlowPlan] = useState<AdvisorOpenPlan | null>(null);

  /**
   * Route an "Open position" click to the flow that can honor it: one decision
   * point for all three surfaces that offer the button (Compass card, Watch
   * simulator, risk-breakdown modal), so a card cannot promise a real open the
   * modal would then refuse. Everything the chain cannot execute falls back to
   * the DEMO simulator, which signs nothing and says so on every screen. A
   * market the engine holds no parameters for takes the same fallback: sizing
   * a real borrow from the demo catalog's numbers is exactly what the
   * null-over-fallback rule in `lib/utils.ts` (`assetLoanToValue`) forbids.
   *
   * Sizing is the advisor's own rule (`borrowForTargetHf`). The borrow prefill
   * IS the cap in OpenFlow, so the Watch borrow slider deliberately does not
   * carry over: a slider value above the profile cap must not become a
   * pressable plan.
   */
  /**
   * Whether this market's "Open position" reaches a real transaction, or falls
   * back to the DEMO simulator.
   *
   * One predicate, read by the click AND by the render. The Compass card and
   * the Watch header both label the fallback before it is taken, and a label
   * derived from anything else (data freshness, a wallet flag, a hardcoded
   * list) is a claim about the click that the click does not have to honor.
   * `requestOpenPosition` routes on this same function, so the badge and the
   * screen it predicts cannot disagree.
   */
  const opensReal = (preset: VaultPreset) =>
    canOpenInApp(chainMode, preset.engineProtocol, preset.collateralSymbol);

  /**
   * Whether this market's dial is the LISTED score rather than an engine read.
   *
   * Both terms are load-bearing. `compassLive?.[id]` alone is also false while
   * the first poll is in flight, and a badge that flashes on every load teaches
   * the reader to ignore it; `compassFeedDown` alone would badge markets whose
   * scores arrived in a poll that has since started failing, and those figures
   * are the engine's - stale, not invented. Only a market with no live score
   * AND a feed that could not be read is drawing a constant.
   *
   * Same shape as `opensReal` and read by the same two sections, so the card and
   * the breakdown panel behind it cannot disagree about which it is showing.
   */
  const scoreFromFallback = (preset: VaultPreset) =>
    compassFeedDown && !compassLive?.[preset.id];

  /** A Compass card's "stress-test this" press: same landing for both sections. */
  const simulateFromCompass = (preset: VaultPreset) => {
    setSelectedPresetId(preset.id);
    setWatchSource("recommendations");
    setActiveTab("watch");
  };

  const requestOpenPosition = (preset: VaultPreset, collateralUsdOverride?: number) => {
    const params = marketParams(preset.engineProtocol, preset.collateralSymbol);
    // `!params` repeats a term of `opensReal` for the type narrowing only:
    // `params.liquidationThreshold` is read below. The routing decision is the
    // predicate's, and stays in one place.
    if (!opensReal(preset) || !params) {
      setOpenPositionPreset(preset);
      return;
    }
    // An emptied Watch simulator (zero collateral) means no override, not a $0 plan.
    const collateralUsd = Math.round(
      collateralUsdOverride !== undefined && collateralUsdOverride >= 1
        ? collateralUsdOverride
        : preset.defaultCollateral * preset.defaultPrice,
    );
    setOpenFlowPlan({
      protocol: preset.engineProtocol,
      collateralSymbol: preset.collateralSymbol,
      collateralUsd,
      borrowUsd: borrowForTargetHf(
        collateralUsd,
        params.liquidationThreshold,
        TARGET_HF[selectedRiskProfile],
      ),
      // Static fallbacks only: OpenFlow re-scores the plan live via
      // /api/prospective on mount and on every sizing edit. The HF is the
      // profile's target by construction of the borrow above.
      projectedScore: preset.baseRisk,
      projectedHf: TARGET_HF[selectedRiskProfile],
      apy: poolYields?.[preset.id]?.apy ?? preset.apy,
    });
  };

  // Telegram alert linking (Connect Telegram lives in the Settings tab).
  // Each wallet-scoped write signs its OWN action-bound, single-use proof: a
  // "register my wallet" signature must not double as authorization to
  // redirect this wallet's liquidation alerts to a stranger's Telegram.
  const { getProof } = useWalletOwnership();
  const telegramLink = useTelegramLink(getProof);

  /**
   * Sign in: one `session-start` signature for the bound wallet. Never
   * automatic and never forced, so a reader who declines keeps exactly the
   * per-visit behaviour this app had before sessions existed and the only thing
   * a refusal produces is a dismissible line. The in-flight flag lives in the
   * hook (`session.busy`), beside the request it describes.
   */
  const signInThisBrowser = () => {
    if (onboardedWallet) void session.signIn(onboardedWallet, getProof);
  };

  /**
   * Sign out: revoke server-side, then drop what this tab restored.
   *
   * The local reset is conditional on the server having confirmed, and it is a
   * reset of the RESTORED identity only. A connected wallet immediately rebinds
   * through the effect above, which is correct: ending a session is not
   * disconnecting a wallet, and the dashboard has always followed the wallet
   * that is actually connected.
   */
  const signOutThisBrowser = () => {
    void session.signOut().then((done) => {
      if (done) setOnboardedWallet(null);
    });
  };

  // ── Monitoring status (the alerts this product exists to send) ───────────
  // Registration needs a signature the wallet must actually be able to produce.
  // When it fails the user is UNMONITORED, so the failure is surfaced instead
  // of swallowed. Null = fine (or not attempted yet).
  //
  // Held as ONE object rather than a message plus a severity, because the two
  // are read together on every render and two useStates can be set apart.
  const [monitoringIssue, setMonitoringIssue] = useState<{
    message: string;
    severity: MonitoringSeverity;
  } | null>(null);
  const [monitoringBusy, setMonitoringBusy] = useState(false);
  /** `null` when registration succeeded or has not been attempted. */
  const noteMonitoring = useCallback((result: RegisterResult) => {
    setMonitoringIssue(
      result.ok || !result.error || !result.severity
        ? null
        : { message: result.error, severity: result.severity },
    );
  }, []);
  const [monitoringTarget, setMonitoringTarget] = useState<{ wallet: string; profile: WatchRiskProfile } | null>(null);

  const enableMonitoring = useCallback(
    async (wallet: string, profile: WatchRiskProfile) => {
      setMonitoringTarget({ wallet, profile });
      setMonitoringBusy(true);
      const result = await registerWatchedWallet(wallet, profile, getProof);
      noteMonitoring(result);
      setMonitoringBusy(false);
    },
    [getProof, noteMonitoring],
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

  /**
   * Whether an alert could actually reach this user away from this page.
   *
   * Both halves are required and they fail independently: the wallet has to be
   * registered for monitoring (or nothing is ever scored for it) AND a channel
   * has to be linked (or the crossing is recorded and delivered nowhere).
   *
   * It exists because the empty alert log promised delivery unconditionally
   * while Settings, in the same session, said "No alerts are being sent". Only
   * `"connected"` counts: `idle` is the state before the link check has
   * returned, and treating "we have not asked yet" as "you are covered" is the
   * failure this whole flag is here to close.
   */
  const alertsDeliverable = monitoringIssue === null && telegramLink.status === "connected";

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

  // A user portfolio is ONE wallet: the bound one, already fetched per wallet.
  const portfolioPositions = ownLive.positions;

  /**
   * The four Portfolio states, told apart here rather than at four call sites.
   *
   * `null` positions means two completely different things and the tab used to
   * render both as the same grey skeleton: a fetch in flight (wait), and a feed
   * we could not reach (this wallet's exposure is UNKNOWN). DESIGN_SYSTEM calls
   * conflating "nothing to report" with "we could not look" a safety bug, and
   * an unreachable feed rendering as a permanent loading state is the same bug
   * one step earlier — a skeleton says "any second now" for as long as the API
   * is down.
   *
   * `useWalletPositions` already separates them: it holds `positions` at null
   * and raises `offline` on a failed poll, so the distinction costs nothing but
   * naming it.
   */
  const portfolioFeedDown = ownLive.offline;
  /**
   * When the figures on screen were last actually read, or null when the feed
   * never answered.
   *
   * The API's own `updatedAt`, never a local clock: it is the moment the
   * scoring run produced these numbers, and a "we fetched it at" would be a
   * different and less useful fact. Null renders no claim rather than an epoch
   * date, which is the "never render an unknown as a zero" rule applied to a
   * timestamp.
   */
  const lastScoredAt = ownLive.updatedAt > 0 ? SCORED_AT_FORMAT.format(ownLive.updatedAt) : null;
  /**
   * The same reading as an ELAPSED time, for the sidebar's watching block.
   *
   * Two wordings of one timestamp, and they are not interchangeable. The stale
   * notice above says WHEN the last successful read was ("from 07:41"), because
   * a reader deciding whether to trust a frozen figure wants the wall clock.
   * The sidebar says HOW LONG AGO, because it is a background fact glanced at
   * rather than read, and "2 minutes ago" answers "is this current" without any
   * arithmetic. Both come from `ownLive.updatedAt`, so they cannot disagree.
   */
  const walletCheckedAt = checkedAgo(ownLive.updatedAt);
  const portfolioLoading = portfolioPositions === null && !portfolioFeedDown;
  const portfolioEmpty = portfolioPositions !== null && portfolioPositions.length === 0;
  const hasPositions = portfolioPositions !== null && portfolioPositions.length > 0;

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
  const breakdownData = useMemo<BreakdownData | null>(() => {
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
    // null HF = no debt, which only the live path can report; the offline
    // branch derives one from the score and so always has a number.
    const healthFactor = live ? live.healthFactor : Math.round((2.5 - p.baseRisk / 60) * 100) / 100;
    /**
     * Every liquidation figure the panel shows hangs off THAT health factor,
     * through the engine's one `1 - 1/HF`.
     *
     * The API serves `liquidationDrawdown` beside the health factor and the two
     * are the same arithmetic on the same inputs (adapters/prospective.ts), so
     * reading it would buy nothing and the offline branch has no drawdown to
     * serve at all - it would need a literal, and a literal beside a derived
     * health factor is two cells of one panel free to disagree.
     */
    const drawdown = drawdownToLiquidation(healthFactor);
    return {
      isLive: Boolean(live),
      subs,
      /**
       * The health factor as the price move it means, worded and rounded by the
       * engine. The exact ratio stays reachable on `outlook.hover`.
       */
      outlook: liquidationOutlook(healthFactor, p.collateralAsset),
      liqPrice: drawdown != null ? p.defaultPrice * (1 - drawdown) : null,
      poolYield: poolYields?.[p.id] ?? null,
    };
  }, [selectedRiskBreakdownPreset, compassLive, poolYields]);

  // Portfolio history: alert feed + score series for the wallet being VIEWED,
  // which is the bound one unless the switcher says otherwise. The three
  // portfolio feeds move together on purpose: a positions list for one wallet
  // beside an alert log for another is two wallets presented as one.
  const historyWallet = viewedWallet;
  const { history: walletHistory, offline: historyFeedDown } = useWalletHistory(historyWallet);
  /**
   * The same three-way split the position feed gets, for the same reason. An
   * alert log we have not read yet and an alert log we could not read are both
   * "no alerts" to an array length, and only one of them is good news.
   */
  const historyLoading = walletHistory === null && !historyFeedDown;

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
   * The alert log, newest first, sorted ONCE. The card previews the head of this
   * array and the history page groups all of it, so ordering them separately is
   * how the two end up disagreeing about which alert is the most recent. ISO-8601
   * UTC strings compare chronologically as strings, so no Date is built per
   * comparison.
   */
  const alertsNewestFirst = useMemo(
    () => [...(walletHistory?.alerts ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [walletHistory],
  );

  /**
   * The full alert log, as a view inside the Portfolio panel. See
   * `AlertHistoryView` for why it is not a modal and not a sixth tab.
   *
   * Focus has to be handed back by hand because the trigger UNMOUNTS while the
   * view is open: the ref is empty until the card comes back, so the return is
   * an effect on the render that remounts it. `returnFocusToTrigger` is set only
   * by the dismissal paths (Back, Escape). Clicking an alert row also closes the
   * view, but there the position row it points at claims focus, and a second
   * `focus()` racing it would undo the thing the click asked for.
   */
  const [alertHistoryOpen, setAlertHistoryOpen] = useState(false);
  const alertHistoryTrigger = useRef<HTMLButtonElement>(null);
  const returnFocusToTrigger = useRef(false);
  const closeAlertHistory = useCallback(() => {
    returnFocusToTrigger.current = true;
    setAlertHistoryOpen(false);
  }, []);
  useEffect(() => {
    if (alertHistoryOpen || !returnFocusToTrigger.current) return;
    returnFocusToTrigger.current = false;
    alertHistoryTrigger.current?.focus();
  }, [alertHistoryOpen]);
  /* Leaving Portfolio closes it: a view someone navigated away from should not
     be what they find on their way back. No focus return, because focus is
     already in whichever tab they moved to. A wallet switch closes it for the
     harder reason: it replaces the log the view is showing. */
  useEffect(() => {
    if (activeTab !== "portfolio") setAlertHistoryOpen(false);
  }, [activeTab]);
  useEffect(() => setAlertHistoryOpen(false), [historyWallet]);

  // 30d aggregate risk series: bucket snapshots by day, protocols weighted by
  // collateral USD (same weighting the macro Aggregate PANIK risk score uses).
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

  /**
   * Height of the risk-index chart, and of the block that stands in for it
   * before there is a series to draw. One expression, because a placeholder
   * sized independently of the chart is a placeholder that reserves the wrong
   * amount of room.
   *
   * At 220 the crossings of the alert line are legible, which is the one event
   * the chart exists to show. 150 below `lg`, where the whole page is a single
   * narrow column and 220px of chart pushes the tab's other cards off screen.
   */
  const riskChartHeight = isWide ? 220 : 150;

  /**
   * Which Portfolio cards have anything to hold.
   *
   * A card is rendered when it has content, or when it is the thing that
   * EXPLAINS the current state ("reading positions", "we could not reach the
   * feed", "history is still filling in"). It is not rendered to say "there is
   * nothing here" while three of its neighbours say the same: an empty wallet
   * used to get the empty state AND a position card repeating it AND an empty
   * alert feed AND an empty chart.
   */
  const showPositionsCard = hasPositions || portfolioLoading || portfolioFeedDown;
  const showAlertHistory = hasPositions || alertsNewestFirst.length > 0;
  const showRiskHistory = hasPositions || riskHistory !== null;

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
   * The position closest to being liquidated, or null when nothing is borrowed
   * against this wallet.
   *
   * The HEALTH FACTOR is the ordering key, not a drawdown computed here: the
   * engine's `1 - 1/HF` is monotonic in it, so the smallest health factor is
   * the smallest buffer by construction and the UI does not acquire a second
   * copy of that formula to disagree about. A null health factor is a leg with
   * no debt, which has no distance to liquidation at all rather than an
   * infinite one, so it is skipped instead of sorting last.
   *
   * The stat card renders the WORDS through `liquidationOutlook`, which is the
   * same helper the table rows and the Watch tiles read, so "4.8%",
   * "Liquidatable now" and "None" mean the same three things everywhere.
   */
  const closestToLiquidation = useMemo(() => {
    let closest: LiveWalletPosition | null = null;
    let thinnest = Infinity;
    for (const p of portfolioPositions ?? []) {
      if (p.healthFactor === null || p.healthFactor >= thinnest) continue;
      closest = p;
      thinnest = p.healthFactor;
    }
    return closest;
  }, [portfolioPositions]);

  /**
   * The collateral assets whose price feed the engine could not read, for the
   * one card that names them.
   *
   * The COUNT of degraded legs is `liveMacro.unpricedLegs` and stays there; a
   * name is a different fact, and it is the one the reader needs to decide
   * whether the missing figure matters to them. Deduplicated, because two legs
   * of the same asset are one stale feed and "The wstETH, wstETH price feeds
   * are stale" describes an outage that is not happening.
   */
  const stalePriceAssets = useMemo(
    () => [
      ...new Set(
        (portfolioPositions ?? [])
          .filter((p) => p.usdValuesUnavailable === true || p.collateralValueUsd === null)
          .map((p) => p.scoredCollateralSymbol),
      ),
    ],
    [portfolioPositions],
  );

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
   * Same asset on both legs, so the price scenarios below would be answering a
   * question this market cannot be asked. What moves it here is the two legs
   * pricing apart, which is the pair of price controls, not a scenario chip.
   */
  const sameAssetMarket = isSameAssetMarket(activeMarket);

  /**
   * The market listbox's rows, from whichever source Watch is reading.
   *
   * ONE array rather than two branches inside the panel, because `Listbox`
   * addresses a row by INDEX: "the third row" has to mean one thing, and two
   * `.map`s over two lists cannot agree on what it is. Which list is showing is
   * decided here, once, beside the state that decides it.
   */
  const marketChoices: MarketChoice[] = useMemo(
    () =>
      watchingOwnPosition
        ? watchPositionMarkets.map(({ key, position, preset }) => ({
            key,
            protocol: preset.protocol,
            // Never a zero standing in for a size we could not price: a degraded
            // feed says so in words, in the slot the money would have been in.
            line: `${preset.collateralSymbol} · ${
              position.collateralValueUsd === null
                ? "size unavailable (prices degraded)"
                : `${formatCurrency(position.collateralValueUsd)} supplied`
            }`,
            band: preset.riskStatus,
            score: preset.baseRisk,
            commit: () => setSelectedLivePositionKey(key),
          }))
        : presetsWithLive.map((p) => ({
            key: p.id,
            protocol: p.protocol,
            line: p.assetPair,
            band: p.riskStatus,
            score: p.baseRisk,
            commit: () => setSelectedPresetId(p.id),
          })),
    // Nothing about the SELECTION, which is why the rows no longer carry a
    // `selected` flag: a list that is rebuilt every time a reader picks a row
    // in it is rebuilding eight objects to move one marker, and `Listbox`
    // already derives selection from the index below. What the rows are made of
    // is these three, and the two setters are stable.
    [watchingOwnPosition, watchPositionMarkets, presetsWithLive],
  );
  /**
   * Which row is the current value, found by the KEY the selection is held as.
   *
   * One `findIndex` over the load-bearing field rather than a per-row boolean
   * that then has to be searched for anyway: the flag was a second copy of this
   * answer, stored on every row, and one edit away from disagreeing with the
   * state it was derived from.
   *
   * The same guard `WalletSelector` makes for the same reason: a miss is a
   * caller bug, and the first row is the honest thing to open on while it lasts.
   */
  const selectedMarketKey = watchingOwnPosition ? selectedPositionMarket.key : selectedPresetId;
  const marketSelectedIndex = Math.max(
    0,
    marketChoices.findIndex((c) => c.key === selectedMarketKey),
  );

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

  /**
   * The offline fallback score, for the minutes `/api/prospective` is
   * unreachable. It is handed the market's REAL identity now — label and
   * collateral symbol — because the health factor it reports is measured
   * against the engine's listed threshold for that pair. The old call narrowed
   * every protocol that was not Aave to "Moonwell" before a 0.82 / 0.78 literal
   * decided the ratio, so a Morpho position was measured with Moonwell's name
   * and neither protocol's parameter.
   */
  const calculateResult = () =>
    calculateDynamicPosition(
      activeMarket.protocol,
      activeMarket.collateralSymbol,
      collateralAmount,
      borrowUsd,
      assetPrice,
    );

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
  // The collateral slider goes to 0, which is the guard's whole reason to
  // exist: `borrowUsd / 0` rendered "Infinity%" here once.
  const watchLtvPct = loanToValuePct(borrowUsd, watchCollateralValue);
  // The liquidation row's label and hover, from the one helper the Compass
  // panel's equivalent row also reads.
  const watchLiquidationRow = depegAwareOutlook(
    watchOutlook,
    activeMarket.collateralAsset,
    sameAssetMarket,
  );
  /**
   * The loan-to-value parameters the ENGINE lists for the market being
   * simulated, or null when this build holds none for it. Both facts under the
   * loan-to-value row are its figures now; the row used to state "Aave V3
   * liquidates above 82%" from a literal keyed only by protocol, which is not
   * the level Aave liquidates cbBTC (78%) or wstETH (79%) at.
   *
   * Null is also the state `/api/prospective` refuses to score, so an unlisted
   * market has no health factor to state either and the rows say so rather than
   * printing a ratio measured against a threshold nobody listed.
   */
  const watchLimits = assetLoanToValue(activeMarket.protocol, activeMarket.collateralSymbol);
  const watchMarketUnlisted =
    listedLiquidationThreshold(activeMarket.protocol, activeMarket.collateralSymbol) === null;
  const watchLiqPrice = positionState.liquidationPrice;
  /**
   * Dropped whole on a same-asset market with a drop to state, which is exactly
   * the case the row above renames to "Depeg to liquidation": the third clause
   * is a DOLLAR collateral price ("USDC at $0.50"), the one figure the Compass
   * panel withholds on these markets because no dollar move can separate the
   * two legs, and the first two clauses would then sit under a label about a
   * depeg as if they qualified it. The exact health factor is not lost, it
   * opens the row's hover, which is where every other surface keeps it.
   */
  const watchDropSub =
    sameAssetMarket && watchLiquidationRow.statesADrop
      ? ""
      : [
          positionState.healthFactor === null
            ? null
            : `Health factor ${positionState.healthFactor.toFixed(2)}`,
          /* `stripNote` is gone from here, because the row above now promotes
             it into the VALUE. It is non-null in exactly the two cases the
             engine will not express as a percentage, which are the two cases
             the value reads "Liquidatable now" or "None", so leaving it here
             printed the same fact twice on two consecutive lines. */
          watchOutlook.stripNote === null && watchLiqPrice > 0
            ? `${activeMarket.collateralAsset} at ${formatCurrency(watchLiqPrice)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  // The gas reading used to be mirrored into local state, seeded with a
  // literal 2.8 that was on screen until the first poll landed - a fabricated
  // market figure in a product whose whole rule is not to state facts it does
  // not have. The hook's own value is passed straight to the one surface that
  // reads it now (the exit flow's review step), and null there renders no line.

  // Custom simulation handlers for Watch Cockpit
  const handleSimulateCollateralInflow = () => {
    setCollateralAmount(+(collateralAmount * 1.5).toFixed(2));
  };

  const handleSimulateFlashRepay = () => {
    setBorrowAmount(+(borrowAmount * 0.5).toFixed(2));
  };

  // Profile-based filtering for Compass — runs on LIVE engine scores when
  // the API is up (presetsWithLive), static fallbacks otherwise.
  //
  // On testnet the catalog is first cut to markets that can really open there
  // (founder decision): a grid of seven cards whose button lands in the demo
  // simulator reads as broken next to the one that transacts. Mainnet shows
  // the full catalog. The cut uses the SAME `opensReal` predicate the click
  // routes on, so a card shown is a card that works.
  const compassCatalog =
    chainMode === "testnet" ? presetsWithLive.filter(opensReal) : presetsWithLive;
  // The engine's own membership test, and `outside` is its negation by
  // construction rather than a hand-maintained De Morgan of it.
  //
  // This used to be three windows written here (<20 / 20-49 / >=50 by profile)
  // while `ALERT_THRESHOLD` alerts at 25 / 50 / 75, so the grid recommended
  // markets the watcher would fire on and filed the two safest markets in the
  // catalog under "Outside your profile" for an aggressive reader. `fitsProfile`
  // is the same boundary `statusFor` decides alerts with.
  const recommended = compassCatalog.filter((p) => fitsProfile(selectedRiskProfile, p.baseRisk));
  const outside = compassCatalog.filter((p) => !fitsProfile(selectedRiskProfile, p.baseRisk));
  /**
   * The one market this page leads with, and the ONE claim the data supports.
   *
   * There is no fit, match or rank anywhere in the compass payload: `/api/compass`
   * serves an id, a composite, a band and the four sub-scores per market
   * (`CompassLiveScore`), and `VAULT_PRESETS` adds a listed fallback score and an
   * APY. A "best match for you" would therefore be a ranking this component
   * invented, which is exactly the thing the data-honesty rule forbids.
   *
   * So the lead is the lowest PANIK score among the markets that scored UNDER
   * the profile's alert threshold (`fitsProfile`), and the card says that in
   * those words rather than implying a recommendation engine that does not
   * exist. It is arithmetic the reader can check against the seven dials beside
   * it.
   *
   * Null below two cards: "the lowest of one" is a claim with no content, and a
   * section with one card in it has already led with it.
   */
  const compassLead =
    recommended.length > 1
      ? recommended.reduce((best, p) => (p.baseRisk < best.baseRisk ? p : best))
      : null;
  /** The lead first, because position is half of what makes it the lead. */
  const recommendedOrdered = compassLead
    ? [compassLead, ...recommended.filter((p) => p.id !== compassLead.id)]
    : recommended;
  /**
   * Whether an empty Compass section is STATED rather than dropped.
   *
   * Only while the catalog holds something: with NOTHING openable the tab says
   * so once, in its own state below, rather than printing two empty sections
   * that state the same absence twice.
   *
   * NOT gated on the chain. A section that simply vanishes is indistinguishable
   * from a page that failed to load, which is what a moderate profile on the
   * cut Sepolia catalog looked like: one out-of-profile card under a screen of
   * void. The mainnet catalog is fuller but the sections partition it on LIVE
   * engine scores, so a profile whose window no live score falls in empties one
   * of them there too, and the same heading disappears for the same reason.
   */
  const statesEmptySections = compassCatalog.length > 0;

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
    {/* Onboarding overlay. First run: mandatory (no cancel). Every other way in
        — the header chip, the Portfolio invitation, the risk-tier chip — is
        cancellable and says which job it is doing, and a wallet with a saved
        profile skips the quiz entirely.

        The cancel is withheld on the first run, and only while no wallet is
        bound. Both terms are load-bearing: the first is what makes a genuine
        first run mandatory, and the second releases the modal once a wallet
        arrives some other way (a wagmi connect mid-run) rather than holding
        someone inside a flow whose first step has already been answered. */}
    {onboardingIntent && (
      <Onboarding
        mode={onboardingIntent}
        initialWallet={onboardedWallet ?? undefined}
        onComplete={handleOnboardingComplete}
        savedProfiles={savedProfiles}
        onCancel={
          onboardingIntent === "first-run" && !onboardedWallet
            ? undefined
            : () => setOnboardingIntent(null)
        }
      />
    )}

    {/* `w-full`, not `w-screen`: `100vw` includes the classic scrollbar gutter,
        so `w-screen` is itself a source of the horizontal overflow this shell
        then has to hide. Column on a phone so the tab bar can sit at the
        bottom; row on desktop so the sidebar sits alongside. */}
    <div className="flex flex-col md:flex-row h-screen w-full overflow-hidden bg-surface-base text-text-primary font-sans antialiased text-sm">

      {/* 1. LEFT SIDEBAR PANEL (exactly modeled after the Figma UI) */}
      {isDesktop && (
      <aside className={`w-64 h-full shrink-0 flex flex-col justify-between border-r border-border-subtle bg-surface-base p-6 ${LAYER.chrome}`}>

        {/* Sidebar Header Brand block */}
        <div className="space-y-8">
          <div className="flex items-center gap-2.5">
            <img src="/panik-mark.svg" alt="PANIK" width={32} height={32} style={{ objectFit: "contain" }} />
            <span className="font-sans font-extrabold text-lg text-text-primary leading-none">PANIK</span>
          </div>

          <NavTabs
            variant="sidebar"
            activeTab={activeTab}
            onSelect={setActiveTab}
            tabRefs={tabRefs}
            onKeyDown={onTabKeyDown}
          />
        </div>

        {/* The bottom of the rail: which wallet everything above is about, and
            the way out.

            The wallet lives HERE now rather than in the header, and this is the
            fix for three separate complaints at once. The header carried a
            wallet chip that opened onboarding, a "Wallets 2" button that opened
            a sheet, and an account menu, and two of the three were shadowed
            panels that appeared over whatever the reader was looking at. Whose
            money is on screen is true on every tab, so it belongs on the one
            surface that is also on every tab; and the sidebar had 208px of
            permanent empty space under the nav to put it in. */}
        <div className="space-y-4">
          {viewedWallet && portfolioWalletOptions.length > 0 && (
            <WalletSelector
              options={portfolioWalletOptions}
              value={viewedWallet}
              onChange={setViewedWalletChoice}
              checkedAt={walletCheckedAt}
            />
          )}
          <a
            href="/"
            className="group flex cursor-pointer items-center gap-2 font-sans text-xs text-text-secondary no-underline hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-text-muted" />
            <span>Back to landing</span>
          </a>
        </div>
      </aside>
      )}

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-surface-base relative">

        {/* SIMULATED-PRICE MARKER. Above the header and outside the scroller,
            so it is in frame at every scroll position and every width: it must
            be impossible to screenshot an affected figure without it. It is
            served ON the positions payload, so it can never describe a
            different poll than the numbers below it (lib/live.ts). */}
        {activeSimulation && <SimulationBanner simulation={activeSimulation} now={simulationNow} />}

        {/* THE HEADER STRIP IS GONE, and what it held is now wherever the
            reader would go looking for it.

            It was a 64px band carrying, left to right: a risk-profile chip that
            reopened the onboarding quiz, a TESTNET marker that opened Settings,
            a gas reading, a wallet chip that reopened onboarding, a "Wallets 2"
            button that opened a sheet, and an account menu. Six controls, four
            of them navigation to somewhere else, three of them opening a
            floating panel over whatever was being read, and none of them a
            property of the page you were standing on. It is where every
            identifier in the product had accumulated because there was room.

            Where each went, and why there rather than here:
              risk profile   Settings. It is a setting.
              TESTNET        Settings, next to the switch that sets it.
              gas            The exit flow's review step, which is the one place
                             in the product a gas figure changes a decision.
              wallet         The sidebar's watching block, beside the control
                             that switches it.
              Wallets        The Portfolio's own "Add wallet" action.
              account        Settings' account card, with sign out.

            Each tab draws its own `PageHeader` now: the page's name and its one
            action, at 72px, which is the header height this system sets.

            A phone keeps ONE strip, below, and it carries the two things the
            desktop sidebar carries that a bottom tab bar cannot: the mark, and
            the way back to the landing page. */}
        {!isDesktop && (
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b-[3px] border-solid border-border-strong bg-surface-raised px-4">
            <a
              href="/"
              title="Back to landing"
              className="flex shrink-0 items-center gap-2 no-underline"
            >
              <img src="/panik-mark.svg" alt="" width={24} height={24} style={{ objectFit: "contain" }} />
              <span className="font-sans text-sm font-extrabold leading-none text-text-primary">
                PANIK
              </span>
            </a>
            {/* The wallet as an identifier and nothing else: the control that
                changes it is in the Portfolio, which is where a phone reader
                chooses what they are looking at. */}
            {viewedWallet && (
              <span
                title={viewedWallet}
                className="truncate font-mono text-xs font-bold text-text-primary"
              >
                {truncateAddress(viewedWallet)}
              </span>
            )}
          </header>
        )}

        {/* Session-level truths, between the header and the content they
            qualify: a read-only view has to be visible from every tab, and a
            note about the link that brought the reader here belongs with it
            rather than inside whichever tab happened to be open. Both sit
            outside the scroller so neither can be scrolled out of frame. */}
        {readOnlySession && <ReadOnlyBanner onSignIn={signInThisBrowser} busy={session.busy} />}
        {session.note && <SessionNote text={session.note} onDismiss={session.dismissNote} />}

        {/* The advisor notice used to sit HERE, in this band, so it appeared
            over whichever tab happened to be open. It is on the Portfolio now,
            under that tab's own header: a recommendation is about this wallet's
            positions, and a message about positions on Compass or on Settings
            is a message on a screen that is not about them. */}

        {/* PAGE VIEWS SWITCH */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <AnimatePresence mode="wait">
            
            {/* VIEW A: COMPASS TAB (Fully interactive and identical to the requested design layout!) */}
            {activeTab === "compass" && (
              <TabPanel key="compass" tab="compass" gap="space-y-8">
                {/* No action in the header, and no subtitle. The profile
                    toggle used to sit in the action slot, which is where every
                    other tab puts its one verb: a three-way chooser there made
                    the same slot mean "do this" on one tab and "change what
                    this shows" on another. It is a control over the sections
                    below, so it sits with them. */}
                <PageHeader title="Compass" />

                {/* Which profile the two sections below are partitioned on.
                    Three copies of one button became a map over the three
                    profiles, so the selected and unselected treatments cannot
                    drift between them. Lavender for the selected plate, not
                    cobalt: cobalt is the nav's block and means "the section you
                    are in". */}
                <div
                  role="group"
                  aria-label="Which risk profile to browse against"
                  className="flex flex-wrap items-center gap-2"
                >
                  {RISK_PROFILES.map((profile) => {
                    const active = selectedRiskProfile === profile;
                    return (
                      <button
                        key={profile}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelectedRiskProfile(profile)}
                        className={`flex h-12 cursor-pointer items-center hard-edge px-4 label-type text-xs text-text-primary shadow-hard-sm hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-hard-sm active:translate-x-[6px] active:translate-y-[6px] active:shadow-none ${
                          active ? "bg-highlight" : "bg-surface-raised"
                        }`}
                      >
                        {profile}
                      </button>
                    );
                  })}
                </div>

                {/* What this toggle does NOT do, said only when it matters.

                    It moves the thresholds every screen is READ against; it does
                    not touch the level PANIK actually alerts your wallet at,
                    which lives in a signed subscription. That gap was silent:
                    someone could switch to conservative, watch the whole app
                    re-band around them, and still be alerted at the moderate
                    level they signed up with.

                    The fix is a sentence and a link, NOT a signature prompt on
                    the toggle. A wallet popup fired by a display control is the
                    opposite trade - it makes browsing cost consent.

                    Rendered only when the two genuinely differ AND the
                    subscription has been read. A watchlist we could not reach
                    says nothing about what anyone is subscribed at, and a hint
                    guessed from the toggle's own value would be the invented
                    fact this is here to remove. */}
                {subscribedProfile !== null && subscribedProfile !== selectedRiskProfile && (
                  <p className="text-xs font-sans leading-relaxed text-text-secondary">
                    Alerts for your wallet still use the {subscribedProfile} level. Choosing another
                    here changes what you see, not when PANIK warns you.{" "}
                    <button
                      type="button"
                      onClick={() => setWalletsPanelOpen(true)}
                      className="cursor-pointer font-bold text-text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
                    >
                      Change it in Wallets
                    </button>
                  </p>
                )}

                {/* Why the testnet catalog is short. Without this line, one
                    card standing where eight were reads as a loading failure
                    rather than a choice; and the sentence changes what the
                    user does next (switch chains), so it stays inline. */}
                {chainMode === "testnet" && (
                  <p className="text-xs font-sans text-text-secondary">
                    {CHAIN_MODE_LABEL.testnet} shows only the markets that can be opened there.
                    The full catalog is on {CHAIN_MODE_LABEL.mainnet}; switch chains in Settings.
                  </p>
                )}

                {/* Nothing openable at all. One statement, and no hint: the
                    line above already says where the full catalog is and how to
                    get to it. `clear` rather than `problem`, because nothing
                    failed here; this is the coverage the chain has. */}
                {chainMode === "testnet" && compassCatalog.length === 0 && (
                  <EmptyState
                    tone="clear"
                    title={`No market can be opened on ${CHAIN_MODE_LABEL.testnet} yet`}
                  />
                )}

                {/* The empty-section copy is chain-neutral, because the reason
                    a section empties is not: on testnet the catalog is already
                    cut to what can be opened there, on mainnet it is the whole
                    catalog partitioned on live scores, and either can leave a
                    profile with nothing on one side. Naming the chain is
                    enough; "can be opened there" would be false on mainnet. */}
                <MarketSection
                  heading={`Recommended for your ${selectedRiskProfile} profile`}
                  presets={recommendedOrdered}
                  leadId={compassLead?.id}
                  /* The measurement, not a verdict: this app does not rank
                     markets for a person, and saying it did would be the
                     invented fact the data-honesty rule is about. "Within your
                     limit" is what the predicate now computes - membership is
                     one boundary, the profile's alert threshold, so "in this
                     profile" would name a window that no longer exists. */
                  leadNote="Lowest risk within your limit"
                  statesEmpty={statesEmptySections}
                  emptyTitle={`No ${CHAIN_MODE_LABEL[chainMode]} market scores under your risk limit`}
                  /* A measured fact rather than a guess: an empty section is
                     only stated with a non-empty catalog, so an empty
                     `recommended` puts every market in `outside`. */
                  emptyHint="Everything in this catalog is in the section below, outside it."
                  poolYields={poolYields}
                  opensReal={opensReal}
                  scoreFromFallback={scoreFromFallback}
                  onBreakdown={setSelectedRiskBreakdownPreset}
                  onOpen={requestOpenPosition}
                  onSimulate={simulateFromCompass}
                />

                {/* Outside the profile's limits. The per-card "Outside safety
                    triggers" caption is gone: it restated this heading eight
                    words later, once per card, and no card without it is any
                    less clearly filed under it.

                    These cards carry the same "Open position" as the
                    recommended ones. Withholding it did not stop the open, it
                    only made the user leave for the protocol's own app, where
                    nothing sizes the borrow; `requestOpenPosition` sizes every
                    open to the profile's target health factor whichever
                    section it was pressed in, so the position that comes out
                    of an out-of-profile card is still within target. This
                    heading is what says "not recommended".

                    Good news when it is empty, and worth the one line. No hint,
                    because there is nothing further a reader would act on. */}
                <MarketSection
                  heading="Outside your profile"
                  muted
                  presets={outside}
                  statesEmpty={statesEmptySections}
                  emptyTitle={`Every ${CHAIN_MODE_LABEL[chainMode]} market scores under your risk limit`}
                  poolYields={poolYields}
                  opensReal={opensReal}
                  scoreFromFallback={scoreFromFallback}
                  onBreakdown={setSelectedRiskBreakdownPreset}
                  onOpen={requestOpenPosition}
                  onSimulate={simulateFromCompass}
                />

              </TabPanel>
            )}

            {/* VIEW B: WATCH TAB (The high-fidelity mathematical simulator control cockpit!) */}
            {activeTab === "watch" && (
              <TabPanel key="watch" tab="watch">
                {/* Watch had no page heading at all, which is why the shared
                    header exists: four tabs each drew their own and the fifth
                    forgot. No action, because the tab's one control is the
                    source toggle under it and that changes what the page shows
                    rather than doing anything. */}
                <PageHeader title="Watch" />

                {/* Source toggle. Business requirement: Watch mirrors the
                    positions this wallet actually holds on-chain (Current
                    Positions). Recommendations keeps the Compass-derived
                    what-if sandbox for markets you could open.

                    `ChainModeSwitch`'s shape, not a third one: a labelled group
                    of `aria-pressed` buttons, the selected one a neutral filled
                    plate. It is not a tablist. The two options do not swap
                    panels; they change which catalog the ONE simulator below
                    reads, and the app already has exactly one hand-built tabs
                    implementation (`NavTabs`) whose roving tabindex and
                    `tab-*` ids a second, nested copy would have to duplicate.
                    The one-off chip tray this replaces was a third pattern
                    with an 11px label and no state anywhere but the fill. */}
                <div
                  role="group"
                  aria-label="Which markets the simulator reads"
                  className="flex flex-wrap items-center gap-2"
                >
                  {([
                    { key: "positions", label: "Current positions", count: watchPositionMarkets.length as number | null },
                    { key: "recommendations", label: "Recommendations", count: null as number | null },
                  ] as const).map((opt) => {
                    const active = watchSource === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setWatchSource(opt.key)}
                        aria-pressed={active}
                        /* Explicit, because a button's accessible name is its
                           content flattened with no separators: the count pill
                           beside the label announces as "Current positions4". */
                        aria-label={opt.count === null ? opt.label : `${opt.label}, ${opt.count}`}
                        /* Selected is the LAVENDER plate, resting is the white
                           one, and both keep the same edge and shadow. Two
                           plates rather than two greys, which is the same
                           distinction `Card` draws between `lead` and `raised`.

                           Not cobalt: that is the tab rail's block and it means
                           "the section you are in". This chooses which catalog
                           one panel reads, and a second cobalt block on the
                           screen would make the two look like the same kind of
                           control. Not the risk ramp either, for the obvious
                           reason.

                           No hover fill on the resting plate. Filling it with
                           `highlight` would paint it the selected colour under
                           the pointer, which is a control that lies about its
                           own state; the press travel is the affordance.

                           That travel is `BUTTON_PRESS` from ui/Button, copied
                           verbatim rather than approximated: three positions
                           off a `shadow-hard-sm` plate, 3px on hover and 6px
                           and no shadow on active. A shorter two-position
                           version of it is how a screen ends up with two
                           pressable blocks that answer a press differently.
                           The constant is not exported yet, so this is a copy
                           with a note on it rather than an import. */
                        className={`flex h-12 cursor-pointer items-center gap-2 hard-edge px-4 label-type text-xs text-text-primary shadow-hard-sm hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-hard-sm active:translate-x-[6px] active:translate-y-[6px] active:shadow-none ${
                          active ? "bg-highlight" : "bg-surface-raised"
                        }`}
                      >
                        {opt.key === "positions" ? (
                          <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
                        ) : (
                          <CompassIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        )}
                        <span>{opt.label}</span>
                        {/* The count as a NUMERAL, in the mono face every other
                            figure in the product is set in. It used to be a
                            pill, which is a rounded tinted box on a system with
                            no radius and no tints, and both of its fills were
                            translucent white: one of them rendered the digit
                            invisible on the selected plate the moment the plate
                            stopped being dark. */}
                        {opt.count !== null && opt.count > 0 && (
                          <span className="font-mono text-xs font-bold tabular-nums">
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
                    input.

                    The arithmetic, on the CONTENT column rather than the
                    window: content = window - 256 (sidebar) - 64 (p-8), then
                    the 32px gap comes off before the 8/12 and 4/12 shares. At
                    1280 that is 960 content -> 619 / 309; at 1440, 1120 ->
                    725 / 363; at 1024 it would have been 704 -> 448 / 224,
                    which is the number that made `lg` wrong.

                    Both columns are flex and their cards take `xl:flex-auto`,
                    so each column's slack is shared out over the cards in it
                    rather than pooling under the last one. Grid items already
                    stretch to the tallest item in the row, so whichever column
                    is shorter grows to meet the other and the two end level at
                    any market, at any score, with no magic number to go stale.
                    Before this the left column stopped 292px above the rail
                    (measured at 1440x900) and the bottom third of the page was
                    a hole. No `min-h-0` and no internal scroller, for the same
                    reason the Portfolio alert card has neither: a flex child
                    allowed to shrink below its content is a card that clips
                    it. */}
                {/* Simulator Area (xl:col-span-8) */}
                <div className="col-span-1 xl:col-span-8 flex flex-col gap-6">
                  
                  {/* The simulator's summary, as ONE card. Three depths of
                      container around one subject read as three separate
                      subjects; `Card` has exactly two depths, on purpose.

                      `xl:flex-auto` here and on the readings card below, so the
                      two split whatever slack the rail leaves and neither ends
                      with a visible pool of it. `flex-auto`, not `flex-1`:
                      `flex-1` zeroes the basis, which makes two cards holding
                      quite different amounts exactly the same height and puts
                      all of the emptiness in the shorter one. */}
                  <Card tone="raised" className="flex flex-col xl:flex-auto">
                    {/* Wraps on a phone: side by side, the market name took
                        three lines while the action next to it took three of
                        its own, and neither was readable. Stacked, each gets
                        the full width for one line. */}
                    <div className="flex shrink-0 flex-wrap justify-between items-center gap-3 mb-5 border-b border-border-subtle pb-3">
                      {/* Market selector - mode-aware. Positions mode lists the
                          wallet's real on-chain positions; Recommendations lists
                          the Compass preset catalog. */}
                      <div>
                        {/* Sentence case, and two words. The uppercase
                            letter-spaced style was retired everywhere else in
                            the app, and "SCORED ON-CHAIN" was provenance the
                            score's own InfoTip states properly.

                            Three readings, not two: the positions source follows
                            the Portfolio switcher, and "Your position" over a
                            watched wallet's leg would name the wrong owner on
                            the one screen whose numbers are somebody's real
                            money. */}
                        <span className="mb-1 block label-type text-xs text-text-muted">
                          {watchingOwnPosition
                            ? viewingWatchOnly
                              ? "Watched position"
                              : "Your position"
                            : "Simulated market"}
                        </span>
                        {/* The app's listbox, not a second one. This was a
                            button and a `<ul>` with no key handling at all: the
                            list could not be opened, moved through or dismissed
                            from a keyboard, on the screen where a reader
                            compares four positions before acting on one. It
                            also carried its own copy of the outside-click
                            effect. Both are `ui/Listbox` now, which
                            `WalletSelector` also uses, so a fix to either lands
                            on both.

                            The rows are what they were: protocol, the leg, the
                            band as a chip and the score beside it. */}
                        <Listbox
                          label="Which market to score"
                          count={marketChoices.length}
                          selectedIndex={marketSelectedIndex}
                          onCommit={(i) => marketChoices[i].commit()}
                          triggerClassName="group flex items-center gap-2 cursor-pointer"
                          /* `CardTitle`: this is the card's name, and it was the
                             loudest of the five different answers this app gave
                             to what a title looks like (`tracking-wide` where
                             the system's headline tracking is tight). The
                             hover, which faded the whole heading to muted, went
                             with it. There is no motion here, and the trigger's
                             affordance is the chevron the listbox draws beside
                             it, which does not have to dim a heading to be
                             found. */
                          trigger={
                            /* `caseSensitive`: the pair is two tickers, and
                               "CBBTC / USDC" is not the name of a market. */
                            <CardTitle as="h2" size="lg" caseSensitive>
                              {activeMarket.protocol} · {activeMarket.assetPair}
                            </CardTitle>
                          }
                          /* The selected row keeps its left rail, which is the
                             marker this list has always used for "this is the
                             one you are on". The keyboard's row takes the same
                             tint the pointer's does, and only a row that is
                             neither gets the hover. */
                          optionClassName={({ selected, active }) =>
                            `flex cursor-pointer items-center justify-between gap-3 px-4 py-3 ${
                              selected ? "border-l-[3px] border-solid border-l-border-strong" : ""
                            }`
                          }
                          renderOption={(i, { selected }) => (
                            <MarketOptionRow choice={marketChoices[i]} selected={selected} />
                          )}
                        />
                      </div>
                      <div className="flex items-center gap-2.5">
                        {/* Simulate-to-open path: the simulator is where conviction
                            forms, so the open action must be one click away here. */}
                        <Button
                          onClick={() => requestOpenPosition(activeMarket, watchCollateralValue)}
                          className="shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Open position
                        </Button>
                        {/* What the button beside it would do, not how fresh
                            the numbers are: this badge sits against "Open
                            position", so the fact it has to carry is whether
                            that press signs a transaction or opens the demo
                            simulator. Same predicate the press routes on. */}
                        {!opensReal(activeMarket) && <DemoChip />}
                      </div>
                    </div>

                    {/* The score, then what it is made of, stacked.

                        This used to split side by side at `xl`. It does not any
                        more, and the reason is the same arithmetic that set the
                        breakpoint: the left side held three short lines and the
                        right side four bars, so at every width above the split
                        the score column was a 165px block in a 400px space and
                        the card carried a permanent hole. Stacked, both parts
                        get the full 690px of the column, the driver rows stop
                        competing for width with a paragraph, and the card
                        matches the Compass risk-breakdown panel it shares its
                        row treatment with. */}
                    <div className="flex flex-1 flex-col gap-5 text-left">
                      <div className="space-y-2">
                        {/* No icon. Portfolio's stat labels carry none, and a
                            generic pulse glyph beside the score's name adds no
                            information the words are missing. */}
                        <CardTitle
                          as="h3"
                          size="sm"
                          muted
                          hint={`${RISK_SCORE_HINT} Your risk profile sets where alerts fire.`}
                        >
                          {RISK_SCORE_NAME}
                        </CardTitle>

                        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                          <div className="flex items-baseline gap-2">
                            {/* Neutral ink, like every other figure in the
                                product, and set in MONO like every other
                                numeral: a score, a price and a dollar amount
                                all read as readings rather than as prose, and
                                this is the largest reading on the tab. A 40px
                                saturated numeral is the loudest thing a
                                dashboard can emit, and it was saying in the
                                same hue what the chip beside it says. The chip
                                is the band. */}
                            <span className="font-mono text-4xl font-bold tabular-nums text-text-primary">
                              {positionState.riskScore}
                            </span>
                            <span className="font-mono text-sm tabular-nums text-text-muted">/ 100</span>

                            {/* Beside the figure, not at the far edge: a band
                                pushed to the other end of a 690px row leaves a
                                score and the word that reads it with the width
                                of the card between them. */}
                            <RiskChip band={positionState.status} className="ml-1">
                              {BAND_WORD[positionState.status]}
                            </RiskChip>
                          </div>

                          {/* Absent when the simulation sits on the real numbers:
                              there is then no delta, and a zero dressed up as a
                              trend is a movement that did not happen. Neutral ink
                              — the arrow says the direction, and the chip beside
                              it already says the band. */}
                          {scoreDelta !== 0 && (
                            <p className="flex items-center gap-1 font-sans text-xs text-text-secondary">
                              {scoreDelta > 0 ? (
                                <ArrowUp className="h-4 w-4 shrink-0" aria-hidden="true" />
                              ) : (
                                <ArrowDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                              )}
                              <span className="font-mono font-bold tabular-nums">
                                {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta}
                              </span>{" "}
                              vs {watchingOwnPosition ? "your position" : "this market"} now
                            </p>
                          )}
                        </div>

                        {/* One table, not four `&&` branches over the same
                            value: a band the engine gains renders NOTHING under
                            a chain like that, so the card silently loses its
                            verdict rather than failing the build. See
                            `BAND_VERDICT` for the wording. */}
                        <p className="font-sans text-sm leading-relaxed text-text-secondary">
                          {BAND_VERDICT[positionState.status]}
                        </p>
                      </div>

                      <div className="flex flex-1 min-w-0 flex-col">
                        {/* The same four rows the Compass panel draws, from the
                            same component; only the accessor differs, because
                            this surface reads a `PositionState` breakdown whose
                            field names are its own. */}
                        <ScoreBreakdownSection
                          valueOf={(driver) => driver.of(positionState.breakdown)}
                        />

                      </div>
                    </div>
                  </Card>

                  {/* What the score is a score OF, in the row treatment the
                      Compass panel uses for the same job. Liquidation distance
                      leads, because the sliders move collateral, price and debt
                      — the health factor is an OUTPUT here as it is everywhere
                      else, and it is the one figure on this screen a non-expert
                      cannot read. Values and sub-lines come from `watchOutlook`
                      beside `scoreDelta`.

                      The two dollar rows are the figures the ENGINE was handed
                      (`prospectiveArgs`), which the token amounts in the
                      controls are not: move the borrowed price to $0.87 and
                      "105,200 USDC" and "$91,524" stop being the same quantity.
                      They also carry the collateral's worth, which used to be
                      glued onto the collateral slider's maximum-end label as if
                      it were part of the range.

                      Replaced entirely by one line with NO DEBT rather than
                      printing "Loan to value 0%": a position with nothing
                      borrowed has no loan-to-value and no liquidation distance,
                      and that zero is the same lie as a "$0" standing in for an
                      unknown price. The branch reads the borrowed amount rather
                      than the health factor because the offline fallback
                      formula has no null to offer. */}
                  {borrowUsd <= 0 ? (
                    <EmptyState
                      tone="clear"
                      title="No debt on this position"
                      hint={`Nothing is borrowed against your ${activeMarket.collateralAsset}, so there is nothing to liquidate. Raise the borrowed amount to simulate one.`}
                    />
                  ) : (
                    <Card tone="raised" className="xl:flex-auto">
                      <BreakdownSection heading="The position being scored">
                        {/* Label and hover from `depegAwareOutlook`, the same
                            decision the Compass panel's equivalent row makes.
                            The label used to be hard-coded "Drop to
                            liquidation" on the non-depeg branch, which
                            overrode the engine's own switch and printed a drop
                            for a position that is liquidatable now. */}
                        <BreakdownRow
                          label={watchMarketUnlisted ? "Liquidation risk" : watchLiquidationRow.label}
                          hint={
                            watchMarketUnlisted
                              ? UNLISTED_MARKET_HINT
                              : watchLiquidationRow.hint
                          }
                          /* `statValue` wherever there is no drop to state, and
                             `strip` only when there is one.

                             `statesADrop` is false in exactly the two cases the
                             engine refuses to express as a percentage, and this
                             row was printing `strip` through both of them. On a
                             liquidatable-now position that rendered "Liquidation
                             risk / 0%", which is the precise inverse of the
                             truth and the reason `statLabel`/`statValue` exist:
                             the label already stopped saying "Drop to
                             liquidation" here, so the value beside it had to
                             stop being a drop as well. It reads "Liquidatable
                             now" now, and "None" on a position with no debt. */
                          value={
                            watchMarketUnlisted
                              ? "Not measured"
                              : watchLiquidationRow.statesADrop
                                ? watchOutlook.strip
                                : watchOutlook.statValue
                          }
                          note={watchMarketUnlisted ? undefined : watchDropSub || undefined}
                        />
                        <BreakdownRow
                          label="Loan to value"
                          hint={`${LOAN_TO_VALUE_HINT} The closer this gets to the protocol's maximum, the smaller your cushion before liquidation.`}
                          value={watchLtvPct === null ? "No collateral" : `${watchLtvPct}%`}
                          /* The engine's listed figure for THIS asset, or no
                             clause at all. A protocol-wide literal here said
                             Aave liquidates cbBTC above 82% when Aave lists
                             it at 78%. */
                          note={
                            watchLimits === null
                              ? undefined
                              : `${activeMarket.protocol} can liquidate from ${watchLimits.liquidationPct}%`
                          }
                        />
                        {/* The token amount only where it says something the
                            dollars do not. At a simulated price of $1 the two
                            are the same number, so "$2,000" over "2,000 USDC"
                            is one quantity printed twice; the panel drops its
                            note on the same test. */}
                        <BreakdownRow
                          label="Collateral value"
                          hint="Your collateral amount at the simulated collateral price. This is the dollar figure the score is computed on."
                          value={formatCurrency(watchCollateralValue)}
                          note={
                            assetPrice === 1
                              ? undefined
                              : formatPlainAmount(collateralAmount, activeMarket.collateralAsset)
                          }
                        />
                        <BreakdownRow
                          label="Borrowed value"
                          hint="Your borrowed amount at the simulated borrowed price. This is the dollar figure the score is computed on."
                          value={formatCurrency(borrowUsd)}
                          note={
                            debtPrice === 1
                              ? undefined
                              : formatPlainAmount(borrowAmount, activeMarket.debtAsset)
                          }
                        />
                      </BreakdownSection>
                    </Card>
                  )}

                </div>

                {/* The controls column (xl:col-span-4) */}
                <div className="col-span-1 xl:col-span-4 flex flex-col gap-6">

                  {/* Scenario presets (#3): the answer first, sliders second.
                      Same `Card` as everything else on this tab now — it was a
                      hand-typed copy of the raised tone that had drifted to
                      p-6. */}
                  <Card tone="raised" className="space-y-3">
                    <CardTitle
                      as="h3"
                      size="sm"
                      muted
                      hint="Crash and black-swan magnitudes mirror the backtest event set. Each row states how much further the collateral could fall from that price before liquidation, measured with the same liquidation threshold the score uses; hover it for the exact health factor."
                    >
                      Price scenarios
                    </CardTitle>
                    {/* A same-asset market gets the reason instead of the chips.
                        Run against USDC collateral and USDC debt, the four
                        scenarios were reporting "black swan -55%, HF ~1.48",
                        which reads as "you survive USDC going to zero": the
                        chips move the collateral price alone, and on this market
                        that is not a crash, it is a depeg between two legs of the
                        same asset. Stating why is the only version that is true;
                        deleting the panel would leave the market looking
                        unfinished, and re-labelling the chips would keep a
                        magnitude nobody can act on.

                        The fact comes from `sameAssetDepegNote`, shared with the
                        risk-breakdown panel, which has to withhold its dollar
                        liquidation price for exactly this reason. Only the
                        instruction after it is this screen's. */}
                    {sameAssetMarket ? (
                      <p className="text-sm font-sans text-text-secondary leading-relaxed">
                        {sameAssetDepegNote(activeMarket.collateralAsset)} Set the two price controls
                        below apart to simulate it.
                      </p>
                    ) : (
                    /* Hairlines, not four bordered tiles inside a bordered card.
                       Selection is carried the way the market dropdown above
                       carries it — a `border-l-2` accent plus a background
                       shift — which is legible without giving every row an edge
                       of its own, and `aria-pressed` states it for a reader who
                       cannot see either. */
                    <div
                      role="group"
                      aria-label="Collateral price scenario"
                      className="divide-y divide-border-subtle border-t border-border-subtle"
                    >
                      {PRICE_SCENARIOS.map((s) => {
                        const price = scenarioPrice(s.pct);
                        /* The ENGINE's health factor for this row's price, from
                           `estimateHealthFactor` against the threshold `MARKETS`
                           lists for this exact pair. It used to be a second copy
                           of collateral x LT / debt run against a 0.82 / 0.78
                           literal keyed only by protocol, so these rows and the
                           card beside them stated two different health factors
                           for one position. Null here is a market we hold no
                           parameters for, and the row then states nothing. */
                        const estHf = simulatedHealthFactor(
                          activeMarket.protocol,
                          activeMarket.collateralSymbol,
                          collateralAmount * price,
                          borrowUsd,
                        );
                        const active = activeScenario === s.key;
                        /* The price-drop buffer, not the ratio, in the wording
                           every other surface uses for a health factor:
                           `liquidationOutlook` converts it with the engine's own
                           `1 - 1/HF` and rounds it with the engine's own policy,
                           and the exact ratio stays one hover away. "HF ~1.46"
                           was the last raw ratio left in the product. */
                        const outlook = liquidationOutlook(estHf, activeMarket.collateralAsset);
                        const consequence =
                          estHf === null
                            ? null
                            : outlook.stripNote === null
                              ? `${outlook.statValue} to liquidation`
                              : outlook.statValue;
                        // Each of these renders twice per row, once visibly and
                        // once in the accessible name. Formatted once so the
                        // two cannot round the same number differently, and so
                        // four rows do not pay for eight `Intl` formats on
                        // every slider frame.
                        const priceText = formatCurrency(price);
                        const magnitude =
                          s.pct === 0 ? s.note : `${s.note}, ${Math.round(s.pct * 100)}%`;
                        return (
                          <button
                            key={s.key}
                            type="button"
                            aria-pressed={active}
                            /* Built from the same values the row draws, for the
                               same reason the toggle above carries one: flattened
                               without separators this row announces as
                               "Current$2,000market priceHF ~1.46". */
                            aria-label={[s.label, priceText, magnitude, consequence]
                              .filter(Boolean)
                              .join(", ")}
                            onClick={() => applyScenario(s.key, s.pct)}
                            /* The selected row is a 3px black rail and the
                               sunken plate, which is `Card`'s own `set-back`
                               pair. Both of the fills this replaces were
                               translucent WHITE, so on paper the selected row
                               and the hovered row were the same white as the
                               card and the rail was carrying the state alone at
                               2px. */
                            className={`block w-full cursor-pointer border-l-[3px] border-solid py-3 pl-3 pr-1 text-left ${
                              active
                                ? "border-l-border-strong bg-surface-sunken"
                                : "border-l-transparent hover:bg-surface-sunken"
                            }`}
                          >
                            <span className="flex items-baseline justify-between gap-3">
                              <span
                                className={`font-sans text-xs ${active ? "font-bold text-text-primary" : "text-text-secondary"}`}
                              >
                                {s.label}
                              </span>
                              <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-text-primary">
                                {priceText}
                              </span>
                            </span>
                            <span className="mt-0.5 flex items-baseline justify-between gap-3">
                              {/* The scenario's magnitude, not a measurement of
                                  anything. It defines which row this is ("Crash"
                                  is -40%), so it reads as a label and is inked
                                  like one, beside the event it is named for. */}
                              <span className="font-sans text-xs text-text-muted">
                                {magnitude}
                              </span>
                              {consequence !== null && (
                                /* No hue, on either branch. "Liquidatable now"
                                   was the one coloured verdict left on this tab,
                                   and at a -20% stress it is three rows of it at
                                   once, which is not the handful the ramp is
                                   rationed to; the words already say the whole
                                   thing without help, and the band the reader
                                   should act on is the chip on the score. The
                                   preview beside it used to run its own
                                   green/amber/red ramp cut at 1.3, a fourth set
                                   of thresholds on a screen that already had
                                   three.

                                   `title` rather than an InfoTip: the tip's
                                   anchor cannot wrap and this column is ~280px,
                                   which is the same call the position rows make
                                   for the same clause. */
                                <span
                                  title={outlook.hover}
                                  className="shrink-0 cursor-help font-mono text-xs font-bold tabular-nums text-text-secondary"
                                >
                                  {consequence}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </Card>

                  {/* Advanced parameters (#4): direct inputs for amounts + prices.

                      Hairline rows, like the scenarios above. Each control used
                      to sit in its own tinted, bordered, rounded well inside
                      this bordered card, which is four boxes drawn to say
                      "these four things are separate" about four rows a divider
                      already separates. The hover tint went with them: it lit up
                      a container the pointer was only crossing to reach the
                      slider, and it stated nothing about state. */}
                  <Card tone="raised" className="flex flex-col xl:flex-auto">
                    <CardTitle as="h3" size="sm" muted>
                      Adjust the position
                    </CardTitle>

                    <div className="mt-3 divide-y divide-border-subtle border-t border-border-subtle">
                    {/* Collateral amount */}
                    <div className="space-y-2 py-4">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Collateral ({activeMarket.collateralAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultCollateral < 10 ? 0.1 : 100}
                          value={collateralAmount}
                          onChange={(e) => setCollateralAmount(Math.max(0, Number(e.target.value)))}
                          className={WATCH_NUMBER_FIELD}
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
                        className={WATCH_SLIDER}
                        id="watch-collateral-slider"
                      />
                      {/* Both ends state the END, in the shape the price slider
                          below uses. The right one used to read "2.5x, worth
                          $128,500" where the dollars were the CURRENT holding,
                          not the maximum the label names: one clause, two
                          unrelated facts, and the reader gets the wrong one. */}
                      <div className={WATCH_SLIDER_ENDS}>
                        <span>0</span>
                        <span>2.5x ({formatCurrency(activeMarket.defaultCollateral * 2.5 * assetPrice)})</span>
                      </div>
                    </div>

                    {/* Collateral price. Named for the LEG, not the asset: on a
                        USDC-collateral, USDC-debt market "USDC price" was the
                        label on both this control and the debt one below, two
                        sliders reading the same words and driving different
                        halves of the position. The leg is what tells them apart,
                        and it is also what the amount rows above are named for. */}
                    <div className="space-y-2 py-4">
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
                          className={WATCH_NUMBER_FIELD}
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
                        className={WATCH_SLIDER}
                        id="watch-price-slider"
                      />
                      <div className={WATCH_SLIDER_ENDS}>
                        <span>-60% ({formatCurrency(activeMarket.defaultPrice * 0.4)})</span>
                        <span>+30% ({formatCurrency(activeMarket.defaultPrice * 1.3)})</span>
                      </div>
                    </div>

                    {/* Borrowed amount */}
                    <div className="space-y-2 py-4">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Borrowed ({activeMarket.debtAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={activeMarket.defaultBorrow < 10 ? 0.1 : 50}
                          value={borrowAmount}
                          onChange={(e) => setBorrowAmount(Math.max(0, Number(e.target.value)))}
                          className={WATCH_NUMBER_FIELD}
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
                        className={WATCH_SLIDER}
                        id="watch-borrow-slider"
                      />
                      <div className={WATCH_SLIDER_ENDS}>
                        <span>0</span>
                        <span>+60% debt</span>
                      </div>
                    </div>

                    {/* Borrowed asset price (depeg scenarios) */}
                    <div className="space-y-2 py-4">
                      <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1 text-xs font-sans text-text-secondary">
                        <span>Borrowed price ({activeMarket.debtAsset})</span>
                        <input
                          type="number"
                          min={0}
                          step={0.005}
                          value={debtPrice}
                          onChange={(e) => setDebtPrice(Math.max(0, Number(e.target.value)))}
                          className={WATCH_NUMBER_FIELD}
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
                        className={WATCH_SLIDER}
                        id="watch-debt-price-slider"
                      />
                      <div className={WATCH_SLIDER_ENDS}>
                        <span className="flex items-center gap-1">
                          $0.85 depeg
                          <InfoTip text="USDC fell to $0.87 during the SVB weekend in March 2023, which is the event this end of the range is scaled to." />
                        </span>
                        <span>$1.05 premium</span>
                      </div>
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
                {/* "Advisor", not "AI Advisor". The tab in the rail says
                    Advisor, and a screen whose heading names the technology
                    rather than the job is the same leak as printing an engine
                    enum: what the reader came here for is what to do about
                    their positions. The one line of AI provenance that is
                    genuinely owed is `AI_PROSE_NOTE`, at the foot of the panel
                    below, where it states the fact and stops. */}
                <PageHeader title="Advisor" />

                {advisorLive.report ? (
                  <AdvisorPanel
                    report={advisorLive.report}
                    onExit={viewingWatchOnly ? undefined : (prefill) => setExitPrefill(prefill)}
                    onOpen={viewingWatchOnly ? undefined : (plan) => setOpenFlowPlan(plan)}
                    /* The Advisor follows whichever wallet the Portfolio is
                       showing, so on a watched one it is reading somebody
                       else's positions. The note is what turns that from a
                       missing button into a stated fact. */
                    watchOnlyNote={
                      viewingWatchOnly && viewedWallet
                        ? `This report is about ${truncateAddress(viewedWallet)}, a wallet you watch. PANIK cannot act on it, so no action is offered here.`
                        : undefined
                    }
                  />
                ) : advisorLive.offline ? (
                  /* `problem`, and it must not resemble the card below it. A
                     service we could not reach rendering as "Advisor is not
                     live yet" tells someone a feature was never built, on a tab
                     that is built and would have had something to say about
                     their position. The alert feed's split, one tab over.

                     `offline` excludes a 404 (see useAdvisor), so a deployment
                     that genuinely does not mount the route still falls through
                     to the card below. */
                  <div className="max-w-2xl mx-auto my-8">
                    <EmptyState
                      tone="problem"
                      title="Advisor unavailable"
                      hint="We could not reach the advisor service, so what it would say about this wallet is unknown right now. That is not the same as it having nothing to flag."
                    />
                  </div>
                ) : (
                /* `lead`, and it is the only card on this branch, which is the
                   condition the tone is rationed to: there is one thing to read
                   here and lavender says so without making a claim about a
                   position, because `highlight` is nowhere on the risk ramp.

                   Left-aligned, like every other card in the product. The
                   centred column this replaces was a 12th-scale `p-12` well with
                   a rounded avatar plate on top, which is three things the
                   system does not have: a radius, a tinted translucent surface,
                   and a layout that agrees with nothing beside it. */
                <Card tone="lead" className="mx-auto my-8 flex max-w-2xl flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                      <CardTitle as="h2" size="lg">
                        The Advisor is not open yet
                      </CardTitle>
                      {/* What it will DO, in the reader's terms. What this
                          replaced was "guardrail recommendations and sized
                          action plans are still in parameter audit on Base",
                          which is four pieces of jargon and no statement of
                          what the reader gets or when. The second sentence is
                          the honest half: it says what is holding it, without
                          promising a date the code does not know. */}
                      <p className="mt-2 font-sans text-sm leading-relaxed text-text-secondary">
                        It will read the positions in this wallet and say what to do about each
                        one, sized to the risk profile you set. We are still checking those
                        numbers against Base, and nothing lands on this screen until they hold.
                      </p>
                    </div>
                  </div>

                  {/* Recorded in this browser and nowhere else, which is what
                      the wording has to survive: "notify me" promised a message
                      from a service that has no address to send one to. */}
                  <label className="flex cursor-pointer select-none items-center gap-3 self-start">
                    <input
                      type="checkbox"
                      checked={advisorNotifyChecked}
                      onChange={(e) => {
                        setAdvisorNotifyChecked(e.target.checked);
                        localStorage.setItem("panik_advisor_notify", String(e.target.checked));
                      }}
                      className="h-5 w-5 shrink-0 cursor-pointer hard-edge bg-surface-raised accent-brand"
                    />
                    <span className="font-sans text-sm text-text-secondary">
                      Remember that I want this when it opens
                    </span>
                  </label>
                </Card>
                )}
              </TabPanel>
            )}

            {/* VIEW D: PORTFOLIO TAB (Aggregate Vaults Portfolio Under Protective Firewall) */}
            {/* VIEW D1: the full alert log. Same panel and same key as the
                dashboard below, so Portfolio stays the selected tab and
                `panel-portfolio` keeps the `aria-labelledby` pair the tabs
                pattern needs; only what the panel contains changes. Two branches
                rather than a ternary inside one, so the dashboard's markup and
                its indentation are untouched by this. */}
            {activeTab === "portfolio" && alertHistoryOpen && (
              <TabPanel key="portfolio" tab="portfolio">
                <AlertHistoryView
                  alerts={alertsNewestFirst}
                  protocolLabel={LIVE_PROTOCOL_LABEL}
                  targets={alertTargets}
                  onSelectTarget={(key) => {
                    // Back to the dashboard, because the position this alert is
                    // about is on it. LivePositions scrolls the row into view and
                    // takes focus from there, which is why this path does not
                    // return focus to the trigger.
                    setAlertHistoryOpen(false);
                    setHighlightedPositionKey(key);
                  }}
                  onClose={closeAlertHistory}
                  deliveryConnected={alertsDeliverable}
                  onConnectAlerts={() => {
                    closeAlertHistory();
                    setActiveTab("settings");
                  }}
                />
              </TabPanel>
            )}

            {activeTab === "portfolio" && !alertHistoryOpen && (
              <TabPanel key="portfolio" tab="portfolio">
                {/* STATE 1 of 4 - no wallet. The whole surface is the
                    invitation: no header, no stat row, no cards. Nothing below
                    knows anything yet, and a dashboard of empty containers is
                    not a smaller version of the dashboard, it is a different
                    and worse screen. */}
                {!boundMode ? (
                  <FirstRunInvite
                    onAddWallet={() => setOnboardingIntent("switch-wallet")}
                    chainLabel={coveredChainLabel}
                    protocolSentence={coveredProtocolSentence}
                  />
                ) : (
                <>
                {/* The shared header, on all five tabs. Which wallet this page
                    is about is NOT here any more: it is the sidebar's watching
                    block, beside the switch that changes it, because "whose
                    money is this" is a property of the whole session rather
                    than of this one tab.

                    One action, and it is the one this page cannot do without: a
                    dashboard about watched wallets has to be able to add one.
                    Withheld while a watched wallet is on screen, because the
                    list it edits belongs to the reader and this page is
                    describing somebody else's money. */}
                <PageHeader
                  title="Portfolio"
                  action={
                    viewingWatchOnly ? undefined : (
                      <Button onClick={() => setWalletsPanelOpen(true)}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Add wallet
                      </Button>
                    )
                  }
                />

                {/* The watching block, on a phone, where there is no sidebar to
                    put it in. Here rather than in the phone's top strip because
                    it is three lines and a control, and because the Portfolio
                    is the tab a reader chooses a wallet on: the strip carries
                    the address as an identifier and this carries the switch. */}
                {!isDesktop && viewedWallet && portfolioWalletOptions.length > 0 && (
                  <WalletSelector
                    options={portfolioWalletOptions}
                    value={viewedWallet}
                    onChange={setViewedWalletChoice}
                    checkedAt={walletCheckedAt}
                  />
                )}

                {/* What the Advisor would say about this wallet, under the
                    header and over the figures it is about. It renders nothing
                    unless there is a recommendation to make, and nothing at all
                    on a watched wallet: its whole shape is an offer to act, and
                    the action here would be exiting a position the reader does
                    not hold. */}
                {!viewingWatchOnly && (
                  <AdvisorPopup
                    report={advisorLive.report}
                    onExit={(prefill) => setExitPrefill(prefill)}
                    onOpen={(plan) => setOpenFlowPlan(plan)}
                    onView={() => setActiveTab("advisor")}
                  />
                )}

                {/* STATE 3 of 4 - we reached the feed and this wallet holds
                    nothing. "clear", not "problem": that is good news and it is
                    safe to say so. ONE sentence and one affordance, per the
                    primitive's contract. The invitation it used to carry
                    ("browse risk-scored opportunities matched to your moderate
                    profile") named the reader's profile at them, described a
                    ranking Compass does not perform, and was an instruction a
                    watch-only reader could not follow. */}
                {portfolioEmpty && (
                  <EmptyState
                    tone="clear"
                    title="No positions yet"
                    hint="We read this wallet and found no open lending positions."
                    action={
                      viewingWatchOnly ? undefined : (
                        <Button variant="secondary" onClick={() => setActiveTab("compass")}>
                          Open Compass
                        </Button>
                      )
                    }
                  />
                )}

                {/* STATE 2 of 4 - a fetch is genuinely in flight. A reserved
                    block, not a figure: the four cards used to print $18,450 /
                    $9,310 / 50% / 22 from string literals whenever `liveMacro`
                    was null, which is exactly the window in which the code
                    knows nothing at all.

                    `portfolioLoading`, not `positions === null`. Null also
                    covers a feed we could not reach, and a skeleton renders
                    that as "any second now" for as long as the API is down -
                    which is how a permanently unreachable endpoint came to look
                    like a slow one. State 4 is the position card's `problem`
                    panel instead, and it says so in words. */}
                {portfolioLoading && (
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                    {["collateral", "debt", "positions", "buffer"].map((slot) => (
                      <Card key={slot} tone="raised">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="mt-2 h-9 w-32" />
                        {/* Every one of the four lands with a subline, so all
                            three lines are held open: a 98px card becoming a
                            124px one under the reader is the jump this exists
                            to prevent. */}
                        <Skeleton className="mt-2 h-4 w-24" />
                      </Card>
                    ))}
                  </div>
                )}

                {/* STATE 4 of 4, on the cards rather than on the list.

                    A poll that fails after one has succeeded raises `offline`
                    and KEEPS the positions it last read, so `liveMacro` keeps
                    summing them and the cards below carried on stating a
                    monitored total as current while the position list under them
                    said the feed was unreachable. One screen, two contradictory
                    claims about one wallet, and the one making the safety claim
                    was the one that looked fine.

                    The figures stay, because a reader whose feed just went down
                    still wants their last-known numbers. What changes is that
                    the screen says how old they are, in the words the feed's
                    own timestamp supports and no stronger. */}
                {portfolioFeedDown && liveMacro && (
                  <EmptyState
                    tone="problem"
                    title="These figures are not being updated"
                    hint={`We could not reach the scoring feed, so everything below is the last successful read${lastScoredAt ? `, from ${lastScoredAt}` : ""}. Nothing here has been rescored.`}
                  />
                )}

                {/* Nothing on this wallet could be priced. Stated once, above
                    the figures, because every dollar total below is then a
                    blank rather than a number. `problem`, not `clear` - this is
                    "we could not look", which is never good news.

                    Suppressed while the feed is down: the notice above already
                    says these numbers are not current, and two hatched panels
                    stacked make the reader work out which one is the real
                    problem. */}
                {!portfolioFeedDown && liveMacro && liveMacro.capital === null && (
                  <EmptyState
                    tone="problem"
                    title="Dollar amounts are unavailable for this wallet"
                    hint="A price feed PANIK converts these positions with is missing or stale, so there is no portfolio total to show. Each position's own score and outlook below are unaffected, because they are ratios."
                  />
                )}

                {/* The stat row. Rendered only when there are real positions to
                    summarise, so every figure comes from `liveMacro` and there
                    is no literal for it to fall back to. An empty wallet gets
                    the EmptyState above and no cards at all, because "No
                    positions yet" directly over a dashboard stating a monitored
                    total is the screen contradicting itself.

                    1 -> 2 -> 4. The old jump straight from 1 to 4 at `sm` gave
                    each card ~150px at 640px wide, which is narrower than the
                    figure inside it, so every card in the row ellipsised at
                    once. Four across is only earned at `xl`. */}
                {liveMacro && (() => {
                  // Legs the engine could not price contribute nothing to the
                  // dollar-weighted figures here, so each one is a FLOOR and
                  // not the wallet. A numeral that quietly drops a position is
                  // the failure this screen is least able to survive, so the
                  // shortfall is stated rather than left to the reader.
                  //
                  // The visible marker is one sub-line, on the collateral card,
                  // and it is deliberately short: `Stat` truncates its sub to a
                  // single line, so a caveat long enough to be cut is a caveat
                  // that disappears exactly when the card gets narrow. The
                  // sentence explaining it is the right rail's feed card.
                  const unpriced = liveMacro.unpricedLegs;
                  const unpricedNote =
                    unpriced === 0
                      ? null
                      : unpriced === 1
                        ? "One position not priced"
                        : `${plural(unpriced, "position")} not priced`;
                  // One rendering for "we could not measure this", in the value
                  // slot where a number would otherwise go. The treatment is
                  // `RISK_CHIP.UNKNOWN`, the same hatch a degraded position row
                  // uses, so the marker means the same thing everywhere: shape,
                  // icon and words, no hue, and no number standing in for a
                  // blank.
                  const notMeasured = (
                    <span
                      className={`inline-flex items-center gap-1.5 hard-edge px-2 py-0.5 font-sans text-base font-semibold ${RISK_CHIP.UNKNOWN}`}
                    >
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Not measured
                    </span>
                  );
                  // The buffer's own wording comes from the engine's outlook
                  // helper, so "4.8%", "Liquidatable now" and "None" are the
                  // same three answers this figure gives on every other screen.
                  const bufferOutlook = liquidationOutlook(
                    closestToLiquidation?.healthFactor ?? null,
                    closestToLiquidation?.scoredCollateralSymbol ?? "",
                  );
                  return (
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                      <Card tone="raised">
                        <Stat
                          size="lg"
                          label="Total collateral"
                          /* No subline when every leg is priced: the figure and
                             the label already say everything this card knows.
                             When one is not, the sub-line is the only thing
                             standing between this figure and a lie. */
                          sub={unpricedNote}
                          value={
                            liveMacro.capital === null ? notMeasured : formatUsd(liveMacro.capital)
                          }
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          size="lg"
                          label="Total debt"
                          value={liveMacro.debt === null ? notMeasured : formatUsd(liveMacro.debt)}
                          /* No ratio when either side of it is unknown. "Net
                             loan to value 0%" was the reassuring end of the
                             same bug: a wallet with no readable prices reads as
                             a wallet with no debt. */
                          sub={
                            liveMacro.ltv === null
                              ? "Net loan to value not measured"
                              : `Net loan to value ${Math.round(liveMacro.ltv * 100)}%`
                          }
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          size="lg"
                          label="Positions"
                          value={liveMacro.positions}
                          sub={`Across ${plural(liveMacro.protocols, "protocol")}`}
                        />
                      </Card>

                      <Card tone="raised">
                        <Stat
                          size="lg"
                          label="Liquidation buffer"
                          value={bufferOutlook.statValue}
                          /* Which position the figure is about, because a
                             wallet-level buffer that does not name its leg is a
                             number nobody can act on. "No debt on this wallet"
                             is the honest reading of the other branch: nothing
                             is borrowed, so there is nothing to liquidate. */
                          sub={
                            closestToLiquidation
                              ? `Closest position, ${LIVE_PROTOCOL_LABEL[closestToLiquidation.protocol]}`
                              : "No debt on this wallet"
                          }
                        />
                      </Card>
                    </div>
                  );
                })()}

                {/* ONE grid, three rows. Row 1 is the positions table beside
                    the rail that qualifies it; row 2 splits the allocation and
                    the alert log; row 3 is the score history across all twelve.
                    Grid items in one row end on the same line by definition, so
                    nothing here is a column padded to match its neighbour.

                    `lg` is the breakpoint, and it is measured on the WINDOW
                    while the split happens in the CONTENT column: at a 1024px
                    window the sidebar and padding leave 698px of content, so
                    the 8 and 4 tracks measure 454px and 220px at the moment
                    they first appear. Below `lg` everything stacks full width
                    in DOM order.

                    The whole grid is gated on there being something to put in
                    it. An empty wallet used to get this row anyway: a card
                    repeating "no open positions" under the empty state that had
                    just said it, an alert feed saying "no alerts yet", and a
                    chart saying history would build. */}
                {(showPositionsCard || showAlertHistory || showRiskHistory) && (
                <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
                  {/* Row 1, left: the position table - loading, unreachable, or
                      holding rows. The zero-position case is the page-level
                      empty state above and never reaches here. */}
                  {showPositionsCard && (
                  <div className="grid min-w-0 lg:col-span-9">
                    <LivePositions
                      positions={portfolioPositions}
                      highlightKey={highlightedPositionKey}
                      offline={portfolioFeedDown}
                      chain={ownLive.chain}
                      /* No exit control at all unless a connected key could
                         sign one for the wallet on screen, rather than a
                         disabled one: `exitControlState`'s two "why not"
                         sentences are about the chain and about the flow being
                         wired in, and neither is the reason here. A row with no
                         action is the honest shape when the action was never
                         available to offer. */
                      exitActions={canActOnViewed ? portfolioExitActions : undefined}
                      onExit={canActOnViewed ? (prefill) => setExitPrefill(prefill) : undefined}
                      onStressTest={(pos) => {
                        // Bridge: open THIS real position in the Watch simulator.
                        setSelectedLivePositionKey(`${pos.wallet}:${pos.protocol}:${pos.scoredCollateralSymbol}`);
                        setWatchSource("positions");
                        setActiveTab("watch");
                      }}
                    />
                  </div>
                  )}

                  {/* Row 1, right: the three things that qualify the table
                      beside it - where alerts go, which feed is missing, and
                      what was scanned. None of them is a position, which is why
                      none of them is in the table. */}
                  {showPositionsCard && (
                  <div className="flex flex-col gap-6 lg:col-span-3">
                    {/* The screen's ONE `lead` card, and it is spent here on
                        purpose: whether an alert can reach this reader away
                        from this page is the single thing on the tab they
                        cannot work out by looking at the numbers. Lavender is
                        nowhere on the risk ramp, so the loudest box on the page
                        makes no claim about any position in it. */}
                    <Card tone="lead" className="space-y-3">
                      <span className="flex items-center gap-2 label-type text-xs text-text-primary">
                        <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Alerts
                      </span>
                      <CardTitle as="h3" size="lg">
                        {alertsDeliverable ? "Telegram connected" : "Telegram not connected"}
                      </CardTitle>
                      {/* One line, and only on the branch where there is
                          something to do about it. "PANIK messages you when a
                          position crosses your limit" under "Telegram
                          connected" is the heading restated, which is the copy
                          rule's delete case. */}
                      {!alertsDeliverable && (
                        <p className="font-sans text-sm leading-relaxed text-text-primary">
                          No alerts are being sent for this wallet.
                        </p>
                      )}
                      <Button
                        variant="secondary"
                        className="w-full justify-center"
                        onClick={() => setActiveTab("settings")}
                      >
                        Alert rules
                      </Button>
                    </Card>

                    {/* Only when a feed is genuinely stale, and only when it is
                        SOME of them: with nothing priced at all the page-level
                        notice above already says so, and two panels about one
                        outage is the reader working out which is the real one.
                        It names the asset, which is the one thing the stat
                        card's truncated sub-line cannot. */}
                    {liveMacro !== null && liveMacro.capital !== null && stalePriceAssets.length > 0 && (() => {
                      // One test, four readings of it. Spelled out at each of
                      // the four and they can disagree, which in English means
                      // "The cbBTC price feeds are stale, so that position is".
                      const one = stalePriceAssets.length === 1;
                      return (
                        <Card tone="raised" className="space-y-2">
                          <span className="flex items-center gap-2 label-type text-xs text-text-muted">
                            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                            {one ? "One feed missing" : plural(stalePriceAssets.length, "feed") + " missing"}
                          </span>
                          <p className="font-sans text-sm leading-relaxed text-text-secondary">
                            {`The ${stalePriceAssets.join(", ")} price ${one ? "feed is" : "feeds are"} stale, so ${one ? "that position is" : "those positions are"} left blank rather than counted as zero.`}
                          </p>
                        </Card>
                      );
                    })()}

                    {/* What was actually scanned, from the payload rather than
                        from a constant: a Base Sepolia reader must not be told
                        three protocols with no market there were checked and
                        found empty. The marks are the same ones the coverage
                        row has always drawn; the dimmed ones are covered and
                        empty.

                        Gated on the summary having arrived, because which marks
                        are lit is a fact about the wallet: with no positions
                        read yet every mark would be dimmed, which says PANIK
                        looked and found nothing rather than that it has not
                        looked. */}
                    {liveMacro !== null && (
                    <Card tone="raised" className="flex flex-1 flex-col gap-3">
                      <span className="label-type text-xs text-text-muted">Coverage</span>
                      <ProtocolMarks
                        protocols={liveMacro.protocolNames}
                        covered={coveredProtocols}
                      />
                      <span className="mt-auto font-mono text-sm font-bold tabular-nums text-text-primary">
                        {`${plural(coveredProtocols.length, "protocol")} on ${coveredChainLabel}`}
                      </span>
                    </Card>
                    )}
                  </div>
                  )}

                  {/* Row 2, left: the visual collateral breakdown. Only when
                      there is collateral to break down. A card that renders a
                      bar, four dots, four symbols and four dollar amounts has
                      to be describing something, and when this had no positions
                      to describe it described a wstETH/USDC/ETH/USDT portfolio
                      nobody held. */}
                  {allocation.length > 0 && (
                  <Card className="space-y-6 lg:col-span-6">
                    <CardTitle as="h3" size="sm">
                      Asset allocation
                    </CardTitle>

                    {/* Segmented bar; the swatch on each row below is its legend,
                        which is why those dots stay while decorative ones went. */}
                    <div className="flex h-4 w-full overflow-hidden hard-edge">
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
                        <div key={a.symbol} className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <span className={`h-2.5 w-2.5 shrink-0 ${a.color}`}></span>
                            {/* Row content, so 14px. An allocation legend where
                                the symbol and the dollar amount are both 12px
                                is a table nobody reads across. */}
                            <span className="truncate font-sans text-sm font-medium text-text-primary">
                              {a.symbol}
                            </span>
                          </div>
                          <div className="shrink-0 text-right">
                            <span className="font-mono text-sm font-bold tabular-nums text-text-primary">{formatUsd(a.usd)}</span>
                            <span className="block font-mono text-xs tabular-nums text-text-secondary">{a.pct.toFixed(1)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                  )}

                  {/* Row 2, right: the alert log (watch_transitions IS the
                      alert log).

                      Rendered when there are alerts, or when there are
                      positions for a future alert to be about. "No alerts yet"
                      is reassurance beside a wallet PANIK is watching; beside a
                      wallet it could not read, it is one more empty box
                      agreeing that the screen knows nothing. */}
                  {showAlertHistory && (
                  <Card
                    /* One class, chosen here rather than two appended and left
                       to Tailwind's emit order to break the tie: with the
                       allocation card absent this takes the whole row instead
                       of leaving half of it empty. */
                    className={`flex flex-col ${allocation.length > 0 ? "lg:col-span-6" : "lg:col-span-12"}`}
                  >
                    <CardTitle
                      as="h3"
                      size="sm"
                      className="mb-4 shrink-0"
                      hint="Every risk-status change PANIK detected. A chip appears only when the alert did not reach you; delivered alerts stay quiet."
                    >
                      Alert history
                    </CardTitle>
                    {alertsNewestFirst.length ? (
                      <>
                        {/* Rules, not boxes. Bordered, tinted rows inside a Card
                            that is already bordered is chrome wrapping chrome; a
                            hairline separates rows for free. `AlertFeed` owns the
                            row, and the history page draws it from the same
                            component, so the preview and the full log cannot
                            drift into two treatments. */}
                        <AlertFeed
                          alerts={alertsNewestFirst.slice(0, ALERT_PREVIEW_COUNT)}
                          protocolLabel={LIVE_PROTOCOL_LABEL}
                          targets={alertTargets}
                          onSelectTarget={setHighlightedPositionKey}
                        />
                        {/* Only when the preview falls short of the log. Below
                            that the card IS the whole history, and a control
                            that opens a page showing what you are already
                            looking at is a control that does nothing.

                            It names the length, because how far the history runs
                            is the one thing a four-row preview cannot say. */}
                        {alertsNewestFirst.length > ALERT_PREVIEW_COUNT && (
                          <Button
                            ref={alertHistoryTrigger}
                            variant="secondary"
                            className="mt-3 w-full shrink-0 justify-center lg:mt-auto"
                            onClick={() => setAlertHistoryOpen(true)}
                          >
                            See all {alertsNewestFirst.length} alerts
                          </Button>
                        )}
                      </>
                    ) : historyLoading ? (
                      /* Before the log has been read, the card cannot say
                         whether it is empty. The rows it is about to have,
                         held open at the height they will be. */
                      <AlertFeedSkeleton />
                    ) : historyFeedDown ? (
                      /* `problem`, and it must not resemble the state above
                         it: an unreachable log rendering as "no alerts yet"
                         is this product promising it is watching at the one
                         moment it cannot see. */
                      <EmptyState
                        tone="problem"
                        title="Alert history unavailable"
                        hint="We could not reach the alert log, so whether this wallet has raised any alert is unknown right now. That is not the same as having raised none."
                      />
                    ) : (
                      <AlertLogEmptyState
                        deliveryConnected={alertsDeliverable}
                        onConnectAlerts={() => setActiveTab("settings")}
                      />
                    )}
                  </Card>
                  )}

                  {/* Row 3: the aggregate score over time (score_snapshots via
                      /api/history), across all twelve columns.

                      Full width because this is the one card on the tab whose
                      readability is a function of horizontal room. At a 1440
                      window its 30 daily points had ~21px of x each in a 7-of-12
                      track; across all twelve they have ~34px, which is what
                      makes a crossing of the alert line readable as an event
                      rather than a kink. The y-domain is `riskDomain`, computed
                      from the series and the user's own alert threshold and
                      independent of the width, so the extra room lengthens the
                      line without flattening what it shows.

                      Same rule as the alert feed: a series to draw, or positions
                      whose history is genuinely still filling in. */}
                  {showRiskHistory && (
                  <Card className="lg:col-span-12">
                    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <CardTitle
                        as="h3"
                        size="sm"
                        hint={`Aggregate ${RISK_SCORE_NAME} of this wallet over time, protocols weighted by collateral. Bigger positions move it more, and a leg we could not price carries no weight.`}
                      >
                        Aggregate {RISK_SCORE_NAME}
                      </CardTitle>
                      {/* The current reading and the direction it moved, which
                          are the two facts this card knows. The score used to
                          be a fifth stat card up in the row; it is here now,
                          over the series it is the last point of, so the figure
                          and its history are one thing rather than two cards
                          counting the same array. */}
                      <span className="flex items-baseline gap-3">
                        <span className="font-mono text-lg font-bold tabular-nums text-text-primary">
                          {liveMacro && liveMacro.aggregate !== null
                            ? `${liveMacro.aggregate} / 100`
                            : "Not measured"}
                        </span>
                        {riskHistory && riskHistory.series.length > 1 && (() => {
                          const s = riskHistory.series;
                          const delta = Math.round(s[s.length - 1] - s[0]);
                          // The WINDOW, not the interval count. 30 daily points
                          // span 29 intervals, and this header used to say "29d"
                          // beside an x-axis reading "30d ago" - two defensible
                          // numbers describing one chart, which reads as a bug.
                          // `riskHistory.xStart` counts days the same way.
                          const days = s.length;
                          return (
                            <span className="font-sans text-xs tabular-nums text-text-secondary">
                              {delta === 0
                                ? `flat over ${days}d`
                                : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} over ${days}d`}
                            </span>
                          );
                        })()}
                      </span>
                    </div>
                    {riskHistory ? (
                      // Series colour is cool and fixed: repainting 30 days of history in
                      // today's band colour claims the whole series was that band.
                      // The axis is 0-100 because the SCORE is 0-100. Scaled to
                      // its own min/max the line filled the card whatever it
                      // did, and cropped out the two facts worth having: the
                      // band boundaries, and the level at which PANIK starts
                      // alerting this user. The threshold is the user's own,
                      // read from their profile, and drawn as a neutral
                      // annotation - not a fifth band colour.
                      <Sparkline
                        data={riskHistory.series}
                        height={riskChartHeight}
                        stroke="var(--color-chart-series)"
                        domain={riskDomain}
                        reference={{
                          value: ALERT_THRESHOLD[selectedRiskProfile],
                          label: `alert ${ALERT_THRESHOLD[selectedRiskProfile]}`,
                        }}
                        axes={{ yFormat: (v) => String(Math.round(v)), xStart: riskHistory.xStart, xEnd: "today" }}
                      />
                    ) : historyFeedDown ? (
                      /* Nothing is on its way, so nothing gets reserved. A
                         placeholder standing where a chart will never arrive is
                         the permanent-loading failure the position feed already
                         had once: it says "any second now" for as long as the
                         endpoint is down. */
                      <EmptyState
                        tone="problem"
                        title={`Aggregate ${RISK_SCORE_NAME} history unavailable`}
                        hint="We could not reach the stored score history for this wallet, so there is no series to draw. The scores above come from the live feed and are unaffected."
                      />
                    ) : (
                      /* Two states, one shape, because a reader is owed the same
                         thing in both: the chart is genuinely coming. A wallet
                         PANIK has just started scoring has fewer than two daily
                         points, which is not an error and not an empty result.

                         The frame is reserved rather than filled with prose, so
                         the first series to land does not shove the page. The
                         cadence is only stated once the history has actually
                         been read. */
                      <SparklinePlaceholder
                        height={riskChartHeight}
                        note={
                          walletHistory !== null
                            ? "This fills in as PANIK rescores your wallet, about once a minute."
                            : undefined
                        }
                      />
                    )}
                  </Card>
                  )}
                </div>
                )}
                </>
                )}
              </TabPanel>
            )}

            {/* VIEW E: SETTINGS TAB (Sentry preferences + Telegram alert dispatcher) */}
            {activeTab === "settings" && (
              <TabPanel key="settings" tab="settings">
                {/* ONE settled column, centred, and no sidebar.

                    This was a 12-column split whose right track held a single
                    three-line privacy note. Measured at a 1440 window: the panel
                    is 1114px, the sidebar track took 355px of it (32%) and ran
                    853px tall to match its neighbour, so roughly 790px of the
                    tab was permanently empty page with a hairline down the
                    middle of it. The note belonged to the Telegram card anyway,
                    and now sits under it.

                    Settings is a stack of forms rather than a dashboard, and a
                    form has a measure: `max-w-3xl` is 768px, within 33px of the
                    735px these cards already rendered at, so the cards are the
                    width they were and the slack is split evenly instead of
                    dumped on one side. `TabPanel`'s own 1600px cap still applies
                    above it.

                    The page header is INSIDE the column rather than above it,
                    so the heading, the rule under it and every card share one
                    left edge. A full-width rule over an inset stack reads as
                    two different pages joined at the top. */}
                <div className="mx-auto w-full max-w-3xl space-y-6">
                    {/* The other four tabs' page header, exactly: an `h1` at
                        `text-2xl` over a hairline with `pb-5`. This tab was
                        running its own smaller one (`h2`, `text-lg`,
                        `tracking-wide`, `pb-3`), so moving between tabs restated
                        the heading at two sizes with no rule saying which was
                        which. */}
                    <PageHeader title="Settings" />

                    {/* WHO THIS BROWSER IS, first, because everything under it
                        is scoped to that.

                        It used to be a menu button in the app header: an
                        address, a membership line and a sign-out, in a portalled
                        panel that opened over whatever was being read, on every
                        tab. None of those three is a thing anyone does twice a
                        session, and sign-out in particular is a deliberate, rare
                        action a user goes LOOKING for. */}
                    {accountState.account && (
                      <Card tone="raised" className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
                          <UserRound className="h-4 w-4 text-text-primary" />
                          <h3 className="text-sm font-sans font-semibold text-text-primary">Account</h3>
                        </div>
                        <p className="font-sans text-sm font-bold text-text-primary">
                          {accountState.account.email}
                        </p>
                        {/* Stated from the grant the server returned, never
                            assumed: a membership with no expiry gets no date
                            rather than an invented one. */}
                        <p className="font-sans text-xs text-text-secondary">
                          {describeMembership(accountState.account)}
                        </p>
                        <Button
                          variant="secondary"
                          disabled={accountState.busy}
                          onClick={() => void accountState.signOut()}
                        >
                          {accountState.busy ? "Signing out..." : "Sign out"}
                        </Button>
                      </Card>
                    )}

                    {/* The risk profile, which was a chip in the header wearing
                        a tooltip that explained what it changed.

                        It is a SETTING: it decides the limit every position on
                        every tab is measured against, and where alerts fire.
                        The line under it is the threshold itself, from the
                        engine, which is the one thing the tier's name cannot
                        say. */}
                    {riskTier && (
                      <Card tone="raised" className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
                          <Sliders className="h-4 w-4 text-text-primary" />
                          <h3 className="text-sm font-sans font-semibold text-text-primary">
                            Risk profile
                          </h3>
                        </div>
                        <p className="font-sans text-sm font-bold text-text-primary">
                          {RISK_TIER_LABELS[riskTier]}
                        </p>
                        <p className="font-sans text-xs text-text-secondary">
                          Alerts fire at {ALERT_THRESHOLD[selectedRiskProfile]} on the 0 to 100
                          score.
                        </p>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setOnboardingIntent(onboardedWallet ? "retake-quiz" : "switch-wallet")
                          }
                        >
                          Retake the questions
                        </Button>
                      </Card>
                    )}

                    {/* Which chain the positions, scores and exits on every
                        other tab belong to. The TESTNET marker that used to ride
                        in the header is the selected state of this control. */}
                    <ChainModeSwitch />

                    {/* Identity, above the two cards that depend on it: where
                        alerts go and what standing permission exists are both
                        answers to "for which wallet", and this is the card that
                        says how PANIK knows. It is also the only home for sign
                        out, which is a deliberate, rare action a user goes
                        looking for rather than one that belongs in a header
                        read on every screen. */}
                    <SessionCard
                      session={session.session}
                      wallet={onboardedWallet}
                      busy={session.busy}
                      onSignIn={signInThisBrowser}
                      onSignOut={signOutThisBrowser}
                    />

                    {/* Telegram alerts dispatcher (the real Connect flow).

                        Withheld entirely under a read-only session. Every
                        control on it is a write that ends in a `telegram-link`
                        signature this reader cannot produce, and the card's own
                        status line describes alert delivery for a wallet they
                        have not proved they hold. A disabled copy would state
                        the same facts while offering nothing, so the honest
                        version of "you cannot change this here" is not to show
                        the control at all: the banner above already says why,
                        and the Settings card above it says how to fix it. */}
                    {!readOnlySession && (
                      <Card tone="raised" className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
                          <Bell className="w-4 h-4 text-text-primary" />
                          <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary">
                            Telegram alerts
                            <InfoTip text="Alerts fire only on a real transition toward liquidation: debounced, deduped and rate-limited, never on noise." />
                          </h3>
                        </div>
                        {/* "Get a Telegram message when this wallet nears your
                            moderate risk limit" used to stand here. It restates
                            the card's own heading and the profile card above it,
                            and the threshold it alludes to is stated exactly
                            there. The status line below is the fact this card
                            carries. */}
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
                        {/* "Sign to prove wallet ownership, free, no
                            transaction, no gas" is gone: the account card above
                            already says what a PANIK signature costs, and it
                            said the same thing twice on one screen.

                            The one line that survives on this branch is the one
                            that says what to DO, because a control the reader
                            cannot use has to say why. */}
                        {!telegramEligible && (
                          <p className="text-xs font-sans text-text-secondary">
                            Add a wallet starting 0x to enable alerts.
                          </p>
                        )}
                        {/* The instructions, and only while a link is open: a
                            reader whose browser did not follow it has no other
                            way to finish. Not decoration, not an explanation of
                            the feature. */}
                        {telegramLink.status === "opened" && (
                          <div className="space-y-1.5 border-t border-border-subtle pt-1.5">
                            <p className="text-xs font-sans text-text-secondary leading-relaxed">
                              Send this to <strong className="text-text-primary">@{telegramBotUsername}</strong> if the link did not open:
                            </p>
                            <div className="flex items-center break-all hard-edge bg-surface-sunken px-2.5 py-1.5 font-mono text-xs select-all">
                              /start {telegramLink.code}
                            </div>
                          </div>
                        )}
                        {telegramLink.status === "error" && telegramLink.error && (
                          <p className="text-xs font-sans text-risk-critical">{telegramLink.error}</p>
                        )}
                      </Card>
                    )}

                    {/* A data-handling commitment and the only place /stop is
                        documented, so it is never deleted - but it is now the
                        two facts rather than the paragraph around them.
                        Withheld with the card it belongs to, because a promise
                        about a feature this screen is not offering has nothing
                        to attach itself to.

                        Deliberately NOT the `Card` primitive the cards above it
                        are. It is a footnote to the card it follows, and giving
                        it the same plate would make it read as a fifth
                        setting. */}
                    {!readOnlySession && (
                      <p className="font-sans text-xs leading-relaxed text-text-secondary">
                        Stored: your Telegram chat id and wallet address. Send /stop in the bot to
                        disable.
                      </p>
                    )}

                    {/* Two cards, two different things being granted, and they
                        sit in this order on purpose.

                        Approvals come first because they are the lower-level
                        permission: they let the exit contract move tokens at
                        all, and without them the standing permission below has
                        nothing it can execute. Each card names what its own
                        revoke button revokes, because a user who kills their
                        delegation meaning to clear their allowances (or the
                        reverse) has lost something they meant to keep. */}
                    <ExitApprovals />

                    {/* Standing exit permission (Phase 2.C) - grant/disclose/revoke
                        a scoped ExitPermit the user signs; the relayer that uses
                        it is Phase 4. */}
                    <DelegationManager riskProfile={selectedRiskProfile} />

                    {/* Emergency auto repayment trigger (interactive preference).
                        Hidden per business-dev QA (2026-07-03) until the
                        Deleverager ships - flip SHOW_AUTO_REPAY_CARD to restore. */}
                    {SHOW_AUTO_REPAY_CARD && (
                    <Card tone="raised" className="space-y-3">
                      <div className="flex justify-between items-center border-b border-border-subtle pb-2.5">
                        <div className="flex items-center gap-2">
                          <Sliders className="w-4 h-4 text-text-primary" />
                          <h3 className="text-sm font-sans font-semibold text-text-primary">
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
                    </Card>
                    )}
                </div>
              </TabPanel>
            )}

          </AnimatePresence>
        </div>

        {/* 3. SLIDE-OUT PANEL FOR DETAILED RISK BREAKDOWN (Linear/Stripe style) */}
        <AnimatePresence>
          {selectedRiskBreakdownPreset && breakdownData && (
            <Sheet onDismiss={() => setSelectedRiskBreakdownPreset(null)}>
              <RiskBreakdownPanel
                preset={selectedRiskBreakdownPreset}
                data={breakdownData}
                opensDemo={!opensReal(selectedRiskBreakdownPreset)}
                onClose={() => setSelectedRiskBreakdownPreset(null)}
                onSimulate={() => {
                  setSelectedPresetId(selectedRiskBreakdownPreset.id);
                  setWatchSource("recommendations");
                  setActiveTab("watch");
                  setSelectedRiskBreakdownPreset(null);
                }}
                onOpen={() => requestOpenPosition(selectedRiskBreakdownPreset)}
              />
            </Sheet>
          )}
        </AnimatePresence>

        {/* 4. SLIDE-OUT PANEL FOR THE WATCHLIST.

            Literally the risk breakdown's shell, not a matching copy of it:
            both are a reading-and-editing surface opened over the page you were
            on, and the app should not have two ways of covering itself. See
            `Sheet`.

            Gated on a bound wallet: the list belongs to an owner, and there is
            no owner before onboarding. */}
        <AnimatePresence>
          {walletsPanelOpen && onboardedWallet && (
            <Sheet onDismiss={() => setWalletsPanelOpen(false)}>
              <WalletsPanel
                owner={onboardedWallet}
                state={watchlist}
                getProof={getProof}
                /* The user's own answer from onboarding, as the default for a
                   wallet they have not thought about a level for yet. */
                defaultProfile={selectedRiskProfile}
                viewedWallet={viewedWallet}
                /* A read-only reader may see the list the alerts come from,
                   and may not change it: every edit here ends in one
                   `watchlist-manage` signature they cannot produce. */
                readOnly={readOnlySession}
                onClose={() => setWalletsPanelOpen(false)}
              />
            </Sheet>
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
          /* No border here: the tablist inside draws the 3px edge that separates
             it from the content column, and a hairline above that read as a
             rendering fault beside it. */
          className={`shrink-0 bg-surface-base ${LAYER.chrome}`}
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

      {/* DEMO simulator fallback (no signing, no funds - see component):
          reached only when requestOpenPosition found the chain cannot open it. */}
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
      {monitoringIssue && (() => {
        // "blocked" is the case the banner was built for: we tried, we failed,
        // and the user believes they are covered. It keeps the risk hue.
        //
        // "unverified" is not a failure. Pasting an address to look around is
        // the ordinary way into this product, and a watch-only address cannot
        // be monitored and never could be. Shouting about it in risk-critical
        // red put a permanent alarm on the busiest surface in the app for a
        // non-event, and spent the one hue reserved for actual liquidation
        // risk on a wallet-connection prompt. Same words, stated calmly.
        const blocked = monitoringIssue.severity === "blocked";
        return (
          <div className={`fixed top-4 left-1/2 -translate-x-1/2 ${LAYER.banner} w-full max-w-xl px-4`}>
            <div
              role={blocked ? "alert" : "status"}
              className={`flex items-center gap-3 bg-surface-overlay border rounded-md px-4 py-3 shadow-2xl shadow-black/60 ${
                blocked ? "border-risk-critical/40" : "border-border-subtle"
              }`}
            >
              <ShieldAlert
                className={`w-4 h-4 shrink-0 ${blocked ? "text-risk-critical" : "text-text-muted"}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-xs font-sans font-bold ${
                    blocked ? "text-risk-critical" : "text-text-primary"
                  }`}
                >
                  Alerts inactive
                </p>
                {/* The message is a COMPLETE sentence carrying its own
                    consequence. It used to have "Verify wallet ownership to
                    enable liquidation alerts." concatenated onto whatever came
                    back, which read as two half-sentences whenever the first
                    half was a library string. */}
                <p className="text-2xs text-text-secondary mt-0.5">{monitoringIssue.message}</p>
              </div>
              <button
                onClick={retryMonitoring}
                disabled={monitoringBusy}
                className="shrink-0 px-3 py-1.5 rounded-md bg-text-primary hover:opacity-90 disabled:opacity-50 text-2xs font-sans font-bold text-surface-base transition-colors cursor-pointer"
              >
                {monitoringBusy ? "Verifying..." : blocked ? "Retry" : "Connect"}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Atomic Exit / Reduce flow (Phase 2) - real transactions, user-signed */}
      {exitPrefill && (
        <ExitFlow
          prefill={exitPrefill}
          onClose={() => setExitPrefill(null)}
          gasGwei={chainTel.gasGwei}
        />
      )}

      {/* In-app open flow (Phase 2) - the selected chain, user-signed */}
      {openFlowPlan && (
        <OpenFlow
          plan={openFlowPlan}
          riskProfile={selectedRiskProfile}
          onClose={() => setOpenFlowPlan(null)}
          // A position opened but not monitored is the same silent failure as
          // an unregistered onboarding — route it to the same banner.
          onMonitoring={(wallet, profile, result: RegisterResult) => {
            setMonitoringTarget({ wallet, profile });
            noteMonitoring(result);
          }}
        />
      )}

      {/* First-run onboarding tooltip tour */}
      {currentTourStep && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 ${LAYER.banner} w-full max-w-sm px-4`}>
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
