/**
 * In-app position OPENING (Phase 2) - per-protocol transaction builders.
 *
 * Opens are standard protocol interactions signed by the user's OWN wallet -
 * no PANIK contracts sit in the path, so this is the same trust model as using
 * the protocol's own app. Every step is simulated before signing, and builders
 * sanity-check addresses on-chain (e.g. comet.baseToken(), mToken.underlying())
 * before any funds move.
 *
 * Two chains, and they are NOT symmetric. Base mainnet carries all four
 * protocols and real assets; Base Sepolia carries Aave V3 only, with faucet
 * assets that have no value. Which one a caller is on arrives as an explicit
 * `OpenChainConfig` (see `openChainConfig`) rather than module state, so a
 * mid-flight chain switch cannot re-target an executing sequence.
 */

import type { LiveProtocol } from "./live";
import type { ContractClient } from "./exit";
import type { ChainMode } from "./chainMode";
import { SCORING_CHAINS } from "../../../packages/scoring/src/chains";
// The protocol naming table, imported here rather than re-typed: the sentences
// below are rendered, and a raw `aave_v3` in one of them is the enum leak the
// table exists to stop. It imports only leaf modules, so this direction adds no
// cycle (`chainMode.ts` -> `openProtocols.ts` would have added one, which is
// why the open policy lives here beside the config it reads).
import { PROTOCOL_LABEL } from "./utils";

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

// ── Base Sepolia ───────────────────────────────────────────────────────────

// The Sepolia market addresses are NOT written down here: the scoring package
// already carries them, verified live and dated (`SCORING_CHAINS.testnet`),
// and two copies of one deployment is how the open flow ends up signing at a
// pool the scores no longer read. The tests still pin the literal addresses,
// so a drift in the scoring table is caught rather than inherited silently.
export const OPEN_CHAIN_ID_SEPOLIA: number = SCORING_CHAINS.testnet.chainId; // 84532

export const AAVE_POOL_SEPOLIA = SCORING_CHAINS.testnet.aave.pool as `0x${string}`;

/**
 * Aave's Base Sepolia test-asset faucet. `isPermissioned()` is false, so anyone
 * may call `mint(asset, to, amount)`. Not part of the scoring table - scoring
 * never mints - so this is the one Sepolia address written down here.
 *
 * Minting always goes through the faucet, never the asset: the Sepolia reserve
 * contracts are Ownable BY the faucet, so a direct `mint` on the asset reverts.
 */
export const FAUCET_SEPOLIA: `0x${string}` = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc";

/** A reserve from the scoring table's Sepolia market, by its own symbol key. */
function testnetReserve(symbol: string): { address: `0x${string}`; decimals: number } {
  const r = SCORING_CHAINS.testnet.aave.reserves.find((x) => x.symbol === symbol);
  if (!r) throw new Error(`scoring testnet reserves missing ${symbol}`);
  return { address: r.address as `0x${string}`, decimals: r.decimals };
}

/**
 * The only two Sepolia reserves the open flow touches: it supplies USDC and
 * borrows USDT.
 *
 * WETH is deliberately absent. Base Sepolia's WETH is the OP-stack predeploy at
 * 0x4200000000000000000000000000000000000006, which the faucet does not own and
 * therefore cannot mint - offering it would dead-end every testnet user without
 * a pre-funded balance.
 *
 * Note the two "USDC" contracts on Base Sepolia: match assets by ADDRESS,
 * lowercased. A symbol does not identify an asset across chains.
 */
export const SEPOLIA_OPEN_ASSETS: Record<string, { address: `0x${string}`; decimals: number }> = {
  USDC: testnetReserve("USDC"),
  USDT: testnetReserve("USDT"),
};

/**
 * Collateral symbols openable in-app per protocol on Base Sepolia. Only Aave V3
 * has a deployment worth opening against: Morpho Blue's contract exists on
 * Sepolia but carries no markets, and Moonwell and Compound V3 are not
 * configured there at all. The other three are proven by the mainnet fork suite
 * and stay mainnet-only - the same asymmetry `EXECUTABLE_PROTOCOLS` in
 * `lib/exit.ts` records for exits.
 */
