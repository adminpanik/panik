/**
 * The wire contract between the risk engine and this app's data layer, for the
 * one case the two used to disagree about: a sub-score the engine could not
 * measure.
 *
 * The engine reports it as `null`, the API is a `JSON.stringify` of the engine's
 * object, and `lib/live.ts` declared it `number`. Nothing failed loudly — TypeScript
 * was satisfied, the response parsed, and `Math.round(null)` handed every render
 * site a 0, which on this ramp is the SAFEST score there is. A dead market feed
 * rendered as a calm market.
 *
 * These tests pin the three links in that chain: what the engine emits, what
 * survives serialization, and what the app must never turn a null into.
 *
 * The engine is deep-imported (`computeScore`, not the package barrel) for the
 * same reason `utils.ts` deep-imports `prospective`: the barrel reaches viem
 * through the chain adapters, and this module pulls only arithmetic.
 */

import { describe, expect, it } from "vitest";
import { computeScoreFromAvailable } from "../../../packages/scoring/src/computeScore";
import type { DegradedScoringInput } from "../../../packages/scoring/src/types";
import type { DegradableSubScores, LiveWalletPosition } from "./live";
import { marketContextMissing } from "./utils";

/** The morpho leg of dev/fixtures.ts, as the engine would be handed it. */
const POSITION_HEALTH = { healthFactor: 1.05, currentLtv: 0.82, maxLtv: 0.86 };

const ASSET_RISK_INPUT: NonNullable<DegradedScoringInput["assetRisk"]> = {
  dailyReturns30d: Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.02),
  btcReturns30d: Array.from({ length: 30 }, (_, i) => Math.sin(i + 1) * 0.02),
  prices90d: Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i) * 5),
};

const SYSTEMIC_INPUT: NonNullable<DegradedScoringInput["systemicRisk"]> = {
  protocolTvlNow: 900_000_000,
  protocolTvl7dAgo: 1_000_000_000,
  sectorTvlNow: 40_000_000_000,
  sectorTvl7dAgo: 42_000_000_000,
};

const input = (over: Partial<DegradedScoringInput> = {}): DegradedScoringInput => ({
  protocol: "morpho",
  positionHealth: POSITION_HEALTH,
  assetRisk: ASSET_RISK_INPUT,
  systemicRisk: SYSTEMIC_INPUT,
  ...over,
});

describe("degraded sub-scores over the wire", () => {
  it("an unread market term is null, and the composite is still a real number", () => {
    const degraded = computeScoreFromAvailable(input({ systemicRisk: null }));

    expect(degraded.subScores.systemicRisk).toBeNull();
    // Not 0. 0 is a real systemic-risk score meaning "the calmest this term
    // gets", so imputing it is an assertion about a market nobody looked at.
    expect(degraded.subScores.systemicRisk).not.toBe(0);
    // The terms that need no I/O are always present, which is why the divisor
    // in the renormalised composite can never approach zero.
    expect(typeof degraded.subScores.positionHealth).toBe("number");
    expect(typeof degraded.subScores.protocolSafety).toBe("number");
    expect(Number.isFinite(degraded.total)).toBe(true);
    expect(degraded.total).toBeGreaterThan(0);
  });

  it("survives JSON, which is the entire API serializer", () => {
    // scripts/api-server.ts spreads the engine's ActiveScore into res.json, and
    // scripts/watch-worker.ts persists JSON.stringify(s.subScores). Neither
    // touches the values, so this round trip IS the wire format — the failure
    // was never a lossy serializer, it was a DTO that described it wrongly.
    const degraded = computeScoreFromAvailable(input({ assetRisk: null, systemicRisk: null }));
    const onWire = JSON.parse(
      JSON.stringify({ ...degraded, marketContextUnavailable: true }),
    ) as Pick<LiveWalletPosition, "subScores" | "marketContextUnavailable" | "total">;

    expect(onWire.subScores.assetRisk).toBeNull();
    expect(onWire.subScores.systemicRisk).toBeNull();
    expect(onWire.marketContextUnavailable).toBe(true);
    expect(onWire.total).toBe(degraded.total);
    // JSON has no `undefined`, so a null that arrives as a missing key would be
    // indistinguishable from an old payload. It arrives as an explicit null.
    expect(Object.keys(onWire.subScores)).toContain("assetRisk");
  });

  it("marketContextMissing agrees with the flag the engine sets", () => {
    // ActiveAdapter derives `marketContextUnavailable` from exactly this
    // condition (adapters/active.ts). The advisor payload carries the
    // sub-scores without the flag, so the predicate has to be the authority.
    const both = computeScoreFromAvailable(input({ assetRisk: null, systemicRisk: null }));
    const one = computeScoreFromAvailable(input({ assetRisk: null }));
    const none = computeScoreFromAvailable(input());

    expect(marketContextMissing(both.subScores)).toBe(true);
    expect(marketContextMissing(one.subScores)).toBe(true);
    expect(marketContextMissing(none.subScores)).toBe(false);
  });

  it("Math.round is the trap: it turns every null into the best possible score", () => {
    // Kept as an executable note. This is what every render site did before
    // this change, and it is silent — no throw, no NaN, just a good number.
    const sub: DegradableSubScores = {
      positionHealth: 95,
      assetRisk: null,
      protocolSafety: 52,
      systemicRisk: null,
    };
    expect(Math.round(sub.assetRisk as unknown as number)).toBe(0);
    expect(marketContextMissing(sub)).toBe(true);
  });

  it("marketContextUnavailable survives the score_snapshots round trip with no column of its own", () => {
    // scripts/watch-worker.ts persists `JSON.stringify(s.subScores)` into the
    // `sub_scores` jsonb column. Unlike `usdValuesUnavailable` — which got its
    // own `usd_values_unavailable` boolean column in
    // 20260806000001_snapshot_degraded_prices.sql, because the dispatch loop
    // needs to read it back to waive the dust gate — nothing reads
    // marketContextUnavailable back out of a persisted row today, and it does
    // not need a column: `node-pg` deserializes jsonb back into a plain
    // object with nulls intact (see the "survives JSON" test above), so a
    // `JSON.parse(JSON.stringify(...))` round trip is exactly what a real
    // read performs. Re-deriving it with `marketContextMissing()` on the far
    // side reproduces exactly what `ActiveAdapter` computed at write time
    // (adapters/active.ts: `assetRisk === null || systemicRisk === null`) —
    // the same DERIVED-not-STORED contract `marketContextMissing` already
    // documents for the live (non-persisted) path.
    const degraded = computeScoreFromAvailable(input({ assetRisk: null, systemicRisk: null }));
    const marketContextUnavailableAtWrite =
      degraded.subScores.assetRisk === null || degraded.subScores.systemicRisk === null;

    const persistedRow = JSON.parse(JSON.stringify(degraded.subScores)) as DegradableSubScores;

    expect(marketContextUnavailableAtWrite).toBe(true);
    expect(marketContextMissing(persistedRow)).toBe(marketContextUnavailableAtWrite);

    const healthy = computeScoreFromAvailable(input());
    const healthyRow = JSON.parse(JSON.stringify(healthy.subScores)) as DegradableSubScores;
    expect(marketContextMissing(healthyRow)).toBe(false);
  });
});
