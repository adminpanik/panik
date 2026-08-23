/**
 * Crash-conditional forward-drawdown research (roadmap 5.2, and the evidence
 * for the 5.3 crash promote-to-exit ratio).
 *
 * Two questions, one pass over the real price series already in this repo:
 *
 *  A. d* — "survive an X% drop" is only a target if X is measured. For every
 *     day the ENGINE ITSELF calls a crash (S_asset_risk >= CRASH_REGIME
 *     .assetRiskAtOrAbove, evaluated per day from the real series, the same
 *     gate rules.ts uses), how far did the collateral fall AFTERWARDS? The
 *     percentiles of that forward drawdown are the candidate d* values, per
 *     collateral asset.
 *
 *  B. the crash ratio — a repay to target T at time t survives iff the forward
 *     drawdown from t stays at or below 1 - 1/T. Note what that does NOT
 *     contain: the repay SIZE. Post-repay the position sits at T whatever it
 *     cost to get there, so futility is a property of the target and the market,
 *     not of R/D. Part B measures it anyway, bucketed by R/D over the real
 *     per-wallet health factors, so the claim is checked rather than asserted.
 *
 * OFFLINE ONLY. Every input is committed in this repo; no RPC, no Dune, no key.
 *   - packages/scoring/tests/fixtures/ethCrash2022.ts  WETH+WBTC daily
 *     2022-03-12..06-19, WETH hourly 2022-06-06..06-19
 *   - packages/scoring/tests/fixtures/depeg2023.ts     USDC+WETH+WBTC daily
 *     2022-12-09..2023-03-15
 *   - scripts/backtest/datasets/prices_weth_*_aug2024.csv  WETH+WBTC daily
 *     2024-05-01..08-07, WETH hourly 2024-08-03..08-07
 *   - scripts/backtest/datasets/positions_<event>.csv  per-wallet exact HFs
 *
 * FTX (Nov 2022) is absent from part A and B on purpose: no price series for
 * that window is committed offline, so its asset risk cannot be evaluated here.
 * Excluded, not estimated.
 *
 * ASSUMPTIONS, all of them load-bearing:
 *  1. Forward drawdown is truncated at the end of each series. Truncation can
 *     only make a drawdown look SMALLER, so every number here understates the
 *     danger. `horizon` in the output is the horizon actually available.
 *  2. Debt is a stablecoin, so HF moves with the collateral price alone. This is
 *     the same reconstruction the backtest replay uses and it is exact for the
 *     WETH-collateral / stablecoin-debt cohorts these CSVs contain.
 *  3. A day is "crash" by the engine's own gate, not by hand-picked dates. That
 *     keeps d* conditional on the thing the product can actually detect.
 *  4. Days are treated as independent samples. They are NOT: overlapping forward
 *     windows inside one sell-off are heavily autocorrelated, so an "n" here is
 *     a count of days, never a count of independent crashes. The independent
 *     crash count is the window count, which is 4.
 *
 * Run:
 *   node --import tsx scripts/backtest/crash-drawdown.ts
 *
 * ── RESULTS, measured 2026-08-24, and what they do NOT support ──────────────
 *
 * A. The market half of the crash gate opened in ONE of the four windows with a
 *    committed price series. Peak S_asset_risk over each series: WETH 2022 = 83
 *    (24 crash days), WBTC 2022 = 71 (6 crash days), WETH Mar-2023 = 50, USDC
 *    Mar-2023 = 18, WETH Aug-2024 = 53, WBTC Aug-2024 = 45 - all four of the
 *    last ones below the gate of 60, so those windows contribute NO crash days.
 *    (Cross-check: datasets/black_swan_events.csv records peaks of 82 for June
 *    2022 and 52 for Aug 2024, against 83 and 53 here. Its USDC figure of 2 is
 *    the PRE-event reading; 18 here is the max over the whole series, which
 *    includes the post-depeg vol spike. Both are far below the gate.)
 *
 *    WETH crash-day forward drawdown: 7d p50 9.3%, p90 33.0%, p95 34.8%,
 *    max 38.1%; 14d p90 40.2%, max 42.6%. Against the shipped d* of 50.0 /
 *    42.9 / 33.3%, so conservative and moderate sit at or above the worst
 *    14-day drawdown in that crash and aggressive sits near its 7-day p90.
 *
 *    That is ONE independent sell-off. 24 overlapping daily windows from a
 *    single crash cannot set a per-asset live risk parameter, and WBTC's 6 days
 *    are a fragment of the same one. So 5.2 FALLS BACK to the 5.1 constants:
 *    TARGET_DRAWDOWN stays derived from TARGET_HF. The measurement is here so
 *    the next window makes the sample bigger instead of starting it over.
 *
 * B. Crash-gated futility, by profile, over the same states the advisor would
 *    size a repay for: conservative 0/2227 crash states futile, moderate
 *    0/1723, aggressive 313/1046 = 29.9%. Within aggressive the relation to repay
 *    size runs the WRONG WAY: 32.0% futile in the R/D 0.0-0.1 bucket against
 *    27.4% in 0.1-0.2.
 *
 *    That is the expected shape rather than a surprise, and it is the reason
 *    part B exists: after the repay the position sits at T no matter what the
 *    repay cost, so whether the crash then eats it is a fact about T and the
 *    market, with R/D nowhere in it. A "promote to exit above X% of debt" rule
 *    keyed on R/D is therefore keyed on the wrong variable - the measured
 *    correlation is slightly negative.
 *
 *    So there is no defensible crash value for REDUCE_TO_EXIT_RATIO in this
 *    data. It stays flat at 0.9 until either a value is chosen on other
 *    grounds or the promotion is re-keyed onto something that predicts
 *    futility. Note also that R/D never exceeds 0.4 in any bucket above:
 *    rule 3 only sees legs above the 1.25 proximity gate, which caps R/D at
 *    1 - 1.25/T = 0.375 conservative, 0.286 moderate, 0.167 aggressive.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TARGET_DRAWDOWN, TARGET_HF } from "../../packages/scoring/src/advisor/repayMath";
import { dailyReturns } from "../../packages/scoring/src/math";
import { CRASH_REGIME } from "../../packages/scoring/src/params";
import { scoreAssetRisk } from "../../packages/scoring/src/subscores/assetRisk";
import type { RiskProfile } from "../../packages/scoring/src/types";
import {
  DAILY_START,
  WBTC_DAILY,
  WETH_DAILY,
  WETH_HOURLY,
  WETH_HOURLY_START,
} from "../../packages/scoring/tests/fixtures/ethCrash2022";
import {
  USDC as USDC_2023,
  WBTC as WBTC_2023,
  WETH as WETH_2023,
} from "../../packages/scoring/tests/fixtures/depeg2023";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "datasets");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PROFILES: RiskProfile[] = ["conservative", "moderate", "aggressive"];

function csv(name: string): string[][] {
  return readFileSync(resolve(DIR, name), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","));
}

/** Nearest-rank percentile. No interpolation: these are order statistics of a
 * small sample and inventing values between them would overstate resolution. */
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}

