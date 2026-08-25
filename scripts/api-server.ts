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
 *   GET /api/chain        block number + gas price for the scored chain
 */

import express from "express";
import pg from "pg";
import {
  AdvisorNarrator,
  adviseWallet,
  CoinGeckoProvider,
  DefiLlamaProvider,
  findOpportunities,
  insightsFromClassification,
  MARKETS,
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
  type RiskProfile,
  type StatedProfile,
  type WalletInsights,
  type YieldTable,
} from "../packages/scoring/src/index";
import {
  alchemyKeyNotice,
  buildScoringChains,
  chainScopedKey,
  resolveAlchemyKey,
  scoringChainWire,
  type ScoringChainRuntime,
} from "../server/scoringChain";
import { describeReaderError } from "../server/readerError";
import {
  SimulationCache,
  SimulationStore,
  simulationWire,
  validateArmInput,
  type ArmSimulationInput,
} from "../server/simulationStore";
import {
  getProfileDeps,
  isDuneExecutionId,
  isEvmAddress,
  isStatedProfile,
  transactionPoolerUrl,
} from "../server/profileDeps";
import { TelegramStore } from "../server/telegramStore";
import { sendMessage, setWebhook } from "../server/telegram";
import { linkState } from "../server/telegramReach";
import {
  SupabaseHeartbeatStore,
  heartbeatAlerts,
  type HeartbeatStore,
} from "../server/workerHeartbeat";
import {
  AlertDispatcher,
  SupabaseAlertLedger,
  operatorLogSink,
  operatorWebhookSink,
} from "../server/monitorAlerts";
import { CampaignStore } from "../server/campaignStore";
import { AccountStore, buildAccountResponse } from "../server/accountStore";
import {
  isMember,
  requireAccount,
  requireMember,
  type AccountContext,
} from "../server/accountAuth";
import { linkAccountWallet, redeemVoucher, VOUCHER_REFUSALS } from "../server/accounts";
import { clientIp, userAgent } from "../server/clientIp";
import { rateLimit } from "../server/rateLimit";
import { LruCache } from "../server/lruCache";
import { logNarration, type NarrationLogRow, type NarrationStore } from "../server/narrationLog";
import { buildCreateInput, type RawCreateBody } from "../server/adminCampaigns";
import { adminAuthGate } from "../server/adminAuth";
import { adminBearerGate } from "../server/adminGate";
import { MetricsStore } from "../server/metricsStore";
import { verifyWalletOwnership } from "../server/walletAuth";
import {
  applyWatchlistOps,
  listSubscriptions,
  parseWatchlistOps,
  registerSelfSubscription,
  WATCHLIST_LABEL_MAX,
  WATCHLIST_MAX,
  WatchlistError,
} from "../server/watchlist";
import {
  loadAlertSettings,
  saveAlertSettings,
  toWireSettings,
} from "../server/alertSettingsStore";
import { parseAlertSettings } from "../packages/scoring/src/watch/alertSettings";
import { fetchAlertOutcomes } from "../server/alertOutcomes";
import { AUTH_NONCE_TTL_MS, SupabaseNonceStore } from "../server/nonceStore";
import {
  burnDeepLinkToken,
  clearedSessionCookie,
  createSession,
  readCookie,
  readSession,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
} from "../server/sessionStore";
import { SupabaseDelegationStore } from "../server/exitDelegationStore";
import { ViemExitChainReader } from "../server/exitChain";
import { listLiveDelegations, revokeDelegation, submitDelegation } from "../server/exitDelegations";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Railway (and most PaaS) inject PORT; fall back to PANIK_API_PORT for local dev.
const PORT = Number(process.env.PORT ?? process.env.PANIK_API_PORT ?? 8787);
const cgKey = process.env.COINGECKO_API_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
// Which chain the SCORING path reads (server/scoringChain.ts). Unset =
// mainnet, exactly as before. The Alchemy key required depends on it, so the
// boot check below names the one this chain actually wants.
const alchemy = resolveAlchemyKey(process.env.PANIK_SCORING_CHAIN, process.env);
// Persona profiler keys are OPTIONAL — the rest of the API runs without them;
// /api/profile reports 503 if Dune is unconfigured, and narration falls back
// to deterministic prose if OpenRouter is absent.
// Profiler keys are read by getProfileDeps from env directly; we only need to
// know here whether to advertise the endpoints (DUNE + DB are the hard reqs).
const duneKey = process.env.DUNE_API_KEY;
if (!cgKey || !dbUrl) {
  console.error(
    `Missing env (COINGECKO_API_KEY / SUPABASE_DB_URL)` +
      ` — scoring chain is ${alchemy.config.label} (PANIK_SCORING_CHAIN=${process.env.PANIK_SCORING_CHAIN ?? "unset"})`,
  );
  process.exit(1);
}
// The Alchemy key is OPTIONAL. Each chain's fallback transport starts at a
// keyless public node (server/scoringChain.ts), so the API serves scores
// without one. This used to process.exit(1), which is why an exhausted free
// tier read as "the API is down" rather than "reads are slower".
const alchemyNotice = alchemyKeyNotice(alchemy);
if (alchemyNotice) console.warn(alchemyNotice);

const providers = {
  assetRisk: new CoinGeckoProvider(cgKey),
  systemic: new DefiLlamaProvider(),
};

/**
 * The armed market simulation (server/simulationStore.ts), shared by the
 * scoring path and the admin routes that arm and clear it.
 *
 * Null when Supabase is unconfigured, which disables the feature entirely
 * rather than half-enabling it: an operator able to arm a scenario the worker
 * cannot see would show a crashed dashboard next to a silent alert channel.
 */
const simulations = (() => {
  try {
    return new SimulationCache(SimulationStore.fromEnv());
  } catch {
    return null;
  }
})();

/**
 * Every chain this process can score, not just the configured one.
 *
 * The chain is a per-REQUEST choice now (`?chain=`), because the product has
 * two honest modes: mainnet shows the risk management working on real money,
 * testnet shows the exit actually settling, since the executor is deployed on
 * Base Sepolia alone. Those used to be two builds. PANIK_SCORING_CHAIN is still
 * the default, so a deployment that sets nothing and a client that sends
 * nothing both behave exactly as before.
 */
const scoringChains = buildScoringChains({
  defaultMode: process.env.PANIK_SCORING_CHAIN,
  env: process.env,
  providers,
  onReaderError: (err) =>
    console.error(`reader failed (other protocols continue): ${describeReaderError(err)}`),
  onCompoundWarn: (m) => console.warn(`compound reader degraded: ${m}`),
  simulation: () => simulations?.current() ?? null,
});
/**
 * The registry-wide loop (/api/scores) and the boot log read this one. It is
 * NOT the adapter a wallet request uses: those resolve their own runtime from
 * `?chain=`, and reusing this one would score every caller on the deployment's
 * default chain while telling them which chain they asked for.
 */
