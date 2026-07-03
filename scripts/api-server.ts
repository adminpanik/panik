/**
 * PANIK — local scoring API (dev).
 * Run:  npm run dev:api   (then `npm run dev` and open /app.html)
 * Serves live scores to the panik-core UI. Keys stay server-side — the
 * browser only ever sees score JSON, mirroring the production worker split.
 *
 * Endpoints:
 *   GET /api/health
 *   GET /api/scores       live wallet positions (Supabase registry → chain)
 *   GET /api/compass      the 6 Compass preset scenarios, scored live
 *   GET /api/prospective  ?protocol&symbol&collateralUsd&borrowUsd (Watch sliders)
 *   GET /api/poolhistory  30d APY/TVL per Compass preset (DefiLlama, 1h cache)
 *   GET /api/history      ?wallet  alert feed + 30d score series (Portfolio)
 *   GET /api/profile      ?wallet  DeFi-persona prediction (Dune history → AI)
 *   GET /api/chain        real Base block number + gas price
 */

import express from "express";
import pg from "pg";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  AaveActiveReader,
  ActiveAdapter,
  CoinGeckoProvider,
  CompoundActiveReader,
  DefiLlamaProvider,
  MARKETS,
  MoonwellActiveReader,
  MorphoActiveReader,
  resolveProfileScan,
  scoreProspective,
  startProfileScan,
  statusFor,
  formatWelcome,
  type ActiveScore,
  type Protocol,
  type PublicClientLike,
  type RiskProfile,
  type StatedProfile,
} from "../packages/scoring/src/index";
import { getProfileDeps, isEvmAddress, transactionPoolerUrl } from "../server/profileDeps";
import { TelegramStore } from "../server/telegramStore";
import { sendMessage, setWebhook } from "../server/telegram";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Railway (and most PaaS) inject PORT; fall back to PANIK_API_PORT for local dev.
const PORT = Number(process.env.PORT ?? process.env.PANIK_API_PORT ?? 8787);
const cgKey = process.env.COINGECKO_API_KEY;
const alchemyKey = process.env.ALCHEMY_API_KEY_BASE_MAINNET;
const dbUrl = process.env.SUPABASE_DB_URL;
// Persona profiler keys are OPTIONAL — the rest of the API runs without them;
// /api/profile reports 503 if Dune is unconfigured, and narration falls back
// to deterministic prose if OpenRouter is absent.
// Profiler keys are read by getProfileDeps from env directly; we only need to
// know here whether to advertise the endpoints (DUNE + DB are the hard reqs).
const duneKey = process.env.DUNE_API_KEY;
if (!cgKey || !alchemyKey || !dbUrl) {
  console.error("Missing env (COINGECKO_API_KEY / ALCHEMY_API_KEY_BASE_MAINNET / SUPABASE_DB_URL)");
  process.exit(1);
}

