/**
 * The relayer (Phase 4.A) — the code that spends gas and acts on a user's
 * position when their signed trigger fires.
 *
 * This is the highest-consequence module in the backend, so the shape is
 * deliberately conservative: it is pure orchestration over injected
 * collaborators (chain, delegation store, attempt ledger, signer pool), it owns
 * NO money math of its own, and every path out of it is either a submission it
 * simulated first or a skip with a named reason.
 *
 * WHAT DECIDES A TRIGGER. Engine math and the contract, and nothing else. The
 * health factor comes from packages/scoring (via the worker's latest tick), the
 * threshold comes from `permit.triggerHealthFactorWad` which the USER signed,
 * and the comparison uses `hfToWad` from server/exitPermit.ts — the same
 * conversion the UI used to write that field. The relayer's check is only a
 * PRE-FILTER: PanikExecutor._assertTriggerMet re-reads the health factor from
 * the pool at execution and reverts if it has recovered, so a stale snapshot can
 * waste gas but can never exit a healthy position. No LLM is anywhere near this
 * path.
 *
 * WHAT BUILDS THE LEGS. `buildExitLegs` from src/panik-core/lib/exitLegs.ts —
 * the same builder the UI's ExitFlow uses, imported rather than reimplemented.
 * It is wagmi/viem/React-free by design, so the server can use it as-is.
 *
 * WHY EVERY KIND USES THE `AMOUNT_FULL` SENTINEL. Read this before "fixing" the
 * REDUCE branch. On the delegated path the contract does not accept whatever
 * amount the submitter felt like: `_buildAavePosition` computes the AUTHORISED
 * repay as `liveDebt * permit.maxRepayFractionBps / 10000` from state at
 * execution, and reverts `RepayFloorNotMet` if the leg repays any less. An exact
 * amount derived from a read one block earlier is ALWAYS less than that, because
 * debt accrues interest in between. The sentinel is resolved against live debt
 * inside the same transaction and is then capped by the permit fraction, so it
 * lands exactly on the authorised figure for every kind — full exit, full repay,
 * and a genuine partial reduce alike. That is why a REDUCE permit maps to the
 * builder's `full_repay` plan (sentinel repay, zero withdraw) and NOT to
 * `partial`: the permit's own bps IS the size, and the chain applies it.
 *
 * WHAT IT REFUSES TO DO. See server/relayerPolicy.ts. Kill switch off by
 * default, a chain guard, per-tick / per-hour submission caps, a max-gas
 * ceiling, a minimum signer balance, sequencer-staleness detection, and a
 * durable attempt ledger so a crash-restart cannot re-fire a permit that is
 * already in flight.
 */

import {
  AMOUNT_FULL,
  PROTOCOL_ID,
  buildExitLegs,
  type ExitLegInput,
  type ExitReserveState,
} from "../src/panik-core/lib/exitLegs";
import { EXIT_KIND, hfToWad, wadToHf, type ExitPermit } from "./exitPermit";
import { liveDelegationsFor, type DelegationDeps } from "./exitDelegations";
import type { DelegationRow } from "./exitDelegationStore";
import type { LiveProtocol } from "../src/panik-core/lib/live";
import {
  bumpFee,
  type RelayerSignerPool,
  type RelayerTxRequest,
} from "./relayerSigner";
import {
  chainGuardOk,
  sequencerStale,
  type RelayerEventSink,
  type RelayerLimits,
  type SkipReason,
  type SubmissionRateWindow,
} from "./relayerPolicy";
import type { RelayerAttemptStore, AttemptKey } from "./relayerAttemptStore";

/** A mined transaction, reduced to what the ledger and the events need. */
export interface RelayerReceipt {
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
}

/** The exact call the executor exposes: atomicExitFor(user, legs, [], permit, sig). */
export interface AtomicExitForCall {
  user: `0x${string}`;
  legs: readonly ExitLegInput[];
  permit: ExitPermit;
  signature: `0x${string}`;
}

/**
 * Chain access the relayer needs. Injected so the whole decision tree is
 * testable without an RPC, and so the fork integration test can point the SAME
 * code at a real node.
 */
