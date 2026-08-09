/**
 * Compose an ExitPermit MESSAGE from the user's choices plus engine/chain
 * defaults — the grant half of the delegation lifecycle (Phase 2.C).
 *
 * The permit TYPE, domain and struct are NOT redefined here. They are imported
 * from server/exitPermit.ts, the single source of truth the backend recomputes
 * and the contract enforces; a second copy in the UI is exactly the drift that
 * would make every recovered signer wrong. This module only builds the message
 * object and its defaults, and every default traces to a number the code
 * already knows: TARGET_HF from the scoring engine for the trigger, the
 * executor's on-chain slippage ceiling for the slippage cap, PROTOCOL_ID for
 * the mask. Nothing here invents a figure the engine or the chain did not
 * produce.
 *
 * Kept free of wagmi/viem/React so the leg math and the defaults can be unit
 * tested without a DOM or a chain, the same rule exitLegs.ts follows.
 */

import { BPS_DENOMINATOR, EXIT_KIND, type ExitPermit } from "../../../server/exitPermit";
import { EXECUTABLE_PROTOCOLS, type ExitEnv } from "./exit";
import { PROTOCOL_ID } from "./exitLegs";
import type { LiveProtocol } from "./live";
import { TARGET_HF } from "../../../packages/scoring/src/advisor/repayMath";
import type { RiskProfile } from "../../../packages/scoring/src/types";

/** The user-facing action a standing permission authorizes. */
export type GrantAction = "full_exit" | "full_repay" | "reduce";

export interface GrantActionMeta {
  id: GrantAction;
  /** ExitTypes.ExitKind the permit carries. */
  kind: number;
  /** Selector label. */
  label: string;
  /** Consequence-led clause: what PANIK MAY DO. No jargon, no enum. */
  allows: string;
  /** What the user is LEFT holding afterwards. */
  leaves: string;
}

/**
 * The three actions, mapped to the contract's ExitKind. Order is the order the
 * selector shows them: the least destructive last so a mis-click lands on a
 * smaller consequence, and full exit first because it is the one a scared user
 * reaches for.
 */
export const GRANT_ACTIONS: readonly GrantActionMeta[] = [
  {
    id: "full_exit",
    kind: EXIT_KIND.FULL_EXIT,
    label: "Full exit",
    allows: "repay all your debt, withdraw your collateral, and convert it to USDC",
    leaves: "USDC in your wallet, with the position closed",
  },
  {
    id: "full_repay",
    kind: EXIT_KIND.FULL_REPAY,
    label: "Clear debt",
    allows: "repay all your debt from your wallet",
    leaves: "your collateral deposited, with nothing left to liquidate",
  },
  {
    id: "reduce",
    kind: EXIT_KIND.REDUCE,
    label: "Reduce",
    allows: "repay part of your debt from your wallet",
    leaves: "your collateral deposited and the position open, carrying a smaller loan",
  },
] as const;

export function grantActionMeta(action: GrantAction): GrantActionMeta {
  const meta = GRANT_ACTIONS.find((a) => a.id === action);
  if (!meta) throw new Error(`unknown grant action: ${action}`);
  return meta;
}

/** Fixed-point scale for a health factor on-chain (WAD = 1e18). */
export const WAD = 10n ** 18n;

/**
 * A health factor as the contract's WAD-scaled integer (HF x 1e18).
 *
 * Two-step so it stays exact in double precision: HF is rounded to 1e-9 first
 * (nine decimals is far past anything a health factor is quoted to), then
 * scaled up in BigInt. `hf * 1e18` straight through a Number would lose the low
 * bits of the mantissa and hand the signer a digest a hair off the contract's.
 */
export function hfToWad(hf: number): bigint {
  if (!Number.isFinite(hf) || hf <= 0) throw new Error("health factor must be positive");
  return BigInt(Math.round(hf * 1e9)) * (WAD / 1_000_000_000n);
}

/** WAD-scaled HF back to a number, for display and the disclosure. */
export function wadToHf(wad: bigint): number {
  return Number(wad) / Number(WAD);
}

/**
 * Default HF trigger: the user's risk-profile target, straight from the engine
 * (TARGET_HF). This is the user's risk limit expressed as a health factor, so a
 * standing permission fires exactly when a position crosses the line the user
 * already set for alerts. Not a number chosen here.
 */
export function defaultTriggerHf(profile: RiskProfile): number {
  return TARGET_HF[profile];
}

/** OR the protocols' mask bits together (bit i = ProtocolId i is permitted). */
export function protocolsMaskFor(protocols: readonly LiveProtocol[]): number {
  let mask = 0;
  for (const p of protocols) mask |= 1 << PROTOCOL_ID[p];
  return mask;
}