const rawClient = createPublicClient({
  chain: base,
  transport: http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`),
});
const chain = rawClient as unknown as PublicClientLike;

const providers = {
  assetRisk: new CoinGeckoProvider(cgKey),
  systemic: new DefiLlamaProvider(),
};

const adapter = new ActiveAdapter(
  [
    new AaveActiveReader(chain),
    new MoonwellActiveReader(chain),
    new CompoundActiveReader(chain),
    new MorphoActiveReader(), // official Morpho API (market discovery needs an index)
  ],
  providers,
  (err) => console.error(`reader failed (other protocols continue): ${(err as Error).message.slice(0, 120)}`),
);

// Persona profiler (analytics tier — once-per-wallet, cached; NOT the live loop).
// Deps (Dune + Supabase cache + optional OpenRouter narrator) are built lazily
// by getProfileDeps from env, shared with the Vercel serverless functions.
const profilerConfigured = Boolean(
  duneKey && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
);

const db = new pg.Pool({
  // Use the TRANSACTION pooler (6543), not the SESSION pooler (5432). The
  // session pooler resets/times out from some networks (the watched_wallets
  // "Connection terminated due to connection timeout" errors); 6543 connects
  // in ~1s. Same fix the profiler uses. Watch-loop queries are simple SELECTs,
  // so transaction-mode pooling is fine here.
  connectionString: transactionPoolerUrl(),
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

// pg.Pool emits 'error' on IDLE clients when the connection drops (e.g. the
// Supabase pooler resetting the TCP socket). With no listener, Node treats it as
// an unhandled error event and kills the whole process — this is the ECONNRESET
// death we kept hitting. Swallow + log so a dropped idle client self-heals.
db.on("error", (err) => console.error(`db pool error (recovered): ${err.message}`));

// One retry: a single pooler reset on the first packet is common and harmless.
async function queryWatched() {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { rows } = await db.query<{ wallet: string; risk_profile: RiskProfile; label: string | null }>(
        "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
      );
      return rows;
    } catch (err) {
      lastErr = err;
      console.error(`watched_wallets query attempt ${attempt} failed: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

// ── live wallet scores (60s cache regardless of polling tabs) ─────────────
export interface LivePosition extends ActiveScore {
  label: string | null;
  riskProfile: RiskProfile;
  profileStatus: ReturnType<typeof statusFor>;
}

let scoresCache: { at: number; positions: LivePosition[] } = { at: 0, positions: [] };

async function getScores(): Promise<typeof scoresCache> {
  if (Date.now() - scoresCache.at < 60_000) return scoresCache;

  let rows: { wallet: string; risk_profile: RiskProfile; label: string | null }[];
  try {
    rows = await queryWatched();
  } catch (err) {
    // DB unreachable — serve the last good cache (even if stale) rather than 500ing.
    if (scoresCache.positions.length) {
      console.error(`scores: DB unreachable, serving stale cache (${(err as Error).message.slice(0, 80)})`);
      return scoresCache;
    }
    throw err;
  }

  const positions: LivePosition[] = [];
  for (const w of rows) {
    try {
      for (const s of await adapter.scoreWallet(w.wallet)) {
        positions.push({
          ...s,
          label: w.label,
          riskProfile: w.risk_profile,
          profileStatus: statusFor(w.risk_profile, s.total),
        });
      }
    } catch (err) {
      console.error(`score failed for ${w.wallet}: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  scoresCache = { at: Date.now(), positions };
  return scoresCache;
}

// ── Compass preset scenarios (ids MUST match VAULT_PRESETS in AppDemo) ────
const COMPASS_SCENARIOS: {
  id: string;
  protocol: Protocol;
  collateralSymbol: string;
  collateralValueUsd: number;
  borrowValueUsd: number;
}[] = [
  { id: "aave-usdc-supply", protocol: "aave_v3", collateralSymbol: "USDC", collateralValueUsd: 2000, borrowValueUsd: 500 },
  { id: "moonwell-usdc-supply", protocol: "moonwell", collateralSymbol: "USDC", collateralValueUsd: 1500, borrowValueUsd: 300 },
  { id: "aave-wsteth-vault", protocol: "aave_v3", collateralSymbol: "wstETH", collateralValueUsd: 8000, borrowValueUsd: 4500 },
  { id: "aave-weth-borrow", protocol: "aave_v3", collateralSymbol: "WETH", collateralValueUsd: 5000, borrowValueUsd: 2000 },
  { id: "moonwell-weth-debt", protocol: "moonwell", collateralSymbol: "WETH", collateralValueUsd: 2000, borrowValueUsd: 1300 },
  { id: "moonwell-cbeth-max", protocol: "moonwell", collateralSymbol: "cbETH", collateralValueUsd: 1500, borrowValueUsd: 1050 },
  { id: "morpho-weth-loop", protocol: "morpho", collateralSymbol: "WETH", collateralValueUsd: 4000, borrowValueUsd: 2400 },
  { id: "compound-weth-borrow", protocol: "compound_v3", collateralSymbol: "WETH", collateralValueUsd: 3000, borrowValueUsd: 1500 },
];

let compassCache: { at: number; scores: unknown[] } = { at: 0, scores: [] };

async function getCompass(): Promise<typeof compassCache> {
  if (Date.now() - compassCache.at < 60_000) return compassCache;
  const scores = await Promise.all(
    COMPASS_SCENARIOS.map(async (s) => {
      const r = await scoreProspective(s, providers);
      return {
        id: s.id,
        total: r.total,
        band: r.band,
        subScores: r.subScores,
        healthFactor: r.healthFactor,
        liquidationDrawdown: r.liquidationDrawdown,
      };
    }),
  );
  compassCache = { at: Date.now(), scores };
  return compassCache;
}

// ── DefiLlama pool yields (30d APY/TVL per Compass preset; 1h cache) ────────
// Pool UUIDs resolved from https://yields.llama.fi/pools filtered on
// chain=Base + project + symbol (highest TVL match), verified 2026-07-03.
// Re-derive with the same filter if a market is migrated or delisted.
// moonwell-cbeth-max has NO listed pool (market delisted from DefiLlama) -
// intentionally absent; the UI falls back to its static preset APY.
const LLAMA_POOLS: Record<string, string> = {
  "aave-usdc-supply": "7e0661bf-8cf3-45e6-9424-31916d4c7b84", // aave-v3 / USDC
  "moonwell-usdc-supply": "69cf831d-624a-4f23-b5e3-c0f63ad1fa01", // moonwell-lending / USDC
  "aave-wsteth-vault": "361f0a3c-6adb-4b1c-bf35-f9cd79f2341c", // aave-v3 / WSTETH
  "aave-weth-borrow": "23405eee-97e7-4b8e-8625-19c3a36047e8", // aave-v3 / WETH
  "moonwell-weth-debt": "914284ae-dbef-421f-bbb7-7c42f527fd5f", // moonwell-lending / ETH
  "morpho-weth-loop": "660e240a-ab18-43af-9d24-0245828f903f", // morpho-blue / WETH
  "compound-weth-borrow": "d83facac-3757-4b19-a84c-f3c0850dfe2a", // compound-v3 / WETH
};

interface PoolYield {
  apy: number;
  tvlUsd: number;
  apySeries: number[]; // last 30 daily points, oldest first
  tvlSeries: number[];
}

let poolYieldCache: { at: number; pools: Record<string, PoolYield> } = { at: 0, pools: {} };

async function getPoolYields(): Promise<typeof poolYieldCache> {
  if (Date.now() - poolYieldCache.at < 3_600_000) return poolYieldCache;
  const entries = await Promise.all(
    Object.entries(LLAMA_POOLS).map(async ([id, pool]) => {
      try {
        const res = await fetch(`https://yields.llama.fi/chart/${pool}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          data: { tvlUsd: number | null; apy: number | null }[];
        };
        const tail = body.data.slice(-30);
        if (tail.length === 0) return null;
        const apySeries = tail.map((p) => p.apy ?? 0);
        const tvlSeries = tail.map((p) => p.tvlUsd ?? 0);
        const yieldRow: PoolYield = {
          apy: apySeries[apySeries.length - 1]!,
          tvlUsd: tvlSeries[tvlSeries.length - 1]!,
          apySeries,
          tvlSeries,
        };
        return [id, yieldRow] as const;
      } catch (err) {
        console.error(`pool yield failed for ${id}: ${(err as Error).message.slice(0, 80)}`);
        return null;
      }
    }),
  );
  const pools = Object.fromEntries(entries.filter((e): e is [string, PoolYield] => e !== null));
  // Every fetch failed (Llama outage): keep serving the stale cache.
  if (Object.keys(pools).length === 0 && Object.keys(poolYieldCache.pools).length > 0) {
    return poolYieldCache;
  }
  poolYieldCache = { at: Date.now(), pools };
  return poolYieldCache;
}

