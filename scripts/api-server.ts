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
  AdvisorNarrator,
  adviseWallet,
  CoinGeckoProvider,
  CompoundActiveReader,
  DefiLlamaProvider,
  findOpportunities,
  insightsFromClassification,
  MARKETS,
  MoonwellActiveReader,
  MorphoActiveReader,
  PROTOCOL_DEFILLAMA_SLUG,
  resolveProfileScan,
  scoreProspective,
  startProfileScan,
  statusFor,
  formatWelcome,
  type ActiveScore,
  type AdvisorReport,
  type LegMarketContext,
  type Protocol,
  type PublicClientLike,
  type RiskProfile,
  type StatedProfile,
  type WalletInsights,
  type YieldTable,
} from "../packages/scoring/src/index";
import {
  getProfileDeps,
  isDuneExecutionId,
  isEvmAddress,
  isStatedProfile,
  transactionPoolerUrl,
} from "../server/profileDeps";
import { TelegramStore } from "../server/telegramStore";
import { sendMessage, setWebhook } from "../server/telegram";
import { CampaignStore } from "../server/campaignStore";
import { clientIp, userAgent } from "../server/clientIp";
import { rateLimit } from "../server/rateLimit";
import { LruCache } from "../server/lruCache";
import { buildCreateInput, type RawCreateBody } from "../server/adminCampaigns";
import { adminAuthGate } from "../server/adminAuth";
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
    new CompoundActiveReader(chain, undefined, {
      onWarn: (m) => console.warn(`compound reader degraded: ${m}`),
    }),
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

app.disable("x-powered-by"); // don't advertise the stack

// Body parsing runs BEFORE the per-route limiters (every POST route reads
// req.body), so a 429'd client still costs us a parse — bound it explicitly.
// express.json()'s default is 100kb; nothing this API accepts is close (the
// largest real body is a Telegram update), so the cap is both a memory bound
// and a cheap first filter.
const JSON_BODY_LIMIT = "32kb";
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Without this, a malformed or oversized body surfaces as express's default
// HTML error page with a stack trace, and 413/400 look like 500s to the client.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const e = err as { type?: string; status?: number } | null;
  if (e?.type === "entity.too.large") {
    res.status(413).json({ error: `request body exceeds ${JSON_BODY_LIMIT}` });
    return;
  }
  if (err instanceof SyntaxError && e?.status === 400) {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }
  next(err);
});

// CORS - lets a separately-hosted SPA (e.g. the Vercel static frontend) call
// this backend cross-origin. CORS_ORIGINS is a comma-separated allowlist and is
// REQUIRED in production (a missing value must never silently widen to "*");
// local dev falls back to "*". (If the SPA is served same-origin via a Vercel
// rewrite, CORS is moot but harmless.)
//
// The guard checks the VALUE, not just presence: "*" would restore wildcard CORS
// in production and " " would boot but match nothing, failing every cross-origin
// call silently. Both are refused, loudly - Dockerfile hard-sets
// NODE_ENV=production and railway.toml retries 10 times, so a boot failure here
// takes the API down and must therefore be unmistakable in the logs.
const isProduction = process.env.NODE_ENV === "production";
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (isProduction) {
  const CORS_HELP =
    'set CORS_ORIGINS to a comma-separated list of exact frontend origins, e.g. CORS_ORIGINS="https://panik.xyz,https://www.panik.xyz" (see .env.example)';
  if (corsOrigins.length === 0) {
    console.error(`CORS_ORIGINS is missing or blank - refusing to boot with a wildcard CORS policy. Fix: ${CORS_HELP}`);
    process.exit(1);
  }
  if (corsOrigins.includes("*")) {
    console.error(`CORS_ORIGINS contains "*" - a wildcard is not an allowlist and is refused in production. Fix: ${CORS_HELP}`);
    process.exit(1);
  }
}
const allowAnyOrigin = !isProduction && (corsOrigins.length === 0 || corsOrigins.includes("*"));
console.log(
  allowAnyOrigin ? "CORS: allowing any origin (non-production)" : `CORS: allowlist ${corsOrigins.join(", ")}`,
);

