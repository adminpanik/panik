/**
 * "The scoring pass is producing nothing" — the alert a multi-day RPC outage
 * proved was missing.
 *
 * WHAT HAPPENED. Every reader inside `scoreWallet` rejected, so the adapter
 * returned an empty array for every wallet, for days. The watch loop ticked on
 * schedule and stamped a healthy heartbeat every time, because it genuinely
 * completed every cycle: it was alive, on time, and blind. No transition was
 * ever written, so no alert was ever queued, so nothing downstream had anything
 * to notice the absence of. Silence looked exactly like "no wallet crossed its
 * limit today", which is the sentence this whole monitoring layer exists to
 * make impossible.
 *
 * WHY THIS IS NOT AN RPC CHECK. `rpc.provider_down` samples endpoints and it
 * did not save us — the endpoints answered. What failed was one layer up, in
 * the per-protocol reads the adapter runs against them, and `onReaderError`
 * logs those one line at a time with nobody counting. The only signal that a
 * partially working dependency cannot fake is the OUTPUT of the pass: did it
 * produce any legs at all, when there were wallets to produce them for.
 *
 * WHY A COUNTER AND NOT A SINGLE TICK. One empty tick is ordinary — a transient
 * provider blip, a pool that dropped every connection at once. Three consecutive
 * empty ticks with a non-empty registry is not a blip, and at the default 60s
 * cadence it costs three minutes of delay to buy the difference between a page
 * and a false page.
 *
 * Pure policy: no chain, no clock of its own, no I/O. The caller supplies the
 * observation and delivers whatever comes back through the usual
 * `AlertDispatcher`, so the durable dedupe gate applies unchanged.
 */

import type { AlertKind, MonitorAlert } from "./monitorAlerts";

/**
 * Consecutive empty ticks before the pass is called blind.
 *
 * Three. See the note above: one is noise, and at `critical` severity the
 * repeat window is an hour, so the cost of being slightly late is bounded and
 * the cost of being wrong is a muted channel.
 */
export const SCORING_BLIND_TICKS = 3;

/** One completed scoring pass, as far as this detector is concerned. */
export interface ScoringTick {
  /** Legs the pass produced this tick, summed across every watched wallet. */
  legsScored: number;
  /** Wallets in the registry when the tick ran. */
  walletsWatched: number;
  /** Tick completion time, epoch ms. */
  at: number;
}

/**
 * The consecutive-empty-tick counter.
 *
 * Stateful by necessity (the condition is a run of observations, not a single
 * one) and deliberately nothing else: `observe` is a pure function of the
 * observation plus the run so far.
 *
 * IT CLEARS ITSELF. Any tick that scores at least one leg resets the run, so
 * the alert stops repeating the moment scoring recovers and the ledger row ages
 * out on its own. There is no "resolve" call to forget to make.
 *
 * AN EMPTY REGISTRY IS NOT BLINDNESS. Zero watched wallets means there was
 * nothing to score, and paging on that would turn a quiet dev host into a
 * standing critical. It resets the run rather than advancing it.
 */
export class ScoringBlindWatch {
  private consecutive = 0;
  private blindSince: number | null = null;

  constructor(private readonly threshold: number = SCORING_BLIND_TICKS) {}

  observe(tick: ScoringTick): MonitorAlert[] {
    if (tick.walletsWatched <= 0 || tick.legsScored > 0) {
      this.consecutive = 0;
      this.blindSince = null;
      return [];
    }

    this.consecutive += 1;
    const since = this.blindSince ?? tick.at;
    this.blindSince = since;
    if (this.consecutive < this.threshold) return [];

    const kind: AlertKind = "scoring.blind";
    return [
      {
        kind,
        severity: "critical",
        // ONE ongoing condition, so one key: "the watch loop is scoring
        // nothing". Naming the loop leaves room for a second scoring pass
        // without retroactively changing what this key means.
        key: "scoring.blind:watch",
        summary:
          `watch loop scored 0 positions on ${this.consecutive} consecutive ticks ` +
          `while ${tick.walletsWatched} wallet(s) are watched`,
        detail: {
          consecutiveTicks: this.consecutive,
          walletsWatched: tick.walletsWatched,
          blindSince: new Date(since).toISOString(),
          blindForMs: tick.at - since,
        },
        at: tick.at,
      },
    ];
  }

  /** Length of the current empty run. Observability and tests. */
  get blindTicks(): number {
    return this.consecutive;
  }
}