export const SEPOLIA_OPENABLE_SYMBOLS: Record<LiveProtocol, string[]> = {
  aave_v3: ["USDC"],
  moonwell: [],
  compound_v3: [],
  morpho: [],
};

// ── Per-chain configuration ────────────────────────────────────────────────

/**
 * Everything the open builders need that differs between chains. Passed
 * explicitly into every builder and reader: there is no module-level "current
 * chain", because a user flipping the app's chain mode while a sequence is
 * mid-flight must not re-point the remaining steps at another chain.
 */
export interface OpenChainConfig {
  chainId: number;
  /**
   * This chain in the product's own words, from the scoring table that already
   * names it. Every sentence built below prints this and never the mode string:
   * "testnet" is an internal value, not a chain name a user should read.
   */
  label: string;
  aavePool: `0x${string}`;
  /**
   * AaveOracle for this market, from the scoring table - the same oracle the
   * scores are priced from, so an open is sized by the numbers the user has
   * been shown. `chains.ts` documents the on-chain re-derivation for the day
   * either market is redeployed.
   */
  aaveOracle: `0x${string}`;
  /** Test-asset faucet, or null on a chain where assets have real value. */
  faucet: `0x${string}` | null;
  /** Symbol of the asset the borrow leg draws, keyed into `tokens`. */
  borrowSymbol: string;
  tokens: Record<string, { address: `0x${string}`; decimals: number }>;
  openable: Record<LiveProtocol, string[]>;
}

/**
 * A `Record` over `ChainMode` rather than a ternary so a third mode is a
 * compile error here, not a silent fall-through to the config holding real
 * funds.
 */
const OPEN_CONFIGS: Record<ChainMode, OpenChainConfig> = {
  mainnet: {
    chainId: OPEN_CHAIN_ID,
    label: SCORING_CHAINS.mainnet.label,
    aavePool: AAVE_POOL,
    aaveOracle: SCORING_CHAINS.mainnet.aave.oracle as `0x${string}`,
    faucet: null,
    borrowSymbol: "USDC",
    tokens: OPEN_TOKENS,
    openable: OPENABLE_SYMBOLS,
  },
  testnet: {
    chainId: OPEN_CHAIN_ID_SEPOLIA,
    label: SCORING_CHAINS.testnet.label,
    aavePool: AAVE_POOL_SEPOLIA,
    aaveOracle: SCORING_CHAINS.testnet.aave.oracle as `0x${string}`,
    faucet: FAUCET_SEPOLIA,
    borrowSymbol: "USDT",
    tokens: SEPOLIA_OPEN_ASSETS,
    openable: SEPOLIA_OPENABLE_SYMBOLS,
  },
};

/** The open configuration for the chain the app is currently looking at. */
export function openChainConfig(mode: ChainMode): OpenChainConfig {
  return OPEN_CONFIGS[mode];
}

export function isOpenSupported(
  config: OpenChainConfig,
  protocol: LiveProtocol,
  symbol: string,
): boolean {
  return (config.openable[protocol] ?? []).includes(symbol) && symbol in config.tokens;
}

/**
 * Why this chain cannot open this market, in one sentence, at the point of
 * action.
 *
 * Three surfaces need it and none of them may word it themselves: the disabled
 * button's hover on an Advisor opportunity card, the same button in the popup,
 * and the open modal's dead-end step.
 *
 * The testnet list is READ from `config.openable`, the same table
 * `isOpenSupported` gates on, so the sentence cannot promise a market the flow
 * would then refuse. Chain and protocol names come from the tables that own
 * them, never from the raw ids.
 */
export function openAvailabilityLine(
  mode: ChainMode,
  protocol: LiveProtocol,
  symbol: string,
): string {
  const config = openChainConfig(mode);
  const protocolLabel = PROTOCOL_LABEL[protocol] ?? protocol;
  if (mode === "testnet") {
    const list = (Object.keys(config.openable) as LiveProtocol[])
      .filter((p) => (config.openable[p] ?? []).length > 0)
      .map((p) => `${(config.openable[p] ?? []).join(", ")} on ${PROTOCOL_LABEL[p] ?? p}`)
      .join("; ");
    return (
      `In-app opening on ${config.label} is limited to ${list}.` +
      ` Use the protocol's own app for ${symbol} on ${protocolLabel}.`
    );
  }
  return (
    `In-app opening for ${symbol} on ${protocolLabel} is not yet address-verified.` +
    ` Use the protocol's own app for now.`
  );
}

