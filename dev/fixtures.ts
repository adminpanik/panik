/**
 * Fixture data for `npm run dev:mock` (see dev/mockApi.ts).
 *
 * DEV ONLY. Nothing here is imported by production source; the plugin that
 * serves it is `apply: 'serve'`, so it cannot reach a build.
 *
 * Types are imported (type-only, so no runtime edge into src/) from
 * src/panik-core/lib/live.ts — the same contract the real API answers with.
 * If a response shape drifts there, `npm run lint` breaks here first.
 *
 * The numbers are hand-built to be MUTUALLY CONSISTENT, because an inconsistent
 * fixture teaches the UI to render nonsense:
 *   - `band` follows `total` under the 25 / 50 / 75 thresholds
 *     (packages/scoring/src/computeScore.ts).
 *   - `total` is the composite of the four sub-scores at the published weights
 *     (position .40 / asset .25 / protocol .20 / systemic .15), then lifted by
 *     the liquidation-proximity floors (HF <= 1.10 -> 75, HF <= 1.25 -> 50).
 *   - `profileStatus` follows `total` for the "moderate" profile
 *     (alert at 50, "approaching" from 40).
 * dev/fixtures.test.ts asserts all three, so an edit here cannot drift silently.
 *
 * Sub-scores are themselves derived rather than sprinkled: systemic risk is a
 * market-wide term (one value everywhere), protocol safety is per protocol,
 * asset risk is per asset, and only position health varies per position.
 */

import type {
  AdvisorRecommendation,
  AdvisorReport,
  Band,
  CompassLiveScore,
  HistoryAlert,
  HistorySnapshot,
  LiveProtocol,
  LiveWalletPosition,
  PoolYield,
  ProspectiveLive,
  RegistryWallet,
} from "../src/panik-core/lib/live";

/**
 * The wallet the mock answers for. dev/mockApi.ts seeds it into localStorage as
 * `panik_wallet`, which is what puts AppDemo into boundMode and fires the
 * per-wallet fetches. Lowercase: /api/history and /api/advisor lowercase the
 * query param server-side, so the fixture must match in that form.
 */
export const MOCK_WALLET = "0x4c9f2a1d7b3e8056af1c9d2e4b7a3f6081d5c2e9";

/** Sub-score inputs shared across fixtures — see the header note on derivation. */
const SYSTEMIC = 30; // calm-ish market, identical for every position at one instant
const PROTOCOL_SAFETY: Record<LiveProtocol, number> = {
  aave_v3: 16,
  compound_v3: 24,
  moonwell: 30,
  morpho: 52, // isolated markets, thinnest track record -> highest risk score
};
const ASSET_RISK: Record<string, number> = {
  USDC: 8,
  cbBTC: 34,
  WETH: 38,
  wstETH: 44,
  cbETH: 46,
};

// ── /api/positions and /api/scores ─────────────────────────────────────────
// FOUR positions — at most one per protocol, because that is the most the
// engine can emit. scripts/api-server.ts registers exactly one reader per
// protocol and ActiveAdapter.scoreWallet returns at most one ActiveReading per
// reader, so a wallet has at most four legs. LivePositions.tsx keys its rows on
// `${wallet}:${protocol}`, which a second leg on the same protocol would
// collide with; dev/fixtures.test.ts asserts the pair is unique.
//
// Five render paths still fit across the four legs — the asset-risk proxy is
// only a string in `scoredCollateralSymbol`, orthogonal to band and debt, so it
// rides on the levered Moonwell leg. Dropping any of the five silently stops
// exercising a branch nobody then looks at again.

