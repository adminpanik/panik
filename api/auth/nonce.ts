/**
 * GET /api/auth/nonce -> {nonce, expiresInSec}
 *
 * Hands out the single-use value that must appear in the SIWE message any
 * wallet-scoped write is signed over (server/walletAuth.ts). It is the reason
 * the proof cannot be produced offline by a hostile page, and — because
 * verification CONSUMES it atomically — the reason a captured proof cannot be
 * replayed to mint a fresh Telegram deep-link code for someone else's wallet.
 *
 * Public and unauthenticated by design: a nonce is worthless on its own (it
 * authorizes nothing until a wallet signs a message containing it). Rate-limited
 * anyway so it cannot be used to bulk-insert rows.
 *
 * Mirrors the route in scripts/api-server.ts (the Railway production backend);
 * see the note in api/telegram/link.ts about which one actually serves prod.
 */

import { AUTH_NONCE_TTL_MS, SupabaseNonceStore } from "../../server/nonceStore";
import { denyRequest, keyedRateLimit } from "../../server/rateLimit";

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader?(name: string, value: string): void;
}

// Isolate-local (see server/rateLimit.ts): a brake on the obvious burst, not a
// guarantee. Matches `strictLimit` in scripts/api-server.ts — every call mints
// a nonce row, and a fallback looser than the primary is just a slower way in.
const limit = keyedRateLimit({ limit: 10 });

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const denied = denyRequest(limit, req);
  if (denied) {
    res.setHeader?.("Retry-After", String(denied.retryAfterSec));
    res.status(denied.status).json({ error: denied.error, retryAfterSec: denied.retryAfterSec });
    return;
  }

  let store: SupabaseNonceStore;
  try {
    store = SupabaseNonceStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `sign-in unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    const { nonce } = await store.issue();
    res.status(200).json({ nonce, expiresInSec: AUTH_NONCE_TTL_MS / 1000 });
  } catch (err) {
    console.error(`GET /api/auth/nonce -> 502: ${(err as Error).message}`);
    res.status(502).json({ error: "could not issue a sign-in nonce" });
  }
}
