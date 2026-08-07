/**
 * Telegram link store over the Supabase PostgREST API. Pure fetch with the
 * service key (bypasses the deny-all RLS on telegram_links / telegram_link_codes),
 * mirroring server/profileCache.ts. No `pg`, so it bundles cleanly as an
 * ESM Vercel serverless function. Tables: see supabase/migrations.
 *
 * Used by the Vercel functions (api/telegram/link.ts, api/telegram/webhook.ts).
 * The standalone worker reads the same tables via direct pg instead.
 */

export interface LinkCode {
  wallet: string;
  expiresAt: number; // epoch ms
}

export class TelegramStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): TelegramStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new TelegramStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  // ── link codes ────────────────────────────────────────────────────────────

  /** Mint a single-use deep-link code with a TTL. */
  async createLinkCode(code: string, wallet: string, ttlMs: number): Promise<void> {
    const expires = new Date(Date.now() + ttlMs).toISOString();
    const res = await fetch(`${this.base}/rest/v1/telegram_link_codes`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ code, wallet: wallet.toLowerCase(), expires_at: expires }),
    });
    if (!res.ok) throw new Error(`createLinkCode: HTTP ${res.status}`);
  }

  /** Resolve a code to its wallet (or null if missing). Does not check TTL. */
  async getLinkCode(code: string): Promise<LinkCode | null> {
    const url =
      `${this.base}/rest/v1/telegram_link_codes` +
      `?code=eq.${encodeURIComponent(code)}&select=wallet,expires_at&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getLinkCode: HTTP ${res.status}`);
    const rows = (await res.json()) as { wallet: string; expires_at: string }[];
    const row = rows[0];
    if (!row) return null;
    return { wallet: row.wallet, expiresAt: new Date(row.expires_at).getTime() };
  }

  /** Delete a consumed code (single-use). */
  async consumeLinkCode(code: string): Promise<void> {
    await fetch(
      `${this.base}/rest/v1/telegram_link_codes?code=eq.${encodeURIComponent(code)}`,
      { method: "DELETE", headers: this.headers({ Prefer: "return=minimal" }) },
    );
  }

  // ── links ───────────────────────────────────────────────────────────────

  /**
   * Link a wallet to a chat. Because chat_id is unique, first drop any prior
   * row for that chat (the user re-linking the same Telegram to a new wallet),
   * then upsert on the wallet PK.
   */
  async upsertLink(args: { wallet: string; chatId: number; username?: string }): Promise<void> {
    await fetch(
      `${this.base}/rest/v1/telegram_links?chat_id=eq.${args.chatId}`,
      { method: "DELETE", headers: this.headers({ Prefer: "return=minimal" }) },
    );
    const res = await fetch(`${this.base}/rest/v1/telegram_links`, {
      method: "POST",
      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        wallet: args.wallet.toLowerCase(),
        chat_id: args.chatId,
        username: args.username ?? null,
        enabled: true,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`upsertLink: HTTP ${res.status}`);
  }

  /** Current link for a wallet (drives the connect status check), or null. */
  async getLink(
    wallet: string,
  ): Promise<{ chatId: number; username: string | null; enabled: boolean } | null> {
    const url =
      `${this.base}/rest/v1/telegram_links` +
      `?wallet=eq.${encodeURIComponent(wallet.toLowerCase())}&select=chat_id,username,enabled&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getLink: HTTP ${res.status}`);
    const rows = (await res.json()) as { chat_id: number; username: string | null; enabled: boolean }[];
    const row = rows[0];
    return row ? { chatId: row.chat_id, username: row.username, enabled: row.enabled } : null;
  }

  /** Disable alerts for a chat (the /stop command). */
  async disableLink(chatId: number): Promise<void> {
    await fetch(`${this.base}/rest/v1/telegram_links?chat_id=eq.${chatId}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    });
  }
}
