/**
 * EIP-7702 signer-code handling (Issue #41), layers 2 and 3.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * EIP-7702 lets a plain EOA install code at its own address via a set-code
 * authorization. The address keeps its private key, so `ecrecover` over an
 * EIP-712 digest still returns that address and every ECDSA check this backend
 * runs still passes. The DEPLOYED EXECUTOR does not use ecrecover
 * unconditionally: when `signer.code.length != 0` it takes the ERC-1271 branch
 * and asks the account's own code whether the signature is valid. Most 7702
 * delegates do not implement `isValidSignature` at all.
 *
 * So a wallet with a 7702 delegate can sign a permit that PANIK verifies, PANIK
 * stores, the UI reports as active coverage — and that the executor will refuse
 * the moment it matters. The user believed they were protected and were not,
 * discovered during a crash.
 *
 * ── THE THREE LAYERS ────────────────────────────────────────────────────────
 *
 *   1. CONTRACT (deferred to the pre-mainnet redeploy). The executor should
 *      accept a valid ECDSA signature from `permit.user` even when that address
 *      carries code, since the key still controls the account. Changing it
 *      needs a redeploy, so it is not in this file.
 *   2. GRANT TIME (here, `checkSignerCode`). Read `getCode(permit.user)` before
 *      storing. Empty code: nothing changes, ECDSA as today. Non-empty code:
 *      verify the permit the way the CONTRACT WILL — ERC-1271 against the same
 *      digest — and refuse to store a permit the contract would reject. Failing
 *      loudly at grant time, while the user is present and can act, beats
 *      failing silently during a liquidation.
 *   3. SWEEP (here, `codeTransition`; used by server/coverageSweep.ts). A user
 *      can install a delegate AFTER granting, which no grant-time check can
 *      catch. That is why grant time records whether the signer had code and
 *      what its code hash was: the sweep compares them against live state and
 *      alerts on the transition.
 *
 * WHY A CODE HASH AND NOT JUST A BOOLEAN. "Had code, still has code" is not
 * enough. A smart account whose permit was accepted under ERC-1271 can be
 * re-delegated to a different implementation that rejects the same signature.
 * The hash makes that visible; a boolean makes it invisible.
 */

import { keccak256 } from "viem";
import { hashExitPermit, type ExitDomainConfig, type ExitPermit } from "./exitPermit";

/** ERC-1271 `isValidSignature(bytes32,bytes)` success magic value. */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";

/** The minimal ERC-1271 fragment, for a viem `readContract`. */
export const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

/** The two reads this layer needs. Injectable so nothing here needs an RPC. */
export interface SignerCodeReader {
  /** `eth_getCode`. "0x" (or "0x0") for an address with no code. */
  codeAt(address: `0x${string}`): Promise<`0x${string}`>;
  /**
   * ERC-1271 `isValidSignature(digest, signature)`. Resolves the returned
   * bytes4, or null when the call reverted / the account has no such function
   * — which is the common case for a 7702 delegate and is a REJECTION, not an
   * error to swallow.
   */
  isValidSignature(
    account: `0x${string}`,
    digest: `0x${string}`,
    signature: `0x${string}`,
  ): Promise<`0x${string}` | null>;
}

/** What the signer address looked like at a point in time. */
export interface SignerCodeState {
  hasCode: boolean;
  /** keccak256 of the deployed code, or null when there is none. */
  codeHash: string | null;
}

/** Empty code is spelled several ways by different nodes. Treat them alike. */
export function isEmptyCode(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return normalized === "" || normalized === "0x" || /^0x0*$/.test(normalized);
}

export function codeStateFrom(code: `0x${string}`): SignerCodeState {
  if (isEmptyCode(code)) return { hasCode: false, codeHash: null };
  return { hasCode: true, codeHash: keccak256(code) };
}

