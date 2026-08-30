/**
 * Relayer unit tests (Phase 4.A).
 *
 * These cover the DECISION TREE — every gate, in isolation, with fakes. They
 * are necessary and NOT sufficient: a mocked chain will agree with whatever the
 * code believes about the contract, so the proof that a real submission works
 * lives in server/exitRelayer.fork.test.ts, which runs the same submit path
 * against the REAL deployed executor on a forked Base Sepolia.
 *
 * What is asserted here is the part a fork cannot cheaply prove: that the
 * relayer REFUSES in each of the ways it is supposed to, and that each refusal
 * is named. A relayer that works is table stakes; a relayer that stops is the
 * feature.
 */

import { describe, expect, it } from "vitest";
import {
  runRelayerTick,
  triggerFired,
  permitCoversProtocol,
  type AtomicExitForCall,
  type RelayerCandidate,
  type RelayerChain,
  type RelayerDeps,
  type RelayerReceipt,
} from "./exitRelayer";
import {
  DEFAULT_RELAYER_LIMITS,
  SubmissionRateWindow,
  chainGuardOk,
  relayerEnabled,
  sequencerStale,
  type RelayerEvent,
  type RelayerLimits,
} from "./relayerPolicy";
import { MemoryRelayerAttemptStore } from "./relayerAttemptStore";
import {
  PinnedEndpointOperation,
  RelayerSignerPool,
  bumpFee,
  endpointLabel,
  type PinnedEndpointClient,
  type RelayerSigner,
  type SignerOperation,
} from "./relayerSigner";
import { EXIT_KIND, hfToWad, type ExitPermit } from "./exitPermit";
import type { DelegationRow, DelegationStatus, DelegationStore } from "./exitDelegationStore";
import type { ExitChainReader, TxReceiptInfo } from "./exitChain";
import type { ExitReserveState } from "../src/panik-core/lib/exitLegs";

const CHAIN_ID = 84532;
const EXECUTOR = "0x554530e0a5c428bd7f617f875a3c5570803842e4" as `0x${string}`;
const USER = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const WETH = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as `0x${string}`;
const SIG = ("0x" + "ab".repeat(65)) as `0x${string}`;

const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;

function permit(over: Partial<ExitPermit> = {}): ExitPermit {
  return {
    user: USER,
    kind: EXIT_KIND.FULL_REPAY,
    maxRepayFractionBps: 10_000,
    triggerHealthFactorWad: hfToWad(1.5),
    maxSlippageBps: 100,
    protocolsMask: 0b0001, // AAVE_V3
    epoch: 0n,
    nonce: 7n,
    deadline: BigInt(NOW_SEC + 86_400),
    ...over,
  };
}

function row(p: ExitPermit = permit(), status: DelegationStatus = "active"): DelegationRow {
  return {
    id: `row-${p.nonce}`,
    createdAt: NOW_MS,
    permit: p,
    signature: SIG,
    status,
    chainId: CHAIN_ID,
    executor: EXECUTOR,
    revocationTx: null,
    signerHadCode: false,
    signerCodeHash: null,
  };
}

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeDelegationStore implements DelegationStore {
  constructor(public rows: DelegationRow[] = []) {}
  async insert(): Promise<boolean> {
    return true;
  }
  async listActive(): Promise<DelegationRow[]> {
    return this.rows;
  }
  async setStatus(id: string, status: DelegationStatus): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = status;
  }
}

class FakeExitChainReader implements ExitChainReader {
  constructor(
    public epoch = 0n,
    public usedNonces = new Set<string>(),
  ) {}
  async revocationEpoch(): Promise<bigint> {
    return this.epoch;
  }
  async isNonceUsed(_u: `0x${string}`, nonce: bigint): Promise<boolean> {
    return this.usedNonces.has(nonce.toString());
  }
  async maxPermitSlippageBps(): Promise<number> {
    return 1_000;
  }
  async receiptFor(): Promise<TxReceiptInfo | null> {
    return null;
  }
  // 4.B added the EIP-7702 reads to ExitChainReader. The relayer never calls
  // them (it consumes reconciled rows, never re-verifies a signature), so a
  // plain-EOA answer keeps this fake honest about what it stands in for.
  async codeAt(): Promise<`0x${string}`> {
    return "0x";
  }
  async isValidSignature(): Promise<`0x${string}` | null> {
    return null;
  }
}

interface FakeChainOptions {
  chainId?: number;
  blockTsSec?: number;
  reserves?: ExitReserveState[];
  gas?: bigint;
  simulateThrows?: string;
  receipt?: RelayerReceipt | null;
  usedNonces?: Set<string>;
}

