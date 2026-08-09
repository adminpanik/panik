/**
 * Morpho (Blue) active reader — via Morpho's official GraphQL API.
 *
 * Why an API instead of RPC (deviation from RPC-first, documented):
 * Morpho positions live in isolated markets keyed by marketId — discovering
 * which markets a wallet touched requires an index (events or this API).
 * The API also prices positions with each market's own oracle. Schema was
 * verified live against blue-api.morpho.org on 2026-06-13.
 *
 * Aggregation policy for isolated markets: HF = MIN across the wallet's
 * markets (the most-at-risk leg drives alerts — a healthy market cannot
 * bail out a liquidating one, so averaging would hide danger).
 */

import type { PositionHealthInput } from "../types";
import type { FetchFn } from "../providers/types";
import type { ActiveReading } from "./activeAave";

const MORPHO_API = "https://blue-api.morpho.org/graphql";
const BASE_CHAIN_ID = 8453;

const QUERY = `query ($wallets: [String!]) {
  marketPositions(where: { userAddress_in: $wallets, chainId_in: [${BASE_CHAIN_ID}] }, first: 50) {
    items {
      healthFactor
      state { collateralUsd borrowAssetsUsd }
      market { lltv collateralAsset { symbol } loanAsset { symbol } }
    }
  }
}`;

interface MorphoPosition {
  healthFactor: number | null;
  state: { collateralUsd: number | null; borrowAssetsUsd: number | null } | null;
  market: {
    lltv: string;
    collateralAsset: { symbol: string } | null;
    loanAsset: { symbol: string } | null;
  };
}

export class MorphoActiveReader {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async read(wallet: string): Promise<ActiveReading | null> {
    const res = await this.fetchFn(MORPHO_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { wallets: [wallet] } }),
    });
    if (!res.ok) throw new Error(`Morpho API: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { marketPositions?: { items?: MorphoPosition[] } };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw new Error(`Morpho API: ${body.errors[0]?.message}`);

    const items = (body.data?.marketPositions?.items ?? []).filter(
      (p) => (p.state?.collateralUsd ?? 0) > 0 || (p.state?.borrowAssetsUsd ?? 0) > 0,
    );
    if (items.length === 0) return null;

    let collateralUsd = 0;
    let borrowUsd = 0;
    let weightedLltvUsd = 0;
    let minHf: number | null = null;
    let bestCollateralUsd = 0;
    let dominantCollateralSymbol: string | null = null;

    for (const p of items) {
      const coll = p.state?.collateralUsd ?? 0;
      const debt = p.state?.borrowAssetsUsd ?? 0;
      collateralUsd += coll;
      borrowUsd += debt;
      weightedLltvUsd += coll * (Number(p.market.lltv) / 1e18);
      if (debt > 0 && p.healthFactor !== null) {
        minHf = minHf === null ? p.healthFactor : Math.min(minHf, p.healthFactor);
      }
      if (coll > bestCollateralUsd) {
        bestCollateralUsd = coll;
        dominantCollateralSymbol = p.market.collateralAsset?.symbol ?? null;
      }
    }

    // Morpho Blue prices one factor per market: lltv IS the liquidation
    // threshold, and there is no separate borrow LTV to sit below it. So the
    // collateral-weighted lltv serves as both — computed once and read twice,
    // rather than written twice and allowed to drift.
    const weightedLiquidationThreshold =
      collateralUsd > 0 ? weightedLltvUsd / collateralUsd : null;

    const positionHealth: PositionHealthInput = {
      healthFactor: borrowUsd > 0 ? minHf : null,
      currentLtv: collateralUsd > 0 ? borrowUsd / collateralUsd : 0,
      maxLtv: weightedLiquidationThreshold ?? 0,
    };

    return {
      protocol: "morpho",
      positionHealth,
      collateralValueUsd: collateralUsd,
      borrowValueUsd: borrowUsd,
      weightedLiquidationThreshold,
      dominantCollateralSymbol,
    };
  }
}