export const MOCK_POSITIONS: LiveWalletPosition[] = [
  {
    // 1. Supply-only. No debt -> no health factor, no liquidation. The UI must
    //    print "no debt", never "0.00".
    protocol: "aave_v3",
    wallet: MOCK_WALLET,
    total: 19,
    band: "LOW",
    subScores: {
      positionHealth: 0, // no debt -> nothing to liquidate
      assetRisk: ASSET_RISK.wstETH,
      protocolSafety: PROTOCOL_SAFETY.aave_v3,
      systemicRisk: SYSTEMIC,
    },
    healthFactor: null,
    collateralValueUsd: 48_500,
    borrowValueUsd: 0,
    scoredCollateralSymbol: "wstETH",
    label: "Staking sleeve",
    riskProfile: "moderate",
    profileStatus: "within",
  },
  {
    // 2. HF 1.20 — inside the second liquidation-proximity floor (<= 1.25 -> 50).
    //    The composite already clears it here, so the floor is a no-op; that is
    //    the realistic case and keeps the sub-scores reconcilable.
    //
    //    Also the asset-risk proxy path: the collateral has no own risk series,
    //    so the engine scored it against WETH and says so in the symbol. The UI
    //    has to carry that "(proxy)" suffix through instead of pretending it is
    //    WETH. The suffix is orthogonal to band and debt, so it costs no leg.
    protocol: "moonwell",
    wallet: MOCK_WALLET,
    total: 52,
    band: "HIGH",
    subScores: {
      positionHealth: 80,
      assetRisk: ASSET_RISK.WETH, // the proxy: no own series, scored against WETH
      protocolSafety: PROTOCOL_SAFETY.moonwell,
      systemicRisk: SYSTEMIC,
    },
    healthFactor: 1.2,
    collateralValueUsd: 84_200,
    borrowValueUsd: 56_800,
    scoredCollateralSymbol: "WETH (proxy)",
    label: null,
    riskProfile: "moderate",
    profileStatus: "outside",
  },
  {
    // 3. HF 1.05 — the first proximity floor fires: the weighted composite is 61
    //    (a calm market says "ELEVATED"), the floor lifts it to 75 / CRITICAL.
    //    This is exactly the Mar-2023 USDC-depeg case params.ts was written for,
    //    so the fixture set covers it rather than only the easy path.
    protocol: "morpho",
    wallet: MOCK_WALLET,
    total: 75,
    band: "CRITICAL",
    subScores: {
      positionHealth: 95,
      assetRisk: ASSET_RISK.cbBTC,
      protocolSafety: PROTOCOL_SAFETY.morpho,
      systemicRisk: SYSTEMIC,
    },
    healthFactor: 1.05,
    collateralValueUsd: 128_500,
    borrowValueUsd: 105_200,
    scoredCollateralSymbol: "cbBTC",
    label: "BTC carry",
    riskProfile: "moderate",
    profileStatus: "outside",
  },
  {
    // 4. Degraded price feed. Score, band and HF are ratios and stay EXACT; only
    //    the dollar magnitudes are unknown. Every surface must render these as
    //    "$—", never "$0" — a six-figure debt reported as zero is the bug this
    //    flag exists to prevent.
    protocol: "compound_v3",
    wallet: MOCK_WALLET,
    total: 44,
    band: "ELEVATED",
    subScores: {
      positionHealth: 66,
      assetRisk: ASSET_RISK.cbBTC,
      protocolSafety: PROTOCOL_SAFETY.compound_v3,
      systemicRisk: SYSTEMIC,
    },
    healthFactor: 1.34,
    collateralValueUsd: null,
    borrowValueUsd: null,
    usdValuesUnavailable: true,
    scoredCollateralSymbol: "cbBTC",
    label: null,
    riskProfile: "moderate",
    profileStatus: "approaching",
  },
];

// ── /api/wallets ───────────────────────────────────────────────────────────

export const MOCK_WALLETS: RegistryWallet[] = [
  { wallet: MOCK_WALLET, risk_profile: "moderate", label: "Mock dev wallet" },
];

// ── /api/compass and /api/prospective ──────────────────────────────────────
// Ids match scripts/api-server.ts COMPASS_SCENARIOS; protocol/symbol are kept
// alongside so /api/prospective can answer the Watch sliders from the same
// table (it looks the preset up — it does not score anything; packages/scoring
// owns that, and `npm run dev:api` is how you get real numbers).