class FakeChain implements RelayerChain {
  simulateCalls: AtomicExitForCall[] = [];
  constructor(private readonly o: FakeChainOptions = {}) {}
  async chainId(): Promise<number> {
    return this.o.chainId ?? CHAIN_ID;
  }
  async latestBlockTimestampSec(): Promise<number> {
    return this.o.blockTsSec ?? NOW_SEC - 3;
  }
  async isNonceUsed(_u: `0x${string}`, nonce: bigint): Promise<boolean> {
    return (this.o.usedNonces ?? new Set<string>()).has(nonce.toString());
  }
  async reserveStates(_user: `0x${string}`): Promise<ExitReserveState[]> {
    return (
      this.o.reserves ?? [
        { reserve: USDC, symbol: "USDC", decimals: 6, aBalance: 0n, debt: 100_000_000n },
        { reserve: WETH, symbol: "WETH", decimals: 18, aBalance: 10n ** 18n, debt: 0n },
      ]
    );
  }
  async simulate(call: AtomicExitForCall): Promise<{ gas: bigint; data: `0x${string}` }> {
    this.simulateCalls.push(call);
    if (this.o.simulateThrows) throw new Error(this.o.simulateThrows);
    return { gas: this.o.gas ?? 500_000n, data: "0xdeadbeef" };
  }
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n };
  }
  async receipt(): Promise<RelayerReceipt | null> {
    return this.o.receipt ?? null;
  }
  async waitForReceipt(): Promise<RelayerReceipt | null> {
    return this.o.receipt === undefined
      ? { status: "success", gasUsed: 400_000n, effectiveGasPrice: 1_000_000n, blockNumber: 1n }
      : this.o.receipt;
  }
}

/**
 * What a scripted endpoint recorded: the viem args the pinned operation built,
 * not the RelayerTxRequest it was built from.
 */
interface SentTx {
  to: `0x${string}`;
  data: `0x${string}`;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  value: bigint;
}

interface FakeEndpointOptions {
  /** What eth_chainId answers. A mismatch is how a wrong-network node looks. */
  chainId?: number;
  /** What eth_getTransactionCount(pending) answers on THIS node. */
  nonce?: number;
  balance?: bigint;
  /** Set to make the health probe fail: this node is down. */
  downChainId?: boolean;
  /** Set to make only the nonce read fail, which is what forces a failover. */
  downNonce?: boolean;
  throwOnSend?: string | null;
}

/**
 * One RPC endpoint, scripted.
 *
 * The nonce lives on the ENDPOINT rather than on the signer, because that is
 * the whole point: a pending nonce is a fact about one node's mempool, and two
 * nodes are entitled to disagree. A test that put the nonce on the signer could
 * not express the bug this file now guards against.
 */
class FakeEndpoint implements PinnedEndpointClient {
  readonly sent: SentTx[] = [];
  nonceReads = 0;
  chainIdReads = 0;
  /** Flipped mid-test to take an endpoint down between submissions. */
  down = false;

  constructor(
    readonly url: string,
    private readonly o: FakeEndpointOptions = {},
  ) {}

  async getChainId(): Promise<number> {
    this.chainIdReads += 1;
    if (this.down || this.o.downChainId) throw new Error(`${this.url} unreachable`);
    return this.o.chainId ?? CHAIN_ID;
  }
  async getTransactionCount(): Promise<number> {
    this.nonceReads += 1;
    if (this.o.downNonce) throw new Error(`${this.url} nonce read failed`);
    return this.o.nonce ?? 5;
  }
  async getBalance(): Promise<bigint> {
    return this.o.balance ?? 10n ** 18n;
  }
  async sendTransaction(args: unknown): Promise<`0x${string}`> {
    this.sent.push(args as SentTx);
    if (this.o.throwOnSend) throw new Error(this.o.throwOnSend);
    return ("0x" + String(this.sent.length).padStart(64, "1")) as `0x${string}`;
  }
}

/**
 * A signer over scripted endpoints, using the REAL PinnedEndpointOperation.
 *
 * Not a hand-written stub of the operation: the pinning rules are the thing
 * under test, so every submission in this file goes through them.
 */
class FakeSigner implements RelayerSigner {
  readonly endpoints: FakeEndpoint[];
  constructor(
    readonly label = "fake-0",
    readonly address = "0x00000000000000000000000000000000000000f1" as `0x${string}`,
    readonly chainId = CHAIN_ID,
    private readonly bal = 10n ** 18n,
    throwOnSend: string | null = null,
    nonce = 5,
    endpoints?: FakeEndpoint[],
  ) {
    this.endpoints =
      endpoints ?? [new FakeEndpoint("https://one.test", { chainId, nonce, throwOnSend, balance: bal })];
  }
  async beginOperation(): Promise<SignerOperation> {
    return PinnedEndpointOperation.open(
      this.endpoints.map((e) => e.url),
      this.chainId,
      this.label,
      this.address,
      (url) => this.endpoints.find((e) => e.url === url)!,
    );
  }
  async balance(): Promise<bigint> {
    return this.bal;
  }
  /** Every broadcast this signer made, across every endpoint, in order. */
  get sent(): SentTx[] {
    return this.endpoints.flatMap((e) => e.sent);
  }
}

