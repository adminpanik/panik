/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard: five figures describing what PANIK is watching right now.
 * The first panel of the admin console at /admin, behind the same gate as every
 * other panel there.
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
 * The simulator panel sits directly below this one, and a scenario armed there
 * multiplies the collateral USD written into every snapshot it produces. The
 * RPC filters those rows out, so "Collateral monitored" keeps reporting the
 * market while a crash is being demonstrated. The cost is that the reading can
 * be older than the last tick, which is what the staleness cue is for.
 *
 * Nothing here renders an unknown as a zero, and nothing renders a known zero
 * as an unknown. A missing price, an events pipeline that has never ingested
 * anything, and a genuine zero are three different statements, and the tiles
 * say which one they mean.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, Card, EmptyState, Skeleton, Stat } from "../panik-core/ui";
import { formatUsd } from "../panik-core/lib/utils";
import { getMetrics, isSignedOut, type AdminMetrics } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** Count -> text. Null is unknown, and unknown is never 0. Pairs with "$…". */
function formatCount(value: number | null): string {
  return value === null ? "…" : value.toLocaleString("en-US");
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
  // Both cues are the OLDEST of their set. "Last reading 2 min ago" was true of
  // whichever position happened to be scored most recently and said nothing
  // about the other eighteen; the age of the worst contributor is the one that
  // tells an operator whether the total beside it is worth quoting.
  const staleness = elapsed(metrics?.oldestReadingAt ?? null);
  const eventsSpan = elapsed(metrics?.txOldestAt ?? null);

  return (
    <Card tone="panel" className="mb-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-sans font-bold text-text-primary">What PANIK is watching</h2>
        <Button variant="quiet" className="ml-auto" onClick={refresh} aria-label="Reload the figures">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Reload
        </Button>
      </div>

      {error ? (
        <EmptyState
          tone="problem"
          title="Could not load the figures"
          hint={error}
          action={
            <Button variant="outline" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          }
        />
      ) : !metrics ? (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i}>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-2 h-8 w-36" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          <Stat
            label="Collateral monitored"
            value={formatUsd(metrics.collateralUsd)}
            sub={
              unpriced > 0
                ? `${formatCount(unpriced)} of ${formatCount(metrics.positionsMonitored)} positions had no price`
                : staleness
                  ? `Oldest reading ${staleness} old`
                  : undefined
            }
          />
          <Stat
            label="Transaction volume"
            value={metrics.eventsReady ? formatUsd(metrics.txVolumeUsd) : "$…"}
            sub={
              !metrics.eventsReady
                ? "No lending events on record yet"
                : metrics.txUnpriced && metrics.txUnpriced > 0
                  ? `${formatCount(metrics.txUnpriced)} of ${formatCount(metrics.txCount)} events carried no USD amount`
                  : eventsSpan
                    ? `Events on record go back ${eventsSpan}`
                    : undefined
            }
          />
          <Stat
            label="Transactions"
            value={metrics.eventsReady ? formatCount(metrics.txCount) : "…"}
            sub={
              !metrics.eventsReady
                ? "No lending events on record yet"
                : eventsSpan
                  ? `Events on record go back ${eventsSpan}`
                  : undefined
            }
          />
          <Stat
            label="Wallets connected"
            value={formatCount(metrics.walletsConnected)}
            sub="Active in the watch registry"
          />
          <Stat
            label="Positions monitored"
            value={formatCount(metrics.positionsMonitored)}
            sub={staleness ? `Oldest reading ${staleness} old` : "No readings yet"}
          />
        </div>
      )}
    </Card>
  );
}
