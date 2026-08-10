/**
 * The coverage sweep (Phase 4.B) — the "believes protected but isn't" detector.
 *
 * These tests are written against the four ways the promise can break while
 * every existing signal still reads green:
 *
 *   1. The user revokes a token approval. The permit stays perfectly live —
 *      unspent nonce, matching epoch, deadline in the future — and the exit
 *      would revert on the first transferFrom.
 *   2. The signer installs an EIP-7702 delegate after granting (Issue #41).
 *      Same permit, same signature, and the executor now takes its ERC-1271
 *      branch and refuses it.
 *   3. The permit runs out of time while the position is at risk.
 *   4. The sweep cannot check something. This one is a test about HONESTY:
 *      an unconfigured market must produce "unverified", never silence.
 */

import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import {
  EXPIRY_THRESHOLDS,
  authorizedRepay,
  expiryRung,
  sweepWallet,
  type CoverageChain,
  type CoverageMarkets,
  type SweepDeps,
  type SweepTarget,
} from "./coverageSweep";
import { EXIT_KIND, type ExitPermit } from "./exitPermit";
import type {
  DelegationRow,
  DelegationStatus,
  DelegationStore,
} from "./exitDelegationStore";
import type { ExitChainReader, TxReceiptInfo } from "./exitChain";
import type { ExitReserveState } from "../src/panik-core/lib/exitLegs";

const CHAIN_ID = 84532;
const EXECUTOR = "0x554530e0a5c428bd7f617f875a3c5570803842e4" as `0x${string}`;
const USER = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as `0x${string}`;
const AUSDC = "0x00000000000000000000000000000000000000aa" as `0x${string}`;
const COMET = "0x00000000000000000000000000000000000000c1" as `0x${string}`;
const COMPOUND_ADAPTER = "0x00000000000000000000000000000000000000c2" as `0x${string}`;
const MORPHO = "0x00000000000000000000000000000000000000d1" as `0x${string}`;
const MORPHO_ADAPTER = "0x00000000000000000000000000000000000000d2" as `0x${string}`;
const SIG = ("0x" + "ab".repeat(65)) as `0x${string}`;

const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1_000;
const DAY = 86_400;

/** Some non-empty runtime code, and its hash, without a key-shaped literal. */
const DELEGATE_CODE = toHex("delegate-runtime-code") as `0x${string}`;
const DELEGATE_HASH = keccak256(DELEGATE_CODE);
const OTHER_CODE = toHex("a-different-delegate") as `0x${string}`;

function permit(over: Partial<ExitPermit> = {}): ExitPermit {
  return {
    user: USER,
    kind: EXIT_KIND.FULL_EXIT,
    maxRepayFractionBps: 10_000,
    triggerHealthFactorWad: 0n,
    maxSlippageBps: 100,
    protocolsMask: 0b1111,
    epoch: 0n,
    nonce: 7n,
    deadline: BigInt(NOW_SEC + 30 * DAY),
    ...over,
  };
}

function row(over: Partial<DelegationRow> = {}, p: ExitPermit = permit()): DelegationRow {
  return {
    id: `row-${p.nonce}`,
    createdAt: NOW_MS,
    permit: p,
    signature: SIG,
    status: "active",
    chainId: CHAIN_ID,
    executor: EXECUTOR,
    revocationTx: null,
    signerHadCode: false,
    signerCodeHash: null,
    ...over,
  };
}

class FakeStore implements DelegationStore {
  constructor(public rows: DelegationRow[] = []) {}
  async insert(): Promise<boolean> {
    return true;
  }
  async listActive(): Promise<DelegationRow[]> {
    return this.rows.filter((r) => r.status === "active");
  }
  async setStatus(id: string, status: DelegationStatus): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = status;
  }
}

class FakeExitChain implements ExitChainReader {
  epoch = 0n;
  used = new Set<string>();
  async revocationEpoch(): Promise<bigint> {
    return this.epoch;
  }
  async isNonceUsed(_u: `0x${string}`, n: bigint): Promise<boolean> {
    return this.used.has(n.toString());
  }
  async maxPermitSlippageBps(): Promise<number> {
    return 1_000;
  }
  async receiptFor(): Promise<TxReceiptInfo | null> {
    return null;
  }
  async codeAt(): Promise<`0x${string}`> {
    return "0x";
  }
  async isValidSignature(): Promise<`0x${string}` | null> {
    return null;
  }
}

