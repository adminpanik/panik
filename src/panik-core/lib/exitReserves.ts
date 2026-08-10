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
 *
 * ## Why the chain resolution lives here too
 *
 * The first fix (PR #48) put the pure intersection here and the two chain reads
 * that feed it inside `ExitFlow`. That left the relayer and the coverage sweep
 * still carrying the hardcoded pair, and the fix had to be made a second time.
 * `resolveExitReserveSet` is the whole answer - reads included - so there is one
 * implementation for the UI, the relayer and the sweep, and no fourth copy to
 * write next time.
 *
 * This module is imported by `server/` and `scripts/` as well as the browser
 * bundle, so it must stay node-safe: it may import `./exit.generated` (plain
 * generated data) but never `./exit`, which pulls in wagmi and
 * `import.meta.env`.
 */

import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
} from "./exit.generated";

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

/** Just the addresses, for a caller that reads per reserve and needs no label. */
export function exitReserveAddresses(set: readonly ExitReserveRef[]): `0x${string}`[] {
  return set.map((r) => r.reserve);
}

// ── chain resolution ─────────────────────────────────────────────────────────

/**
 * The one read shape this needs.
 *
 * Deliberately structural rather than viem's `PublicClient`: wagmi's client, the
 * server's `createPublicClient`, and the narrow `Client` interfaces in
 * server/relayerChain.ts and server/coverageChain.ts all satisfy it, and none of
 * them typecheck against each other under this tsconfig.
 */
export interface ReserveReadClient {
  readContract(params: unknown): Promise<unknown>;
}

/**
 * Which deployment to resolve against. Defaults are the generated deploy config,
 * which is the only market the app is wired to; the fields exist so a test can
 * point at a fork without a second code path.
 */
export interface ExitReserveSetOptions {
  chainId?: number;
  dataProvider?: `0x${string}`;
  executor?: `0x${string}`;
}

/**
 * `getAllReservesTokens` only. The full data-provider ABI lives in `./exit`,
 * which this module cannot import (wagmi, `import.meta.env`). One view fragment
 * is the smaller duplication, and it is the same shape server/relayerChain.ts
 * and server/coverageChain.ts already keep for `getUserReserveData`.
 */
const RESERVE_LIST_ABI = [
  {
    type: "function",
    name: "getAllReservesTokens",
    stateMutability: "view",
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
  },
] as const;

/**
 * Read the market's reserve list and the executor's tracked assets, and
 * intersect them. Always two calls, never per wallet - see `loadExitReserveSet`.
 *
 * Issued together so a batching transport (wagmi's Multicall3, viem's) folds
 * them into one request.
 */
export async function resolveExitReserveSet(
  client: ReserveReadClient,
  options: ExitReserveSetOptions = {},
): Promise<ExitReserveRef[]> {
  const dataProvider = options.dataProvider ?? EXIT_DATA_PROVIDER_ADDRESS;
  const executor = options.executor ?? EXECUTOR_ADDRESS;

  const [marketReserves, tracked] = await Promise.all([
    client.readContract({
      address: dataProvider,
      abi: RESERVE_LIST_ABI,
      functionName: "getAllReservesTokens",
    }) as Promise<readonly MarketReserve[]>,
    // The GENERATED executor ABI: the relayer and this must agree with the
    // contract as deployed, and `npm run sync:exit-config` is what keeps that
    // true.
    client.readContract({
      address: executor,
      abi: EXECUTOR_ABI,
      functionName: "getTrackedAssets",
    }) as Promise<readonly string[]>,
  ]);

  return exitReserveSet(marketReserves, tracked);
}

function cacheKey(options: ExitReserveSetOptions): string {
  const chainId = options.chainId ?? EXIT_CHAIN_ID;
  const dataProvider = (options.dataProvider ?? EXIT_DATA_PROVIDER_ADDRESS).toLowerCase();
  const executor = (options.executor ?? EXECUTOR_ADDRESS).toLowerCase();
  return `${chainId}:${dataProvider}:${executor}`;
}

/** Resolved sets, and the reads currently in flight, both keyed per deployment. */
const resolvedSets = new Map<string, ExitReserveRef[]>();
const inflightSets = new Map<string, Promise<ExitReserveRef[]>>();

/**
 * `resolveExitReserveSet`, resolved at most once per deployment per process.
 *
 * An asset is listed or de-listed by an Aave governance action or an executor
 * admin call. Neither happens while a modal is open, and neither happens between
 * two wallets in the same worker tick - so the worker, which sweeps every
 * watched wallet every 60 seconds, must not pay two RPC calls per wallet per
 * tick to keep learning the same answer.
 *
 * Two things are deliberately NOT cached:
 *
 * - A rejection. A transport failure says nothing about the reserve set, and
 *   pinning it would turn one bad minute into a dead process.
 * - An empty result. Empty means the two lists do not overlap, which is a
 *   misconfiguration somewhere and is worth re-checking rather than pinning for
 *   the process lifetime. The callers treat empty as "cannot verify", never as
 *   "nothing to check".
 *
 * Concurrent callers share one in-flight read, so the first tick over N wallets
 * still costs two calls and not 2N.
 */
export async function loadExitReserveSet(
  client: ReserveReadClient,
  options: ExitReserveSetOptions = {},
): Promise<ExitReserveRef[]> {
  const key = cacheKey(options);

  const hit = resolvedSets.get(key);
  if (hit) return hit;

  const pending = inflightSets.get(key);
  if (pending) return pending;

  const run = resolveExitReserveSet(client, options)
    .then((set) => {
      if (set.length > 0) resolvedSets.set(key, set);
      return set;
    })
    .finally(() => {
      inflightSets.delete(key);
    });

  inflightSets.set(key, run);
  return run;
}

/** Drop the cache. For tests, and for a process that has changed deployment. */
export function clearExitReserveSetCache(): void {
  resolvedSets.clear();
  inflightSets.clear();
}
