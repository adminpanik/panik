/**
 * Authoritative multi-event survivor matrix — runs the REAL scoring engine.
 *
 * For every candidate at every crash block we build the actual ScoringInput
 * (exact HF from archive RPC; LTV from HF; S_asset_risk from the real daily
 * series at that date; systemic held flat) and call computeScore — once with the
 * crash regime OFF (baseline = static floors) and once ON (shipped). A position
 * is "flagged" if it reached CRITICAL at any block before it exited (liquidation)
 * or before the window ended (survivor). This removes the "asset_risk ≥ 60 holds"
 * proxy: the gate is evaluated per block from real data.
 *
 * Run: node --env-file=.env --import ./scripts/backtest/dnsfix.mjs --import tsx \
 *        scripts/backtest/survivor-matrix-real.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore } from "../../packages/scoring/src/computeScore";
import { scoreAssetRisk } from "../../packages/scoring/src/subscores/assetRisk";
import { EVENTS } from "./events.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "data");
const FILES: Record<string, string> = { june: "june-hf.json", ust: "ust-hf.json", ftx: "ftx-hf.json" };
// Full populations now reconstructed → no survivor sampling, so precision is
// exact (the base-rate up-weight factor is 1). [sampled, total] kept equal.
const SURV: Record<string, [number, number]> = { june: [1, 1], ust: [1, 1], ftx: [1, 1] };
const WETH_LT = 0.825, WETH_MAXLTV = 0.8;
const FLAT = { sectorTvlNow: 100e9, sectorTvl7dAgo: 100e9, protocolTvlNow: 5e9, protocolTvl7dAgo: 5e9 };
const key = process.env.DUNE_API_KEY;

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
async function daily(): Promise<{ days: string[]; weth: number[]; wbtc: number[] }> {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch("https://api.dune.com/api/v1/query/7739633/results?limit=5000", {
        headers: { "X-Dune-API-Key": key as string }, signal: AbortSignal.timeout(45_000),
      });
      const j = await r.json();
      if (j?.result?.rows) {
        const rows = j.result.rows.sort((a: any, b: any) => (a.day < b.day ? -1 : 1));
        return {
          days: rows.map((x: any) => (x.day as string).slice(0, 10)),
          weth: rows.map((x: any) => Number(x.weth_usd)),
          wbtc: rows.map((x: any) => Number(x.wbtc_usd)),
        };
      }
    } catch { /* retry */ }
    await sleep(2500 * (i + 1));
  }
  throw new Error("daily prices unavailable");
}
function ret(s: number[], a: number, b: number) {
  const o: number[] = [];
  for (let i = Math.max(1, a); i <= b; i++) if (s[i - 1]! > 0) o.push(s[i]! / s[i - 1]! - 1);
  return o;
}

interface UserHf { liquidated: boolean; firstLiqIso: string | null; hf: Record<string, number | null>; }