// Wallet persona profiles are handled by the shared start/poll session
// (Supabase-cached), identical to the Vercel functions — see the routes below.

// ── chain telemetry (10s cache) ───────────────────────────────────────────
let chainCache: { at: number; blockNumber: number; gasGwei: number } = {
  at: 0,
  blockNumber: 0,
  gasGwei: 0,
};

async function getChain(): Promise<typeof chainCache> {
  if (Date.now() - chainCache.at < 10_000) return chainCache;
  const [block, gas] = await Promise.all([
    rawClient.getBlockNumber(),
    rawClient.getGasPrice(),
  ]);
  chainCache = { at: Date.now(), blockNumber: Number(block), gasGwei: Number(gas) / 1e9 };
  return chainCache;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const app = express();

// CORS - lets a separately-hosted SPA (e.g. the Vercel static frontend) call
// this backend cross-origin. Set CORS_ORIGINS to a comma-separated allowlist in
// production; defaults to "*" for local dev. (If the SPA is served same-origin
// via a Vercel rewrite, CORS is moot but harmless.)
const corsOrigins = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (corsOrigins.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && corsOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Bot-Api-Secret-Token");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

const BOOT_AT = new Date().toISOString();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, cachedAt: scoresCache.at, positions: scoresCache.positions.length });
});

