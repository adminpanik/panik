/**
 * ExitPermit verification — the trust check for delegated exits (Phase 2.B).
 *
 * A user signs an EIP-712 ExitPermit in their wallet; the relayer (Phase 4.A)
 * later submits it to PanikExecutor.atomicExitFor. THE DELEGATION IS THE
 * SIGNATURE: PANIK custodies no per-user key, and the permit carries no
 * recipient, so proceeds can only ever land on `permit.user`. Before the
 * backend stores a permit it must recompute the SAME EIP-712 digest the
 * contract computes and recover the signer, or a stored permit is a useless (or
 * worse, misleading) row.
 *
 * BYTE-FOR-BYTE WITH THE CONTRACT. The domain, the type string and the struct
 * encoding here are transcribed from executor/contracts/PanikExecutor.sol
 * (DOMAIN_TYPEHASH, EXIT_PERMIT_TYPEHASH, _domainSeparator, _hashPermitStruct)
 * and executor/contracts/libraries/ExitTypes.sol (the ExitPermit struct). If
 * any of them drifts, the recovered signer stops matching and every submit
 * 401s — which is why server/exitPermit.test.ts hand-rolls the digest exactly
 * as the Solidity does and asserts viem's hashTypedData reproduces it.
 *
 * CHAIN ID BINDING — READ THIS. The EIP-712 domain pins the EXECUTOR's chain,
 * which is Base Sepolia (84532) today, NOT Base mainnet (8453). walletAuth.ts /
 * siweProof.ts hardcode 8453 because SIWE proofs name the chain PANIK MONITORS
 * (mainnet). These are DIFFERENT chains for DIFFERENT purposes: monitoring runs
 * on mainnet, the audited-pending executor runs on testnet. Reusing 8453 here
 * would compute a digest for a domain the deployed contract never uses, so
 * every recovered signer would be wrong. The chain id therefore comes from
 * EXIT_CHAIN_ID (src/panik-core/lib/exit.generated.ts), the single source of
 * truth for where the executor lives, and flips to 8453 only when that file is
 * regenerated against a mainnet deployment.
 */

import { hashTypedData, isAddress, recoverTypedDataAddress } from "viem";
import {
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
} from "../src/panik-core/lib/exit.generated";

/** ExitTypes.ExitKind (executor/contracts/libraries/ExitTypes.sol). */
export const EXIT_KIND = { FULL_EXIT: 0, FULL_REPAY: 1, REDUCE: 2 } as const;

/** PanikExecutor.BPS_DENOMINATOR. */
export const BPS_DENOMINATOR = 10_000;

/** Fixed-point scale for a health factor on-chain (WAD = 1e18). */
export const WAD = 10n ** 18n;

/**
 * A health factor as the contract's WAD-scaled integer (HF x 1e18).
 *
 * Two-step so it stays exact in double precision: HF is rounded to 1e-9 first
 * (nine decimals is far past anything a health factor is quoted to), then
 * scaled up in BigInt. `hf * 1e18` straight through a Number would lose the low
 * bits of the mantissa and hand the signer a digest a hair off the contract's.
 *
 * Lives HERE, next to the permit field it encodes, because two callers need it
 * and they must agree: the UI composes `triggerHealthFactorWad` for the wallet
 * to sign (src/panik-core/lib/exitPermitCompose.ts), and the relayer compares
 * the engine's live health factor against that same field before it spends gas
 * (server/exitRelayer.ts). A second copy of this conversion is a second opinion
 * about when a position is in trouble.
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
 * The EIP-712 type, transcribed field-for-field from EXIT_PERMIT_TYPEHASH in
 * PanikExecutor.sol. Order and Solidity types must match exactly.
 */
