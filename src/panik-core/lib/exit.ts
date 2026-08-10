/**
 * Atomic Exit runtime config + helpers (Phase 2).
 *
 * Honesty gate: execution runs on Base SEPOLIA until the executor is audited.
 * EXIT_ENV describes THE EXECUTOR's chain and nothing else. Mainnet cutover =
 * flip VITE_EXIT_ENV + re-run sync:exit-config against a mainnet deployment.
 *
 * Which chain the app is LOOKING at is a separate question with a separate
 * answer: `lib/chainMode.ts`, set by the user in Settings. The TESTNET badges
 * follow that, not this. Whether an exit can be signed at all is the two
 * agreeing, which is what `exitsExecutableOn` computes.
 */

import { fallback, http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import type { LiveProtocol } from "./live";
import { EXIT_CHAIN_ID } from "./exit.generated";
import { exitRpcUrls } from "./exitRpc";

export type ExitEnv = "testnet" | "mainnet";

// Widened copy: the generated constant is a literal type, and TS flags
// literal-vs-literal comparisons that can only be true after a redeploy.
const EXIT_CHAIN: number = EXIT_CHAIN_ID;

export const EXIT_ENV: ExitEnv =
  (import.meta.env.VITE_EXIT_ENV as ExitEnv | undefined) ??
  (EXIT_CHAIN === 8453 ? "mainnet" : "testnet");

export function getExitChain() {
  return EXIT_CHAIN === 8453 ? base : baseSepolia;
}

/** The chain's name, for the sentences a user reads when a call fails. */
export const EXIT_NETWORK_LABEL = getExitChain().name;

export function exitExplorerTxUrl(hash: string): string {
  const host = EXIT_CHAIN === 8453 ? "basescan.org" : "sepolia.basescan.org";
  return `https://${host}/tx/${hash}`;
}

/**
 * Narrow client view for raw reads/simulations. viem's full generic parameter
 * types require `authorizationList` under this tsconfig (same strictness
 * family as the known panik-founding type errors); results are explicitly
 * typed at each call site instead.
 */
export interface ContractClient {
  readContract(params: unknown): Promise<unknown>;
  simulateContract(params: unknown): Promise<{ request: unknown }>;
  waitForTransactionReceipt(params: {
    hash: `0x${string}`;
  }): Promise<{ logs: unknown[]; status: "success" | "reverted" }>;
}

export function asContractClient(client: unknown): ContractClient {
  return client as ContractClient;
}

/**
 * Operator override for a chain's RPC endpoint, per chain.
 *
 * PUBLIC BY DESIGN. `VITE_*` is compiled into the client bundle, so whatever is
 * set here is readable by anyone who opens devtools - it is for a URL that is
 * safe to publish, such as a provider endpoint locked to your domain or a node
 * you run. The repo's `ALCHEMY_API_KEY_BASE_SEPOLIA` is a backend-only secret
 * and must NOT be reached for here: giving it a `VITE_` name publishes it.
 *
 * Unset is the normal case, and the public list below stands on its own.
 */
const RPC_OVERRIDES: Record<number, string | undefined> = {
  [base.id]: import.meta.env.VITE_BASE_RPC_URL as string | undefined,
  [baseSepolia.id]: import.meta.env.VITE_BASE_SEPOLIA_RPC_URL as string | undefined,
};

/**
 * A transport that fails over instead of giving up.
 *
 * `http()` with no URL - what this used to be - resolves to the chain's single
 * default public node, and a rate limit there is the end of the read. `fallback`
 * moves to the next endpoint instead. viem's fallback does NOT fail over on an
 * execution revert, so a real revert still surfaces as one rather than being
 * re-asked of three nodes in turn.
 *
 * `retryCount: 0` on the fallback is deliberate: each `http` already retries
 * itself, and a second retry layer multiplies the wait a rate-limited user sits
 * through before the next endpoint is tried at all.
 */
function exitTransport(chainId: number) {
  return fallback(
    exitRpcUrls(chainId, RPC_OVERRIDES[chainId]).map((url) =>
      http(url, { retryCount: 2, retryDelay: 300, timeout: 15_000 }),
    ),
    { retryCount: 0 },
  );
}

// panik-core's own wagmi config (do NOT import from panik-founding - bundles
// are isolated on purpose).
export const exitWagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: exitTransport(base.id),
    [baseSepolia.id]: exitTransport(baseSepolia.id),
  },
  // wagmi batches reads through Multicall3 by default, which is why a failing
  // read shows up as an `aggregate3` call. Kept on - it is the thing that turns
  // the flow's parallel reads into ONE request against a rate-limited node -
  // but the size is pinned rather than left implicit, so a future batch cannot
  // grow into an `eth_call` large enough for a public endpoint to refuse.
  batch: { multicall: { batchSize: 1024, wait: 16 } },
});

// `PROTOCOL_ID`, `AMOUNT_FULL` and `ExitLegInput` live in `./exitLegs`, which
// carries no wagmi/viem imports so the leg-building math can be unit tested.

/**
 * Protocols executable in the CURRENT exit environment. On the Sepolia demo
 * only Aave V3 has a live deployment; the other three are proven by the mainnet
 * fork suite and unlock at mainnet cutover.
 */
export const EXECUTABLE_PROTOCOLS: Record<ExitEnv, LiveProtocol[]> = {
  testnet: ["aave_v3"],
  mainnet: ["aave_v3", "moonwell", "compound_v3", "morpho"],
};

export function isExitExecutable(protocol: LiveProtocol): boolean {
  return EXECUTABLE_PROTOCOLS[EXIT_ENV].includes(protocol);
}

/**
 * Protocols on which a COLLATERAL-FUNDED repay can actually be executed, per
 * environment. Empty in both, and that is the honest reading rather than a
 * placeholder: `PanikDeleverager` is proven against a Base mainnet fork and is
 * DEPLOYED NOWHERE, so there is no address to send a transaction to on either
 * chain.
 *
 * It is a table rather than a bare `false` so the cutover is the same one-line
 * edit the exit flow already takes, next to the constant it mirrors, instead of
 * a boolean somebody has to find.
 */
export const DELEVERAGE_EXECUTABLE_PROTOCOLS: Record<ExitEnv, LiveProtocol[]> = {
  testnet: [],
  mainnet: [],
};

/**
 * Whether the app can execute a collateral-funded repay on this protocol today.
 *
 * The advisor sizes the option regardless, because the sizing is a true
 * statement about the position and is worth showing. What a surface must NOT do
 * is put a button on it: an action the code cannot perform, offered as though it
 * could, is precisely the "never state a fact the code does not know" failure.
 * Explain the option, name that it is not live yet, and gate the control on
 * this.
 */
export function isDeleverageExecutable(protocol: LiveProtocol): boolean {
  return DELEVERAGE_EXECUTABLE_PROTOCOLS[EXIT_ENV].includes(protocol);
}

// ── Minimal ABIs used by the flow (panik-core-local copies) ────────────────

export const EXIT_ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

/** Aave protocol data provider - the three views the exit flow needs. */
export const EXIT_DATA_PROVIDER_ABI = [
  {
    // The market's own reserve list. The flow used to hardcode which assets it
    // read, which is how it ended up calling `getUserReserveData` on the
    // executor's PAYOUT token - an address this market does not list. See
    // `./exitReserves`.
    type: "function",
    name: "getAllReservesTokens",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "symbol", type: "string" },
          { name: "tokenAddress", type: "address" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getUserReserveData",
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getReserveTokensAddresses",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
    stateMutability: "view",
  },
] as const;
