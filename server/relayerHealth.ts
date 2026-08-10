/**
 * Relayer health (Phase 4.B) — the balance threshold and the event observer.
 *
 * Both halves CONSUME what 4.A already emits. server/exitRelayer.ts publishes a
 * structured event for every submission attempt, success, failure, balance read
 * and named skip; server/relayerPolicy.ts owns the caps and the sequencer
 * detector. Nothing here re-derives any of that. A monitor that recomputes the
 * thing it monitors will eventually disagree with it, and then an operator has
 * two numbers and no truth.
 *
 * ── THE BALANCE THRESHOLD, AND WHY IT IS NOT A FLAT NUMBER ──────────────────
 *
 * "Alert under 0.01 ETH" is wrong in both directions. On a quiet Base day it is
 * ten times more than the relayer can possibly spend, so it never fires; during
 * a gas spike it is less than a single transaction, so it fires after the
 * relayer has already run dry. The number that matters is not a preference, it
 * is a consequence of the caps an operator already chose:
 *
 *     worst-case burst (wei) = maxSubmissionsPerHour x maxGasPerTx x feePerGas
 *
 * Every factor is real. `maxSubmissionsPerHour` and `maxGasPerTx` are the hard
 * ceilings in RelayerLimits — by construction the relayer CANNOT spend more
 * than their product in an hour, and a runaway loop or a bad price feed spends
 * exactly that. `feePerGas` is read live from the node, so the threshold tracks
 * a gas spike instead of being invalidated by one.
 *
 * That product is then multiplied by BURST_HOURS, because the alert has to fire
 * with enough lead time for a human to top the wallet up. One hour of budget in
 * the wallet means the page arrives exactly as the money runs out.
 *
 * The result is compared against the POOL total, not one signer: any signer can
 * take the next submission, so what matters for coverage is whether the pool as
 * a whole can fund the burst. A single signer falling under
 * `minSignerBalanceWei` is a separate and more urgent fact, because
 * server/exitRelayer.ts refuses to submit from it at all — that signer's share
 * of the pool has already stopped protecting anyone.
 */

import type { RelayerEvent, RelayerLimits, SkipReason } from "./relayerPolicy";
import type { MonitorAlert } from "./monitorAlerts";

/**
 * Hours of worst-case burst the pool should be able to fund.
 *
 * Two. One hour would page at the moment the wallet empties, which is not an
 * alert, it is a post-mortem. Two hours is enough for someone to be woken up,
 * find the wallet and send a top-up before the first submission is refused.
 */
export const BURST_HOURS = 2n;

/** The most the configured caps allow the relayer to spend in one hour, in wei. */
export function hourlyBurstWei(limits: RelayerLimits, feePerGasWei: bigint): bigint {
  return BigInt(limits.maxSubmissionsPerHour) * limits.maxGasPerTx * feePerGasWei;
}

/** The pool balance the caps imply, in wei. See the header for the derivation. */
export function requiredPoolBalanceWei(limits: RelayerLimits, feePerGasWei: bigint): bigint {
  return hourlyBurstWei(limits, feePerGasWei) * BURST_HOURS;
}

/** One signer's balance as read from the chain. */
export interface SignerBalance {
  address: string;
  balanceWei: bigint;
}

/**
 * Balance alerts.
 *
 * Two independent conditions, deliberately not merged:
 *
 *   - CRITICAL, per signer: below `minSignerBalanceWei`. This is not a
 *     prediction. server/exitRelayer.ts already refuses to submit from a signer
 *     under that figure and emits `relayer_balance_low`, so the coverage that
 *     signer was providing is gone right now.
 *   - WARNING, pool-wide: the pool cannot fund BURST_HOURS of the worst case
 *     its own caps permit. Nothing is broken yet; this is the lead time.
 */
export function balanceAlerts(
  signers: readonly SignerBalance[],
  limits: RelayerLimits,
  feePerGasWei: bigint,
  nowMs: number,
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];

  for (const signer of signers) {
    if (signer.balanceWei >= limits.minSignerBalanceWei) continue;
    alerts.push({
      kind: "relayer.balance_low",
      severity: "critical",
      key: `relayer.balance_low:${signer.address.toLowerCase()}`,
      summary:
        `relayer signer ${signer.address} holds ${signer.balanceWei} wei, below the ` +
        `${limits.minSignerBalanceWei} wei floor; the relayer will refuse to submit from it`,
      detail: {
        signer: signer.address,
        balanceWei: signer.balanceWei.toString(),
        floorWei: limits.minSignerBalanceWei.toString(),
      },
      at: nowMs,
    });
  }

  if (signers.length === 0) return alerts;

  const total = signers.reduce((sum, s) => sum + s.balanceWei, 0n);
  const required = requiredPoolBalanceWei(limits, feePerGasWei);
  if (total < required) {
    alerts.push({
      kind: "relayer.balance_under_burst",
      severity: "warning",
      key: "relayer.balance_under_burst",
      summary:
        `relayer pool holds ${total} wei, under the ${required} wei needed to fund ` +
        `${BURST_HOURS}h of the worst-case burst its caps allow ` +
        `(${limits.maxSubmissionsPerHour}/h x ${limits.maxGasPerTx} gas x ${feePerGasWei} wei/gas)`,
      detail: {
        poolBalanceWei: total.toString(),
        requiredWei: required.toString(),
        burstHours: Number(BURST_HOURS),
        maxSubmissionsPerHour: limits.maxSubmissionsPerHour,
        maxGasPerTx: limits.maxGasPerTx.toString(),
        feePerGasWei: feePerGasWei.toString(),
        signers: signers.length,
      },
      at: nowMs,
    });
  }

  return alerts;
}