const fmtPct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "  n/a");

interface DailySeries {
  label: string;
  asset: string;
  startMs: number;
  px: number[];
  btc: number[];
}

const aug24Daily = csv("prices_weth_wbtc_daily_aug2024.csv");
const AUG24_WETH = aug24Daily.map((r) => Number(r[1]));
const AUG24_WBTC = aug24Daily.map((r) => Number(r[2]));
const AUG24_DAILY_START = Date.parse(aug24Daily[0]?.[0] as string);

const aug24Hourly = csv("prices_weth_hourly_aug2024.csv");
const AUG24_WETH_HOURLY = aug24Hourly.map((r) => Number(r[1]));
const AUG24_HOURLY_START = Date.parse(aug24Hourly[0]?.[0] as string);

/** One entry per (collateral asset, crash window) with a committed price series. */
const SERIES: DailySeries[] = [
  { label: "UST + June 2022 (ETH mainnet)", asset: "WETH", startMs: DAILY_START, px: WETH_DAILY, btc: WBTC_DAILY },
  // WBTC as its own BTC proxy: correlation-to-BTC is 1 by construction, which
  // is what the live adapter also feeds for a BTC-family collateral.
  { label: "UST + June 2022 (ETH mainnet)", asset: "WBTC", startMs: DAILY_START, px: WBTC_DAILY, btc: WBTC_DAILY },
  { label: "USDC depeg / SVB Mar 2023", asset: "USDC", startMs: Date.UTC(2022, 11, 9), px: USDC_2023, btc: WBTC_2023 },
  { label: "USDC depeg / SVB Mar 2023", asset: "WETH", startMs: Date.UTC(2022, 11, 9), px: WETH_2023, btc: WBTC_2023 },
  { label: "Aug 2024 unwind (Base cohort)", asset: "WETH", startMs: AUG24_DAILY_START, px: AUG24_WETH, btc: AUG24_WBTC },
  { label: "Aug 2024 unwind (Base cohort)", asset: "WBTC", startMs: AUG24_DAILY_START, px: AUG24_WBTC, btc: AUG24_WBTC },
];

/** S_asset_risk on day `d`, built exactly as the live adapter builds it. */
function assetRiskOn(s: DailySeries, d: number): number | null {
  if (d < 30) return null; // no 30 returns yet -> no reading, and no reading is not a crash
  return scoreAssetRisk({
    dailyReturns30d: dailyReturns(s.px.slice(d - 30, d + 1)),
    btcReturns30d: dailyReturns(s.btc.slice(d - 30, d + 1)),
    prices90d: s.px.slice(Math.max(0, d - 90), d + 1),
  });
}