interface CompassFixture extends CompassLiveScore {
  protocol: LiveProtocol;
  symbol: string;
}

const COMPASS: CompassFixture[] = [
  {
    id: "aave-usdc-supply",
    protocol: "aave_v3",
    symbol: "USDC",
    total: 10,
    band: "LOW",
    subScores: { positionHealth: 0, assetRisk: ASSET_RISK.USDC, protocolSafety: PROTOCOL_SAFETY.aave_v3, systemicRisk: SYSTEMIC },
    healthFactor: 3.4,
    liquidationDrawdown: 0.706,
  },
  {
    id: "moonwell-usdc-supply",
    protocol: "moonwell",
    symbol: "USDC",
    total: 13,
    band: "LOW",
    subScores: { positionHealth: 0, assetRisk: ASSET_RISK.USDC, protocolSafety: PROTOCOL_SAFETY.moonwell, systemicRisk: SYSTEMIC },
    healthFactor: 4.25,
    liquidationDrawdown: 0.765,
  },
  {
    id: "aave-wsteth-vault",
    protocol: "aave_v3",
    symbol: "wstETH",
    total: 43,
    band: "ELEVATED",
    subScores: { positionHealth: 60, assetRisk: ASSET_RISK.wstETH, protocolSafety: PROTOCOL_SAFETY.aave_v3, systemicRisk: SYSTEMIC },
    healthFactor: 1.4,
    liquidationDrawdown: 0.286,
  },
  {
    id: "aave-weth-borrow",
    protocol: "aave_v3",
    symbol: "WETH",
    total: 17,
    band: "LOW",
    subScores: { positionHealth: 0, assetRisk: ASSET_RISK.WETH, protocolSafety: PROTOCOL_SAFETY.aave_v3, systemicRisk: SYSTEMIC },
    healthFactor: 2.03,
    liquidationDrawdown: 0.507,
  },
  {
    id: "moonwell-weth-debt",
    protocol: "moonwell",
    symbol: "WETH",
    total: 51,
    band: "HIGH",
    subScores: { positionHealth: 78, assetRisk: ASSET_RISK.WETH, protocolSafety: PROTOCOL_SAFETY.moonwell, systemicRisk: SYSTEMIC },
    healthFactor: 1.22,
    liquidationDrawdown: 0.18,
  },
  {
    // Max leverage: HF 1.07 trips the <= 1.10 floor, so 59 becomes 75 / CRITICAL.
    id: "moonwell-cbeth-max",
    protocol: "moonwell",
    symbol: "cbETH",
    total: 75,
    band: "CRITICAL",
    subScores: { positionHealth: 93, assetRisk: ASSET_RISK.cbETH, protocolSafety: PROTOCOL_SAFETY.moonwell, systemicRisk: SYSTEMIC },
    healthFactor: 1.07,
    liquidationDrawdown: 0.065,
  },
  {
    id: "morpho-weth-loop",
    protocol: "morpho",
    symbol: "WETH",
    total: 47,
    band: "ELEVATED",
    subScores: { positionHealth: 57, assetRisk: ASSET_RISK.WETH, protocolSafety: PROTOCOL_SAFETY.morpho, systemicRisk: SYSTEMIC },
    healthFactor: 1.43,
    liquidationDrawdown: 0.301,
  },
  {
    id: "compound-weth-borrow",
    protocol: "compound_v3",
    symbol: "WETH",
    total: 34,
    band: "ELEVATED",
    subScores: { positionHealth: 38, assetRisk: ASSET_RISK.WETH, protocolSafety: PROTOCOL_SAFETY.compound_v3, systemicRisk: SYSTEMIC },
    healthFactor: 1.62,
    liquidationDrawdown: 0.383,
  },
];

/** Exported for the invariant test; the endpoint strips protocol/symbol. */
export const MOCK_COMPASS_FIXTURES: readonly CompassFixture[] = COMPASS;

export const MOCK_COMPASS: CompassLiveScore[] = COMPASS.map(
  ({ protocol: _protocol, symbol: _symbol, ...score }) => score,
);