/**
 * Default protocol mask: the protocols actually executable in this environment.
 * On testnet that is Aave V3 alone; the others unlock at mainnet cutover, and a
 * permit naming a protocol with no executable path would be dead weight the
 * backend refuses to store anyway.
 */
export function defaultProtocolsMask(env: ExitEnv): number {
  return protocolsMaskFor(EXECUTABLE_PROTOCOLS[env]);
}

/**
 * maxRepayFractionBps for a kind. Full exit and full repay MUST be 100%: the
 * contract's _validatePermitScope reverts on anything else, because half a
 * close is not a close. A reduce is capped at 100% too, the ceiling the relayer
 * sizes the real repay under at execution against the live health factor.
 */
export function repayFractionBpsFor(_kind: number): number {
  return BPS_DENOMINATOR;
}

/**
 * A slippage choice clamped to the executor's immutable on-chain ceiling
 * (maxPermitSlippageBps). The ceiling is a chain fact, so it is the honest
 * upper bound and the honest default; the user may only tighten below it. A
 * malformed input falls back to the ceiling rather than to a guessed number.
 */
export function clampSlippageBps(requested: number, ceilingBps: number): number {
  if (!Number.isInteger(requested) || requested < 0) return ceilingBps;
  return Math.min(requested, ceilingBps);
}

/** Everything the message needs beyond the engine/chain defaults. */
export interface ComposeInput {
  user: `0x${string}`;
  action: GrantAction;
  /** Health factor at or below which PANIK may act. */
  triggerHf: number;
  /** Already clamped to the on-chain ceiling. */
  maxSlippageBps: number;
  protocolsMask: number;
  /** Permit expiry, unix seconds. */
  deadline: number;
  /** revocationEpoch(user), read on-chain: a permit on a stale epoch is dead. */
  epoch: bigint;
  /** A random unordered nonce (see nonceFromBytes). */
  nonce: bigint;
}

/**
 * Build the ExitPermit message the wallet signs. Lower-cases the user so the
 * stored row and the recovered signer compare cleanly, matching parsePermitBody.
 */
export function composeExitPermit(input: ComposeInput): ExitPermit {
  const kind = grantActionMeta(input.action).kind;
  return {
    user: input.user.toLowerCase() as `0x${string}`,
    kind,
    maxRepayFractionBps: repayFractionBpsFor(kind),
    triggerHealthFactorWad: hfToWad(input.triggerHf),
    maxSlippageBps: input.maxSlippageBps,
    protocolsMask: input.protocolsMask,
    epoch: input.epoch,
    nonce: input.nonce,
    deadline: BigInt(Math.floor(input.deadline)),
  };
}

/**
 * The `{permit, signature}` request body for the 2.B submit endpoint, with
 * every bigint stringified — JSON cannot carry a bigint, and parsePermitBody
 * accepts decimal strings. Mirrors permitToJson in server/exitDelegations.ts.
 */
export function permitToRequestBody(permit: ExitPermit, signature: `0x${string}`) {
  return {
    permit: {
      user: permit.user,
      kind: permit.kind,
      maxRepayFractionBps: permit.maxRepayFractionBps,
      triggerHealthFactorWad: permit.triggerHealthFactorWad.toString(),
      maxSlippageBps: permit.maxSlippageBps,
      protocolsMask: permit.protocolsMask,
      epoch: permit.epoch.toString(),
      nonce: permit.nonce.toString(),
      deadline: permit.deadline.toString(),
    },
    signature,
  };
}

/** Big-endian bytes -> unordered nonce. Component feeds 32 crypto-random bytes. */
export function nonceFromBytes(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Split an unordered nonce into the (wordPos, mask) invalidateUnorderedNonces
 * takes: the top 248 bits pick the 256-bit word, the low 8 bits pick the bit.
 */
export function nonceInvalidation(nonce: bigint): { wordPos: bigint; mask: bigint } {
  return { wordPos: nonce >> 8n, mask: 1n << (nonce & 0xffn) };
}

/**
 * Whether an on-chain revocation is confirmed enough to reflect in the UI.
 *
 * viem resolves a REVERTED transaction too (it does not throw on revert), so
 * the receipt status is the only proof the revocation actually landed. A
 * missing, pending or reverted receipt must never flip a permission to
 * "revoked": showing coverage as gone while it is still live on-chain is the
 * one failure this product cannot ship. Only a `success` receipt passes, after
 * which the backend reconciles against the chain and the live query stops
 * returning the row.
 */
export function revocationConfirmed(
  receipt: { status: "success" | "reverted" } | null | undefined,
): boolean {
  return !!receipt && receipt.status === "success";
}
