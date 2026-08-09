/**
 * Aave V3 active reader — one batched multicall per wallet.
 * HF/LTV come straight from getUserAccountData (8-dec USD base units);
 * dominant collateral is discovered by ranking aToken balances at AaveOracle
 * prices, read in the same batch as the balances (both are chain reads, so
 * ranking costs no extra round trip and no HTTP call).
 */

import type { PositionHealthInput, Protocol } from "../types";
import {
  AAVE_ORACLE_BASE,
  AAVE_POOL_BASE,
  KNOWN_AAVE_RESERVES,
  type PublicClientLike,
  aaveOracleAbi,
  aavePoolAbi,
  erc20Abi,
} from "./chain";

/** Aave's no-debt sentinel: healthFactor == type(uint256).max. */
const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Common decimal scale the collateral legs are compared on. Every ranking
 * quantity is lifted to it in BigInt, so an 18-decimal whale balance keeps
 * every wei: `Number()` on a raw balance loses precision above 2^53 and this
 * is the comparison that picks the asset the whole advisor chain acts on.
 * Must be >= the largest `decimals` in KNOWN_AAVE_RESERVES (currently 18).
 */
const RANK_DECIMALS = 18;

export interface ActiveReading {
  protocol: Protocol;
  /**
   * HF / LTV / maxLtv. These are RATIOS of same-denominated quantities, so
   * they survive a missing USD price entirely — a reader that cannot value
   * the position in dollars must still report them (see
   * `usdValuesUnavailable`), never drop the leg.
   */
  positionHealth: PositionHealthInput;
  /** null when the USD denomination could not be established this read. */
  collateralValueUsd: number | null;
  /** null when the USD denomination could not be established this read. */
  borrowValueUsd: number | null;
  /**
   * True when a price input the USD conversion depends on was missing or
   * stale. The position is STILL scored (HF/LTV are denomination-free); only
   * the dollar magnitudes are withheld. Consumers must treat this as
   * "degraded", not as "safe": the minimum-borrow materiality gate is waived
   * and the UI/advisor must say the prices are degraded.
   */
  usdValuesUnavailable?: boolean;
  /** Dominant collateral symbol, or null when discovery failed. */
  dominantCollateralSymbol: string | null;
  /**
   * True when the dominant collateral was picked WITHOUT per-asset prices, by
   * ranking decimal-normalised token amounts instead. The pick may then favour
   * a large balance of a cheap asset, and it drives the scored asset,
   * `safestAlternativeProtocol` and the ExitFlow prefill — so it is surfaced,
   * never silently substituted.
   */
  dominantCollateralUnpriced?: boolean;
}

/** One reserve's aToken position, in the units the ranking compares. */
interface CollateralLeg {
  symbol: string;
  /** balance × 10^(RANK_DECIMALS − decimals). Zero-balance legs are dropped. */
  amount: bigint;
  /** Oracle price in base-currency units (1e8 = $1), or null when unreadable. */
  price: bigint | null;
}

export class AaveActiveReader {
  constructor(
    private readonly client: PublicClientLike,
    private readonly pool: string = AAVE_POOL_BASE,
    private readonly oracle: string = AAVE_ORACLE_BASE,
  ) {}

  /** Returns null when the wallet has no Aave position at all. */
  async read(wallet: string): Promise<ActiveReading | null> {
    const first = await this.client.multicall({
      allowFailure: true,
      contracts: [
        {
          address: this.pool,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [wallet],
        },
        ...KNOWN_AAVE_RESERVES.map((r) => ({
          address: this.pool,
          abi: aavePoolAbi,
          functionName: "getReserveData",
          args: [r.address],
        })),
      ],
    });

    const account = first[0];
    if (!account || account.status !== "success") {
      throw new Error(`Aave getUserAccountData failed for ${wallet}`);
    }
    const [totalCollateralBase, totalDebtBase, , , ltvBps, healthFactor] =
      account.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

    if (totalCollateralBase === 0n && totalDebtBase === 0n) return null;

    // Zero-debt sentinel: never feed uint256.max into the formula (§3.4).
    const hf =
      totalDebtBase === 0n || healthFactor === UINT256_MAX
        ? null
        : Number(healthFactor) / 1e18;

    const collateralValueUsd = Number(totalCollateralBase) / 1e8;
    const borrowValueUsd = Number(totalDebtBase) / 1e8;

    // Collateral discovery: aToken balances on the known reserves.
    const aTokens = KNOWN_AAVE_RESERVES.map((reserve, i) => {
      const res = first[i + 1];
      if (!res || res.status !== "success") return null;
      const data = res.result as { aTokenAddress: string };
      return { reserve, aToken: data.aTokenAddress };
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    let dominantCollateralSymbol: string | null = null;
    let dominantCollateralUnpriced = false;
    if (aTokens.length > 0) {
      // Balances and prices ride the SAME multicall: the price is a read on the
      // AaveOracle the pool itself names, so ranking costs one extra call per
      // reserve in a batch that was already round-tripping, and no HTTP call.
      const reads = await this.client.multicall({
        allowFailure: true,
        contracts: [
          ...aTokens.map(({ aToken }) => ({
            address: aToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          })),
          ...aTokens.map(({ reserve }) => ({
            address: this.oracle,
            abi: aaveOracleAbi,
            functionName: "getAssetPrice",
            args: [reserve.address],
          })),
        ],
      });

      const legs: CollateralLeg[] = [];
      aTokens.forEach(({ reserve }, i) => {
        const balance = reads[i];
        if (!balance || balance.status !== "success") return;
        const raw = balance.result as bigint;
        if (raw === 0n) return;
        const price = reads[aTokens.length + i];
        legs.push({
          symbol: reserve.symbol,
          amount: raw * 10n ** BigInt(RANK_DECIMALS - reserve.decimals),
          price:
            price && price.status === "success" && (price.result as bigint) > 0n
              ? (price.result as bigint)
              : null,
        });
      });

      // Ranking is by real oracle value: balance × price, in BigInt, on one
      // decimal scale. The hardcoded price classes this replaced could not
      // separate wstETH from WETH at all (they shared a class, though wstETH
      // trades ~1.24× WETH) and drifted arbitrarily far across classes.
      //
      // When any competing leg has lost its price the value comparison is not
      // available, so the whole ranking falls back to decimal-normalised token
      // AMOUNTS - a stated, uniform rule - and the reading says so. Inventing a
      // constant for the missing price would be a guess presented as a fact.
      // A single candidate needs no comparison, so it is not a degraded pick.
      const anyUnpriced = legs.some((l) => l.price === null);
      dominantCollateralUnpriced = anyUnpriced && legs.length > 1;
      const rankOf = (leg: CollateralLeg): bigint =>
        anyUnpriced ? leg.amount : leg.amount * (leg.price as bigint);
      dominantCollateralSymbol =
        legs.reduce<CollateralLeg | null>(
          (best, leg) => (best === null || rankOf(leg) > rankOf(best) ? leg : best),
          null,
        )?.symbol ?? null;
    }

    return {
      protocol: "aave_v3",
      positionHealth: {
        healthFactor: hf,
        currentLtv:
          collateralValueUsd > 0 ? borrowValueUsd / collateralValueUsd : 0,
        maxLtv: Number(ltvBps) / 10_000,
      },
      collateralValueUsd,
      borrowValueUsd,
      dominantCollateralSymbol,
      ...(dominantCollateralUnpriced ? { dominantCollateralUnpriced: true } : {}),
    };
  }
}
