/**
 * Delegation lifecycle orchestration — submit, the live-permit query, and
 * revocation, all against a mocked store + chain (the pattern
 * server/walletAuth.test.ts uses for the nonce store).
 *
 * The properties under test are the ones whose absence would be a real bug: a
 * permit is stored only if its signature recovers to permit.user AND the chain
 * would accept it, and a permit is NEVER reported live once the chain has
 * expired, orphaned (stale epoch) or spent (used nonce) it - "never state a
 * fact the code does not know" applied to liquidation coverage.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import { EXIT_PERMIT_TYPES, exitDomain, type ExitPermit } from "./exitPermit";
import type { ExitChainReader, TxReceiptInfo } from "./exitChain";
import type {
  DelegationInsert,
  DelegationRow,
  DelegationStatus,
  DelegationStore,
} from "./exitDelegationStore";
import {
  listLiveDelegations,
  resolveLiveStatus,
  revokeDelegation,
  submitDelegation,
  type DelegationDeps,
} from "./exitDelegations";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const USER = alice.address.toLowerCase() as `0x${string}`;
const NOW = 1_000_000;

function basePermit(over: Partial<ExitPermit> = {}): ExitPermit {
  return {
    user: USER,
    kind: 0,
    maxRepayFractionBps: 10_000,
    triggerHealthFactorWad: 0n,
    maxSlippageBps: 500,
    protocolsMask: 0b1111,
    epoch: 0n,
    nonce: 1n,
    deadline: BigInt(NOW + 3_600),
    ...over,
  };
}

async function sign(permit: ExitPermit, signer = alice): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: exitDomain(),
    types: EXIT_PERMIT_TYPES,
    primaryType: "ExitPermit",
    message: permit,
  });
}

/** In-memory store; enforces the same unique (chain, executor, user, nonce). */
class FakeStore implements DelegationStore {
  rows: DelegationRow[] = [];
  private seq = 0;

  async insert(row: DelegationInsert): Promise<boolean> {
    const dup = this.rows.some(
      (r) =>
        r.chainId === row.chainId &&
        r.executor === row.executor.toLowerCase() &&
        r.permit.user === row.permit.user.toLowerCase() &&
        r.permit.nonce === row.permit.nonce,
    );
    if (dup) return false;
    this.rows.push({
      id: `row-${this.seq++}`,
      createdAt: NOW * 1000,
      permit: { ...row.permit, user: row.permit.user.toLowerCase() as `0x${string}` },
      signature: row.signature,
      status: "active",
      chainId: row.chainId,
      executor: row.executor.toLowerCase() as `0x${string}`,
      revocationTx: null,
      signerHadCode: row.signerHadCode ?? null,
      signerCodeHash: row.signerCodeHash ?? null,
    });
    return true;
  }

  async listActive(user: `0x${string}`, chainId: number, executor: `0x${string}`): Promise<DelegationRow[]> {
    return this.rows.filter(
      (r) =>
        r.status === "active" &&
        r.permit.user === user.toLowerCase() &&
        r.chainId === chainId &&
        r.executor === executor.toLowerCase(),
    );
  }

  async setStatus(id: string, status: DelegationStatus, revocationTx?: string | null): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.status = status;
      if (revocationTx !== undefined) row.revocationTx = revocationTx;
    }
  }
}

/** Configurable chain stand-in. */
class FakeChain implements ExitChainReader {
  epoch = 0n;
  usedNonces = new Set<string>();
  ceiling = 2_000;
  receipts = new Map<string, TxReceiptInfo>();
  /** Signer code, keyed by lowercased address. Empty = a plain EOA. */
  code = new Map<string, `0x${string}`>();
  /** What ERC-1271 returns for a coded signer; null = reverted / no function. */
  erc1271: `0x${string}` | null = null;

