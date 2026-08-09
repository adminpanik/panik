/**
 * ExitPermit verification — the trust check for delegated exits.
 *
 * The load-bearing test is the digest cross-check: it hand-rolls the EIP-712
 * digest EXACTLY as PanikExecutor.sol does in assembly (_domainSeparator ++
 * _hashPermitStruct ++ 0x1901 framing, with the verbatim type strings) and
 * asserts the module's viem-based hashExitPermit reproduces it byte for byte.
 * The contract's own interop test (executor/test/executor-v2.spec.ts, "matches
 * the domain and digest a standard client computes") pins the CONTRACT to
 * ethers' standard EIP-712 encoder over the same PERMIT_TYPES; this pins the
 * BACKEND to the same standard from the other side, so a field-order or type
 * typo here cannot silently ship a digest the contract would never sign.
 */

import { describe, expect, it } from "vitest";
import { concatHex, encodeAbiParameters, getAddress, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTOR_ADDRESS } from "../src/panik-core/lib/exit.generated";
import {
  BPS_DENOMINATOR,
  DOMAIN_TYPE_STRING,
  EXIT_KIND,
  EXIT_PERMIT_TYPES,
  EXIT_PERMIT_TYPE_STRING,
  exitDomain,
  hashExitPermit,
  parsePermitBody,
  validatePermitScope,
  verifyPermitSignature,
  type ExitPermit,
} from "./exitPermit";

const CHAIN_ID = 84532;
const VERIFYING = getAddress(EXECUTOR_ADDRESS);
const CFG = { chainId: CHAIN_ID, verifyingContract: VERIFYING };

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

function basePermit(over: Partial<ExitPermit> = {}): ExitPermit {
  return {
    user: alice.address.toLowerCase() as `0x${string}`,
    kind: EXIT_KIND.FULL_EXIT,
    maxRepayFractionBps: 10_000,
    triggerHealthFactorWad: 0n,
    maxSlippageBps: 500,
    protocolsMask: 0b1111,
    epoch: 0n,
    nonce: 1n,
    deadline: 4_000_000_000n,
    ...over,
  };
}

/** The digest, hand-rolled the way PanikExecutor.sol builds it in assembly. */
function solidityDigest(permit: ExitPermit, chainId: number, verifying: `0x${string}`): `0x${string}` {
  const domainTypehash = keccak256(stringToHex(DOMAIN_TYPE_STRING));
  const nameHash = keccak256(stringToHex("PanikExecutor"));
  const versionHash = keccak256(stringToHex("2"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypehash, nameHash, versionHash, BigInt(chainId), verifying],
    ),
  );

  const permitTypehash = keccak256(stringToHex(EXIT_PERMIT_TYPE_STRING));
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint8" },
        { type: "uint16" },
        { type: "uint256" },
        { type: "uint16" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        permitTypehash,
        permit.user,
        permit.kind,
        permit.maxRepayFractionBps,
        permit.triggerHealthFactorWad,
        permit.maxSlippageBps,
        permit.protocolsMask,
        permit.epoch,
        permit.nonce,
        permit.deadline,
      ],
    ),
  );

  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

describe("hashExitPermit", () => {
  it("matches the digest PanikExecutor.sol builds byte for byte", () => {
    const permit = basePermit();
    expect(hashExitPermit(permit, CFG)).toBe(solidityDigest(permit, CHAIN_ID, VERIFYING));
  });

  it("changes with every field, so tampering invalidates the signature", () => {
    const base = hashExitPermit(basePermit(), CFG);
    const mutations: Partial<ExitPermit>[] = [
      { kind: EXIT_KIND.REDUCE },
      { maxRepayFractionBps: 5_000 },
      { triggerHealthFactorWad: 1n },
      { maxSlippageBps: 501 },
      { protocolsMask: 0b0001 },
      { epoch: 1n },
      { nonce: 2n },
      { deadline: 4_000_000_001n },
    ];
    for (const m of mutations) {
      expect(hashExitPermit(basePermit(m), CFG)).not.toBe(base);
    }
  });

  it("is domain-bound: a different chainId or verifyingContract yields a different digest", () => {
    const permit = basePermit();
    expect(hashExitPermit(permit, { chainId: 8453, verifyingContract: VERIFYING })).not.toBe(
      hashExitPermit(permit, CFG),
    );
    expect(
      hashExitPermit(permit, { chainId: CHAIN_ID, verifyingContract: alice.address as `0x${string}` }),
    ).not.toBe(hashExitPermit(permit, CFG));
  });
});

