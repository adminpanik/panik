/**
 * LIVE positions — real wallets from the Supabase watch registry, scored by
 * the actual PANIK engine against live Base mainnet state. Data arrives via
 * props from AppDemo's useLiveScores() hook (shared with the Portfolio
 * metrics) — this component only renders.
 */

import React from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import type { LiveWalletPosition } from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import { Button, Card, EmptyState, RiskChip, Skeleton } from "../ui";

const PROTOCOL_NAME: Record<LiveWalletPosition["protocol"], string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/**
 * Line 3 is a sentence, and a sentence does not get painted. Both halves used
 * to carry the risk ramp, so a single row could show red prose, a red chip and
 * a red numeral for one fact stated once. The chip on line 1 is the band; this
 * line is the reason, and reasons read better in muted grey.
 *
 * Lower-case: this is a clause inside a sentence, not a label.
 */
function statusCopy(p: LiveWalletPosition): string {
  if (p.profileStatus === "outside") return "outside your profile";
  if (p.profileStatus === "approaching") return "approaching your limit";
  return "within your profile";
}

/** No debt is not the same as a healthy ratio: there is no ratio to report. */
function healthCopy(p: LiveWalletPosition): string {
  if (p.healthFactor === null) return "No debt";
  return `Health factor ${p.healthFactor.toFixed(2)}`;
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
  // The address only disambiguates in the registry ("ALL wallets") view. On a
  // single wallet it is the same string on every row, so it is noise competing
  // with the score chip for the end of line 1.
  const showWallet = new Set((positions ?? []).map((p) => p.wallet)).size > 1;

  if (offline) {
    return (
      <EmptyState
        tone="problem"
        title="Live feed unavailable"
        hint="We could not reach the scoring feed, so this wallet's positions are unknown right now. That is not the same as having none."
      />
    );
  }

  return (
    <Card className="space-y-4">
      {/* The provenance that used to sit as a permanent 24-word footer under
          the list. It is real and worth keeping — which RPC calls, which price
          and TVL sources, which refresh interval — but it is an answer to a
          question asked once, not a caption you need on every glance. It also
          gives this card the same titled header its three siblings on the
          Portfolio grid already have. */}
      <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary">
        Positions
        <InfoTip text="Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF) + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s." />
      </h3>

      {/* Three fixed lines instead of a wrapping chain of bullet-separated
          fragments. The old row let any fragment reflow, which stranded a "•"
          at the start of a line and split a "$X supplied / $Y borrowed" pair
          across two — a value pair that breaks in half is worse than one that
          overflows, because half a pair still reads as a whole number. */}
      {positions === null && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-md border border-border-subtle bg-surface-raised/50 p-4">
              <Skeleton className="h-8 w-8 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
          <p className="text-2xs font-sans text-text-muted">Reading positions from chain…</p>
        </div>
      )}

      {positions !== null && positions.length === 0 && (
        <EmptyState
          tone="clear"
          title="No open positions"
          hint="New positions are picked up within a minute of opening."
        />
      )}

      {positions !== null && positions.length > 0 && (
        <ul className="space-y-3">
          {(positions ?? []).map((p) => {
            const status = statusCopy(p);
            const health = healthCopy(p);
            return (
              <li
                key={`${p.wallet}:${p.protocol}`}
                className="flex items-start gap-3 rounded-md border border-border-subtle bg-surface-raised/50 p-4"
              >
                <ProtocolLogo protocol={PROTOCOL_NAME[p.protocol]} size="w-8 h-8" />

                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* Line 1 — identity. The protocol never shrinks; only the
                      asset symbol may truncate, because "Aave V3" truncated to
                      "Aav…" is unreadable while "wstE…" is still placeable. */}
                  <div className="flex items-baseline gap-2">
                    <h4 className="shrink-0 text-sm font-sans font-bold text-text-primary">
                      {PROTOCOL_NAME[p.protocol]}
                    </h4>
                    <span className="truncate text-xs font-sans text-text-secondary">
                      {p.scoredCollateralSymbol}
                    </span>
                    {showWallet && (
                      <span className="ml-auto shrink-0 text-2xs font-mono text-text-muted">
                        {p.wallet.slice(0, 6)}…{p.wallet.slice(-4)}
                      </span>
                    )}
                    <RiskChip
                      className={showWallet ? "" : "ml-auto"}
                      band={p.band}
                      title={`Sub-scores: position ${Math.round(p.subScores.positionHealth)}, asset ${Math.round(p.subScores.assetRisk)}, protocol ${Math.round(p.subScores.protocolSafety)}, systemic ${Math.round(p.subScores.systemicRisk)}`}
                    >
                      {p.total} {p.band}
                    </RiskChip>
                  </div>

                  {/* Line 2 — magnitudes. One nowrap span: the pair moves as a
                      unit or not at all. */}
                  <div className="flex items-center gap-2">
                    <span
                      className={`whitespace-nowrap text-xs font-sans tabular-nums ${
                        p.usdValuesUnavailable ? "text-risk-unknown" : "text-text-secondary"
                      }`}
                    >
                      {fmtUsd(p.collateralValueUsd)} collateral / {fmtUsd(p.borrowValueUsd)} debt
                    </span>
                  </div>

                  {/* Line 3 — verdict, as one sentence.
                      The degraded-price marker used to be a bordered chip
                      wedged into the value row, which put a box in the middle
                      of the only line whose job is to be scanned. It reads as
                      the tail of the sentence instead, but it still says so in
                      three independent ways — the amounts render as "$…" and
                      not "$0", the icon is there, and the words are there — so
                      a position we could not price can never be mistaken for a
                      healthy one. */}
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 text-xs font-sans text-text-secondary">
                      <span className="tabular-nums">{health}</span>, {status}
                      {p.usdValuesUnavailable && (
                        <span
                          className="mt-1 flex items-center gap-1 text-text-muted"
                          title="A price feed this position's USD conversion depends on was missing or stale. The health factor and PANIK score are unaffected; only the dollar amounts are unknown."
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          Prices degraded
                        </span>
                      )}
                    </p>
                    {onStressTest && (
                      <Button
                        variant="quiet"
                        onClick={() => onStressTest(p)}
                        title="Stress-test this position in Watch"
                        className="shrink-0 px-2 py-1 font-normal"
                      >
                        <SlidersHorizontal className="h-3 w-3" />
                        Stress-test
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

    </Card>
  );
}
