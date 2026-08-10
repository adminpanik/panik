/**
 * Telegram link store over the Supabase PostgREST API. Pure fetch with the
 * service key (bypasses the deny-all RLS on telegram_links / telegram_link_codes),
 * mirroring server/profileCache.ts. No `pg`, so it bundles cleanly as an
 * ESM Vercel serverless function. Tables: see supabase/migrations.
 *
 * Used by the Vercel functions (api/telegram/link.ts, api/telegram/webhook.ts).
 * The standalone worker reads the same tables via direct pg instead.
 */

import type { TelegramLinkRow } from "./telegramReach";

export interface LinkCode {
  wallet: string;
  expiresAt: number; // epoch ms
}

/** The reachability columns as PostgREST returns them. */
interface RawLinkRow {
  chat_id: number;
  enabled: boolean;
  last_delivered_at: string | null;
  last_probe_at: string | null;
  last_probe_ok: boolean | null;
  unreachable_since: string | null;
}

const ms = (iso: string | null): number | null => (iso ? new Date(iso).getTime() : null);

function decodeLinkRow(r: RawLinkRow): TelegramLinkRow {
  return {
    chatId: r.chat_id,
    enabled: r.enabled,
    lastDeliveredAt: ms(r.last_delivered_at),
    lastProbeAt: ms(r.last_probe_at),
    lastProbeOk: r.last_probe_ok,
    unreachableSince: ms(r.unreachable_since),
  };
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
   *
   * EVERY bind is logged, not just rebinds. Logging only `prior.chatId !==
   * chatId` was blind to the likeliest attack: a victim who never linked has
   * no prior row, so the hijack that captures their alerts first is exactly
   * the one that left no trace. A failed lookup is logged as UNKNOWN rather
   * than swallowed into "looks like a first link" — a silently-degraded audit
   * signal is worse than none, because it reads as an all-clear.
   */
  async upsertLink(args: { wallet: string; chatId: number; username?: string }): Promise<void> {
    const wallet = args.wallet.toLowerCase();
    let prior: { chatId: number; username: string | null; enabled: boolean } | null = null;
    let priorKnown = true;
    try {
      prior = await this.getLink(wallet);
    } catch (err) {
      priorKnown = false;
      console.error(`telegram link precheck failed for wallet=${wallet}: ${(err as Error).message}`);
    }
    if (!priorKnown) {
      console.warn(`telegram link bound (PRIOR STATE UNKNOWN): wallet=${wallet} chat=${args.chatId}`);
    } else if (!prior) {
      console.warn(`telegram link bound (first link): wallet=${wallet} chat=${args.chatId}`);
    } else if (prior.chatId !== args.chatId) {
      // The fingerprint of an alert takeover: the victim silently stops
      // receiving liquidation warnings. Legitimate re-links hit it too — a
      // signal to grep, not an error — so log it and continue.
      console.warn(`telegram link rebound: wallet=${wallet} chat ${prior.chatId} -> ${args.chatId}`);
    }
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

  /**
   * The link WITH its reachability evidence — what `linkState` needs to tell
   * linked from subscribed from reachable (server/telegramReach.ts).
   *
   * Separate from `getLink` rather than replacing it because `enabled` alone is
   * still the right answer for the dispatcher's join, and widening every caller
   * to carry four timestamps it does not read would be noise.
   */
  async getLinkState(wallet: string): Promise<TelegramLinkRow | null> {
    const url =
      `${this.base}/rest/v1/telegram_links` +
      `?wallet=eq.${encodeURIComponent(wallet.toLowerCase())}` +
      `&select=chat_id,enabled,last_delivered_at,last_probe_at,last_probe_ok,unreachable_since&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getLinkState: HTTP ${res.status}`);
    const rows = (await res.json()) as RawLinkRow[];
    const row = rows[0];
    return row ? decodeLinkRow(row) : null;
  }

  /**
   * Stamp the outcome of a delivery or a probe.
   *
   * `unreachableSince` is written ONLY on a 403 and cleared on any success, so
   * the column means "Telegram told us we are blocked", never "we guessed".
   */
  async recordReachability(
    chatId: number,
    outcome: { kind: "delivered" | "probe"; ok: boolean; blocked: boolean; at: number },
  ): Promise<void> {
    const stamp = new Date(outcome.at).toISOString();
    const body: Record<string, unknown> = { updated_at: stamp };
    if (outcome.kind === "delivered" && outcome.ok) body.last_delivered_at = stamp;
    if (outcome.kind === "probe") {
      body.last_probe_at = stamp;
      body.last_probe_ok = outcome.ok;
    }
    if (outcome.blocked) {
      body.unreachable_since = stamp;
      body.enabled = false;
    } else if (outcome.ok) {
      body.unreachable_since = null;
    }
    const res = await fetch(`${this.base}/rest/v1/telegram_links?chat_id=eq.${chatId}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`recordReachability: HTTP ${res.status}`);
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
