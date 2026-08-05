/**
 * POST /api/profile/result   body { wallet, executionId?, stated? }
 * (also accepts GET ?wallet=&executionId= without `stated`)
 *
 * One non-blocking step toward the reveal: returns {status:"pending"} while the
 * Dune execution runs, or {status:"done", profile} with the combined
 * (stated-vs-revealed) AI analysis once ready. Fast per call — the client polls
 * during/after the onboarding quiz. See docs/technical-docs/WALLET_PROFILER.md.
 */

// Specific modules, not the barrel — see server/profileDeps.ts (avoids viem/ws).
import { resolveProfileScan } from "../../packages/scoring/src/classify/profileSession";
import type { StatedProfile } from "../../packages/scoring/src/classify/types";
import { getProfileDeps, isDuneExecutionId, isEvmAddress } from "../../server/profileDeps";

interface Req { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }
interface Res { status(code: number): Res; json(body: unknown): void }

function pick(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const body = (req.body ?? {}) as { wallet?: string; executionId?: string; stated?: StatedProfile };
  const wallet = (pick(req.query.wallet) ?? body.wallet ?? "").trim();
  const executionId = pick(req.query.executionId) ?? body.executionId;
  const stated = body.stated;

  if (!isEvmAddress(wallet)) {
    res.status(400).json({ error: "invalid EVM wallet address" });
    return;
  }
  if (executionId !== undefined && !isDuneExecutionId(executionId)) {
    res.status(400).json({ error: "invalid executionId" });
    return;
  }

  let deps;
  try {
    deps = getProfileDeps();
  } catch (err) {
    res.status(503).json({ error: `profiler unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    const result = await resolveProfileScan(wallet.toLowerCase(), { executionId, stated }, deps);
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