/**
 * Prospective score for the Watch sliders. Looked up by protocol + symbol, so
 * switching market moves the number; the USD sliders do not, because sizing a
 * score is the engine's job and this file is not the engine.
 */
export function mockProspective(protocol: string, symbol: string): ProspectiveLive {
  const hit =
    COMPASS.find((c) => c.protocol === protocol && c.symbol === symbol) ??
    COMPASS[4];
  const { id: _id, protocol: _protocol, symbol: _symbol, ...rest } = hit;
  return rest;
}

// ── /api/history ───────────────────────────────────────────────────────────
// 30 daily points per leg so the Portfolio sparkline has something real to
// draw. Collateral is derived from the health factor and a constant debt
// (HF = collateral * LT / debt), which is what actually happens when the
// collateral price moves — so the series stays self-consistent day by day.

const HISTORY_LEGS = [
  { protocol: "moonwell" as const, lt: 0.81, borrowUsd: 56_800, from: 34, to: 52, hfFrom: 1.62, hfTo: 1.2 },
  { protocol: "morpho" as const, lt: 0.86, borrowUsd: 105_200, from: 48, to: 75, hfFrom: 1.34, hfTo: 1.05 },
];

export const HISTORY_DAYS = 30;

export function mockHistory(now = Date.now()): { alerts: HistoryAlert[]; snapshots: HistorySnapshot[] } {
  const snapshots: HistorySnapshot[] = [];
  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const createdAt = new Date(now - daysAgo * 86_400_000).toISOString();
    const t = (HISTORY_DAYS - 1 - daysAgo) / (HISTORY_DAYS - 1); // 0 oldest -> 1 newest
    for (const leg of HISTORY_LEGS) {
      // Trend plus a fixed wobble: a straight line does not look like a market,
      // and Math.random would redraw a different chart on every poll.
      const wobble = Math.sin(daysAgo * 1.1) * 3;
      const hf = leg.hfFrom + (leg.hfTo - leg.hfFrom) * t;
      const collateral = (hf * leg.borrowUsd) / leg.lt;
      snapshots.push({
        protocol: leg.protocol,
        total: Math.round(leg.from + (leg.to - leg.from) * t + (daysAgo === 0 ? 0 : wobble)),
        health_factor: hf.toFixed(4),
        collateral_usd: collateral.toFixed(2),
        borrow_usd: leg.borrowUsd.toFixed(2),
        created_at: createdAt,
      });
    }
  }

  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const alerts: HistoryAlert[] = [
    {
      protocol: "moonwell",
      risk_profile: "moderate",
      score: 51,
      band: "HIGH",
      from_status: "approaching",
      to_status: "outside",
      notify_channel: null, // queued: no Telegram linked in mock mode
      notified_at: null,
      created_at: ago(2),
    },
    {
      protocol: "morpho",
      risk_profile: "moderate",
      score: 61,
      band: "HIGH",
      from_status: "approaching",
      to_status: "outside",
      notify_channel: "telegram",
      notified_at: ago(4),
      created_at: ago(4),
    },
    {
      protocol: "morpho",
      risk_profile: "moderate",
      score: 44,
      band: "ELEVATED",
      from_status: "within",
      to_status: "approaching",
      notify_channel: "telegram",
      notified_at: ago(11),
      created_at: ago(11),
    },
  ];

  return { alerts, snapshots };
}

// ── /api/poolhistory ───────────────────────────────────────────────────────
// Keyed by Compass preset id. moonwell-cbeth-max is absent on purpose: it has
// no listed DefiLlama pool in production either, and the UI falls back to the
// preset's static APY. Mocking it would hide that path.

function series(base: number, drift: number, wobble: number): number[] {
  return Array.from({ length: 30 }, (_, i) =>
    Number((base + drift * (i / 29) + Math.sin(i * 0.7) * wobble).toFixed(4)),
  );
}

