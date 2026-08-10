/**
 * Live data hooks — panik-core's only bridge to the scoring API.
 * Every hook degrades gracefully (returns null / offline=true) so the demo
 * stays fully functional without `npm run dev:api`.
 */

import { useEffect, useRef, useState } from "react";

/**
 * The engine's band vocabulary, not a copy of it. This used to be a literal
 * re-declaration of the same four strings, which meant `packages/scoring` — the
 * one place scoring is allowed to live — could gain a band and every consumer
 * here would keep compiling and silently resolve `RISK_CHIP[band]` to
 * `undefined`. Importing it makes that a type error at the door.
 *
 * TYPE-only, and it has to stay that way: `packages/scoring` is raw TS whose
 * barrel pulls viem, so a value import would put the engine in a browser
 * bundle. `import type` is erased before the bundler ever sees it.
 */
export type { Band } from "../../../packages/scoring/src/types";
import type { Band } from "../../../packages/scoring/src/types";

/**
 * Sub-scores from the PROSPECTIVE path (/api/compass, /api/prospective).
 * All four are numbers there and always will be: `scoreProspective` awaits both
 * market-context providers with `Promise.all`, so a failed lookup rejects the
 * whole request and the route answers 5xx rather than a partial score. Nothing
 * on those two endpoints can be null, and typing them as if they could would
 * push a "not measured" branch onto surfaces that can never reach it.
 */
export interface SubScores {
  positionHealth: number;
  assetRisk: number;
  protocolSafety: number;
  systemicRisk: number;
}

/**
 * Sub-scores from the ACTIVE path (/api/scores, /api/positions, /api/advisor),
 * mirroring `DegradableSubScores` in packages/scoring/src/types.ts.
 *
 * The two market-context terms are null when their provider lookup failed for
 * this leg. Null means NOT MEASURED and never 0: 0 is a real score meaning "as
 * calm as this term gets", so `Math.round(null)` renders a degraded feed as the
 * best possible reading. Position health comes from the chain read and protocol
 * safety from a static table, so neither can go missing.
 *
 * The composite is renormalised over the surviving weights (computeScore.ts),
 * so `total` stays a real number even when a term here is null.
 */
export interface DegradableSubScores {
  positionHealth: number;
  assetRisk: number | null;
  protocolSafety: number;
  systemicRisk: number | null;
}

export type LiveProtocol = "aave_v3" | "moonwell" | "morpho" | "compound_v3";

/**
 * Where a position sits relative to the limit the user's risk profile sets
 * (packages/scoring, `profile.ts`). An INTERNAL enum and a database column —
 * never a string to render. `lib/utils.ts` owns the two English phrasings.
 */
export type ProfileStatus = "within" | "approaching" | "outside";

export interface LiveWalletPosition {
  protocol: LiveProtocol;
  wallet: string;
  total: number;
  band: Band;
  subScores: DegradableSubScores;
  healthFactor: number | null;
  /** null when the engine could not price the position in USD — see below. */
  collateralValueUsd: number | null;
  borrowValueUsd: number | null;
  /**
   * True when a price feed the USD conversion depends on was missing or stale.
   * The score, band and health factor are still exact (they are ratios); only
   * the dollar magnitudes are unknown. Must be surfaced, never rendered as $0.
   */
  usdValuesUnavailable?: boolean;
  /**
   * True when a market-context provider failed for THIS leg, so `subScores`
   * carries a null. The composite is weighted over what was measured, which
   * makes it a real number the UI may print; the null sub-scores are not.
   * Optional because a payload cached before the field existed omits it — read
   * it through `marketContextMissing()`, which derives the same condition from
   * the sub-scores themselves.
   */
  marketContextUnavailable?: boolean;
  scoredCollateralSymbol: string;
  label: string | null;
  riskProfile: string;
  profileStatus: ProfileStatus;
  /**
   * Non-null when THIS position was scored from simulated prices. Optional so a
   * payload cached before the field existed still parses; absent and null both
   * mean "scored from the real market", which is the honest reading of a
   * response written when no simulator existed.
   */
  simulation?: SimulationStampInfo | null;
}

