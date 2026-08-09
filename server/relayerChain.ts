/**
 * viem-backed `RelayerChain` (Phase 4.A) — the only place the relayer touches
 * an RPC.
 *
 * Split out of server/exitRelayer.ts so the decision tree above it can be
 * exercised without a node, and so the fork integration test can point the SAME
 * relayer code at a real chain by swapping only the RPC URL. Everything here is
 * a read or an estimate; broadcasting lives with the signer, which is the only
 * component holding a key.
 *
 * SIMULATION IS NOT OPTIONAL. `simulate` runs viem's `simulateContract`, which
 * is an `eth_call` against the pending state, and then `estimateContractGas`.
 * Both go through the executor's real ABI at the real address, so a permit the
 * contract would reject (revoked, expired, trigger not met, a leg naming an
 * untracked asset) throws HERE, for free, instead of costing a reverted
 * transaction. The gas the relayer signs for comes from that estimate and from
 * nowhere else: a hardcoded limit is either too low (the transaction dies
 * mid-execution and still charges) or too high (it hands a buggy call a bigger
 * budget to burn).
 *
 * The ABI is the GENERATED one (src/panik-core/lib/exit.generated.ts), which is
 * synced from the deployed contract by `npm run sync:exit-config`. The relayer
 * must encode calldata exactly as deployed, so the generated artifact is the
 * right source here even though the delegation reads in server/exitChain.ts use
 * a hand-written v2 fragment for views that predate the sync.
 */

import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
} from "../src/panik-core/lib/exit.generated";
import type { AtomicExitForCall, RelayerChain, RelayerReceipt } from "./exitRelayer";
import type { ExitReserveState } from "../src/panik-core/lib/exitLegs";