/** The verdict of the grant-time check. */
export interface SignerCodeCheck {
  /** May this permit be stored? */
  ok: boolean;
  /** What to show the user. Empty when ok. Actionable, never a stack trace. */
  error: string;
  /** Recorded on the row so the sweep can detect a later transition. */
  state: SignerCodeState;
}

/**
 * The error the UI shows when a 7702 delegate refuses the permit.
 *
 * Written as an instruction rather than a diagnosis, because the user CAN fix
 * this and the only question they have is how.
 */
export const SIGNER_CODE_REJECTED_MESSAGE =
  "This wallet has contract code at its address (an EIP-7702 delegate or a smart account), " +
  "so the executor verifies the permit through ERC-1271 rather than a plain signature, and " +
  "this delegate did not accept it. Standing protection cannot be stored because it would " +
  "fail at the moment it is needed. Remove the delegate, or grant protection from a wallet " +
  "without one, then try again.";

/**
 * GRANT-TIME LAYER. Decide whether a permit may be stored, given what the
 * signer address looks like on-chain right now.
 *
 * `ecdsaValid` is the result the caller already computed with
 * `verifyPermitSignature`, passed in rather than recomputed so there is one
 * ECDSA check in the codebase.
 *
 * The truth table, chosen to match what the CONTRACT does rather than what is
 * convenient:
 *
 *   no code  + valid ECDSA        -> store. Unchanged behaviour.
 *   no code  + invalid ECDSA      -> reject. Unchanged behaviour.
 *   has code + ERC-1271 accepts   -> store. This also closes the long-standing
 *                                    smart-contract-wallet gap: those users
 *                                    could not register a delegation at all.
 *   has code + ERC-1271 rejects   -> REJECT, even when the ECDSA signature is
 *                                    perfectly valid, because the executor will
 *                                    never reach the ecrecover branch.
 *
 * A read failure is NOT a pass. Unknown is not permission to store coverage
 * that may be unusable.
 */
export async function checkSignerCode(
  permit: ExitPermit,
  signature: `0x${string}`,
  ecdsaValid: boolean,
  reader: SignerCodeReader,
  domain?: Partial<ExitDomainConfig>,
): Promise<SignerCodeCheck> {
  const code = await reader.codeAt(permit.user);
  const state = codeStateFrom(code);

  if (!state.hasCode) {
    return {
      ok: ecdsaValid,
      error: ecdsaValid ? "" : "signature does not recover to permit.user",
      state,
    };
  }

  // The digest is recomputed with the SAME helper that produced what the wallet
  // signed and what the contract hashes, so the bytes handed to ERC-1271 are
  // the bytes the executor will hand it.
  const digest = hashExitPermit(permit, domain);
  const returned = await reader.isValidSignature(permit.user, digest, signature);
  const accepted = returned !== null && returned.toLowerCase().startsWith(ERC1271_MAGIC_VALUE);

  return {
    ok: accepted,
    error: accepted ? "" : SIGNER_CODE_REJECTED_MESSAGE,
    state,
  };
}

/** What changed about the signer's code between grant time and now. */
export type CodeTransition = "none" | "gained_code" | "code_changed" | "unknown_baseline";

/**
 * SWEEP LAYER. Compare live signer code against what was recorded at grant.
 *
 * `unknown_baseline` is deliberate and is the honest answer for a row stored
 * before this column existed: the address has code now and there is no record
 * of whether it did then. Reporting that as "none" would be stating a fact the
 * code does not know; reporting it as `gained_code` would be inventing one. The
 * caller alerts on it as unverifiable.
 */
export function codeTransition(
  grantState: { hadCode: boolean | null; codeHash: string | null },
  live: SignerCodeState,
): CodeTransition {
  if (!live.hasCode) return "none";
  if (grantState.hadCode === null) return "unknown_baseline";
  if (grantState.hadCode === false) return "gained_code";
  if (grantState.codeHash === null) return "unknown_baseline";
  return grantState.codeHash.toLowerCase() === (live.codeHash ?? "").toLowerCase()
    ? "none"
    : "code_changed";
}