const defaultChain = scoringChains.get(scoringChains.defaultMode);
const { adapter } = defaultChain;
for (const mode of scoringChains.available) {
  const cfg = scoringChains.get(mode).config;
  console.log(
    `scoring chain ${mode === scoringChains.defaultMode ? "(default) " : ""}` +
      `${cfg.label} (${cfg.chainId}), protocols ${cfg.protocols.join(", ")}, ` +
      `market context ${cfg.marketContext}`,
  );
}

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

/**
 * The eight preset scores, refreshed at most once a minute.
 *
 * A failed refresh serves the LAST GOOD payload with its original `at`, which
 * is the rule `getPoolYields` below already follows. `scoreProspective` awaits
 * its market-context providers with `Promise.all`, so one CoinGecko hiccup on
 * one of eight scenarios rejected the whole batch and the route answered 500 —
 * and the client's own fallback for a dead /api/compass is the listed
 * `VAULT_PRESETS` constants, so a single upstream blip replaced eight measured
 * scores with eight guesses. Stale engine numbers with a timestamp saying how
 * stale are strictly better than that, and the timestamp is why: it rides out
 * on `updatedAt` untouched, so the age is the client's to see rather than this
 * function's to hide.
 *
 * With no cached payload at all (`at === 0`, the boot state) there is nothing
 * to be stale about, and the throw stands: an error is the honest answer and
 * an empty score list would read as eight markets the engine declined to score.
 */