/** Peak-to-trough drawdown from index `i` forward, over at most `h` steps. */
function forwardDrawdown(px: number[], i: number, h: number): number {
  const from = px[i] as number;
  if (!(from > 0)) return Number.NaN;
  let lo = from;
  for (let k = i; k <= Math.min(px.length - 1, i + h); k++) lo = Math.min(lo, px[k] as number);
  return 1 - lo / from;
}

// ── Part A: crash-conditional forward drawdown ──────────────────────────────
console.log("\n=== A. forward drawdown on days the engine calls a crash ===");
console.log(`crash gate: S_asset_risk >= ${CRASH_REGIME.assetRiskAtOrAbove}`);
console.log("horizon = calendar days forward, truncated at the end of the series\n");

const HORIZONS = [3, 7, 14];
const pooled = new Map<string, number[]>();

for (const s of SERIES) {
  const crashDays: number[] = [];
  let peakRisk = 0;
  for (let d = 0; d < s.px.length; d++) {
    const ar = assetRiskOn(s, d);
    if (ar === null) continue;
    peakRisk = Math.max(peakRisk, ar);
    if (ar >= CRASH_REGIME.assetRiskAtOrAbove) crashDays.push(d);
  }
  const iso = (d: number) => new Date(s.startMs + d * DAY_MS).toISOString().slice(0, 10);
  console.log(
    `${s.asset.padEnd(5)} ${s.label.padEnd(32)} days=${String(s.px.length).padStart(3)}  peak S_asset_risk=${peakRisk.toFixed(0)}  crash days=${crashDays.length}` +
      (crashDays.length ? `  (${iso(crashDays[0] as number)}..${iso(crashDays[crashDays.length - 1] as number)})` : ""),
  );
  if (crashDays.length === 0) {
    console.log("      no crash days -> nothing measurable for this asset/window\n");
    continue;
  }
  console.log("      horizon      n     p50     p75     p90     p95     max");
  for (const h of HORIZONS) {
    const dd = crashDays.map((d) => forwardDrawdown(s.px, d, h)).filter(Number.isFinite);
    dd.sort((a, b) => a - b);
    if (h === 7) pooled.set(s.asset, [...(pooled.get(s.asset) ?? []), ...dd]);
    console.log(
      `      ${String(h).padStart(2)}d     ${String(dd.length).padStart(4)}  ${fmtPct(pct(dd, 0.5)).padStart(6)}  ${fmtPct(pct(dd, 0.75)).padStart(6)}  ${fmtPct(pct(dd, 0.9)).padStart(6)}  ${fmtPct(pct(dd, 0.95)).padStart(6)}  ${fmtPct(dd[dd.length - 1] as number).padStart(6)}`,
    );
  }
  console.log("");
}

console.log("pooled by collateral asset (7d horizon; days are NOT independent):");
console.log("asset    n     p50     p75     p90     p95     max");
for (const [asset, dd] of [...pooled.entries()].sort()) {
  const s = [...dd].sort((a, b) => a - b);
  console.log(
    `${asset.padEnd(6)} ${String(s.length).padStart(3)}  ${fmtPct(pct(s, 0.5)).padStart(6)}  ${fmtPct(pct(s, 0.75)).padStart(6)}  ${fmtPct(pct(s, 0.9)).padStart(6)}  ${fmtPct(pct(s, 0.95)).padStart(6)}  ${fmtPct(s[s.length - 1] as number).padStart(6)}`,
  );
}

console.log("\nshipped d* (repayMath.TARGET_DRAWDOWN), for comparison:");
for (const p of PROFILES) {
  console.log(`  ${p.padEnd(13)} T=${TARGET_HF[p].toFixed(2)}  d*=${fmtPct(TARGET_DRAWDOWN[p])}`);
}

// ── Part B: was a repay to target futile, and does repay SIZE predict it? ────
interface EventSpec {
  event: string;
  px: number[];
  startMs: number;
  stepMs: number;
  /** Labels with no block_time in the CSV export (see survivor-matrix-base.ts). */
  isoByLabel?: Record<string, string>;
  horizonSteps: number;
  /** The daily series the crash gate is evaluated on for this event. */
  ar: DailySeries;
}

const WETH_2022_SERIES = SERIES[0] as DailySeries;
const USDC_2023_SERIES = SERIES[2] as DailySeries;
const WETH_2024_SERIES = SERIES[4] as DailySeries;

const AUG24_LABEL_ISO: Record<string, string> = {};
for (let i = 0; i < 16; i++) {
  AUG24_LABEL_ISO[`h${i * 6 < 10 ? "0" : ""}${i * 6}`] = new Date(
    Date.UTC(2024, 7, 4) + i * 6 * HOUR_MS,
  ).toISOString();
}

