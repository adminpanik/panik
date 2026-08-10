/**
 * GET /api/telegram/status?wallet=0x...
 *
 * Returns the THREE distinct facts about a Telegram link, because they are
 * three different things and reporting one number for all of them was a lie the
 * UI repeated (Phase 4.B, see server/telegramReach.ts):
 *
 *   linked       a link row exists — the user did the setup
 *   subscribed   `enabled` — they have not sent /stop and the bot is not 403'd
 *   reachability "reachable" | "unreachable" | "unverified" — whether delivery
 *                has actually been PROVEN recently
 *
 * `linked` in the RESPONSE is `alertsDeliverable`, not the raw row existence:
 * the field already drove a "connected, you will be alerted" claim, and the
 * honest version of that claim is "a link exists AND we have no evidence the
 * bot is blocked". That is strictly stronger than the `enabled` bit it
 * replaces, so no caller gets a weaker guarantee. The three raw states ship
 * alongside it so a surface can say "unverified since <date>" instead of
 * picking a side.
 *
 * The captured @username is deliberately NOT returned: unauthenticated, that
 * made this a wallet -> Telegram handle oracle for the whole user base. The
 * reachability timestamps are safe by the same test — they say nothing about
 * WHO the Telegram account is.
 *
 * Fetch-only (Supabase REST), no viem/pg. Mirrors the route in
 * scripts/api-server.ts (the Railway production backend).
 */

import { isEvmAddress } from "../../server/profileDeps";
import { TelegramStore } from "../../server/telegramStore";
import { linkState } from "../../server/telegramReach";

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
    const state = linkState(await store.getLinkState(wallet), Date.now());
    res.status(200).json({
      linked: state.alertsDeliverable,
      link: {
        linked: state.linked,
        subscribed: state.subscribed,
        reachability: state.reachability,
        reachableAt: state.reachableAt,
        unreachableSince: state.unreachableSince,
        alertsDeliverable: state.alertsDeliverable,
      },
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