async function getCompass(): Promise<typeof compassCache> {
  if (Date.now() - compassCache.at < 60_000) return compassCache;
  let scores: unknown[];
  try {
    scores = await Promise.all(
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
  } catch (err) {
    if (compassCache.at === 0) throw err;
    console.error(`compass refresh failed, serving cache: ${(err as Error).message.slice(0, 100)}`);
    return compassCache;
  }
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

// ── chain telemetry (10s cache, PER CHAIN) ────────────────────────────────
// One entry per mode, not one entry: a block height and a gas price are facts
// about a specific chain, and Base Sepolia's block number served under a "Base"
// label is a wrong number rather than a stale one.
interface ChainTelemetry {
  at: number;
  blockNumber: number;
  gasGwei: number;
}
const chainCaches = new Map<string, ChainTelemetry>();

async function getChain(runtime: ScoringChainRuntime): Promise<ChainTelemetry> {
  const key = runtime.config.mode;
  const hit = chainCaches.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit;
  const [block, gas] = await Promise.all([
    runtime.telemetry.getBlockNumber(),
    runtime.telemetry.getGasPrice(),
  ]);
  const fresh = { at: Date.now(), blockNumber: Number(block), gasGwei: Number(gas) / 1e9 };
  chainCaches.set(key, fresh);
  return fresh;
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
  // DELETE is here for /api/session and /api/admin/simulation. It was missing
  // while the latter already existed, so a cross-origin preflight for it was
  // being answered with a method list that did not include it.
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token, X-Admin-Key");
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
//
// ── WHY THE READ PATH IS MULTIPLIABLE ─────────────────────────────────────
// Every limiter keys on ipBucket(clientIp(req)). In production that is one
// bucket per client. On a developer's machine it is ONE BUCKET FOR EVERYTHING:
// the app tab, the admin console, a second tab, and any curl all arrive as
// 127.0.0.1, so they share a single 30/min budget. Two tabs plus a few reloads
// exhausts it, /positions starts answering 429, and the dashboard renders "Live
// feed unavailable" — which reads as a broken scoring feed and invites the
// retry that keeps the window full. That cost a demo rehearsal.
//
// So the CHEAP, CACHED READS take a multiplier, default 1 (production is
// unchanged by this). Set PANIK_RATE_LIMIT_X locally in .env.
//
// adminLimit is multiplied too, and it is the one worth justifying. It is NOT
// what stops a stranger guessing their way in: that is the failed-auth brake in
// server/adminAuth.ts, keyed on a HASH OF THE PRESENTED CREDENTIAL rather than
// on the caller's address, and nothing here touches it. This is a generic
// per-IP brake in front of routes that are already bearer-gated, and 10/min is
// tight for a console that loads the simulator, the campaigns and the
// redemptions on every render: one operator with the page open exhausted it and
// read "rate limit exceeded" on a panel that had done nothing wrong.
//
// Deliberately NOT multiplied: advisorLimit (OpenRouter completions per miss),
// strictLimit (spends third-party quota) and webhookLimit. Widening those to
// make local dev comfortable would widen the exact controls that exist because
// the request costs money, and one stray env var in production should not be
// able to reach them.
// Anything unparseable, zero or negative means "no opinion", not "no limit".
const rawRateLimitX = Number(process.env.PANIK_RATE_LIMIT_X ?? 1);
const RATE_LIMIT_X =
  Number.isFinite(rawRateLimitX) && rawRateLimitX >= 1 ? Math.min(rawRateLimitX, 100) : 1;
const publicLimit = rateLimit({ limit: 120 * RATE_LIMIT_X }); // 60s-cached GETs, no caller-supplied key
const walletLimit = rateLimit({ limit: 30 * RATE_LIMIT_X });  // /positions, /history — wallet-keyed
const advisorLimit = rateLimit({ limit: 10 });            // RPC + LLM + DB per miss; UI polls 1/min
const telegramStatusLimit = rateLimit({ limit: 60 * RATE_LIMIT_X }); // 3s poll during linking
const profileResultLimit = rateLimit({ limit: 40 * RATE_LIMIT_X });  // 3s poll during the reveal
const strictLimit = rateLimit({ limit: 10 });             // spends money / mints state
const adminLimit = rateLimit({ limit: 10 * RATE_LIMIT_X }); // failed-auth brake lives in server/adminAuth.ts
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

// ── Worker liveness (Phase 4.B) ─────────────────────────────────────────────
//
// THE WORKER CANNOT PAGE FOR ITS OWN DEATH. Everything that watches coverage
// runs inside scripts/watch-worker.ts, so a process that dies or hangs silences
// every alert at once — and silence looks exactly like health. The worker
// therefore asserts liveness into public.worker_heartbeats on every COMPLETED
// loop, and this process, which is deployed separately on Railway and does not
// share the worker's lifecycle, is the one that notices the assertion stop.
//
// Two ways to consume it, both live here on purpose:
//   * GET /api/health/worker — 503 when any loop is overdue. This is the
//     endpoint an external uptime check points at, and it is the delivery path
//     that survives BOTH processes being wrong about themselves.
//   * The interval below pages the operator channel directly, so the page does
//     not depend on anyone having wired an uptime check yet.
const WORKER_WATCHDOG_MS = 60_000;
const workerHeartbeats: HeartbeatStore | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? SupabaseHeartbeatStore.fromEnv()
    : null;
const watchdogAlerts = workerHeartbeats
  ? new AlertDispatcher(
      SupabaseAlertLedger.fromEnv(),
      [
        operatorLogSink,
        ...(process.env.MONITOR_OPERATOR_WEBHOOK_URL?.trim()
          ? [operatorWebhookSink(process.env.MONITOR_OPERATOR_WEBHOOK_URL.trim())]
          : []),
      ],
    )
  : null;

/** Loops whose absence is a page. Mirrors EXPECTED_LOOPS in the worker. */
const WORKER_LOOPS = ["watch", "dispatch", "monitor"] as const;

app.get("/api/health/worker", publicLimit, async (req, res) => {
  if (!workerHeartbeats) {
    res.status(503).json({ ok: false, error: "heartbeat store unconfigured" });
    return;
  }
  try {
    const records = await workerHeartbeats.list();
    // No bootedAt: this process's uptime says nothing about the WORKER's, and
    // suppressing "never reported" on an API restart would hide a worker that
    // has been dead the whole time.
    const stale = heartbeatAlerts(records, WORKER_LOOPS, Date.now());
    res.status(stale.length === 0 ? 200 : 503).json({
      ok: stale.length === 0,
      loops: records.map((r) => ({
        loop: r.loop,
        at: new Date(r.at).toISOString(),
        expectedBy: new Date(r.expectedByMs).toISOString(),
      })),
      overdue: stale.map((a) => a.summary),
    });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

if (workerHeartbeats && watchdogAlerts) {
  setInterval(() => {
    void (async () => {
      try {
        const stale = heartbeatAlerts(await workerHeartbeats.list(), WORKER_LOOPS, Date.now());
        if (stale.length > 0) await watchdogAlerts.dispatch(stale);
      } catch (err) {
        console.error(`worker watchdog failed: ${(err as Error).message.slice(0, 160)}`);
      }
    })();
  }, WORKER_WATCHDOG_MS);
  console.log(`worker watchdog @${WORKER_WATCHDOG_MS / 1000}s over ${WORKER_LOOPS.join(", ")}`);
} else {
  console.warn("worker watchdog not started: SUPABASE_URL / SUPABASE_SECRET_KEY missing");
}

// Deploy marker - confirms WHICH commit is live (Railway injects the SHA).
app.get("/api/version", (_req, res) => {
  res.json({
    service: "panik-api",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "unknown",
    bootAt: BOOT_AT,
  });
});

/**
 * Admin gate for the whole-registry routes. Unauthenticated, these dumped every
 * watched wallet (address + risk profile + operator label) — the enumeration
 * list an attacker needs to target other users, and a de-facto customer roster.
 * Only the ops/demo view consumes them; a user's OWN data comes from the
 * per-wallet routes (/api/positions, /api/history), which stay open.
 *
 * The guessing brake is keyed on the PRESENTED credential, never the caller's
 * IP — an IP-keyed lockout lets any stranger lock the real admin out. See
 * server/adminAuth.ts.
 */
function requireAdmin(req: express.Request, res: express.Response): boolean {
  // Already established upstream by adminBearerGate (a signed-in Supabase
  // operator). Nobody sets this but that middleware, on a verified identity.
  if (res.locals.adminAuthed === true) return true;
  const { auth, retryAfterSec } = adminAuthGate.authorize(req.header("x-admin-key") ?? undefined);
  if (auth === "unconfigured") { res.status(503).json({ error: "admin unconfigured (ADMIN_ACCESS_KEY)" }); return false; }
  if (auth === "locked") {
    res.setHeader("Retry-After", String(retryAfterSec ?? 60));
    res.status(429).json({ error: "too many failed admin auth attempts", retryAfterSec });
    return false;
  }
  if (auth === "forbidden") {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// Watch registry — the ops wallet selector source (so wallets with no readable
// positions still get a pill instead of vanishing). `label` never leaves here.
app.get("/api/wallets", adminLimit, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await db.query(
      "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
    );
    res.json({ wallets: rows });
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

// Admin, and deliberately NOT per-request: this is the watch registry's own
// scores, produced by the loop the worker runs on PANIK_SCORING_CHAIN. Letting
// a caller re-point it would return positions the alerting path never looked
// at, under the registry's label. The chain block names the chain it IS.
app.get("/api/scores", adminLimit, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { at, positions } = await getScores();
    res.json({ updatedAt: at, positions, chain: scoringChainWire(defaultChain.config) });
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

/**
 * Issue a single-use SIWE nonce. The browser fetches one immediately before
 * prompting a signature; verification consumes it atomically, which is what
 * makes an ownership proof unreplayable (and unmakeable by a hostile page that
 * never talked to us). Unauthenticated on purpose — a nonce authorizes nothing
 * on its own — but STRICT-tiered anyway: every call mints a row, so this is a
 * write endpoint wearing a GET, and the cheap-GET budget does not apply. One
 * nonce is fetched per signature prompt, so 10/min is far above real use.
 */
app.get("/api/auth/nonce", strictLimit, async (req, res) => {
  let store: SupabaseNonceStore;
  try {
    store = SupabaseNonceStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `sign-in unconfigured: ${(err as Error).message}` });
    return;
  }
  try {
    const { nonce } = await store.issue();
    res.json({ nonce, expiresInSec: AUTH_NONCE_TTL_MS / 1000 });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// ── identity sessions ───────────────────────────────────────────────────────
//
// SIGNATURES AUTHORIZE ACTIONS; SESSIONS ONLY RESTORE IDENTITY. These four
// routes are the entire session surface, and none of the write endpoints below
// reads a cookie: /api/watchlist, /api/wallets/register and /api/telegram/link
// each still demand their own single-use SIWE proof on every request, exactly
// as they did before sessions existed. server/sessionBoundary.test.ts scans
// this file and fails the build if a mutating route ever starts consulting one.
//
// All four are strict-tiered. Each one either mints a row, burns a row, or is
// an unauthenticated guess at a credential, and none is a cheap cached GET.
//
// CORS: `Access-Control-Allow-Credentials` is deliberately NOT set. The
// frontend reaches this API same-origin through the Vercel rewrite
// (www.panik.fi/api/* -> Railway), so the cookie rides along without it;
// setting it would be the one change that makes these cookies usable from a
// genuinely cross-origin page.

/** The session token this request presents, if any. */
function presentedToken(req: express.Request): string | null {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

/**
 * Mint a full session from a SIWE proof of `session-start`.
 *
 * The proof is a normal single-use ownership proof — same nonce, same domain
 * binding, same exact-message re-derivation as every write. What is different
 * is what it buys: a name, for thirty days, and nothing else.
 */
app.post("/api/session", strictLimit, async (req, res) => {
  const proof = await verifyWalletOwnership(req.body, "session-start");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  try {
    const session = await createSession(db, proof.wallet, "full");
    res.setHeader("Set-Cookie", sessionCookie(session.token, session.maxAgeSec));
    res.json({ wallet: proof.wallet, scope: "full", expiresAt: session.expiresAt });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Who is this browser? 401 when the answer is "nobody we can vouch for".
 *
 * One refusal for every cause — no cookie, malformed, unknown, revoked,
 * expired. The client cannot tell them apart, and should not: the difference is
 * only ever useful to someone guessing tokens.
 */
// walletLimit, not strictLimit: the SPA reads the session on every boot, and a
// shared-IP office or a dev machine with a few tabs would burn 10/min instantly.
// Reads reveal nothing mintable; mint/revoke/exchange stay strict.
app.get("/api/session", walletLimit, async (req, res) => {
  try {
    const identity = await readSession(db, presentedToken(req));
    if (!identity) {
      res.status(401).json({ error: "not signed in" });
      return;
    }
    res.json(identity);
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Sign out: revoke server-side AND clear the cookie, in that order of
 * importance. Clearing the cookie alone would leave any copy that had already
 * been taken valid for the rest of its life, which is the opposite of what the
 * person pressing this button is asking for.
 *
 * Always 200, even with no cookie. Sign-out is idempotent and must not report
 * whether the token it was handed happened to exist.
 */
app.delete("/api/session", strictLimit, async (req, res) => {
  try {
    await revokeSession(db, presentedToken(req));
  } catch (err) {
    // Log it, but still clear the cookie: leaving the browser signed in because
    // the revocation write failed is the worse of the two outcomes.
    console.error(`DELETE /api/session revoke failed: ${(err as Error).message}`);
  }
  res.setHeader("Set-Cookie", clearedSessionCookie());
  res.json({ ok: true });
});

/**
 * Trade a Telegram alert's `sid` for a READONLY session.
 *
 * Read-only because that is the honest reading of what the bearer proved: they
 * can see the chat this wallet's alerts go to. Enough to be shown the position
 * the alert was about; not enough to be treated as the key holder, which is why
 * this cannot mint a 'full' session and why the writes still want a signature.
 *
 * The burn is atomic and single-use (server/sessionStore.ts). Every failure is
 * one 401 with one string, distinct from the "not signed in" of GET so the UI
 * can phrase it for a human, and vague between unknown / expired / already-used
 * because the server genuinely does not know which applied.
 */
app.post("/api/session/exchange", strictLimit, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : null;
  try {
    // Two independent reads, so they go together rather than one after the
    // other: neither the burn nor the cookie lookup is an input to the other,
    // and this route is on the path a worried person takes from an alert.
    //
    // The only ordering this gives up is that `readSession`'s opportunistic
    // `last_seen_at` bump can now land beside a burn that fails. That column is
    // a diagnostic nothing decides on, and "this browser was here" is true
    // whether or not the token it presented was still good.
    const [wallet, existing] = await Promise.all([
      burnDeepLinkToken(db, token),
      readSession(db, presentedToken(req)),
    ]);
    if (!wallet) {
      res.status(401).json({ error: "alert link is no longer valid — open PANIK from a fresh alert" });
      return;
    }
    // A browser already holding a FULL session for this wallet keeps it: the
    // token is burned above either way (a live token in a chat is the risk),
    // but replacing a 30-day full cookie with a 7-day readonly one would
    // DOWNGRADE the signed-in user who tapped their own alert and silently
    // lock them out of edits until they re-sign.
    if (existing && existing.scope === "full" && existing.wallet === wallet) {
      res.json({ wallet, scope: "full", expiresAt: existing.expiresAt });
      return;
    }
    const session = await createSession(db, wallet, "readonly");
    res.setHeader("Set-Cookie", sessionCookie(session.token, session.maxAgeSec));
    res.json({ wallet, scope: "readonly", expiresAt: session.expiresAt });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/** A WatchlistError → its own status; anything else → the generic handler. */
function watchlistError(req: express.Request, res: express.Response, err: unknown): void {
  if (err instanceof WatchlistError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  serverError(req, res, 500, err);
}

/**
 * Register the caller's OWN wallet for monitoring (onboarding). Replaces the
 * browser's direct rpc/register_watched_wallet call, which the publishable key
 * let anyone aim at a victim's row: rewriting risk_profile to "aggressive"
 * raises their alert threshold from 25 to 75 and mutes their liquidation
 * warnings, and unbounded inserts add wallets the worker polls every 60s.
 *
 * Since watchlists it is a SELF-SUBSCRIPTION rather than a registry row, and it
 * goes through the same core the batch endpoint uses (server/watchlist.ts). That
 * closes the two footguns the old RPC carried: it can no longer resurrect a
 * wallet the user had removed (it creates exactly one subscription, and the
 * registry is re-derived from what exists afterwards), and it no longer stamps
 * 'onboarded user' over a label the user chose — it passes no label at all.
 *
 * Ownership signature bound to the "wallet-register" action + strict per-IP
 * limit. The response carries the resulting list so the client never has to
 * guess what the write did.
 */
app.post("/api/wallets/register", strictLimit, async (req, res) => {
  const proof = await verifyWalletOwnership(req.body, "wallet-register");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  // Normalized before it reaches SQL — the profile selects alert thresholds.
  const profile = riskProfileParam(req.body?.profile);
  try {
    const watching = await registerSelfSubscription(db, proof.wallet, profile);
    res.json({ ok: true, watching });
  } catch (err) {
    watchlistError(req, res, err);
  }
});

/**
 * Change the caller's watchlist: a batch of add / update / remove operations
 * behind ONE ownership proof.
 *
 * ONE signature per batch, not per wallet. A user replacing their list should
 * approve "update the list of wallets PANIK watches for you" once, and every op
 * in the batch is applied in a single transaction — a half-applied list is a
 * user looking at wallets they did not ask for, or missing ones they did.
 *
 * The proof's owner IS the owner_wallet; the body cannot name a different one.
 * That is the whole auth model here: `watched_wallet` may be any address (that
 * is the feature — you can watch a wallet you do not control), but who the
 * alerts go to is decided by a signature, never by a field.
 *
 * strictLimit rather than walletLimit: one request per batch, and every request
 * mints rows the worker then polls every 60s.
 */
app.post("/api/watchlist", strictLimit, async (req, res) => {
  const proof = await verifyWalletOwnership(req.body, "watchlist-manage");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  const parsed = parseWatchlistOps(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const watching = await applyWatchlistOps(db, proof.wallet, parsed.ops);
    res.json({ ok: true, watching });
  } catch (err) {
    watchlistError(req, res, err);
  }
});

/**
 * One owner's watchlist. Unsigned by decision: the list holds addresses and the
 * owner's own labels for them, all of which are public chain data plus a
 * nickname, and requiring a signature to READ your own list would mean a wallet
 * popup on every page load. Nothing here is a credential and nothing here can
 * be written.
 *
 * The two LIMITS ride on the response so the browser never holds a copy of
 * them. The management panel's counter states the cap out loud ("3 of 10
 * watched") and its name field enforces the length, so a build-time constant in
 * the bundle would have the UI teaching a stale number the day either moves,
 * with nothing visibly broken. `server/watchlist.ts` owns both; this is the one
 * place they cross to the client.
 */
app.get("/api/watchlist", walletLimit, async (req, res) => {
  const owner = String(req.query.owner ?? "").trim().toLowerCase();
  if (!isEvmAddress(owner)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  try {
    res.json({
      updatedAt: Date.now(),
      watching: await listSubscriptions(db, owner),
      max: WATCHLIST_MAX,
      labelMax: WATCHLIST_LABEL_MAX,
    });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Change when PANIK alerts the caller (7.4 / 7.5).
 *
 * SIGNED, and with its OWN action URN. Alert settings are per-wallet state, so
 * changing them acts on a wallet: without a proof, anyone could name a victim's
 * address and mute their liquidation alerts, which is not an inconvenience but a
 * silent failure of the one thing this product promises. The URN is
 * `alert-settings` and nothing else — a signature a user gave to link Telegram
 * or to manage a watchlist must not double as permission to silence them
 * (server/siweProof.ts).
 *
 * strictLimit, like every other signed write: a proof costs a nonce and this
 * endpoint writes a row the dispatcher then reads on every pass.
 *
 * The body is a WHOLE settings object, not a patch. An absent field is the
 * engine default, which makes "reset to defaults" an empty body and removes the
 * class of bug where a partial save leaves half of a quiet-hours window behind.
 */
app.post("/api/alerts/settings", strictLimit, async (req, res) => {
  const proof = await verifyWalletOwnership(req.body, "alert-settings");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  const parsed = parseAlertSettings(req.body?.settings);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    await saveAlertSettings(db, proof.wallet, parsed.settings);
    res.json({ ok: true, settings: toWireSettings(await loadAlertSettings(db, proof.wallet)) });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * One wallet's current alert settings. Unsigned to READ, on the same reasoning
 * as GET /api/watchlist: nothing here is a credential, nothing here can be
 * written through this route, and demanding a wallet popup to render a settings
 * screen would push people to skip the screen.
 */
app.get("/api/alerts/settings", walletLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  try {
    res.json({ settings: toWireSettings(await loadAlertSettings(db, wallet)) });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Observed alert quality (7.3): how many delivered alerts were followed by the
 * position getting worse, and how many by it going quiet again.
 *
 * Both figures, always: one user's own history is usually too small to mean
 * anything on its own, and the aggregate is what the ~24-27% backtest figure
 * should be read against. `falseAlarmRate` is null until something has actually
 * been decided - a 0% rate computed from no evidence is the
 * unknown-rendered-as-zero bug in its most flattering form.
 *
 * The aggregate is counts only and names no wallet, which is why it is safe to
 * return next to a per-user figure the caller already knows.
 */
app.get("/api/alerts/outcomes", walletLimit, async (req, res) => {
  const raw = String(req.query.wallet ?? "").trim().toLowerCase();
  if (raw && !isEvmAddress(raw)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  try {
    const [aggregate, user] = await Promise.all([
      fetchAlertOutcomes(db, null),
      raw ? fetchAlertOutcomes(db, raw) : Promise.resolve(null),
    ]);
    res.json({ user, aggregate, generatedAt: new Date().toISOString() });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

// Live positions for ONE arbitrary wallet — the onboarded user's own wallet —
// scored on demand via that request's ActiveAdapter. Lets the dashboard follow
// the pasted wallet instead of the seeded validation registry.
// 60s cache per CHAIN AND wallet (mirrors the live-loop cadence).
// Wallet-keyed caches are LRU-capped: the keys come from the caller, so an
// unbounded Map would let anyone grow the heap one address at a time.
const CACHE_MAX_WALLETS = 2_000;
const ownPosCache = new LruCache<{
  at: number;
  positions: LivePosition[];
  /**
   * Which simulation these positions were scored under (null = real prices).
   *
   * The cache is keyed on it as well as on time, because a 60-second entry is
   * otherwise 60 seconds during which the marker and the numbers disagree: arm
   * a scenario and the dashboard would keep serving real figures under a
   * "simulated" banner, and - much worse - clearing one would drop the banner
   * off numbers that are still the crashed ones. Either direction is exactly
   * the screenshot this feature exists to make impossible.
   */
  simulationId: string | null;
}>(CACHE_MAX_WALLETS);
app.get("/api/positions", walletLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  const profile = riskProfileParam(req.query.profile);
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  // An unrecognised ?chain= resolves to mainnet rather than 400ing: the value
  // is a display preference read out of the user's own browser storage, and a
  // stale or edited one must not put an error page over positions we can read.
  const runtime = scoringChains.resolve(req.query.chain);
  // Read ONCE per request and reuse for the cache test, the scoring pass and
  // the wire: three separate reads could straddle an expiry and describe the
  // response with a scenario that was not the one it was scored under.
  const armed = simulations?.current() ?? null;
  const armedId = armed?.id ?? null;
  const wire = armed ? simulationWire(armed) : null;
  // Chain-scoped, for the reason spelled out on `chainScopedKey`: one wallet
  // holds a different position on each chain, and a shared key would let one
  // answer the other for a minute.
  const cacheKey = chainScopedKey(runtime.config.mode, wallet);

  const cached = ownPosCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000 && cached.simulationId === armedId) {
    res.json({
      updatedAt: cached.at,
      positions: cached.positions,
      chain: scoringChainWire(runtime.config),
      simulation: wire,
    });
    return;
  }
  try {
    const scored = await runtime.adapter.scoreWallet(wallet);
    const positions: LivePosition[] = scored.map((s) => ({
      ...s,
      label: null,
      riskProfile: profile,
      profileStatus: statusFor(profile, s.total),
    }));
    ownPosCache.set(cacheKey, { at: Date.now(), positions, simulationId: armedId });
    res.json({
      updatedAt: Date.now(),
      positions,
      chain: scoringChainWire(runtime.config),
      simulation: wire,
    });
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
      // The delivery chip comes from the SELF-OWNER's delivery row when there
      // is one, and falls back to the legacy per-transition columns otherwise
      // (rows written before watch_deliveries existed still carry their outcome
      // there). This surface is "what happened to MY wallet", so the self-owner
      // is the only recipient it can honestly speak for: a transition delivered
      // solely to a third-party watcher reads as still queued here, which is
      // both the truthful answer for this reader and the one that does not
      // disclose that somebody else is watching them.
      db.query(
        `select t.protocol, t.risk_profile, t.score, t.band, t.from_status, t.to_status,
                coalesce(d.notify_channel, t.notify_channel) as notify_channel,
                coalesce(d.notified_at,    t.notified_at)    as notified_at,
                t.created_at
           from public.watch_transitions t
           left join public.watch_deliveries d
             on d.transition_id = t.id and d.owner_wallet = t.wallet
          where t.wallet = $1
          order by t.created_at desc
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

/**
 * Where a narration attempt gets written down, rejected ones included.
 * See server/narrationLog.ts for why the prompt is stored as a hash.
 */
const narrationStore: NarrationStore = {
  insert: (row: NarrationLogRow) =>
    db.query(
      "insert into public.advisor_narrations" +
        " (wallet, model, raw_response, numeric_pass, hedge_pass, served, payload_hash)" +
        " values ($1,$2,$3,$4,$5,$6,$7)",
      [
        row.wallet,
        row.model,
        row.rawResponse,
        row.numericPass,
        row.hedgePass,
        row.served,
        row.payloadHash,
      ],
    ),
};

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
  const runtime = scoringChains.resolve(req.query.chain);
  // The simulation id is part of the cache key, not a field checked after the
  // hit: a report written under a scenario and one written under real prices
  // are answers to different questions and must never substitute for each other.
  // The chain is in the key for the same reason, one step further out: a report
  // is advice about a position, and the two chains hold different positions.
  const armedId = simulations?.current()?.id ?? null;
  const key = chainScopedKey(runtime.config.mode, wallet, profile, armedId ?? "real");
  const hit = advisorCache.get(key);
  if (hit && Date.now() - hit.at < ADVISOR_TTL_MS) {
    res.json(hit.report);
    return;
  }
  try {
    // 1 - positions: reuse the /api/positions 60s cache when fresh AND scored
    // under the same simulation state. The advisor is not special-cased: it
    // sizes a repay from whatever health factor the engine hands it, so an
    // entry cached before a scenario was armed would have it recommending HOLD
    // against a crash the rest of the screen is showing.
    const posKey = chainScopedKey(runtime.config.mode, wallet);
    const cachedPos = ownPosCache.get(posKey);
    let scores: ActiveScore[];
    if (cachedPos && Date.now() - cachedPos.at < 60_000 && cachedPos.simulationId === armedId) {
      scores = cachedPos.positions;
    } else {
      scores = await runtime.adapter.scoreWallet(wallet);
      ownPosCache.set(posKey, {
        at: Date.now(),
        simulationId: armedId,
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
    // Opportunities are OPEN suggestions sized from MARKETS, which is the Base
    // mainnet listing set, priced by CoinGecko and DefiLlama. On a chain whose
    // market context is unavailable none of that describes anything the user
    // can act on: the scan would offer "USDC on Moonwell, 4.2% APY" to someone
    // on Base Sepolia, where Moonwell is not deployed and the APY is another
    // chain's. Having nothing to suggest is the honest answer, and an empty
    // list is a state the Advisor already renders.
    const opportunities =
      runtime.config.marketContext === "unavailable"
        ? []
        : await findOpportunities({
            wallet,
            profile,
            scoreScenario: (s) => scoreProspective(s, providers),
            currentRecommendations: recommendations,
            yields,
            insights,
          });

    // 4 - narrate non-HOLD legs + the top opportunity, time-boxed; any failure
    // keeps the deterministic sections already attached. The narrator's own
    // guards (numeric whitelist, critical-verdict template slot, symbol
    // sanitisation, circuit breaker) decide whether a completion is servable;
    // this loop only decides whether it arrived in time.
    let narrated = false;
    if (advisorNarrator) {
      const targets = [
        ...recommendations.filter((r) => r.action !== "HOLD"),
        ...opportunities.slice(0, 1),
      ];
      await Promise.all(
        targets.map(async (rec) => {
          const attempt = advisorNarrator.narrateWithAudit(rec, profile, insights).catch(() => null);
          const out = await withTimeout(attempt, ADVISOR_NARRATE_TIMEOUT_MS, null);
          const useModel = out !== null && out.served === "narrated";
          if (useModel && out) {
            rec.sections = out.sections;
            narrated = true;
          }
          rec.narrationSource = useModel ? "narrated" : "fallback";
          // Audited off the SETTLED promise, not the raced one, so a completion
          // that arrived a second late is still on the record - `served` stays
          // the decision this request actually made.
          void attempt.then((settled) => {
            if (!settled) return;
            logNarration(
              narrationStore,
              {
                wallet,
                model: settled.model,
                raw: settled.raw,
                numericPass: settled.numericPass,
                hedgePass: settled.hedgePass,
                served: useModel ? "narrated" : "fallback",
                payload: settled.payload,
              },
              (e: unknown) =>
                console.error(
                  `advisor_narrations insert failed: ${(e as Error).message.slice(0, 80)}`,
                ),
            );
          });
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
// Ownership-gated: the code this mints redirects a wallet's liquidation alerts
// to whoever opens the deep link, so the caller must PROVE the wallet is theirs
// with a proof bound to THIS action — a "register my wallet" signature must not
// double as authorization to redirect someone's alerts.
const telegramConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.VITE_TELEGRAM_BOT_USERNAME,
);
app.post("/api/telegram/link", strictLimit, async (req, res) => {
  const proof = await verifyWalletOwnership(req.body, "telegram-link");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  const wallet = proof.wallet;
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
// deny-all to the browser).
//
// It used to return the @username too, which made this an unauthenticated
// wallet -> Telegram handle oracle: walk the wallet list and you deanonymize
// the whole user base. What remains says nothing about WHO the account is.
//
// Phase 4.B: LINKED, SUBSCRIBED and REACHABLE are three different facts and
// `enabled` was reporting one number for all three, so a user who blocked the
// bot read as fully alerted until the first alert failed — and the first alert
// IS the emergency. The response now carries all three (see
// server/telegramReach.ts), and the top-level `linked` field, which drove the
// "you will be alerted" claim, now means `alertsDeliverable`: a link exists AND
// there is no evidence the bot is blocked. Strictly stronger than the bit it
// replaces, so no existing caller gets a weaker guarantee.
app.get("/api/telegram/status", telegramStatusLimit, async (req, res) => {
  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) { res.status(400).json({ error: "invalid EVM wallet address" }); return; }
  if (!telegramConfigured) { res.status(503).json({ error: "telegram unconfigured" }); return; }
  try {
    const state = linkState(await TelegramStore.fromEnv().getLinkState(wallet), Date.now());
    res.json({
      linked: state.alertsDeliverable,
      link: {
        linked: state.linked,
        subscribed: state.subscribed,
        reachability: state.reachability,
        reachableAt: state.reachableAt,
        unreachableSince: state.unreachableSince,
        alertsDeliverable: state.alertsDeliverable,
      },
    });
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

// ── Delegated exit permits (Phase 2.B) ─────────────────────────────────────
// A user signs an EIP-712 ExitPermit in their wallet; the backend verifies it
// recovers to permit.user on the EXECUTOR's domain (Base Sepolia 84532, NOT the
// mainnet 8453 SIWE uses) and stores the SIGNED permit so the Phase 4.A relayer
// can later submit it via atomicExitFor. PANIK custodies no key; the permit
// carries no recipient, so a stored row can only ever pay the user. Revocation
// is the user's own on-chain action (invalidateUnorderedNonces / revokeAll);
// the live-permit query resolves every row against on-chain state so a permit
// the chain would reject is never reported live. Mirrors api/exit/*.
//
// No separate SIWE proof: the permit signature already proves wallet control
// for THIS scoped action and cannot redirect value (see server/exitDelegations.ts).
// Rate-limited like every money/PII path. KNOWN OPEN RISK, restated in the PR:
// the Railway-origin rate-limit bypass must be closed before this drives spend.
const exitChainReader = ViemExitChainReader.fromEnv();

app.post("/api/exit/delegations", strictLimit, async (req, res) => {
  let store: SupabaseDelegationStore;
  try {
    store = SupabaseDelegationStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `delegations unconfigured: ${(err as Error).message}` });
    return;
  }
  try {
    const result = await submitDelegation(req.body, { store, chain: exitChainReader });
    res.status(result.status).json(result.body);
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

app.get("/api/exit/delegations", walletLimit, async (req, res) => {
  let store: SupabaseDelegationStore;
  try {
    store = SupabaseDelegationStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `delegations unconfigured: ${(err as Error).message}` });
    return;
  }
  try {
    const result = await listLiveDelegations(req.query.wallet, { store, chain: exitChainReader });
    res.status(result.status).json(result.body);
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

app.post("/api/exit/delegations/revoke", strictLimit, async (req, res) => {
  let store: SupabaseDelegationStore;
  try {
    store = SupabaseDelegationStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `delegations unconfigured: ${(err as Error).message}` });
    return;
  }
  try {
    const result = await revokeDelegation(req.body, { store, chain: exitChainReader });
    res.status(result.status).json(result.body);
  } catch (err) {
    serverError(req, res, 500, err);
  }
});

// ── Product trial codes - business-card "Try Now" + admin ──────────────────
// Mirrors api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts. The
// SECURITY DEFINER RPCs enforce usage/time limits atomically; these routes only
// capture IP/UA (for the attempt log) and gate the admin surface behind
// ADMIN_ACCESS_KEY. See supabase/migrations/20260704000001_product_codes.sql.
const campaignsConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

// Mirrors the trial_grants_email_format CHECK: a permissive typo screen, not deliverability.
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

// ── Accounts (closed beta) ─────────────────────────────────────────────────
//
// Identity is a Supabase Auth user; the SPA carries its access token as a
// bearer and server/accountAuth.ts resolves it against /auth/v1/user.
//
// AN ACCOUNT IS NOT A MEMBERSHIP. Signing in creates an auth user and nothing
// else. Everything except GET /api/account sits behind requireMember, which
// 403s "closed beta - a voucher code is needed" until a voucher has been
// redeemed. GET /api/account is the deliberate exception: the SPA has to be
// able to render the screen that asks for a code, and it cannot do that if the
// only endpoint describing the account refuses to answer.
//
// NOTHING HERE WEAKENS THE SIWE BOUNDARY. A bearer says which ACCOUNT is
// calling; it never says which wallet, and it authorizes no wallet-scoped
// write. Linking a wallet demands the account bearer AND a fresh single-use
// ownership signature bound to its own action URN (server/accounts.ts).

/**
 * Account reads and the voucher/wallet writes.
 *
 * The read runs on every SPA boot for a signed-in user and is served from the
 * 60-second identity cache plus two small indexed lookups, so it sits at the
 * wallet class rather than strict — strict would rate-limit the app's own
 * startup on a shared office IP. The three WRITES are strict: each one mints
 * state, and the voucher route spends a finite campaign slot.
 */
const accountLimit = rateLimit({ limit: 30 * RATE_LIMIT_X });

/** Everything GET /api/account reports, in one round of reads. */
app.get("/api/account", accountLimit, requireAccount(), async (req, res) => {
  const account = res.locals.account as AccountContext;
  try {
    const store = AccountStore.fromEnv();
    const [wallets, history] = await Promise.all([
      store.listWallets(account.userId),
      store.membershipHistory(account.userId),
    ]);
    // The shape lives in server/accountStore.ts, because dev/mockApi.ts answers
    // this route too and a body with two authors is a body that drifts.
    res.json(
      buildAccountResponse({
        userId: account.userId,
        email: account.email,
        member: isMember(account.membership),
        membership: account.membership,
        history,
        wallets,
      }),
    );
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Redeem a voucher. Reuses the panik-try campaign machinery verbatim — the
 * atomic slot guard and the attempt log live in redeem_campaign_code and are
 * not reimplemented here (server/accounts.ts explains why at length).
 *
 * requireAccount, NOT requireMember: this is the one write a non-member must be
 * able to make, since it is how they stop being one.
 */
app.post("/api/account/voucher", strictLimit, requireAccount(), async (req, res) => {
  const account = res.locals.account as AccountContext;
  if (!campaignsConfigured) { res.status(503).json({ error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    const result = await redeemVoucher(
      {
        store: AccountStore.fromEnv(),
        campaigns: CampaignStore.fromEnv(),
        ip: clientIp(req),
        userAgent: userAgent(req.headers),
      },
      // The email is the VERIFIED one from the bearer, never a body field, so
      // the campaign roster gains a real identity rather than a typed string.
      { userId: account.userId, email: account.email, code: (req.body ?? {}).code },
    );
    if (result.outcome === "success" || result.outcome === "already_member") {
      res.json({ ok: true, outcome: result.outcome, membership: result.membership ?? null });
      return;
    }
    res.status(result.outcome === "invalid" ? 400 : 409).json({
      ok: false,
      outcome: result.outcome,
      error: VOUCHER_REFUSALS[result.outcome],
    });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Attach a wallet to the account. BOTH proofs are required: the bearer says
 * which account, the signature says which wallet. See server/accounts.ts for
 * what dropping either one costs.
 */
app.post("/api/account/wallets", strictLimit, requireAccount(), requireMember, async (req, res) => {
  const account = res.locals.account as AccountContext;
  try {
    const store = AccountStore.fromEnv();
    const result = await linkAccountWallet({ store }, account.userId, req.body);
    if (result.outcome !== "linked") {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }
    // The whole list comes back, so the client never has to guess what the
    // write did — same contract as /api/watchlist and /api/wallets/register.
    res.json({ ok: true, wallet: result.wallet, wallets: await store.listWallets(account.userId) });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

/**
 * Detach one of the account's own wallets. No signature: removing an
 * association the account itself created takes away access rather than granting
 * it, and the user_id filter in the DELETE is what makes "own only" true — a
 * caller naming a stranger's address deletes nothing and is told 404.
 */
app.delete("/api/account/wallets/:wallet", strictLimit, requireAccount(), requireMember, async (req, res) => {
  const account = res.locals.account as AccountContext;
  try {
    const store = AccountStore.fromEnv();
    const removed = await store.unlinkWallet(account.userId, String(req.params.wallet ?? ""));
    if (!removed) {
      res.status(404).json({ error: "that wallet is not linked to your account" });
      return;
    }
    res.json({ ok: true, wallets: await store.listWallets(account.userId) });
  } catch (err) {
    serverError(req, res, 502, err);
  }
});

async function adminCampaigns(req: express.Request, res: express.Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
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
/**
 * Who redeemed ONE campaign, plus every attempt against it (failures included).
 * Returns personal data (claim IP + user agent), so it sits behind the same
 * admin gate as the rest and inherits adminLimit's 10/min ceiling. Nothing here
 * is logged: the rows go to the operator's screen and no further.
 */
async function adminRedemptions(req: express.Request, res: express.Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!campaignsConfigured) { res.status(503).json({ error: "unconfigured (SUPABASE_*)" }); return; }
  // Same normalization the SQL applies (upper(btrim(...))), so a code copied
  // from a printed card with stray case or spaces still resolves.
  const code = String(req.query.code ?? "").trim().toUpperCase();
  if (!code) { res.status(400).json({ error: "missing code" }); return; }
  try {
    const store = CampaignStore.fromEnv();
    const [redemptions, attempts] = await Promise.all([
      store.listRedemptions(code),
      store.listAttempts(code),
    ]);
    res.json({ code, redemptions, attempts });
  } catch (err) {
    serverError(req, res, 502, err);
  }
}

/**
 * The market-event simulator (server/simulationStore.ts).
 *
 * GET    reports what is armed, with the wallets it currently affects.
 * POST   arms a scenario for a bounded window.
 * DELETE clears it.
 *
 * Behind the same admin gate as the rest, and deliberately not exposed in any
 * unauthenticated form: arming one changes what every user of the app sees.
 * Who armed it is recorded from the verified identity where there is one
 * (`res.locals.adminEmail`, set only by adminBearerGate on a checked Supabase
 * session) and never from the request body, which the caller controls.
 */
async function adminSimulation(req: express.Request, res: express.Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!simulations) {
    res.status(503).json({ error: "unconfigured (SUPABASE_*)" });
    return;
  }
  const actor = typeof res.locals.adminEmail === "string" ? res.locals.adminEmail : "admin-key";
  const store = SimulationStore.fromEnv();

  try {
    if (req.method === "POST") {
      const body = (req.body ?? {}) as Partial<ArmSimulationInput>;
      const input: ArmSimulationInput = {
        scenario: String(body.scenario ?? ""),
        label: String(body.label ?? ""),
        multipliers: (body.multipliers ?? {}) as Record<string, number>,
        durationMinutes: Number(body.durationMinutes),
        setBy: actor,
      };
      const invalid = validateArmInput(input);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      await store.arm(input);
    } else if (req.method === "DELETE") {
      await store.clear(actor);
    }

    // Awaited, not left to the TTL: the operator's console must show the state
    // it just created, and the next scoring pass in THIS process must use it.
    const active = await simulations.refresh();
    const watched = await watchedPositions();
    res.json({
      simulation: active ? simulationWire(active) : null,
      affected: active ? affectedPositions(watched, active.multipliers) : [],
      // Every collateral asset currently held by a watched wallet, so the
      // console offers the operator the assets that exist rather than a text
      // box in which to guess at a symbol that matches nothing.
      assets: [
        ...new Set(watched.map((p) => p.collateralSymbol).filter((s): s is string => Boolean(s))),
      ].sort(),
    });
  } catch (err) {
    serverError(req, res, 502, err);
  }
}

interface WatchedPosition {
  wallet: string;
  protocol: string;
  collateralSymbol: string | null;
  updatedAt: string;
}

/**
 * Every position on a watched wallet, as of its latest score snapshot.
 *
 * Read from snapshots rather than by re-scoring: this feeds an operator's
 * preview, and making one console refresh re-read four protocols for every
 * watched wallet would be a chain-read storm in exchange for nothing. It is
 * therefore "as of the last watch tick", which is what `updatedAt` reports.
 */
async function watchedPositions(): Promise<WatchedPosition[]> {
  const { rows } = await db.query<{
    wallet: string;
    protocol: string;
    collateral_symbol: string | null;
    created_at: string;
  }>(
    `select distinct on (s.wallet, s.protocol)
            s.wallet, s.protocol, s.collateral_symbol, s.created_at
       from public.score_snapshots s
       join public.watched_wallets w on w.wallet = s.wallet and w.is_active
      order by s.wallet, s.protocol, s.created_at desc`,
  );
  return rows.map((r) => ({
    wallet: r.wallet,
    protocol: r.protocol,
    collateralSymbol: r.collateral_symbol,
    updatedAt: r.created_at,
  }));
}

/**
 * Which of those a scenario's assets actually touch, so the operator knows what
 * the room is about to see.
 *
 * A position whose collateral symbol was never recorded is returned with a null
 * multiplier rather than 1: "we do not know what this holds" is not the same
 * claim as "this one is unaffected", and the console renders them differently.
 * That is also why such a row is kept in the list instead of filtered out - an
 * operator should see the position they cannot vouch for.
 */
function affectedPositions(
  positions: WatchedPosition[],
  multipliers: Record<string, number>,
): Array<WatchedPosition & { multiplier: number | null }> {
  const byLowerSymbol = new Map(
    Object.entries(multipliers).map(([k, v]) => [k.trim().toLowerCase(), v]),
  );
  return positions
    .map((p) => ({
      ...p,
      multiplier: p.collateralSymbol
        ? (byLowerSymbol.get(p.collateralSymbol.trim().toLowerCase()) ?? 1)
        : null,
    }))
    .filter((p) => p.multiplier === null || p.multiplier !== 1);
}

/**
 * The dashboard tile set: wallets connected, positions monitored, collateral
 * under watch, transaction count and volume. One `admin_metrics()` RPC, so the
 * whole page is a single round trip (server/metricsStore.ts).
 *
 * Behind the same admin gate as the rest. The figures aggregate every watched
 * wallet, which is the shape of PANIK's entire user base; that is an operator
 * fact, not a public one, and no unauthenticated form of this route exists.
 */
async function adminMetrics(req: express.Request, res: express.Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!campaignsConfigured) { res.status(503).json({ error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    res.json(await MetricsStore.fromEnv().fetchMetrics());
  } catch (err) {
    serverError(req, res, 502, err);
  }
}

/**
 * The account roster: every Supabase Auth user, with its membership, the COUNT
 * of wallets it has proven, and whether any of them reaches Telegram.
 *
 * Behind the same admin gate as the rest, and no PII beyond the email — no
 * wallet addresses, no chat ids, no IPs. "How many accounts are in the beta and
 * are they reachable" is an operator question; "which addresses does this
 * person hold" is a different and much more sensitive one, and this route is
 * not the place to answer it.
 *
 * Paginated because GoTrue's admin listing is: ?page=1&perPage=50, capped at
 * ROSTER_PAGE_MAX. It reports no total, so `hasMore` means "the page came back
 * full" rather than an invented count.
 */
async function adminUsers(req: express.Request, res: express.Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!campaignsConfigured) { res.status(503).json({ error: "unconfigured (SUPABASE_*)" }); return; }
  try {
    res.json(
      await AccountStore.fromEnv().listAccounts({
        page: Number(req.query.page ?? 1),
        perPage: Number(req.query.perPage ?? 50),
      }),
    );
  } catch (err) {
    serverError(req, res, 502, err);
  }
}

app.get("/api/admin/users", adminLimit, adminBearerGate, adminUsers);
app.get("/api/admin/metrics", adminLimit, adminBearerGate, adminMetrics);
app.get("/api/admin/campaigns", adminLimit, adminBearerGate, adminCampaigns);
app.post("/api/admin/campaigns", adminLimit, adminBearerGate, adminCampaigns);
app.get("/api/admin/redemptions", adminLimit, adminBearerGate, adminRedemptions);
app.get("/api/admin/simulation", adminLimit, adminBearerGate, adminSimulation);
app.post("/api/admin/simulation", adminLimit, adminBearerGate, adminSimulation);
app.delete("/api/admin/simulation", adminLimit, adminBearerGate, adminSimulation);

app.get("/api/chain", publicLimit, async (req, res) => {
  try {
    const runtime = scoringChains.resolve(req.query.chain);
    res.json({ ...(await getChain(runtime)), chain: scoringChainWire(runtime.config) });
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
    if (p === "/try") return "try.html";
    if (p === "/admin" || p === "/admin-neithan") return "admin.html";
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