interface HarnessOptions {
  enabled?: boolean;
  rows?: DelegationRow[];
  chain?: FakeChain;
  signer?: FakeSigner | null;
  limits?: Partial<RelayerLimits>;
  reader?: FakeExitChainReader;
  attempts?: MemoryRelayerAttemptStore;
}

function harness(o: HarnessOptions = {}) {
  const events: RelayerEvent[] = [];
  const signer = o.signer === null ? null : (o.signer ?? new FakeSigner());
  const chain = o.chain ?? new FakeChain();
  const deps: RelayerDeps = {
    chain,
    delegations: {
      store: new FakeDelegationStore(o.rows ?? [row()]),
      chain: o.reader ?? new FakeExitChainReader(),
      chainId: CHAIN_ID,
      executor: EXECUTOR,
      nowSec: NOW_SEC,
    },
    attempts: o.attempts ?? new MemoryRelayerAttemptStore(),
    pool: signer ? new RelayerSignerPool([signer]) : null,
    limits: { ...DEFAULT_RELAYER_LIMITS, ...o.limits },
    hourly: new SubmissionRateWindow(),
    emit: (e) => events.push(e),
    enabled: o.enabled ?? true,
    executor: EXECUTOR,
    expectedChainId: CHAIN_ID,
    nowMs: () => NOW_MS,
  };
  return { deps, events, signer, chain };
}

/** HF 1.2 is below the signed 1.5 trigger, so the trigger has fired. */
const candidate: RelayerCandidate = { wallet: USER, protocol: "aave_v3", healthFactor: 1.2 };

const reasons = (events: RelayerEvent[]) =>
  events.filter((e) => e.type === "relayer.skipped").map((e) => (e as { reason: string }).reason);

// ── pure policy ──────────────────────────────────────────────────────────────

describe("kill switch", () => {
  it("is OFF by default and for anything that is not an explicit yes", () => {
    for (const v of [undefined, "", " ", "false", "0", "no", "off", "TRUE_ISH", "enabled"]) {
      expect(relayerEnabled(v === undefined ? {} : { RELAYER_ENABLED: v })).toBe(false);
    }
  });

  it("is ON only for true / 1 / yes, case-insensitively", () => {
    for (const v of ["true", "TRUE", "1", "yes", "Yes", " true "]) {
      expect(relayerEnabled({ RELAYER_ENABLED: v })).toBe(true);
    }
  });
});

describe("chain guard", () => {
  it("passes only on an exact match", () => {
    expect(chainGuardOk(84532, 84532)).toBe(true);
    expect(chainGuardOk(8453, 84532)).toBe(false);
    expect(chainGuardOk(1, 84532)).toBe(false);
    expect(chainGuardOk(Number.NaN, 84532)).toBe(false);
  });
});

describe("sequencer staleness", () => {
  it("tolerates ordinary block jitter and flags a stopped chain", () => {
    expect(sequencerStale(NOW_SEC - 4, NOW_SEC, 120)).toBe(false);
    expect(sequencerStale(NOW_SEC - 120, NOW_SEC, 120)).toBe(false);
    expect(sequencerStale(NOW_SEC - 121, NOW_SEC, 120)).toBe(true);
    expect(sequencerStale(NOW_SEC - 7_200, NOW_SEC, 120)).toBe(true);
  });
});

describe("trigger evaluation", () => {
  it("fires only strictly below the signed trigger", () => {
    const p = permit({ triggerHealthFactorWad: hfToWad(1.5) });
    expect(triggerFired(p, 1.49)).toBe(true);
    expect(triggerFired(p, 1.5)).toBe(false);
    expect(triggerFired(p, 1.51)).toBe(false);
  });

  it("never fires on an unknown or nonsensical health factor", () => {
    const p = permit();
    expect(triggerFired(p, null)).toBe(false);
    expect(triggerFired(p, Number.NaN)).toBe(false);
    expect(triggerFired(p, Number.POSITIVE_INFINITY)).toBe(false);
    expect(triggerFired(p, 0)).toBe(false);
    expect(triggerFired(p, -1)).toBe(false);
  });

  it("treats a zero trigger as an execute-now permit, as the contract does", () => {
    const p = permit({ triggerHealthFactorWad: 0n });
    expect(triggerFired(p, null)).toBe(true);
    expect(triggerFired(p, 99)).toBe(true);
  });

  it("reads the protocol mask the same way the contract does", () => {
    expect(permitCoversProtocol(permit({ protocolsMask: 0b0001 }), "aave_v3")).toBe(true);
    expect(permitCoversProtocol(permit({ protocolsMask: 0b0001 }), "moonwell")).toBe(false);
    expect(permitCoversProtocol(permit({ protocolsMask: 0b1111 }), "morpho")).toBe(true);
  });
});

