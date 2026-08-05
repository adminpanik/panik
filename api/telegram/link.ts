/**
 * POST /api/telegram/link  {message, signature}
 * Mints a single-use deep-link code for the wallet named by the SIWE proof and
 * returns the t.me deep link the user opens to connect their Telegram. The user
 * pressing Start fires /api/telegram/webhook, which resolves the code to the
 * wallet.
 *
 * This response HANDS the caller a code that redirects a wallet's liquidation
 * alerts to whoever opens it. That is why the proof must be single-use and
 * action-bound (server/walletAuth.ts): a replayable proof does not merely reuse
 * an old code, it mints a NEW one for the victim's wallet and gives it to the
 * replayer.
 *
 * WHICH HANDLER SERVES PRODUCTION: not this one. `.vercelignore` excludes
 * `api/` from the deployment upload, so no Vercel function exists to shadow the
 * `vercel.json` rewrite and every /api/* request lands on the Railway Express
 * server (scripts/api-server.ts) — verified against panik.fi, whose /api
 * responses carry Railway's `x-railway-request-id` / `x-railway-edge` headers.
 * These files remain a deliberate fallback, so they get the SAME method guard,
 * rate limit, and ownership check as their Express twins; a fallback that is
 * weaker than the primary is just a slower way to get breached.
 *
 * Supabase REST only (no pg); viem rides in via the ownership check.
 * Mirrors scripts/api-server.ts. See docs/technical-docs/TELEGRAM_ALERTS.md.
 */

import { randomUUID } from "node:crypto";
import { clientIp } from "../../server/clientIp";
import { keyedRateLimit } from "../../server/rateLimit";
import { TelegramStore } from "../../server/telegramStore";
import { verifyWalletOwnership } from "../../server/walletAuth";

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

/** Codes live 15 minutes. */
const CODE_TTL_MS = 15 * 60 * 1000;

/** Matches `strictLimit` in scripts/api-server.ts: this mints state. */
const limit = keyedRateLimit({ limit: 10 });

export default async function handler(req: Req, res: Res): Promise<void> {
  // Body only: a ?wallet query param carries no proof, and letting it through
  // would leave the pre-fix hijack reachable via GET.
  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const decision = limit.hit(clientIp(req.headers ?? {}) ?? "unknown");
  if (!decision.ok) {
    res.setHeader?.("Retry-After", String(decision.retryAfterSec));
    res.status(429).json({ error: "rate limit exceeded", retryAfterSec: decision.retryAfterSec });
    return;
  }

  const proof = await verifyWalletOwnership(req.body, "telegram-link");
  if (!proof.ok) {
    res.status(proof.status).json({ error: proof.error });
    return;
  }
  const wallet = proof.wallet;

  const botUsername = process.env.VITE_TELEGRAM_BOT_USERNAME;
  if (!botUsername) {
    res.status(503).json({ error: "telegram unconfigured (VITE_TELEGRAM_BOT_USERNAME)" });
    return;
  }

  let store: TelegramStore;
  try {
    store = TelegramStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `telegram unconfigured: ${(err as Error).message}` });
    return;
  }

  // url-safe, single-use; randomUUID is 122 bits of entropy.
  const code = randomUUID().replace(/-/g, "");
  try {
    await store.createLinkCode(code, wallet, CODE_TTL_MS);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  res.status(200).json({
    code,
    botUsername,
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresInSec: CODE_TTL_MS / 1000,
  });
}
