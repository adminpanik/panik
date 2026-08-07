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
import { buildCreateInput, type RawCreateBody } from "../../server/adminCampaigns";
import { adminAuthGate } from "../../server/adminAuth";

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res { status(code: number): Res; json(body: unknown): void }

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  // Guessing brake keyed on the PRESENTED credential (server/adminAuth.ts), so
  // no stranger can lock the real admin out. State is per-isolate here, which
  // only ever makes the brake more lenient — never the admin less available.
  const { auth, retryAfterSec } = adminAuthGate.authorize(pick(req.headers["x-admin-key"]));
  if (auth === "unconfigured") { res.status(503).json({ error: "admin unconfigured (ADMIN_ACCESS_KEY)" }); return; }
  if (auth === "locked") { res.status(429).json({ error: "too many failed admin auth attempts", retryAfterSec }); return; }
  if (auth === "forbidden") { res.status(401).json({ error: "unauthorized" }); return; }

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

    const { input, error } = buildCreateInput(body);
    if (error) { res.status(400).json({ error }); return; }
    const campaign = await store.createCampaign(input!);
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
