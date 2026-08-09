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
 *
 * The exception is the leg whose market context failed to read: its systemic
 * term is `null` ("not measured"), the composite renormalises over the weights
 * that survive, and the fixture is here so the degraded render path is exercised
 * by `npm run dev:mock` rather than only by a unit test.
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
  ProfileStatus,
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
    //
    //    Also the DEGRADED MARKET CONTEXT path: the systemic-risk lookup threw
    //    for this leg (the moonwell/moonwell-artemis id incident), so that
    //    sub-score is null and the composite renormalises over the three terms
    //    that were read: (95*.40 + 34*.25 + 52*.20) / .85 = 66.9 -> 67, which
    //    the HF <= 1.10 floor then lifts to 75. The total is unchanged, which
    //    is the point: the number stays real and only the SUB-score is unknown,
    //    so a UI that prints `Math.round(null)` here shows a 0 next to a
    //    CRITICAL dial and nothing else looks wrong.
    protocol: "morpho",
    wallet: MOCK_WALLET,
    total: 75,
    band: "CRITICAL",
    subScores: {
      positionHealth: 95,
      assetRisk: ASSET_RISK.cbBTC,
      protocolSafety: PROTOCOL_SAFETY.morpho,
      systemicRisk: null, // DefiLlama lookup failed for this leg — not measured, never 0
    },
    marketContextUnavailable: true,
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
// draw.
//
// ONE LEG PER POSITION, and the last point of every leg IS that position's live
// row. This is not tidiness: the Portfolio renders the same quantity twice, as
// the "Aggregate risk index" stat card (collateral-weighted over MOCK_POSITIONS)
// and as the header of "Risk index history" (collateral-weighted over the last
// day of snapshots). While this table held only moonwell and morpho the two
// were weighted over DIFFERENT SETS, so the page showed 57 in one card and 66
// in the card beside it — the same metric, disagreeing with itself, which is
// exactly the class of thing a risk product cannot ship. dev/fixtures.test.ts
// now asserts the two agree.
//
// Collateral is anchored to the live value and moves with the health factor:
// HF = collateral * LT / debt, so with debt and LT constant, collateral is
// proportional to HF. Deriving it from a hand-picked LT instead (the old
// `lt: 0.81`) landed the final day on $84,148 where the dashboard says $84,200,
// which is precisely the kind of near-miss that makes an equality test
// impossible to write.

interface HistoryLeg {
  protocol: LiveProtocol;
  /** PANIK score, oldest -> newest. `to` must equal the live position's total. */
  score: readonly [number, number];
  /** Health factor, oldest -> newest. null for a supply-only leg: no debt, no ratio. */
  hf: readonly [number, number] | null;
  /** Live collateral, or null when the price feed is degraded. NEVER 0. */
  collateralUsd: number | null;
  borrowUsd: number | null;
}

const HISTORY_LEGS: readonly HistoryLeg[] = [
  // Supply-only: no debt, so no health factor and no HF-driven collateral
  // drift. Its score moves on asset and systemic risk alone.
  { protocol: "aave_v3", score: [14, 19], hf: null, collateralUsd: 48_500, borrowUsd: 0 },
  { protocol: "moonwell", score: [34, 52], hf: [1.62, 1.2], collateralUsd: 84_200, borrowUsd: 56_800 },
  { protocol: "morpho", score: [48, 75], hf: [1.34, 1.05], collateralUsd: 128_500, borrowUsd: 105_200 },
  // Degraded feed. The health factor is a ratio and stays exact; the dollars are
  // NULL, which is the row scripts/watch-worker.ts actually inserts when
  // `usdValuesUnavailable` is set (it passes collateralValueUsd straight
  // through). Null and not 0 — and it is the only leg that exercises the
  // `?? 0` / `Math.max(1, …)` weighting branch in AppDemo's riskHistory, which
  // no fixture reached before.
  { protocol: "compound_v3", score: [30, 44], hf: [1.55, 1.34], collateralUsd: null, borrowUsd: null },
];

