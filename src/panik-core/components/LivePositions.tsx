/**
 * LIVE positions — real wallets from the Supabase watch registry, scored by
 * the actual PANIK engine against live Base mainnet state. Data arrives via
 * props from AppDemo's useLiveScores() hook (shared with the Portfolio
 * metrics) — this component only renders.
 */

import React, { useEffect, useRef } from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import type { LiveWalletPosition } from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import {
  formatUsd,
  limitStateCopy,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  RISK_CHIP,
} from "../lib/utils";
import { Button, Card, EmptyState, RiskDial, Skeleton } from "../ui";

const PROTOCOL_NAME: Record<LiveWalletPosition["protocol"], string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/**
 * The row identity the alert feed navigates to. Same shape as the React key, and
 * exported so the caller does not hand-assemble the string it has to match.
 */
export function positionKey(p: Pick<LiveWalletPosition, "wallet" | "protocol">): string {
  return `${p.wallet}:${p.protocol}`;
}

interface LivePositionsProps {
  positions: LiveWalletPosition[] | null;
  offline: boolean;
  /** Optional: open this real position in the Watch simulator (stress-test bridge). */
  onStressTest?: (position: LiveWalletPosition) => void;
  /**
   * `positionKey` of the row an alert just pointed at, or null for none. The row
   * scrolls into view, takes focus and holds a neutral emphasis until the caller
   * clears it.
   */
  highlightKey: string | null;
}

