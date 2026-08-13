/**
 * Chain-read plumbing for active mode (SYSTEM_ARCHITECTURE §3.4).
 * Base mainnet addresses + minimal ABIs. The readers depend on a structural
 * subset of viem's PublicClient so tests can stub it with a plain object.
 */

import { parseAbi } from "viem";

/** Structural subset of viem's PublicClient used by the readers. */
export interface PublicClientLike {
  multicall(args: {
    contracts: readonly unknown[];
    allowFailure: true;
  }): Promise<{ status: "success" | "failure"; result?: unknown }[]>;
  readContract(args: unknown): Promise<unknown>;
}

// ── Base mainnet addresses ────────────────────────────────────────────────
export const AAVE_POOL_BASE = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const;
/**
 * AaveOracle for the Base market. Resolved on-chain 2026-08-09 from the pool
 * itself: `Pool.ADDRESSES_PROVIDER()` -> 0xe20fCBdBff…ad64D ->
 * `getPriceOracle()`. Re-derive it the same way if Aave migrates the market.
 *
 * Prices are quoted in the market's base currency: `BASE_CURRENCY_UNIT()`
 * returns 1e8, the SAME 8-decimal USD base as `getUserAccountData`'s
 * totalCollateralBase, so the two are directly comparable.
 */
export const AAVE_ORACLE_BASE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156" as const;
/** Verified live 2026-06-13: getAllMarkets() returns 21 markets. */
export const MOONWELL_COMPTROLLER_BASE =
  "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as const;

/** Aave V3 reserves we track for collateral discovery (underlying tokens). */
export const KNOWN_AAVE_RESERVES = [
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
] as const;

// ── ABIs (minimal, human-readable) ────────────────────────────────────────
export const aavePoolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

/**
 * Per-asset, not `getAssetsPrices(address[])`: the batched call reverts as a
 * whole if any one asset has no usable source, which would cost every reserve
 * its price. One call per asset lets `allowFailure` degrade just the asset
 * that lost its feed.
 */
export const aaveOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
]);

export const comptrollerAbi = parseAbi([
  "function getAssetsIn(address account) view returns (address[])",
  "function markets(address mToken) view returns (bool isListed, uint256 collateralFactorMantissa)",
  "function oracle() view returns (address)",
]);

export const mTokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function borrowBalanceStored(address account) view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function underlying() view returns (address)",
]);

export const oracleAbi = parseAbi([
  "function getUnderlyingPrice(address mToken) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// ── Compound V3 (Comet) — Base mainnet ────────────────────────────────────
/** Symbols verified on-chain 2026-06-13 (cUSDCv3 / cWETHv3). */
export const COMETS_BASE = [
  {
    address: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    baseSymbol: "USDC",
    /** getPrice() values are denominated in USD for this market. */
    priceInEth: false,
  },
  {
    address: "0x46e6b214b524310239732D51387075E0e70970bf",
    baseSymbol: "WETH",
    /** getPrice() values are ETH-denominated — convert via ETH/USD feed. */
    priceInEth: true,
  },
] as const;

/**
 * Chainlink ETH/USD on Base (verified via description() 2026-06-13).
 * The staleness POLICY for this feed lives in providers/chainlink.ts
 * (`ETH_USD_FEED_BASE`); read it through `ChainlinkPriceReader`, never with a
 * private aggregator ABI and a private age bound.
 */
export const CHAINLINK_ETH_USD_BASE =
  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;

export const cometAbi = parseAbi([
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
  "function userCollateral(address account, address asset) view returns (uint128 balance, uint128 reserved)",
  // `assetsIn` is Comet's own bitmask over userCollateral: bit i is set when
  // asset i's balance becomes non-zero and cleared when it returns to zero. So
  // a zero mask IS "this wallet holds no collateral in this market", readable
  // in the same batch as the borrow balance instead of costing a second one.
  "function userBasic(address account) view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function baseTokenPriceFeed() view returns (address)",
  "function baseScale() view returns (uint64)",
  "function getPrice(address priceFeed) view returns (uint128)",
]);
