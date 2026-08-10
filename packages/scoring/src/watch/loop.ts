/**
 * Watch loop skeleton — 60s cycle, profile-relative status transitions.
 * Notification channel is pluggable (Phase-0 alert-channel decision pending);
 * the loop only detects and emits transitions.
 */

import { statusFor } from "../profile";
import type { SimulationStamp } from "../simulation";
import type { Band, ProfileStatus, Protocol, RiskProfile } from "../types";

export interface WatchScore {
  protocol: Protocol;
  wallet: string;
  total: number;
  band: Band;
  /**
   * Set when this score came from SIMULATED prices (`../simulation.ts`).
   * Optional because the loop accepts any shape satisfying `WatchScore`, but an
   * `ActiveScore` always carries the field explicitly.
   */
  simulation?: SimulationStamp | null;
}

export interface WatchTransition {
  wallet: string;
  protocol: Protocol;
  profile: RiskProfile;
  score: number;
  band: Band;
  /** null = first observation of this position. */
  from: ProfileStatus | null;
  to: ProfileStatus;
  /**
   * Provenance, carried from the score that caused the crossing so it survives
   * into `watch_transitions` and into the alert body.
   *
   * A simulated transition that is stored looking exactly like a real one is a
   * lie with a long tail: the history surface would show a crash the market
   * never had, and nobody reading it later could tell. The transition is REAL —
   * the score genuinely crossed the user's limit and the alert genuinely fired —
   * but the price that moved it was imagined, and those are different claims.
   */
  simulation: SimulationStamp | null;
}

export interface WatchDeps {
  scoreWallet(wallet: string): Promise<WatchScore[]>;
  profileFor(wallet: string): RiskProfile;
  onTransition(t: WatchTransition): void;
  onError?(error: unknown, wallet: string): void;
  /** Default 60_000 (arch: 60s cycle). */
  intervalMs?: number;
  /**
   * Anti-spam debounce: a new status must hold this many CONSECUTIVE ticks
   * before the transition is committed and emitted (see params.ALERT_POLICY).
   * Default 1 = legacy behaviour (emit on the first observation of a change).
   * A candidate that reverts before confirming is discarded silently.
   */
  confirmTicks?: number;
}

/** A status seen but not yet confirmed for `confirmTicks` consecutive ticks. */
interface Pending {
  status: ProfileStatus;
  count: number;
}

export class WatchService {
  private readonly wallets = new Set<string>();
  /** Last COMMITTED status per `${wallet}:${protocol}`. */
  private readonly lastStatus = new Map<string, ProfileStatus>();
  /** In-flight candidate awaiting confirmation per key. */
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WatchDeps) {}

  watch(wallet: string): void {
    this.wallets.add(wallet.toLowerCase());
  }

  unwatch(wallet: string): void {
    this.wallets.delete(wallet.toLowerCase());
  }

  /**
   * Seed the last committed status for a position WITHOUT emitting a transition.
   * The worker calls this on startup from the persisted watch_transitions tail
   * so a restart does not re-fire a "first observation" for every position
   * (lastStatus is in-memory and would otherwise reset to empty).
   */
  seed(wallet: string, protocol: Protocol, status: ProfileStatus): void {
    this.lastStatus.set(`${wallet.toLowerCase()}:${protocol}`, status);
  }

  /** One scoring pass over all watched wallets. Exposed for tests/manual runs. */
  async tick(): Promise<void> {
    const confirmTicks = Math.max(1, this.deps.confirmTicks ?? 1);
    for (const wallet of this.wallets) {
      try {
        const scores = await this.deps.scoreWallet(wallet);
        const profile = this.deps.profileFor(wallet);
        for (const s of scores) {
          const observed = statusFor(profile, s.total);
          const key = `${wallet}:${s.protocol}`;
          const committed = this.lastStatus.get(key) ?? null;

          // Already at the committed status: nothing pending, nothing to do.
          if (observed === committed) {
            this.pending.delete(key);
            continue;
          }

          // Track how long the candidate has persisted. Reset the counter when
          // the candidate changes (a different status, or a flap back-and-forth).
          const prev = this.pending.get(key);
          const count = prev && prev.status === observed ? prev.count + 1 : 1;

          if (count < confirmTicks) {
            this.pending.set(key, { status: observed, count });
            continue; // not yet sustained, hold fire
          }

          // Confirmed: commit + emit, and clear the pending candidate.
          this.pending.delete(key);
          this.lastStatus.set(key, observed);
          this.deps.onTransition({
            wallet,
            protocol: s.protocol,
            profile,
            score: s.total,
            band: s.band,
            from: committed,
            to: observed,
            simulation: s.simulation ?? null,
          });
        }
      } catch (error) {
        this.deps.onError?.(error, wallet);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
