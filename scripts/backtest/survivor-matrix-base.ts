/**
 * Base survivor matrix — runs the real computeScore over an Aave-V3-Base crash
 * cohort (exact HF via archive RPC), comparing baseline (static floors) vs the
 * shipped crash-regime. Asset-risk from real WETH/WBTC daily (market proxy — the
 * Aug-2024/Feb-2025/Apr-2025 events were broad ETH/BTC crashes). Precision exact.
 *
 * Run: node --env-file=.env --import ./scripts/backtest/dnsfix.mjs --import tsx \
 *        scripts/backtest/survivor-matrix-base.ts <label> <dailyQueryId>
 *   e.g. ... aave-aug24 7749291
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore } from "../../packages/scoring/src/computeScore";
import { scoreAssetRisk } from "../../packages/scoring/src/subscores/assetRisk";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "data");
const key = process.env.DUNE_API_KEY;
const [label, dailyQid] = process.argv.slice(2);
if (!label || !dailyQid) throw new Error("usage: <label> <dailyQueryId>");

// Aug-2024 dense Base blocks (must match fetch-survivors-base BASE_EVENTS).
const BLOCKS: Record<string, { label: string; iso: string }[]> = {
  "aave-aug24": [
    ["h00", "2024-08-04T00:00:00Z"], ["h06", "2024-08-04T06:00:00Z"], ["h12", "2024-08-04T12:00:00Z"], ["h18", "2024-08-04T18:00:00Z"],
    ["h24", "2024-08-05T00:00:00Z"], ["h30", "2024-08-05T06:00:00Z"], ["h36", "2024-08-05T12:00:00Z"], ["h42", "2024-08-05T18:00:00Z"],
    ["h48", "2024-08-06T00:00:00Z"], ["h54", "2024-08-06T06:00:00Z"], ["h60", "2024-08-06T12:00:00Z"], ["h66", "2024-08-06T18:00:00Z"],
    ["h72", "2024-08-07T00:00:00Z"], ["h78", "2024-08-07T06:00:00Z"], ["h84", "2024-08-07T12:00:00Z"], ["h90", "2024-08-07T18:00:00Z"],
  ].map(([label, iso]) => ({ label, iso })),
};
const blocks = BLOCKS[label];
if (!blocks) throw new Error(`no blocks for ${label}`);

const WETH_LT = 0.83, WETH_MAXLTV = 0.8;
const FLAT = { sectorTvlNow: 1e11, sectorTvl7dAgo: 1e11, protocolTvlNow: 5e9, protocolTvl7dAgo: 5e9 };
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

async function daily(): Promise<{ days: string[]; weth: number[]; wbtc: number[] }> {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(`https://api.dune.com/api/v1/query/${dailyQid}/results?limit=5000`, {
        headers: { "X-Dune-API-Key": key as string }, signal: AbortSignal.timeout(45_000),
      });
      const j = await r.json();
      if (j?.result?.rows) {
        const rows = j.result.rows.sort((a: any, b: any) => (a.day < b.day ? -1 : 1));
        return { days: rows.map((x: any) => (x.day as string).slice(0, 10)), weth: rows.map((x: any) => Number(x.weth_usd)), wbtc: rows.map((x: any) => Number(x.wbtc_usd)) };
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
interface UserHf { liquidated: boolean; firstLiqIso: string | null; hf: Record<string, number | null> }

(async () => {
  const px = await daily();
  const arAt = (date: string) => {
    const d = px.days.indexOf(date.slice(0, 10));
    const di = d < 0 ? px.days.length - 1 : d;
    const w90 = px.weth.slice(Math.max(0, di - 90), di + 1);
    // prices90d (ordered), not the extremes: the extremes route to the
    // deprecated order-blind fallback and reproduce pre-fix numbers.
    return { dailyReturns30d: ret(px.weth, Math.max(0, di - 30), di), btcReturns30d: ret(px.wbtc, Math.max(0, di - 30), di), prices90d: w90 };
  };
  const arByLabel: Record<string, ReturnType<typeof arAt>> = {};
  const arScore: Record<string, number> = {};
  for (const b of blocks) { arByLabel[b.label] = arAt(b.iso); arScore[b.label] = scoreAssetRisk(arByLabel[b.label]); }
  console.log(`asset-risk by block: ${blocks.map((b) => `${b.iso.slice(5, 13)}=${arScore[b.label].toFixed(0)}`).join("  ")}`);

  const users: UserHf[] = JSON.parse(readFileSync(resolve(DIR, `${label}-hf.json`), "utf8"));
  const isoByLabel = Object.fromEntries(blocks.map((b) => [b.label, b.iso]));
  const hasDebt = (u: UserHf) => {
    const exit = u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity;
    return Object.entries(u.hf).some(([l, hf]) => hf !== null && isoByLabel[l] && Date.parse(isoByLabel[l]) < exit);
  };
  function flagged(u: UserHf, crashRegime: boolean): boolean {
    const exit = u.firstLiqIso ? Date.parse(u.firstLiqIso) : Infinity;
    for (const [l, hf] of Object.entries(u.hf)) {
      if (hf === null || !isoByLabel[l] || Date.parse(isoByLabel[l]) >= exit) continue;
      const r = computeScore({ protocol: "aave_v3", positionHealth: { healthFactor: hf, currentLtv: Math.min(WETH_LT / hf, 0.95), maxLtv: WETH_MAXLTV }, assetRisk: arByLabel[l]!, systemicRisk: FLAT }, { crashRegime });
      if (r.band === "CRITICAL") return true;
    }
    return false;
  }
  const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
  console.log(`\nAave V3 Base — ${label} (${users.length} candidates)`);
  for (const [name, cr] of [["BASELINE (static floors)", false], ["SHIPPED (crash-regime)", true]] as const) {
    let tp = 0, fp = 0, fn = 0, tn = 0, nod = 0;
    for (const u of users) { if (!hasDebt(u)) { nod++; continue; } const f = flagged(u, cr); if (u.liquidated) f ? tp++ : fn++; else f ? fp++ : tn++; }
    console.log(`${name}: TP ${tp} FN ${fn} FP ${fp} TN ${tn}  (no-debt ${nod})  ·  recall ${pct(tp / (tp + fn))} · false-alarm ${pct(fp / (fp + tn))} · precision ${pct(tp / (tp + fp))}`);
  }
  console.log("");
})().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
