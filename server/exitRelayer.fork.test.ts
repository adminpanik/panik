/**
 * Relayer INTEGRATION test (Phase 4.A) — the acceptance gate.
 *
 * Unit tests with mocks prove the relayer refuses correctly. They cannot prove
 * it SUBMITS correctly, because a fake chain agrees with whatever the code
 * believes about the contract. This file closes that gap with a real
 * transaction:
 *
 *   - a real fork of Base Sepolia, pinned to a block, run by anvil,
 *   - the REAL deployed PanikExecutor v2 at 0x554530E0…42E4 (not a redeploy,
 *     not a mock — the bytecode currently live on Sepolia),
 *   - the REAL Aave V3 Base Sepolia market: the test wallet actually supplies
 *     cbETH and actually borrows USDC, so the debt being repaid is debt the pool
 *     itself issued,
 *   - a REAL ExitPermit signed by the position owner's key through
 *     server/exitPermit.ts — byte-for-byte the EIP-712 the UI produces, checked
 *     by running the backend's own verifyPermitSignature over it,
 *   - the REAL relayer submit path: runRelayerTick -> ViemRelayerChain.simulate
 *     -> LocalKeyRelayerSigner.sendTransaction -> receipt verification.
 *
 * The assertion is not "a promise resolved". It is `status === "success"` on the
 * receipt AND the Aave debt actually gone AND the permit nonce actually spent.
 *
 * WHY A FULL_REPAY PERMIT. A FULL_EXIT additionally withdraws collateral and
 * swaps it to USDC through Uniswap, and Base Sepolia pools are thin enough that
 * the swap's minOut floor is a coin flip unrelated to the relayer. FULL_REPAY
 * exercises every part of the delegated path this phase owns — permit
 * consumption, scope validation, the live-health trigger gate, the wallet-funded
 * repay, the per-leg repay floor — with `withdrawAmount = 0`, which means no
 * collateral moves and no swap happens at all. The swap path is already covered
 * by executor/test/fork/mainnet.fork.spec.ts against deep mainnet liquidity.
 *
 * OPT-IN. Skipped unless RELAYER_FORK_RPC is set, so the default `npm test` stays
 * offline and deterministic. Run it with:
 *
 *   RELAYER_FORK_RPC=https://base-sepolia.g.alchemy.com/v2/<key> npx vitest run \
 *     server/exitRelayer.fork.test.ts
 *
 * Requires `anvil` on PATH (Foundry). NOTHING here touches a live network: every
 * transaction goes to the local fork.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEther,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  EXIT_KIND,
  exitDomain,
  hfToWad,
  validatePermitScope,
  verifyPermitSignature,
  EXIT_PERMIT_TYPES,
  type ExitPermit,
} from "./exitPermit";
import { ViemExitChainReader } from "./exitChain";
import { ViemRelayerChain } from "./relayerChain";
import { LocalKeyRelayerSigner, RelayerSignerPool } from "./relayerSigner";
import { MemoryRelayerAttemptStore } from "./relayerAttemptStore";
import {
  DEFAULT_RELAYER_LIMITS,
  SubmissionRateWindow,
  type RelayerEvent,
} from "./relayerPolicy";
import { runRelayerTick, type RelayerCandidate, type RelayerDeps } from "./exitRelayer";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import type { DelegationRow, DelegationStatus, DelegationStore } from "./exitDelegationStore";

const FORK_RPC = process.env.RELAYER_FORK_RPC;
const PORT = Number(process.env.RELAYER_FORK_PORT ?? 8546);
const NODE_URL = `http://127.0.0.1:${PORT}`;

/** Pinned so a rerun forks identical state. Override with RELAYER_FORK_BLOCK. */
const FORK_BLOCK = process.env.RELAYER_FORK_BLOCK ?? "45270000";

// Base Sepolia, from executor/deploy/onchain-config.json (the deployed config).
const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as `0x${string}`;
const DATA_PROVIDER = "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b" as `0x${string}`;
/** The Aave market's own testnet USDC (6dp) — a TRACKED asset on the executor. */
const AAVE_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as `0x${string}`;
/**
 * Collateral. cbETH rather than WETH, and the reason is worth recording: the
 * Base Sepolia WETH reserve sits within a whisker of its 1000-token supply cap
 * (`SupplyCapExceeded`, selector 0xf58f733a, on a 0.1 WETH supply at the pinned
 * block), so seeding a WETH position on this fork is not reliably possible.
 * cbETH has no supply cap, is borrow-enabled, and is on the executor's tracked
 * asset list, so it seeds a real position without touching protocol config.
 */