// ── The event observer ──────────────────────────────────────────────────────

/**
 * Skip reasons that mean COVERAGE IS BROKEN for that permit, as opposed to
 * "there was nothing to do".
 *
 * This split is the whole value of the repeated-skip alert. `trigger_not_met`
 * repeating forever is the system working: the position is healthy. But a
 * permit that reports `simulation_reverted` on every tick is a permit the
 * contract will never accept — the user's UI says protected, the relayer
 * silently declines, and nothing today notices. Same for a permit whose mask
 * does not cover the position it is supposed to protect, or one that has burned
 * its attempt budget.
 *
 * `sequencer_stale`, `chain_mismatch` and `relayer_balance_low` are absent on
 * purpose: they are chain- or fleet-wide, they already have their own dedicated
 * alerts, and counting them per permit would page once per user for one fault.
 */
export const COVERAGE_BLOCKING_SKIPS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "simulation_reverted",
  "protocol_not_permitted",
  "gas_cap_exceeded",
  "attempt_limit_reached",
  "no_legs",
  "no_signer",
  "evaluation_error",
]);

/**
 * How many consecutive ticks a permit must skip for the SAME reason before it
 * counts as permanently stuck rather than transiently unlucky.
 *
 * Three. The relayer loop runs every 30s, so three ticks is ~90 seconds — long
 * enough that a one-off RPC hiccup has cleared, short enough that a genuinely
 * dead permit is reported inside two minutes.
 */
export const REPEATED_SKIP_THRESHOLD = 3;

/**
 * Turns the relayer's event stream into alerts.
 *
 * Stateful only in the small: it counts consecutive same-reason skips per
 * permit, and forgets a permit the moment it does something else. In-memory is
 * correct here — a restart legitimately re-observes the condition from scratch,
 * and the DURABLE side of the anti-spam story is the AlertLedger downstream.
 */
export class RelayerWatch {
  private readonly streak = new Map<string, { reason: SkipReason; count: number }>();

  constructor(private readonly threshold: number = REPEATED_SKIP_THRESHOLD) {}

  /** Observe one relayer event. Returns the alerts it produced (usually none). */
  observe(event: RelayerEvent, nowMs: number): MonitorAlert[] {
    switch (event.type) {
      case "relayer.failed":
        return [this.failureAlert(event, nowMs)];

      case "relayer.succeeded":
        this.streak.delete(permitKey(event.wallet, event.nonce));
        return [];

      case "relayer.skipped":
        return this.skipAlerts(event, nowMs);

      // `relayer.balance` low is already covered, more precisely, by
      // balanceAlerts() against the configured floor. Emitting here too would
      // page twice for one wallet.
      default:
        return [];
    }
  }

  private failureAlert(
    event: Extract<RelayerEvent, { type: "relayer.failed" }>,
    nowMs: number,
  ): MonitorAlert {
    this.streak.delete(permitKey(event.wallet, event.nonce));
    return {
      kind: "relayer.submission_failed",
      severity: "critical",
      // Keyed per ATTEMPT, not per permit: a second failure on the same permit
      // is a second wasted transaction and must not be suppressed as a repeat.
      key: `relayer.failed:${event.wallet}:${event.nonce}:${event.txHash ?? "no-tx"}`,
      summary:
        `atomicExitFor did not succeed for ${event.wallet} (permit nonce ${event.nonce}): ${event.reason}`,
      detail: { nonce: event.nonce, txHash: event.txHash, reason: event.reason.slice(0, 300) },
      wallet: event.wallet,
      at: nowMs,
    };
  }

  private skipAlerts(
    event: Extract<RelayerEvent, { type: "relayer.skipped" }>,
    nowMs: number,
  ): MonitorAlert[] {
    // 4.A owns the sequencer DETECTOR; this only surfaces its verdict, so there
    // is exactly one definition of "the chain stopped" in the codebase.
    if (event.reason === "sequencer_stale") {
      return [
        {
          kind: "sequencer.stale",
          severity: "critical",
          key: "sequencer.stale:relayer",
          summary: `relayer halted the tick: ${event.detail ?? "sequencer looks stale"}`,
          detail: { detail: event.detail ?? null },
          at: nowMs,
        },
      ];
    }

    if (!COVERAGE_BLOCKING_SKIPS.has(event.reason)) {
      // A benign skip still ENDS a streak: "reverted, reverted, trigger not
      // met" is not three consecutive reverts.
      if (event.nonce !== null) this.streak.delete(permitKey(event.wallet, event.nonce));
      return [];
    }

    const key = permitKey(event.wallet, event.nonce ?? "unknown");
    const prev = this.streak.get(key);
    const count = prev && prev.reason === event.reason ? prev.count + 1 : 1;
    this.streak.set(key, { reason: event.reason, count });
    if (count < this.threshold) return [];

    return [
      {
        kind: "relayer.repeated_skip",
        severity: "warning",
        // Keyed on the ongoing condition (this permit, this reason) so the
        // ledger suppresses the fourth, fifth and hundredth observation.
        key: `relayer.repeated_skip:${event.wallet}:${event.nonce ?? "unknown"}:${event.reason}`,
        summary:
          `relayer has skipped ${event.wallet} permit ${event.nonce ?? "(unknown nonce)"} ` +
          `${count} consecutive times for "${event.reason}"; this permit is not protecting anything`,
        detail: {
          nonce: event.nonce,
          reason: event.reason,
          consecutive: count,
          detail: event.detail ?? null,
        },
        wallet: event.wallet,
        at: nowMs,
      },
    ];
  }
}

function permitKey(wallet: string, nonce: string): string {
  return `${wallet.toLowerCase()}:${nonce}`;
}