(async () => {
  const px = await daily();
  const dayIdx = (d: string) => px.days.indexOf(d);
  const assetRiskInputAt = (date: string) => {
    const d = dayIdx(date);
    const w90 = px.weth.slice(Math.max(0, d - 90), d + 1);
    return {
      dailyReturns30d: ret(px.weth, Math.max(0, d - 30), d),
      btcReturns30d: ret(px.wbtc, Math.max(0, d - 30), d),
      // Ordered series: the extremes route to the deprecated order-blind
      // fallback, which is byte-identical to the pre-fix formula - re-running
      // this matrix with them would "confirm" a calibration the engine no
      // longer uses.
      prices90d: w90,
    };
  };

  const events = ["june", "ust", "ftx"];
  // precompute asset-risk input per event-block (date-driven, same for all users)
  const arInput: Record<string, Record<string, ReturnType<typeof assetRiskInputAt>>> = {};
  const arScore: Record<string, Record<string, number>> = {};
  for (const e of events) {
    arInput[e] = {}; arScore[e] = {};
    for (const b of EVENTS[e].blocks) {
      const date = (b.iso as string).slice(0, 10);
      arInput[e][b.label] = assetRiskInputAt(date);
      arScore[e][b.label] = scoreAssetRisk(arInput[e][b.label]);
    }
  }

  type Mode = { crashRegime: boolean };
  function isFlagged(u: UserHf, e: string, mode: Mode): boolean {
    const exit = u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity;
    const isoByLabel = Object.fromEntries(EVENTS[e].blocks.map((b: any) => [b.label, b.iso]));
    for (const [label, hf] of Object.entries(u.hf)) {
      if (hf === null) continue;
      if (!isoByLabel[label] || Date.parse(isoByLabel[label]) >= exit) continue;
      const r = computeScore(
        {
          protocol: "aave_v3",
          positionHealth: { healthFactor: hf, currentLtv: Math.min(WETH_LT / hf, 0.95), maxLtv: WETH_MAXLTV },
          assetRisk: arInput[e][label]!,
          systemicRisk: FLAT,
        },
        mode,
      );
      if (r.band === "CRITICAL") return true;
    }
    return false;
  }

  function matrix(users: UserHf[], e: string, mode: Mode) {
    let tp = 0, fp = 0, fn = 0, tn = 0, noDebt = 0;
    for (const u of users) {
      const hasDebt = Object.entries(u.hf).some(([l, hf]) => {
        const iso = (EVENTS[e].blocks.find((b: any) => b.label === l) as any)?.iso;
        return hf !== null && Date.parse(iso) < (u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity);
      });
      if (!hasDebt) { noDebt++; continue; }
      const f = isFlagged(u, e, mode);
      if (u.liquidated) f ? tp++ : fn++;
      else f ? fp++ : tn++;
    }
    return { tp, fp, fn, tn, noDebt };
  }
  const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
  const rates = (m: any) => ({
    recall: m.tp + m.fn ? m.tp / (m.tp + m.fn) : NaN,
    fpr: m.fp + m.tn ? m.fp / (m.fp + m.tn) : NaN,
  });

  const data: Record<string, UserHf[]> = {};
  for (const e of events) data[e] = JSON.parse(readFileSync(resolve(DIR, FILES[e]), "utf8"));

  console.log("\nS_asset_risk at each crash block (gate = 60):");
  for (const e of events) console.log(`  ${e}: ${EVENTS[e].blocks.map((b: any) => `${b.iso.slice(0, 10)}=${arScore[e][b.label].toFixed(0)}`).join("  ")}`);

  const MODES: { name: string; mode: Mode }[] = [
    { name: "BASELINE (static floors only)", mode: { crashRegime: false } },
    { name: "SHIPPED (vol-gated crash regime)", mode: { crashRegime: true } },
  ];
  for (const { name, mode } of MODES) {
    console.log(`\n=== ${name} — flag = ever CRITICAL pre-exit ===`);
    console.log("event   liq  surv   recall  false-alarm");
    console.log("─".repeat(46));
    let TP = 0, FP = 0, FN = 0, TN = 0, fpAdj = 0;
    for (const e of events) {
      const m = matrix(data[e], e, mode);
      const r = rates(m);
      TP += m.tp; FP += m.fp; FN += m.fn; TN += m.tn;
      fpAdj += m.fp * (SURV[e][1] / SURV[e][0]);
      console.log(`${e.padEnd(6)} ${String(m.tp + m.fn).padStart(4)} ${String(m.fp + m.tn).padStart(5)}   ${pct(r.recall).padStart(6)}  ${pct(r.fpr).padStart(11)}`);
    }
    const R = TP + FN ? TP / (TP + FN) : NaN, FA = FP + TN ? FP / (FP + TN) : NaN;
    const adjP = TP + fpAdj ? TP / (TP + fpAdj) : NaN;
    console.log("─".repeat(46));
    console.log(`POOLED ${String(TP + FN).padStart(4)} ${String(FP + TN).padStart(5)}   ${pct(R).padStart(6)}  ${pct(FA).padStart(11)}`);
    void adjP; // (full population now → no extrapolation; precision below is exact)
    console.log(`pooled precision (full population, exact) ${pct(TP / (TP + FP))}`);
  }

  // ── Gate sweep (manual rule, matches the engine): flag if, at any pre-exit
  // block, HF ≤ 1.10 (static floor) OR (S_asset_risk ≥ gate AND HF ≤ 1.25).
  function sweepFlag(u: UserHf, e: string, gate: number): boolean {
    const exit = u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity;
    for (const b of EVENTS[e].blocks) {
      const hf = u.hf[b.label];
      if (hf === null || hf === undefined) continue;
      if (Date.parse(b.iso) >= exit) continue;
      if (hf <= 1.1) return true;
      if (arScore[e][b.label]! >= gate && hf <= 1.25) return true;
    }
    return false;
  }
  console.log("Gate sweep (asset-risk gate; calm-2022 baseline ≈ 56, so <55 risks firing in normal bears):");
  console.log("gate   pooled-recall  pooled-FA   UST-recall  UST-FA");
  for (const gate of [50, 55, 60]) {
    let TP = 0, FP = 0, FN = 0, TN = 0, uTP = 0, uFN = 0, uFP = 0, uTN = 0;
    for (const e of events) {
      for (const u of data[e]) {
        const hasDebt = EVENTS[e].blocks.some((b: any) => u.hf[b.label] != null && Date.parse(b.iso) < (u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity));
        if (!hasDebt) continue;
        const f = sweepFlag(u, e, gate);
        if (u.liquidated) f ? TP++ : FN++; else f ? FP++ : TN++;
        if (e === "ust") { if (u.liquidated) f ? uTP++ : uFN++; else f ? uFP++ : uTN++; }
      }
    }
    console.log(`${gate}     ${pct(TP / (TP + FN)).padStart(11)}  ${pct(FP / (FP + TN)).padStart(8)}   ${pct(uTP / (uTP + uFN)).padStart(8)}  ${pct(uFP / (uFP + uTN)).padStart(6)}`);
  }
  console.log("");
})();
