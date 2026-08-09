/**
 * Relayer policy (Phase 4.A) — every reason the relayer is allowed to refuse,
 * in one place, plus the structured events Phase 4.B will consume.
 *
 * The design rule: THE RELAYER SKIPS LOUDLY. A relayer that spends gas is one
 * bad feed away from mass-exiting positions that were never in trouble, so
 * every gate here is a hard stop with a named reason, and every skip emits an
 * event carrying that reason. Silence is never an outcome — "nothing happened"
 * and "we refused for a reason" are different facts and the second one is the
 * only one you can debug at 3am.
 *
 * The gates, in the order the relayer applies them (cheapest and most
 * catastrophic first):
 *
 *   1. KILL SWITCH   RELAYER_ENABLED, default OFF. Off does not stop the loop;
 *                    it stops SUBMISSION. The loop still evaluates every
 *                    candidate and emits `would-submit` events, so the trigger
 *                    logic can be watched against real production positions for
 *                    as long as it takes before anyone arms it.
 *   2. CHAIN GUARD   The connected chain id must equal the executor's chain from
 *                    exit.generated.ts. An executor address on the wrong chain
 *                    is either nothing (revert, gas burned) or, worse, some
 *                    unrelated contract. Read from the node, never assumed.
 *   3. CAPS          Per-tick and per-hour submission counts, a max gas per tx,
 *                    and a minimum relayer balance. These bound the blast
 *                    radius of a bug or a bad price feed to a number an
 *                    operator chose, rather than to the relayer's whole wallet.
 *
 * Nothing here talks to a chain or a database; it is pure policy so it can be
 * tested exhaustively without either.
 */

/**
 * Why a candidate did not produce a transaction. Every value is a stable string
 * because 4.B will group on it and a renamed reason is a broken dashboard.
 */
export type SkipReason =
  /** Kill switch off: evaluated and logged, never submitted. */
  | "relayer_disabled"
  /** Connected chain id != the executor's chain. */
  | "chain_mismatch"
  /** No signer configured (no key / no KMS ids). */
  | "no_signer"
  /** Every pool signer already has a transaction in flight. */
  | "no_free_signer"
  /** The wallet has no delegation the chain would accept. */
  | "no_live_permit"
  /** The engine has no usable health factor for this position. */
  | "health_factor_unknown"
  /** Live health factor is at or above the signed trigger. */
  | "trigger_not_met"
  /** The permit's protocol mask does not cover this position's protocol. */
  | "protocol_not_permitted"
  /** Nothing to do on-chain: no debt, or the reduce rounds to dust. */
  | "no_legs"
  /** The nonce is already spent on-chain (executed or invalidated). */
  | "nonce_spent"
  /** An attempt for this permit is already in flight. */
  | "attempt_in_flight"
  /** This permit already produced a successful submission. */
  | "already_submitted"
  /** This permit failed too many times; a human decides what happens next. */
  | "attempt_limit_reached"
  /** Per-tick submission cap reached. */
  | "tick_cap_reached"
  /** Per-hour submission cap reached. */
  | "hourly_cap_reached"
  /** Simulated gas exceeds the configured per-transaction ceiling. */
  | "gas_cap_exceeded"
  /** The relayer EOA is below the configured minimum native balance. */
  | "relayer_balance_low"
  /** The chain's latest block is too old to trust: sequencer likely down. */
  | "sequencer_stale"
  /** eth_call reverted. The contract refused; never pay to be refused again. */
  | "simulation_reverted"
  /** A read failed. Unknown is not permission to act. */
  | "evaluation_error";

/** Tunables, all env-driven with conservative defaults. */
export interface RelayerLimits {
  /** Max submissions in a single tick. */
  maxSubmissionsPerTick: number;
  /** Max submissions in any trailing hour. */
  maxSubmissionsPerHour: number;
  /** Refuse any transaction whose SIMULATED gas exceeds this. */
  maxGasPerTx: bigint;
  /** Refuse to submit from a signer below this native balance, in wei. */
  minSignerBalanceWei: bigint;
  /** A block older than this many seconds means the sequencer is not healthy. */
  sequencerStaleAfterSec: number;
  /** How many times one permit may be retried after a failed attempt. */
  maxAttemptsPerPermit: number;
  /** How long a broadcast transaction may sit unmined before it is replaced. */
  stuckAfterMs: number;
}

/**
 * Defaults chosen to be boring. A cap that never binds teaches nothing, and a
 * cap that binds constantly gets raised without thought; these are sized so a
 * normal day never touches them and a runaway loop stops within one tick.
 */
export const DEFAULT_RELAYER_LIMITS: RelayerLimits = {
  maxSubmissionsPerTick: 3,
  maxSubmissionsPerHour: 20,
  // An atomicExitFor over a handful of Aave legs measures in the low millions.
  maxGasPerTx: 3_000_000n,
  // ~0.002 ETH. Below this a Base transaction may still fit, but the wallet is
  // close enough to empty that an operator needs to know before the next one.
  minSignerBalanceWei: 2_000_000_000_000_000n,
  // Base targets 2s blocks. Two minutes of silence is not jitter.
  sequencerStaleAfterSec: 120,
  maxAttemptsPerPermit: 3,
  stuckAfterMs: 90_000,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const n = BigInt(raw.trim());
    return n >= 0n ? n : fallback;
  } catch {
    return fallback;
  }
}

