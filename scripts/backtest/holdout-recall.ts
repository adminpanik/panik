/**
 * Recall / false-alarm with an explicit CALIBRATION vs HOLDOUT split (roadmap 5.4).
 *
 * The published 89% pooled recall is a CALIBRATION number in the parts that
 * matter: both crash-regime gates were chosen on the June-2022 cohort. This
 * script re-measures the same confusion matrix per event and prints which
 * events the gates were fitted on and which they had never seen, so a headline
 * can be quoted with the half it is entitled to.
 *
 * WHAT IS CALIBRATION AND WHAT IS HOLDOUT, and why (sources in-repo):
 *
 *  - June 2022 = CALIBRATION, twice over. The asset-risk gate of 60 was placed
 *    in the gap between calm Apr-May 2022 (29.8-42.8) and the June crash
 *    (66.4-82.7); the HF gate of 1.25 was chosen from a 560-wallet survivor
 *    matrix sampled at four June blocks, against 1.10 and 1.35. Both are
 *    recorded on CRASH_REGIME in packages/scoring/src/params.ts and in
 *    docs/technical-docs/BACKTEST_RESULTS.md.
 *  - UST/LUNA May 2022 = PARTIALLY IN-SAMPLE. No parameter was fitted on it,
 *    but a MODEL choice was: the acute short-horizon drawdown trigger (v2) was
 *    investigated and rejected on UST evidence (params.ts). Rejecting a variant
 *    on an event is model selection, so UST is not a clean holdout.
 *  - USDC depeg Mar 2023 = HOLDOUT. The peg-break escalation experiment was run
 *    on it and REVERTED (scripts/backtest/survivor-matrix-usdc.ts), so nothing
 *    in the shipped engine was chosen from it.
 *  - Aug-2024 Base = HOLDOUT. Added after the gates shipped; no parameter or
 *    variant decision references it.
 *  - FTX Nov 2022 = NOT MEASURABLE HERE. No price series for that window is
 *    committed to this repo, so its asset risk cannot be evaluated offline.
 *    Excluded and stated, never estimated: the published FTX 53% is not
 *    reproduced or contradicted by this run.
 *
 * OFFLINE ONLY. Reproduces survivor-matrix-real.ts without Dune or an archive
 * RPC by reading the exported evidence instead: datasets/positions_<event>.csv
 * (exact per-wallet HF at each sampled block, from those same archive reads) and
 * the price series committed in tests/fixtures + datasets.
 *
 * ASSUMPTIONS:
 *  1. A wallet is flagged if it reached CRITICAL at ANY sampled block strictly
 *     before its first LiquidationCall - the same rule survivor-matrix-real.ts
 *     uses. Sparse block sampling misses dips between blocks, so recall here is
 *     a FLOOR.
 *  2. Blank health_factor = no debt at that block; a wallet with no pre-exit
 *     debt sample is excluded from the matrix entirely.
 *  3. Systemic risk is held flat (no offline TVL), so S_systemic = 0. This
 *     under-warns, again biasing recall down.
 *  4. Reserve params per event are the collateral's Aave config, listed on each
 *     EVENTS entry. They enter only through currentLtv = min(LT/HF, 0.95).
 *  5. UST-window positions are scored against WETH, matching what
 *     survivor-matrix-real.ts did for that cohort.
 *
 * Run:
 *   node --import tsx scripts/backtest/holdout-recall.ts
 *
 * ── RESULTS, measured 2026-08-24 ────────────────────────────────────────────
 *
 * The offline reproduction lands on the published per-event figures exactly
 * (BACKTEST_RESULTS.md: June 49 -> 88 at 34% false alarm, UST 94 -> 94 at 20%,
 * USDC 97 -> 97 at 30%, Aug-2024 92 -> 92 at 24%). Survivor counts differ by
 * two wallets on June (1257 here against 1259 there), which is the no-pre-exit-
 * debt filter, not a different cohort.
 *
 *   split         liq   surv   baseline recall   shipped recall   false alarm
 *   CALIBRATION   408   1257              49%              88%           34%
 *   PARTIAL       262   1454              94%              94%           20%
 *   HOLDOUT      1494    491              92%              92%           26%
 *   ALL (no FTX) 2164   3202              84%              91%           26%
 *
 * Two things this says that the pooled number hides:
 *
 *  1. Recall out of sample is 92% on 1,494 liquidated positions across two
 *     crises no threshold was tuned on, at a 26% false-alarm rate over 491
 *     survivors. That is a defensible headline, and it is NOT the same claim as
 *     the published pooled 89%, which includes the calibration event and FTX.
 *  2. On both holdout events the crash regime changed NOTHING - baseline and
 *     shipped recall are identical, because the asset-risk gate never opened
 *     there (Mar-2023 peak 50, Aug-2024 peak 53, gate 60; see
 *     crash-drawdown.ts). The entire +39pt lift the crash regime is credited
 *     with is measured on the event it was calibrated on. Out of sample the
 *     static proximity floors are doing all of the work.
 *
 * Neither of those is evidence the gate is wrong: no holdout event reached a
 * June-2022-scale sell-off, so the gate was never given a chance to fire. It is
 * evidence that the gate is UNVALIDATED out of sample, which is a different and
 * quotable fact.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeScore } from "../../packages/scoring/src/computeScore";
import { dailyReturns } from "../../packages/scoring/src/math";
import type { AssetRiskInput, Protocol } from "../../packages/scoring/src/types";
import {
  DAILY_START,
  WBTC_DAILY,
  WETH_DAILY,
} from "../../packages/scoring/tests/fixtures/ethCrash2022";
import {
  USDC as USDC_2023,
  WBTC as WBTC_2023,
} from "../../packages/scoring/tests/fixtures/depeg2023";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "datasets");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Pre-event the off-chain TVL signal is unavailable -> held flat. */
const FLAT_SYSTEMIC = {
  sectorTvlNow: 100e9,
  sectorTvl7dAgo: 100e9,
  protocolTvlNow: 5e9,
  protocolTvl7dAgo: 5e9,
};