const CBETH = "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B" as `0x${string}`;

/**
 * Test keys. Deliberately NOT anvil's well-known dev accounts, and the reason
 * is a real property of the deployed contract worth recording:
 *
 * PanikExecutor._isValidSignature branches on `signer.code.length`. Zero means
 * ECDSA; anything else means the address is treated as an ERC-1271 contract
 * signer. On Base Sepolia every one of anvil's default accounts carries an
 * EIP-7702 delegation designator (`0xef0100…`, 23 bytes of code), because those
 * keys are public and someone has delegated them. So the executor takes the
 * ERC-1271 path for them and rejects a perfectly valid ECDSA permit with
 * `InvalidSignature()`.
 *
 * These two keys hold no code on the fork (asserted in beforeAll). They are
 * throwaway test keys with no value on any network, funded here via
 * anvil_setBalance.
 *
 * DERIVED, NEVER WRITTEN DOWN. The key is the keccak256 of a plain English
 * label, so what appears in this file is a sentence rather than a 64-hex
 * literal. Two reasons, and the second is the one that matters:
 *   - a reader can see at a glance that no real key is involved, because the
 *     whole secret is the string "panik-fork-test-user";
 *   - the repo's gitleaks scan flags any 64-hex private-key literal, and the
 *     right response to that is to stop writing keys in source, not to add an
 *     allowlist entry. An allowlist would be a hole the next REAL key fits
 *     through.
 * Deterministic, so a rerun forks identical accounts.
 */
const keyFromLabel = (label: string): `0x${string}` => keccak256(toHex(label));

