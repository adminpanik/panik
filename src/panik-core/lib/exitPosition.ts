/**
 * One wallet's Aave V3 position, read from the chain in the shape the leg
 * builder wants.
 *
 * Split out of `ExitFlow` when a second surface needed the same reads: the
 * pre-authorization card in Settings sizes its approvals from the same debt and
 * the same deposit balances the exit would, and two copies of this loop are two
 * chances to disagree about what a user's position is.
 *
 * The rule it carries with it: a reserve the market will not answer for is
 * REPORTED, never skipped. Legs (or approvals) built from a partial view cover
 * what could be read and quietly leave the rest, under a screen saying the user
 * is set up. Refusing is the only honest option, and the caller needs the
 * symbols to say which ones.
 *
 * Browser-only, unlike `./exitReserves`: it reaches `./exit` for the ABIs, and
 * that module reads `import.meta.env`.
 */

import {
  asContractClient,
  EXIT_DATA_PROVIDER_ABI,
  EXIT_ERC20_ABI,
  EXIT_NETWORK_LABEL,
  type ContractClient,
} from "./exit";
import { EXIT_DATA_PROVIDER_ADDRESS } from "./exit.generated";
import { classifyExitError } from "./exitRpc";
import { loadExitReserveSet } from "./exitReserves";
import type { ExitReserveState } from "./exitLegs";

export interface UserReserveRead {
  /** Reserves the market answered for, in the market's own order. */
  reserves: ExitReserveState[];
  /**
   * Symbols the market would not answer for. Non-empty means the view of this
   * wallet is incomplete and nothing may be promised about it.
   */
  unreadable: string[];
  /**
   * True when no asset is both listed by the market and enabled for exits, so
   * there is nothing to act on at all. A deployment problem, not a wallet one.
   */
  noCoverage: boolean;
}

/**
 * Read every exitable reserve for `owner`.
 *
 * Every read is issued in one tick rather than awaited in sequence: they have
 * no dependency on each other, and wagmi's Multicall3 batching folds them into
 * a single request against a rate-limited node.
 *
 * Decimals come from each token, never from the symbol: the repay is
 * denominated in the debt asset, and a WETH amount scaled by 10^6 is off by
 * twelve orders of magnitude.
 *
 * A transport failure is rethrown rather than blamed on a reserve. It says
 * nothing about that particular asset, and telling a user "we cannot read your
 * WETH position" when the truth is "we cannot reach the chain" sends them to
 * retry the wrong thing.
 */
export async function readUserReserves(
  client: ContractClient,
  owner: `0x${string}`,
): Promise<UserReserveRead> {
  const known = await loadExitReserveSet(client);
  if (known.length === 0) return { reserves: [], unreadable: [], noCoverage: true };

  const unreadable: string[] = [];
  const readings = await Promise.all(
    known.map(async ({ reserve, symbol }): Promise<ExitReserveState | null> => {
      try {
        const [userReserve, rawDecimals] = await Promise.all([
          client.readContract({
            address: EXIT_DATA_PROVIDER_ADDRESS,
            abi: EXIT_DATA_PROVIDER_ABI,
            functionName: "getUserReserveData",
            args: [reserve, owner],
          }) as Promise<[bigint, bigint, bigint]>,
          client.readContract({
            address: reserve,
            abi: EXIT_ERC20_ABI,
            functionName: "decimals",
          }),
        ]);
        const [aBal, stableDebt, varDebt] = userReserve;
        return {
          reserve,
          symbol,
          // uint8 token metadata, not a wei amount - the one place `Number` is
          // safe on a chain read here.
          decimals: Number(rawDecimals),
          aBalance: aBal,
          debt: stableDebt + varDebt,
        };
      } catch (err) {
        const failure = classifyExitError(err, EXIT_NETWORK_LABEL);
        if (failure.kind === "network") throw err;
        console.error(
          `[exit] reserve ${symbol} (${reserve}) is unreadable on ${EXIT_NETWORK_LABEL}:`,
          failure.detail,
        );
        unreadable.push(symbol);
        return null;
      }
    }),
  );

  return {
    reserves: readings.filter((r): r is ExitReserveState => r !== null),
    unreadable,
    noCoverage: false,
  };
}

/** `asContractClient`, re-exported so a caller needs one import for the pair. */
export { asContractClient };