describe("replacement fee bump", () => {
  it("always clears the node's 10% replacement floor, rounding up", () => {
    expect(bumpFee(100n)).toBe(110n);
    expect(bumpFee(1n)).toBe(2n); // 1.1 rounds UP; a floor here never replaces
    expect(bumpFee(7n)).toBe(8n);
    for (const v of [1n, 7n, 100n, 1_000_000_007n]) {
      expect(bumpFee(v) * 100n).toBeGreaterThanOrEqual(v * 110n);
    }
  });
});

// ── the loop ─────────────────────────────────────────────────────────────────

describe("kill switch, end to end", () => {
  it("evaluates and simulates but NEVER submits while disarmed", async () => {
    const { deps, events, signer, chain } = harness({ enabled: false });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(0);
    expect(report.dryRun).toBe(true);
    expect(signer!.sent).toHaveLength(0);
    // The rehearsal is real: the simulation ran, so a dry run proves the
    // contract WOULD have accepted the transaction.
    expect(chain.simulateCalls).toHaveLength(1);
    const would = events.find((e) => e.type === "relayer.would-submit");
    expect(would).toBeDefined();
    expect((would as { gas: string }).gas).toBe("500000");
  });
});

describe("chain guard, end to end", () => {
  it("submits nothing when the connected chain is not the executor's", async () => {
    const chain = new FakeChain({ chainId: 8453 });
    const { deps, events, signer } = harness({ chain });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(chain.simulateCalls).toHaveLength(0);
    expect(reasons(events)).toContain("chain_mismatch");
  });
});