export const HISTORY_DAYS = 30;

/**
 * The alert feed, one row per line: days ago, protocol, score, band, previous
 * status, new status, delivery channel.
 *
 * Twelve rows, not three: the feed paginates at 8, so three exercised neither the
 * "Show N older alerts" control nor the second page. Every protocol here is one
 * the mock wallet holds, so every row is a live link to a position.
 *
 * `band` is written out rather than derived, so dev/fixtures.test.ts asserting
 * `band === bandFor(score)` stays a real check and not a tautology.
 *
 * Deliberately no `blocked` channel: that is the one delivery chip that keeps a
 * risk hue, and the Portfolio tab is held to exactly five risk-hued elements
 * (four dials plus the aggregate glyph). A sixth would turn a design budget into
 * a demo artefact.
 */
type AlertRow = readonly [
  daysAgo: number,
  protocol: LiveProtocol,
  score: number,
  band: Band,
  from: string | null,
  to: ProfileStatus,
  channel: string | null,
];

const ALERT_ROWS: readonly AlertRow[] = [
  [2, "moonwell", 51, "HIGH", "approaching", "outside", null], // queued: no Telegram in mock mode
  [4, "morpho", 61, "HIGH", "approaching", "outside", "telegram"],
  [11, "morpho", 44, "ELEVATED", "within", "approaching", "telegram"],
  [13, "compound_v3", 41, "ELEVATED", "within", "approaching", "telegram"],
  [14, "moonwell", 38, "ELEVATED", "outside", "approaching", "telegram"],
  [16, "moonwell", 55, "HIGH", "approaching", "outside", "telegram"],
  [18, "morpho", 78, "CRITICAL", "outside", "outside", "telegram"],
  [19, "aave_v3", 27, "ELEVATED", "within", "approaching", "suppressed_immaterial"],
  [21, "compound_v3", 33, "ELEVATED", "approaching", "within", "telegram"],
  [24, "morpho", 52, "HIGH", "approaching", "outside", "suppressed_cooldown"],
  [27, "moonwell", 22, "LOW", "approaching", "within", "telegram"],
  // The oldest row, and the only one with no prior status: the first reading
  // this wallet ever produced for that protocol.
  [29, "aave_v3", 16, "LOW", null, "within", "telegram"],
];

export function mockHistory(now = Date.now()): { alerts: HistoryAlert[]; snapshots: HistorySnapshot[] } {
  const snapshots: HistorySnapshot[] = [];
  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const createdAt = new Date(now - daysAgo * 86_400_000).toISOString();
    const t = (HISTORY_DAYS - 1 - daysAgo) / (HISTORY_DAYS - 1); // 0 oldest -> 1 newest
    for (const leg of HISTORY_LEGS) {
      // Trend plus a fixed wobble: a straight line does not look like a market,
      // and Math.random would redraw a different chart on every poll. Today
      // carries no wobble, so the series lands exactly on the live numbers.
      const wobble = Math.sin(daysAgo * 1.1) * 3;
      const hf = leg.hf ? leg.hf[0] + (leg.hf[1] - leg.hf[0]) * t : null;
      const collateral =
        leg.collateralUsd === null
          ? null
          : hf === null
            ? leg.collateralUsd
            : (leg.collateralUsd * hf) / leg.hf![1];
      snapshots.push({
        protocol: leg.protocol,
        total: Math.round(leg.score[0] + (leg.score[1] - leg.score[0]) * t + (daysAgo === 0 ? 0 : wobble)),
        health_factor: hf === null ? null : hf.toFixed(4),
        collateral_usd: collateral === null ? null : collateral.toFixed(2),
        borrow_usd: leg.borrowUsd === null ? null : leg.borrowUsd.toFixed(2),
        created_at: createdAt,
      });
    }
  }

  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  /** A delivered alert carries the moment it was delivered; nothing else does. */
  const alerts: HistoryAlert[] = ALERT_ROWS.map(
    ([daysAgo, protocol, score, band, from_status, to_status, notify_channel]) => ({
      protocol,
      risk_profile: "moderate",
      score,
      band,
      from_status,
      to_status,
      notify_channel,
      notified_at: notify_channel === "telegram" ? ago(daysAgo) : null,
      created_at: ago(daysAgo),
    }),
  );

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

