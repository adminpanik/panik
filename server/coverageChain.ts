/**
 * viem-backed `CoverageChain` (Phase 4.B) — the only place the coverage sweep
 * touches an RPC.
 *
 * Split from server/coverageSweep.ts for the same reason server/relayerChain.ts
 * is split from server/exitRelayer.ts: the decision about whether a wallet is
 * really covered is worth testing exhaustively, and it cannot be if it is
 * welded to a node.
 *
 * Every read here is a view. The sweep NEVER simulates `atomicExitFor` against
 * a live position, and that is a deliberate limitation rather than an
 * oversight: a simulation would be the strongest possible proof, but the
 * trigger has not fired, so the contract's own `_assertTriggerMet` would revert
 * and the result would say nothing about the approvals. Checking the
 * authorizations directly answers the question that a pre-trigger simulation
 * cannot.
 */

import { createPublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  EXECUTOR_ADDRESS,
  EXIT_ADAPTERS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
} from "../src/panik-core/lib/exit.generated";
// The SAME resolution the relayer and the UI use. `EXIT_USDC_ADDRESS` is
// deliberately not imported here any more: it is `executor.usdc()`, the PAYOUT
// token, and sweeping it checked an approval on an asset no position holds.
import { exitReserveAddresses, loadExitReserveSet } from "../src/panik-core/lib/exitReserves";
// The same public-first endpoint ladder the relayer and the delegation reader
// build on, so the sweep can never be the one component reading a stale node.
import { executorRpcTransport } from "./exitChain";
import type { CoverageChain, CoverageMarkets } from "./coverageSweep";
import type { ExitReserveState } from "../src/panik-core/lib/exitLegs";

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

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
  {
    type: "function",
    name: "getReserveTokensAddresses",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
] as const;