export function LivePositions({ positions, offline, onStressTest, highlightKey }: LivePositionsProps) {
  /**
   * One ref, attached to the highlighted row only. Refs are set during commit,
   * before effects run, so the row this points at is always the one the current
   * `highlightKey` names.
   */
  const highlightedRow = useRef<HTMLLIElement | null>(null);

  /**
   * Scrolling is not enough on its own. A sighted mouse user sees the row move
   * under them; a keyboard or screen-reader user pressing Enter on an alert
   * gets nothing at all unless focus follows, and would then Tab on from the
   * alert feed rather than from the thing they just navigated to. `tabIndex=-1`
   * on the row makes it focusable as a DESTINATION without adding a tab stop.
   *
   * Keyed on the KEY alone. `positions` gets a fresh array identity on every 60s
   * poll, so depending on it meant a poll landing inside the highlight window
   * re-ran this and stole focus back mid-scroll.
   */
  useEffect(() => {
    const row = highlightedRow.current;
    if (!highlightKey || !row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.focus({ preventScroll: true });
  }, [highlightKey]);
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
      {/* The count lives HERE, on the list it describes, rather than in a
          subline on a card three columns away that read the same array through
          different props and could therefore disagree with it. The provenance
          moved into the InfoTip: it is an answer to a question asked once, not a
          caption needed on every glance.

          Only rendered once the array has arrived: "0 Positions" while the first
          fetch is still in flight is a claim we cannot make yet, and it is the
          exact claim this product must never make by accident. */}
      <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary">
        {positions === null
          ? "Positions"
          : `${positions.length} ${positions.length === 1 ? "Position" : "Positions"}`}
        <InfoTip text="Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF) + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s." />
      </h3>

      {positions === null && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-md border border-border-subtle bg-surface-raised/50 p-4">
              <Skeleton className="h-8 w-8 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-3 w-48" />
              </div>
              {/* The rail is reserved while loading. A skeleton that omits it
                  hands the real row a 44px shove sideways the moment data
                  lands, which is the jump the skeleton exists to prevent. */}
              <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
            </div>
          ))}
          <p className="text-xs font-sans text-text-secondary">Reading positions from chain…</p>
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
            const status = limitStateCopy(p.profileStatus);
            const outlook = liquidationOutlook(p.healthFactor, p.scoredCollateralSymbol);
            const key = positionKey(p);
            const highlighted = key === highlightKey;
            return (
              <li
                key={key}
                ref={highlighted ? highlightedRow : undefined}
                tabIndex={-1}
                /* Emphasis, not a risk statement. The alert feed points here,
                   so the row has to be findable the moment it scrolls into
                   view — but a fifth risk hue on this page would break the
                   "one colour per band, five coloured things" budget the
                   Portfolio is held to. A stronger edge on the neutral border
                   token says "this one" without saying anything about how
                   dangerous it is. */
                className={`flex items-start gap-3 rounded-md border p-4 transition-colors ${
                  highlighted
                    ? "border-border-strong bg-white/[0.05]"
                    : "border-border-subtle bg-surface-raised/50"
                }`}
              >
                <ProtocolLogo protocol={PROTOCOL_NAME[p.protocol]} size="w-8 h-8" />

                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* Line 1 — identity. The protocol never shrinks; only the
                      asset symbol may truncate, because "Aave V3" truncated to
                      "Aav…" is unreadable while "wstE…" is still placeable. The
                      score is not here: on the rail instead, which is what keeps
                      this line three short strings on a 390px phone. */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h4 className="shrink-0 text-sm font-sans font-bold text-text-primary">
                      {PROTOCOL_NAME[p.protocol]}
                    </h4>
                    <span className="truncate text-xs font-sans text-text-secondary">
                      {p.scoredCollateralSymbol}
                    </span>
                    {showWallet && (
                      <span className="ml-auto shrink-0 text-xs font-mono text-text-muted">
                        {p.wallet.slice(0, 6)}…{p.wallet.slice(-4)}
                      </span>
                    )}
                  </div>

                  {/* Line 2 — magnitudes, and the reason this row exists. 14px
                      with the figures in primary ink and the units left
                      secondary, so the money is what the eye lands on. Two
                      nowrap chunks, not one: the pair must never break in half
                      (half a pair reads as a whole number) but at 14px a single
                      span overflowed a 390px row, so it wraps BETWEEN its
                      halves.

                      A degraded price feed REPLACES this line rather than
                      dimming it. "$… collateral" is indistinguishable from a
                      truncated string, so the honest statement got read as a
                      broken component; a sentence cannot be misread that way.
                      Distinctness from a healthy row is a CORRECTNESS
                      requirement here, and it holds on four axes: shape,
                      colour, icon, and words. No branch of this can emit "$0".

                      The treatment comes from `RISK_CHIP.UNKNOWN`, not a local
                      copy: that entry carries no fill because a 10% wash of
                      this grey under this grey label measures 4.26:1, and a
                      contrast decision re-typed in a second file holds only
                      until someone types it differently.

                      This marker is the ONLY place the degraded state is
                      stated; the explanation is on its hover, and `cursor-help`
                      is what advertises that the hover exists.

                      `py-0.5`, not `py-1`: this block stands in for the money
                      line, and the row only matches its siblings' height if its
                      substitute matches what it replaces. */}
                  {p.usdValuesUnavailable ? (
                    <div className="flex">
                      <span
                        title="A price feed this position's USD conversion depends on was missing or stale. The PANIK score and health factor are unaffected - they are ratios - so only the dollar amounts are unknown."
                        className={`inline-flex cursor-help items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        USD amounts unavailable
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm font-sans tabular-nums text-text-secondary">
                      <span className="whitespace-nowrap">
                        <span className="font-semibold text-text-primary">
                          {formatUsd(p.collateralValueUsd)}
                        </span>{" "}
                        collateral
                      </span>
                      <span className="whitespace-nowrap">
                        <span className="font-semibold text-text-primary">
                          {formatUsd(p.borrowValueUsd)}
                        </span>{" "}
                        debt
                      </span>
                    </div>
                  )}

                  {/* A market-context term the engine could not read. Separate
                      from the USD marker above and never merged with it: the
                      two failures are independent (a leg can be priced exactly
                      and still lose its asset-risk lookup), and they withhold
                      different things — that one withholds the dollars, this
                      one withholds part of the score.

                      Same treatment as the USD marker, from the same
                      `RISK_CHIP.UNKNOWN`: unfilled, dashed edge, icon and
                      words, so "not measured" survives greyscale and is
                      distinguishable from a healthy row on four axes. The grey
                      is `risk-unknown`, which is not a band, so this row still
                      spends exactly one risk hue (its dial).

                      `text-xs`, one step under the money line it sits below:
                      this is a caveat about the score on the rail, not the
                      row's headline. */}
                  {marketContextMissing(p.subScores) && (
                    <div className="flex">
                      <span
                        title={MARKET_CONTEXT_MISSING_HINT}
                        className={`inline-flex cursor-help items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {MARKET_CONTEXT_MISSING_LABEL}
                      </span>
                    </div>
                  )}

                  {/* Line 3 — verdict, as one sentence. A health factor as the
                      price move it means, because a ratio on an unstated scale
                      is not something a non-expert can decide on. The
                      arithmetic and the wording are the engine's
                      (`liquidationOutlook`), never this file's.

                      A `title` rather than an InfoTip: the tip's anchor is
                      `inline-flex` and cannot wrap, and this column is ~186px
                      on a 390px phone, so a non-wrapping clause here is
                      horizontal overflow.

                      The same sentence on every row, including the degraded
                      one. The degraded caveat is stated once, by the marker on
                      line 2. */}
                  <p className="text-sm font-sans text-text-secondary">
                    <span className="cursor-help tabular-nums" title={outlook.hover}>
                      {outlook.sentence}
                    </span>
                    , {status}
                  </p>
                </div>

                {/* Right rail — the score and the one thing you can do about
                    it, grouped because "this is 75" and "simulate 75 under a
                    price move" are one thought.

                    Icon-only, because the rail is as wide as the dial (44px) and
                    a 110px labelled button would take a quarter of a 390px row
                    from the figures. It keeps its name for everyone who is not a
                    sighted mouse user: `title` plus `aria-label`. */}
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <RiskDial score={p.total} band={p.band} subScores={p.subScores} />
                  {onStressTest && (
                    <Button
                      variant="quiet"
                      onClick={() => onStressTest(p)}
                      title="Stress-test this position in Watch"
                      aria-label={`Stress-test the ${PROTOCOL_NAME[p.protocol]} position in Watch`}
                      className="px-1.5 py-1"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

    </Card>
  );
}