/**
 * `apy` is a PERCENT, not a fraction — 8.12 means 8.12% — because that is what
 * DefiLlama's /chart endpoint returns and what `getPoolYields` in
 * scripts/api-server.ts hands straight to the client (the advisor's yield table
 * is the only consumer that converts, with `pool.apy / 100`).
 *
 * This fixture used to hold fractions (0.0812), so every Compass card rendered
 * `(0.0248).toFixed(1)` and printed "0.0%" for a live 2.5% pool. A fixture in
 * the wrong unit is worse than no fixture: the UI looked broken in the one
 * place a reviewer looks, and the bug was invisible against the real API.
 *
 * Only the unit changed: every value below is the same number it was, times a
 * hundred. The advisor fixtures downstream still hold FRACTIONS in their
 * `openPlan.apy`, which is correct — that is the side of `pool.apy / 100`.
 */
export const MOCK_POOLS: Record<string, PoolYield> = {
  "aave-usdc-supply": { apy: 8.12, tvlUsd: 214_000_000, apySeries: series(7.4, 0.7, 0.4), tvlSeries: series(198e6, 16e6, 6e6) },
  "moonwell-usdc-supply": { apy: 7.31, tvlUsd: 61_400_000, apySeries: series(6.9, 0.4, 0.5), tvlSeries: series(58e6, 3.4e6, 2.2e6) },
  "aave-wsteth-vault": { apy: 2.48, tvlUsd: 148_000_000, apySeries: series(2.6, -0.1, 0.2), tvlSeries: series(155e6, -7e6, 4e6) },
  "aave-weth-borrow": { apy: 1.93, tvlUsd: 176_000_000, apySeries: series(2.1, -0.2, 0.3), tvlSeries: series(168e6, 8e6, 5e6) },
  "moonwell-weth-debt": { apy: 2.87, tvlUsd: 42_800_000, apySeries: series(2.7, 0.2, 0.4), tvlSeries: series(40e6, 2.8e6, 1.8e6) },
  "morpho-weth-loop": { apy: 4.12, tvlUsd: 33_600_000, apySeries: series(3.6, 0.5, 0.6), tvlSeries: series(31e6, 2.6e6, 1.5e6) },
  "compound-weth-borrow": { apy: 2.24, tvlUsd: 57_200_000, apySeries: series(2.4, -0.2, 0.3), tvlSeries: series(55e6, 2.2e6, 2e6) },
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
/**
 * The same repay as a fraction of the leg's $56,800 debt, which is the form the
 * ExitFlow actually sizes from: 17851.43 / 56800 = 0.3142857…, rounded to the
 * 1/1e6 grid `repayFractionOfDebt` emits (packages/scoring/advisor/repayMath).
 */
const MOONWELL_REPAY_FRACTION = 0.314286;
/**
 * The same protection, funded by selling the leg's own collateral instead of
 * spending from the wallet.
 *
 * collateralFundedRepayToTargetHf(56800, 1.20, 1.75, 0.81) = 33234.0425…,
 * with 0.81 standing in for the leg's weighted liquidation threshold (Moonwell
 * is a Compound-V2 fork, so one collateralFactorMantissa is both the borrow
 * limit and the liquidation threshold). It repays MORE than the wallet-funded
 * plan because selling collateral shrinks both sides of the health factor, and
 * that gap is the thing the two-outcome card exists to show.
 *
 * The fraction is the same 1/1e6 grid `repayFractionOfDebt` emits:
 * 33234.0425… / 56800 = 0.5851063… -> 0.585106.
 */
const MOONWELL_COLLATERAL_REPAY_USD = 33_234;
const MOONWELL_COLLATERAL_REPAY_FRACTION = 0.585106;

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
    // Narrated, so the AI-label block is reachable in dev:mock — and CRITICAL,
    // so the verdict above is the one sentence a narrated leg still gets from
    // the engine (the template slot in AdvisorNarrator). The card should show
    // the lead unlabelled and the label only inside "Why this".
    narrationSource: "narrated",
    exitPrefill: { protocol: "morpho", kind: "full" },
  },
  {
    protocol: "moonwell",
    wallet: MOCK_WALLET,
    action: "REDUCE",
    urgency: "warning",
    triggers: ["band:HIGH", "profile:outside", "repay:collateral_funded_available"],
    repayPlan: {
      repayUsd: MOONWELL_REPAY_USD,
      repayAssetSymbol: "USDC",
      repayFraction: MOONWELL_REPAY_FRACTION,
      targetHf: 1.75,
      projectedHf: 1.75,
      mode: "wallet_funded",
    },
    // Both routes to the same target, which is what the engine emits: it cannot
    // see whether this wallet holds $17,851 of USDC, so it sizes each and the
    // card names what each one needs. The costs are the engine's own constants
    // for a Moonwell leg (worst-case flash fee, the 1% swap allowance, and the
    // fork-measured gas), so the card's cost line is reachable in dev:mock.
    collateralFundedAlternative: {
      repayUsd: MOONWELL_COLLATERAL_REPAY_USD,
      repayAssetSymbol: "USDC",
      repayFraction: MOONWELL_COLLATERAL_REPAY_FRACTION,
      targetHf: 1.75,
      projectedHf: 1.75,
      mode: "collateral_funded",
      costs: { flashFeeBps: 5, slippageBps: 100, gasUnits: 1_167_280 },
    },
    sections: {
      position:
        "Your Moonwell position holds $84,200 collateral against $56,800 debt (health factor 1.20, PANIK score 52 - HIGH). A 17% WETH (proxy) price drop would trigger liquidation.",
      market: "The score is being driven by position health (80/100).",
      recommendation:
        "Repay ~$17,851 of USDC debt on Moonwell to lift your health factor from 1.20 to 1.75.",
      execution:
        "The Reduce button pre-fills a partial exit repaying ~$17,851 of USDC on Moonwell; you sign the transaction yourself.",
    },
    numbers: numbersOf(LEVERED_WETH),
    // Narrated and NOT critical, so this is the card where the lead sentence
    // itself sits in the AI block. The prose is still the deterministic
    // template: the fixture is standing in for a served narration, and copying
    // the engine's own words is the one wording guaranteed to pass the guard.
    narrationSource: "narrated",
    exitPrefill: {
      protocol: "moonwell",
      kind: "partial",
      repayUsd: MOONWELL_REPAY_USD,
      repayFraction: MOONWELL_REPAY_FRACTION,
      // The three readings the exit flow cannot make for itself, so a repay it
      // has to cap to the wallet balance can still say what that buys. Straight
      // off the same leg the numbers block is built from.
      borrowUsd: LEVERED_WETH.borrowValueUsd,
      healthFactor: LEVERED_WETH.healthFactor,
      collateralSymbol: LEVERED_WETH.scoredCollateralSymbol,
    },
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
        "Your Compound V3 position's USD values are unavailable (degraded price feed) - the health factor below is still exact (health factor 1.34, PANIK score 44 - ELEVATED). A 25% cbBTC price drop would trigger liquidation.",
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
    // True because two legs carry `narrationSource: "narrated"`. The report flag
    // and the per-leg flag answer different questions and both are rendered:
    // this one drives the banner's provenance line, the per-leg one decides
    // which blocks wear the "AI-generated summary" label.
    narrated: true,
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
