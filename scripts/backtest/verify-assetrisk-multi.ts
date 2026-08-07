/**
 * Verify the crash-regime asset-risk gate (S_asset_risk ≥ 60) actually fires in
 * the UST/LUNA (May 2022) and FTX (Nov 2022) windows — the assumption that lets
 * the survivor matrix reduce the crash-regime flag to HF ≤ threshold.
 * Pulls daily WETH/WBTC (Dune query 7739633) via API; pair with dnsfix preload.
 */
import { scoreAssetRisk } from "../../packages/scoring/src/subscores/assetRisk";

const key = process.env.DUNE_API_KEY;
if (!key) throw new Error("DUNE_API_KEY missing");

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
async function results(): Promise<any[]> {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch("https://api.dune.com/api/v1/query/7739633/results?limit=5000", {
        headers: { "X-Dune-API-Key": key as string },
        signal: AbortSignal.timeout(45_000),
      });
      const j = await r.json();
      if (j?.result?.rows) return j.result.rows;
    } catch {
      /* retry */
    }
    await sleep(2500 * (i + 1));
  }
  throw new Error("could not fetch daily prices");
}

function ret(s: number[], a: number, b: number) {
  const o: number[] = [];
  for (let i = Math.max(1, a); i <= b; i++) if ((s[i - 1] as number) > 0) o.push((s[i] as number) / (s[i - 1] as number) - 1);
  return o;
}

(async () => {
  const rows = (await results()).sort((a, b) => (a.day < b.day ? -1 : 1));
  const days = rows.map((r) => (r.day as string).slice(0, 10));
  const weth = rows.map((r) => Number(r.weth_usd));
  const wbtc = rows.map((r) => Number(r.wbtc_usd));

  const at = (date: string) => {
    const d = days.indexOf(date);
    if (d < 0) return `(${date} not found)`;
    const w90 = weth.slice(Math.max(0, d - 90), d + 1);
    const s = scoreAssetRisk({
      dailyReturns30d: ret(weth, Math.max(0, d - 30), d),
      btcReturns30d: ret(wbtc, Math.max(0, d - 30), d),
      // Ordered series: the extremes route to the deprecated order-blind
      // fallback and would re-verify a formula the engine no longer uses.
      prices90d: w90,
    });
    return s.toFixed(1);
  };

  console.log("\nS_asset_risk (gate = 60) by date:\n");
  console.log("UST/LUNA window:");
  for (const d of ["2022-05-08", "2022-05-10", "2022-05-12", "2022-05-13"]) console.log(`  ${d}  ${at(d)}`);
  console.log("FTX window:");
  for (const d of ["2022-11-08", "2022-11-09", "2022-11-10", "2022-11-11"]) console.log(`  ${d}  ${at(d)}`);
  console.log("\ncalm reference:");
  for (const d of ["2022-03-01", "2022-10-01"]) console.log(`  ${d}  ${at(d)}`);
})();
