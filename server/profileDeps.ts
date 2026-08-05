/**
 * Lazily-built, module-scoped profiler dependencies shared by the dev Express
 * server and the Vercel serverless functions. Singletons survive warm
 * invocations so a Vercel function reuses one pg pool / provider set.
 *
 * Lives in server/ (NOT scripts/) so it ships to Vercel — the api/ functions
 * import it. scripts/ is excluded by .vercelignore.
 */

// Import specific modules, NOT the barrel (../packages/scoring/src/index): the
// barrel re-exports the chain adapters → viem → isows → "ws", an optional dep
// esbuild can't resolve, which crashes the Vercel function at load. The cache
// uses Supabase REST (fetch), not `pg`, for the same bundling reason.
import { DuneHistoryProvider } from "../packages/scoring/src/providers/duneHistory";
import { OpenRouterNarrator } from "../packages/scoring/src/providers/narrator";
import type { SessionDeps } from "../packages/scoring/src/classify/profileSession";
import type { StatedProfile } from "../packages/scoring/src/classify/types";
import { RestProfileCache } from "./profileCache";

let deps: SessionDeps | null = null;

/**
 * Build (once) the SessionDeps from env. Throws if a required key is missing —
 * the caller maps that to a 503. OPENROUTER_API_KEY is optional (deterministic
 * fallback prose is used without it). The cache uses the Supabase REST API with
 * the service key (bypasses RLS) — no pg, so it bundles cleanly on Vercel.
 */
export function getProfileDeps(): SessionDeps {
  if (deps) return deps;

  const duneKey = process.env.DUNE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!duneKey) throw new Error("DUNE_API_KEY missing");
  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");

  deps = {
    history: new DuneHistoryProvider(duneKey),
    cache: new RestProfileCache(supabaseUrl, serviceKey),
    narrator: openRouterKey ? new OpenRouterNarrator(openRouterKey) : undefined,
  };
  return deps;
}

/**
 * Supabase TRANSACTION pooler URL (6543) for the dev api-server's own pg pool
 * (the watched_wallets / live-scores loop) — the session pooler (5432) resets
 * from some networks. Pure string logic; no pg import here so the serverless
 * bundle stays pg-free.
 */
export function transactionPoolerUrl(): string {
  const explicit = process.env.SUPABASE_DB_POOL_URL;
  if (explicit) return explicit;
  const base = process.env.SUPABASE_DB_URL as string;
  try {
    const u = new URL(base);
    if (u.port === "5432") u.port = "6543";
    return u.toString();
  } catch {
    return base;
  }
}

/** Validate an EVM address (the only addresses the lending spells cover). */
export function isEvmAddress(wallet: unknown): wallet is string {
  return typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(wallet.trim());
}

/**
 * Validate a Dune execution id before it reaches the results URL. Client-
 * supplied ids are interpolated into `/execution/{id}/results`, so anything
 * outside this alphabet ("../", slashes) would traverse to other Dune
 * endpoints with our API key.
 */
export function isDuneExecutionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(id);
}

/**
 * Validate the onboarding quiz's stated profile before it reaches the reveal.
 * Both the LLM prompt and fallbackCombined read `riskProfile3` unguarded, so a
 * bogus shape (`{}`, a string, an array) becomes a TypeError → 502 instead of
 * the 400 it is.
 */
export function isStatedProfile(value: unknown): value is StatedProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.riskProfile3 !== "conservative" && v.riskProfile3 !== "moderate" && v.riskProfile3 !== "aggressive") {
    return false;
  }
  for (const key of ["riskTier", "segment", "segmentLabel"]) {
    if (v[key] !== undefined && typeof v[key] !== "string") return false;
  }
  return v.riskScore === undefined || Number.isFinite(v.riskScore);
}
