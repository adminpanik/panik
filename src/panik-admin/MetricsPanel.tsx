/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard: five figures describing what PANIK is watching right now.
 * The Watching tab of the admin console at /admin, behind the same gate as
 * every other panel there.
 *
 * ── TWO LABELS THAT ARE DELIBERATELY NOT WHAT WAS ASKED FOR ───────────────
 * "TVL" is rendered as "Collateral monitored". PANIK is non-custodial: this
 * money sits in the user's own Aave/Moonwell/Morpho position and PANIK could
 * not touch it if it wanted to. A tile reading "TVL" over that sum claims
 * custody the product does not have, and it is the kind of number that ends up
 * in a deck. The escrow contract is the only value PANIK actually holds, and it
 * is a different, much smaller figure that does not belong in this total.
 *
 * "Transaction volume" counts lending events on WATCHED wallets. Unscoped, the
 * Goldsky table reports every Aave user on Base, which is a fact about Base
 * rather than about PANIK. It is also not an all-time figure: retention prunes
 * that table to 7 days, so the tiles state the span they actually cover instead
 * of implying one the data cannot support.
 *
 * ── SIMULATED PRICES ARE NOT IN THESE NUMBERS ─────────────────────────────
 * A scenario armed on the Simulator tab multiplies the collateral USD written
 * into every snapshot it produces. The RPC filters those rows out, so
 * "Collateral monitored" keeps reporting the market while a crash is being
 * demonstrated. The cost is that the reading can be older than the last tick,
 * which is what the staleness cue is for.
 *
 * Nothing here renders an unknown as a zero, and nothing renders a known zero
 * as an unknown. A missing price, an events pipeline that has never ingested
 * anything, and a genuine zero are three different statements, and the tiles
 * say which one they mean. The unknown is now the WORDS "Not on record" rather
 * than an ellipsis: "$…" is a dollar sign in front of nothing, which reads as
 * a figure that failed to render rather than as a fact we do not hold.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, EmptyState, Skeleton, Stat } from "../panik-core/ui";
import { formatUsd } from "../panik-core/lib/utils";
import { Panel, PANEL_BODY, ReloadButton } from "./ui/controls";
import { getMetrics, isSignedOut, type AdminMetrics } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** Count -> text. Null is unknown, and unknown is never 0. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** A figure we do not hold, in words. Never a zero and never a bare glyph. */
function NotOnRecord() {
  return <span className="font-sans text-base text-text-secondary">Not on record</span>;
}

/**
 * How much of the total was read recently, as a ratio.
 *
 * Not a timestamp, because neither end of the distribution summarised it. The
 * newest reading called all 21 positions current on the strength of one. The
 * oldest then read "7 d old" permanently, because a single Aave leg closed
 * on-chain keeps its final snapshot and pins the minimum to the day it closed,
 * so the cue said the same thing whether the worker was healthy or dead.
 *
 * A count moves in proportion: one abandoned leg costs one of twenty-one and
 * stays visible, and a real outage collapses the numerator.
 */
function readingCue(m: AdminMetrics): string | undefined {
  if (m.positionsMonitored === 0) return "No readings yet";
  // An older server, or the serverless mirror, returns no window: the mapper
  // floors the absent field to 0 and the sentence would become "0 of 21 read in
  // the last 0 min", which is not a degraded cue but a false one. Say nothing
  // instead: the figure above it is still true, and this line is optional.
  if (m.freshWindowMinutes <= 0) return undefined;
  const window = `${formatCount(m.freshWindowMinutes)} min`;
  return m.positionsFresh === m.positionsMonitored
    ? `All ${formatCount(m.positionsMonitored)} read in the last ${window}`
    : `${formatCount(m.positionsFresh)} of ${formatCount(m.positionsMonitored)} read in the last ${window}`;
}

/**
 * How long ago, as a bare duration, coarse on purpose: this is a freshness cue
 * and not a timestamp. Bare rather than "… ago" so one helper serves both "3
 * min old" and "go back 6 d"; a sub-minute gap is a phrase for the same reason,
 * since "0 min old" reads as a stuck clock.
 */
