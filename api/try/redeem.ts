/**
 * POST /api/try/redeem   body: { code, honeypot? }
 * Redeems a campaign code and mints the visitor a unique, expiring trial link
 * into the core app. Usage + time limits are enforced ATOMICALLY in SQL
 * (redeem_campaign_code); this handler only captures the client IP/User-Agent
 * for the attempt log and shapes the response.
 *
 * Mirrors api/telegram/link.ts. Fetch-only (Supabase REST), no viem/pg.
 * The dev/Railway Express server exposes the same route (scripts/api-server.ts).
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

// Mirrors isValidEmail in src/panik-try/lib/trialLogic.ts and the
// trial_grants_email_format CHECK - a permissive typo screen, not deliverability.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req: Req, res: Res): Promise<void> {
  const body = (req.body ?? {}) as { code?: string; email?: string; honeypot?: string };
  const code = (body.code ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();

  // Honeypot: real users never fill it; bots do. Silently no-op (no DB write,
  // no code burned), same philosophy as public.waitlist_signup.
  if ((body.honeypot ?? "").trim() !== "") {
    res.status(200).json({ ok: false, outcome: "not_found" });
    return;
  }
  if (!code) {
    res.status(400).json({ ok: false, error: "missing code" });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ ok: false, error: "invalid email" });
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
    const result = await store.redeem(code, email, clientIp(req), userAgent(req.headers));
    if (result.outcome === "success" && result.token) {
      res.status(200).json({ ok: true, outcome: "success", trialUrl: `/app?trial=${result.token}` });
      return;
    }
    res.status(200).json({ ok: false, outcome: result.outcome });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
}