const COMET_ABI = [
  {
    type: "function",
    name: "isAllowed",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "manager", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const MORPHO_ABI = [
  {
    type: "function",
    name: "isAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "authorized", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Narrow client view; viem's generic PublicClient does not typecheck here. */
interface Client {
  readContract(args: unknown): Promise<unknown>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
}

function chainFor(chainId: number) {
  return chainId === base.id ? base : baseSepolia;
}

export interface CoverageChainConfig {
  /**
   * Pins the endpoint set. Omit (or pass an empty list) for the resolved
   * public-first ladder in `executorRpcUrls`.
   */
  rpcUrl?: string | readonly string[];
  chainId?: number;
  dataProvider?: `0x${string}`;
  executor?: `0x${string}`;
  /**
   * Explicit reserve addresses. Omit (or pass empty) to resolve the market's
   * reserve list intersected with the executor's tracked assets, which is what
   * the relayer would actually build legs against.
   */
  reserves?: readonly `0x${string}`[];
}

export class ViemCoverageChain implements CoverageChain {
  private readonly client: Client;
  private readonly dataProvider: `0x${string}`;
  private readonly executor: `0x${string}`;
  private readonly chainId: number;
  /** Operator override. Empty means "resolve from chain". */
  private readonly reserveOverride: readonly `0x${string}`[];
  /** aToken addresses are immutable per reserve; one read per process. */
  private readonly aTokens = new Map<string, `0x${string}` | null>();
  private readonly meta = new Map<string, { symbol: string; decimals: number }>();

  constructor(config: CoverageChainConfig) {
    this.dataProvider = config.dataProvider ?? EXIT_DATA_PROVIDER_ADDRESS;
    this.executor = config.executor ?? EXECUTOR_ADDRESS;
    this.chainId = config.chainId ?? EXIT_CHAIN_ID;
    this.reserveOverride = config.reserves ?? [];
    this.client = createPublicClient({
      chain: chainFor(this.chainId),
      transport: executorRpcTransport(config.rpcUrl, this.chainId),
    }) as unknown as Client;
  }

  /**
   * The reserves the sweep inspects, resolved once per process.
   *
   * This is the answer to "which assets could a delegated exit actually name for
   * this wallet". It used to fall back to `[EXIT_USDC_ADDRESS,
   * EXIT_WETH_ADDRESS]`, which meant the sweep checked approvals on the payout
   * token - an asset no Aave position holds - found nothing wrong, and reported
   * coverage healthy while a cbETH or USDT position sat unapproved. The sweep
   * exists to make "the user believes they are protected and they are not"
   * impossible, so it has to look at the same list the relayer would.
   *
   * Throws rather than returning a partial list when the chain cannot be read:
   * the caller turns that into a failed check, never into a clean sweep.
   */
  async aaveReserves(): Promise<readonly `0x${string}`[]> {
    if (this.reserveOverride.length > 0) return this.reserveOverride;
    return exitReserveAddresses(
      await loadExitReserveSet(this.client, {
        chainId: this.chainId,
        dataProvider: this.dataProvider,
        executor: this.executor,
      }),
    );
  }

  async codeAt(address: `0x${string}`): Promise<`0x${string}`> {
    return (await this.client.getCode({ address })) ?? "0x";
  }

  async allowance(
    token: `0x${string}`,
    owner: `0x${string}`,
    spender: `0x${string}`,
  ): Promise<bigint> {
    return (await this.client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
  }

  async aTokenFor(reserve: `0x${string}`): Promise<`0x${string}` | null> {
    const cached = this.aTokens.get(reserve.toLowerCase());
    if (cached !== undefined) return cached;
    try {
      const out = (await this.client.readContract({
        address: this.dataProvider,
        abi: DATA_PROVIDER_ABI,
        functionName: "getReserveTokensAddresses",
        args: [reserve],
      })) as readonly `0x${string}`[];
      const aToken = out[0] ?? null;
      // The zero address means "not a listed reserve", which is a null answer
      // and not an address to go and read an allowance from.
      const resolved =
        aToken && aToken !== "0x0000000000000000000000000000000000000000" ? aToken : null;
      this.aTokens.set(reserve.toLowerCase(), resolved);
      return resolved;
    } catch {
      // NOT cached: a transient RPC failure must not become a permanent null
      // that the sweep would keep reporting as unverifiable forever.
      return null;
    }
  }

  private async tokenMeta(token: `0x${string}`): Promise<{ symbol: string; decimals: number }> {
    const cached = this.meta.get(token.toLowerCase());
    if (cached) return cached;
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
    for (const reserve of await this.aaveReserves()) {
      const raw = (await this.client.readContract({
        address: this.dataProvider,
        abi: DATA_PROVIDER_ABI,
        functionName: "getUserReserveData",
        args: [reserve, user],
      })) as readonly bigint[];
      const aBalance = raw[0]!;
      const debt = raw[1]! + raw[2]!;
      if (aBalance === 0n && debt === 0n) continue;
      const { symbol, decimals } = await this.tokenMeta(reserve);
      out.push({ reserve, symbol, decimals, aBalance, debt });
    }
    return out;
  }

  async cometAllowed(
    comet: `0x${string}`,
    owner: `0x${string}`,
    manager: `0x${string}`,
  ): Promise<boolean> {
    return (await this.client.readContract({
      address: comet,
      abi: COMET_ABI,
      functionName: "isAllowed",
      args: [owner, manager],
    })) as boolean;
  }

  async morphoAuthorized(
    morpho: `0x${string}`,
    owner: `0x${string}`,
    authorized: `0x${string}`,
  ): Promise<boolean> {
    return (await this.client.readContract({
      address: morpho,
      abi: MORPHO_ABI,
      functionName: "isAuthorized",
      args: [owner, authorized],
    })) as boolean;
  }
}

/** Parse a comma-separated env var into checksum-free 0x addresses. */
function addressList(raw: string | undefined): `0x${string}`[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s)) as `0x${string}`[];
}

/**
 * The market set the sweep can verify, from env + the generated deploy config.
 *
 * The adapters come from `exit.generated.ts` because they are the addresses the
 * DEPLOYED executor actually calls; a hand-typed adapter address would make the
 * sweep check an authorization nobody needs. The Comet markets and Morpho have
 * no such source — they are per-deployment — so they stay env-driven, and an
 * unset one leaves that protocol UNVERIFIABLE rather than assumed fine.
 *
 * `aaveReserves` is passed in rather than read from env, because it now comes
 * from `ViemCoverageChain.aaveReserves()` — the chain, not a constant. The old
 * `[EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS]` fallback is gone: an empty list here
 * makes the sweep report Aave UNVERIFIABLE, which is the honest answer, where
 * the wrong list made it report healthy.
 */
export function coverageMarketsFromEnv(
  aaveReserves: readonly `0x${string}`[],
  env: NodeJS.ProcessEnv = process.env,
): CoverageMarkets {
  return {
    aaveReserves,
    comets: addressList(env.COVERAGE_COMET_MARKETS),
    compoundAdapter: EXIT_ADAPTERS.compound,
    morpho: addressList(env.COVERAGE_MORPHO_ADDRESS)[0] ?? null,
    morphoAdapter: EXIT_ADAPTERS.morpho,
    mTokens: addressList(env.COVERAGE_MOONWELL_MTOKENS),
  };
}
