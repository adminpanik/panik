/**
 * PANIK — ACTIVE-mode live demo: score REAL wallets with REAL positions
 * on Base mainnet, end to end (RPC reads → scoring core → profile status).
 * Run:  npm run demo:watch
 *
 * Test wallets are recent borrowers found via Dune (queries 7710543 /
 * 7710559, executed 2026-06-13) — positions may close over time; replace
 * with fresh borrowers from those queries if rows go empty.
 */

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  AaveActiveReader,
  ActiveAdapter,
  ChainlinkPriceReader,
  CoinGeckoProvider,
  DefiLlamaProvider,
  MoonwellActiveReader,
  PriceWatcher,
  WatchService,
  type PublicClientLike,
} from "../packages/scoring/src/index";

const apiKey = process.env.COINGECKO_API_KEY;
const alchemyKey = process.env.ALCHEMY_API_KEY_BASE_MAINNET;
if (!apiKey || !alchemyKey) {
  console.error("Missing COINGECKO_API_KEY / ALCHEMY_API_KEY_BASE_MAINNET");
  process.exit(1);
}

const WALLETS = [
  // Aave V3 borrowers (Dune 7710543, borrowed hours before query time)
  "0xdcb7388a9a7f7ffa5083b48c1e5587c9f60d4b8f",
  "0x12a58e699baf4b230f571df90523fe9ac3e42305",
  "0x292d023c84885873c8da11792db9b30318f8acf8",
  // Moonwell borrowers (Dune 7710559)
  "0x416ec2ca21a38cbcfeacd6a14532b3f348356d23",
  "0x76f88702325c92c83efad341a932fb326957056f",
];

const client = createPublicClient({
  chain: base,
  transport: http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`),
}) as unknown as PublicClientLike;

const adapter = new ActiveAdapter(
  [new AaveActiveReader(client), new MoonwellActiveReader(client)],
  {
    assetRisk: new CoinGeckoProvider(apiKey),
    systemic: new DefiLlamaProvider(),
  },
);

// Oracle pre-check: same feeds the protocols liquidate against (§3.3).
// Stale feeds degrade scoring; fresh moves ≥2% trigger immediate re-scores.
const chainlink = new ChainlinkPriceReader(client);
const priceWatcher = new PriceWatcher(2);
const readings = await chainlink.readAll();
priceWatcher.update(readings); // establish movement baseline

console.log("\nChainlink oracle check (Base mainnet):");
for (const r of readings) {
  const age = r.updatedAt ? `${Math.round((Date.now() / 1000 - r.updatedAt) / 60)}m ago` : "—";
  console.log(
    `  ${r.symbol.padEnd(6)} ${r.price === null ? "READ FAILED" : `$${r.price.toLocaleString()}`}`.padEnd(28) +
    `updated ${age}  ${r.isStale ? "⚠ STALE — scoring degraded for this asset" : "fresh"}`,
  );
}

console.log("\nPANIK ACTIVE mode — real wallets, live Base mainnet reads\n" + "─".repeat(108));
console.log(
  "WALLET".padEnd(14) + "PROTOCOL".padEnd(10) + "COLLATERAL".padEnd(14) +
  "SUPPLIED".padStart(12) + "BORROWED".padStart(12) + "HF".padStart(8) +
  "TOTAL".padStart(7) + "  BAND".padEnd(11) + "MODERATE",
);
console.log("─".repeat(108));

const watch = new WatchService({
  scoreWallet: (w) => adapter.scoreWallet(w),
  profileFor: () => "moderate",
  onTransition: (t) => {
    console.log(
      `${t.wallet.slice(0, 10)}…  ${t.protocol.padEnd(10)}` +
      `score ${String(t.score).padStart(3)} (${t.band})  ` +
      `${t.from ?? "first-seen"} → ${t.to}`,
    );
  },
  onError: (err, w) =>
    console.error(`${w.slice(0, 10)}…  ERROR: ${(err as Error).message.slice(0, 80)}`),
});

for (const wallet of WALLETS) {
  try {
    const scores = await adapter.scoreWallet(wallet);
    if (scores.length === 0) {
      console.log(`${wallet.slice(0, 12)}…  (no open positions found)`);
      continue;
    }
    for (const s of scores) {
      const hf = s.healthFactor === null ? "—" : s.healthFactor.toFixed(2);
      const usd = (v: number | null) =>
        v === null ? "$—" : `$${Math.round(v).toLocaleString()}`;
      console.log(
        `${wallet.slice(0, 12)}…`.padEnd(14) + s.protocol.padEnd(10) +
        s.scoredCollateralSymbol.padEnd(14) +
        usd(s.collateralValueUsd).padStart(12) +
        usd(s.borrowValueUsd).padStart(12) +
        hf.padStart(8) + String(s.total).padStart(7) +
        `  ${s.band}`.padEnd(11) +
        (s.total >= 50 ? "outside" : s.total >= 40 ? "approaching" : "within") +
        (s.usdValuesUnavailable ? "  [prices degraded]" : ""),
      );
    }
    watch.watch(wallet);
  } catch (err) {
    console.error(`${wallet.slice(0, 12)}…  read failed: ${(err as Error).message.slice(0, 90)}`);
  }
}

console.log("─".repeat(108));
console.log("\nWatch loop — first tick (initial status events):");
await watch.tick();
console.log(
  "\nSame engine as prospective mode; only the position-health inputs came from the chain.\n" +
  "In production this tick runs every 60s (arch cadence).\n",
);
