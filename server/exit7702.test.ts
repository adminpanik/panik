/**
 * EIP-7702 signer-code handling (Issue #41), layers 2 and 3.
 *
 * The bug: a 7702 delegate leaves the private key in control, so `ecrecover`
 * over the permit digest still returns `permit.user` and every ECDSA check the
 * backend runs still passes. The DEPLOYED executor does not use ecrecover
 * unconditionally — when the signer address carries code it asks that code, via
 * ERC-1271, and most 7702 delegates do not implement `isValidSignature` at all.
 * So the backend would store, and the UI would show, coverage the contract will
 * refuse at the exact moment it matters.
 *
 * The load-bearing test is "refuses a coded signer whose delegate rejects the
 * signature, EVEN WHEN the ECDSA signature is valid". That case is the whole
 * issue: everything else in the system says yes.
 *
 * Test keys are derived at runtime from a label (keccak256 of a sentence), the
 * same pattern server/exitRelayer.fork.test.ts uses, so no 64-hex private-key
 * literal ever lands in the repo for gitleaks to find.
 */

import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC1271_MAGIC_VALUE,
  SIGNER_CODE_REJECTED_MESSAGE,
  checkSignerCode,
  codeStateFrom,
  codeTransition,
  isEmptyCode,
  type SignerCodeReader,
} from "./exit7702";
import {
  EXIT_PERMIT_TYPES,
  exitDomain,
  hashExitPermit,
  type ExitPermit,
} from "./exitPermit";
import { submitDelegation, type DelegationDeps } from "./exitDelegations";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import type {
  DelegationInsert,
  DelegationRow,
  DelegationStatus,
  DelegationStore,
} from "./exitDelegationStore";
import type { ExitChainReader, TxReceiptInfo } from "./exitChain";

/** Derived at runtime; the whole secret is the sentence. */
const keyFromLabel = (label: string): `0x${string}` => keccak256(toHex(label));
const alice = privateKeyToAccount(keyFromLabel("panik-7702-test-signer"));
const USER = alice.address.toLowerCase() as `0x${string}`;

const NOW = 1_800_000_000;
const DELEGATE_CODE = toHex("7702-delegate-runtime") as `0x${string}`;
const DELEGATE_HASH = keccak256(DELEGATE_CODE);
const OTHER_CODE = toHex("a-different-implementation") as `0x${string}`;
const OTHER_HASH = keccak256(OTHER_CODE);

function permit(over: Partial<ExitPermit> = {}): ExitPermit {
  return {
    user: USER,
    kind: 0,
    maxRepayFractionBps: 10_000,
    triggerHealthFactorWad: 0n,
    maxSlippageBps: 100,
    protocolsMask: 0b1111,
    epoch: 0n,
    nonce: 11n,
    deadline: BigInt(NOW + 86_400),
    ...over,
  };
}

const sign = (p: ExitPermit): Promise<`0x${string}`> =>
  alice.signTypedData({
    domain: exitDomain(),
    types: EXIT_PERMIT_TYPES,
    primaryType: "ExitPermit",
    message: p,
  });

/** A code reader whose answers are set per test. */
class FakeReader implements SignerCodeReader {
  code: `0x${string}` = "0x";
  /** What ERC-1271 returns; null means reverted / no such function. */
  erc1271: `0x${string}` | null = null;
  /** Digests the reader was asked about, so the caller's hashing is checked. */
  seenDigests: string[] = [];
  codeError: string | null = null;

  async codeAt(): Promise<`0x${string}`> {
    if (this.codeError) throw new Error(this.codeError);
    return this.code;
  }
  async isValidSignature(
    _account: `0x${string}`,
    digest: `0x${string}`,
  ): Promise<`0x${string}` | null> {
    this.seenDigests.push(digest);
    return this.erc1271;
  }
}

