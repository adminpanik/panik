/**
 * Product trial-code store over the Supabase PostgREST API. Pure fetch with the
 * service key (bypasses the deny-all RLS on product_campaigns / trial_grants /
 * redemption_attempts), mirroring server/telegramStore.ts. No `pg`, so it
 * bundles cleanly as an ESM Vercel serverless function AND runs in the dev/
 * Railway Express server unchanged.
 *
 * - Redemption + app-open call the SECURITY DEFINER RPCs (atomic check + log).
 * - Admin CRUD (create / list / expire) hits the table REST API directly.
 *
 * Tables + functions: see supabase/migrations/20260704000001_product_codes.sql.
 * Used by api/try/access.ts, api/admin/campaigns.ts, the account redeem flow,
 * and the mirrored routes in scripts/api-server.ts.
 */

import { randomInt } from "node:crypto";

/** Unambiguous alphabet (no 0/1/I/O) - matches gen_panik_suffix in SQL. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Suffix length. Codes are a bearer secret for a free trial, so the keyspace
 * has to survive guessing: 8 chars over 32 symbols is 2^40, vs the ~1M of the
 * original 4.
 */
const CODE_SUFFIX_LEN = 8;

/** Random N-char suffix from the unambiguous alphabet (CSPRNG, unbiased). */
function randomSuffix(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * PostgREST error bodies quote the failing SQL and, on an auth failure, the
 * project ref — they belong in the server log, never in a thrown message that
 * an unauthenticated route might echo back (e.g. /api/try/access).
 */
async function logErrorBody(scope: string, res: { status: number; text(): Promise<string> }): Promise<void> {
  const body = await res.text().catch(() => "");
  console.error(`${scope}: HTTP ${res.status} ${body.slice(0, 300)}`);
}

export type RedeemOutcome = "success" | "not_found" | "disabled" | "expired" | "exhausted";
export interface RedeemResult {
  outcome: RedeemOutcome;
  token?: string;
}

export type OpenOutcome = "active" | "expired" | "invalid";
export interface OpenResult {
  outcome: OpenOutcome;
  expiresAt?: string;
}

export interface Campaign {
  id: string;
  campaign_code: string;
  label: string | null;
  max_redemptions: number;
  redemption_count: number;
  trial_duration_hours: number;
  claim_window_expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignInput {
  label?: string | null;
  maxRedemptions: number;
  trialDurationHours: number;
  /** ISO timestamp for the claim cutoff, or null for no campaign-level deadline. */
  claimWindowExpiresAt?: string | null;
}

/** One redeemed grant (one user), flattened with its campaign code for the admin roster. */
export interface TrialGrant {
  email: string | null;
  campaign_code: string | null;
  campaign_label: string | null;
  first_opened_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * One successful redemption of a single campaign, with the capture metadata.
 *
 * `claim_ip` and `claim_user_agent` are PERSONAL DATA. They exist so the
 * operator can tell a real scan from a bot sweep, and they leave the database
 * only through the admin-gated, rate-limited redemptions route. `access_token`
 * is deliberately absent: it is a bearer credential for the trial itself, and
 * a roster is not a reason to move one.
 */
export interface CampaignRedemption {
  email: string | null;
  claim_ip: string | null;
  claim_user_agent: string | null;
  first_opened_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * One attempt against a campaign code, successful or not. The failures are the
 * point: a wall of `exhausted` says the print run was too small, and a wall of
 * `not_found` from one address says somebody is guessing codes.
 */
export interface RedemptionAttempt {
  outcome: RedeemOutcome;
  ip: string | null;
  user_agent: string | null;
  /** Whether this attempt actually minted a trial token. */
  granted: boolean;
  created_at: string;
}

/** Hard ceiling on rows either redemption read can return. */
const REDEMPTION_PAGE_MAX = 500;

/** Clamp a caller-supplied page size into [1, REDEMPTION_PAGE_MAX]. */
function pageSize(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 200;
  return Math.min(Math.floor(requested), REDEMPTION_PAGE_MAX);
}

export class CampaignStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): CampaignStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new CampaignStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    // Strip null/undefined params: PostgREST can't resolve JSON null to typed
    // PostgreSQL text params (42883 "no function matches"). Omitting them lets
    // the function's DEFAULT NULL kick in instead.
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== null && v !== undefined) clean[k] = v;
    }
    const res = await fetch(`${this.base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(clean),
    });
    if (!res.ok) {
      await logErrorBody(fn, res);
      throw new Error(`${fn}: HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── redemption (public /try flow) ─────────────────────────────────────────

  /**
   * Attempt a redemption; atomic + logged in SQL. Never over-decrements.
   * `email` is captured on the minted grant (the /try flow requires it) so the
   * roster reflects who redeemed each card.
   *
   * IDEMPOTENT PER (campaign, email) since
   * supabase/migrations/20260831000001_idempotent_campaign_redeem.sql: calling
   * it again with an address that already holds a grant on this campaign
   * returns that grant's token, mints nothing and spends no slot. Passing no
   * email opts out of that, because there is then nobody to be idempotent
   * about; the /try flow requires one and the account flow supplies the
   * verified address, so in practice every caller is covered.
   */
  async redeem(
    code: string,
    email?: string | null,
    ip?: string | null,
    ua?: string | null,
  ): Promise<RedeemResult> {
    const args: Record<string, unknown> = { p_code: code };
    if (email) args.p_email = email;
    if (ip) args.p_ip = ip;
    if (ua) args.p_ua = ua;
    const out = (await this.rpc("redeem_campaign_code", args)) as RedeemResult;
    return out;
  }

  /** Resolve a per-user token on app open; starts the clock on first open. */
  async openTrial(token: string, ip?: string | null, ua?: string | null): Promise<OpenResult> {
    const args: Record<string, unknown> = { p_token: token };
    if (ip) args.p_ip = ip;
    if (ua) args.p_ua = ua;
    const out = (await this.rpc("open_trial", args)) as OpenResult;
    return out;
  }

  // ── admin CRUD ────────────────────────────────────────────────────────────

  /**
   * Create a campaign with a freshly generated PANIK-TRY-XXXXXXXX code (the SQL
   * CHECK accepts 4-8 suffix chars, so widening needs no migration). Retries on
   * the unique-code collision (409) a few times before giving up.
   */
  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const campaign_code = `PANIK-TRY-${randomSuffix(CODE_SUFFIX_LEN)}`;
      const res = await fetch(`${this.base}/rest/v1/product_campaigns`, {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({
          campaign_code,
          label: input.label ?? null,
          max_redemptions: input.maxRedemptions,
          trial_duration_hours: input.trialDurationHours,
          claim_window_expires_at: input.claimWindowExpiresAt ?? null,
        }),
      });
      if (res.status === 409) continue; // code collision - regenerate
      if (!res.ok) {
        await logErrorBody("createCampaign", res);
        throw new Error(`createCampaign: HTTP ${res.status}`);
      }
      const rows = (await res.json()) as Campaign[];
      return rows[0]!;
    }
    throw new Error("createCampaign: could not allocate a unique code");
  }

  /**
   * Every redeemed grant (one row per user), newest first, with its campaign
   * code/label embedded. This is the "how many users + their email" roster for
   * the admin console. Uses PostgREST FK embedding on campaign_id.
   */
  async listGrants(): Promise<TrialGrant[]> {
    const select =
      "email,first_opened_at,expires_at,created_at,product_campaigns(campaign_code,label)";
    const res = await fetch(
      `${this.base}/rest/v1/trial_grants?select=${encodeURIComponent(select)}&order=created_at.desc`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      await logErrorBody("listGrants", res);
      throw new Error(`listGrants: HTTP ${res.status}`);
    }
    type Row = {
      email: string | null;
      first_opened_at: string | null;
      expires_at: string | null;
      created_at: string;
      product_campaigns: { campaign_code: string | null; label: string | null } | null;
    };
    const rows = (await res.json()) as Row[];
    return rows.map((r) => ({
      email: r.email,
      campaign_code: r.product_campaigns?.campaign_code ?? null,
      campaign_label: r.product_campaigns?.label ?? null,
      first_opened_at: r.first_opened_at,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }

  /**
   * Who redeemed ONE campaign, newest first. Filtered with a PostgREST inner
   * embed on the FK so the code -> id lookup and the row read are one round
   * trip rather than two.
   */
  async listRedemptions(code: string, limit = 200): Promise<CampaignRedemption[]> {
    const select =
      "email,claim_ip,claim_user_agent,first_opened_at,expires_at,created_at,product_campaigns!inner(campaign_code)";
    const url =
      `${this.base}/rest/v1/trial_grants?select=${encodeURIComponent(select)}` +
      `&product_campaigns.campaign_code=eq.${encodeURIComponent(code)}` +
      `&order=created_at.desc&limit=${pageSize(limit)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("listRedemptions", res);
      throw new Error(`listRedemptions: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as (CampaignRedemption & { product_campaigns?: unknown })[];
    return rows.map((r) => ({
      email: r.email,
      claim_ip: r.claim_ip,
      claim_user_agent: r.claim_user_agent,
      first_opened_at: r.first_opened_at,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }

  /** Every attempt against ONE campaign code, newest first, failures included. */
  async listAttempts(code: string, limit = 200): Promise<RedemptionAttempt[]> {
    const url =
      `${this.base}/rest/v1/redemption_attempts?select=outcome,ip,user_agent,granted_token_id,created_at` +
      `&campaign_code=eq.${encodeURIComponent(code)}` +
      `&order=created_at.desc&limit=${pageSize(limit)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("listAttempts", res);
      throw new Error(`listAttempts: HTTP ${res.status}`);
    }
    type Row = {
      outcome: RedeemOutcome;
      ip: string | null;
      user_agent: string | null;
      granted_token_id: string | null;
      created_at: string;
    };
    const rows = (await res.json()) as Row[];
    return rows.map((r) => ({
      outcome: r.outcome,
      ip: r.ip,
      user_agent: r.user_agent,
      granted: r.granted_token_id !== null,
      created_at: r.created_at,
    }));
  }

  /** All campaigns, newest first (admin table). */
  async listCampaigns(): Promise<Campaign[]> {
    const res = await fetch(
      `${this.base}/rest/v1/product_campaigns?select=*&order=created_at.desc`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`listCampaigns: HTTP ${res.status}`);
    return (await res.json()) as Campaign[];
  }

  /** Manually expire (disable) a campaign early. Returns the updated row or null. */
  async expireCampaign(id: string): Promise<Campaign | null> {
    const res = await fetch(
      `${this.base}/rest/v1/product_campaigns?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({ is_active: false }),
      },
    );
    if (!res.ok) throw new Error(`expireCampaign: HTTP ${res.status}`);
    const rows = (await res.json()) as Campaign[];
    return rows[0] ?? null;
  }
}
