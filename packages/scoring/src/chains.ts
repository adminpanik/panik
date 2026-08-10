/**
 * Which chain the SCORING path reads.
 *
 * The exit executor is deployed on Base Sepolia (src/panik-core/lib/exit.ts,
 * `EXIT_ENV`), while scores were hardcoded to Base mainnet in the API server.
 * A product that scores one chain and executes on another tells the user about
 * a position the Exit button cannot act on, so the chain is a single piece of
 * configuration here rather than a literal at each call site: the client, the
 * protocol reader set, the Aave market addresses and whether market context is
 * obtainable all come from ONE entry in this table.
 *
 * Base mainnet is the default and is unchanged. Testnet is opt-in via
 * PANIK_SCORING_CHAIN (server) / VITE_SCORING_CHAIN (browser).
 */

import { AAVE_ORACLE_BASE, AAVE_POOL_BASE, KNOWN_AAVE_RESERVES } from "./adapters/chain";
import type { Protocol } from "./types";

export type ScoringChainMode = "mainnet" | "testnet";

/** One Aave V3 reserve: the underlying token the pool lists. */
export interface AaveReserve {
  readonly symbol: string;
  readonly address: string;
  readonly decimals: number;
}

/** The three addresses the Aave reader needs to score a market. */
export interface AaveMarketConfig {
  readonly pool: string;
  /**
   * AaveOracle for this market. Prices are quoted in the market's base
   * currency; both markets below report BASE_CURRENCY_UNIT() = 1e8, the same
   * 8-decimal USD base as `getUserAccountData`, so the two are comparable.
   */
  readonly oracle: string;
  /** Reserves scanned for collateral/debt discovery. */
  readonly reserves: readonly AaveReserve[];
}

/**
 * Whether the market-context providers (CoinGecko volatility, DefiLlama TVL)
 * can describe this chain's assets at all.
 *
 * `unavailable` is not a failure and not a licence to substitute: a testnet's
 * mock USDC has no listing and no TVL, so there is nothing to look up. The
 * adapter then leaves `assetRisk`/`systemicRisk` null and the composite
 * renormalises over the terms it did measure (computeScore.ts). Position health
 * and the USD magnitudes are read from the market's own oracle and stay exact.
 */
export type MarketContextAvailability = "measured" | "unavailable";

export interface ScoringChainConfig {
  readonly mode: ScoringChainMode;
  readonly chainId: number;
  /** Chain name for UI copy. Never a raw mode string. */
  readonly label: string;
  /** Alchemy host prefix, e.g. `base-mainnet` -> base-mainnet.g.alchemy.com. */
  readonly alchemyHost: string;
  /** Env var naming the Alchemy key for this chain. */
  readonly alchemyKeyEnv: string;
  readonly aave: AaveMarketConfig;
  /**
   * Protocols with a market that can actually be READ on this chain. Mirrors
   * the shape of `EXECUTABLE_PROTOCOLS` in src/panik-core/lib/exit.ts, and on
   * testnet it holds the same single entry: Moonwell, Compound and Morpho have
   * no Base Sepolia deployment to read, so the honest answer is to leave them
   * out rather than run a reader against a mainnet address on the wrong chain.
   */
  readonly protocols: readonly Protocol[];
  readonly marketContext: MarketContextAvailability;
}

/**
 * Aave V3 on Base Sepolia. Verified live 2026-08-10 at block 45282198:
 * `Pool.ADDRESSES_PROVIDER()` -> 0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00 ->
 * `getPriceOracle()` returns the oracle below, and `BASE_CURRENCY_UNIT()` is
 * 1e8. Re-derive the same way if the testnet market is redeployed.
 *
 * Reserves are the full `getReservesList()` in pool order, with decimals read
 * from each token. These are Aave's faucet test tokens, NOT the mainnet
 * addresses of the same-named assets.
 */
const AAVE_BASE_SEPOLIA: AaveMarketConfig = {
  pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  oracle: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF",
  reserves: [
    { symbol: "USDC", address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", decimals: 6 },
    { symbol: "USDT", address: "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", decimals: 6 },
    { symbol: "WBTC", address: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", decimals: 8 },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "cbETH", address: "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B", decimals: 18 },
    { symbol: "LINK", address: "0x810D46F9a9027E28F9B01F75E2bdde839dA61115", decimals: 18 },
  ],
};

export const SCORING_CHAINS: Record<ScoringChainMode, ScoringChainConfig> = {
  mainnet: {
    mode: "mainnet",
    chainId: 8453,
    label: "Base",
    alchemyHost: "base-mainnet",
    alchemyKeyEnv: "ALCHEMY_API_KEY_BASE_MAINNET",
    aave: {
      pool: AAVE_POOL_BASE,
      oracle: AAVE_ORACLE_BASE,
      reserves: KNOWN_AAVE_RESERVES,
    },
    protocols: ["aave_v3", "moonwell", "compound_v3", "morpho"],
    marketContext: "measured",
  },
  testnet: {
    mode: "testnet",
    chainId: 84532,
    label: "Base Sepolia",
    alchemyHost: "base-sepolia",
    alchemyKeyEnv: "ALCHEMY_API_KEY_BASE_SEPOLIA",
    aave: AAVE_BASE_SEPOLIA,
    protocols: ["aave_v3"],
    // Aave's faucet tokens are not listed on CoinGecko and the testnet market
    // has no DefiLlama TVL, so neither provider has anything to say about them.
    // See MarketContextAvailability.
    marketContext: "unavailable",
  },
};

/**
 * Parse a configured mode. Anything unrecognised (including undefined) is
 * mainnet: the testnet path must be an explicit, deliberate choice, and a typo
 * must never quietly move a user's scores onto a chain their money is not on.
 */
export function scoringChainMode(raw: string | undefined | null): ScoringChainMode {
  return raw?.trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
}

export function scoringChainConfig(raw: string | undefined | null): ScoringChainConfig {
  return SCORING_CHAINS[scoringChainMode(raw)];
}