export interface RelayerChain {
  /** The CONNECTED chain id, read from the node. Never assumed. */
  chainId(): Promise<number>;
  /** Latest block timestamp, unix seconds — the sequencer-liveness signal. */
  latestBlockTimestampSec(): Promise<number>;
  /** PanikExecutor.isNonceUsed(user, nonce). */
  isNonceUsed(user: `0x${string}`, nonce: bigint): Promise<boolean>;
  /** Per-reserve aToken balance / debt / decimals for the user's position. */
  reserveStates(user: `0x${string}`): Promise<ExitReserveState[]>;
  /**
   * Simulate atomicExitFor from `from`. MUST throw when the call reverts, and
   * MUST return the gas the node estimated — a hardcoded gas limit is how a
   * relayer pays for a transaction that was never going to fit.
   */
  simulate(call: AtomicExitForCall, from: `0x${string}`): Promise<{ gas: bigint; data: `0x${string}` }>;
  /** Current EIP-1559 fee suggestion. */
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Receipt if mined, else null. Null means PENDING OR NEVER SEEN. */
  receipt(hash: `0x${string}`): Promise<RelayerReceipt | null>;
  /** Poll for a receipt up to `timeoutMs`; null on timeout. */
  waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<RelayerReceipt | null>;
}

/** One position the worker scored this tick, offered to the relayer. */
export interface RelayerCandidate {
  wallet: `0x${string}`;
  protocol: LiveProtocol;
  /** The engine's health factor for this position. Null when unknown. */
  healthFactor: number | null;
}

export interface RelayerDeps {
  chain: RelayerChain;
  /** Reused verbatim so delegation status is never re-derived here. */
  delegations: DelegationDeps;
  attempts: RelayerAttemptStore;
  /** Null when no signer is configured; a dry run needs none. */
  pool: RelayerSignerPool | null;
  limits: RelayerLimits;
  hourly: SubmissionRateWindow;
  emit: RelayerEventSink;
  /** THE KILL SWITCH, already resolved. False = evaluate and log only. */
  enabled: boolean;
  executor: `0x${string}`;
  /** The executor's chain from exit.generated.ts. */
  expectedChainId: number;
  nowMs?: () => number;
}

export interface RelayerTickReport {
  candidates: number;
  submitted: number;
  skipped: number;
  /** Skip reasons counted, so a caller can log a one-line summary. */
  reasons: Partial<Record<SkipReason, number>>;
  dryRun: boolean;
}

/** Map an ExitPermit kind onto the leg builder's plan. See the header. */
function planKindFor(kind: number): "full" | "full_repay" {
  return kind === EXIT_KIND.FULL_EXIT ? "full" : "full_repay";
}

/** Does this permit's mask authorise a leg on this protocol? */
export function permitCoversProtocol(permit: ExitPermit, protocol: LiveProtocol): boolean {
  return (permit.protocolsMask & (1 << PROTOCOL_ID[protocol])) !== 0;
}

/**
 * Has the signed trigger fired?
 *
 * A permit with `triggerHealthFactorWad === 0` is an EXECUTE-NOW permit: the
 * contract skips its live-health gate entirely for those and bounds them by the
 * deadline instead, so the relayer treats them as always fired.
 *
 * An unknown health factor is NOT a fired trigger. A degraded feed reads as
 * null, and "we cannot see the position" must never become "so close it".
 */
export function triggerFired(permit: ExitPermit, healthFactor: number | null): boolean {
  if (permit.triggerHealthFactorWad === 0n) return true;
  if (healthFactor === null || !Number.isFinite(healthFactor) || healthFactor <= 0) return false;
  return hfToWad(healthFactor) < permit.triggerHealthFactorWad;
}

/**
 * The first delegation this candidate can actually act on: live (already
 * reconciled against the chain by `liveDelegationsFor`), covering this
 * protocol, and with its trigger fired.
 */
