/**
 * Server-issued single-use nonces for the wallet-ownership proof.
 *
 * The nonce is the whole point of the proof being unforgeable-offline and
 * unreplayable: it is minted here, embedded in the SIWE message the wallet
 * signs, and DESTROYED the first time a signature carrying it is accepted.
 *
 * Deliberately NOT a "seen signature" cache. ECDSA signatures are malleable
 * (s -> n-s with a flipped v recovers the same signer), so a byte-level dedupe
 * of signatures is trivially bypassed. Dedupe the thing WE issued instead.
 *
 * Storage is the Supabase REST API with the service key (deny-all RLS), same
 * transport as server/telegramStore.ts — one implementation serves both the
 * Railway Express server and the Vercel functions, and neither needs `pg`.
 */

import { generateSiweNonce } from "viem/siwe";

/** How long an unredeemed nonce stays usable. This IS the proof's lifetime. */
export const AUTH_NONCE_TTL_MS = 5 * 60 * 1000;

export interface IssuedNonce {
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface NonceStore {
  /** Mint a fresh nonce with the standard TTL. */
  issue(): Promise<IssuedNonce>;
  /**
   * Atomically redeem `nonce`. Resolves true for the FIRST caller only;
   * false if it is unknown, already consumed, or expired. Never throws for a
   * simple miss — only for a transport failure (caller maps that to 502).
   */
  consume(nonce: string): Promise<boolean>;
}

/** Shape the API returns for GET /api/auth/nonce. */
export interface NonceResponse {
  nonce: string;
  expiresInSec: number;
}

export class SupabaseNonceStore implements NonceStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): SupabaseNonceStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SupabaseNonceStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async issue(): Promise<IssuedNonce> {
    // viem's generator: 96 alphanumeric chars, crypto-random, and already in
    // the shape EIP-4361 demands (^[a-zA-Z0-9]{8,}$).
    const nonce = generateSiweNonce();
    const expiresAt = Date.now() + AUTH_NONCE_TTL_MS;
    const res = await fetch(`${this.base}/rest/v1/auth_nonces`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ nonce, expires_at: new Date(expiresAt).toISOString() }),
    });
    if (!res.ok) throw new Error(`issueNonce: HTTP ${res.status}`);
    return { nonce, expiresAt };
  }

  async consume(nonce: string): Promise<boolean> {
    // Cheap shape gate so a garbage value never reaches PostgREST as a filter.
    if (!/^[a-zA-Z0-9]{16,128}$/.test(nonce)) return false;
    // DELETE ... RETURNING, expressed as PostgREST's return=representation.
    // The expires_at filter makes expiry part of the same atomic statement, so
    // a nonce cannot be redeemed a microsecond after it lapses. Postgres locks
    // the row: of two concurrent deletes exactly one gets a row back.
    const url =
      `${this.base}/rest/v1/auth_nonces` +
      `?nonce=eq.${encodeURIComponent(nonce)}` +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: this.headers({ Prefer: "return=representation" }),
    });
    if (!res.ok) throw new Error(`consumeNonce: HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) && rows.length === 1;
  }
}