/**
 * Which chain the API actually read these positions from.
 *
 * Served WITH the positions rather than derived from a build-time env var,
 * because those are two different facts and only one of them is true: the API
 * chooses its chain from PANIK_SCORING_CHAIN at boot, so a browser bundle
 * carrying a different opinion would put the wrong chain name on real money.
 * Optional because a response cached before the field existed omits it, and a
 * missing chain is rendered as no claim at all, never as "Base".
 */
export interface ScoringChainInfo {
  mode: string;
  chainId: number;
  /** Chain name fit to render, e.g. "Base" or "Base Sepolia". */
  label: string;
  /**
   * The protocols the API scanned on this chain. What "PANIK covers" means is
   * a property of the chain, not of the product: on Base Sepolia only Aave V3
   * has a market to read, and a coverage row fixed at four claims three
   * protocols were checked when none of them were.
   */
  protocols: LiveProtocol[];
}

/**
 * An armed market simulation, as served WITH the positions it produced.
 * Mirrors `SimulationWire` in server/simulationStore.ts.
 *
 * It travels on the positions response rather than being polled separately, and
 * that is a correctness requirement rather than a saved round trip: a
 * separately-fetched marker can light up over the previous poll's real numbers,
 * or - much worse - go dark a tick before the crashed figures do. The marker
 * has to describe the payload it arrived with, so it arrives with it.
 */
export interface SimulationInfo {
  id: string;
  scenario: string;
  /** Human label for the marker, e.g. "Crash". Never an engine enum. */
  label: string;
  /** SYMBOL -> price multiplier. 0.6 = that asset is priced 40% lower. */
  multipliers: Record<string, number>;
  /** Epoch ms. */
  startedAt: number;
  expiresAt: number;
}

/**
 * Per-leg provenance. Mirrors `SimulationStamp` in packages/scoring.
 *
 * Present on a position means every figure on that row - score, band, health
 * factor, dollar amounts - came from an imagined price, and the row must carry
 * the marker. Absent means the row is real, including while a simulation is
 * armed against some other asset.
 */
export interface SimulationStampInfo {
  id: string;
  label: string;
  scenario: string;
  collateralMultiplier: number;
  borrowMultiplier: number;
  healthFactorMultiplier: number;
  expiresAt: number;
}

export interface CompassLiveScore {
  id: string;
  total: number;
  band: Band;
  subScores: SubScores;
  healthFactor: number | null;
  liquidationDrawdown: number | null;
}

export interface ProspectiveLive {
  total: number;
  band: Band;
  subScores: SubScores;
  healthFactor: number | null;
  liquidationDrawdown: number | null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

/** Poll a JSON endpoint on an interval; null until first success. */
function usePolled<T>(url: string, intervalMs: number): { data: T | null; offline: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getJson<T>(url);
        if (!cancelled) {
          setData(body);
          setOffline(false);
        }
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [url, intervalMs]);

  return { data, offline };
}

/**
 * Live wallet positions for the WHOLE watch registry (60s — arch cadence).
 * ADMIN-GATED server-side: /api/scores now requires x-admin-key, because the
 * whole-registry view is an enumeration list of other people's wallets. The
 * browser sends no key, so this resolves `offline` and the ops view degrades to
 * its empty state. An onboarded user's own positions come from
 * useWalletPositions (/api/positions), which stays open.
 */
export function useLiveScores() {
  const { data, offline } = usePolled<{ updatedAt: number; positions: LiveWalletPosition[] }>(
    "/api/scores",
    60_000,
  );
  return { positions: data?.positions ?? null, updatedAt: data?.updatedAt ?? 0, offline };
}

/**
 * Live positions for ONE wallet — the onboarded user's own wallet. Polls
 * /api/positions every 60s; no-ops (returns null) when wallet is null. Degrades
 * gracefully offline like the other hooks.
 */