class FakeCoverageChain implements CoverageChain {
  code: `0x${string}` = "0x";
  allowances = new Map<string, bigint>();
  reserves: ExitReserveState[] = [];
  aTokens = new Map<string, `0x${string}` | null>([[USDC.toLowerCase(), AUSDC]]);
  cometAllow = true;
  morphoAuth = true;
  /** Set to throw from reserveStates, to prove a read failure is not a pass. */
  reserveError: string | null = null;

  async codeAt(): Promise<`0x${string}`> {
    return this.code;
  }
  async allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
    return this.allowances.get(`${token}:${owner}:${spender}`.toLowerCase()) ?? 0n;
  }
  async aTokenFor(reserve: `0x${string}`): Promise<`0x${string}` | null> {
    return this.aTokens.get(reserve.toLowerCase()) ?? null;
  }
  async reserveStates(): Promise<ExitReserveState[]> {
    if (this.reserveError) throw new Error(this.reserveError);
    return this.reserves;
  }
  async cometAllowed(): Promise<boolean> {
    return this.cometAllow;
  }
  async morphoAuthorized(): Promise<boolean> {
    return this.morphoAuth;
  }

  approve(token: `0x${string}`, amount: bigint): void {
    this.allowances.set(`${token}:${USER}:${EXECUTOR}`.toLowerCase(), amount);
  }
}

function markets(over: Partial<CoverageMarkets> = {}): CoverageMarkets {
  return {
    aaveReserves: [USDC],
    comets: [COMET],
    compoundAdapter: COMPOUND_ADAPTER,
    morpho: MORPHO,
    morphoAdapter: MORPHO_ADAPTER,
    mTokens: [],
    ...over,
  };
}

function deps(
  store: FakeStore,
  chain: FakeCoverageChain,
  over: Partial<SweepDeps> = {},
): SweepDeps {
  return {
    delegations: {
      store,
      chain: new FakeExitChain(),
      chainId: CHAIN_ID,
      executor: EXECUTOR,
      nowSec: NOW_SEC,
    },
    chain,
    markets: markets(),
    executor: EXECUTOR,
    nowSec: NOW_SEC,
    nowMs: NOW_MS,
    ...over,
  };
}

const target = (over: Partial<SweepTarget> = {}): SweepTarget => ({
  wallet: USER,
  protocols: ["aave_v3"],
  atRisk: false,
  ...over,
});

/** A fully covered Aave position: debt approved, collateral approved. */
function healthyAave(chain: FakeCoverageChain): void {
  chain.reserves = [
    { reserve: USDC, symbol: "USDC", decimals: 6, aBalance: 1_000_000n, debt: 500_000n },
  ];
  chain.approve(USDC, 500_000n);
  chain.approve(AUSDC, 1_000_000n);
}

describe("authorizedRepay", () => {
  it("mirrors the contract's _capRepay in BigInt", () => {
    expect(authorizedRepay(1_000n, 10_000)).toBe(1_000n);
    expect(authorizedRepay(1_000n, 5_000)).toBe(500n);
    // Truncating division, exactly as Solidity's mulDiv does: 7 * 3333 / 10000
    // is 2.3331, and the contract will pull 2.
    expect(authorizedRepay(7n, 3_333)).toBe(2n);
    expect(authorizedRepay(1n, 3_333)).toBe(0n);
  });
});

describe("expiryRung", () => {
  it("returns the tightest threshold the permit has crossed", () => {
    expect(expiryRung(8 * DAY)).toBeNull();
    expect(expiryRung(6 * DAY)?.label).toBe("7d");
    expect(expiryRung(40 * 3_600)?.label).toBe("48h");
    expect(expiryRung(6 * 3_600)?.label).toBe("12h");
  });

  it("returns nothing once the permit has already expired", () => {
    // An expired permit is not "expiring"; it gets the expiry alert instead.
    expect(expiryRung(0)).toBeNull();
    expect(expiryRung(-100)).toBeNull();
  });

  it("covers the thresholds the escalation ladder documents", () => {
    expect(EXPIRY_THRESHOLDS.map((t) => t.label)).toEqual(["12h", "48h", "7d"]);
  });
});

