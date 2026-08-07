/**
 * LIVE positions — real wallets from the Supabase watch registry, scored by
 * the actual PANIK engine against live Base mainnet state. Data arrives via
 * props from AppDemo's useLiveScores() hook (shared with the Portfolio
 * metrics) — this component only renders.
 */

import React from "react";
import { Activity, WifiOff, SlidersHorizontal, AlertTriangle } from "lucide-react";
import type { LiveWalletPosition } from "../lib/live";
import { RISK_CHIP } from "../lib/utils";
import { ProtocolLogo } from "./ProtocolLogo";

const PROTOCOL_NAME: Record<LiveWalletPosition["protocol"], string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

function statusCopy(p: LiveWalletPosition): { text: string; cls: string } {
  if (p.profileStatus === "outside")
    return { text: "Outside your profile", cls: "text-risk-critical" };
  if (p.profileStatus === "approaching")
    return { text: "Approaching your limit", cls: "text-risk-elevated" };
  return { text: "Within your profile", cls: "text-risk-low" };
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
      <div className="flex items-center gap-2 text-2xs font-mono text-text-secondary bg-white/[0.02] border border-border-subtle rounded-md px-4 py-3">
        <WifiOff className="w-3.5 h-3.5 text-text-secondary" />
        <span>Live feed offline (run `npm run dev:api`). Showing simulation data below.</span>
      </div>
    );
  }

  return (
    <div className="bg-white/[0.01] border border-panik-orange/20 rounded-lg p-5.5">
      {positions === null && (
        <div className="text-xs font-mono text-text-secondary py-6 text-center">
          Reading positions from chain…
        </div>
      )}

      {positions !== null && positions.length === 0 && (
        <div className="text-xs font-mono text-text-secondary py-6 text-center">
          No open positions among watched wallets.
        </div>
      )}

      <div className="space-y-3">
        {(positions ?? []).map((p) => {
          const status = statusCopy(p);
          return (
            <div
              key={`${p.wallet}:${p.protocol}`}
              className="flex flex-col sm:flex-row justify-between sm:items-center p-4 rounded-md border border-border-subtle bg-surface-raised/50 gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <ProtocolLogo protocol={PROTOCOL_NAME[p.protocol]} size="w-8 h-8" />
                <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-mono font-bold text-text-primary truncate">
                    {PROTOCOL_NAME[p.protocol]} · {p.scoredCollateralSymbol} position
                  </h4>
                  <span
                    className={`shrink-0 whitespace-nowrap text-2xs font-mono tabular-nums font-bold px-2 py-0.5 rounded-sm border ${RISK_CHIP[p.band]}`}
                  >
                    {p.total} {p.band}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5 text-2xs font-mono text-text-secondary">
                  <span className={status.cls}>{status.text}</span>
                  <span className="text-white/20">•</span>
                  <span>
                    HF:{" "}
                    <strong
                      className={
                        // No debt is not the same as a healthy ratio: there is no
                        // ratio to report, so it must not borrow the safe colour.
                        p.healthFactor === null
                          ? "text-risk-unknown tabular-nums"
                          : p.healthFactor < 1.25
                            ? "text-risk-critical tabular-nums"
                            : p.healthFactor < 1.7
                              ? "text-risk-elevated tabular-nums"
                              : "text-risk-low tabular-nums"
                      }
                    >
                      {p.healthFactor === null ? "no debt" : p.healthFactor.toFixed(2)}
                    </strong>
                  </span>
                  <span className="text-white/20">•</span>
                  <span className={p.usdValuesUnavailable ? "text-risk-unknown" : undefined}>
                    {fmtUsd(p.collateralValueUsd)} supplied / {fmtUsd(p.borrowValueUsd)} borrowed
                  </span>
                  {p.usdValuesUnavailable && (
                    <>
                      <span className="text-white/20">•</span>
                      <span
                        className={`flex items-center gap-1 text-2xs font-mono font-bold px-2 py-0.5 rounded-sm border ${RISK_CHIP.UNKNOWN}`}
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

              <div className="flex items-center gap-3 shrink-0 text-2xs font-mono text-text-secondary">
                <span className="flex items-center gap-1 tabular-nums" title="Sub-scores: position / asset / protocol / systemic">
                  <Activity className="w-3 h-3 text-panik-orange" />
                  {Math.round(p.subScores.positionHealth)} · {Math.round(p.subScores.assetRisk)} ·{" "}
                  {Math.round(p.subScores.protocolSafety)} · {Math.round(p.subScores.systemicRisk)}
                </span>
                {onStressTest && (
                  <button
                    onClick={() => onStressTest(p)}
                    title="Stress-test this position in Watch"
                    className="flex items-center gap-1 text-2xs font-mono font-bold text-panik-orange bg-panik-orange/10 border border-panik-orange/25 px-2 py-1 rounded-md hover:bg-panik-orange/20 cursor-pointer transition-all"
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
        <p className="mt-4 text-2xs font-mono text-text-muted">
          Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF)
          + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s.
        </p>
      )}
    </div>
  );
}
