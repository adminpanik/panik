/**
 * /api/admin/redemptions   (Authorization: Bearer <supabase jwt>, or x-admin-key)
 *   GET   ?code=PANIK-TRY-XXXXXXXX   who redeemed one campaign, plus every
 *                                     attempt against it
 *   POST  ?action=clear               { code, email } -> delete that person's
 *                                     grant so they can redeem this code again
 *
 * The GET returns personal data (claim IP + user agent) and the POST hands a
 * spent voucher back, so both are admin-gated like the rest. The clear-use
 * decision and its audit line live in server/adminCampaigns.ts, which the
 * Express mirror in scripts/api-server.ts calls identically.
 *
 * Like the rest of api/, this file is vercelignored and serves no traffic; it
 * is kept compiling and consistent with the Express side.
 */

import { CLEAR_USE_REFUSAL, clearRedemptionUse } from "../../server/adminCampaigns";
import { CampaignStore } from "../../server/campaignStore";
import { authorizeAdminRequest, type AdminReqHeaders } from "../../server/adminGate";

interface Req {
  method?: string;
  headers: AdminReqHeaders;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res { status(code: number): Res; json(body: unknown): void }

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const verdict = await authorizeAdminRequest(req.headers);
  if (!verdict.ok) { res.status(verdict.status).json(verdict.body); return; }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let store: CampaignStore;
  try {
    store = CampaignStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    if (method === "POST") {
      if (pick(req.query.action) !== "clear") {
        res.status(400).json({ error: "unknown action" });
        return;
      }
      const body = (req.body ?? {}) as { code?: unknown; email?: unknown };
      // `verdict.email` is the signed-in operator when a bearer was presented,
      // and undefined on the shared-secret path, which has no name to record.
      const result = await clearRedemptionUse(store, {
        code: body.code,
        email: body.email,
        actor: verdict.email ?? null,
      });
      if (result.outcome === "cleared") {
        res.status(200).json({ cleared: result.cleared });
        return;
      }
      const refusal = CLEAR_USE_REFUSAL[result.outcome];
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }

    // Same normalization the SQL applies (upper(btrim(...))), so a code copied
    // from a printed card with stray case or spaces still resolves.
    const code = (pick(req.query.code) ?? "").trim().toUpperCase();
    if (!code) { res.status(400).json({ error: "missing code" }); return; }
    const [redemptions, attempts] = await Promise.all([
      store.listRedemptions(code),
      store.listAttempts(code),
    ]);
    res.status(200).json({ code, redemptions, attempts });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
