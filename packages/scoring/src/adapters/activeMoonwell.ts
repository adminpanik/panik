/**
 * Moonwell active reader — Compound V2 fork, no native health factor.
 * Derives HF per arch: (Σ collateral_i × collateralFactor_i) / borrow value,
 * using the comptroller's entered markets and its own oracle prices.
 */

import type { PositionHealthInput } from "../types";
import type { ActiveReading } from "./activeAave";
import {
  MOONWELL_COMPTROLLER_BASE,
  type PublicClientLike,
  comptrollerAbi,
  erc20Abi,
  mTokenAbi,
  oracleAbi,
} from "./chain";

export class MoonwellActiveReader {
  private oracleAddr: string | null = null;

  constructor(
    private readonly client: PublicClientLike,
    private readonly comptroller: string = MOONWELL_COMPTROLLER_BASE,
  ) {}

  private async oracle(): Promise<string> {
    if (this.oracleAddr) return this.oracleAddr;
    this.oracleAddr = (await this.client.readContract({
      address: this.comptroller,
      abi: comptrollerAbi,
      functionName: "oracle",
    })) as string;
    return this.oracleAddr;
  }

  /** Returns null when the wallet has entered no Moonwell markets. */
  async read(wallet: string): Promise<ActiveReading | null> {
    const mTokens = (await this.client.readContract({
      address: this.comptroller,
      abi: comptrollerAbi,
      functionName: "getAssetsIn",
      args: [wallet],
    })) as string[];
    if (mTokens.length === 0) return null;

    const oracle = await this.oracle();

    // One batched call: 5 reads per entered market (+1 optional underlying).
    const perMarket = 6;
    const calls = mTokens.flatMap((m) => [
      { address: m, abi: mTokenAbi, functionName: "balanceOf", args: [wallet] },
      { address: m, abi: mTokenAbi, functionName: "borrowBalanceStored", args: [wallet] },
      { address: m, abi: mTokenAbi, functionName: "exchangeRateStored" },
      { address: this.comptroller, abi: comptrollerAbi, functionName: "markets", args: [m] },
      { address: oracle, abi: oracleAbi, functionName: "getUnderlyingPrice", args: [m] },
      { address: m, abi: mTokenAbi, functionName: "underlying" }, // fails on native markets
    ]);
    const res = await this.client.multicall({ allowFailure: true, contracts: calls });

    let collateralUsd = 0;
    let borrowUsd = 0;
    let weightedCollateralUsd = 0; // Σ collateral_i × CF_i
    let bestCollateralUsd = 0;
    let dominantUnderlying: string | null = null;
    let dominantIsNative = false;
    let bestBorrowUsd = 0;
    let dominantBorrowUnderlying: string | null = null;
    let dominantBorrowIsNative = false;

    const get = <T>(i: number): T | null => {
      const r = res[i];
      return r && r.status === "success" ? (r.result as T) : null;
    };

    mTokens.forEach((_, m) => {
      const base = m * perMarket;
      const balance = get<bigint>(base);
      const borrow = get<bigint>(base + 1);
      const exchangeRate = get<bigint>(base + 2);
      const market = get<readonly [boolean, bigint]>(base + 3);
      const price = get<bigint>(base + 4); // USD × 10^(36 − underlyingDecimals)
      if (balance === null || borrow === null || exchangeRate === null ||
          market === null || price === null) return;

      const cf = Number(market[1]) / 1e18;
      // collateral USD = balance × exchangeRate × price / 10^(18+36)
      const collUsd =
        ((Number(balance) * Number(exchangeRate)) / 1e18) * (Number(price) / 1e36);
      const debtUsd = Number(borrow) * (Number(price) / 1e36);

      collateralUsd += collUsd;
      weightedCollateralUsd += collUsd * cf;
      borrowUsd += debtUsd;

      if (collUsd > bestCollateralUsd) {
        bestCollateralUsd = collUsd;
        dominantUnderlying = get<string>(base + 5);
        dominantIsNative = dominantUnderlying === null;
      }
      // Same read, the other side of the book: a Compound-V2 fork borrows the
      // market's own underlying, so the largest borrow leg names the asset a
      // repay is denominated in.
      if (debtUsd > bestBorrowUsd) {
        bestBorrowUsd = debtUsd;
        dominantBorrowUnderlying = get<string>(base + 5);
        dominantBorrowIsNative = dominantBorrowUnderlying === null;
      }
    });

    if (collateralUsd === 0 && borrowUsd === 0) return null;

    // Compound-V2 fork semantics: a market has ONE collateralFactorMantissa,
    // used as both the borrow limit and the liquidation threshold. So the
    // borrow-side weighting IS the liquidation-side one — computed once here
    // and read twice, rather than written twice and allowed to drift.
    const weightedLiquidationThreshold =
      collateralUsd > 0 ? weightedCollateralUsd / collateralUsd : null;

    // Derived HF per arch §Sub-Scores 1 (shortfall>0 cases land at HF<1 here).
    const positionHealth: PositionHealthInput = {
      healthFactor: borrowUsd > 0 ? weightedCollateralUsd / borrowUsd : null,
      currentLtv: collateralUsd > 0 ? borrowUsd / collateralUsd : 0,
      maxLtv: weightedLiquidationThreshold ?? 0,
    };

    // Resolve both dominant underlyings' symbols in ONE batch (native = ETH).
    // Distinct addresses only: a wallet that supplies and borrows the same
    // market is the common case and must not cost a second identical read.
    // The explicit Set element type is load bearing: both variables are only
    // ever assigned inside the forEach above, which TS's control flow does not
    // follow, so it narrows them back to `null` at this line.
    const underlyings = [
      ...new Set<string | null>([dominantUnderlying, dominantBorrowUnderlying]),
    ].filter((a): a is string => a !== null);
    const symbols = new Map<string, string>();
    if (underlyings.length > 0) {
      const res = await this.client.multicall({
        allowFailure: true,
        contracts: underlyings.map((address) => ({
          address,
          abi: erc20Abi,
          functionName: "symbol",
        })),
      });
      underlyings.forEach((address, i) => {
        const r = res[i];
        if (r && r.status === "success") symbols.set(address, r.result as string);
      });
    }
    const symbolOf = (underlying: string | null, isNative: boolean): string | null =>
      underlying === null ? (isNative ? "ETH" : null) : (symbols.get(underlying) ?? null);

    return {
      protocol: "moonwell",
      positionHealth,
      collateralValueUsd: collateralUsd,
      borrowValueUsd: borrowUsd,
      weightedLiquidationThreshold,
      dominantCollateralSymbol: symbolOf(dominantUnderlying, dominantIsNative),
      dominantBorrowSymbol: symbolOf(dominantBorrowUnderlying, dominantBorrowIsNative),
    };
  }
}
