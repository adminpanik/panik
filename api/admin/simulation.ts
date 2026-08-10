/**
 * /api/admin/simulation
 *   GET     what is armed, or null
 *   POST    arm a scenario for a bounded window
 *   DELETE  clear it
 *
 * The market-event simulator: a scoring-layer price override that makes
 * positions degrade as if the market had moved, so the protection chain can be
 * demonstrated end to end. See packages/scoring/src/simulation.ts for what is
 * and is not imagined.
 *
 * Mirrored by the Express route in scripts/api-server.ts; that one is what
 * serves traffic (api/ is vercelignored). This copy omits the "affected
 * positions" preview, which needs a `pg` query and `pg` is banned from modules
 * api/ imports; it is an operator convenience, not part of the control.
 */

import { authorizeAdminRequest, type AdminReqHeaders } from "../../server/adminGate";
import {
  SimulationStore,
  rowToSimulation,
  simulationWire,
  validateArmInput,
  type ArmSimulationInput,
} from "../../server/simulationStore";
import { activeSimulation } from "../../packages/scoring/src/simulation";

interface Req {
  method?: string;
  headers: AdminReqHeaders;
  body?: unknown;
}
interface Res { status(code: number): Res; json(body: unknown): void }

export default async function handler(req: Req, res: Res): Promise<void> {
  const verdict = await authorizeAdminRequest(req.headers);
  if (!verdict.ok) { res.status(verdict.status).json(verdict.body); return; }

  const method = (req.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(method)) {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Identity from the VERIFIED session, never from the body: who armed a
  // scenario is the audit trail for what a room was shown.
  const actor = verdict.email ?? "admin-key";

  let store: SimulationStore;
  try {
    store = SimulationStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    if (method === "POST") {
      const body = (req.body ?? {}) as Partial<ArmSimulationInput>;
      const input: ArmSimulationInput = {
        scenario: String(body.scenario ?? ""),
        label: String(body.label ?? ""),
        multipliers: (body.multipliers ?? {}) as Record<string, number>,
        durationMinutes: Number(body.durationMinutes),
        setBy: actor,
      };
      const invalid = validateArmInput(input);
      if (invalid) { res.status(400).json({ error: invalid }); return; }
      await store.arm(input);
    } else if (method === "DELETE") {
      await store.clear(actor);
    }

    // Read back through `activeSimulation` rather than trusting the row: expiry
    // is judged in exactly one place, and this response has to agree with what
    // the scoring path will do a second from now.
    const row = await store.currentRow();
    const active = activeSimulation(row ? rowToSimulation(row) : null, Date.now());
    res.status(200).json({ simulation: active ? simulationWire(active) : null, affected: [] });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