function selectDelegation(
  rows: readonly DelegationRow[],
  protocol: LiveProtocol,
  healthFactor: number | null,
): { row: DelegationRow | null; reason: SkipReason | null } {
  const covering = rows.filter((r) => permitCoversProtocol(r.permit, protocol));
  if (covering.length === 0) return { row: null, reason: "protocol_not_permitted" };
  const fired = covering.find((r) => triggerFired(r.permit, healthFactor));
  if (!fired) {
    return {
      row: null,
      reason: healthFactor === null ? "health_factor_unknown" : "trigger_not_met",
    };
  }
  return { row: fired, reason: null };
}

/**
 * Run one relayer pass over `candidates`.
 *
 * Never throws for a per-candidate problem: an evaluation failure is a skip
 * with `evaluation_error`, because one unreadable position must not stop the
 * loop for every other user. A tick-level guard (chain mismatch, stale
 * sequencer) aborts the whole pass, which is the correct blast radius: those
 * conditions make EVERY submission unsafe.
 */
export async function runRelayerTick(
  candidates: readonly RelayerCandidate[],
  deps: RelayerDeps,
): Promise<RelayerTickReport> {
  const now = deps.nowMs ?? (() => Date.now());
  const report: RelayerTickReport = {
    candidates: candidates.length,
    submitted: 0,
    skipped: 0,
    reasons: {},
    dryRun: !deps.enabled,
  };

  const skip = (wallet: string, nonce: bigint | null, reason: SkipReason, detail?: string) => {
    report.skipped += 1;
    report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
    deps.emit({
      type: "relayer.skipped",
      wallet,
      nonce: nonce === null ? null : nonce.toString(),
      reason,
      ...(detail ? { detail } : {}),
    });
  };

  // ── Tick-level guards ─────────────────────────────────────────────────────
  // THE CHAIN GUARD. Read the connected chain from the node and compare it to
  // the executor's chain. A mismatch means the executor address either holds
  // nothing (gas burned on a revert) or holds an unrelated contract, and
  // handing an unrelated contract a signed permit is not a risk worth ranking.
  let connectedChainId: number;
  try {
    connectedChainId = await deps.chain.chainId();
  } catch (err) {
    skip("*", null, "evaluation_error", `chain id read failed: ${(err as Error).message}`);
    deps.emit({ type: "relayer.tick", candidates: candidates.length, submitted: 0, skipped: report.skipped, dryRun: report.dryRun, chainId: -1 });
    return report;
  }
  if (!chainGuardOk(connectedChainId, deps.expectedChainId)) {
    skip("*", null, "chain_mismatch", `connected ${connectedChainId}, executor on ${deps.expectedChainId}`);
    deps.emit({ type: "relayer.tick", candidates: candidates.length, submitted: 0, skipped: report.skipped, dryRun: report.dryRun, chainId: connectedChainId });
    return report;
  }

  // Sequencer staleness. A receipt cannot distinguish "pending" from "the chain
  // stopped"; block age can. Submitting into a dead sequencer just parks a
  // transaction at a fee that will be wrong when it wakes up.
  try {
    const blockTs = await deps.chain.latestBlockTimestampSec();
    if (sequencerStale(blockTs, Math.floor(now() / 1000), deps.limits.sequencerStaleAfterSec)) {
      skip("*", null, "sequencer_stale", `latest block is ${Math.floor(now() / 1000) - blockTs}s old`);
      deps.emit({ type: "relayer.tick", candidates: candidates.length, submitted: 0, skipped: report.skipped, dryRun: report.dryRun, chainId: connectedChainId });
      return report;
    }
  } catch (err) {
    skip("*", null, "evaluation_error", `block read failed: ${(err as Error).message}`);
    deps.emit({ type: "relayer.tick", candidates: candidates.length, submitted: 0, skipped: report.skipped, dryRun: report.dryRun, chainId: connectedChainId });
    return report;
  }

  let submittedThisTick = 0;

  for (const candidate of candidates) {
    const wallet = candidate.wallet.toLowerCase() as `0x${string}`;
    try {
      // ── Coverage: only a permit the CHAIN would accept counts ─────────────
      const live = await liveDelegationsFor(wallet, deps.delegations);
      if (live.length === 0) {
        skip(wallet, null, "no_live_permit");
        continue;
      }

      const chosen = selectDelegation(live, candidate.protocol, candidate.healthFactor);
      if (!chosen.row) {
        skip(wallet, null, chosen.reason ?? "trigger_not_met");
        continue;
      }
      const { permit, signature } = chosen.row;

      // Belt and braces over the reconciled status: the nonce could have been
      // spent between that read and this one, and a spent nonce is a guaranteed
      // revert. Cheap read, guaranteed-wasted transaction avoided.
      if (await deps.chain.isNonceUsed(wallet, permit.nonce)) {
        skip(wallet, permit.nonce, "nonce_spent");
        continue;
      }

      // ── Legs, from the shared builder ─────────────────────────────────────
      const reserves = await deps.chain.reserveStates(wallet);
      const { legs } = buildExitLegs(reserves, {
        protocol: candidate.protocol,
        kind: planKindFor(permit.kind),
      });
      if (legs.length === 0) {
        skip(wallet, permit.nonce, "no_legs");
        continue;
      }

      // ── Caps, before any gas is committed ─────────────────────────────────
      if (submittedThisTick >= deps.limits.maxSubmissionsPerTick) {
        skip(wallet, permit.nonce, "tick_cap_reached");
        continue;
      }
      if (deps.hourly.count(now()) >= deps.limits.maxSubmissionsPerHour) {
        skip(wallet, permit.nonce, "hourly_cap_reached");
        continue;
      }

      // ── SIMULATE. Never submit a transaction that was not simulated ───────
      // The `from` matters: atomicExitFor has no onlyEOA modifier but the
      // simulation must still run as the address that will pay, or a gas
      // estimate can miss a balance-dependent branch. With no pool configured
      // (dry run) the executor itself is a harmless stand-in caller.
      const simulateFrom = deps.pool?.addresses[0] ?? deps.executor;
      let gas: bigint;
      let data: `0x${string}`;
      try {
        const sim = await deps.chain.simulate({ user: wallet, legs, permit, signature }, simulateFrom);
        gas = sim.gas;
        data = sim.data;
      } catch (err) {
        // The contract said no. Record it and never pay to hear it again this
        // tick — this is the single most valuable skip in the whole loop.
        skip(wallet, permit.nonce, "simulation_reverted", (err as Error).message.slice(0, 300));
        continue;
      }

      if (gas > deps.limits.maxGasPerTx) {
        skip(wallet, permit.nonce, "gas_cap_exceeded", `${gas} > ${deps.limits.maxGasPerTx}`);
        continue;
      }

      // ── THE KILL SWITCH ───────────────────────────────────────────────────
      // Everything above ran for real, including the simulation, so a dry run
      // is a genuine rehearsal: it proves the contract WOULD have accepted this
      // transaction. Nothing below this line happens until someone arms it.
      if (!deps.enabled) {
        report.skipped += 1;
        report.reasons.relayer_disabled = (report.reasons.relayer_disabled ?? 0) + 1;
        deps.emit({
          type: "relayer.would-submit",
          wallet,
          nonce: permit.nonce.toString(),
          protocol: candidate.protocol,
          legs: legs.length,
          gas: gas.toString(),
          healthFactor: candidate.healthFactor,
          triggerHf: wadToHf(permit.triggerHealthFactorWad),
        });
        continue;
      }

      if (!deps.pool) {
        skip(wallet, permit.nonce, "no_signer");
        continue;
      }

      const submitted = await submitOnce({ wallet, permit, gas, data, deps, now });
      if (submitted.ok) {
        submittedThisTick += 1;
        report.submitted += 1;
        deps.hourly.record(now());
      } else {
        report.skipped += 1;
        report.reasons[submitted.reason] = (report.reasons[submitted.reason] ?? 0) + 1;
      }
    } catch (err) {
      // One unreadable position must not stop the loop for everyone else.
      skip(wallet, null, "evaluation_error", (err as Error).message.slice(0, 300));
    }
  }

  deps.emit({
    type: "relayer.tick",
    candidates: candidates.length,
    submitted: report.submitted,
    skipped: report.skipped,
    dryRun: report.dryRun,
    chainId: connectedChainId,
  });
  return report;
}

