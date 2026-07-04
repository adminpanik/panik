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
 * Used by api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts and the
 * mirrored routes in scripts/api-server.ts.
 */

/** Unambiguous alphabet (no 0/1/I/O) - matches gen_panik_suffix in SQL. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Random N-char suffix from the unambiguous alphabet. */
function randomSuffix(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
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
    const res = await fetch(`${this.base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }

  // ── redemption (public /try flow) ─────────────────────────────────────────

  /** Attempt a redemption; atomic + logged in SQL. Never over-decrements. */
  async redeem(code: string, ip?: string | null, ua?: string | null): Promise<RedeemResult> {
    const out = (await this.rpc("redeem_campaign_code", {
      p_code: code,
      p_ip: ip ?? null,
      p_ua: ua ?? null,
    })) as RedeemResult;
    return out;
  }

  /** Resolve a per-user token on app open; starts the clock on first open. */
  async openTrial(token: string, ip?: string | null, ua?: string | null): Promise<OpenResult> {
    const out = (await this.rpc("open_trial", {
      p_token: token,
      p_ip: ip ?? null,
      p_ua: ua ?? null,
    })) as OpenResult;
    return out;
  }

  // ── admin CRUD ────────────────────────────────────────────────────────────

  /**
   * Create a campaign with a freshly generated PANIK-TRY-XXXX code. Retries on
   * the unique-code collision (409) a few times before giving up.
   */
  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const campaign_code = `PANIK-TRY-${randomSuffix(4)}`;
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
      if (!res.ok) throw new Error(`createCampaign: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const rows = (await res.json()) as Campaign[];
      return rows[0]!;
    }
    throw new Error("createCampaign: could not allocate a unique code");
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