describe("permit liveness", () => {
  it("skips a REVOKED permit (epoch moved on-chain)", async () => {
    const { deps, events, signer } = harness({
      rows: [row(permit({ epoch: 1n }))],
      reader: new FakeExitChainReader(9n), // chain epoch 9 != signed 1
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("no_live_permit");
  });

  it("skips an EXPIRED permit", async () => {
    const { deps, events, signer } = harness({
      rows: [row(permit({ deadline: BigInt(NOW_SEC - 1) }))],
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("no_live_permit");
  });

  it("skips an ALREADY-USED nonce", async () => {
    // Live-query reconciliation and the relayer's own pre-submit read both see
    // it; either alone must be enough.
    const { deps, events, signer } = harness({
      chain: new FakeChain({ usedNonces: new Set(["7"]) }),
      reader: new FakeExitChainReader(0n, new Set(["7"])),
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events).some((r) => r === "nonce_spent" || r === "no_live_permit")).toBe(true);
  });

  it("skips a nonce spent AFTER the live query but before submission", async () => {
    const { deps, events, signer } = harness({
      chain: new FakeChain({ usedNonces: new Set(["7"]) }),
      reader: new FakeExitChainReader(0n), // live query still says unspent
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("nonce_spent");
  });

  it("skips a wallet with no delegation at all", async () => {
    const { deps, events, signer } = harness({ rows: [] });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("no_live_permit");
  });

  it("skips a permit whose mask does not cover the position's protocol", async () => {
    const { deps, events, signer } = harness({ rows: [row(permit({ protocolsMask: 0b0010 }))] });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("protocol_not_permitted");
  });
});

describe("trigger gating", () => {
  it("does not act on a healthy position", async () => {
    const { deps, events, signer } = harness();
    const report = await runRelayerTick(
      [{ wallet: USER, protocol: "aave_v3", healthFactor: 2.4 }],
      deps,
    );
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("trigger_not_met");
  });

  it("does not act when the health factor is unknown", async () => {
    const { deps, events, signer } = harness();
    const report = await runRelayerTick(
      [{ wallet: USER, protocol: "aave_v3", healthFactor: null }],
      deps,
    );
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("health_factor_unknown");
  });
});

describe("leg building", () => {
  it("skips a position with nothing to do", async () => {
    const { deps, events, signer } = harness({
      chain: new FakeChain({ reserves: [] }),
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("no_legs");
  });

  it("uses the AMOUNT_FULL sentinel and withdraws nothing on a FULL_REPAY", async () => {
    const { deps, chain } = harness();
    await runRelayerTick([candidate], deps);
    const legs = chain.simulateCalls[0]!.legs;
    expect(legs).toHaveLength(1); // only the reserve carrying debt
    expect(legs[0]!.asset).toBe(USDC);
    expect(legs[0]!.repayAmount).toBe(2n ** 256n - 1n);
    expect(legs[0]!.withdrawAmount).toBe(0n);
  });

  it("withdraws collateral only on a FULL_EXIT", async () => {
    const { deps, chain } = harness({ rows: [row(permit({ kind: EXIT_KIND.FULL_EXIT }))] });
    await runRelayerTick([candidate], deps);
    const legs = chain.simulateCalls[0]!.legs;
    expect(legs).toHaveLength(2);
    expect(legs.find((l) => l.asset === WETH)!.withdrawAmount).toBe(2n ** 256n - 1n);
  });

  it("sends the sentinel for a REDUCE too, so the on-chain repay floor is met", async () => {
    // A partial repay computed off a stale read is ALWAYS below the floor the
    // contract recomputes from live debt. The sentinel is capped on-chain by
    // maxRepayFractionBps instead, landing exactly on the authorised figure.
    const { deps, chain } = harness({
      rows: [row(permit({ kind: EXIT_KIND.REDUCE, maxRepayFractionBps: 5_000 }))],
    });
    await runRelayerTick([candidate], deps);
    const legs = chain.simulateCalls[0]!.legs;
    expect(legs[0]!.repayAmount).toBe(2n ** 256n - 1n);
    expect(legs[0]!.withdrawAmount).toBe(0n);
  });
});

describe("simulation", () => {
  it("never submits when the simulation reverts, and logs the reason", async () => {
    const chain = new FakeChain({ simulateThrows: "execution reverted: TriggerNotMet" });
    const { deps, events, signer } = harness({ chain });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    const skip = events.find(
      (e) => e.type === "relayer.skipped" && (e as { reason: string }).reason === "simulation_reverted",
    );
    expect(skip).toBeDefined();
    expect((skip as { detail?: string }).detail).toContain("TriggerNotMet");
  });

  it("refuses a transaction whose simulated gas exceeds the ceiling", async () => {
    const { deps, events, signer } = harness({
      chain: new FakeChain({ gas: 9_000_000n }),
      limits: { maxGasPerTx: 3_000_000n },
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("gas_cap_exceeded");
  });

  it("signs for the SIMULATED gas, never a constant", async () => {
    const { deps, signer } = harness({ chain: new FakeChain({ gas: 812_345n }) });
    await runRelayerTick([candidate], deps);
    expect(signer!.sent[0]!.gas).toBe(812_345n);
  });
});

describe("spend limits", () => {
  it("stops at the per-tick cap", async () => {
    const users = ["a1", "a2", "a3", "a4"].map(
      (s) => `0x${"0".repeat(38)}${s}` as `0x${string}`,
    );
    const rows = users.map((u, i) => row(permit({ user: u, nonce: BigInt(100 + i) })));
    const { deps, events } = harness({ rows, limits: { maxSubmissionsPerTick: 2 } });
    // One signer means one lease at a time, but the pool is released between
    // submissions, so the cap is what binds.
    const report = await runRelayerTick(
      users.map((wallet) => ({ wallet, protocol: "aave_v3" as const, healthFactor: 1.2 })),
      deps,
    );
    expect(report.submitted).toBe(2);
    expect(reasons(events).filter((r) => r === "tick_cap_reached")).toHaveLength(2);
  });

  it("stops at the per-hour cap", async () => {
    const hourly = new SubmissionRateWindow();
    for (let i = 0; i < 20; i++) hourly.record(NOW_MS);
    const { deps, events, signer } = harness({ limits: { maxSubmissionsPerHour: 20 } });
    deps.hourly = hourly;
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("hourly_cap_reached");
  });

  it("expires per-hour records once the window rolls past them", () => {
    const w = new SubmissionRateWindow(1_000);
    w.record(0);
    w.record(500);
    expect(w.count(600)).toBe(2);
    expect(w.count(1_000)).toBe(1);
    expect(w.count(1_500)).toBe(0);
  });

  it("refuses to submit from an underfunded signer", async () => {
    const poor = new FakeSigner("poor", "0x00000000000000000000000000000000000000f2", CHAIN_ID, 1n);
    const { deps, events } = harness({ signer: poor });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(poor.sent).toHaveLength(0);
    expect(reasons(events)).toContain("relayer_balance_low");
    const bal = events.find((e) => e.type === "relayer.balance");
    expect((bal as { low: boolean }).low).toBe(true);
  });

  it("submits nothing with no signer configured, even when armed", async () => {
    const { deps, events } = harness({ signer: null });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(reasons(events)).toContain("no_signer");
  });
});

describe("idempotency", () => {
  it("never submits the same permit twice, even across a fresh tick", async () => {
    const attempts = new MemoryRelayerAttemptStore();
    const first = harness({ attempts });
    expect((await runRelayerTick([candidate], first.deps)).submitted).toBe(1);

    // Same permit, same ledger, a brand new tick and a brand new signer: the
    // durable claim is what stops it, not any in-process memory.
    const second = harness({ attempts });
    const report = await runRelayerTick([candidate], second.deps);
    expect(report.submitted).toBe(0);
    expect(second.signer!.sent).toHaveLength(0);
    expect(reasons(second.events)).toContain("already_submitted");
  });

  it("a crash leaves an in_flight row that blocks a re-fire on restart", async () => {
    const attempts = new MemoryRelayerAttemptStore();
    await attempts.claim(
      { chainId: CHAIN_ID, executor: EXECUTOR, user: USER, nonce: 7n },
      "0x00000000000000000000000000000000000000f1",
      3,
    );
    const { deps, events, signer } = harness({ attempts });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("attempt_in_flight");
  });

  it("stops retrying a permit that has failed its attempt ceiling", async () => {
    const attempts = new MemoryRelayerAttemptStore();
    const key = { chainId: CHAIN_ID, executor: EXECUTOR, user: USER, nonce: 7n };
    for (let i = 0; i < 3; i++) {
      await attempts.claim(key, "0x00000000000000000000000000000000000000f1", 3);
      await attempts.finish(key, { status: "failed" });
    }
    const { deps, events, signer } = harness({ attempts, limits: { maxAttemptsPerPermit: 3 } });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("attempt_limit_reached");
  });
});

describe("receipt verification", () => {
  it("treats a MINED-BUT-REVERTED receipt as a failure, not a success", async () => {
    // viem does not throw on revert: a resolved receipt proves only that the
    // transaction was mined.
    const chain = new FakeChain({
      receipt: { status: "reverted", gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: 2n },
    });
    const { deps, events } = harness({ chain });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(0);
    expect(events.some((e) => e.type === "relayer.succeeded")).toBe(false);
    const failed = events.find((e) => e.type === "relayer.failed");
    expect((failed as { reason: string }).reason).toBe("reverted");
  });

  it("records gas and fee from the receipt on success", async () => {
    const { deps, events } = harness();
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(1);
    const ok = events.find((e) => e.type === "relayer.succeeded") as
      | { gasUsed: string; feeWei: string }
      | undefined;
    expect(ok?.gasUsed).toBe("400000");
    expect(ok?.feeWei).toBe((400_000n * 1_000_000n).toString());
  });
});

describe("stuck transactions", () => {
  it("replaces an unmined transaction with a >=10% fee bump on the same nonce", async () => {
    let calls = 0;
    class Flaky extends FakeChain {
      override async waitForReceipt(): Promise<RelayerReceipt | null> {
        calls += 1;
        return calls === 1
          ? null
          : { status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 3n };
      }
    }
    const { deps, events, signer } = harness({ chain: new Flaky() });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(1);
    expect(signer!.sent).toHaveLength(2);
    expect(signer!.sent[1]!.nonce).toBe(signer!.sent[0]!.nonce); // a replacement, not a new tx
    expect(signer!.sent[1]!.maxFeePerGas * 100n).toBeGreaterThanOrEqual(
      signer!.sent[0]!.maxFeePerGas * 110n,
    );
    expect(events.some((e) => e.type === "relayer.replaced")).toBe(true);
  });

  it("does NOT bump into a stopped sequencer", async () => {
    class Dead extends FakeChain {
      private probes = 0;
      override async latestBlockTimestampSec(): Promise<number> {
        // Healthy for the tick-level gate, stale by the time the tx sticks.
        this.probes += 1;
        return this.probes === 1 ? NOW_SEC - 3 : NOW_SEC - 3_600;
      }
      override async waitForReceipt(): Promise<RelayerReceipt | null> {
        return null;
      }
    }
    const { deps, events, signer } = harness({ chain: new Dead() });
    const report = await runRelayerTick([candidate], deps);

    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(1); // broadcast once, never replaced
    expect(events.some((e) => e.type === "relayer.replaced")).toBe(false);
  });

  it("aborts the whole tick when the chain has stopped producing blocks", async () => {
    const { deps, events, signer } = harness({
      chain: new FakeChain({ blockTsSec: NOW_SEC - 7_200 }),
    });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(signer!.sent).toHaveLength(0);
    expect(reasons(events)).toContain("sequencer_stale");
  });
});

describe("signer pool", () => {
  it("hands each signer its own sequential nonce and never double-leases", async () => {
    const a = new FakeSigner("a", "0x00000000000000000000000000000000000000f1", CHAIN_ID, 10n ** 18n, null, 5);
    const b = new FakeSigner("b", "0x00000000000000000000000000000000000000f2", CHAIN_ID, 10n ** 18n, null, 11);
    const pool = new RelayerSignerPool([a, b]);

    const l1 = (await pool.acquire())!;
    const l2 = (await pool.acquire())!;
    expect(l1.signer.address).not.toBe(l2.signer.address);
    expect(await pool.acquire()).toBeNull(); // both in flight

    l1.release(true);
    const l3 = (await pool.acquire())!;
    expect(l3.signer.address).toBe(l1.signer.address);
    expect(l3.nonce).toBe(l1.nonce + 1); // advanced
    l2.release(false);
    const l4 = (await pool.acquire())!;
    expect(l4.nonce).toBe(l2.nonce); // rewound: it never reached the mempool
  });

  it("rewinds the nonce when the broadcast itself fails, leaving no gap", async () => {
    const boom = new FakeSigner(
      "boom",
      "0x00000000000000000000000000000000000000f3",
      CHAIN_ID,
      10n ** 18n,
      "replacement transaction underpriced",
      42,
    );
    const { deps, events } = harness({ signer: boom });
    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(0);
    expect(events.some((e) => e.type === "relayer.failed")).toBe(true);

    // The next lease reuses 42: a gap here would strand every later transaction.
    const lease = (await deps.pool!.acquire())!;
    expect(lease.nonce).toBe(42);
  });
});

/**
 * Endpoint pinning (the nonce-safety tests).
 *
 * THE FAILURE THESE EXIST FOR. Reads on the executor side go through viem's
 * `fallback()` over the public-first ladder, which routes each call
 * independently. Under that transport a single submission could read
 * `eth_getTransactionCount(pending)` from node B (because node A rate-limited
 * that one call) and broadcast to node A. Two mempools, two different answers:
 * a nonce that is already spent (the transaction is a duplicate and replaces
 * nothing) or one that is too high (every later transaction from that EOA
 * queues behind a gap that never fills). Neither is visible in a log until the
 * relayer has silently stopped protecting anyone.
 *
 * So: one submission, one node. These tests assert that the nonce read and the
 * broadcast land on the SAME endpoint, that failover RE-READS rather than
 * carrying a nonce across, and that no cached sequence from one node is ever
 * handed to another.
 */
describe("endpoint pinning", () => {
  const A = "https://a.test";
  const B = "https://b.test";
  const labelA = endpointLabel(A, 0);
  const labelB = endpointLabel(B, 1);

  const twoEndpointSigner = (a: FakeEndpointOptions, b: FakeEndpointOptions) =>
    new FakeSigner(
      "pinned",
      "0x00000000000000000000000000000000000000f7",
      CHAIN_ID,
      10n ** 18n,
      null,
      0,
      [new FakeEndpoint(A, { chainId: CHAIN_ID, ...a }), new FakeEndpoint(B, { chainId: CHAIN_ID, ...b })],
    );

  it("reads the nonce and broadcasts through the SAME endpoint", async () => {
    const signer = twoEndpointSigner({ nonce: 5 }, { nonce: 99 });
    const [a, b] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const { deps, events } = harness({ signer });

    const report = await runRelayerTick([candidate], deps);
    expect(report.submitted).toBe(1);

    expect(a.nonceReads).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.nonce).toBe(5);
    // The second rung is never touched: no read, no broadcast, no second view.
    expect(b.nonceReads).toBe(0);
    expect(b.sent).toHaveLength(0);

    const attempted = events.find((e) => e.type === "relayer.attempted") as
      | { endpoint: string }
      | undefined;
    expect(attempted?.endpoint).toBe(labelA);
  });

  it("pins the next endpoint when the first is down, nonce and send together", async () => {
    const signer = twoEndpointSigner({ downChainId: true, nonce: 5 }, { nonce: 99 });
    const [a, b] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const { deps, events } = harness({ signer });

    expect((await runRelayerTick([candidate], deps)).submitted).toBe(1);

    expect(a.nonceReads).toBe(0);
    expect(a.sent).toHaveLength(0);
    expect(b.nonceReads).toBe(1);
    expect(b.sent).toHaveLength(1);
    // 99 is B's own pending count. A's 5 never reaches a transaction.
    expect(b.sent[0]!.nonce).toBe(99);
    const attempted = events.find((e) => e.type === "relayer.attempted") as { endpoint: string };
    expect(attempted.endpoint).toBe(labelB);
  });

  it("skips an endpoint answering for the wrong chain", async () => {
    const signer = twoEndpointSigner({ chainId: 1, nonce: 5 }, { nonce: 99 });
    const [a, b] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const lease = (await new RelayerSignerPool([signer]).acquire())!;
    expect(lease.operation.endpoint).toBe(labelB);
    expect(lease.nonce).toBe(99);
    expect(a.nonceReads).toBe(0);
    expect(b.nonceReads).toBe(1);
  });

  it("RE-READS the nonce after failing over, never carrying the dead node's answer", async () => {
    // A is healthy enough to be pinned but cannot answer the nonce read: the
    // one shape where failover happens with an endpoint already chosen.
    const signer = twoEndpointSigner({ downNonce: true, nonce: 5 }, { nonce: 99 });
    const [a, b] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const lease = (await new RelayerSignerPool([signer]).acquire())!;

    expect(a.nonceReads).toBe(1); // tried, failed
    expect(b.nonceReads).toBe(1); // re-read on the new node, not carried over
    expect(lease.operation.endpoint).toBe(labelB);
    expect(lease.nonce).toBe(99);
  });

  it("never hands a cached nonce from one endpoint to a submission on another", async () => {
    const signer = twoEndpointSigner({ nonce: 5 }, { nonce: 99 });
    const [a, b] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const pool = new RelayerSignerPool([signer]);

    const first = (await pool.acquire())!;
    expect(first.operation.endpoint).toBe(labelA);
    expect(first.nonce).toBe(5);
    first.release(true); // the pool now caches 6, stamped as A's

    // A goes down between submissions, so the next one is pinned to B. The
    // cached 6 describes A's mempool and B never agreed to it: reusing it is
    // the duplicate/gap this whole design exists to prevent.
    a.down = true;
    const second = (await pool.acquire())!;
    expect(second.operation.endpoint).toBe(labelB);
    expect(second.nonce).toBe(99);
    expect(second.nonce).not.toBe(6);
    expect(b.nonceReads).toBe(1);
  });

  it("keeps advancing the local sequence while the endpoint does not change", async () => {
    // The re-read is a failover behaviour, not a per-submission cost: polling
    // the node every time would race the relayer's own mempool.
    const signer = twoEndpointSigner({ nonce: 5 }, { nonce: 99 });
    const [a] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const pool = new RelayerSignerPool([signer]);

    const nonces: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const lease = (await pool.acquire())!;
      nonces.push(lease.nonce);
      lease.release(true);
    }
    expect(nonces).toEqual([5, 6, 7]);
    expect(a.nonceReads).toBe(1);
  });

  it("refuses to change endpoint once anything has been broadcast", async () => {
    const signer = twoEndpointSigner({ nonce: 5 }, { nonce: 99 });
    const op = await signer.beginOperation();
    await op.sendTransaction({
      to: EXECUTOR,
      data: "0x",
      gas: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 5,
      chainId: CHAIN_ID,
    });
    // A send that threw may still have reached the mempool, so re-reading the
    // nonce anywhere else could produce a second transaction on nonce 5.
    await expect(op.failover()).rejects.toThrow(/after a broadcast/);
  });

  it("refuses a transaction naming another chain, before it reaches a node", async () => {
    const signer = twoEndpointSigner({ nonce: 5 }, { nonce: 99 });
    const [a] = signer.endpoints as [FakeEndpoint, FakeEndpoint];
    const op = await signer.beginOperation();
    await expect(
      op.sendTransaction({
        to: EXECUTOR,
        data: "0x",
        gas: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        nonce: 5,
        chainId: 1,
      }),
    ).rejects.toThrow(/is on chain 84532/);
    expect(a.sent).toHaveLength(0);
  });

  it("throws, naming every rejection, when no endpoint is healthy", async () => {
    const signer = twoEndpointSigner({ downChainId: true }, { chainId: 1 });
    await expect(signer.beginOperation()).rejects.toThrow(/no healthy endpoint for chain 84532/);
    await expect(signer.beginOperation()).rejects.toThrow(/answers for chain 1/);
  });

  it("never puts a raw endpoint URL in a label an operator could see", () => {
    // The Alchemy rung carries an API key in its path.
    const label = endpointLabel("https://base-sepolia.g.alchemy.com/v2/SECRETKEY", 2);
    expect(label).toBe("2:base-sepolia.g.alchemy.com");
    expect(label).not.toContain("SECRETKEY");
    expect(endpointLabel("not a url", 0)).toBe("0:unparsed");
  });
});

describe("resilience", () => {
  it("one unreadable position does not stop the rest of the tick", async () => {
    const other = "0x00000000000000000000000000000000000000b2" as `0x${string}`;
    class Picky extends FakeChain {
      override async reserveStates(user: `0x${string}`): Promise<ExitReserveState[]> {
        if (user === USER) throw new Error("RPC exploded");
        return super.reserveStates(user);
      }
    }
    const { deps, events } = harness({
      chain: new Picky(),
      rows: [row(permit()), row(permit({ user: other, nonce: 8n }))],
    });
    const report = await runRelayerTick(
      [candidate, { wallet: other, protocol: "aave_v3", healthFactor: 1.2 }],
      deps,
    );
    expect(report.submitted).toBe(1);
    expect(reasons(events)).toContain("evaluation_error");
  });

  it("emits a tick summary carrying the dry-run flag and the chain it saw", async () => {
    const { deps, events } = harness({ enabled: false });
    await runRelayerTick([candidate], deps);
    const tick = events.find((e) => e.type === "relayer.tick") as
      | { dryRun: boolean; chainId: number; candidates: number }
      | undefined;
    expect(tick?.dryRun).toBe(true);
    expect(tick?.chainId).toBe(CHAIN_ID);
    expect(tick?.candidates).toBe(1);
  });

  it("emits only JSON-serialisable events (no bigint leaks into the log drain)", async () => {
    const { deps, events } = harness();
    await runRelayerTick([candidate], deps);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(() => JSON.stringify(e)).not.toThrow();
  });
});
