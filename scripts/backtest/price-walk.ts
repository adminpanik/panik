/**
 * Protocol-agnostic price-walk validator (recall + lead time) for liquidated
 * cohorts on any protocol. A position is liquidated when HF≈1, so with stablecoin
 * debt HF(t) = collateralPrice(t) / collateralPrice(t_liq). We replay each
 * liquidated position hour-by-hour through the real computeScore and measure how
 * early it first reached CRITICAL (baseline floors vs shipped crash-regime).
 *
 * Inputs (data/): <cohort>.json [{owner, first_liq}], weth-hourly-aug24.json
 * [{hour, weth}], weth-daily-aug24.json [{day, weth, wbtc}].
 *
 * Run: npx tsx scripts/backtest/price-walk.ts <cohortFile> <label>
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore } from "../../packages/scoring/src/computeScore";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "data");
const [cohortFile, label] = process.argv.slice(2);
if (!cohortFile || !label) throw new Error("usage: <cohortFile> <label>");

const cohort: { owner: string; first_liq: string }[] = JSON.parse(readFileSync(resolve(DIR, cohortFile), "utf8"));
const hourly: { hour: string; weth: number }[] = JSON.parse(readFileSync(resolve(DIR, "weth-hourly-aug24.json"), "utf8"))
  .map((r: any) => ({ hour: r.hour, weth: Number(r.weth) })).sort((a: any, b: any) => (a.hour < b.hour ? -1 : 1));
const daily: { day: string; weth: number; wbtc: number }[] = JSON.parse(readFileSync(resolve(DIR, "weth-daily-aug24.json"), "utf8"))
  .map((r: any) => ({ day: r.day.slice(0, 10), weth: Number(r.weth), wbtc: Number(r.wbtc) })).sort((a: any, b: any) => (a.day < b.day ? -1 : 1));

const hourTs = hourly.map((h) => Date.parse(h.hour));
function wethAt(ts: number): number | null {
  // nearest hour at or before ts
  let lo = 0, hi = hourTs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (hourTs[m]! <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? hourly[ans]!.weth : null;
}
function ret(s: number[], a: number, b: number) {
  const o: number[] = []; for (let i = Math.max(1, a); i <= b; i++) if (s[i - 1]! > 0) o.push(s[i]! / s[i - 1]! - 1); return o;
}
const days = daily.map((d) => d.day), wethD = daily.map((d) => d.weth), wbtcD = daily.map((d) => d.wbtc);
function assetRiskAt(ts: number) {
  const date = new Date(ts).toISOString().slice(0, 10);
  let d = days.indexOf(date); if (d < 0) d = days.length - 1;
  const w90 = wethD.slice(Math.max(0, d - 90), d + 1);
  // prices90d (ordered), not the extremes: the extremes route to the
  // deprecated order-blind fallback and reproduce pre-fix numbers.
  return { dailyReturns30d: ret(wethD, Math.max(0, d - 30), d), btcReturns30d: ret(wbtcD, Math.max(0, d - 30), d), prices90d: w90 };
}
const FLAT = { sectorTvlNow: 1e11, sectorTvl7dAgo: 1e11, protocolTvlNow: 5e9, protocolTvl7dAgo: 5e9 };
const HOUR = 3_600_000, LT = 0.83;

function leadFor(anchorTs: number, crashRegime: boolean): number | null {
  const anchorPx = wethAt(anchorTs); if (!anchorPx) return null;
  // walk from 72h before to the liquidation hour
  let firstCrit: number | null = null;
  for (let t = anchorTs - 72 * HOUR; t <= anchorTs; t += HOUR) {
    const px = wethAt(t); if (!px) continue;
    const hf = px / anchorPx; // stablecoin debt
    const r = computeScore({ protocol: "aave_v3", positionHealth: { healthFactor: hf, currentLtv: Math.min(LT / hf, 0.95), maxLtv: 0.8 }, assetRisk: assetRiskAt(t), systemicRisk: FLAT }, { crashRegime });
    if (r.band === "CRITICAL") { firstCrit = t; break; }
  }
  return firstCrit === null ? null : Math.round((anchorTs - firstCrit) / HOUR);
}
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

for (const mode of [false, true] as const) {
  const leads: number[] = [];
  let caught = 0;
  for (const p of cohort) {
    const l = leadFor(Date.parse(p.first_liq), mode);
    if (l !== null) { caught++; leads.push(l); }
  }
  console.log(`${label} — ${mode ? "SHIPPED (crash-regime)" : "BASELINE (floors)"}: caught ${caught}/${cohort.length} (${Math.round((100 * caught) / cohort.length)}%), median lead ${median(leads).toFixed(0)}h, p25 ${median(leads.filter((x) => x <= median(leads))).toFixed(0)}h`);
}
