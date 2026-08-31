/**
 * /api/admin/campaigns   (x-admin-key: ADMIN_ACCESS_KEY)
 *   GET                       list all campaigns (newest first)
 *   GET  ?view=emails         redeemed-user roster (count + emails)
 *   POST                      create { label?, trialDays, maxRedemptions, claimWindowDays? }
 *   POST ?action=expire       disable early { id }
 *
 * Secret-gated admin surface for "Neithan". Fetch-only (Supabase REST), no pg.
 * Mirrored by the Express route in scripts/api-server.ts.
 */

import { CampaignStore } from "../../server/campaignStore";
import { createCampaignIdempotent, type RawCreateBody } from "../../server/adminCampaigns";
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

  let store: CampaignStore;
  try {
    store = CampaignStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    if (method === "GET") {
      // ?view=emails → the redeemed-user roster (count + emails); default → campaigns.
      if (pick(req.query.view) === "emails") {
        res.status(200).json({ grants: await store.listGrants() });
        return;
      }
      res.status(200).json({ campaigns: await store.listCampaigns() });
      return;
    }

    // POST
    const action = pick(req.query.action);
    const body = (req.body ?? {}) as RawCreateBody & { id?: string };

    if (action === "expire") {
      const id = (body.id ?? "").trim();
      if (!id) { res.status(400).json({ error: "missing id" }); return; }
      const updated = await store.expireCampaign(id);
      if (!updated) { res.status(404).json({ error: "campaign not found" }); return; }
      res.status(200).json({ campaign: updated });
      return;
    }

    // Idempotency (a replayed create returns the campaign it already minted
    // instead of minting a second one) lives in createCampaignIdempotent, the
    // one place both this route and the Express mirror call it - see
    // server/adminCampaigns.ts for why that is an in-memory cache rather than
    // a migration.
    const result = await createCampaignIdempotent(body, store);
    if (result.error) { res.status(result.status).json({ error: result.error }); return; }
    res.status(result.status).json({ campaign: result.campaign });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