describe("coverage sweep — a revoked approval", () => {
  it("stays silent when every authorization is in place", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    const out = await sweepWallet(target(), deps(new FakeStore([row()]), chain));
    expect(out.gaps).toEqual([]);
    expect(out.alerts).toEqual([]);
    expect(out.live).toBe(1);
  });

  it("CATCHES a revoked debt-asset approval on a live permit", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.approve(USDC, 0n); // the user revoked it from their wallet UI

    const out = await sweepWallet(target(), deps(new FakeStore([row()]), chain));
    expect(out.live).toBe(1); // the permit itself is perfectly live
    expect(out.gaps.map((g) => g.kind)).toContain("repay_allowance_missing");
    const alert = out.alerts.find((a) => a.kind === "coverage.gap");
    expect(alert).toBeDefined();
    expect(alert!.summary).toContain("would NOT execute");
    expect(alert!.userMessage).toBeTruthy();
  });

  it("CATCHES a revoked aToken approval for a full exit", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.approve(AUSDC, 0n);
    const out = await sweepWallet(target(), deps(new FakeStore([row()]), chain));
    expect(out.gaps.map((g) => g.kind)).toContain("collateral_allowance_missing");
  });

  it("does not demand a collateral approval a FULL_REPAY permit never uses", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.approve(AUSDC, 0n);
    const store = new FakeStore([row({}, permit({ kind: EXIT_KIND.FULL_REPAY }))]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.gaps).toEqual([]);
  });

  it("sizes the required repay by the permit's own fraction", async () => {
    const chain = new FakeCoverageChain();
    chain.reserves = [{ reserve: USDC, symbol: "USDC", decimals: 6, aBalance: 0n, debt: 1_000n }];
    // A 50% REDUCE permit only ever pulls 500, so 500 of allowance is enough.
    chain.approve(USDC, 500n);
    const store = new FakeStore([
      row({}, permit({ kind: EXIT_KIND.REDUCE, maxRepayFractionBps: 5_000 })),
    ]);
    expect((await sweepWallet(target(), deps(store, chain))).gaps).toEqual([]);
  });

  it("escalates a gap to critical when the position is already at risk", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.approve(USDC, 0n);
    const out = await sweepWallet(target({ atRisk: true }), deps(new FakeStore([row()]), chain));
    expect(out.alerts.find((a) => a.kind === "coverage.gap")!.severity).toBe("critical");
  });

  it("catches a Comet authorization the user turned off", async () => {
    const chain = new FakeCoverageChain();
    chain.cometAllow = false;
    const out = await sweepWallet(
      target({ protocols: ["compound_v3"] }),
      deps(new FakeStore([row()]), chain),
    );
    expect(out.gaps.map((g) => g.kind)).toEqual(["comet_not_authorized"]);
  });

  it("catches a Morpho authorization the user turned off", async () => {
    const chain = new FakeCoverageChain();
    chain.morphoAuth = false;
    const out = await sweepWallet(
      target({ protocols: ["morpho"] }),
      deps(new FakeStore([row()]), chain),
    );
    expect(out.gaps.map((g) => g.kind)).toEqual(["morpho_not_authorized"]);
  });

  it("ignores a protocol the permit's mask does not cover", async () => {
    const chain = new FakeCoverageChain();
    chain.morphoAuth = false;
    // Mask covers AAVE_V3 only.
    const store = new FakeStore([row({}, permit({ protocolsMask: 0b0001 }))]);
    const out = await sweepWallet(target({ protocols: ["morpho"] }), deps(store, chain));
    expect(out.gaps).toEqual([]);
  });
});

describe("coverage sweep — EIP-7702 (Issue #41, layer 3)", () => {
  it("CATCHES a signer that gained code after signing", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.code = DELEGATE_CODE; // installed after the grant

    const out = await sweepWallet(target(), deps(new FakeStore([row()]), chain));
    expect(out.gaps.map((g) => g.kind)).toContain("signer_gained_code");
    const alert = out.alerts.find((a) => a.kind === "coverage.signer_gained_code");
    expect(alert?.severity).toBe("critical");
    expect(alert?.summary).toContain("ERC-1271");
    expect(alert?.userMessage).toBeTruthy();
  });

  it("stays silent for a smart account whose code has not changed", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.code = DELEGATE_CODE;
    const store = new FakeStore([row({ signerHadCode: true, signerCodeHash: DELEGATE_HASH })]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.gaps).toEqual([]);
  });

  it("CATCHES a smart account re-delegated to different code", async () => {
    // A boolean cannot see this; the code hash can. A new implementation may
    // reject the very signature the old one accepted.
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.code = OTHER_CODE;
    const store = new FakeStore([row({ signerHadCode: true, signerCodeHash: DELEGATE_HASH })]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.gaps.map((g) => g.kind)).toContain("signer_code_changed");
  });

  it("reports a missing baseline as UNVERIFIABLE, not as fine", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    chain.code = DELEGATE_CODE;
    // A row from before the baseline column existed.
    const store = new FakeStore([row({ signerHadCode: null, signerCodeHash: null })]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.gaps).toEqual([]);
    expect(out.unknowns).toHaveLength(1);
    expect(out.alerts.some((a) => a.kind === "coverage.unverifiable")).toBe(true);
  });
});