function elapsed(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * The rules BETWEEN the tiles, as one expression read by every cell.
 *
 * A grid of bordered cards would draw a 3px edge twice wherever two cards meet.
 * Rules on the cells instead: a top rule on everything past the first row, a
 * left rule on everything past the first column, and the card's own edge closes
 * the outside. The row and column a cell is in depends on the breakpoint, which
 * is why both are written as a base rule and an `md:` correction rather than as
 * one static string.
 */
function cellRules(i: number): string {
  const top = i > 0 ? (i < 3 ? "border-t-[3px] md:border-t-0" : "border-t-[3px]") : "";
  const left = i % 3 !== 0 ? "md:border-l-[3px]" : "";
  return `border-border-strong ${top} ${left}`;
}

export function MetricsPanel({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await getMetrics(session);
    setLoading(false);
    if (res.ok && res.data) {
      setMetrics(res.data);
      setError("");
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setError(res.error ?? "Could not load the figures.");
    }
  }, [session, onSignedOut]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // How many watched positions carried no price at the last reading. Shown
  // rather than folded away: a total that silently omits four positions is a
  // total the operator would quote as if it were complete.
  const unpriced = metrics ? metrics.positionsMonitored - metrics.positionsPriced : 0;
  const freshness = metrics ? readingCue(metrics) : null;
  const eventsSpan = elapsed(metrics?.txOldestAt ?? null);

  return (
    <Panel
      title="What PANIK is watching"
      actions={<ReloadButton onClick={refresh} label="Reload the figures" />}
    >
      {error ? (
        <div className={PANEL_BODY}>
          <EmptyState
            tone="problem"
            title="Could not load the figures"
            hint={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            }
          />
        </div>
      ) : !metrics ? (
        <div className="grid md:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={`p-5 ${i === 4 ? "md:col-span-2" : ""} ${cellRules(i)}`}>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-2 h-8 w-36" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid md:grid-cols-3">
          <div className={`p-5 ${cellRules(0)}`}>
            <Stat
              label="Collateral monitored"
              value={
                metrics.collateralUsd === null ? <NotOnRecord /> : formatUsd(metrics.collateralUsd)
              }
              sub={
                unpriced > 0
                  ? `${formatCount(unpriced)} of ${formatCount(metrics.positionsMonitored)} positions had no price`
                  : (freshness ?? undefined)
              }
            />
          </div>
          <div className={`p-5 ${cellRules(1)}`}>
            <Stat
              label="Transaction volume"
              value={
                metrics.eventsReady && metrics.txVolumeUsd !== null ? (
                  formatUsd(metrics.txVolumeUsd)
                ) : (
                  <NotOnRecord />
                )
              }
              sub={
                !metrics.eventsReady
                  ? "No lending events on record yet"
                  : metrics.txUnpriced && metrics.txUnpriced > 0
                    ? `${formatCount(metrics.txUnpriced)} of ${formatCount(metrics.txCount ?? 0)} events carried no USD amount`
                    : eventsSpan
                      ? `Events on record go back ${eventsSpan}`
                      : undefined
              }
            />
          </div>
          <div className={`p-5 ${cellRules(2)}`}>
            <Stat
              label="Transactions"
              value={
                metrics.eventsReady && metrics.txCount !== null ? (
                  formatCount(metrics.txCount)
                ) : (
                  <NotOnRecord />
                )
              }
              sub={
                !metrics.eventsReady
                  ? "No lending events on record yet"
                  : eventsSpan
                    ? `Events on record go back ${eventsSpan}`
                    : undefined
              }
            />
          </div>
          <div className={`p-5 ${cellRules(3)}`}>
            <Stat
              label="Wallets connected"
              value={formatCount(metrics.walletsConnected)}
              sub="Active in the watch registry"
            />
          </div>
          {/* `md:col-span-2`: five figures in a three-column grid leave a
              sixth cell with nothing in it, which reads as a missing figure
              rather than as empty grid track. Giving the last cell the
              remaining two columns fills the row instead of leaving a
              bordered blank beside it. */}
          <div className={`p-5 md:col-span-2 ${cellRules(4)}`}>
            <Stat
              label="Positions monitored"
              value={formatCount(metrics.positionsMonitored)}
              sub={freshness ?? undefined}
            />
          </div>
        </div>
      )}
      {/* `loading` is read so a reload while figures are already on screen is
          not a silent no-op: the panel keeps the last reading and says it is
          fetching a new one, rather than blanking back to skeletons. */}
      {loading && metrics ? (
        <p className="border-t-[3px] border-border-strong px-5 py-2 font-sans text-xs text-text-muted">
          Reading again.
        </p>
      ) : null}
    </Panel>
  );
}