// Log each DENIED origin once, so a mis-set allowlist shows up as a log line
// instead of a browser-side mystery. Bounded: only the first 20 distinct ones.
const deniedOrigins = new Set<string>();
function logDeniedOrigin(origin: string): void {
  if (deniedOrigins.has(origin) || deniedOrigins.size >= 20) return;
  deniedOrigins.add(origin);
  console.error(`CORS: denied origin ${origin} (not in CORS_ORIGINS)`);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowAnyOrigin) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && corsOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  else if (origin) logDeniedOrigin(origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Bot-Api-Secret-Token, X-Admin-Key");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

// Per-client rate limits (in-memory; single Railway container — see
// server/rateLimit.ts). Budgets are sized against BOTH the real client cadence
// and what one request actually costs us, in that order:
//
//   cheap     a process-wide cache the caller cannot miss (60s/1h TTL) — the
//             marginal request is a JSON serialize
//   walleted  keyed on a caller-supplied wallet, so every new address is a
//             guaranteed cache miss: an RPC scan or a 2000-row DB read, and it
//             also evicts a real user's entry from the 2000-entry LRU
//   advisor   the most expensive route in the app: RPC position scan + N
//             DefiLlama lookups + findOpportunities + several OpenRouter
//             completions + Postgres inserts. The UI polls it once a minute.
//   strict    spends third-party quota or mints state (Dune, Telegram, trials)
const publicLimit = rateLimit({ limit: 120 });            // 60s-cached GETs, no caller-supplied key
const walletLimit = rateLimit({ limit: 30 });             // /positions, /history — wallet-keyed
const advisorLimit = rateLimit({ limit: 10 });            // RPC + LLM + DB per miss; UI polls 1/min
const telegramStatusLimit = rateLimit({ limit: 60 });     // 3s poll during linking
const profileResultLimit = rateLimit({ limit: 40 });      // 3s poll during the reveal
const strictLimit = rateLimit({ limit: 10 });             // spends money / mints state
const adminLimit = rateLimit({ limit: 10 });              // failed-auth brake lives in server/adminAuth.ts
// Telegram's own delivery rate for one bot is far below this; the limiter is
// here so the webhook is not the one unmetered POST in the app (its secret is
// only checked AFTER the body is parsed).
const webhookLimit = rateLimit({ limit: 60 });

/** ?profile → a known RiskProfile, defaulting to moderate. Never trust the raw
 * string: it selects the scoring thresholds and rides into the advisor prompt. */
function riskProfileParam(raw: unknown): RiskProfile {
  const value = String(raw ?? "moderate");
  return value === "conservative" || value === "moderate" || value === "aggressive"
    ? value
    : "moderate";
}

/** ?protocol → a supported Protocol, or null. Same allowlist shape as
 * riskProfileParam: indexing MARKETS with the raw string lets "__proto__" and
 * "constructor" return a truthy inherited value that passes the market guard. */
const SUPPORTED_PROTOCOLS = Object.keys(MARKETS) as Protocol[];
function protocolParam(raw: unknown): Protocol | null {
  const value = String(raw ?? "");
  return SUPPORTED_PROTOCOLS.includes(value as Protocol) ? (value as Protocol) : null;
}

/**
 * 5xx responder for the public (unauthenticated) routes. The real cause goes to
 * the server log; the caller only learns that it failed. Raw pg/PostgREST
 * messages must not reach the wire — a Supabase auth failure quotes the project
 * ref, and provider errors quote our request URLs. 4xx validation messages stay
 * verbatim: those describe the caller's own input.
 */
function serverError(req: express.Request, res: express.Response, status: number, err: unknown): void {
  console.error(`${req.method} ${req.path} -> ${status}: ${(err as Error).message}`);
  res.status(status).json({ error: status >= 502 ? "upstream request failed" : "internal server error" });
}

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
app.get("/api/wallets", publicLimit, async (req, res) => {
  try {
    const { rows } = await db.query(
      "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
    );
    res.json({ wallets: rows });
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

app.get("/api/scores", publicLimit, async (req, res) => {
  try {
    const { at, positions } = await getScores();
    res.json({ updatedAt: at, positions });
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

// Live positions for ONE arbitrary wallet — the onboarded user's own wallet —
// scored on demand via the same ActiveAdapter (current Base positions). Lets the
// dashboard follow the pasted wallet instead of the seeded validation registry.
// 60s cache per wallet (mirrors the live-loop cadence).
// Wallet-keyed caches are LRU-capped: the keys come from the caller, so an
// unbounded Map would let anyone grow the heap one address at a time.
const CACHE_MAX_WALLETS = 2_000;
const ownPosCache = new LruCache<{ at: number; positions: LivePosition[] }>(CACHE_MAX_WALLETS);
app.get("/api/positions", walletLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  const profile = riskProfileParam(req.query.profile);
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
    serverError(req, res, 502, err);
  }
});

app.get("/api/compass", publicLimit, async (req, res) => {
  try {
    const { at, scores } = await getCompass();
    res.json({ updatedAt: at, scores });
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

// ── per-wallet history: alert feed + 30d score series (Portfolio tab) ──────
// watch_transitions IS the alert log (notify_channel records the outcome) and
// score_snapshots the score/position time series - no new tables needed.
const walletHistoryCache = new LruCache<{ at: number; body: unknown }>(CACHE_MAX_WALLETS);

app.get("/api/history", walletLimit, async (req, res) => {
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
    serverError(req, res, 502, err);
  }
});

app.get("/api/poolhistory", publicLimit, async (req, res) => {
  try {
    const { at, pools } = await getPoolYields();
    res.json({ updatedAt: at, pools });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

app.get("/api/prospective", publicLimit, async (req, res) => {
  try {
    const protocol = protocolParam(req.query.protocol);
    const collateralSymbol = String(req.query.symbol ?? "");
    const collateralValueUsd = Number(req.query.collateralUsd);
    const borrowValueUsd = Number(req.query.borrowUsd);

    if (!protocol || !Object.prototype.hasOwnProperty.call(MARKETS[protocol], collateralSymbol)) {
      res.status(400).json({ error: `unknown market ${String(req.query.protocol)}/${collateralSymbol}` });
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
    serverError(req, res, 500, err);
  }
});

// -- Morpho market params (Phase 2 OpenFlow) --------------------------------
// The in-app Morpho open needs on-chain MarketParams; markets are discovered
// via the same official API the Morpho reader uses (1h cache). Returns the
// deepest Base market for the collateral symbol with a USDC loan side.
const MORPHO_MARKET_QUERY = `query ($chainId: [Int!]) {
  markets(where: { chainId_in: $chainId, listed: true }, first: 200) {
    items {
      marketId
      lltv
      collateralAsset { address symbol }
      loanAsset { address symbol }
      oracle { address }
      irmAddress
      state { supplyAssetsUsd }
    }
  }
}`;

interface MorphoMarketRow {
  marketId: string;
  lltv: string;
  collateralAsset: { address: string; symbol: string } | null;
  loanAsset: { address: string; symbol: string } | null;
  oracle: { address: string } | null;
  irmAddress: string;
  state: { supplyAssetsUsd: number | null } | null;
}

let morphoMarketCache: { at: number; items: MorphoMarketRow[] } = { at: 0, items: [] };

async function getMorphoMarkets(): Promise<MorphoMarketRow[]> {
  if (Date.now() - morphoMarketCache.at < 3_600_000) return morphoMarketCache.items;
  const res = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MORPHO_MARKET_QUERY, variables: { chainId: [8453] } }),
  });
  if (!res.ok) throw new Error(`Morpho API: HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { markets?: { items?: MorphoMarketRow[] } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`Morpho API: ${body.errors[0]?.message}`);
  morphoMarketCache = { at: Date.now(), items: body.data?.markets?.items ?? [] };
  return morphoMarketCache.items;
}

app.get("/api/morpho/market", publicLimit, async (req, res) => {
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) {
    res.status(400).json({ error: "missing symbol" });
    return;
  }
  try {
    const items = await getMorphoMarkets();
    const candidates = items
      .filter(
        (m) =>
          m.collateralAsset?.symbol === symbol &&
          (m.loanAsset?.symbol === "USDC" || m.loanAsset?.symbol === "USDbC"),
      )
      .sort((a, b) => (b.state?.supplyAssetsUsd ?? 0) - (a.state?.supplyAssetsUsd ?? 0));
    const best = candidates[0];
    if (!best || !best.collateralAsset || !best.loanAsset || !best.oracle) {
      res.status(404).json({ error: `no Base USDC market for collateral ${symbol}` });
      return;
    }
    res.json({
      uniqueKey: best.marketId,
      marketParams: {
        loanToken: best.loanAsset.address,
        collateralToken: best.collateralAsset.address,
        oracle: best.oracle.address,
        irm: best.irmAddress,
        lltv: best.lltv,
      },
    });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// -- AI Advisor (Phase 2) - deterministic engine + LLM narration -----------
// Rules decide (packages/scoring/src/advisor); OpenRouter only rephrases the
// sections. 5-min cache per wallet:profile - narration is the expensive part;
// the scores underneath refresh at 60s and CRITICAL transitions still reach
// users via the Watch/Telegram loop.
const ADVISOR_TTL_MS = 5 * 60_000;
const ADVISOR_NARRATE_TIMEOUT_MS = 4_000;
const advisorNarrator = process.env.OPENROUTER_API_KEY
  ? new AdvisorNarrator(process.env.OPENROUTER_API_KEY)
  : null;

type AdvisorResponse = AdvisorReport & { changeToken: string };
const advisorCache = new LruCache<{ at: number; report: AdvisorResponse }>(CACHE_MAX_WALLETS);

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Cached profiler classification -> advisor personalization. Read-only: never
 * triggers a Dune scan (that stays with the onboarding /api/profile flow).
 */
async function advisorInsights(wallet: string): Promise<WalletInsights | undefined> {
  if (!profilerConfigured) return undefined;
  try {
    const entry = await getProfileDeps().cache.get(wallet);
    return entry ? insightsFromClassification(entry.classification) : undefined;
  } catch {
    return undefined;
  }
}

/** Compass pool yields (DefiLlama percent) -> advisor YieldTable (fractions). */
function advisorYields(pools: Record<string, PoolYield>): YieldTable {
  const table: YieldTable = {};
  for (const s of COMPASS_SCENARIOS) {
    const pool = pools[s.id];
    if (!pool) continue;
    (table[s.protocol] ??= {})[s.collateralSymbol] = pool.apy / 100;
  }
  return table;
}

app.get("/api/advisor", advisorLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  const profile = riskProfileParam(req.query.profile);
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  const key = `${wallet}:${profile}`;
  const hit = advisorCache.get(key);
  if (hit && Date.now() - hit.at < ADVISOR_TTL_MS) {
    res.json(hit.report);
    return;
  }
  try {
    // 1 - positions: reuse the /api/positions 60s cache when fresh.
    const cachedPos = ownPosCache.get(wallet);
    let scores: ActiveScore[];
    if (cachedPos && Date.now() - cachedPos.at < 60_000) {
      scores = cachedPos.positions;
    } else {
      scores = await adapter.scoreWallet(wallet);
      ownPosCache.set(wallet, {
        at: Date.now(),
        positions: scores.map((s) => ({
          ...s,
          label: null,
          riskProfile: profile,
          profileStatus: statusFor(profile, s.total),
        })),
      });
    }

    // 2 - per-protocol TVL context for the rebalance rule (provider-cached).
    const ctx: Partial<Record<Protocol, LegMarketContext>> = {};
    await Promise.all(
      [...new Set(scores.map((s) => s.protocol))].map(async (p) => {
        try {
          const sys = await providers.systemic.getSystemicRiskInput(PROTOCOL_DEFILLAMA_SLUG[p]);
          ctx[p] = {
            protocolTvl7dPct:
              sys.protocolTvl7dAgo > 0 ? sys.protocolTvlNow / sys.protocolTvl7dAgo - 1 : null,
            sectorTvl7dPct:
              sys.sectorTvl7dAgo > 0 ? sys.sectorTvlNow / sys.sectorTvl7dAgo - 1 : null,
          };
        } catch {
          // Context is optional; the rules degrade to sub-score-only signals.
        }
      }),
    );

    // 3 - decide (deterministic), then personalize + scan openings.
    const { overall, recommendations } = adviseWallet(scores, profile, ctx);
    const insights = await advisorInsights(wallet);
    let yields: YieldTable | undefined;
    try {
      yields = advisorYields((await getPoolYields()).pools);
    } catch {
      yields = undefined;
    }
    const opportunities = await findOpportunities({
      wallet,
      profile,
      scoreScenario: (s) => scoreProspective(s, providers),
      currentRecommendations: recommendations,
      yields,
      insights,
    });

    // 4 - narrate non-HOLD legs + the top opportunity, time-boxed; any failure
    // keeps the deterministic sections already attached.
    let narrated = false;
    if (advisorNarrator) {
      const targets = [
        ...recommendations.filter((r) => r.action !== "HOLD"),
        ...opportunities.slice(0, 1),
      ];
      await Promise.all(
        targets.map(async (rec) => {
          const out = await withTimeout(
            advisorNarrator.narrate(rec, profile, insights),
            ADVISOR_NARRATE_TIMEOUT_MS,
            rec.sections,
          );
          if (out !== rec.sections) {
            rec.sections = out;
            narrated = true;
          }
        }),
      );
    }

    const changeToken =
      [
        ...recommendations.map((r) => `${r.protocol}:${r.action}`),
        ...opportunities.map((r) => `open:${r.protocol}:${r.numbers.scoredCollateralSymbol}`),
      ].join("|") || "none";
    const report: AdvisorResponse = {
      wallet,
      profile,
      overall,
      recommendations,
      opportunities,
      walletInsights: insights,
      narrated,
      updatedAt: Date.now(),
      changeToken,
    };

    // 5 - append leg-action CHANGES to the advice log (fire-and-forget; the
    // route never blocks or fails on the insert).
    const prevActions = new Map(
      (hit?.report.recommendations ?? []).map((r) => [r.protocol, r.action]),
    );
    for (const rec of recommendations) {
      const before = prevActions.get(rec.protocol);
      const changed = before !== undefined ? before !== rec.action : rec.action !== "HOLD";
      if (!changed) continue;
      void db
        .query(
          "insert into public.advisor_events (wallet, protocol, action, urgency, payload) values ($1,$2,$3,$4,$5)",
          [wallet, rec.protocol, rec.action, rec.urgency, JSON.stringify(rec)],
        )
        .catch((e: unknown) =>
          console.error(`advisor_events insert failed: ${(e as Error).message.slice(0, 80)}`),
        );
    }

    advisorCache.set(key, { at: Date.now(), report });
    res.json(report);
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// Persona profiler — timeout-proof start/poll, mirroring the Vercel functions
// (same shared session + Supabase cache). The onboarding fires /start on wallet
// entry, then polls /result (with the quiz's stated profile) at the reveal.
app.post("/api/profile/start", strictLimit, async (req, res) => {
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
    serverError(req, res, 502, err);
  }
});

app.post("/api/profile/result", profileResultLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? req.body?.wallet ?? "").trim();
  // Query-then-body, matching api/profile/result.ts exactly — two handlers for
  // one route must not disagree about which value wins.
  const executionId: string | undefined = (req.query.executionId as string | undefined) ?? req.body?.executionId;
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  if (executionId !== undefined && !isDuneExecutionId(executionId)) {
    res.status(400).json({ error: "invalid executionId" });
    return;
  }
  let stated: StatedProfile | undefined;
  if (req.body?.stated !== undefined) {
    if (!isStatedProfile(req.body.stated)) {
      res.status(400).json({ error: "invalid stated profile" });
      return;
    }
    stated = req.body.stated;
  }
  if (!profilerConfigured) {
    res.status(503).json({ error: "profiler unconfigured (DUNE_API_KEY / SUPABASE_DB_URL)" });
    return;
  }
  try {
    res.json(await resolveProfileScan(wallet.toLowerCase(), { executionId, stated }, getProfileDeps()));
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// Telegram deep-link mint - dev parity with the Vercel function api/telegram/link.ts.
// (The webhook itself needs a public URL; tunnel to this server or use Vercel.)
const telegramConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.VITE_TELEGRAM_BOT_USERNAME,
);
app.post("/api/telegram/link", strictLimit, async (req, res) => {
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
    serverError(req, res, 502, err);
  }
});

// Telegram link status - the browser polls this after Connect to auto-confirm
// (and on load to show an existing link). Reads via the service key (table is
// deny-all to the browser); returns only linked + username.
app.get("/api/telegram/status", telegramStatusLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) { res.status(400).json({ error: "invalid EVM wallet address" }); return; }
  if (!telegramConfigured) { res.status(503).json({ error: "telegram unconfigured" }); return; }
  try {
    const link = await TelegramStore.fromEnv().getLink(wallet);
    res.json({ linked: Boolean(link?.enabled), username: link?.username ?? null });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// Telegram webhook - the production handler (Railway), mirroring api/telegram/webhook.ts.
// Telegram echoes the secret_token we registered; that header is the auth boundary.
app.post("/api/telegram/webhook", webhookLimit, async (req, res) => {
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

// ── Product trial codes - business-card "Try Now" + admin ──────────────────
// Mirrors api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts. The
// SECURITY DEFINER RPCs enforce usage/time limits atomically; these routes only
// capture IP/UA (for the attempt log) and gate the admin surface behind
// ADMIN_ACCESS_KEY. See supabase/migrations/20260704000001_product_codes.sql.
const campaignsConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

// Mirrors isValidEmail in src/panik-try/lib/trialLogic.ts + trial_grants_email_format.
const TRY_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.post("/api/try/redeem", strictLimit, async (req, res) => {
  const body = (req.body ?? {}) as { code?: string; email?: string; honeypot?: string };
  const code = String(body.code ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (String(body.honeypot ?? "").trim() !== "") { res.status(200).json({ ok: false, outcome: "not_found" }); return; }
  if (!code) { res.status(400).json({ ok: false, error: "missing code" }); return; }
  if (!TRY_EMAIL_RE.test(email)) { res.status(400).json({ ok: false, error: "invalid email" }); return; }
  if (!campaignsConfigured) { res.status(503).json({ ok: false, error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    const result = await CampaignStore.fromEnv().redeem(code, email, clientIp(req), userAgent(req.headers));
    if (result.outcome === "success" && result.token) {
      res.json({ ok: true, outcome: "success", trialUrl: `/app?trial=${result.token}` });
    } else {
      res.json({ ok: false, outcome: result.outcome });
    }
  } catch (err) {
    console.error(`POST /api/try/redeem -> 502: ${(err as Error).message}`);
    res.status(502).json({ ok: false, error: "redemption failed" });
  }
});

app.post("/api/try/access", strictLimit, async (req, res) => {
  const token = String((req.body as { token?: string } | undefined)?.token ?? "").trim();
  if (!token) { res.status(400).json({ ok: false, error: "missing token" }); return; }
  if (!campaignsConfigured) { res.status(503).json({ ok: false, error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    const result = await CampaignStore.fromEnv().openTrial(token, clientIp(req), userAgent(req.headers));
    res.json({ ok: result.outcome === "active", outcome: result.outcome, expiresAt: result.expiresAt ?? null });
  } catch (err) {
    console.error(`POST /api/try/access -> 502: ${(err as Error).message}`);
    res.status(502).json({ ok: false, error: "trial lookup failed" });
  }
});

async function adminCampaigns(req: express.Request, res: express.Response): Promise<void> {
  // The guessing brake is keyed on the PRESENTED credential, never the caller's
  // IP — an IP-keyed lockout lets any stranger lock the real admin out. See
  // server/adminAuth.ts.
  const { auth, retryAfterSec } = adminAuthGate.authorize(req.header("x-admin-key") ?? undefined);
  if (auth === "unconfigured") { res.status(503).json({ error: "admin unconfigured (ADMIN_ACCESS_KEY)" }); return; }
  if (auth === "locked") {
    res.setHeader("Retry-After", String(retryAfterSec ?? 60));
    res.status(429).json({ error: "too many failed admin auth attempts", retryAfterSec });
    return;
  }
  if (auth === "forbidden") {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!campaignsConfigured) { res.status(503).json({ error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    const store = CampaignStore.fromEnv();
    if (req.method === "GET") {
      if (String(req.query.view ?? "") === "emails") { res.json({ grants: await store.listGrants() }); return; }
      res.json({ campaigns: await store.listCampaigns() });
      return;
    }
    const action = String(req.query.action ?? "");
    const body = (req.body ?? {}) as RawCreateBody & { id?: string };
    if (action === "expire") {
      const id = String(body.id ?? "").trim();
      if (!id) { res.status(400).json({ error: "missing id" }); return; }
      const updated = await store.expireCampaign(id);
      if (!updated) { res.status(404).json({ error: "campaign not found" }); return; }
      res.json({ campaign: updated });
      return;
    }
    const { input, error } = buildCreateInput(body);
    if (error) { res.status(400).json({ error }); return; }
    res.status(201).json({ campaign: await store.createCampaign(input!) });
  } catch (err) {
    serverError(req, res, 502, err);
  }
}
app.get("/api/admin/campaigns", adminLimit, adminCampaigns);
app.post("/api/admin/campaigns", adminLimit, adminCampaigns);

app.get("/api/chain", publicLimit, async (req, res) => {
  try {
    res.json(await getChain());
  } catch (err) {
    serverError(req, res, 500, err);
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
    if (p === "/try") return "try.html";
    if (p === "/admin-neithan") return "admin.html";
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