function csv(name: string): string[][] {
  return readFileSync(resolve(DIR, name), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","));
}

const aug24Daily = csv("prices_weth_wbtc_daily_aug2024.csv");
const AUG24_WETH = aug24Daily.map((r) => Number(r[1]));
const AUG24_WBTC = aug24Daily.map((r) => Number(r[2]));
const AUG24_START = Date.parse(aug24Daily[0]?.[0] as string);

/** Aug-2024 Base block labels, from scripts/backtest/survivor-matrix-base.ts.
 * The CSV export carries no block_time for this event. */
const AUG24_LABEL_ISO: Record<string, string> = {};
for (let i = 0; i < 16; i++) {
  AUG24_LABEL_ISO[`h${i * 6 < 10 ? "0" : ""}${i * 6}`] = new Date(
    Date.UTC(2024, 7, 4) + i * 6 * HOUR_MS,
  ).toISOString();
}

type Split = "CALIBRATION" | "PARTIAL" | "HOLDOUT";

interface EventSpec {
  event: string;
  label: string;
  split: Split;
  /** Protocol-safety is scored as aave_v3 for every event, the same substitution
   * survivor-matrix-real.ts makes: the engine has no aave_v2 entry, and the term
   * is a constant per protocol so it shifts every event by the same amount. */
  protocol: Protocol;
  collateral: string;
  liquidationThreshold: number;
  maxLtv: number;
  px: number[];
  btc: number[];
  startMs: number;
  isoByLabel?: Record<string, string>;
}

const EVENTS: EventSpec[] = [
  {
    event: "june",
    label: "June 2022 stETH cascade (Aave V2 ETH)",
    split: "CALIBRATION",
    protocol: "aave_v3",
    collateral: "WETH",
    liquidationThreshold: 0.825,
    maxLtv: 0.8,
    px: WETH_DAILY,
    btc: WBTC_DAILY,
    startMs: DAILY_START,
  },
  {
    event: "ust",
    label: "UST/LUNA May 2022 (Aave V2 ETH)",
    split: "PARTIAL",
    protocol: "aave_v3",
    collateral: "WETH",
    liquidationThreshold: 0.825,
    maxLtv: 0.8,
    px: WETH_DAILY,
    btc: WBTC_DAILY,
    startMs: DAILY_START,
  },
  {
    event: "usdc",
    label: "USDC depeg Mar 2023 (Aave V2 ETH)",
    split: "HOLDOUT",
    protocol: "aave_v3",
    collateral: "USDC",
    // Aave V2 USDC reserve: 80% LTV / 85% liquidation threshold.
    liquidationThreshold: 0.85,
    maxLtv: 0.8,
    px: USDC_2023,
    btc: WBTC_2023,
    startMs: Date.UTC(2022, 11, 9),
  },
  {
    event: "aave-aug24",
    label: "Aug 2024 yen-carry unwind (Aave V3 Base)",
    split: "HOLDOUT",
    protocol: "aave_v3",
    collateral: "WETH",
    // Base V3 WETH, as used by scripts/backtest/survivor-matrix-base.ts.
    liquidationThreshold: 0.83,
    maxLtv: 0.8,
    px: AUG24_WETH,
    btc: AUG24_WBTC,
    startMs: AUG24_START,
    isoByLabel: AUG24_LABEL_ISO,
  },
];

