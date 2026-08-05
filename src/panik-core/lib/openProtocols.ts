/**
 * In-app position OPENING (Phase 2) - per-protocol transaction builders.
 *
 * Opens are standard protocol interactions signed by the user's OWN wallet on
 * Base MAINNET - no PANIK contracts sit in the path, so this is the same
 * trust model as using the protocol's own app. Every step is simulated
 * before signing, and builders sanity-check addresses on-chain (e.g.
 * comet.baseToken(), mToken.underlying()) before any funds move.
 */

import type { LiveProtocol } from "./live";
import type { ContractClient } from "./exit";

export const OPEN_CHAIN_ID = 8453; // Base mainnet

// Canonical Base mainnet addresses. AAVE_POOL / COMET_USDC / MOONWELL mTokens
// were exercised against live code by the executor repo's fork suite.
export const OPEN_TOKENS: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  wstETH: { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
};

export const AAVE_POOL: `0x${string}` = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
export const COMET_USDC: `0x${string}` = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
export const MORPHO_BLUE: `0x${string}` = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const MOONWELL_COMPTROLLER: `0x${string}` = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";
/** Only on-chain-verified mTokens are openable via Moonwell. */
export const MOONWELL_MTOKENS: Record<string, `0x${string}`> = {
  WETH: "0x628ff693426583D9a7FB391E54366292F509D457",
  USDC: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
};

export interface MorphoMarketParams {
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  oracle: `0x${string}`;
  irm: `0x${string}`;
  lltv: bigint;
}

/** Collateral symbols openable in-app per protocol (subset of MARKETS). */
export const OPENABLE_SYMBOLS: Record<LiveProtocol, string[]> = {
  aave_v3: ["WETH", "wstETH", "USDC", "cbBTC"],
  moonwell: Object.keys(MOONWELL_MTOKENS),
  compound_v3: ["WETH", "cbETH", "cbBTC"],
  morpho: ["WETH", "wstETH", "cbBTC"],
};

export function isOpenSupported(protocol: LiveProtocol, symbol: string): boolean {
  return (OPENABLE_SYMBOLS[protocol] ?? []).includes(symbol) && symbol in OPEN_TOKENS;
}

// ── Minimal ABIs ───────────────────────────────────────────────────────────