describe("coverage sweep — expiry escalation", () => {
  const rungs: [number, string, string][] = [
    [6 * DAY, "7d", "info"],
    [40 * 3_600, "48h", "warning"],
    [6 * 3_600, "12h", "critical"],
  ];

  for (const [secondsLeft, label, severity] of rungs) {
    it(`fires the ${label} rung exactly once, at ${severity}`, async () => {
      const chain = new FakeCoverageChain();
      healthyAave(chain);
      const store = new FakeStore([row({}, permit({ deadline: BigInt(NOW_SEC + secondsLeft) }))]);
      const out = await sweepWallet(target(), deps(store, chain));
      const expiring = out.alerts.filter((a) => a.kind === "coverage.expiring");
      expect(expiring).toHaveLength(1);
      expect(expiring[0]!.severity).toBe(severity);
      // The rung is in the KEY, which is what makes the once-only gate mean
      // "once per threshold" rather than "once ever".
      expect(expiring[0]!.key).toBe(`coverage.expiring:row-7:${label}`);
      expect(expiring[0]!.userMessage).toContain("expires in about");
    });
  }

  it("says nothing about a permit that is nowhere near expiry", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    const store = new FakeStore([row({}, permit({ deadline: BigInt(NOW_SEC + 30 * DAY) }))]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.alerts.filter((a) => a.kind === "coverage.expiring")).toEqual([]);
  });

  it("pages when a permit expired and the position is at risk", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    const store = new FakeStore([row({}, permit({ deadline: BigInt(NOW_SEC - 1) }))]);
    const out = await sweepWallet(target({ atRisk: true }), deps(store, chain));
    const alert = out.alerts.find((a) => a.kind === "coverage.expired_at_risk");
    expect(alert?.severity).toBe("critical");
    expect(out.live).toBe(0);
  });

  it("downgrades an expired permit on a healthy position to a warning", async () => {
    const chain = new FakeCoverageChain();
    healthyAave(chain);
    const store = new FakeStore([row({}, permit({ deadline: BigInt(NOW_SEC - 1) }))]);
    const out = await sweepWallet(target(), deps(store, chain));
    expect(out.alerts.find((a) => a.kind === "coverage.expired")?.severity).toBe("warning");
  });
});

describe("coverage sweep — unknown is never fine", () => {
  it("reports an unconfigured Comet market as unverifiable", async () => {
    const chain = new FakeCoverageChain();
    const out = await sweepWallet(
      target({ protocols: ["compound_v3"] }),
      deps(new FakeStore([row()]), chain, { markets: markets({ comets: [] }) }),
    );
    expect(out.gaps).toEqual([]);
    expect(out.unknowns).toHaveLength(1);
    expect(out.alerts[0]!.kind).toBe("coverage.unverifiable");
    expect(out.alerts[0]!.summary).toContain("UNVERIFIED");
  });

  it("reports an unconfigured Morpho singleton as unverifiable", async () => {
    const out = await sweepWallet(
      target({ protocols: ["morpho"] }),
      deps(new FakeStore([row()]), new FakeCoverageChain(), {
        markets: markets({ morpho: null }),
      }),
    );
    expect(out.alerts[0]!.kind).toBe("coverage.unverifiable");
  });

  it("turns a failed on-chain read into an alert, never into an all-clear", async () => {
    const chain = new FakeCoverageChain();
    chain.reserveError = "rpc timeout";
    const out = await sweepWallet(target(), deps(new FakeStore([row()]), chain));
    expect(out.unknowns[0]!.reason).toContain("rpc timeout");
    expect(out.alerts.some((a) => a.kind === "coverage.unverifiable")).toBe(true);
  });

  it("says nothing about a wallet with no delegation at all", async () => {
    // "Never set up protection" is not a broken promise; it is no promise.
    const out = await sweepWallet(target(), deps(new FakeStore([]), new FakeCoverageChain()));
    expect(out.alerts).toEqual([]);
    expect(out.claimedActive).toBe(0);
  });
});