// Deploy marker - confirms WHICH commit is live (Railway injects the SHA).
app.get("/api/version", (_req, res) => {
  res.json({
    service: "panik-api",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "unknown",
    bootAt: BOOT_AT,
  });
});

// Watch registry — the UI's wallet selector source (so wallets with no
// readable positions still get a pill instead of vanishing).
app.get("/api/wallets", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
    );
    res.json({ wallets: rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/scores", async (_req, res) => {
  try {
    const { at, positions } = await getScores();
    res.json({ updatedAt: at, positions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Live positions for ONE arbitrary wallet — the onboarded user's own wallet —
// scored on demand via the same ActiveAdapter (current Base positions). Lets the
// dashboard follow the pasted wallet instead of the seeded validation registry.
// 60s cache per wallet (mirrors the live-loop cadence).
const ownPosCache = new Map<string, { at: number; positions: LivePosition[] }>();
app.get("/api/positions", async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  const profile = String(req.query.profile ?? "moderate") as RiskProfile;
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  const cached = ownPosCache.get(wallet);
  if (cached && Date.now() - cached.at < 60_000) {
    res.json({ updatedAt: cached.at, positions: cached.positions });
    return;
  }
  try {
    const scored = await adapter.scoreWallet(wallet);
    const positions: LivePosition[] = scored.map((s) => ({
      ...s,
      label: null,
      riskProfile: profile,
      profileStatus: statusFor(profile, s.total),
    }));
    ownPosCache.set(wallet, { at: Date.now(), positions });
    res.json({ updatedAt: Date.now(), positions });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/compass", async (_req, res) => {
  try {
    const { at, scores } = await getCompass();
    res.json({ updatedAt: at, scores });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── per-wallet history: alert feed + 30d score series (Portfolio tab) ──────
// watch_transitions IS the alert log (notify_channel records the outcome) and
// score_snapshots the score/position time series - no new tables needed.
const walletHistoryCache = new Map<string, { at: number; body: unknown }>();

app.get("/api/history", async (req, res) => {
  try {
    const wallet = String(req.query.wallet ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      res.status(400).json({ error: "invalid wallet" });
      return;
    }
    const hit = walletHistoryCache.get(wallet);
    if (hit && Date.now() - hit.at < 60_000) {
      res.json(hit.body);
      return;
    }
    const [alerts, snapshots] = await Promise.all([
      db.query(
        `select protocol, risk_profile, score, band, from_status, to_status,
                notify_channel, notified_at, created_at
           from public.watch_transitions
          where wallet = $1
          order by created_at desc
          limit 50`,
        [wallet],
      ),
      db.query(
        `select protocol, total, health_factor, collateral_usd, borrow_usd, created_at
           from public.score_snapshots
          where wallet = $1 and created_at > now() - interval '30 days'
          order by created_at asc
          limit 2000`,
        [wallet],
      ),
    ]);
    const body = { updatedAt: Date.now(), alerts: alerts.rows, snapshots: snapshots.rows };
    walletHistoryCache.set(wallet, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/poolhistory", async (_req, res) => {
  try {
    const { at, pools } = await getPoolYields();
    res.json({ updatedAt: at, pools });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/prospective", async (req, res) => {
  try {
    const protocol = String(req.query.protocol) as Protocol;
    const collateralSymbol = String(req.query.symbol);
    const collateralValueUsd = Number(req.query.collateralUsd);
    const borrowValueUsd = Number(req.query.borrowUsd);

    if (!MARKETS[protocol]?.[collateralSymbol]) {
      res.status(400).json({ error: `unknown market ${protocol}/${collateralSymbol}` });
      return;
    }
    if (!Number.isFinite(collateralValueUsd) || !Number.isFinite(borrowValueUsd) ||
        collateralValueUsd < 0 || borrowValueUsd < 0) {
      res.status(400).json({ error: "invalid amounts" });
      return;
    }

    // Providers cache for 1h, so slider drags are pure math after warmup.
    const r = await scoreProspective(
      { protocol, collateralSymbol, collateralValueUsd, borrowValueUsd },
      providers,
    );
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Persona profiler — timeout-proof start/poll, mirroring the Vercel functions
// (same shared session + Supabase cache). The onboarding fires /start on wallet
// entry, then polls /result (with the quiz's stated profile) at the reveal.
app.use(express.json());

app.post("/api/profile/start", async (req, res) => {
  const wallet = String(req.query.wallet ?? req.body?.wallet ?? "").trim();
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  if (!profilerConfigured) {
    res.status(503).json({ error: "profiler unconfigured (DUNE_API_KEY / SUPABASE_DB_URL)" });
    return;
  }
  try {
    res.json(await startProfileScan(wallet.toLowerCase(), getProfileDeps()));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.post("/api/profile/result", async (req, res) => {
  const wallet = String(req.query.wallet ?? req.body?.wallet ?? "").trim();
  const executionId: string | undefined = req.body?.executionId ?? (req.query.executionId as string | undefined);
  const stated: StatedProfile | undefined = req.body?.stated;
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  if (!profilerConfigured) {
    res.status(503).json({ error: "profiler unconfigured (DUNE_API_KEY / SUPABASE_DB_URL)" });
    return;
  }
  try {
    res.json(await resolveProfileScan(wallet.toLowerCase(), { executionId, stated }, getProfileDeps()));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Telegram deep-link mint - dev parity with the Vercel function api/telegram/link.ts.
// (The webhook itself needs a public URL; tunnel to this server or use Vercel.)
const telegramConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.VITE_TELEGRAM_BOT_USERNAME,
);
app.post("/api/telegram/link", async (req, res) => {
  const wallet = String(req.body?.wallet ?? req.query.wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  if (!telegramConfigured) {
    res.status(503).json({ error: "telegram unconfigured (SUPABASE_* / VITE_TELEGRAM_BOT_USERNAME)" });
    return;
  }
  try {
    const code = randomUUID().replace(/-/g, "");
    await TelegramStore.fromEnv().createLinkCode(code, wallet, 15 * 60 * 1000);
    const botUsername = process.env.VITE_TELEGRAM_BOT_USERNAME as string;
    res.json({ code, botUsername, deepLink: `https://t.me/${botUsername}?start=${code}`, expiresInSec: 900 });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Telegram link status - the browser polls this after Connect to auto-confirm
// (and on load to show an existing link). Reads via the service key (table is
// deny-all to the browser); returns only linked + username.
app.get("/api/telegram/status", async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) { res.status(400).json({ error: "invalid EVM wallet address" }); return; }
  if (!telegramConfigured) { res.status(503).json({ error: "telegram unconfigured" }); return; }
  try {
    const link = await TelegramStore.fromEnv().getLink(wallet);
    res.json({ linked: Boolean(link?.enabled), username: link?.username ?? null });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Telegram webhook - the production handler (Railway), mirroring api/telegram/webhook.ts.
// Telegram echoes the secret_token we registered; that header is the auth boundary.
app.post("/api/telegram/webhook", async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!secret || !botToken) { res.status(503).json({ error: "telegram unconfigured" }); return; }
  if (req.header("x-telegram-bot-api-secret-token") !== secret) { res.status(401).json({ error: "bad secret" }); return; }

  const update = (req.body ?? {}) as { message?: { text?: string; chat?: { id?: number }; from?: { username?: string } } };
  const chatId = update.message?.chat?.id;
  const text = String(update.message?.text ?? "").trim();
  const username = update.message?.from?.username;
  if (typeof chatId !== "number" || !text) { res.status(200).json({ ok: true }); return; }

  try {
    const store = TelegramStore.fromEnv();
    const startMatch = text.match(/^\/start(?:@\w+)?\s+(\S+)$/);
    if (startMatch) {
      const code = startMatch[1];
      const entry = await store.getLinkCode(code);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) await store.consumeLinkCode(code);
        await sendMessage(botToken, chatId, "This link expired or is invalid. Open Panik and click Connect Telegram again.");
      } else {
        await store.upsertLink({ wallet: entry.wallet, chatId, username });
        await store.consumeLinkCode(code);
        await sendMessage(botToken, chatId, formatWelcome(entry.wallet));
      }
    } else if (/^\/stop(?:@\w+)?$/.test(text)) {
      await store.disableLink(chatId);
      await sendMessage(botToken, chatId, "Alerts disabled. Send /start again from Panik to re-enable.");
    } else if (/^\/start(?:@\w+)?$/.test(text)) {
      await sendMessage(botToken, chatId, "Open Panik and click Connect Telegram to link this chat to your wallet.");
    } else {
      await sendMessage(botToken, chatId, "Unknown command. Connect from the Panik dashboard, or send /stop to disable alerts.");
    }
  } catch (err) {
    console.error(`telegram webhook error: ${(err as Error).message}`);
  }
  res.status(200).json({ ok: true });
});

app.get("/api/chain", async (_req, res) => {
  try {
    res.json(await getChain());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Optional: serve the built SPA from this same service, so ONE Railway service
// can host frontend + backend at the same origin (no CORS, no rewrite). Off by
// default - the frontend usually lives on Vercel's CDN with /api/* rewritten
// here. Enable with SERVE_STATIC=true after `npm run build`.
if (process.env.SERVE_STATIC === "true") {
  const dist = path.resolve("dist");
  // Mirror the vercel.json clean-URL rewrites for the multi-entry build.
  const pageFor = (p: string): string => {
    if (p === "/app") return "app.html";
    if (p === "/founding" || p === "/early-access") return "founding.html";
    return "index.html";
  };
  app.use(express.static(dist, { extensions: ["html"] }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(dist, pageFor(req.path)));
  });
  console.log(`serving static SPA from ${dist}`);
}

// Dev safety net: never let a stray upstream rejection take the whole API down.
process.on("unhandledRejection", (reason) =>
  console.error(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`),
);

// Auto-register the Telegram webhook on boot (idempotent) so /start updates are
// delivered without a manual `telegram:setup`. Uses TELEGRAM_PUBLIC_BASE_URL, or
// Railway's injected RAILWAY_PUBLIC_DOMAIN. No-op if telegram is unconfigured.
function autoRegisterTelegramWebhook(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base =
    process.env.TELEGRAM_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  if (!token || !secret || !base) {
    console.log("telegram webhook auto-register skipped (token/secret/public base missing)");
    return;
  }
  const hookUrl = `${base.replace(/\/+$/, "")}/api/telegram/webhook`;
  void setWebhook(token, hookUrl, secret)
    .then((r) => console.log(`telegram setWebhook -> ${hookUrl}: ok=${r.ok}${r.description ? ` (${r.description})` : ""}`))
    .catch((e) => console.error(`telegram setWebhook failed: ${(e as Error).message.slice(0, 120)}`));
}

// Bind IPv4 explicitly - pairs with the Vite proxy's 127.0.0.1 target.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`PANIK scoring API on http://127.0.0.1:${PORT}  (scores|compass|prospective|chain)`);
  autoRegisterTelegramWebhook();
  void getScores()
    .then((c) => console.log(`warmed: ${c.positions.length} live positions`))
    .catch((e) => console.error(`scores warmup skipped: ${(e as Error).message.slice(0, 100)}`));
  void getCompass()
    .then((c) => console.log(`warmed: ${c.scores.length} compass scenarios`))
    .catch((e) => console.error(`compass warmup skipped: ${(e as Error).message.slice(0, 100)}`));
});
