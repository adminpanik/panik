/**
 * POST /api/try/access   body: { token }
 * Validates a per-user trial token when the core app loads with ?trial=TOKEN.
 * On the FIRST successful open, open_trial starts the per-user clock and sets
 * expires_at = now + trial_duration_hours. Returns the resolved status.
 *
 * Mirrors api/telegram/link.ts. Fetch-only (Supabase REST), no viem/pg.
 */

import { CampaignStore } from "../../server/campaignStore";
import { clientIp, userAgent } from "../../server/clientIp";

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res { status(code: number): Res; json(body: unknown): void }

export default async function handler(req: Req, res: Res): Promise<void> {
  const body = (req.body ?? {}) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) {
    res.status(400).json({ ok: false, error: "missing token" });
    return;
  }

  let store: CampaignStore;
  try {
    store = CampaignStore.fromEnv();
  } catch (err) {
    res.status(503).json({ ok: false, error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    const result = await store.openTrial(token, clientIp(req.headers), userAgent(req.headers));
    res.status(200).json({ ok: result.outcome === "active", outcome: result.outcome, expiresAt: result.expiresAt ?? null });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
}
