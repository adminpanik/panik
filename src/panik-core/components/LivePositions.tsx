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
import { formatUsd, limitStateCopy, RISK_CHIP } from "../lib/utils";
import { Button, Card, EmptyState, RiskDial, Skeleton } from "../ui";

const PROTOCOL_NAME: Record<LiveWalletPosition["protocol"], string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/**
 * Line 3's second clause comes from `limitStateCopy` in lib/utils, shared with
 * the alert log so both surfaces name the same three states the same way.
 *
 * It used to be retyped here as "outside your profile" / "approaching your
 * limit" / "within your profile" — three strings that each embedded the raw
 * `ProfileStatus` token they were translating, which is how "approaching"
 * ended up being read as an internal value rather than a word.
 *
 * A sentence does not get painted. Both halves used to carry the risk ramp, so
 * a single row could show red prose, a red dial and a red numeral for one fact
 * stated once. The dial on the rail is the band; this line is the reason, and
 * reasons read better in muted grey.
 */

/** No debt is not the same as a healthy ratio: there is no ratio to report. */
function healthCopy(p: LiveWalletPosition): string {
  if (p.healthFactor === null) return "No debt";
  return `Health factor ${p.healthFactor.toFixed(2)}`;
}

interface LivePositionsProps {
  positions: LiveWalletPosition[] | null;
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
      {/* The count lives HERE, not in a grey subline on the "Protocols
          watched" card three columns away. It is a fact about this list, and a
          list that states its own length needs no second card to do it — that
          subline was also the one place the two cards could disagree, because
          they were reading the same array through different props.

          Only rendered once the array has arrived: "0 Positions" while the
          first fetch is still in flight is a claim we cannot make yet, and it
          is the exact claim this product must never make by accident. */}
      <h3 className="flex items-center gap-1.5 text-sm font-sans font-semibold text-text-primary">
        {positions === null
          ? "Positions"
          : `${positions.length} ${positions.length === 1 ? "Position" : "Positions"}`}
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
                      "Aav…" is unreadable while "wstE…" is still placeable.

                      The score is no longer competing for the end of this line.
                      It used to be a chip here, which is why the line needed to
                      wrap: chip plus protocol plus symbol plus address did not
                      fit a ~210px phone row, and the symbol was the thing that
                      got squeezed to nothing. With the score moved to its own
                      rail, this line is three short strings and stays one line
                      on every width. */}
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

                  {/* Line 2 — magnitudes, and the reason this row exists.
                      It used to render at 12px in text-secondary: the dimmest,
                      smallest thing in a row whose entire point is two dollar
                      figures. The protocol name above it — which the brand mark
                      to the left already states — was the loudest. That is
                      backwards, so the money is now 14px and the figures
                      themselves are text-primary.

                      The words stay secondary. "collateral" and "debt" are
                      units; giving them the same weight as the numbers turns
                      the line into an undifferentiated bar of near-white and
                      costs the scanning advantage the size bought.

                      Two nowrap chunks rather than one. The pair still never
                      breaks in half — half a pair reads as a whole number — but
                      at 14px the single span was ~230px against ~240px of row
                      on a 390px phone, so the pair now wraps BETWEEN its halves
                      instead of overflowing.

                      When the price feed is degraded this line is REPLACED, not
                      dimmed. It used to render "$… collateral / $… debt" in
                      grey, and an ellipsis standing where digits belong is what
                      a truncated string looks like, so the honest statement
                      "we could not price this" was read as "this component is
                      broken". A sentence cannot be mistaken for a clipped
                      number, so the sentence is what renders.

                      The treatment is the one this product already uses for
                      "we do not know": dashed edge, risk-unknown grey — the
                      same pairing as EmptyState's `problem` tone and the
                      unknown score chip. Distinctness from a healthy row is a
                      CORRECTNESS requirement here, not a preference, and it now
                      holds on four independent axes: different shape (a bordered
                      block, not a figure pair), different colour, an icon, and
                      words that say it outright. No branch of this can emit
                      "$0".

                      The treatment comes from `RISK_CHIP.UNKNOWN` rather than
                      being retyped here, and the difference is not cosmetic:
                      the canonical entry carries NO fill because a 10% wash of
                      this grey under this grey label measures 4.26:1, and the
                      hand-written copy this replaced had reintroduced exactly
                      that fill. A contrast decision that lives in one file and
                      is re-typed in another is a decision that only holds
                      until someone types it slightly differently.

                      This marker is now the ONLY place the degraded state is
                      stated. It used to be said three times in one row — here,
                      again in line 3's clause, and a third time in a bolded
                      "Prices degraded:" paragraph under it — which made the one
                      row carrying a caveat the tallest and busiest thing on the
                      page, 159px against its siblings' 117px. Three
                      restatements of one condition do not make it three times
                      as clear; they make the row look broken.

                      So the marker keeps the four distinctness axes (shape,
                      colour, icon, words) and takes the explanation onto its
                      own hover, where the row's other recoverable detail
                      already lives. `cursor-help` is what advertises that the
                      hover exists; without it a `title` is a secret.

                      Vertical padding is `py-0.5`, not `py-1`: this block
                      stands in for the money line on every other row, and the
                      row is only the same height as its siblings if its
                      substitute is the same height as what it replaces. */}
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

                  {/* Line 3 — verdict, as one sentence.

                      14px, not 12px. This is the row's verdict — "your health
                      factor is X and that is outside the profile you chose" —
                      and it was set smaller than the protocol label above it.
                      Secondary is the right COLOUR (it is prose, and prose does
                      not compete with figures); 12px was the wrong size for it.

                      One sentence, the SAME sentence, on every row — including
                      the degraded one. The "Prices degraded: the score and
                      health factor above are exact…" paragraph that used to
                      hang off this line was a third statement of what the
                      marker on line 2 already says with a shape, a colour, an
                      icon and four words. It now lives on that marker's hover:
                      the fact is not lost, it is just no longer shouted three
                      times at the one user who is already looking at a warning.

                      The verdict now gets the full column width. The
                      Stress-test button used to sit at the end of this line and
                      then, when that crushed the sentence, on a line of its
                      own below it — both of which were the same problem, which
                      is that a secondary action was being laid out inside a
                      block of prose. It lives on the rail now, with the score
                      it acts on. */}
                  <p className="text-sm font-sans text-text-secondary">
                    <span className="tabular-nums">{health}</span>, {status}
                  </p>
                </div>

                {/* Right rail — the score, and the one thing you can do about
                    it. Grouping them is the point: "this is 75" and "simulate
                    75 under a price move" are one thought, and they were at
                    opposite corners of the row.

                    Icon-only, because the rail is as wide as the dial (44px)
                    and a 110px labelled button would have taken a quarter of a
                    390px row away from the figures. It keeps its name for
                    everything that is not a sighted mouse user: `title` for the
                    tooltip, `aria-label` for the accessibility tree. */}
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