export function limitsFromEnv(): RelayerLimits {
  const d = DEFAULT_RELAYER_LIMITS;
  return {
    maxSubmissionsPerTick: envInt("RELAYER_MAX_SUBMISSIONS_PER_TICK", d.maxSubmissionsPerTick),
    maxSubmissionsPerHour: envInt("RELAYER_MAX_SUBMISSIONS_PER_HOUR", d.maxSubmissionsPerHour),
    maxGasPerTx: envBigInt("RELAYER_MAX_GAS_PER_TX", d.maxGasPerTx),
    minSignerBalanceWei: envBigInt("RELAYER_MIN_BALANCE_WEI", d.minSignerBalanceWei),
    sequencerStaleAfterSec: envInt("RELAYER_SEQUENCER_STALE_SEC", d.sequencerStaleAfterSec),
    maxAttemptsPerPermit: envInt("RELAYER_MAX_ATTEMPTS_PER_PERMIT", d.maxAttemptsPerPermit),
    stuckAfterMs: envInt("RELAYER_STUCK_AFTER_MS", d.stuckAfterMs),
  };
}

/**
 * THE KILL SWITCH. Default OFF, and deliberately strict about what counts as
 * on: exactly "true"/"1"/"yes" (case-insensitive). Anything else — a typo, an
 * empty string, a shell that swallowed the value — reads as OFF. The failure
 * mode of a mis-set flag must be "did not spend money", never "spent money
 * because the string was not empty".
 */
export function relayerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RELAYER_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * THE CHAIN GUARD. `connected` is read from the node; `expected` is the
 * executor's chain from exit.generated.ts. Never submit when they differ:
 * the executor address means nothing on another chain, and "nothing" at an
 * address is not safe to call with a signed permit.
 */
export function chainGuardOk(connected: number, expected: number): boolean {
  return Number.isInteger(connected) && connected === expected;
}

/**
 * Sequencer-staleness detection.
 *
 * A receipt cannot tell "my transaction is pending" from "the chain stopped":
 * both look like no receipt. Base has had multi-hour sequencer outages, and
 * during one the right behaviour is to stop submitting (a broadcast into a dead
 * sequencer just sits) and to resume with a fee bump when blocks return. The
 * only signal available off a plain RPC is the age of the latest block, so that
 * is what is used, with a generous threshold so ordinary jitter never trips it.
 */
export function sequencerStale(
  latestBlockTimestampSec: number,
  nowSec: number,
  staleAfterSec: number,
): boolean {
  const age = nowSec - latestBlockTimestampSec;
  return age > staleAfterSec;
}

/**
 * Rolling per-hour submission counter. In-memory on purpose: it bounds THIS
 * process's spend, and a restart re-reads the durable attempt rows before it
 * can re-fire anything, so the DB is the correctness boundary and this is the
 * rate boundary.
 */
export class SubmissionRateWindow {
  private readonly stamps: number[] = [];

  constructor(private readonly windowMs = 3_600_000) {}

  private prune(now: number): void {
    while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
  }

  count(now: number = Date.now()): number {
    this.prune(now);
    return this.stamps.length;
  }

  record(now: number = Date.now()): void {
    this.prune(now);
    this.stamps.push(now);
  }
}

// ── Structured events (the 4.B contract) ───────────────────────────────────────

/**
 * One relayer event. Phase 4.B consumes these; 4.A only has to emit them
 * faithfully. `dryRun` is on every submission-shaped event so a dashboard can
 * never mistake an observation for a spend.
 */
export type RelayerEvent =
  | {
      type: "relayer.tick";
      candidates: number;
      submitted: number;
      skipped: number;
      dryRun: boolean;
      chainId: number;
    }
  | {
      type: "relayer.skipped";
      wallet: string;
      nonce: string | null;
      reason: SkipReason;
      detail?: string;
    }
  | {
      type: "relayer.would-submit";
      wallet: string;
      nonce: string;
      protocol: string;
      legs: number;
      gas: string;
      healthFactor: number | null;
      triggerHf: number;
    }
  | {
      type: "relayer.attempted";
      wallet: string;
      nonce: string;
      txHash: string;
      signer: string;
      gas: string;
      maxFeePerGas: string;
    }
  | {
      type: "relayer.succeeded";
      wallet: string;
      nonce: string;
      txHash: string;
      gasUsed: string;
      feeWei: string;
    }
  | {
      type: "relayer.failed";
      wallet: string;
      nonce: string;
      txHash: string | null;
      reason: string;
    }
  | {
      type: "relayer.replaced";
      wallet: string;
      nonce: string;
      oldTxHash: string;
      newTxHash: string;
      maxFeePerGas: string;
    }
  | {
      type: "relayer.balance";
      signer: string;
      balanceWei: string;
      low: boolean;
    };

export type RelayerEventSink = (event: RelayerEvent) => void;

/**
 * Default sink: one JSON line per event on stdout.
 *
 * JSON rather than prose because 4.B will parse these out of Railway's log
 * drain, and a regex over a sentence is a promise to break. BigInt is
 * stringified at the event boundary (JSON.stringify throws on bigint), which is
 * also why every numeric field on RelayerEvent that can exceed 2^53 is typed as
 * a string.
 */
export const consoleEventSink: RelayerEventSink = (event) => {
  console.log(JSON.stringify(event));
};
