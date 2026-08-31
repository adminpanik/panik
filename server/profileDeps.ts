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

/**
 * Everything that takes up no room in a pasted address: ordinary whitespace,
 * the non-breaking space, the soft hyphen, and the zero-width and bidi-format
 * characters a copy out of a PDF or a rich-text document can carry. All of it
 * is DELETED, internally as well as at the ends, because `.trim()` alone stops
 * at the outer edges and an address pasted with one of these in the middle
 * otherwise fails a format check with nothing for the reader to see wrong.
 * Same character class as `VOUCHER_BLANKS` in `server/accounts.ts`, applied
 * here to addresses instead of voucher codes.
 *
 * TWIN: `ADDRESS_INVISIBLES` in `src/panik-core/lib/telegram.ts` (client) and
 * `src/panik-landing-page/lib/waitlist.ts` (landing copy) is a
 * character-for-character copy and must stay one. The `isEvmAddress` test
 * below asserts all three agree on every case, so they cannot drift apart
 * silently.
 */
const ADDRESS_INVISIBLES = /[\s\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/** Strip the characters above. */
export const stripAddressInvisibles = (a: string): string => a.replace(ADDRESS_INVISIBLES, "");

/** Validate an EVM address (the only addresses the lending spells cover). */
export function isEvmAddress(wallet: unknown): wallet is string {
  return typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(stripAddressInvisibles(wallet));
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

/** Longest accepted free-text field on the stated profile (quiz values are ~30). */
const STATED_TEXT_MAX = 64;
/** Raw quiz score range — see StatedProfile.riskScore (0–18). */
const RISK_SCORE_MIN = 0;
const RISK_SCORE_MAX = 18;
const STATED_TEXT_KEYS = ["riskTier", "segment", "segmentLabel"] as const;
const STATED_KEYS = new Set<string>(["riskProfile3", "riskScore", ...STATED_TEXT_KEYS]);

/**
 * Validate the onboarding quiz's stated profile before it reaches the reveal.
 *
 * This is a VALUE guard, not just a shape guard, because the object is
 * JSON.stringify'd straight into the LLM user message (see
 * packages/scoring/src/providers/narrator.ts) and the completion is rendered
 * back to the user as their persona. So an unbounded string here is both a
 * prompt injection into a prompt whose output the user reads, and a token bill:
 * ~100 kB of "segmentLabel" is ~25k tokens per request. Hence: only known keys,
 * every string capped, and riskScore clamped to its real range rather than
 * merely finite. Rejects (400) instead of truncating — a value this far outside
 * the quiz's own outputs is not a user typo.
 */
export function isStatedProfile(value: unknown): value is StatedProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!STATED_KEYS.has(key)) return false; // unknown keys ride into the prompt too
  }
  if (v.riskProfile3 !== "conservative" && v.riskProfile3 !== "moderate" && v.riskProfile3 !== "aggressive") {
    return false;
  }
  for (const key of STATED_TEXT_KEYS) {
    const field = v[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || field.length > STATED_TEXT_MAX) return false;
  }
  if (v.riskScore === undefined) return true;
  return typeof v.riskScore === "number" && v.riskScore >= RISK_SCORE_MIN && v.riskScore <= RISK_SCORE_MAX;
}
