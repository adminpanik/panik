/**
 * Which assets an exit is allowed to name, derived from the chain instead of
 * hardcoded.
 *
 * The bug this replaces: `ExitFlow` hardcoded its reserve pair to
 * `{ EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS }` and called
 * `getUserReserveData(EXIT_USDC_ADDRESS, user)` on it. `EXIT_USDC_ADDRESS` is
 * `executor.usdc()` - the token the executor PAYS OUT in, which on Base Sepolia
 * is Circle's USDC. The Aave V3 market there does not list Circle's USDC; it
 * lists its own test USDC at a different address. So that read reverted for
 * every wallet, funded or empty, and the flow could never load a position.
 *
 * Two roles, two addresses, both correct on-chain:
 *
 * - `executor.getTrackedAssets()` - assets a leg may name. Includes the Aave
 *   reserve tokens AND the payout token.
 * - `executor.usdc()` - the swap destination. Never a reserve to read.
 *
 * The intersection of the market's reserve list with the executor's tracked
 * assets is exactly the set this flow can legally act on, and it maintains
 * itself when either side changes.
 *
 * **Address is the identity; symbol is only a label.** Two tokens on Base
 * Sepolia both report `symbol() == "USDC"` (Circle's and Aave's test token), and
 * that ambiguity is what produced the original bug. Nothing here matches on a
 * symbol, and the tests below pin that.
 */

/** One entry of `IPoolDataProvider.getAllReservesTokens()`. */
export interface MarketReserve {
  symbol: string;
  tokenAddress: `0x${string}`;
}

/** A reserve this flow may read and build legs against. */
export interface ExitReserveRef {
  reserve: `0x${string}`;
  /** Display label from the market. Never used to identify the asset. */
  symbol: string;
}

/**
 * Market reserves that the executor is also configured to touch.
 *
 * Kept in the market's own order, carrying the market's own address, because
 * that is the address `getUserReserveData` expects back. Comparison is
 * lowercased: the two sources are independently checksummed and a case
 * difference is not a different token. Duplicates are collapsed so a reserve
 * listed twice cannot produce two legs against one debt.
 */
export function exitReserveSet(
  marketReserves: readonly MarketReserve[],
  trackedAssets: readonly string[],
): ExitReserveRef[] {
  const tracked = new Set(trackedAssets.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const out: ExitReserveRef[] = [];

  for (const { symbol, tokenAddress } of marketReserves) {
    const key = tokenAddress.toLowerCase();
    if (!tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ reserve: tokenAddress, symbol });
  }

  return out;
}