describe("verifyPermitSignature", () => {
  async function sign(permit: ExitPermit, signer = alice) {
    return signer.signTypedData({
      domain: exitDomain(CFG),
      types: EXIT_PERMIT_TYPES,
      primaryType: "ExitPermit",
      message: permit,
    });
  }

  it("accepts a signature that recovers to permit.user", async () => {
    const permit = basePermit();
    expect(await verifyPermitSignature(permit, await sign(permit), CFG)).toBe(true);
  });

  it("rejects a signature from a different wallet", async () => {
    const permit = basePermit();
    expect(await verifyPermitSignature(permit, await sign(permit, mallory), CFG)).toBe(false);
  });

  it("rejects a signature over a tampered field", async () => {
    const signed = await sign(basePermit());
    // Same signature, but the submitted permit raised the slippage.
    expect(await verifyPermitSignature(basePermit({ maxSlippageBps: 9_000 }), signed, CFG)).toBe(false);
  });

  it("rejects garbage signature bytes without throwing", async () => {
    expect(await verifyPermitSignature(basePermit(), ("0x" + "11".repeat(65)) as `0x${string}`, CFG)).toBe(false);
  });
});

describe("parsePermitBody", () => {
  const good = {
    permit: {
      user: alice.address,
      kind: 0,
      maxRepayFractionBps: 10000,
      triggerHealthFactorWad: "0",
      maxSlippageBps: 500,
      protocolsMask: 15,
      epoch: "0",
      nonce: "1",
      deadline: "4000000000",
    },
    signature: "0x" + "ab".repeat(65),
  };

  it("parses decimal-string and numeric fields into a typed permit", () => {
    const r = parsePermitBody(good);
    expect(r.ok).toBe(true);
    expect(r.permit?.nonce).toBe(1n);
    expect(r.permit?.user).toBe(alice.address.toLowerCase());
    expect(r.permit?.deadline).toBe(4_000_000_000n);
  });

  it("accepts a full 256-bit nonce exactly (no bigint overflow)", () => {
    const bigNonce = (2n ** 256n - 1n).toString();
    const r = parsePermitBody({ ...good, permit: { ...good.permit, nonce: bigNonce } });
    expect(r.ok).toBe(true);
    expect(r.permit?.nonce).toBe(2n ** 256n - 1n);
  });

  it("rejects a missing signature, a bad address, and out-of-range fields", () => {
    expect(parsePermitBody({ permit: good.permit }).ok).toBe(false);
    expect(parsePermitBody({ ...good, permit: { ...good.permit, user: "nope" } }).ok).toBe(false);
    expect(parsePermitBody({ ...good, permit: { ...good.permit, kind: 9 } }).ok).toBe(false);
    expect(parsePermitBody({ ...good, permit: { ...good.permit, nonce: "-1" } }).ok).toBe(false);
    expect(parsePermitBody(undefined).ok).toBe(false);
  });
});

describe("validatePermitScope", () => {
  const CEILING = 2_000;
  const NOW = 1_000_000;

  it("accepts a well-scoped full exit", () => {
    expect(validatePermitScope(basePermit(), CEILING, NOW).ok).toBe(true);
  });

  it("requires a full kind to repay 100% (a partial FULL_EXIT is rejected)", () => {
    expect(validatePermitScope(basePermit({ maxRepayFractionBps: 5_000 }), CEILING, NOW).ok).toBe(false);
    expect(
      validatePermitScope(basePermit({ kind: EXIT_KIND.FULL_REPAY, maxRepayFractionBps: 9_999 }), CEILING, NOW).ok,
    ).toBe(false);
  });

  it("allows a partial fraction only for REDUCE", () => {
    expect(
      validatePermitScope(basePermit({ kind: EXIT_KIND.REDUCE, maxRepayFractionBps: 5_000 }), CEILING, NOW).ok,
    ).toBe(true);
  });

  it("rejects a zero fraction and one over the denominator", () => {
    expect(validatePermitScope(basePermit({ kind: EXIT_KIND.REDUCE, maxRepayFractionBps: 0 }), CEILING, NOW).ok).toBe(false);
    expect(
      validatePermitScope(basePermit({ kind: EXIT_KIND.REDUCE, maxRepayFractionBps: BPS_DENOMINATOR + 1 }), CEILING, NOW).ok,
    ).toBe(false);
  });

  it("rejects slippage over the executor ceiling", () => {
    expect(validatePermitScope(basePermit({ maxSlippageBps: CEILING + 1 }), CEILING, NOW).ok).toBe(false);
    expect(validatePermitScope(basePermit({ maxSlippageBps: CEILING }), CEILING, NOW).ok).toBe(true);
  });

  it("rejects a mask that enables no real protocol", () => {
    expect(validatePermitScope(basePermit({ protocolsMask: 0 }), CEILING, NOW).ok).toBe(false);
    expect(validatePermitScope(basePermit({ protocolsMask: 0b10000 }), CEILING, NOW).ok).toBe(false);
  });

  it("rejects a deadline at or before now", () => {
    expect(validatePermitScope(basePermit({ deadline: BigInt(NOW) }), CEILING, NOW).ok).toBe(false);
    expect(validatePermitScope(basePermit({ deadline: BigInt(NOW - 1) }), CEILING, NOW).ok).toBe(false);
    expect(validatePermitScope(basePermit({ deadline: BigInt(NOW + 1) }), CEILING, NOW).ok).toBe(true);
  });
});