const user = privateKeyToAccount(keyFromLabel("panik-fork-test-user"));
const relayer = privateKeyToAccount(keyFromLabel("panik-fork-test-relayer"));

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const POOL_ABI = [
  { type: "function", name: "supply", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint16" }], outputs: [] },
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint16" }, { type: "address" }], outputs: [] },
  {
    type: "function", name: "getUserAccountData", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" }, { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" }, { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" }, { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

const DP_ABI = [
  {
    type: "function", name: "getUserReserveData", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [
      { name: "currentATokenBalance", type: "uint256" }, { name: "currentStableDebt", type: "uint256" },
      { name: "currentVariableDebt", type: "uint256" }, { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" }, { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" }, { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
  },
] as const;

const REVOKE_ABI = [
  { type: "function", name: "revokeAll", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

let anvil: ChildProcess | null = null;

const pub = createPublicClient({ chain: baseSepolia, transport: http(NODE_URL) });
const userWallet = createWalletClient({ account: user, chain: baseSepolia, transport: http(NODE_URL) });

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(NODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function startAnvil(): Promise<void> {
  // A node already listening here is almost certainly a leftover from an
  // interrupted run, and silently reusing it means testing against unknown
  // state — which produces confusing reverts in setup rather than a clear
  // failure. Refuse instead.
  const stale = await pub.getBlockNumber().then(
    () => true,
    () => false,
  );
  if (stale) {
    throw new Error(
      `something is already listening on ${NODE_URL}; kill it (or set RELAYER_FORK_PORT) ` +
        `so this test forks known state`,
    );
  }

  anvil = spawn(
    "anvil",
    [
      "--fork-url", FORK_RPC!,
      "--fork-block-number", FORK_BLOCK,
      // The EIP-712 domain pins 84532, and the contract computes its separator
      // from block.chainid. A fork reporting anything else makes every recovered
      // signer wrong, which would look like a signature bug rather than config.
      "--chain-id", String(EXIT_CHAIN_ID),
      "--port", String(PORT),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  anvil.stderr?.on("data", (c) => (stderr += String(c)));

  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await pub.getBlockNumber();
      // Move the fork's clock to NOW before anything else runs.
      //
      // A fork pinned to a past block inherits that block's timestamp, so its
      // "latest block" is hours old by wall clock — and the relayer's
      // sequencer-staleness guard reads exactly that signal and (correctly)
      // refuses to submit into what looks like a stopped chain. Without this
      // line every case below fails with `sequencer_stale`, which is the guard
      // working, not the relayer breaking. Re-anchoring the clock is also what
      // makes the fork resemble a live chain, which is the point of the test.
      await rpc("anvil_setTime", [Math.floor(Date.now() / 1000)]);
      await rpc("evm_mine", []);
      return;
    } catch {
      if (anvil.exitCode !== null) throw new Error(`anvil exited: ${stderr.slice(0, 400)}`);
      if (Date.now() > deadline) throw new Error(`anvil did not start: ${stderr.slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

const balanceOf = (token: `0x${string}`, who: `0x${string}`) =>
  pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/**
 * Credit an ERC20 balance by writing the mapping slot directly.
 *
 * The slot index is DISCOVERED, not assumed: each candidate is written and then
 * verified through `balanceOf`, and reverted when it was the wrong one. Aave's
 * testnet tokens are only mintable by their faucet, and the alternative
 * (borrowing extra to cover interest) changes the debt this test is measuring.
 */
async function dealErc20(token: `0x${string}`, who: `0x${string}`, amount: bigint): Promise<void> {
  const zero = toHex(0n, { size: 32 });
  for (let slot = 0; slot < 40; slot++) {
    const key = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, BigInt(slot)]),
    );
    const before = ((await rpc("eth_getStorageAt", [token, key, "latest"])) as string) ?? zero;
    await rpc("anvil_setStorageAt", [token, key, toHex(amount, { size: 32 })]);
    if ((await balanceOf(token, who)) === amount) return;
    await rpc("anvil_setStorageAt", [token, key, before]);
  }
  throw new Error(`could not locate the balance slot for ${token}`);
}

/**
 * Explicit gas for the SETUP transactions.
 *
 * viem signs for whatever `eth_estimateGas` returns, and that figure can be a
 * notch short for a deeply nested call because of EIP-150's 63/64 rule — the
 * Aave borrow here fails with `out of gas` at depth 2 on an exact estimate. The
 * relayer solves this properly, with a documented buffer in
 * ViemRelayerChain.simulate; the setup just needs to not be the thing under
 * test, so it asks for a flat generous limit. Unused gas is refunded.
 */
const SETUP_GAS = { gas: 3_000_000n } as const;

async function send(hash: `0x${string}`): Promise<void> {
  const r = await pub.waitForTransactionReceipt({ hash });
  // Setup is not exempt from the rule the relayer lives by: viem resolves a
  // reverted receipt, so an unchecked setup tx silently produces a broken test.
  if (r.status === "success") return;
  // Replay the exact call at the block it failed in, so the failure names the
  // contract's own revert instead of just a hash.
  let why = "";
  try {
    const tx = await pub.getTransaction({ hash });
    await pub.call({
      to: tx.to ?? undefined,
      data: tx.input,
      account: tx.from,
      value: tx.value,
      blockNumber: r.blockNumber - 1n,
    });
  } catch (err) {
    why = ` (${(err as Error).message.split("\n")[0]})`;
  }
  throw new Error(`setup transaction reverted: ${hash}${why}`);
}

const debtOf = async (who: `0x${string}`): Promise<bigint> => {
  const d = (await pub.readContract({
    address: DATA_PROVIDER, abi: DP_ABI, functionName: "getUserReserveData", args: [AAVE_USDC, who],
  })) as readonly bigint[];
  return d[1]! + d[2]!;
};

const healthFactorOf = async (who: `0x${string}`): Promise<bigint> => {
  const d = (await pub.readContract({
    address: AAVE_POOL, abi: POOL_ABI, functionName: "getUserAccountData", args: [who],
  })) as readonly bigint[];
  return d[5]!;
};

/** Store stub: the DB is not what this test is proving, the CHAIN path is. */
class OneRowStore implements DelegationStore {
  constructor(public rows: DelegationRow[]) {}
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

function buildDeps(
  rows: DelegationRow[],
  events: RelayerEvent[],
  over: Partial<RelayerDeps> = {},
): RelayerDeps {
  return {
    chain: new ViemRelayerChain({
      rpcUrl: NODE_URL,
      chainId: EXIT_CHAIN_ID,
      reserves: [AAVE_USDC, CBETH],
      pollMs: 200,
    }),
    delegations: {
      store: new OneRowStore(rows),
      chain: new ViemExitChainReader(NODE_URL),
      chainId: EXIT_CHAIN_ID,
      executor: EXECUTOR_ADDRESS,
    },
    attempts: new MemoryRelayerAttemptStore(),
    pool: new RelayerSignerPool([
      new LocalKeyRelayerSigner(keyFromLabel("panik-fork-test-relayer"), NODE_URL, EXIT_CHAIN_ID, "fork-0"),
    ]),
    limits: { ...DEFAULT_RELAYER_LIMITS, stuckAfterMs: 20_000 },
    hourly: new SubmissionRateWindow(),
    // RELAYER_FORK_DEBUG=1 echoes the event stream, which is the fastest way to
    // see WHICH gate refused when a case fails.
    emit: (e) => {
      events.push(e);
      if (process.env.RELAYER_FORK_DEBUG) console.log(JSON.stringify(e));
    },
    enabled: true,
    executor: EXECUTOR_ADDRESS,
    expectedChainId: EXIT_CHAIN_ID,
    ...over,
  };
}

async function signedRow(over: Partial<ExitPermit> = {}, signWith = user): Promise<DelegationRow> {
  const permit: ExitPermit = {
    user: user.address.toLowerCase() as `0x${string}`,
    kind: EXIT_KIND.FULL_REPAY,
    maxRepayFractionBps: 10_000,
    // Well above the position's real health factor, so the CONTRACT's own
    // _assertTriggerMet gate passes on live pool state, not on our say-so.
    triggerHealthFactorWad: hfToWad(1.5),
    maxSlippageBps: 100,
    protocolsMask: 0b0001, // AAVE_V3
    epoch: await new ViemExitChainReader(NODE_URL).revocationEpoch(
      user.address.toLowerCase() as `0x${string}`,
    ),
    nonce: BigInt(Math.floor(Math.random() * 1e15)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    ...over,
  };

  // The SAME EIP-712 the UI signs: server/exitPermit.ts owns the domain and the
  // type, and the domain defaults to the deployed executor on 84532.
  const signature = await signWith.signTypedData({
    domain: exitDomain(),
    types: EXIT_PERMIT_TYPES,
    primaryType: "ExitPermit",
    message: permit,
  });

  return {
    id: `fork-${permit.nonce}`,
    createdAt: Date.now(),
    permit,
    signature,
    status: "active",
    chainId: EXIT_CHAIN_ID,
    executor: EXECUTOR_ADDRESS,
    revocationTx: null,
  };
}

const candidate = (hf: number): RelayerCandidate => ({
  wallet: user.address.toLowerCase() as `0x${string}`,
  protocol: "aave_v3",
  healthFactor: hf,
});

let liveHf = 0;
let snapshot: string;

describe.skipIf(!FORK_RPC)("relayer against a forked Base Sepolia + the deployed executor", () => {
  beforeAll(async () => {
    await startAnvil();

    // Sanity: we are forking the chain the executor is actually deployed on,
    // and the bytecode at that address is real.
    expect(await pub.getChainId()).toBe(EXIT_CHAIN_ID);
    const code = await pub.getCode({ address: EXECUTOR_ADDRESS });
    expect(code && code.length).toBeGreaterThan(2);

    // Both test accounts must be plain EOAs, or the executor takes its ERC-1271
    // branch and refuses the ECDSA permit (see the note on keyFromLabel).
    for (const a of [user.address, relayer.address]) {
      expect(await pub.getCode({ address: a })).toBeUndefined();
    }
    for (const a of [user.address, relayer.address]) {
      await rpc("anvil_setBalance", [a, toHex(parseEther("100"))]);
    }

    // --- seed a REAL Aave position ------------------------------------------
    const addr0 = user.address.toLowerCase() as `0x${string}`;
    const collateral = parseEther("0.2"); // ~$436 of cbETH
    await dealErc20(CBETH, addr0, collateral);
    await send(
      await userWallet.writeContract({
        ...SETUP_GAS,
        address: CBETH, abi: ERC20_ABI, functionName: "approve", args: [AAVE_POOL, collateral],
      }),
    );
    await send(
      await userWallet.writeContract({
        ...SETUP_GAS,
        address: AAVE_POOL, abi: POOL_ABI, functionName: "supply",
        args: [CBETH, collateral, user.address, 0],
      }),
    );
    // 320 USDC of variable-rate debt against ~$436 of cbETH: a genuinely risky
    // position (HF ~1.15), which is the state a trigger is meant to catch.
    const borrow = 320_000_000n;
    // Assert the pool will allow it BEFORE asking, so a capacity problem reads
    // as a capacity problem rather than as an opaque reverted setup tx.
    const acct = (await pub.readContract({
      address: AAVE_POOL, abi: POOL_ABI, functionName: "getUserAccountData", args: [user.address],
    })) as readonly bigint[];
    // getUserAccountData is 8-decimal USD; the borrow is 6-decimal USDC at ~$1.
    expect(acct[2]!).toBeGreaterThan(borrow * 100n);
    await send(
      await userWallet.writeContract({
        ...SETUP_GAS,
        address: AAVE_POOL, abi: POOL_ABI, functionName: "borrow",
        args: [AAVE_USDC, borrow, 2n, 0, user.address],
      }),
    );

    const debt = await debtOf(user.address.toLowerCase() as `0x${string}`);
    expect(debt).toBeGreaterThanOrEqual(borrow);

    // Interest accrues between the borrow and the exit, and the sentinel repays
    // LIVE debt, so top the wallet up above the borrowed figure.
    await dealErc20(AAVE_USDC, user.address.toLowerCase() as `0x${string}`, borrow + 10_000_000n);

    // Wallet-funded repay: the executor pulls the debt asset from the user.
    await send(
      await userWallet.writeContract({
        ...SETUP_GAS,
        address: AAVE_USDC, abi: ERC20_ABI, functionName: "approve",
        args: [EXECUTOR_ADDRESS, borrow + 10_000_000n],
      }),
    );

    const hfWad = await healthFactorOf(user.address.toLowerCase() as `0x${string}`);
    liveHf = Number(hfWad) / 1e18;
    expect(liveHf).toBeGreaterThan(1);
    expect(liveHf).toBeLessThan(1.5); // below the trigger we are about to sign

    snapshot = (await rpc("evm_snapshot", [])) as string;
  }, 180_000);

  afterAll(() => {
    anvil?.kill();
  });

  // Each case starts from the seeded position; anvil's snapshot makes the order
  // of the cases irrelevant.
  const reset = async () => {
    await rpc("evm_revert", [snapshot]);
    snapshot = (await rpc("evm_snapshot", [])) as string;
  };

  it(
    "signs a permit the backend's own verifier accepts",
    async () => {
      await reset();
      const row = await signedRow();
      // If this fails, the relayer is not speaking the contract's EIP-712 and
      // every submission below would 401 at the signature check.
      expect(await verifyPermitSignature(row.permit, row.signature)).toBe(true);
      expect(validatePermitScope(row.permit, 1_000, Math.floor(Date.now() / 1000)).ok).toBe(true);
    },
    60_000,
  );

  it(
    "SUBMITS a real delegated exit: success receipt, debt gone, nonce spent",
    async () => {
      await reset();
      const row = await signedRow();
      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events);
      const addr = user.address.toLowerCase() as `0x${string}`;

      const debtBefore = await debtOf(addr);
      expect(debtBefore).toBeGreaterThan(0n);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(1);

      // The receipt, not the promise. viem does not throw on revert.
      const ok = events.find((e) => e.type === "relayer.succeeded") as
        | { txHash: string; gasUsed: string; feeWei: string }
        | undefined;
      expect(ok).toBeDefined();
      const receipt = await pub.getTransactionReceipt({ hash: ok!.txHash as `0x${string}` });
      expect(receipt.status).toBe("success");
      expect(receipt.to?.toLowerCase()).toBe(EXECUTOR_ADDRESS.toLowerCase());
      expect(receipt.from.toLowerCase()).toBe(relayer.address.toLowerCase());

      // The position actually closed its debt, on the real Aave market.
      expect(await debtOf(addr)).toBe(0n);

      // And the permit is single-use from here on.
      const reader = new ViemExitChainReader(NODE_URL);
      expect(await reader.isNonceUsed(addr, row.permit.nonce)).toBe(true);

      // Gas came from the simulation, and the relayer paid it.
      expect(BigInt(ok!.gasUsed)).toBeGreaterThan(0n);
      expect(
        events.some((e) => e.type === "relayer.attempted" && e.signer === relayer.address.toLowerCase()),
      ).toBe(true);
    },
    180_000,
  );

  it(
    "kill switch OFF: simulates the same permit but submits nothing",
    async () => {
      await reset();
      const row = await signedRow();
      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events, { enabled: false });
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      expect(report.dryRun).toBe(true);
      // The rehearsal reached the simulation, which means the contract WOULD
      // have accepted it — the whole point of a dry run on real state.
      const would = events.find((e) => e.type === "relayer.would-submit") as { gas: string } | undefined;
      expect(would).toBeDefined();
      expect(BigInt(would!.gas)).toBeGreaterThan(0n);
      expect(events.some((e) => e.type === "relayer.attempted")).toBe(false);
      expect(await debtOf(addr)).toBe(before); // nothing moved
    },
    120_000,
  );

  it(
    "chain guard: refuses when the connected chain is not the executor's",
    async () => {
      await reset();
      const row = await signedRow();
      const events: RelayerEvent[] = [];
      // The node still reports 84532; the relayer is told the executor lives on
      // mainnet. The mismatch alone must stop it.
      const deps = buildDeps([row], events, { expectedChainId: 8453 });
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      expect(
        events.some((e) => e.type === "relayer.skipped" && e.reason === "chain_mismatch"),
      ).toBe(true);
      expect(await debtOf(addr)).toBe(before);
    },
    120_000,
  );

  it(
    "revoked permit: the user's own revokeAll strands it and the relayer skips",
    async () => {
      await reset();
      const row = await signedRow();
      // The USER revokes, from their own wallet — the epoch moves to the block
      // number, orphaning every permit signed against the old epoch.
      await send(
        await userWallet.writeContract({
        ...SETUP_GAS,
          address: EXECUTOR_ADDRESS, abi: REVOKE_ABI, functionName: "revokeAll", args: [],
        }),
      );

      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events);
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      expect(
        events.some((e) => e.type === "relayer.skipped" && e.reason === "no_live_permit"),
      ).toBe(true);
      expect(await debtOf(addr)).toBe(before);
    },
    120_000,
  );

  it(
    "expired permit: past its deadline, the relayer never tries",
    async () => {
      await reset();
      const row = await signedRow({ deadline: BigInt(Math.floor(Date.now() / 1000) - 10) });
      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events);
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      expect(
        events.some((e) => e.type === "relayer.skipped" && e.reason === "no_live_permit"),
      ).toBe(true);
      expect(await debtOf(addr)).toBe(before);
    },
    120_000,
  );

  it(
    "already-used nonce: a permit spent on-chain is skipped, not resubmitted",
    async () => {
      await reset();
      const row = await signedRow();
      const events: RelayerEvent[] = [];

      // Land it for real once.
      expect((await runRelayerTick([candidate(liveHf)], buildDeps([row], events))).submitted).toBe(1);

      // Now offer the SAME permit to a relayer with a clean attempt ledger, so
      // only the on-chain nonce can stop it.
      const second: RelayerEvent[] = [];
      const report = await runRelayerTick([candidate(liveHf)], buildDeps([row], second));

      expect(report.submitted).toBe(0);
      expect(
        second.some(
          (e) =>
            e.type === "relayer.skipped" && (e.reason === "nonce_spent" || e.reason === "no_live_permit"),
        ),
      ).toBe(true);
      expect(second.some((e) => e.type === "relayer.attempted")).toBe(false);
    },
    240_000,
  );

  it(
    "simulation revert: a permit the contract refuses costs no transaction",
    async () => {
      await reset();
      // Signed by the RELAYER's key but naming the user — the contract's
      // _consumePermit recovers the wrong signer and reverts InvalidSignature.
      // The live-permit query cannot see that (it checks epoch/nonce/deadline),
      // so the SIMULATION is the only thing standing between this and a
      // guaranteed-reverting transaction.
      const row = await signedRow({}, relayer);
      expect(await verifyPermitSignature(row.permit, row.signature)).toBe(false);

      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events);
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      const skip = events.find(
        (e) => e.type === "relayer.skipped" && e.reason === "simulation_reverted",
      ) as { detail?: string } | undefined;
      expect(skip).toBeDefined();
      expect(skip!.detail && skip!.detail.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "relayer.attempted")).toBe(false);
      expect(await debtOf(addr)).toBe(before);
    },
    120_000,
  );

  it(
    "trigger not met: a permit whose signed threshold is below the live HF is left alone",
    async () => {
      await reset();
      // Signed trigger well UNDER the position's real health factor.
      const row = await signedRow({ triggerHealthFactorWad: hfToWad(1.01) });
      const events: RelayerEvent[] = [];
      const deps = buildDeps([row], events);
      const addr = user.address.toLowerCase() as `0x${string}`;
      const before = await debtOf(addr);

      const report = await runRelayerTick([candidate(liveHf)], deps);

      expect(report.submitted).toBe(0);
      expect(
        events.some((e) => e.type === "relayer.skipped" && e.reason === "trigger_not_met"),
      ).toBe(true);
      expect(await debtOf(addr)).toBe(before);
    },
    120_000,
  );
});
