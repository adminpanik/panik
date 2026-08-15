/**
 * LIVE positions — real wallets from the Supabase watch registry, scored by
 * the actual PANIK engine against live Base mainnet state. Data arrives via
 * props from AppDemo's useLiveScores() hook (shared with the Portfolio
 * metrics) — this component only renders.
 */

import React, { useEffect, useRef } from "react";
import { AlertTriangle, ArrowRight, Eye } from "lucide-react";
import type { LiveWalletPosition, ScoringChainInfo } from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import {
  formatUsd,
  limitStateCopy,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  PROTOCOL_LABEL,
  RISK_CHIP,
  USD_UNAVAILABLE_HINT,
  USD_UNAVAILABLE_LABEL,
} from "../lib/utils";
import { Button, Card, EmptyState, RiskDial, SimulationChip, Skeleton } from "../ui";
import { exitControlState, useChainMode } from "../lib/chainMode";
import type { ExitPrefill } from "./ExitFlow";

/**
 * The row identity the alert feed navigates to. Same shape as the React key, and
 * exported so the caller does not hand-assemble the string it has to match.
 */
export function positionKey(p: Pick<LiveWalletPosition, "wallet" | "protocol">): string {
  return `${p.wallet}:${p.protocol}`;
}

/**
 * How the header names the chain, and what the provenance tip may claim.
 *
 * Nothing is rendered on the default chain: "Base" beside every position on
 * every mainnet install is a caption that never changes, which is the kind of
 * text DESIGN_SYSTEM's three-way copy test deletes. It is rendered the moment
 * the API reports anything else, because THEN the chain is the thing a user
 * would otherwise get wrong.
 *
 * The tip is rebuilt rather than reworded because the mainnet sentence names
 * CoinGecko and DefiLlama, and on a testnet neither is consulted at all: a
 * degraded read must not come with a caption asserting the source it did not
 * use.
 */
function chainProvenance(chain: ScoringChainInfo | null): { badge: string | null; tip: string } {
  const MAINNET_TIP =
    "Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF) + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s.";
  if (chain === null || chain.mode === "mainnet") return { badge: null, tip: MAINNET_TIP };
  return {
    badge: chain.label,
    tip:
      `Scored by the PANIK engine from live RPC reads on ${chain.label} ` +
      "(Aave getUserAccountData), the same chain the exit runs on. Test assets have no " +
      "price history and no protocol TVL to read, so market risk is left unmeasured and " +
      "the score is weighted over position health and protocol safety. Refreshes every 60s.",
  };
}

interface LivePositionsProps {
  positions: LiveWalletPosition[] | null;
  offline: boolean;
  /**
   * The chain the API says it read these positions from, or null when it did
   * not say. Null renders no claim, never a guessed chain name.
   */
  chain?: ScoringChainInfo | null;
  /** Optional: open this real position in the Watch simulator (stress-test bridge). */
  onStressTest?: (position: LiveWalletPosition) => void;
  /**
   * The action the ENGINE recommends for a protocol, keyed by protocol id, or
   * an absent key for "nothing to do here".
   *
   * Passed in rather than derived, and that is the whole point of the shape.
   * This list knows a band and a health factor; it does not know whether the
   * answer is to close the position or to repay part of it, and it cannot size
   * a repay. The Advisor does, so the row offers the Advisor's own
   * recommendation and its own prefill. A button here that assumed "critical
   * means full exit" would be this component inventing advice, and it would
   * disagree with the Advisor tab the moment the engine sized a REDUCE instead.
   */
  exitActions?: Record<string, { label: string; prefill: ExitPrefill } | undefined>;
  /** Runs the action above. Absent disables the control rather than hiding it. */
  onExit?: (prefill: ExitPrefill) => void;
  /**
   * `positionKey` of the row an alert just pointed at, or null for none. The row
   * scrolls into view, takes focus and holds a neutral emphasis until the caller
   * clears it.
   */
  highlightKey: string | null;
}