/**
 * Whether an open control may be pressed, and what to say on hover when it may
 * not.
 *
 * The same composition `exitControlState` is for exits, and it exists for the
 * same reason: one policy decision ("is this control live, and why not") that N
 * surfaces offer as the same button. The Advisor panel and the Advisor popup
 * both offer this open, and until this existed they gated it on `onOpen` alone,
 * so a market the chain cannot open rendered a live button that dead-ended in
 * the modal's unsupported screen.
 *
 * Check order matters. The chain not carrying the market is the reason the user
 * can act on (switch chain, or use the protocol's app); an absent handler means
 * the flow is not wired into that surface at all, which is a different sentence
 * and never the one to show when the market is unsupported anyway.
 */
export function openControlState(
  handler: unknown,
  mode: ChainMode,
  protocol: LiveProtocol,
  symbol: string,
): { enabled: boolean; hint: string | undefined } {
  if (!isOpenSupported(openChainConfig(mode), protocol, symbol)) {
    return { enabled: false, hint: openAvailabilityLine(mode, protocol, symbol) };
  }
  if (!handler) {
    return { enabled: false, hint: "In-app opening ships with the position flows" };
  }
  return { enabled: true, hint: undefined };
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

/** Aave's test-asset faucet. Test chains only - `config.faucet` is null otherwise. */
export const OPEN_FAUCET_ABI = [
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isPermissioned",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

/**
 * How much has to be minted to cover `needed`, in the asset's own units.
 *
 * Zero when the balance already covers it, so a retry after a reverted borrow
 * mints nothing: the caller re-reads the live balance every attempt rather than
 * recording the mint in the resume cursor.
 */
export function faucetDeficit(balance: bigint, needed: bigint): bigint {
  return balance >= needed ? 0n : needed - balance;
}

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
  /** The chain this plan executes on. Explicit: see `OpenChainConfig`. */
  config: OpenChainConfig;
  protocol: LiveProtocol;
  collateralSymbol: string;
  /** Collateral amount in token units. */
  collateralAmount: bigint;
  /**
   * Borrow amount in the units of `config.borrowSymbol` (USDC on mainnet, USDT
   * on Base Sepolia); 0n = collateral-only open.
   */
  borrowAmount: bigint;
  user: `0x${string}`;
  /** Required for morpho only (from /api/morpho/market). */
  morphoMarket?: MorphoMarketParams;
}

/** The asset the borrow leg draws, resolved from the chain's own table. */
export function borrowAsset(config: OpenChainConfig): { address: `0x${string}`; decimals: number } {
  const asset = config.tokens[config.borrowSymbol];
  if (!asset) throw new Error(`unknown borrow asset ${config.borrowSymbol}`);
  return asset;
}

/**
 * The non-Aave builders carry hardcoded Base mainnet addresses (Comet, the
 * Moonwell mTokens, Morpho Blue). Building them against another chain's config
 * would send funds to whatever happens to sit at those addresses there, so it
 * is an error rather than a silent mainnet fallback.
 */
function assertMainnetOnly(config: OpenChainConfig, protocol: LiveProtocol): void {
  if (config.chainId !== OPEN_CHAIN_ID) {
    throw new Error(`${protocol} opens are not configured on chain ${config.chainId}`);
  }
}

/**
 * Read the collateral asset's USD price (8 decimals) from the Aave oracle -
 * one canonical price source for USD -> token-unit conversion in the UI.
 *
 * The oracle address comes from the config (the scoring table's verified
 * entry) rather than being re-discovered through ADDRESSES_PROVIDER on every
 * open: two RPC round trips per attempt bought nothing the table does not
 * already guarantee, and the price now provably comes from the same oracle
 * that priced the scores on screen.
 */
export async function readCollateralPriceUsd8(
  client: ContractClient,
  config: OpenChainConfig,
  symbol: string,
): Promise<bigint> {
  const token = config.tokens[symbol];
  if (!token) throw new Error(`unknown token ${symbol}`);
  return (await client.readContract({
    address: config.aaveOracle,
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
  const { config } = input;
  if (input.protocol !== "aave_v3") assertMainnetOnly(config, input.protocol);
  const borrow = borrowAsset(config);
  if (input.protocol === "compound_v3") {
    const base = (await client.readContract({
      address: COMET_USDC,
      abi: OPEN_COMET_ABI,
      functionName: "baseToken",
    })) as string;
    if (base.toLowerCase() !== borrow.address.toLowerCase()) {
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
    if (underlying.toLowerCase() !== config.tokens[input.collateralSymbol]!.address.toLowerCase()) {
      throw new Error("Moonwell mToken underlying mismatch - aborting");
    }
    // The borrow leg targets a DIFFERENT mToken than the collateral leg. The
    // UI borrows the config's borrow asset and scales by ITS decimals, so an
    // mToken whose underlying is anything else would borrow the wrong asset
    // and the wrong amount.
    const mBorrow = MOONWELL_MTOKENS[config.borrowSymbol];
    if (!mBorrow) throw new Error(`no verified Moonwell ${config.borrowSymbol} market`);
    const borrowUnderlying = (await client.readContract({
      address: mBorrow,
      abi: OPEN_MTOKEN_ABI,
      functionName: "underlying",
    })) as string;
    if (borrowUnderlying.toLowerCase() !== borrow.address.toLowerCase()) {
      throw new Error(`Moonwell ${config.borrowSymbol} mToken underlying mismatch - aborting`);
    }
  }
  if (input.protocol === "morpho") {
    const mp = input.morphoMarket;
    if (!mp) throw new Error("Morpho market params missing");
    if (
      mp.collateralToken.toLowerCase() !==
      config.tokens[input.collateralSymbol]!.address.toLowerCase()
    ) {
      throw new Error("Morpho market collateral mismatch - aborting");
    }
    // Same reasoning as Moonwell's borrow mToken: a market whose loan token is
    // anything but the config's borrow asset would borrow the wrong asset.
    if (mp.loanToken.toLowerCase() !== borrow.address.toLowerCase()) {
      throw new Error("Morpho market loan token mismatch - aborting");
    }
  }
}

/** Build the ordered transaction steps for an in-app open. */
export function buildOpenSteps(input: OpenPlanInput): OpenTxStep[] {
  const { config, protocol, collateralSymbol, collateralAmount, borrowAmount, user } = input;
  const collateral = config.tokens[collateralSymbol];
  if (!collateral) throw new Error(`unknown collateral ${collateralSymbol}`);
  const borrow = borrowAsset(config);
  const steps: OpenTxStep[] = [];

  if (protocol === "aave_v3") {
    steps.push({
      label: `Approve ${collateralSymbol}`,
      address: collateral.address,
      abi: OPEN_ERC20_ABI,
      functionName: "approve",
      args: [config.aavePool, collateralAmount],
      kind: "approve",
      spender: config.aavePool,
    });
    steps.push({
      label: `Supply ${collateralSymbol} to Aave V3`,
      address: config.aavePool,
      abi: OPEN_AAVE_POOL_ABI,
      functionName: "supply",
      args: [collateral.address, collateralAmount, user, 0],
      kind: "supply",
    });
    if (borrowAmount > 0n) {
      steps.push({
        label: `Borrow ${config.borrowSymbol}`,
        address: config.aavePool,
        abi: OPEN_AAVE_POOL_ABI,
        functionName: "borrow",
        args: [borrow.address, borrowAmount, 2n, 0, user],
        kind: "borrow",
      });
    }
    return steps;
  }

  assertMainnetOnly(config, protocol);

  if (protocol === "moonwell") {
    const mToken = MOONWELL_MTOKENS[collateralSymbol];
    const mBorrow = MOONWELL_MTOKENS[config.borrowSymbol];
    if (!mToken || !mBorrow) throw new Error(`no verified Moonwell market for ${collateralSymbol}`);
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
        label: `Borrow ${config.borrowSymbol}`,
        address: mBorrow,
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
        label: `Borrow ${config.borrowSymbol} (withdraw base)`,
        address: COMET_USDC,
        abi: OPEN_COMET_ABI,
        functionName: "withdraw",
        args: [borrow.address, borrowAmount],
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
      label: `Borrow ${config.borrowSymbol}`,
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