const EVENTS: EventSpec[] = [
  { event: "june", px: WETH_HOURLY, startMs: WETH_HOURLY_START, stepMs: HOUR_MS, horizonSteps: 7 * 24, ar: WETH_2022_SERIES },
  { event: "ust", px: WETH_DAILY, startMs: DAILY_START, stepMs: DAY_MS, horizonSteps: 7, ar: WETH_2022_SERIES },
  { event: "usdc", px: USDC_2023, startMs: Date.UTC(2022, 11, 9), stepMs: DAY_MS, horizonSteps: 7, ar: USDC_2023_SERIES },
  {
    event: "aave-aug24",
    px: AUG24_WETH_HOURLY,
    startMs: AUG24_HOURLY_START,
    stepMs: HOUR_MS,
    isoByLabel: AUG24_LABEL_ISO,
    horizonSteps: 7 * 24,
    ar: WETH_2024_SERIES,
  },
];

/** Is the market half of the crash gate open on the day containing `ts`? */
function inCrashMarket(e: EventSpec, ts: number): boolean {
  const d = Math.floor((ts - e.ar.startMs) / DAY_MS);
  if (d < 0 || d >= e.ar.px.length) return false;
  const ar = assetRiskOn(e.ar, d);
  return ar !== null && ar >= CRASH_REGIME.assetRiskAtOrAbove;
}

console.log("\n=== B. futility of a repay to target, by repay size ===");
console.log("a repay to T at time t is FUTILE if the forward drawdown from t exceeds 1 - 1/T");
console.log("R/D is the wallet-funded repay 1 - HF/T at that same t\n");

for (const p of PROFILES) {
  const T = TARGET_HF[p];
  const dStar = TARGET_DRAWDOWN[p];
  // 10 buckets of R/D, 0.0-0.1 .. 0.9-1.0
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, futile: 0, crashN: 0, crashFutile: 0 }));
  let n = 0;
  let futile = 0;
  let truncated = 0;
  let crashN = 0;
  let crashFutile = 0;
  for (const e of EVENTS) {
    for (const row of csv(`positions_${e.event}.csv`)) {
      const [, , , firstLiq, label, blockTime, hfRaw] = row;
      const iso = blockTime && blockTime.length > 0 ? blockTime : e.isoByLabel?.[label as string];
      if (!iso || !hfRaw) continue;
      const ts = Date.parse(iso);
      const hf = Number(hfRaw);
      if (!Number.isFinite(hf) || hf <= 0) continue;
      // Pre-liquidation samples only: after the first LiquidationCall the health
      // factor is the liquidator's work, not the market's.
      if (firstLiq && Date.parse(firstLiq) <= ts) continue;
      // Only states the advisor would actually size a repay for: rule 2 exits
      // at or below the proximity gate, and at or above T there is no repay.
      if (hf <= CRASH_REGIME.hfAtOrBelow || hf >= T) continue;
      const i = Math.round((ts - e.startMs) / e.stepMs);
      if (i < 0 || i >= e.px.length) continue;
      if (i + e.horizonSteps > e.px.length - 1) truncated++;
      const dd = forwardDrawdown(e.px, i, e.horizonSteps);
      if (!Number.isFinite(dd)) continue;
      const isFutile = dd > dStar;
      const crash = inCrashMarket(e, ts);
      const ratio = 1 - hf / T;
      const b = buckets[Math.min(9, Math.floor(ratio * 10))];
      if (b) {
        b.n++;
        if (isFutile) b.futile++;
        if (crash) {
          b.crashN++;
          if (isFutile) b.crashFutile++;
        }
      }
      n++;
      if (crash) {
        crashN++;
        if (isFutile) crashFutile++;
      }
      if (isFutile) futile++;
    }
  }
  console.log(`${p} (T=${T}, d*=${fmtPct(dStar)}): ${n} (wallet, time) states, ${truncated} with a truncated horizon`);
  if (n === 0) {
    console.log("  no states -> nothing measurable for this profile\n");
    continue;
  }
  console.log(`  overall futile: ${futile}/${n} = ${fmtPct(futile / n)}`);
  console.log(
    `  in an open crash market: ${crashFutile}/${crashN} = ${crashN ? fmtPct(crashFutile / crashN) : "n/a"}`,
  );
  console.log("  R/D bucket     n   futile   crash-n  crash-futile");
  for (let i = 0; i < 10; i++) {
    const b = buckets[i];
    if (!b || b.n === 0) continue;
    console.log(
      `  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}   ${String(b.n).padStart(5)}   ${fmtPct(b.futile / b.n).padStart(6)}   ${String(b.crashN).padStart(7)}  ${(b.crashN ? fmtPct(b.crashFutile / b.crashN) : "n/a").padStart(12)}`,
    );
  }
  console.log("");
}