export function LivePositions({
  positions,
  offline,
  chain = null,
  onStressTest,
  exitActions,
  onExit,
  highlightKey,
}: LivePositionsProps) {
  // Shared with the Advisor card, so the same control cannot be live on one
  // surface and dead on the other. Disabled with the reason on hover, not
  // hidden — a control that vanishes teaches nothing about why.
  const { enabled: exitEnabled, hint: exitDisabledHint } = exitControlState(onExit, useChainMode());
  const provenance = chainProvenance(chain);
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
      <h3 className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-sans font-semibold text-text-primary">
        {positions === null
          ? "Positions"
          : `${positions.length} ${positions.length === 1 ? "Position" : "Positions"}`}
        <InfoTip text={provenance.tip} />
        {/* Neutral, never the risk ramp: which chain you are on is not a risk
            band, and the ramp on this screen is spoken for by the dials. Same
            treatment as the standing-permission card's marker. */}
        {provenance.badge && (
          <span className="rounded-sm border border-border-strong px-2 py-0.5 text-2xs font-sans font-bold text-text-secondary">
            {provenance.badge}
          </span>
        )}
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
            /**
             * The marker rations itself to the legs measured OUTSIDE the user's
             * risk limit, which is `profileStatus` and is a different fact from
             * the band: the band is how exposed the position is in the absolute,
             * the limit state is whether that reading has crossed the level this
             * user asked to be told about. The clause at the end of line 3 states
             * it in words; this is the same fact made findable in a scan of four
             * rows. No new threshold is invented, the engine sets it.
             *
             * It used to fire on `p.band !== "LOW"`, which is the quantity the
             * DIAL on the same row already carries - the band drawn twice, once
             * as an arc and once as a hue on a glyph beside it.
             */
            const actionable = p.profileStatus !== "within";
            const action = exitActions?.[p.protocol];
            return (
              <li
                key={key}
                ref={highlighted ? highlightedRow : undefined}
                tabIndex={-1}
                /* Emphasis, not a risk statement. The alert feed points here,
                   so the row has to be findable the moment it scrolls into
                   view — but the risk ramp is spoken for on this screen, and a
                   row painted because it was NAVIGATED to would be the ramp
                   asserting something about danger that the score does not
                   support. A stronger edge on the neutral border token says
                   "this one" without saying anything about how dangerous it
                   is. */
                className={`flex items-start gap-3 rounded-md border p-4 transition-colors ${
                  highlighted
                    ? "border-border-strong bg-white/[0.05]"
                    : "border-border-subtle bg-surface-raised/50"
                }`}
              >
                <ProtocolLogo protocol={PROTOCOL_LABEL[p.protocol]} size="w-8 h-8" />

                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* Line 1 — identity. The protocol never shrinks; only the
                      asset symbol may truncate, because "Aave V3" truncated to
                      "Aav…" is unreadable while "wstE…" is still placeable. The
                      score is not here: on the rail instead, which is what keeps
                      this line three short strings on a 390px phone. */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h4 className="shrink-0 text-sm font-sans font-bold text-text-primary">
                      {PROTOCOL_LABEL[p.protocol]}
                    </h4>
                    <span className="truncate text-xs font-sans text-text-secondary">
                      {p.scoredCollateralSymbol}
                    </span>
                    {/* "This one has crossed your limit", on the line that
                        identifies the position. NEUTRAL INK, and that is the
                        point of it: the risk ramp on this screen is spent on the
                        four dials plus the aggregate glyph, which is the whole
                        budget DESIGN_SYSTEM.md sets for Portfolio, and this
                        glyph took `RISK_TEXT[p.band]` on top of a dial drawn
                        from the same `p.band` inches away. Measured, that put
                        eleven risk-hued elements on the tab against a documented
                        five. Shape is findability; hue is a claim, and the claim
                        was already made by the dial.

                        `aria-hidden`, because `RiskDial` on the rail already
                        announces "PANIK risk score 75 of 100, CRITICAL" and the
                        limit clause on line 3 is read out in full. Nothing here
                        is carried by colour, which is what SC 1.4.1 asks and
                        what a neutral glyph satisfies by construction. */}
                    {actionable && (
                      <AlertTriangle
                        className="h-3.5 w-3.5 shrink-0 self-center text-text-secondary"
                        aria-hidden="true"
                      />
                    )}
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
                        title={USD_UNAVAILABLE_HINT}
                        className={`inline-flex cursor-help items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {USD_UNAVAILABLE_LABEL}
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
                      is `risk-unknown`, which is NOT a band, so this marker
                      spends none of the row's risk-hue budget and must never
                      take a band colour: "we could not measure this" is not a
                      severity.

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

                  {/* A row whose figures came from a simulated price. PER ROW,
                      not per screen: a scenario names assets, so one position
                      can be simulated while the one under it is real, and the
                      banner at the top of the app cannot say which is which.

                      Deliberately NOT merged with the two markers above. Those
                      say "we could not measure this"; this one says "we
                      measured this against a price we invented". A simulated
                      figure is KNOWN - it is exact arithmetic on a stated
                      price - and rendering it in the not-measured treatment
                      would collapse two states the rest of this file spends
                      considerable effort keeping apart. It also spends no risk
                      hue: a simulated position can be perfectly safe. */}
                  {p.simulation && (
                    <div className="flex">
                      <SimulationChip />
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

                  {/* Line 4 — the way out, on the rows that have one.

                      Only where the ENGINE named an action for this protocol, so
                      a row never offers a door the Advisor is not also pointing
                      at, and the label is the Advisor's ("Execute exit" /
                      "Reduce position") rather than a second vocabulary for the
                      same two outcomes.

                      The SAME treatment as the Advisor's control - `lg` primary,
                      14px label on the near-white plate - because it is the same
                      action opening the same modal with the same prefill. It was
                      briefly a quieter `outline` here on the theory that the
                      dashboard should not compete with the Advisor for the one
                      obvious next step; that traded a real cost for a
                      hypothetical one. Two visual weights for one action teaches
                      a user that they are two different things, and the moment
                      they look different someone has to work out which is the
                      real one. `Button` accepts no risk band either way, so
                      matching the Advisor costs nothing from the risk ramp. */}
                  {action && (
                    <div className="mt-2">
                      <Button
                        size="lg"
                        onClick={exitEnabled ? () => onExit?.(action.prefill) : undefined}
                        disabled={!exitEnabled}
                        title={exitEnabled ? undefined : exitDisabledHint}
                      >
                        {action.label}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
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
                      aria-label={`Stress-test the ${PROTOCOL_LABEL[p.protocol]} position in Watch`}
                      className="px-1.5 py-1"
                    >
                      {/* Eye, not sliders: this button lands on Watch, and Watch
                          wears the eye in the nav. The icon should name where it
                          goes, not what it does to the numbers once it arrives. */}
                      <Eye className="h-3.5 w-3.5" />
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