export function useWalletPositions(wallet: string | null, profile: string) {
  const [data, setData] = useState<{
    updatedAt: number;
    positions: LiveWalletPosition[];
    chain?: ScoringChainInfo;
    simulation?: SimulationInfo | null;
  } | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Reset on every wallet change so a switch never shows the PREVIOUS
    // wallet's positions while the new fetch is in flight.
    setData(null);
    if (!wallet) {
      setOffline(false);
      return;
    }
    let cancelled = false;
    const url = `/api/positions?wallet=${wallet}&profile=${encodeURIComponent(profile)}`;
    const load = async () => {
      try {
        const body = await getJson<{
          updatedAt: number;
          positions: LiveWalletPosition[];
          chain?: ScoringChainInfo;
          simulation?: SimulationInfo | null;
        }>(url);
        if (!cancelled) {
          setData(body);
          setOffline(false);
        }
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet, profile]);

  return {
    positions: data?.positions ?? null,
    updatedAt: data?.updatedAt ?? 0,
    chain: data?.chain ?? null,
    // Read off the SAME payload as the positions, so the marker and the figures
    // can never describe two different moments.
    simulation: data?.simulation ?? null,
    offline,
  };
}

/** Live prospective scores for the Compass presets, keyed by preset id. */
export function useCompassScores() {
  const { data, offline } = usePolled<{ updatedAt: number; scores: CompassLiveScore[] }>(
    "/api/compass",
    60_000,
  );
  const byId: Record<string, CompassLiveScore> | null = data
    ? Object.fromEntries(data.scores.map((s) => [s.id, s]))
    : null;
  return { scores: byId, offline };
}

export interface HistoryAlert {
  protocol: LiveProtocol;
  risk_profile: string;
  score: number;
  band: Band;
  /** Loose on purpose: this is whatever the DB row holds, including older values. */
  from_status: string | null;
  to_status: ProfileStatus;
  notify_channel: string | null;
  notified_at: string | null;
  created_at: string;
}

export interface HistorySnapshot {
  protocol: LiveProtocol;
  total: number;
  health_factor: string | null;
  collateral_usd: string | null;
  borrow_usd: string | null;
  created_at: string;
}

/** Alert feed + 30d score series for ONE wallet (Portfolio history). */
export function useWalletHistory(wallet: string | null) {
  const [data, setData] = useState<{ alerts: HistoryAlert[]; snapshots: HistorySnapshot[] } | null>(null);

  useEffect(() => {
    setData(null); // never show the previous wallet's history mid-switch
    if (!wallet) return;
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getJson<{ alerts: HistoryAlert[]; snapshots: HistorySnapshot[] }>(
          `/api/history?wallet=${wallet.toLowerCase()}`,
        );
        if (!cancelled) setData(body);
      } catch {
        /* offline: the Portfolio blocks render their empty states */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet]);

  return data;
}

export interface PoolYield {
  apy: number;
  tvlUsd: number;
  apySeries: number[]; // last 30 daily points, oldest first
  tvlSeries: number[];
}

/** 30d APY/TVL history per Compass preset id (DefiLlama via the API, 1h server cache). */
export function useCompassYields() {
  const { data, offline } = usePolled<{ updatedAt: number; pools: Record<string, PoolYield> }>(
    "/api/poolhistory",
    600_000,
  );
  return { pools: data?.pools ?? null, offline };
}

export interface RegistryWallet {
  wallet: string;
  risk_profile: string;
  label: string | null;
}

/**
 * The watch registry — ops selector source, independent of scoreability.
 * ADMIN-GATED server-side (see useLiveScores): returns null for the browser.
 */
export function useWalletRegistry() {
  const { data } = usePolled<{ wallets: RegistryWallet[] }>("/api/wallets", 60_000);
  return data?.wallets ?? null;
}

/** Real Base block number + gas price (15s). */
export function useChainTelemetry() {
  const { data } = usePolled<{ blockNumber: number; gasGwei: number }>("/api/chain", 15_000);
  return { blockNumber: data?.blockNumber ?? null, gasGwei: data?.gasGwei ?? null };
}

// -- AI Advisor (Phase 2) ---------------------------------------------------
// Local mirrors of packages/scoring/src/advisor/types.ts (panik-core does not
// import the scoring package, same as LiveWalletPosition above).

