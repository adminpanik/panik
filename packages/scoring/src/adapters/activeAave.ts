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
   * Collateral-value-weighted liquidation threshold, as a FRACTION in 0..1
   * (0.83 = the position liquidates once debt reaches 83% of collateral).
   * Like HF/LTV it is a ratio, so it survives a missing USD price.
   *
   * null when the protocol read could not establish it — never 0. Zero is a
   * real threshold meaning "liquidates against any debt at all", and
   * `collateralFundedRepayToTargetHf` acts on the number it is handed: fed 0
   * for an unknown it silently answers the wallet-funded question instead and
   * under-sizes the repay.
   *
   * Per-protocol source:
   *  - Aave V3: `currentLiquidationThreshold` from getUserAccountData (bps).
   *  - Compound V3: Σ(collateral_i × liquidateCollateralFactor_i) / collateral,
   *    pooled across comets. Distinct from `maxLtv`, which weights the strictly
   *    lower borrowCollateralFactor.
   *  - Moonwell: Compound-V2 fork, one collateralFactorMantissa per market is
   *    BOTH the borrow limit and the liquidation threshold, so it equals maxLtv.
   *  - Morpho: `lltv` IS the liquidation threshold (Blue has no separate borrow
   *    LTV), so it equals maxLtv.
   *
   * Consumed by the Deleverager's `collateralFundedRepayToTargetHf`, which is
   * dormant until the flash-loan flow ships.
   */
  weightedLiquidationThreshold: number | null;
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
   * Symbol of the largest BORROW on this leg - the asset a repay is actually
   * denominated in - or null when the reader could not establish one.
   *
   * Null is not "USDC". The advisor used to hardcode that symbol, which named
   * the wrong token the moment a wallet borrowed anything else, and the repay
   * flow acts on this: it decides which token the user is told to hold, and
   * which token the approval is for. An unknown stays unknown.
   *
   * Ranked by the same rule as the collateral side (value at the protocol's own
   * oracle, degrading to decimal-normalised amounts when a competing leg has
   * lost its price), so the two picks cannot disagree about what "dominant"
   * means.
   */
  dominantBorrowSymbol: string | null;
  /**
   * True when the dominant collateral was picked WITHOUT per-asset prices, by
   * ranking decimal-normalised token amounts instead. The pick may then favour
   * a large balance of a cheap asset, and it drives the scored asset,
   * `safestAlternativeProtocol` and the ExitFlow prefill — so it is surfaced,
   * never silently substituted.
   */
  dominantCollateralUnpriced?: boolean;
}

/**
 * One reserve's position on one side of the book, in the units the ranking
 * compares. Collateral and debt use the SAME shape and the same `dominantOf`
 * rule, so the two sides cannot drift into different definitions of "largest".
 */
interface RankedLeg {
  symbol: string;
  /** balance × 10^(RANK_DECIMALS − decimals). Zero-balance legs are dropped. */
  amount: bigint;
  /** Oracle price in base-currency units (1e8 = $1), or null when unreadable. */
  price: bigint | null;
}

/**
 * Largest leg by oracle value, with the ranking degrading to decimal-normalised
 * token AMOUNTS when any competing leg has lost its price - a stated, uniform
 * rule, rather than a made-up constant standing in for the missing price. A
 * single candidate needs no comparison, so it is not a degraded pick.
 */