/** AssetRiskInput for the day containing `ts`, windowed strictly at or before it. */
function assetRiskAt(e: EventSpec, ts: number): AssetRiskInput | null {
  const d = Math.floor((ts - e.startMs) / DAY_MS);
  if (d < 30 || d >= e.px.length) return null; // fewer than 30 returns -> no reading
  return {
    dailyReturns30d: dailyReturns(e.px.slice(d - 30, d + 1)),
    btcReturns30d: dailyReturns(e.btc.slice(d - 30, d + 1)),
    prices90d: e.px.slice(Math.max(0, d - 90), d + 1),
  };
}

interface Sample {
  ts: number;
  hf: number;
}
interface Wallet {
  liquidated: boolean;
  exit: number;
  samples: Sample[];
}

function loadWallets(e: EventSpec): Wallet[] {
  const byOwner = new Map<string, Wallet>();
  for (const row of csv(`positions_${e.event}.csv`)) {
    const [, owner, liq, firstLiq, label, blockTime, hfRaw] = row;
    if (!owner) continue;
    const iso = blockTime && blockTime.length > 0 ? blockTime : e.isoByLabel?.[label as string];
    const exit = firstLiq && firstLiq.length > 0 ? Date.parse(firstLiq) : Number.POSITIVE_INFINITY;
    const w =
      byOwner.get(owner) ?? { liquidated: liq === "true", exit, samples: [] };
    byOwner.set(owner, w);
    // Blank HF = no debt at that block. Post-exit samples are the liquidator's
    // work, not the market's.
    if (!iso || !hfRaw) continue;
    const ts = Date.parse(iso);
    const hf = Number(hfRaw);
    if (!Number.isFinite(ts) || !Number.isFinite(hf) || hf <= 0) continue;
    if (ts >= exit) continue;
    w.samples.push({ ts, hf });
  }
  return [...byOwner.values()].filter((w) => w.samples.length > 0);
}

function flagged(e: EventSpec, w: Wallet, crashRegime: boolean): boolean {
  for (const s of w.samples) {
    const assetRisk = assetRiskAt(e, s.ts);
    if (assetRisk === null) continue;
    const r = computeScore(
      {
        protocol: e.protocol,
        positionHealth: {
          healthFactor: s.hf,
          currentLtv: Math.min(e.liquidationThreshold / s.hf, 0.95),
          maxLtv: e.maxLtv,
        },
        assetRisk,
        systemicRisk: FLAT_SYSTEMIC,
      },
      { crashRegime },
    );
    if (r.band === "CRITICAL") return true;
  }
  return false;
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "  n/a");

interface Matrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}
const empty = (): Matrix => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
function add(a: Matrix, b: Matrix): Matrix {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn, tn: a.tn + b.tn };
}
function row(name: string, m: Matrix): string {
  const recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : Number.NaN;
  const fa = m.fp + m.tn ? m.fp / (m.fp + m.tn) : Number.NaN;
  return `${name.padEnd(52)} ${String(m.tp + m.fn).padStart(5)} ${String(m.fp + m.tn).padStart(6)}   ${pct(recall).padStart(6)}  ${pct(fa).padStart(11)}`;
}

for (const crashRegime of [false, true]) {
  console.log(
    `\n=== ${crashRegime ? "SHIPPED (crash regime on)" : "BASELINE (static floors only)"} - flag = ever CRITICAL pre-exit ===`,
  );
  console.log(`${"event".padEnd(52)} ${"liq".padStart(5)} ${"surv".padStart(6)}   recall  false-alarm`);
  console.log("-".repeat(85));
  const bySplit = new Map<Split, Matrix>();
  for (const e of EVENTS) {
    const m = empty();
    for (const w of loadWallets(e)) {
      const f = flagged(e, w, crashRegime);
      if (w.liquidated) f ? m.tp++ : m.fn++;
      else f ? m.fp++ : m.tn++;
    }
    bySplit.set(e.split, add(bySplit.get(e.split) ?? empty(), m));
    console.log(row(`${e.label} [${e.split}]`, m));
  }
  console.log("-".repeat(85));
  for (const split of ["CALIBRATION", "PARTIAL", "HOLDOUT"] as Split[]) {
    const m = bySplit.get(split);
    if (m) console.log(row(`POOLED ${split}`, m));
  }
  const all = [...bySplit.values()].reduce(add, empty());
  console.log(row("POOLED ALL (offline events only, no FTX)", all));
}
console.log(
  "\nFTX Nov 2022 is absent: no price series for that window is committed offline.",
);
