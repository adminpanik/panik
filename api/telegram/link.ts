/**
 * POST /api/telegram/link  {wallet, signature, timestamp}
 * Mints a single-use deep-link code for the wallet and returns the t.me deep
 * link the user opens to connect their Telegram. The user pressing Start fires
 * /api/telegram/webhook, which resolves the code to the wallet.
 *
 * The code redirects a wallet's liquidation alerts to whoever opens the deep
 * link, so the caller must PROVE the wallet is theirs (server/walletAuth.ts).
 *
 * Supabase REST only (no pg); viem rides in via the ownership check.
 * Mirrors scripts/api-server.ts. See docs/technical-docs/TELEGRAM_ALERTS.md.
 */

import { randomUUID } from "node:crypto";
import { TelegramStore } from "../../server/telegramStore";
import { verifyWalletOwnership } from "../../server/walletAuth";

interface Req { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }
interface Res { status(code: number): Res; json(body: unknown): void }

/** Codes live 15 minutes. */
const CODE_TTL_MS = 15 * 60 * 1000;

export default async function handler(req: Req, res: Res): Promise<void> {
  // Body only: a ?wallet query param carries no proof, and letting it through
  // would leave the pre-fix hijack reachable via GET.
  const proof = await verifyWalletOwnership(req.body);
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