export type AdvisorAction = "HOLD" | "MONITOR" | "REDUCE" | "EXIT" | "REBALANCE" | "OPEN";
export type AdvisorUrgency = "info" | "warning" | "critical";

export interface AdvisorSections {
  position: string;
  market: string;
  recommendation: string;
  execution: string;
}

/**
 * What a collateral-funded repay costs, on top of the debt it clears. Present
 * only on a `collateral_funded` plan: a wallet-funded repay swaps nothing and
 * borrows nothing, and printing it a "0% flash fee" would advertise the absence
 * of a mechanism as a feature. See `packages/scoring/src/advisor/types.ts`.
 */
export interface AdvisorRepayCosts {
  /** Flash-loan fee, bps of the repaid amount, worst case of the route taken. */
  flashFeeBps: number;
  /** Swap slippage ALLOWANCE, bps. Enforced on chain; a worse fill reverts. */
  slippageBps: number;
  /**
   * Gas the deleverage burns, in GAS UNITS (fork-measured per protocol). Never
   * a dollar figure: pricing it needs a live gas price and ETH price the engine
   * does not have, so a surface without both says gas is priced at signing.
   */
  gasUnits: number;
}

export interface AdvisorRepayPlan {
  /** Display only; a dollar figure is never converted back into token units. */
  repayUsd: number;
  /**
   * The leg's actual debt asset. Null when the reader could not name it - it is
   * NOT safe to assume USDC, which is what this field used to hardcode.
   */
  repayAssetSymbol: string | null;
  /**
   * Fraction of the leg's debt to repay, in (0, 1]. The executable form: see
   * `packages/scoring/src/advisor/repayMath.ts`.
   */
  repayFraction: number;
  targetHf: number;
  /** Null when the plan clears the debt: no debt means no health factor. */
  projectedHf: number | null;
  /**
   * Where the money comes from. `wallet_funded`: the user pays from their own
   * wallet in the debt asset, nothing is sold. `collateral_funded`: their own
   * collateral funds it, so they need no capital in the wallet, and it costs a
   * flash fee, swap slippage and materially more gas (see `costs`).
   */
  mode: "wallet_funded" | "collateral_funded";
  /** Present iff `mode === "collateral_funded"`. See `AdvisorRepayCosts`. */
  costs?: AdvisorRepayCosts;
}

/**
 * A second outcome the user may take instead of the primary action. Today the
 * engine emits one: `full_repay`, offered on an EXIT that was promoted from a
 * near-total reduce. Show it as a quiet secondary, never in place of the
 * primary. See `packages/scoring/src/advisor/types.ts`.
 */
export interface AdvisorAlternative {
  kind: "full_repay";
  plan: AdvisorRepayPlan;
}

export interface AdvisorOpenPlan {
  protocol: LiveProtocol;
  collateralSymbol: string;
  collateralUsd: number;
  borrowUsd: number;
  projectedScore: number;
  projectedHf: number | null;
  apy: number | null;
}

