/**
 * Real-time forward-test — the live analog of the historical backtest.
 *
 * The backtest replays 2022 crashes; this scores the CURRENT live watched
 * positions through the SAME engine (via the running scoring API) and appends a
 * timestamped record per position to data/forward-test-log.jsonl. Over time the
 * log captures band transitions; when a watched wallet is later liquidated, the
 * log yields the *realized* lead time — forward validation, no replay needed.
 *
 * Run once (e.g. on a 60s cron):  node --env-file=.env --import tsx scripts/backtest/forward-test.ts
 * The scoring API must be up:      npm run dev:api
 * Needs ADMIN_ACCESS_KEY: /api/scores is admin-gated (whole-registry dump).
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "data");
mkdirSync(DIR, { recursive: true });
const LOG = resolve(DIR, "forward-test-log.jsonl");
const API = process.env.PANIK_API ?? "http://127.0.0.1:8787";

interface Rec { ts: string; wallet: string; protocol: string; symbol: string; total: number; band: string }

/** Last band seen per (wallet|protocol|symbol), from the existing log. */
function lastBands(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(LOG)) return m;
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as Rec; m.set(`${r.wallet}|${r.protocol}|${r.symbol}`, r.band); } catch { /* skip */ }
  }
  return m;
}

(async () => {
  // /api/scores is admin-gated (it dumps the whole watch registry — the
  // enumeration list an attacker would need). Same header the ops console sends.
  const adminKey = process.env.ADMIN_ACCESS_KEY;
  if (!adminKey) throw new Error("ADMIN_ACCESS_KEY missing — /api/scores is admin-gated (run with --env-file=.env)");
  const r = await fetch(`${API}/api/scores`, {
    headers: { "X-Admin-Key": adminKey },
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => {
    throw new Error(`scoring API unreachable at ${API} (is 'npm run dev:api' running?) — ${e.message}`);
  });
  if (r.status === 401) throw new Error("/api/scores → HTTP 401 (ADMIN_ACCESS_KEY does not match the server's)");
  if (!r.ok) throw new Error(`/api/scores → HTTP ${r.status}`);
  const { positions } = (await r.json()) as { positions: any[] };
  const ts = new Date().toISOString();
  const prev = lastBands();

  const transitions: string[] = [];
  for (const p of positions) {
    const key = `${p.wallet}|${p.protocol}|${p.collateralSymbol ?? p.symbol ?? "?"}`;
    const rec: Rec = {
      ts, wallet: p.wallet, protocol: p.protocol,
      symbol: p.collateralSymbol ?? p.symbol ?? "?", total: p.total, band: p.band,
    };
    appendFileSync(LOG, JSON.stringify(rec) + "\n");
    const before = prev.get(key);
    if (before && before !== rec.band) transitions.push(`  ${key.slice(0, 18)}…  ${before} → ${rec.band} (score ${rec.total})`);
  }

  console.log(`\nforward-test @ ${ts} — ${positions.length} live positions scored (same engine as the backtest)`);
  const byBand: Record<string, number> = {};
  for (const p of positions) byBand[p.band] = (byBand[p.band] ?? 0) + 1;
  console.log("  bands:", JSON.stringify(byBand));
  if (transitions.length) {
    console.log("  band transitions since last run:");
    transitions.forEach((t) => console.log(t));
  } else if (prev.size) {
    console.log("  no band transitions since last run");
  }
  console.log(`  appended ${positions.length} records → data/forward-test-log.jsonl\n`);
})().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
