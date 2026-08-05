/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract ABI, addresses, and wagmi configuration for the PanikEscrow contract.
 */

import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { isAddress } from "viem";

// ── Contract addresses (set via env var after deployment) ──────────────
// Must be the deployed contract ADDRESS (0x + 40 hex), not a deploy tx hash.
const RAW_ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS as
  | string
  | undefined;
const ESCROW_ADDRESS =
  RAW_ESCROW_ADDRESS && isAddress(RAW_ESCROW_ADDRESS)
    ? (RAW_ESCROW_ADDRESS as `0x${string}`)
    : undefined;

// Default chain: Base Sepolia for development, Base mainnet for production
const ESCROW_CHAIN_ID = Number(
  import.meta.env.VITE_ESCROW_CHAIN_ID || "84532"
);

// ── USDC addresses per chain ──────────────────────────────────────────
export const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

export const DEPOSIT_AMOUNT = 5_000_000n; // 5 USDC (6 decimals)
export const DEPOSIT_DISPLAY = "5"; // Human-readable

export function getEscrowAddress(): `0x${string}` {
  if (!ESCROW_ADDRESS) {
    throw new Error(
      "VITE_ESCROW_CONTRACT_ADDRESS is not set to a valid contract address. Deploy the contract first."
    );
  }
  return ESCROW_ADDRESS;
}

export function getEscrowChainId(): number {
  return ESCROW_CHAIN_ID;
}

export function getTargetChain() {
  return ESCROW_CHAIN_ID === 8453 ? base : baseSepolia;
}

export function getUsdcAddress(): `0x${string}` {
  const addr = USDC_ADDRESSES[ESCROW_CHAIN_ID];
  if (!addr) throw new Error(`No USDC address for chain ${ESCROW_CHAIN_ID}`);
  return addr;
}

// ── wagmi config ──────────────────────────────────────────────────────
export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});

// ── PanikEscrow ABI (only the functions we need on the frontend) ─────
export const ESCROW_ABI = [
  // Read functions
  {
    type: "function",
    name: "DEPOSIT_AMOUNT",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "REFUND_WINDOW",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "depositorCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasPaid",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isRefundable",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundDeadline",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDepositInfo",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      { name: "_depositTime", type: "uint256" },
      { name: "_shipped", type: "bool" },
      { name: "_refunded", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "depositTime",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "shipped",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refunded",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // Write functions
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimRefund",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Shipped",
    inputs: [],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "depositor", type: "address", indexed: true },
    ],
  },
] as const;

// ── ERC-20 ABI (just approve + allowance + balanceOf) ────────────────
export const ERC20_ABI = [
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
