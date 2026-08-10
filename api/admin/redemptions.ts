/**
 * /api/admin/redemptions?code=PANIK-TRY-XXXXXXXX
 *   GET   who redeemed one campaign, plus every attempt against it
 *
 * Returns personal data (claim IP + user agent), so it is admin-gated like the
 * rest and nothing here is logged. Mirrored by the Express route in
 * scripts/api-server.ts; that one is what serves traffic.
 */

import { CampaignStore } from "../../server/campaignStore";
import { authorizeAdminRequest, type AdminReqHeaders } from "../../server/adminGate";

interface Req {
  method?: string;
  headers: AdminReqHeaders;
  query: Record<string, string | string[] | undefined>;
}
interface Res { status(code: number): Res; json(body: unknown): void }

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const verdict = await authorizeAdminRequest(req.headers);
  if (!verdict.ok) { res.status(verdict.status).json(verdict.body); return; }

  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Same normalization the SQL applies (upper(btrim(...))), so a code copied
  // from a printed card with stray case or spaces still resolves.
  const code = (pick(req.query.code) ?? "").trim().toUpperCase();
  if (!code) { res.status(400).json({ error: "missing code" }); return; }

  let store: CampaignStore;
  try {
    store = CampaignStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    const [redemptions, attempts] = await Promise.all([
      store.listRedemptions(code),
      store.listAttempts(code),
    ]);
    res.status(200).json({ code, redemptions, attempts });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
