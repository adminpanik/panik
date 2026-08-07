/** Diagnostic: what does S_asset_risk actually read during the crash vs calm? */
import { scoreAssetRisk } from "../../packages/scoring/src/subscores/assetRisk";
import {
  DAILY_START,
  WBTC_DAILY,
  WETH_DAILY,
} from "../../packages/scoring/tests/fixtures/ethCrash2022";

const DAY_MS = 86_400_000;
function ret(s: number[], a: number, b: number) {
  const o: number[] = [];
  for (let i = Math.max(1, a); i <= b; i++) if (s[i - 1]! > 0) o.push(s[i]! / s[i - 1]! - 1);
  return o;
}
function assetRiskOnDay(label: string, d: number) {
  const f30 = Math.max(0, d - 30);
  const f90 = Math.max(0, d - 90);
  const w90 = WETH_DAILY.slice(f90, d + 1);
  const s = scoreAssetRisk({
    dailyReturns30d: ret(WETH_DAILY, f30, d),
    btcReturns30d: ret(WBTC_DAILY, f30, d),
    // Ordered series, NOT the extremes: the engine scores a true
    // peak-to-trough drawdown, and passing max/min here would route to the
    // deprecated fallback and reproduce pre-fix numbers.
    prices90d: w90,
  });
  const date = new Date(DAILY_START + d * DAY_MS).toISOString().slice(0, 10);
  console.log(`${label.padEnd(14)} ${date}  S_asset_risk = ${s.toFixed(1)}`);
}

console.log("WETH S_asset_risk by day (calm → crash):\n");
// calm reference points
assetRiskOnDay("calm (Apr)", 35);
assetRiskOnDay("calm (early May)", 52);
// run-up to and through the June crash
for (let d = 84; d <= 99; d++) assetRiskOnDay("crash window", d);