export const OPEN_AAVE_POOL_ABI = [
  {
    type: "function",
    name: "supply",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "borrow",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "ADDRESSES_PROVIDER",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const OPEN_ADDRESSES_PROVIDER_ABI = [
  {
    type: "function",
    name: "getPriceOracle",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const OPEN_ORACLE_ABI = [
  {
    type: "function",
    name: "getAssetPrice",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const OPEN_MTOKEN_ABI = [
  {
    type: "function",
    name: "mint",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "borrow",
    inputs: [{ name: "borrowAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "underlying",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const OPEN_COMPTROLLER_ABI = [
  {
    type: "function",
    name: "enterMarkets",
    inputs: [{ name: "mTokens", type: "address[]" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "nonpayable",
  },
] as const;

export const OPEN_COMET_ABI = [
  {
    type: "function",
    name: "supply",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "baseToken",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export const OPEN_MORPHO_ABI = [
  {
    type: "function",
    name: "supplyCollateral",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "assets", type: "uint256" },
      { name: "onBehalf", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "borrow",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "assets", type: "uint256" },
      { name: "shares", type: "uint256" },
      { name: "onBehalf", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

export const OPEN_ERC20_ABI = [
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
] as const;

// ── Step building ──────────────────────────────────────────────────────────

/**
 * What a step does to the user's funds. `supply` is the irreversible one -
 * replaying it deposits the collateral a second time, so resume logic keys
 * off these kinds rather than off raw indices.
 */
export type OpenStepKind = "approve" | "supply" | "enable" | "borrow";

export interface OpenTxStep {
  label: string;
  address: `0x${string}`;
  abi: unknown;
  functionName: string;
  args: unknown[];
  kind: OpenStepKind;
  /** Approve steps only: who the allowance is granted to. */
  spender?: `0x${string}`;
}

export interface OpenPlanInput {
  protocol: LiveProtocol;
  collateralSymbol: string;
  /** Collateral amount in token units. */
  collateralAmount: bigint;
  /** USDC borrow amount in OPEN_TOKENS.USDC units; 0n = collateral-only open. */
  borrowAmount: bigint;
  user: `0x${string}`;
  /** Required for morpho only (from /api/morpho/market). */
  morphoMarket?: MorphoMarketParams;
}

/**
 * Read the collateral asset's USD price (8 decimals) from the Aave oracle -
 * one canonical price source for USD -> token-unit conversion in the UI.
 */
export async function readCollateralPriceUsd8(
  client: ContractClient,
  symbol: string,
): Promise<bigint> {
  const token = OPEN_TOKENS[symbol];
  if (!token) throw new Error(`unknown token ${symbol}`);
  const addressesProvider = (await client.readContract({
    address: AAVE_POOL,
    abi: OPEN_AAVE_POOL_ABI,
    functionName: "ADDRESSES_PROVIDER",
  })) as `0x${string}`;
  const oracle = (await client.readContract({
    address: addressesProvider,
    abi: OPEN_ADDRESSES_PROVIDER_ABI,
    functionName: "getPriceOracle",
  })) as `0x${string}`;
  return (await client.readContract({
    address: oracle,
    abi: OPEN_ORACLE_ABI,
    functionName: "getAssetPrice",
    args: [token.address],
  })) as bigint;
}

/** On-chain sanity checks before any funds move (self-verify the addresses). */
export async function verifyOpenTargets(
  client: ContractClient,
  input: OpenPlanInput,
): Promise<void> {
  if (input.protocol === "compound_v3") {
    const base = (await client.readContract({
      address: COMET_USDC,
      abi: OPEN_COMET_ABI,
      functionName: "baseToken",
    })) as string;
    if (base.toLowerCase() !== OPEN_TOKENS.USDC!.address.toLowerCase()) {
      throw new Error("Comet baseToken mismatch - aborting");
    }
  }
  if (input.protocol === "moonwell") {
    const mToken = MOONWELL_MTOKENS[input.collateralSymbol];
    if (!mToken) throw new Error(`no verified Moonwell market for ${input.collateralSymbol}`);
    const underlying = (await client.readContract({
      address: mToken,
      abi: OPEN_MTOKEN_ABI,
      functionName: "underlying",
    })) as string;
    if (underlying.toLowerCase() !== OPEN_TOKENS[input.collateralSymbol]!.address.toLowerCase()) {
      throw new Error("Moonwell mToken underlying mismatch - aborting");
    }
  }
  if (input.protocol === "morpho") {
    const mp = input.morphoMarket;
    if (!mp) throw new Error("Morpho market params missing");
    if (
      mp.collateralToken.toLowerCase() !==
      OPEN_TOKENS[input.collateralSymbol]!.address.toLowerCase()
    ) {
      throw new Error("Morpho market collateral mismatch - aborting");
    }
    // The UI borrows "USDC" and scales by USDC's decimals - a market whose
    // loan token is anything else would borrow the wrong asset and amount.
    if (mp.loanToken.toLowerCase() !== OPEN_TOKENS.USDC!.address.toLowerCase()) {
      throw new Error("Morpho market loan token mismatch - aborting");
    }
  }
}

/** Build the ordered transaction steps for an in-app open. */
export function buildOpenSteps(input: OpenPlanInput): OpenTxStep[] {
  const { protocol, collateralSymbol, collateralAmount, borrowAmount, user } = input;
  const collateral = OPEN_TOKENS[collateralSymbol];
  const usdc = OPEN_TOKENS.USDC!;
  if (!collateral) throw new Error(`unknown collateral ${collateralSymbol}`);
  const steps: OpenTxStep[] = [];

  if (protocol === "aave_v3") {
    steps.push({
      label: `Approve ${collateralSymbol}`,
      address: collateral.address,
      abi: OPEN_ERC20_ABI,
      functionName: "approve",
      args: [AAVE_POOL, collateralAmount],
      kind: "approve",
      spender: AAVE_POOL,
    });
    steps.push({
      label: `Supply ${collateralSymbol} to Aave V3`,
      address: AAVE_POOL,
      abi: OPEN_AAVE_POOL_ABI,
      functionName: "supply",
      args: [collateral.address, collateralAmount, user, 0],
      kind: "supply",
    });
    if (borrowAmount > 0n) {
      steps.push({
        label: "Borrow USDC",
        address: AAVE_POOL,
        abi: OPEN_AAVE_POOL_ABI,
        functionName: "borrow",
        args: [usdc.address, borrowAmount, 2n, 0, user],
        kind: "borrow",
      });
    }
    return steps;
  }

  if (protocol === "moonwell") {
    const mToken = MOONWELL_MTOKENS[collateralSymbol];
    const mUsdc = MOONWELL_MTOKENS.USDC;
    if (!mToken || !mUsdc) throw new Error(`no verified Moonwell market for ${collateralSymbol}`);
    steps.push({
      label: `Approve ${collateralSymbol}`,
      address: collateral.address,
      abi: OPEN_ERC20_ABI,
      functionName: "approve",
      args: [mToken, collateralAmount],
      kind: "approve",
      spender: mToken,
    });
    steps.push({
      label: `Supply ${collateralSymbol} to Moonwell`,
      address: mToken,
      abi: OPEN_MTOKEN_ABI,
      functionName: "mint",
      args: [collateralAmount],
      kind: "supply",
    });
    steps.push({
      label: "Enable as collateral",
      address: MOONWELL_COMPTROLLER,
      abi: OPEN_COMPTROLLER_ABI,
      functionName: "enterMarkets",
      args: [[mToken]],
      kind: "enable",
    });
    if (borrowAmount > 0n) {
      steps.push({
        label: "Borrow USDC",
        address: mUsdc,
        abi: OPEN_MTOKEN_ABI,
        functionName: "borrow",
        args: [borrowAmount],
        kind: "borrow",
      });
    }
    return steps;
  }

  if (protocol === "compound_v3") {
    steps.push({
      label: `Approve ${collateralSymbol}`,
      address: collateral.address,
      abi: OPEN_ERC20_ABI,
      functionName: "approve",
      args: [COMET_USDC, collateralAmount],
      kind: "approve",
      spender: COMET_USDC,
    });
    steps.push({
      label: `Supply ${collateralSymbol} to Compound V3`,
      address: COMET_USDC,
      abi: OPEN_COMET_ABI,
      functionName: "supply",
      args: [collateral.address, collateralAmount],
      kind: "supply",
    });
    if (borrowAmount > 0n) {
      steps.push({
        label: "Borrow USDC (withdraw base)",
        address: COMET_USDC,
        abi: OPEN_COMET_ABI,
        functionName: "withdraw",
        args: [usdc.address, borrowAmount],
        kind: "borrow",
      });
    }
    return steps;
  }

  // morpho
  const mp = input.morphoMarket;
  if (!mp) throw new Error("Morpho market params missing");
  const mpTuple = {
    loanToken: mp.loanToken,
    collateralToken: mp.collateralToken,
    oracle: mp.oracle,
    irm: mp.irm,
    lltv: mp.lltv,
  };
  steps.push({
    label: `Approve ${collateralSymbol}`,
    address: collateral.address,
    abi: OPEN_ERC20_ABI,
    functionName: "approve",
    args: [MORPHO_BLUE, collateralAmount],
    kind: "approve",
    spender: MORPHO_BLUE,
  });
  steps.push({
    label: `Supply ${collateralSymbol} to Morpho`,
    address: MORPHO_BLUE,
    abi: OPEN_MORPHO_ABI,
    functionName: "supplyCollateral",
    args: [mpTuple, collateralAmount, user, "0x"],
    kind: "supply",
  });
  if (borrowAmount > 0n) {
    steps.push({
      label: "Borrow USDC",
      address: MORPHO_BLUE,
      abi: OPEN_MORPHO_ABI,
      functionName: "borrow",
      args: [mpTuple, borrowAmount, 0n, user, user],
      kind: "borrow",
    });
  }
  return steps;
}

// ── Resume safety ──────────────────────────────────────────────────────────
//
// An open is a multi-transaction sequence and the borrow leg is the one that
// most often reverts (borrow cap, health factor). The natural recovery is to
// lower the borrow and retry - which must NOT replay the approve/supply legs,
// because re-running `supply` deposits the collateral a SECOND time with real
// funds. Everything below exists to make that impossible.

/**
 * Number of leading steps that commit collateral (approve / supply / enable).
 * `buildOpenSteps` always emits the collateral legs first and appends the
 * borrow leg last (and only when borrowAmount > 0n), so the borrow leg is the
 * only tail that may be rebuilt with new arguments on a retry.
 */
export function collateralStepCount(steps: OpenTxStep[]): number {
  const borrowIdx = steps.findIndex((s) => s.kind === "borrow");
  return borrowIdx === -1 ? steps.length : borrowIdx;
}

/**
 * Stable identity for an in-flight open. Deliberately excludes the sizing
 * inputs: editing the borrow amount must resume the SAME open, not start a
 * new one. Progress recorded under this key is what stops a double supply.
 */
export function openProgressKey(input: {
  protocol: string;
  collateralSymbol: string;
  user: string;
  chainId: number;
}): string {
  return [
    "panik.open.v1",
    input.chainId,
    input.protocol,
    input.collateralSymbol,
    input.user.toLowerCase(),
  ].join(":");
}

export interface ResumeIndexInput {
  /** The freshly built step list for this attempt. */
  steps: OpenTxStep[];
  /** How many steps are recorded as landed on-chain for this open. */
  completedSteps: number;
  /** Live on-chain allowance the approve step would grant. */
  allowance: bigint;
  /** Collateral amount the approve/supply steps carry, in token units. */
  collateralAmount: bigint;
}

/**
 * Index of the first step that still has to run.
 *
 * Invariant: the returned index is NEVER lower than a recorded, landed
 * `supply` step - no input edit, remount or refetch can walk the cursor back
 * over collateral that is already deposited. The only backwards move allowed
 * is re-running `approve` while the supply is still pending, which is exactly
 * the case where the approval amount was recomputed and no longer covers the
 * supply (an exact-amount approval is spent, not topped up).
 */
export function resumeIndex({
  steps,
  completedSteps,
  allowance,
  collateralAmount,
}: ResumeIndexInput): number {
  const clamped = Math.min(Math.max(Math.trunc(completedSteps) || 0, 0), steps.length);
  const approveIdx = steps.findIndex((s) => s.kind === "approve");
  const supplyIdx = steps.findIndex((s) => s.kind === "supply");
  if (approveIdx === -1) return clamped;

  const supplyLanded = supplyIdx !== -1 && clamped > supplyIdx;
  let index = clamped;

  // Approve landed but the supply has not, and the live allowance no longer
  // covers the amount this attempt will supply (the oracle re-read moved it,
  // or the approval was spent elsewhere). Re-approving is safe here precisely
  // because no collateral has moved yet.
  if (!supplyLanded && index > approveIdx && allowance < collateralAmount) {
    index = approveIdx;
  }

  // Conversely, never ask for an approval the chain already grants.
  if (index === approveIdx && allowance >= collateralAmount) {
    index = approveIdx + 1;
  }

  return index;
}
