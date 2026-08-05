/**
 * GET /api/telegram/status?wallet=0x...
 * Returns ONLY whether the wallet has an enabled Telegram link. The browser
 * polls this after Connect to auto-confirm, and on load to show an existing
 * link. Fetch-only (Supabase REST), no viem/pg.
 *
 * The captured @username is deliberately NOT returned: unauthenticated, that
 * made this a wallet -> Telegram handle oracle for the whole user base.
 * Mirrors the route in scripts/api-server.ts (the Railway production backend).
 */

import { isEvmAddress } from "../../server/profileDeps";
import { TelegramStore } from "../../server/telegramStore";

interface Req { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }
interface Res { status(code: number): Res; json(body: unknown): void }

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const wallet = (pick(req.query.wallet) ?? "").trim().toLowerCase();
  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  let store: TelegramStore;
  try {
    store = TelegramStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `telegram unconfigured: ${(err as Error).message}` });
    return;
  }
  try {
    const link = await store.getLink(wallet);
    res.status(200).json({ linked: Boolean(link?.enabled) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