interface SubmitInput {
  wallet: `0x${string}`;
  permit: ExitPermit;
  gas: bigint;
  data: `0x${string}`;
  deps: RelayerDeps;
  now: () => number;
}

type SubmitResult = { ok: true; txHash: `0x${string}` } | { ok: false; reason: SkipReason };

/**
 * Claim, sign, broadcast, and settle ONE permit.
 *
 * The order is the whole safety argument:
 *   1. lease a signer (exclusive, so its nonce sequence cannot be double-spent),
 *      which PINS one RPC endpoint and reads the nonce from it,
 *   2. check its balance (an underfunded relayer produces a stuck tx, not a
 *      clean failure),
 *   3. CLAIM the durable attempt row BEFORE broadcasting, so a crash between
 *      here and the receipt leaves evidence that stops a re-fire,
 *   4. broadcast THROUGH THE LEASE'S OPERATION, never through the signer: the
 *      nonce in `tx` describes one node's mempool and is only valid there. See
 *      the endpoint-pinning note at the top of server/relayerSigner.ts.
 *   5. wait, replacing with a >=10% fee bump if it sticks — on the same pinned
 *      node, so the replacement is priced against the transaction that node
 *      actually holds,
 *   6. verify `status === "success"` — viem does NOT throw on revert, so a
 *      resolved receipt is not a successful one, and treating it as one is how
 *      a failed exit gets reported as protection.
 */