describe("isEmptyCode / codeStateFrom", () => {
  it("treats every spelling of empty as empty", () => {
    for (const empty of ["0x", "0X", "", "0x0", "0x00"]) {
      expect(isEmptyCode(empty)).toBe(true);
    }
    expect(isEmptyCode(DELEGATE_CODE)).toBe(false);
  });

  it("hashes real code and refuses to hash nothing", () => {
    expect(codeStateFrom("0x")).toEqual({ hasCode: false, codeHash: null });
    expect(codeStateFrom(DELEGATE_CODE)).toEqual({ hasCode: true, codeHash: DELEGATE_HASH });
  });
});

describe("checkSignerCode — GRANT TIME (layer 2)", () => {
  it("leaves a plain EOA on the ECDSA path, unchanged", async () => {
    const reader = new FakeReader();
    const p = permit();
    const check = await checkSignerCode(p, await sign(p), true, reader);
    expect(check.ok).toBe(true);
    expect(check.state).toEqual({ hasCode: false, codeHash: null });
    // ERC-1271 is never consulted for an address with no code.
    expect(reader.seenDigests).toEqual([]);
  });

  it("still rejects a plain EOA whose signature does not recover", async () => {
    const check = await checkSignerCode(permit(), "0xdead", false, new FakeReader());
    expect(check.ok).toBe(false);
    expect(check.error).toContain("does not recover");
  });

  it("REFUSES a coded signer whose delegate rejects the signature", async () => {
    // THE ISSUE. The ECDSA signature is genuinely valid — the 7702 delegate
    // does not take the key away — and the executor will still refuse it,
    // because a signer with code never reaches the ecrecover branch.
    const reader = new FakeReader();
    reader.code = DELEGATE_CODE;
    reader.erc1271 = null; // no isValidSignature, the common 7702 case

    const p = permit();
    const check = await checkSignerCode(p, await sign(p), true, reader);
    expect(check.ok).toBe(false);
    expect(check.error).toBe(SIGNER_CODE_REJECTED_MESSAGE);
    // The baseline is recorded even on refusal: it is a true fact about the
    // signer and the caller may want it.
    expect(check.state).toEqual({ hasCode: true, codeHash: DELEGATE_HASH });
  });

  it("refuses when the delegate returns a non-magic value", async () => {
    const reader = new FakeReader();
    reader.code = DELEGATE_CODE;
    reader.erc1271 = "0xffffffff";
    const p = permit();
    expect((await checkSignerCode(p, await sign(p), true, reader)).ok).toBe(false);
  });

  it("ACCEPTS a smart account whose ERC-1271 returns the magic value", async () => {
    // This also closes the long-standing smart-contract-wallet gap: those
    // users previously could not register a delegation at all.
    const reader = new FakeReader();
    reader.code = DELEGATE_CODE;
    reader.erc1271 = ERC1271_MAGIC_VALUE as `0x${string}`;
    const p = permit();
    const check = await checkSignerCode(p, await sign(p), false, reader);
    expect(check.ok).toBe(true);
    expect(check.state.codeHash).toBe(DELEGATE_HASH);
  });

  it("asks ERC-1271 about the SAME digest the contract will hash", async () => {
    const reader = new FakeReader();
    reader.code = DELEGATE_CODE;
    reader.erc1271 = ERC1271_MAGIC_VALUE as `0x${string}`;
    const p = permit();
    await checkSignerCode(p, await sign(p), false, reader);
    expect(reader.seenDigests).toEqual([hashExitPermit(p)]);
  });

  it("propagates a getCode failure instead of passing", async () => {
    // Unknown is not permission to store coverage that may be unusable.
    const reader = new FakeReader();
    reader.codeError = "rpc timeout";
    await expect(checkSignerCode(permit(), "0x00", true, reader)).rejects.toThrow("rpc timeout");
  });
});

