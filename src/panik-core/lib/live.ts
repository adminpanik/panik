/**
 * Live data hooks — panik-core's only bridge to the scoring API.
 * Every hook degrades gracefully (returns null / offline=true) so the demo
 * stays fully functional without `npm run dev:api`.
 */

import { useEffect, useRef, useState } from "react";

export type Band = "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";

export interface SubScores {
  positionHealth: number;
  assetRisk: number;
  protocolSafety: number;
  systemicRisk: number;
}

export type LiveProtocol = "aave_v3" | "moonwell" | "morpho" | "compound_v3";

export interface LiveWalletPosition {
  protocol: LiveProtocol;
  wallet: string;
  total: number;
  band: Band;
  subScores: SubScores;
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
  scoredCollateralSymbol: string;
  label: string | null;
  riskProfile: string;
  profileStatus: "within" | "approaching" | "outside";
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

/** Live wallet positions from the watch registry (60s — arch cadence). */
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
  const [data, setData] = useState<{ updatedAt: number; positions: LiveWalletPosition[] } | null>(null);
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
        const body = await getJson<{ updatedAt: number; positions: LiveWalletPosition[] }>(url);
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

  return { positions: data?.positions ?? null, updatedAt: data?.updatedAt ?? 0, offline };
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
  from_status: string | null;
  to_status: "within" | "approaching" | "outside";
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

/** The watch registry — selector source, independent of scoreability. */
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

export interface AdvisorRepayPlan {
  repayUsd: number;
  repayAssetSymbol: string;
  targetHf: number;
  projectedHf: number;
  mode: "wallet_funded";
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
  openPlan?: AdvisorOpenPlan;
  rebalance?: { toProtocol: LiveProtocol; reason: string };
  sections: AdvisorSections;
  numbers: {
    total: number;
    band: Band;
    healthFactor: number | null;
    /** null when the leg could not be priced in USD (degraded feed). */
    collateralValueUsd: number | null;
    borrowValueUsd: number | null;
    usdValuesUnavailable?: boolean;
    subScores: SubScores;
    scoredCollateralSymbol: string;
  };
  exitPrefill?: { protocol: LiveProtocol; kind: "full" | "partial"; repayUsd?: number };
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