export const EXIT_PERMIT_TYPES = {
  ExitPermit: [
    { name: "user", type: "address" },
    { name: "kind", type: "uint8" },
    { name: "maxRepayFractionBps", type: "uint16" },
    { name: "triggerHealthFactorWad", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "protocolsMask", type: "uint8" },
    { name: "epoch", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The exact type string keccak256'd into EXIT_PERMIT_TYPEHASH on-chain. */
export const EXIT_PERMIT_TYPE_STRING =
  "ExitPermit(address user,uint8 kind,uint16 maxRepayFractionBps,uint256 triggerHealthFactorWad,uint16 maxSlippageBps,uint8 protocolsMask,uint256 epoch,uint256 nonce,uint256 deadline)";

/** The EIP-712 domain type string keccak256'd into DOMAIN_TYPEHASH on-chain. */
export const DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** DOMAIN_NAME_HASH / DOMAIN_VERSION_HASH pre-images. */
export const DOMAIN_NAME = "PanikExecutor";
export const DOMAIN_VERSION = "2";

/**
 * The normalized permit the rest of the backend passes around. The three true
 * uint256 fields are bigint so they round-trip a full 256-bit value; the
 * bounded fields are plain numbers.
 */
export interface ExitPermit {
  user: `0x${string}`;
  kind: number;
  maxRepayFractionBps: number;
  triggerHealthFactorWad: bigint;
  maxSlippageBps: number;
  protocolsMask: number;
  epoch: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** Where the permit will be verified: the deployed executor and its chain. */
export interface ExitDomainConfig {
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * The domain to verify against. Defaults to the deployed executor from the
 * generated config — the ONLY place the executor's chain and address are
 * defined (see the chain-id note in the header).
 */
export function exitDomain(cfg?: Partial<ExitDomainConfig>) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: cfg?.chainId ?? EXIT_CHAIN_ID,
    verifyingContract: cfg?.verifyingContract ?? EXECUTOR_ADDRESS,
  } as const;
}

/** The EIP-712 digest the signer's wallet signs — the contract's hashExitPermit. */
export function hashExitPermit(permit: ExitPermit, cfg?: Partial<ExitDomainConfig>): `0x${string}` {
  return hashTypedData({
    domain: exitDomain(cfg),
    types: EXIT_PERMIT_TYPES,
    primaryType: "ExitPermit",
    message: permit,
  });
}

/**
 * Recover the address that produced `signature` over `permit`. EOA signatures
 * only (viem's recoverTypedDataAddress); ERC-1271 smart-contract wallets are a
 * documented gap, exactly as walletAuth.ts accepts for SIWE — those users keep
 * every read path and only lose self-service delegation registration.
 */
export async function recoverPermitSigner(
  permit: ExitPermit,
  signature: `0x${string}`,
  cfg?: Partial<ExitDomainConfig>,
): Promise<`0x${string}` | null> {
  try {
    return await recoverTypedDataAddress({
      domain: exitDomain(cfg),
      types: EXIT_PERMIT_TYPES,
      primaryType: "ExitPermit",
      message: permit,
      signature,
    });
  } catch {
    return null; // malformed signature bytes are a rejection, never a throw
  }
}

/**
 * THE trust check: does `signature` recover to `permit.user`? Address format is
 * never authorization (CLAUDE.md security posture); a signature that recovers to
 * the named user is. Case-insensitive because recovery returns EIP-55 checksum.
 */
export async function verifyPermitSignature(
  permit: ExitPermit,
  signature: `0x${string}`,
  cfg?: Partial<ExitDomainConfig>,
): Promise<boolean> {
  const recovered = await recoverPermitSigner(permit, signature, cfg);
  return recovered !== null && recovered.toLowerCase() === permit.user.toLowerCase();
}

/** Result of parsing an untrusted request body into an ExitPermit. */
export interface ParsedPermit {
  ok: boolean;
  permit: ExitPermit | null;
  signature: `0x${string}` | null;
  error: string;
}

const parseFail = (error: string): ParsedPermit => ({ ok: false, permit: null, signature: null, error });

/** Parse a decimal / 0x-hex numeric field into a non-negative bigint, or null. */
function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) {
    try {
      const n = BigInt(v.trim());
      return n >= 0n ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse a bounded uint (kind/bps/mask) into a number within [0, max], or null. */
function toBoundedUint(v: unknown, max: number): number | null {
  const n = toBigInt(v);
  if (n === null || n > BigInt(max)) return null;
  return Number(n);
}

/**
 * Parse `{permit, signature}` off an untrusted body. Shape and range only — the
 * signature is verified by verifyPermitSignature and the scope by
 * validatePermitScope. Returns fields describing the CALLER's input, safe to
 * echo back.
 */
export function parsePermitBody(body: unknown): ParsedPermit {
  const { permit, signature } = (body ?? {}) as { permit?: unknown; signature?: unknown };
  if (permit === null || typeof permit !== "object") return parseFail("missing permit");
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return parseFail("missing or malformed signature");
  }

  const p = permit as Record<string, unknown>;
  const user = typeof p.user === "string" ? p.user.trim() : "";
  if (!isAddress(user)) return parseFail("permit.user is not a valid address");

  const kind = toBoundedUint(p.kind, EXIT_KIND.REDUCE);
  if (kind === null) return parseFail("permit.kind out of range");

  const maxRepayFractionBps = toBoundedUint(p.maxRepayFractionBps, 0xffff);
  if (maxRepayFractionBps === null) return parseFail("permit.maxRepayFractionBps out of range");

  const maxSlippageBps = toBoundedUint(p.maxSlippageBps, 0xffff);
  if (maxSlippageBps === null) return parseFail("permit.maxSlippageBps out of range");

  const protocolsMask = toBoundedUint(p.protocolsMask, 0xff);
  if (protocolsMask === null) return parseFail("permit.protocolsMask out of range");

  const triggerHealthFactorWad = toBigInt(p.triggerHealthFactorWad);
  if (triggerHealthFactorWad === null) return parseFail("permit.triggerHealthFactorWad invalid");

  const epoch = toBigInt(p.epoch);
  if (epoch === null) return parseFail("permit.epoch invalid");

  const nonce = toBigInt(p.nonce);
  if (nonce === null) return parseFail("permit.nonce invalid");

  const deadline = toBigInt(p.deadline);
  if (deadline === null) return parseFail("permit.deadline invalid");

  return {
    ok: true,
    error: "",
    signature: signature as `0x${string}`,
    permit: {
      user: user.toLowerCase() as `0x${string}`,
      kind,
      maxRepayFractionBps,
      triggerHealthFactorWad,
      maxSlippageBps,
      protocolsMask,
      epoch,
      nonce,
      deadline,
    },
  };
}

/** Outcome of a scope check. */
export interface ScopeCheck {
  ok: boolean;
  error: string;
}

const scopeFail = (error: string): ScopeCheck => ({ ok: false, error });

/**
 * Validate the permit against the SAME rules PanikExecutor._validatePermitScope
 * / _consumePermit enforce, so the backend never stores a permit the contract
 * would reject. The leg-vs-permit checks (which markets, which assets, the
 * per-leg repay/withdraw floors) run at execution against LIVE state and cannot
 * be prevalidated without the legs, which the relayer builds later; what CAN be
 * checked from the permit alone is checked here.
 *
 * @param maxPermitSlippageBps the executor's immutable ceiling, read on-chain.
 * @param nowSec current unix time; the deadline must be strictly in the future
 *   (contract reverts on block.timestamp > deadline).
 */
export function validatePermitScope(
  permit: ExitPermit,
  maxPermitSlippageBps: number,
  nowSec: number,
): ScopeCheck {
  if (permit.kind > EXIT_KIND.REDUCE) return scopeFail("invalid permit kind");

  const full = permit.kind === EXIT_KIND.FULL_REPAY || permit.kind === EXIT_KIND.FULL_EXIT;
  if (
    permit.maxRepayFractionBps === 0 ||
    permit.maxRepayFractionBps > BPS_DENOMINATOR ||
    (full && permit.maxRepayFractionBps !== BPS_DENOMINATOR)
  ) {
    return scopeFail("invalid maxRepayFractionBps for this kind");
  }

  if (permit.maxSlippageBps > maxPermitSlippageBps) {
    return scopeFail(`maxSlippageBps exceeds the executor ceiling (${maxPermitSlippageBps})`);
  }

  // An all-zero mask, or one with only bits above the four real protocols
  // (AAVE_V3=0 .. MORPHO_BLUE=3), permits no leg at all: every leg would revert
  // ProtocolNotPermitted, so the permit is dead weight. Refuse to store it.
  if ((permit.protocolsMask & 0x0f) === 0) {
    return scopeFail("protocolsMask enables no protocol");
  }

  // block.timestamp > deadline reverts on-chain; a permit already past its
  // deadline can never execute, so it must never be stored as live.
  if (permit.deadline <= BigInt(nowSec)) return scopeFail("permit deadline has already passed");

  return { ok: true, error: "" };
}