describe("codeTransition — SWEEP (layer 3)", () => {
  const live = codeStateFrom(DELEGATE_CODE);

  it("is a no-op for a signer that still has no code", () => {
    expect(codeTransition({ hadCode: false, codeHash: null }, codeStateFrom("0x"))).toBe("none");
    expect(codeTransition({ hadCode: null, codeHash: null }, codeStateFrom("0x"))).toBe("none");
  });

  it("detects a delegate installed AFTER the grant", () => {
    expect(codeTransition({ hadCode: false, codeHash: null }, live)).toBe("gained_code");
  });

  it("stays quiet for a smart account whose code is unchanged", () => {
    expect(codeTransition({ hadCode: true, codeHash: DELEGATE_HASH }, live)).toBe("none");
  });

  it("detects a re-delegation to different code", () => {
    // A boolean baseline cannot see this; the hash can, and the new
    // implementation may reject the signature the old one accepted.
    expect(codeTransition({ hadCode: true, codeHash: OTHER_HASH }, live)).toBe("code_changed");
  });

  it("reports an unrecorded baseline as unknown, never as clean", () => {
    expect(codeTransition({ hadCode: null, codeHash: null }, live)).toBe("unknown_baseline");
    expect(codeTransition({ hadCode: true, codeHash: null }, live)).toBe("unknown_baseline");
  });
});

// ── the grant path end to end ────────────────────────────────────────────────

class FakeStore implements DelegationStore {
  rows: DelegationInsert[] = [];
  async insert(row: DelegationInsert): Promise<boolean> {
    this.rows.push(row);
    return true;
  }
  async listActive(): Promise<DelegationRow[]> {
    return [];
  }
  async setStatus(_id: string, _status: DelegationStatus): Promise<void> {}
}

class FakeChain implements ExitChainReader {
  code: `0x${string}` = "0x";
  erc1271: `0x${string}` | null = null;
  async revocationEpoch(): Promise<bigint> {
    return 0n;
  }
  async isNonceUsed(): Promise<boolean> {
    return false;
  }
  async maxPermitSlippageBps(): Promise<number> {
    return 1_000;
  }
  async receiptFor(): Promise<TxReceiptInfo | null> {
    return null;
  }
  async codeAt(): Promise<`0x${string}`> {
    return this.code;
  }
  async isValidSignature(): Promise<`0x${string}` | null> {
    return this.erc1271;
  }
}

describe("submitDelegation — the gate in the real submit path", () => {
  const deps = (chain: FakeChain, store: FakeStore): DelegationDeps => ({
    store,
    chain,
    chainId: EXIT_CHAIN_ID,
    executor: EXECUTOR_ADDRESS,
    nowSec: NOW,
  });

  it("stores a plain-EOA permit and records the baseline as no-code", async () => {
    const store = new FakeStore();
    const p = permit();
    const res = await submitDelegation(
      { permit: p, signature: await sign(p) },
      deps(new FakeChain(), store),
    );
    expect(res.status).toBe(200);
    expect(store.rows[0]).toMatchObject({ signerHadCode: false, signerCodeHash: null });
  });

  it("REFUSES to store a permit a 7702 delegate would reject, with an actionable error", async () => {
    const store = new FakeStore();
    const chain = new FakeChain();
    chain.code = DELEGATE_CODE;
    chain.erc1271 = null;

    const p = permit();
    const res = await submitDelegation({ permit: p, signature: await sign(p) }, deps(chain, store));
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(SIGNER_CODE_REJECTED_MESSAGE);
    // Nothing stored: failing loudly here beats failing silently in a crash.
    expect(store.rows).toEqual([]);
  });

  it("stores a smart-account permit and records its code hash for the sweep", async () => {
    const store = new FakeStore();
    const chain = new FakeChain();
    chain.code = DELEGATE_CODE;
    chain.erc1271 = ERC1271_MAGIC_VALUE as `0x${string}`;

    const p = permit();
    const res = await submitDelegation({ permit: p, signature: await sign(p) }, deps(chain, store));
    expect(res.status).toBe(200);
    expect(store.rows[0]).toMatchObject({ signerHadCode: true, signerCodeHash: DELEGATE_HASH });
  });

  it("returns 503, not a pass, when the code read fails", async () => {
    const chain = new FakeChain();
    chain.codeAt = async () => {
      throw new Error("rpc down");
    };
    const p = permit();
    const res = await submitDelegation(
      { permit: p, signature: await sign(p) },
      deps(chain, new FakeStore()),
    );
    expect(res.status).toBe(503);
  });
});