function dominantOf(legs: RankedLeg[]): { symbol: string | null; unpriced: boolean } {
  const anyUnpriced = legs.some((l) => l.price === null);
  const rankOf = (leg: RankedLeg): bigint =>
    anyUnpriced ? leg.amount : leg.amount * (leg.price as bigint);
  const best = legs.reduce<RankedLeg | null>(
    (acc, leg) => (acc === null || rankOf(leg) > rankOf(acc) ? leg : acc),
    null,
  );
  return { symbol: best?.symbol ?? null, unpriced: anyUnpriced && legs.length > 1 };
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
    // Tuple order: collateral, debt, availableBorrows, liquidationThreshold,
    // ltv, healthFactor. Both threshold slots are bps of collateral VALUE, so
    // they are already the weighted averages Aave applies to the whole account.
    const [totalCollateralBase, totalDebtBase, , liqThresholdBps, ltvBps, healthFactor] =
      account.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

    if (totalCollateralBase === 0n && totalDebtBase === 0n) return null;

    // Zero-debt sentinel: never feed uint256.max into the formula (§3.4).
    const hf =
      totalDebtBase === 0n || healthFactor === UINT256_MAX
        ? null
        : Number(healthFactor) / 1e18;

    const collateralValueUsd = Number(totalCollateralBase) / 1e8;
    const borrowValueUsd = Number(totalDebtBase) / 1e8;

    // Position discovery: aToken and debt-token balances on the known reserves.
    const tokens = KNOWN_AAVE_RESERVES.map((reserve, i) => {
      const res = first[i + 1];
      if (!res || res.status !== "success") return null;
      const data = res.result as {
        aTokenAddress: string;
        stableDebtTokenAddress: string;
        variableDebtTokenAddress: string;
      };
      return {
        reserve,
        aToken: data.aTokenAddress,
        stableDebt: data.stableDebtTokenAddress,
        variableDebt: data.variableDebtTokenAddress,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    let dominantCollateralSymbol: string | null = null;
    let dominantCollateralUnpriced = false;
    let dominantBorrowSymbol: string | null = null;
    if (tokens.length > 0) {
      // Balances and prices ride the SAME multicall: the price is a read on the
      // AaveOracle the pool itself names, so ranking costs a few extra calls in
      // a batch that was already round-tripping, and no HTTP call. The debt
      // balances are appended LAST so the collateral block's indices are the
      // ones they always were.
      const n = tokens.length;
      const reads = await this.client.multicall({
        allowFailure: true,
        contracts: [
          ...tokens.map(({ aToken }) => ({
            address: aToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          })),
          ...tokens.map(({ reserve }) => ({
            address: this.oracle,
            abi: aaveOracleAbi,
            functionName: "getAssetPrice",
            args: [reserve.address],
          })),
          ...tokens.map(({ variableDebt }) => ({
            address: variableDebt,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          })),
          ...tokens.map(({ stableDebt }) => ({
            address: stableDebt,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          })),
        ],
      });

      const balanceAt = (i: number): bigint | null => {
        const r = reads[i];
        return r && r.status === "success" ? (r.result as bigint) : null;
      };
      const priceAt = (i: number): bigint | null => {
        const p = reads[n + i];
        return p && p.status === "success" && (p.result as bigint) > 0n
          ? (p.result as bigint)
          : null;
      };

      const collateral: RankedLeg[] = [];
      const debt: RankedLeg[] = [];
      tokens.forEach(({ reserve }, i) => {
        const scale = 10n ** BigInt(RANK_DECIMALS - reserve.decimals);
        const price = priceAt(i);
        const aBalance = balanceAt(i);
        if (aBalance !== null && aBalance > 0n) {
          collateral.push({ symbol: reserve.symbol, amount: aBalance * scale, price });
        }
        // Aave splits a reserve's debt across two tokens; the borrow is their
        // sum, and a reserve where BOTH reads failed contributes nothing rather
        // than a zero that would read as "no debt here".
        const variable = balanceAt(2 * n + i);
        const stable = balanceAt(3 * n + i);
        if (variable === null && stable === null) return;
        const owed = (variable ?? 0n) + (stable ?? 0n);
        if (owed > 0n) {
          debt.push({ symbol: reserve.symbol, amount: owed * scale, price });
        }
      });

      // Ranking is by real oracle value: balance × price, in BigInt, on one
      // decimal scale. The hardcoded price classes this replaced could not
      // separate wstETH from WETH at all (they shared a class, though wstETH
      // trades ~1.24× WETH) and drifted arbitrarily far across classes.
      const top = dominantOf(collateral);
      dominantCollateralSymbol = top.symbol;
      dominantCollateralUnpriced = top.unpriced;
      dominantBorrowSymbol = dominantOf(debt).symbol;
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
      // Aave reports 0 bps for an account holding no collateral, which is an
      // absent threshold rather than a threshold of zero.
      weightedLiquidationThreshold:
        liqThresholdBps > 0n ? Number(liqThresholdBps) / 10_000 : null,
      dominantCollateralSymbol,
      dominantBorrowSymbol,
      ...(dominantCollateralUnpriced ? { dominantCollateralUnpriced: true } : {}),
    };
  }
}