export const MOCK_POOLS: Record<string, PoolYield> = {
  "aave-usdc-supply": { apy: 0.0812, tvlUsd: 214_000_000, apySeries: series(0.074, 0.007, 0.004), tvlSeries: series(198e6, 16e6, 6e6) },
  "moonwell-usdc-supply": { apy: 0.0731, tvlUsd: 61_400_000, apySeries: series(0.069, 0.004, 0.005), tvlSeries: series(58e6, 3.4e6, 2.2e6) },
  "aave-wsteth-vault": { apy: 0.0248, tvlUsd: 148_000_000, apySeries: series(0.026, -0.001, 0.002), tvlSeries: series(155e6, -7e6, 4e6) },
  "aave-weth-borrow": { apy: 0.0193, tvlUsd: 176_000_000, apySeries: series(0.021, -0.002, 0.003), tvlSeries: series(168e6, 8e6, 5e6) },
  "moonwell-weth-debt": { apy: 0.0287, tvlUsd: 42_800_000, apySeries: series(0.027, 0.002, 0.004), tvlSeries: series(40e6, 2.8e6, 1.8e6) },
  "morpho-weth-loop": { apy: 0.0412, tvlUsd: 33_600_000, apySeries: series(0.036, 0.005, 0.006), tvlSeries: series(31e6, 2.6e6, 1.5e6) },
  "compound-weth-borrow": { apy: 0.0224, tvlUsd: 57_200_000, apySeries: series(0.024, -0.002, 0.003), tvlSeries: series(55e6, 2.2e6, 2e6) },
};

// ── /api/chain ─────────────────────────────────────────────────────────────

/** Base block time is 2s; ticking the number keeps the telemetry strip alive. */
const MOCK_CHAIN_EPOCH_MS = Date.UTC(2026, 7, 1);
const MOCK_CHAIN_EPOCH_BLOCK = 36_500_000;

export function mockChain(now = Date.now()): { blockNumber: number; gasGwei: number } {
  return {
    blockNumber: MOCK_CHAIN_EPOCH_BLOCK + Math.floor((now - MOCK_CHAIN_EPOCH_MS) / 2000),
    gasGwei: Number((0.0042 + Math.sin(now / 90_000) * 0.0011).toFixed(6)),
  };
}

// ── /api/advisor ───────────────────────────────────────────────────────────
// One recommendation per leg — four legs, four recommendations — following
// packages/scoring/src/advisor/rules.ts: CRITICAL -> EXIT, HIGH+outside ->
// REDUCE with a sized repay, approaching -> MONITOR, no-debt/within -> HOLD.
// Prose mirrors the deterministic templates in advisor/fallback.ts
// (narrated: false — no LLM in the loop).
//
// The degraded leg is the one with real invariants attached (see
// packages/scoring/tests/active.test.ts): it must NOT carry "debt:none", must
// carry "prices:degraded", must not invent a repayPlan, and must not let the
// report settle on an all-clear headline.

const numbersOf = (p: LiveWalletPosition): AdvisorRecommendation["numbers"] => ({
  total: p.total,
  band: p.band,
  healthFactor: p.healthFactor,
  collateralValueUsd: p.collateralValueUsd,
  borrowValueUsd: p.borrowValueUsd,
  usdValuesUnavailable: p.usdValuesUnavailable,
  subScores: p.subScores,
  scoredCollateralSymbol: p.scoredCollateralSymbol,
});

const [SUPPLY_ONLY, LEVERED_WETH, CRITICAL_BTC, DEGRADED] = MOCK_POSITIONS;

/** repayToTargetHf(56800, 1.20, 1.75) — moderate targets HF 1.75. */
const MOONWELL_REPAY_USD = 17_851.43;