export interface AdvisorRecommendation {
  protocol: LiveProtocol;
  wallet: string;
  action: AdvisorAction;
  urgency: AdvisorUrgency;
  triggers: string[];
  repayPlan?: AdvisorRepayPlan;
  /** A declinable second outcome; see `AdvisorAlternative`. */
  alternative?: AdvisorAlternative;
  /**
   * The same protection as `repayPlan`, funded by the user's own collateral
   * rather than their wallet. Both arrive together because the engine has no
   * wallet-balance input and so cannot know which route the user can actually
   * take; the client picks. Absent means the leg has no such option, never that
   * the option is free. See `packages/scoring/src/advisor/types.ts`.
   */
  collateralFundedAlternative?: AdvisorRepayPlan;
  openPlan?: AdvisorOpenPlan;
  rebalance?: { toProtocol: LiveProtocol; reason: string };
  sections: AdvisorSections;
  /**
   * Who wrote `sections` on THIS leg. Absent or "fallback" = the engine did.
   *
   * Per-leg because the guards reject legs one at a time, so the report-level
   * `narrated` flag is true as soon as any leg is narrated and cannot be used
   * to label a block "AI-generated". On a critical leg "narrated" still leaves
   * the verdict sentence deterministic.
   */
  narrationSource?: "narrated" | "fallback";
  numbers: {
    total: number;
    band: Band;
    healthFactor: number | null;
    /** null when the leg could not be priced in USD (degraded feed). */
    collateralValueUsd: number | null;
    borrowValueUsd: number | null;
    usdValuesUnavailable?: boolean;
    /**
     * Degradable, same as the position rows: the advisor's `numbers` is a
     * `Pick` of the engine's ActiveScore, so a null market-context term arrives
     * here too. The engine does not include `marketContextUnavailable` in that
     * Pick, which is why `marketContextMissing()` derives it from these.
     */
    subScores: DegradableSubScores;
    scoredCollateralSymbol: string;
  };
  exitPrefill?: {
    protocol: LiveProtocol;
    /** `full_repay` clears the debt and leaves the collateral deposited. */
    kind: "full" | "partial" | "full_repay";
    /** Display only. */
    repayUsd?: number;
    /** What a partial exit is actually sized from; see `AdvisorRepayPlan`. */
    repayFraction?: number;
    /**
     * Engine readings the exit flow cannot make for itself, carried so a repay
     * capped to the wallet balance can state what protection it actually buys.
     * Display only. See `packages/scoring/src/advisor/types.ts`.
     */
    borrowUsd?: number | null;
    healthFactor?: number | null;
    collateralSymbol?: string;
  };
  openPrefill?: AdvisorOpenPlan;
}

export interface AdvisorWalletInsights {
  profile: string;
  archetype: string;
  protocols: string[];
  topProtocol: string | null;
  topCollateralSymbol: string | null;
  liquidations: number;
  lendingAgeDays: number;
  borrowToDepositRatio: number;
  stableBorrowPct: number;
  daysSinceLastActivity: number;
  confidence: number;
}

export interface AdvisorReport {
  wallet: string;
  profile: string;
  overall: { action: AdvisorAction; urgency: AdvisorUrgency; headline: string };
  recommendations: AdvisorRecommendation[];
  opportunities: AdvisorRecommendation[];
  walletInsights?: AdvisorWalletInsights;
  narrated: boolean;
  updatedAt: number;
  changeToken: string;
}

/**
 * Advisor report for ONE wallet - 60s poll of /api/advisor (the server caches
 * the expensive narration for 5 min). Null wallet or offline degrades to null,
 * so the Advisor tab can keep its Coming-Soon fallback.
 */
export function useAdvisor(wallet: string | null, profile: string) {
  const [data, setData] = useState<AdvisorReport | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Reset on wallet change - never show the previous wallet's advice.
    setData(null);
    if (!wallet) {
      setOffline(false);
      return;
    }
    let cancelled = false;
    const url = `/api/advisor?wallet=${wallet.toLowerCase()}&profile=${encodeURIComponent(profile)}`;
    const load = async () => {
      try {
        const body = await getJson<AdvisorReport>(url);
        if (!cancelled) {
          setData(body);
          setOffline(false);
        }
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet, profile]);

  return { report: data, offline };
}

export interface ProspectiveArgs {
  protocol: LiveProtocol;
  symbol: string;
  collateralUsd: number;
  borrowUsd: number;
}

/**
 * Debounced live scoring for the Watch sliders. Aborts stale requests so
 * fast dragging never renders an out-of-date score.
 */
export function useProspective(args: ProspectiveArgs): ProspectiveLive | null {
  const [result, setResult] = useState<ProspectiveLive | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const q = new URLSearchParams({
        protocol: args.protocol,
        symbol: args.symbol,
        collateralUsd: String(args.collateralUsd),
        borrowUsd: String(args.borrowUsd),
      });
      getJson<ProspectiveLive>(`/api/prospective?${q}`, ctrl.signal)
        .then(setResult)
        .catch(() => {
          if (!ctrl.signal.aborted) setResult(null); // offline → caller falls back to mock
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [args.protocol, args.symbol, args.collateralUsd, args.borrowUsd]);

  return result;
}
