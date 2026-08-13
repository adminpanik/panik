/**
 * /api/admin/metrics
 *   GET  the dashboard tile set (wallets, positions, collateral, transactions)
 *
 * Mirrored by the Express route in scripts/api-server.ts; that one is what
 * serves traffic (api/ is vercelignored). Unlike the simulation mirror, this
 * copy is complete: every figure comes from one SQL function over PostgREST, so
 * there is nothing here that needed `pg`.
 */

import { authorizeAdminRequest, type AdminReqHeaders } from "../../server/adminGate";
import { MetricsStore } from "../../server/metricsStore";

interface Req {
  method?: string;
  headers: AdminReqHeaders;
}
interface Res { status(code: number): Res; json(body: unknown): void }

export default async function handler(req: Req, res: Res): Promise<void> {
  const verdict = await authorizeAdminRequest(req.headers);
  if (!verdict.ok) { res.status(verdict.status).json(verdict.body); return; }

  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let store: MetricsStore;
  try {
    store = MetricsStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    res.status(200).json(await store.fetchMetrics());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
