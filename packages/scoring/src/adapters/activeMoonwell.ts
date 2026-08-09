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

    // Resolve the dominant collateral's symbol (native market = ETH).
    let dominantCollateralSymbol: string | null = dominantIsNative ? "ETH" : null;
    if (dominantUnderlying) {
      const sym = await this.client.multicall({
        allowFailure: true,
        contracts: [
          { address: dominantUnderlying, abi: erc20Abi, functionName: "symbol" },
        ],
      });
      dominantCollateralSymbol =
        sym[0]?.status === "success" ? (sym[0].result as string) : null;
    }

    return {
      protocol: "moonwell",
      positionHealth,
      collateralValueUsd: collateralUsd,
      borrowValueUsd: borrowUsd,
      weightedLiquidationThreshold,
      dominantCollateralSymbol,
    };
  }
}
