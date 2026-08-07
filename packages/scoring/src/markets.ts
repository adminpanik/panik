/**
 * Static market parameters for prospective-mode scoring (Compass scenarios).
 *
 * ⚠️ v1 values are reasonable approximations of Base-mainnet listings.
 * Slice 2 MUST replace them with on-chain reads (Aave PoolDataProvider /
 * Moonwell mToken collateralFactor) before active mode ships — prospective
 * estimates may be slightly off until then, which is acceptable for
 * "what if" scenarios but not for live positions.
 */

import type { Protocol } from "./types";

export interface AssetMarketParams {
  /** Max borrow LTV, 0–1. */
  maxLtv: number;
  /** Liquidation threshold, 0–1 (Compound-style protocols: = collateral factor). */
  liquidationThreshold: number;
  /** CoinGecko asset id for price history. */
  coingeckoId: string;
}

export const MARKETS: Record<Protocol, Record<string, AssetMarketParams>> = {
  aave_v3: {
    WETH: { maxLtv: 0.8, liquidationThreshold: 0.83, coingeckoId: "ethereum" },
    wstETH: { maxLtv: 0.75, liquidationThreshold: 0.79, coingeckoId: "wrapped-steth" },
    USDC: { maxLtv: 0.75, liquidationThreshold: 0.78, coingeckoId: "usd-coin" },
    cbBTC: { maxLtv: 0.73, liquidationThreshold: 0.78, coingeckoId: "coinbase-wrapped-btc" },
  },
  moonwell: {
    WETH: { maxLtv: 0.81, liquidationThreshold: 0.81, coingeckoId: "ethereum" },
    USDC: { maxLtv: 0.83, liquidationThreshold: 0.83, coingeckoId: "usd-coin" },
    cbETH: { maxLtv: 0.73, liquidationThreshold: 0.73, coingeckoId: "coinbase-wrapped-staked-eth" },
  },
  // Morpho Blue: per-market LLTV from the governance-approved set; borrowing is
  // allowed up to LLTV (no separate maxLtv). 0.86 is the common WETH-collateral
  // tier on Base. Per-market verification lands with the active reader.
  morpho: {
    WETH: { maxLtv: 0.86, liquidationThreshold: 0.86, coingeckoId: "ethereum" },
    wstETH: { maxLtv: 0.86, liquidationThreshold: 0.86, coingeckoId: "wrapped-steth" },
    cbBTC: { maxLtv: 0.86, liquidationThreshold: 0.86, coingeckoId: "coinbase-wrapped-btc" },
  },
  // Compound V3 (Comet, cUSDCv3 on Base): borrowCF < liquidationCF per collateral.
  compound_v3: {
    WETH: { maxLtv: 0.78, liquidationThreshold: 0.84, coingeckoId: "ethereum" },
    cbETH: { maxLtv: 0.75, liquidationThreshold: 0.8, coingeckoId: "coinbase-wrapped-staked-eth" },
    cbBTC: { maxLtv: 0.7, liquidationThreshold: 0.77, coingeckoId: "coinbase-wrapped-btc" },
  },
};

/** DefiLlama protocol slugs for systemic-risk lookups (verified live 2026-06-13). */
export const PROTOCOL_DEFILLAMA_SLUG: Record<Protocol, string> = {
  aave_v3: "aave-v3",
  moonwell: "moonwell",
  morpho: "morpho", // parent slug — $6.6B aggregate
  compound_v3: "compound-v3", // $1.05B
};

/**
 * Symbol → CoinGecko id for active-mode collateral discovered on-chain.
 * Unknown symbols degrade to a WETH proxy in the adapter (flagged on the
 * score, never silent).
 */
export const SYMBOL_TO_COINGECKO: Record<string, string> = {
  WETH: "ethereum",
  ETH: "ethereum",
  wstETH: "wrapped-steth",
  cbETH: "coinbase-wrapped-staked-eth",
  rETH: "rocket-pool-eth",
  weETH: "wrapped-eeth",
  USDC: "usd-coin",
  USDbC: "bridged-usd-coin-base",
  USDT: "tether",
  DAI: "dai",
  USDS: "usds",
  EURC: "euro-coin",
  cbBTC: "coinbase-wrapped-btc",
  tBTC: "tbtc",
  LBTC: "lombard-staked-btc",
  AERO: "aerodrome-finance",
  WELL: "moonwell-artemis",
};