const RECOMMENDATIONS: AdvisorRecommendation[] = [
  {
    protocol: "morpho",
    wallet: MOCK_WALLET,
    action: "EXIT",
    urgency: "critical",
    triggers: ["band:CRITICAL", "profile:outside", "floor:hf<=1.1"],
    sections: {
      position:
        "Your Morpho position holds $128,500 collateral against $105,200 debt (health factor 1.05, PANIK score 75 - CRITICAL). A 4.8% cbBTC price drop would trigger liquidation.",
      market: "The score is being driven by position health (95/100).",
      recommendation:
        "Exit this Morpho position in full. The risk level no longer fits any profile band worth holding through.",
      execution:
        "The Exit button pre-selects this Morpho position for a single atomic transaction you sign yourself - debt repaid, collateral withdrawn, proceeds returned as USDC.",
    },
    numbers: numbersOf(CRITICAL_BTC),
    exitPrefill: { protocol: "morpho", kind: "full" },
  },
  {
    protocol: "moonwell",
    wallet: MOCK_WALLET,
    action: "REDUCE",
    urgency: "warning",
    triggers: ["band:HIGH", "profile:outside"],
    repayPlan: {
      repayUsd: MOONWELL_REPAY_USD,
      repayAssetSymbol: "USDC",
      targetHf: 1.75,
      projectedHf: 1.75,
      mode: "wallet_funded",
    },
    sections: {
      position:
        "Your Moonwell position holds $84,200 collateral against $56,800 debt (health factor 1.20, PANIK score 52 - HIGH). A 16.7% WETH (proxy) price drop would trigger liquidation.",
      market: "The score is being driven by position health (80/100).",
      recommendation:
        "Repay ~$17,851 of USDC debt on Moonwell to lift your health factor from 1.20 to 1.75.",
      execution:
        "The Reduce button pre-fills a partial exit repaying ~$17,851 of USDC on Moonwell; you sign the transaction yourself.",
    },
    numbers: numbersOf(LEVERED_WETH),
    exitPrefill: { protocol: "moonwell", kind: "partial", repayUsd: MOONWELL_REPAY_USD },
  },
  {
    protocol: "compound_v3",
    wallet: MOCK_WALLET,
    action: "MONITOR",
    urgency: "info",
    // No "debt:none": the dust gate is WAIVED for a degraded leg, not failed.
    // No repayPlan either — the engine cannot size a repay it cannot price.
    triggers: ["band:ELEVATED", "profile:approaching", "prices:degraded"],
    sections: {
      position:
        "Your Compound V3 position's USD values are unavailable (degraded price feed) - the health factor below is still exact (health factor 1.34, PANIK score 44 - ELEVATED). A 25.4% cbBTC price drop would trigger liquidation.",
      market: "The score is being driven by position health (66/100).",
      recommendation:
        "No action needed yet, but this Compound V3 position is approaching your risk threshold - watch it closely.",
      execution: "No transaction needed. Watch alerts will fire if it crosses your threshold.",
    },
    numbers: numbersOf(DEGRADED),
  },
  {
    protocol: "aave_v3",
    wallet: MOCK_WALLET,
    action: "HOLD",
    urgency: "info",
    triggers: ["band:LOW", "profile:within", "debt:none"],
    sections: {
      position:
        "Your Aave V3 position holds $48,500 collateral against $0 debt (health factor no debt, PANIK score 19 - LOW). No debt, so no liquidation risk.",
      market: "The score is being driven by asset volatility risk (44/100).",
      recommendation: "Hold. This Aave V3 position sits comfortably within your risk profile.",
      execution: "No transaction needed.",
    },
    numbers: numbersOf(SUPPLY_ONLY),
  },
];