  async codeAt(address: `0x${string}`): Promise<`0x${string}`> {
    return this.code.get(address.toLowerCase()) ?? "0x";
  }
  async isValidSignature(): Promise<`0x${string}` | null> {
    return this.erc1271;
  }

  async revocationEpoch(): Promise<bigint> {
    return this.epoch;
  }
  async isNonceUsed(_user: `0x${string}`, nonce: bigint): Promise<boolean> {
    return this.usedNonces.has(nonce.toString());
  }
  async maxPermitSlippageBps(): Promise<number> {
    return this.ceiling;
  }
  async receiptFor(txHash: `0x${string}`): Promise<TxReceiptInfo | null> {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
}

let store: FakeStore;
let chain: FakeChain;
let deps: DelegationDeps;

beforeEach(() => {
  store = new FakeStore();
  chain = new FakeChain();
  deps = { store, chain, chainId: EXIT_CHAIN_ID, executor: EXECUTOR_ADDRESS, nowSec: NOW };
});

async function submit(permit: ExitPermit, signer = alice) {
  return submitDelegation({ permit, signature: await sign(permit, signer) }, deps);
}

describe("submitDelegation", () => {
  it("stores a valid, well-scoped, on-chain-live permit", async () => {
    const res = await submit(basePermit());
    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  it("is idempotent: resubmitting the same permit reports a duplicate, not a new row", async () => {
    await submit(basePermit());
    const again = await submit(basePermit());
    expect(again.status).toBe(200);
    expect((again.body as any).duplicate).toBe(true);
    expect(store.rows).toHaveLength(1);
  });

  it("rejects a signature that does not recover to permit.user (401)", async () => {
    const res = await submit(basePermit(), mallory);
    expect(res.status).toBe(401);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects a tampered permit whose signature no longer matches (401)", async () => {
    const signature = await sign(basePermit());
    // Submit a permit with a raised slippage under the old signature.
    const res = await submitDelegation({ permit: basePermit({ maxSlippageBps: 1_500 }), signature }, deps);
    expect(res.status).toBe(401);
  });

  it("rejects slippage over the executor ceiling (400)", async () => {
    chain.ceiling = 1_000;
    const res = await submit(basePermit({ maxSlippageBps: 1_500 }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty protocols mask (400)", async () => {
    const res = await submit(basePermit({ protocolsMask: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects an already-expired deadline (400)", async () => {
    const res = await submit(basePermit({ deadline: BigInt(NOW - 1) }));
    expect(res.status).toBe(400);
  });

  it("rejects a permit on a stale revocation epoch (409)", async () => {
    chain.epoch = 42n; // wallet has revoked since; permit was signed at epoch 0
    const res = await submit(basePermit({ epoch: 0n }));
    expect(res.status).toBe(409);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects a permit whose nonce is already spent on-chain (409)", async () => {
    chain.usedNonces.add("1");
    const res = await submit(basePermit({ nonce: 1n }));
    expect(res.status).toBe(409);
  });

  it("returns 400 for a malformed body", async () => {
    expect((await submitDelegation({}, deps)).status).toBe(400);
    expect((await submitDelegation({ permit: { user: "nope" }, signature: "0x12" }, deps)).status).toBe(400);
  });
});

describe("resolveLiveStatus", () => {
  const row = (over: Partial<ExitPermit> = {}): DelegationRow => ({
    id: "x",
    createdAt: 0,
    permit: basePermit(over),
    signature: "0x00" as `0x${string}`,
    status: "active",
    chainId: EXIT_CHAIN_ID,
    executor: EXECUTOR_ADDRESS,
    revocationTx: null,
    signerHadCode: false,
    signerCodeHash: null,
  });

  it("is expired when the deadline has passed, regardless of chain", () => {
    expect(resolveLiveStatus(row({ deadline: BigInt(NOW - 1) }), 0n, false, NOW)).toBe("expired");
  });
  it("is revoked when the permit epoch differs from the chain epoch", () => {
    expect(resolveLiveStatus(row({ epoch: 0n }), 7n, false, NOW)).toBe("revoked");
  });
  it("is consumed when the nonce is spent", () => {
    expect(resolveLiveStatus(row(), 0n, true, NOW)).toBe("consumed");
  });
  it("is active only when live on every axis", () => {
    expect(resolveLiveStatus(row(), 0n, false, NOW)).toBe("active");
  });
});

describe("listLiveDelegations", () => {
  it("returns only genuinely live permits and hides expired/revoked/consumed", async () => {
    await submit(basePermit({ nonce: 1n }));
    await submit(basePermit({ nonce: 2n }));
    await submit(basePermit({ nonce: 3n, deadline: BigInt(NOW + 10) }));
    expect(store.rows).toHaveLength(3);

    // nonce 2 gets spent on-chain; the deadline of nonce 3 lapses.
    chain.usedNonces.add("2");
    deps.nowSec = NOW + 100;

    const res = await listLiveDelegations(USER, deps);
    expect(res.status).toBe(200);
    const live = (res.body as any).delegations as any[];
    expect(live.map((d) => d.permit.nonce).sort()).toEqual(["1"]);
    expect(live[0].status).toBe("active");
    expect(live[0].signature).toMatch(/^0x/);
  });

  it("lazily persists the terminal statuses it discovers", async () => {
    await submit(basePermit({ nonce: 5n }));
    chain.epoch = 99n; // orphans the epoch-0 permit
    await listLiveDelegations(USER, deps);
    expect(store.rows[0]!.status).toBe("revoked");
  });

  it("rejects an invalid wallet (400)", async () => {
    expect((await listLiveDelegations("not-an-address", deps)).status).toBe(400);
  });

  it("returns an empty list for a wallet with no delegations", async () => {
    const res = await listLiveDelegations(mallory.address, deps);
    expect(res.status).toBe(200);
    expect((res.body as any).delegations).toEqual([]);
  });
});

describe("revokeDelegation", () => {
  it("flips rows the chain shows as revoked and records the tx evidence", async () => {
    await submit(basePermit({ nonce: 1n }));
    chain.epoch = 123n; // user called revokeAll on-chain
    const txHash = ("0x" + "cd".repeat(32)) as `0x${string}`;
    chain.receipts.set(txHash.toLowerCase(), { from: USER, to: EXECUTOR_ADDRESS, success: true });

    const res = await revokeDelegation({ wallet: USER, txHash }, deps);
    expect(res.status).toBe(200);
    expect((res.body as any).revoked).toHaveLength(1);
    expect(store.rows[0]!.status).toBe("revoked");
    expect(store.rows[0]!.revocationTx).toBe(txHash);
  });

  it("does not flip anything when the chain still shows the permit live", async () => {
    await submit(basePermit({ nonce: 1n }));
    const res = await revokeDelegation({ wallet: USER }, deps);
    expect(res.status).toBe(200);
    expect((res.body as any).revoked).toHaveLength(0);
    expect((res.body as any).stillActive).toBe(1);
    expect(store.rows[0]!.status).toBe("active");
  });

  it("rejects a txHash not sent by the wallet to the executor (400)", async () => {
    await submit(basePermit({ nonce: 1n }));
    chain.epoch = 5n;
    const txHash = ("0x" + "ef".repeat(32)) as `0x${string}`;
    chain.receipts.set(txHash.toLowerCase(), { from: mallory.address.toLowerCase() as `0x${string}`, to: EXECUTOR_ADDRESS, success: true });
    const res = await revokeDelegation({ wallet: USER, txHash }, deps);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed txHash (400) and an invalid wallet (400)", async () => {
    expect((await revokeDelegation({ wallet: USER, txHash: "0x1234" }, deps)).status).toBe(400);
    expect((await revokeDelegation({ wallet: "nope" }, deps)).status).toBe(400);
  });
});