/** The two Aave data-provider views a position read needs. */
const DATA_PROVIDER_ABI = [
  {
    type: "function",
    name: "getUserReserveData",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "currentATokenBalance", type: "uint256" },
      { name: "currentStableDebt", type: "uint256" },
      { name: "currentVariableDebt", type: "uint256" },
      { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * Narrow client view. viem's fully generic `PublicClient` does not typecheck
 * under this tsconfig once `chainFor` returns a `base | baseSepolia` union
 * (their `getBlock` return types differ — Base carries an extra deposit
 * transaction variant). The app hits the same wall and resolves it the same
 * way; see `ContractClient` in src/panik-core/lib/exit.ts.
 */
interface Client {
  getChainId(): Promise<number>;
  getBlock(args?: unknown): Promise<{ timestamp: bigint; number: bigint }>;
  readContract(args: unknown): Promise<unknown>;
  simulateContract(args: unknown): Promise<{ request: unknown }>;
  estimateContractGas(args: unknown): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    blockNumber: bigint;
  }>;
}

function chainFor(chainId: number) {
  return chainId === base.id ? base : baseSepolia;
}

// Widened copy of the generated literal: TS flags `84532 === 8453` as a
// no-overlap comparison. Same trick server/exitChain.ts and
// src/panik-core/lib/exit.ts use.
const EXECUTOR_CHAIN: number = EXIT_CHAIN_ID;

/**
 * Executor RPC endpoint, resolved exactly as server/exitChain.ts resolves it so
 * the relayer and the delegation reader can never end up on different nodes.
 */
export function relayerRpcUrl(): string {
  const override = process.env.EXIT_EXECUTOR_RPC_URL;
  if (override && override.trim()) return override.trim();
  if (EXECUTOR_CHAIN === base.id) {
    const key = process.env.ALCHEMY_API_KEY_BASE_MAINNET;
    return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : "https://mainnet.base.org";
  }
  const key = process.env.ALCHEMY_API_KEY_BASE_SEPOLIA;
  return key ? `https://base-sepolia.g.alchemy.com/v2/${key}` : "https://sepolia.base.org";
}

/**
 * The reserves a position read covers.
 *
 * Explicit rather than discovered from `getReservesList` on purpose: only an
 * asset the executor TRACKS can appear in a leg (`_requireTrackedAsset`), so
 * scanning every reserve would build legs the contract is certain to reject.
 * Defaults to the executor's own tracked set from the deploy config; the fork
 * test passes its own list.
 */
export interface RelayerChainConfig {
  rpcUrl?: string;
  chainId?: number;
  executor?: `0x${string}`;
  dataProvider?: `0x${string}`;
  /** Reserve addresses to read. Symbols/decimals come from the token itself. */
  reserves?: readonly `0x${string}`[];
  /** Poll interval while waiting for a receipt. */
  pollMs?: number;
  /** Headroom added to the estimate, in percent. See GAS_BUFFER_PCT. */
  gasBufferPct?: bigint;
}

/**
 * Headroom added to the node's gas estimate before signing.
 *
 * `eth_estimateGas` returns the smallest limit that made the call succeed IN
 * THE SIMULATION, and that is not always enough at inclusion time. Two reasons,
 * both real:
 *
 *   1. EIP-150's 63/64 rule. A nested call only receives 63/64 of the gas
 *      remaining at its frame, so a limit that is exact at the top level can
 *      leave an inner call one notch short. atomicExitFor is four frames deep
 *      through the adapters (executor -> adapter -> Aave pool -> token), and
 *      this is exactly how the Aave borrow in the fork test failed: `out of
 *      gas` at depth 2 with gasUsed 276,783 against an estimated limit of
 *      284,444.
 *   2. State moves between the estimate and inclusion — an interest accrual, a
 *      cold storage slot that a competing transaction warmed differently.
 *
 * A buffer costs NOTHING when unused: the EVM refunds the unspent limit, so the
 * relayer pays for gas used, not gas reserved. The only thing it consumes is
 * headroom under `maxGasPerTx`, which is checked against the BUFFERED figure so
 * the cap still bounds the worst case.
 */
export const GAS_BUFFER_PCT = 25n;

export class ViemRelayerChain implements RelayerChain {
  private readonly client: Client;
  private readonly executor: `0x${string}`;
  private readonly dataProvider: `0x${string}`;
  private readonly reserves: readonly `0x${string}`[];
  private readonly pollMs: number;
  private readonly gasBufferPct: bigint;
  /** Token metadata is immutable; one read per token per process. */
  private readonly meta = new Map<string, { symbol: string; decimals: number }>();

  constructor(config: RelayerChainConfig = {}) {
    const chainId = config.chainId ?? EXIT_CHAIN_ID;
    this.executor = config.executor ?? EXECUTOR_ADDRESS;
    this.dataProvider = config.dataProvider ?? EXIT_DATA_PROVIDER_ADDRESS;
    this.reserves = config.reserves ?? [];
    this.pollMs = config.pollMs ?? 2_000;
    this.gasBufferPct = config.gasBufferPct ?? GAS_BUFFER_PCT;
    this.client = createPublicClient({
      chain: chainFor(chainId),
      transport: http(config.rpcUrl ?? relayerRpcUrl()),
    }) as unknown as Client;
  }

  async chainId(): Promise<number> {
    return this.client.getChainId();
  }

  async latestBlockTimestampSec(): Promise<number> {
    const block = await this.client.getBlock();
    return Number(block.timestamp);
  }

  async isNonceUsed(user: `0x${string}`, nonce: bigint): Promise<boolean> {
    return (await this.client.readContract({
      address: this.executor,
      abi: EXECUTOR_ABI,
      functionName: "isNonceUsed",
      args: [user, nonce],
    })) as boolean;
  }

  private async tokenMeta(token: `0x${string}`): Promise<{ symbol: string; decimals: number }> {
    const cached = this.meta.get(token.toLowerCase());
    if (cached) return cached;
    // Decimals come from the token, never from the symbol: the repay is
    // denominated in the debt asset, and a WETH amount scaled by 10^6 is off by
    // twelve orders of magnitude.
    const [decimals, symbol] = await Promise.all([
      this.client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      this.client
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .catch(() => token.slice(0, 8)),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals) };
    this.meta.set(token.toLowerCase(), meta);
    return meta;
  }

  async reserveStates(user: `0x${string}`): Promise<ExitReserveState[]> {
    const out: ExitReserveState[] = [];
    for (const reserve of this.reserves) {
      const raw = (await this.client.readContract({
        address: this.dataProvider,
        abi: DATA_PROVIDER_ABI,
        functionName: "getUserReserveData",
        args: [reserve, user],
      })) as readonly bigint[];
      const aBalance = raw[0]!;
      const debt = raw[1]! + raw[2]!; // stable + variable, as the exit flow sums them
      if (aBalance === 0n && debt === 0n) continue;
      const { symbol, decimals } = await this.tokenMeta(reserve);
      out.push({ reserve, symbol, decimals, aBalance, debt });
    }
    return out;
  }

  async simulate(
    call: AtomicExitForCall,
    from: `0x${string}`,
  ): Promise<{ gas: bigint; data: `0x${string}` }> {
    // `uniswapTokenIds` is always empty: atomicExitFor reverts
    // UniswapLegNotPermitted on anything else, because an ExitPermit has no
    // field naming LP token ids so a signature cannot scope them.
    const args = [
      call.user,
      call.legs.map((l) => ({
        protocol: l.protocol,
        asset: l.asset,
        repayAmount: l.repayAmount,
        withdrawAmount: l.withdrawAmount,
        data: l.data,
      })),
      [] as readonly bigint[],
      call.permit,
      call.signature,
    ];
    const params = {
      address: this.executor,
      abi: EXECUTOR_ABI,
      functionName: "atomicExitFor",
      args,
      account: from,
    };

    // eth_call first: it surfaces the contract's own revert reason, which is
    // the useful diagnostic. estimateContractGas would also revert, but its
    // error is about gas rather than about why the permit was refused.
    await this.client.simulateContract(params);
    const estimated = await this.client.estimateContractGas(params);
    const gas = (estimated * (100n + this.gasBufferPct)) / 100n;

    const { encodeFunctionData } = await import("viem");
    const data = encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: "atomicExitFor",
      args,
    } as never) as `0x${string}`;

    return { gas, data };
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    return this.client.estimateFeesPerGas();
  }

  async receipt(hash: `0x${string}`): Promise<RelayerReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        blockNumber: r.blockNumber,
      };
    } catch {
      return null; // not mined yet, or never seen
    }
  }

  /**
   * Poll rather than viem's `waitForTransactionReceipt`, because the caller
   * needs to tell "timed out" from "reverted" and act differently: a timeout
   * gets a fee bump, a revert must never be retried. viem's waiter throws on
   * timeout and RESOLVES on revert, which is exactly the pair this code must
   * not conflate.
   */
  async waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<RelayerReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.receipt(hash);
      if (r) return r;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
