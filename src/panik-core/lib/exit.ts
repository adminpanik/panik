/**
 * Atomic Exit runtime config + helpers (Phase 2).
 *
 * Honesty gate: scores/positions are read on Base MAINNET, but execution runs
 * on Base SEPOLIA until the executor is audited. EXIT_ENV drives the TESTNET
 * badges and the demo-position banner; mainnet cutover = flip VITE_EXIT_ENV +
 * re-run sync:exit-config against a mainnet deployment. Zero component changes.
 */

import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import type { LiveProtocol } from "./live";
import { EXIT_CHAIN_ID } from "./exit.generated";

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

// panik-core's own wagmi config (do NOT import from panik-founding - bundles
// are isolated on purpose).
export const exitWagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

// `PROTOCOL_ID`, `AMOUNT_FULL` and `ExitLegInput` live in `./exitLegs`, which
// carries no wagmi/viem imports so the leg-building math can be unit tested.

/**
 * Protocols executable in the CURRENT exit environment. On the Sepolia demo
 * only Aave V3 has a live deployment + seeded demo positions; the other three
 * are proven by the mainnet fork suite and unlock at mainnet cutover.
 */
export const EXECUTABLE_PROTOCOLS: Record<ExitEnv, LiveProtocol[]> = {
  testnet: ["aave_v3"],
  mainnet: ["aave_v3", "moonwell", "compound_v3", "morpho"],
};

export function isExitExecutable(protocol: LiveProtocol): boolean {
  return EXECUTABLE_PROTOCOLS[EXIT_ENV].includes(protocol);
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

/** Aave protocol data provider - the two views the exit flow needs. */
export const EXIT_DATA_PROVIDER_ABI = [
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
