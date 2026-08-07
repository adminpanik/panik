/**
 * LIVE positions — real wallets from the Supabase watch registry, scored by
 * the actual PANIK engine against live Base mainnet state. Data arrives via
 * props from AppDemo's useLiveScores() hook (shared with the Portfolio
 * metrics) — this component only renders.
 */

import React from "react";
import { Activity, WifiOff, SlidersHorizontal, AlertTriangle } from "lucide-react";
import type { LiveWalletPosition } from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";

const PROTOCOL_NAME: Record<LiveWalletPosition["protocol"], string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

function bandStyle(band: LiveWalletPosition["band"]): string {
  if (band === "LOW") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/25";
  if (band === "ELEVATED") return "bg-amber-500/10 text-amber-500 border-amber-500/25";
  return "bg-red-500/10 text-red-400 border-red-500/25";
}

function statusCopy(p: LiveWalletPosition): { text: string; cls: string } {
  if (p.profileStatus === "outside")
    return { text: "Outside your profile", cls: "text-red-400" };
  if (p.profileStatus === "approaching")
    return { text: "Approaching your limit", cls: "text-amber-400" };
  return { text: "Within your profile", cls: "text-emerald-400" };
}

/** Unknown dollar magnitudes render as an ellipsis — never as "$0". */
const fmtUsd = (v: number | null) =>
  v === null || !Number.isFinite(v) ? "$…" : `$${Math.round(v).toLocaleString()}`;

interface LivePositionsProps {
  positions: LiveWalletPosition[] | null;
  updatedAt: number;
  offline: boolean;
  /** Optional: open this real position in the Watch simulator (stress-test bridge). */
  onStressTest?: (position: LiveWalletPosition) => void;
}

export function LivePositions({ positions, offline, onStressTest }: LivePositionsProps) {
  if (offline) {
    return (
      <div className="flex items-center gap-2 text-[10px] font-mono text-panik-text-secondary bg-white/[0.02] border border-white/[0.05] rounded-xl px-4 py-3">
        <WifiOff className="w-3.5 h-3.5 text-panik-text-secondary" />
        <span>Live feed offline (run `npm run dev:api`). Showing simulation data below.</span>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.01] border border-panik-orange/20 rounded-2xl p-5.5">
      <h3 className="text-sm font-mono tracking-widest text-[#748BAA] font-bold uppercase mb-4 flex items-center justify-end">
        <span className="text-[10px] text-panik-orange font-normal flex items-center">
          {positions === null ? "CONNECTING…" : "LIVE"}
        </span>
      </h3>

      {positions === null && (
        <div className="text-xs font-mono text-panik-text-secondary py-6 text-center">
          Reading positions from chain…
        </div>
      )}

      {positions !== null && positions.length === 0 && (
        <div className="text-xs font-mono text-panik-text-secondary py-6 text-center">
          No open positions among watched wallets.
        </div>
      )}

      <div className="space-y-3">
        {(positions ?? []).map((p) => {
          const status = statusCopy(p);
          return (
            <div
              key={`${p.wallet}:${p.protocol}`}
              className="flex flex-col sm:flex-row justify-between sm:items-center p-4 rounded-xl border border-white/[0.04] bg-[#111318]/50 gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <ProtocolLogo protocol={PROTOCOL_NAME[p.protocol]} size="w-8 h-8" />
                <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-mono font-bold text-white truncate">
                    {PROTOCOL_NAME[p.protocol]} · {p.scoredCollateralSymbol} position
                  </h4>
                  <span
                    className={`text-[9px] font-mono tabular-nums font-bold px-2 py-0.5 rounded border ${bandStyle(p.band)}`}
                  >
                    {p.total} {p.band}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5 text-[10px] font-mono text-panik-text-secondary">
                  <span className={status.cls}>{status.text}</span>
                  <span className="text-white/20">•</span>
                  <span>
                    HF:{" "}
                    <strong
                      className={
                        p.healthFactor === null
                          ? "text-emerald-400 tabular-nums"
                          : p.healthFactor < 1.25
                            ? "text-red-400 tabular-nums"
                            : p.healthFactor < 1.7
                              ? "text-amber-400 tabular-nums"
                              : "text-emerald-400 tabular-nums"
                      }
                    >
                      {p.healthFactor === null ? "no debt" : p.healthFactor.toFixed(2)}
                    </strong>
                  </span>
                  <span className="text-white/20">•</span>
                  <span>
                    {fmtUsd(p.collateralValueUsd)} supplied / {fmtUsd(p.borrowValueUsd)} borrowed
                  </span>
                  {p.usdValuesUnavailable && (
                    <>
                      <span className="text-white/20">•</span>
                      <span
                        className="flex items-center gap-1 text-amber-400"
                        title="A price feed this position's USD conversion depends on was missing or stale. The health factor and PANIK score above are unaffected; only the dollar amounts are unknown."
                      >
                        <AlertTriangle className="w-3 h-3" />
                        Prices degraded
                      </span>
                    </>
                  )}
                  <span className="text-white/20">•</span>
                  <span className="truncate">{p.wallet.slice(0, 6)}…{p.wallet.slice(-4)}</span>
                </div>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 text-[9px] font-mono text-panik-text-secondary">
                <span className="flex items-center gap-1 tabular-nums" title="Sub-scores: position / asset / protocol / systemic">
                  <Activity className="w-3 h-3 text-panik-orange" />
                  {Math.round(p.subScores.positionHealth)} · {Math.round(p.subScores.assetRisk)} ·{" "}
                  {Math.round(p.subScores.protocolSafety)} · {Math.round(p.subScores.systemicRisk)}
                </span>
                {onStressTest && (
                  <button
                    onClick={() => onStressTest(p)}
                    title="Stress-test this position in Watch"
                    className="flex items-center gap-1 text-[9px] font-mono font-bold text-panik-orange bg-panik-orange/10 border border-panik-orange/25 px-2 py-1 rounded-lg hover:bg-panik-orange/20 cursor-pointer transition-all"
                  >
                    <SlidersHorizontal className="w-3 h-3" />
                    <span>Stress-test</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {positions !== null && positions.length > 0 && (
        <p className="mt-4 text-[9px] font-mono text-white/30">
          Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF)
          + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s.
        </p>
      )}
    </div>
  );
}