async function submitOnce(input: SubmitInput): Promise<SubmitResult> {
  const { wallet, permit, gas, data, deps, now } = input;
  const pool = deps.pool!;

  const lease = await pool.acquire();
  if (!lease) return { ok: false, reason: "no_free_signer" };

  const key: AttemptKey = {
    chainId: deps.expectedChainId,
    executor: deps.executor,
    user: wallet,
    nonce: permit.nonce,
  };
  let claimed = false;

  try {
    const balance = await lease.operation.balance();
    const low = balance < deps.limits.minSignerBalanceWei;
    deps.emit({
      type: "relayer.balance",
      signer: lease.signer.address,
      balanceWei: balance.toString(),
      low,
    });
    if (low) {
      deps.emit({
        type: "relayer.skipped",
        wallet,
        nonce: permit.nonce.toString(),
        reason: "relayer_balance_low",
        detail: `${lease.signer.address} holds ${balance} wei`,
      });
      return { ok: false, reason: "relayer_balance_low" };
    }

    // THE IDEMPOTENCY CLAIM. False means someone else owns this permit, or it
    // already succeeded, or it has failed too many times. All three are skips.
    claimed = await deps.attempts.claim(key, lease.signer.address, deps.limits.maxAttemptsPerPermit);
    if (!claimed) {
      const existing = await deps.attempts.find(key).catch(() => null);
      const reason: SkipReason =
        existing?.status === "succeeded"
          ? "already_submitted"
          : existing?.status === "failed"
            ? "attempt_limit_reached"
            : "attempt_in_flight";
      deps.emit({ type: "relayer.skipped", wallet, nonce: permit.nonce.toString(), reason });
      return { ok: false, reason };
    }

    const fees = await deps.chain.fees();
    const tx: RelayerTxRequest = {
      to: deps.executor,
      data,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      nonce: lease.nonce,
      chainId: deps.expectedChainId,
    };

    let txHash = await lease.operation.sendTransaction(tx);
    deps.emit({
      type: "relayer.attempted",
      wallet,
      nonce: permit.nonce.toString(),
      txHash,
      signer: lease.signer.address,
      endpoint: lease.operation.endpoint,
      gas: gas.toString(),
      maxFeePerGas: tx.maxFeePerGas.toString(),
    });

    let receipt = await deps.chain.waitForReceipt(txHash, deps.limits.stuckAfterMs);

    // ── Stuck handling ────────────────────────────────────────────────────
    // No receipt is ambiguous, so resolve the ambiguity before acting: a stale
    // chain means the SEQUENCER is down and a replacement would only queue
    // behind the same wall, while a live chain means the fee was too low.
    // Bounded to one replacement per tick; the next tick picks it up again.
    if (!receipt) {
      const blockTs = await deps.chain.latestBlockTimestampSec().catch(() => 0);
      const stale = sequencerStale(blockTs, Math.floor(now() / 1000), deps.limits.sequencerStaleAfterSec);
      if (!stale) {
        const replacement: RelayerTxRequest = {
          ...tx,
          // Both legs must clear the node's 10% replacement floor, or the
          // resubmit is silently rejected and the original stays stuck.
          maxFeePerGas: bumpFee(tx.maxFeePerGas),
          maxPriorityFeePerGas: bumpFee(tx.maxPriorityFeePerGas),
        };
        try {
          const newHash = await lease.operation.sendTransaction(replacement);
          deps.emit({
            type: "relayer.replaced",
            wallet,
            nonce: permit.nonce.toString(),
            oldTxHash: txHash,
            newTxHash: newHash,
            maxFeePerGas: replacement.maxFeePerGas.toString(),
          });
          txHash = newHash;
          receipt = await deps.chain.waitForReceipt(txHash, deps.limits.stuckAfterMs);
        } catch (err) {
          // A rejected replacement usually means the original just mined.
          receipt = await deps.chain.receipt(txHash).catch(() => null);
          if (!receipt) {
            deps.emit({
              type: "relayer.failed",
              wallet,
              nonce: permit.nonce.toString(),
              txHash,
              reason: `replacement rejected: ${(err as Error).message.slice(0, 200)}`,
            });
          }
        }
      }
    }

    if (!receipt) {
      // Still unmined. The nonce IS consumed by the broadcast, so the lease is
      // released as landed; the attempt stays claimable-once-failed so the next
      // tick can reconcile it against the chain rather than blindly re-firing.
      await deps.attempts.finish(key, {
        status: "failed",
        txHash,
        error: "no receipt before the stuck timeout",
      });
      deps.emit({
        type: "relayer.failed",
        wallet,
        nonce: permit.nonce.toString(),
        txHash,
        reason: "no receipt before the stuck timeout",
      });
      lease.release(true);
      return { ok: false, reason: "evaluation_error" };
    }

    lease.release(true);

    // viem does NOT throw on revert: a resolved receipt proves the transaction
    // was MINED, not that it worked. `status === "success"` is the only proof.
    if (receipt.status !== "success") {
      await deps.attempts.finish(key, {
        status: "failed",
        txHash,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        error: "transaction reverted on-chain",
      });
      deps.emit({
        type: "relayer.failed",
        wallet,
        nonce: permit.nonce.toString(),
        txHash,
        reason: "reverted",
      });
      return { ok: false, reason: "simulation_reverted" };
    }

    await deps.attempts.finish(key, {
      status: "succeeded",
      txHash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
    });
    deps.emit({
      type: "relayer.succeeded",
      wallet,
      nonce: permit.nonce.toString(),
      txHash,
      gasUsed: receipt.gasUsed.toString(),
      feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    });
    return { ok: true, txHash };
  } catch (err) {
    // The send itself failed, so nothing reached the mempool and the nonce is
    // still free: rewind the sequence or every later transaction from this EOA
    // queues behind a gap that never fills.
    lease.release(false);
    if (claimed) {
      await deps.attempts
        .finish(key, { status: "failed", error: (err as Error).message })
        .catch(() => undefined);
    }
    deps.emit({
      type: "relayer.failed",
      wallet,
      nonce: permit.nonce.toString(),
      txHash: null,
      reason: (err as Error).message.slice(0, 200),
    });
    return { ok: false, reason: "evaluation_error" };
  }
}

/** Re-exported so the worker and the tests can name the sentinel they rely on. */
export { AMOUNT_FULL };
export type { ExitLegInput, ExitReserveState };
