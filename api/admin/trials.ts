/**
 * /api/admin/trials   (Authorization: Bearer <supabase jwt>, or x-admin-key)
 *   GET                    every beta grant that is open right now
 *   POST ?action=end       force one to end now { email }
 *
 * Operator QA surface: a renewal flow can only be exercised by somebody whose
 * trial has just run out, so this ends one on demand. The decision, the write
 * and the audit line all live in server/adminTrials.ts, which the Express
 * mirror in scripts/api-server.ts calls identically.
 *
 * Fetch-only (Supabase REST + GoTrue), no pg, so it bundles as an ESM
 * serverless function. Like the rest of api/, this file is vercelignored and
 * serves no traffic; it is kept compiling and consistent with the Express side.
 */

import {
  AdminTrialStore,
  END_TRIAL_REFUSAL,
  endTrialForEmail,
} from "../../server/adminTrials";
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

  let store: AdminTrialStore;
  try {
    store = AdminTrialStore.fromEnv();
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
      res.status(200).json({ trials: await store.liveTrials() });
      return;
    }

    if (pick(req.query.action) !== "end") {
      res.status(400).json({ error: "unknown action" });
      return;
    }
    const body = (req.body ?? {}) as { email?: unknown };
    // `verdict.email` is the signed-in operator when a bearer was presented,
    // and undefined on the shared-secret path, which has no name to record.
    const result = await endTrialForEmail(store, { email: body.email, actor: verdict.email ?? null });
    if (result.outcome === "ended") {
      res.status(200).json({ trial: result.trial });
      return;
    }
    const refusal = END_TRIAL_REFUSAL[result.outcome];
    res.status(refusal.status).json({ error: refusal.error });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