const OPPORTUNITIES: AdvisorRecommendation[] = [
  {
    protocol: "aave_v3",
    wallet: MOCK_WALLET,
    action: "OPEN",
    urgency: "info",
    triggers: ["scan:opportunity", "profile:within"],
    openPlan: {
      protocol: "aave_v3",
      collateralSymbol: "USDC",
      collateralUsd: 25_000,
      borrowUsd: 0,
      projectedScore: 10,
      projectedHf: null,
      apy: 0.0812,
    },
    openPrefill: {
      protocol: "aave_v3",
      collateralSymbol: "USDC",
      collateralUsd: 25_000,
      borrowUsd: 0,
      projectedScore: 10,
      projectedHf: null,
      apy: 0.0812,
    },
    sections: {
      position: "No existing Aave V3 USDC position.",
      market: "The score is being driven by protocol safety (16/100).",
      recommendation:
        "Deposit ~$25,000 USDC on Aave V3 (no borrow). Projected PANIK score 10, ~8.1% net APY.",
      execution:
        "The Open button pre-fills this position - approve, supply - each step signed from your own wallet on Base.",
    },
    numbers: {
      total: 10,
      band: "LOW",
      healthFactor: null,
      collateralValueUsd: 25_000,
      borrowValueUsd: 0,
      subScores: { positionHealth: 0, assetRisk: ASSET_RISK.USDC, protocolSafety: PROTOCOL_SAFETY.aave_v3, systemicRisk: SYSTEMIC },
      scoredCollateralSymbol: "USDC",
    },
  },
  {
    protocol: "moonwell",
    wallet: MOCK_WALLET,
    action: "OPEN",
    urgency: "info",
    triggers: ["scan:opportunity", "profile:within"],
    openPlan: {
      protocol: "moonwell",
      collateralSymbol: "USDC",
      collateralUsd: 18_000,
      borrowUsd: 0,
      projectedScore: 13,
      projectedHf: null,
      apy: 0.0731,
    },
    openPrefill: {
      protocol: "moonwell",
      collateralSymbol: "USDC",
      collateralUsd: 18_000,
      borrowUsd: 0,
      projectedScore: 13,
      projectedHf: null,
      apy: 0.0731,
    },
    sections: {
      position: "No existing Moonwell USDC position.",
      market: "The score is being driven by protocol safety (30/100).",
      recommendation:
        "Deposit ~$18,000 USDC on Moonwell (no borrow). Projected PANIK score 13, ~7.3% net APY.",
      execution:
        "The Open button pre-fills this position - approve, supply - each step signed from your own wallet on Base.",
    },
    numbers: {
      total: 13,
      band: "LOW",
      healthFactor: null,
      collateralValueUsd: 18_000,
      borrowValueUsd: 0,
      subScores: { positionHealth: 0, assetRisk: ASSET_RISK.USDC, protocolSafety: PROTOCOL_SAFETY.moonwell, systemicRisk: SYSTEMIC },
      scoredCollateralSymbol: "USDC",
    },
  },
];

/**
 * Worst leg wins the overall verdict (EXIT, severity 5), and the degraded leg
 * forces the caveat: an "all positions within your risk profile" all-clear is a
 * claim the engine cannot support for a position it never priced.
 */
export function mockAdvisor(profile: string, now = Date.now()): AdvisorReport {
  return {
    wallet: MOCK_WALLET,
    profile,
    overall: {
      action: "EXIT",
      urgency: "critical",
      headline:
        "Critical risk: exit recommended on Morpho. Prices degraded on Compound V3 - position sizes unverified.",
    },
    recommendations: RECOMMENDATIONS,
    opportunities: OPPORTUNITIES,
    walletInsights: {
      profile,
      archetype: "Levered ETH borrower",
      protocols: ["aave", "moonwell", "morpho", "compound"],
      topProtocol: "moonwell",
      topCollateralSymbol: "WETH",
      liquidations: 0,
      lendingAgeDays: 512,
      borrowToDepositRatio: 0.61,
      stableBorrowPct: 0.88,
      daysSinceLastActivity: 3,
      confidence: 0.78,
    },
    narrated: false,
    updatedAt: now,
    changeToken: "mock-1",
  };
}

/** Exported so dev/fixtures.test.ts can assert the degraded-leg invariants. */
export const MOCK_ADVISOR_RECOMMENDATIONS: readonly AdvisorRecommendation[] = RECOMMENDATIONS;

/** Band thresholds, mirrored from packages/scoring so the test can check them. */
export const BAND_THRESHOLDS: ReadonlyArray<readonly [number, Band]> = [
  [75, "CRITICAL"],
  [50, "HIGH"],
  [25, "ELEVATED"],
  [0, "LOW"],
];
