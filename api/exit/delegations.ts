/**
 * /api/exit/delegations  (Phase 2.B)
 *   POST {permit, signature}  -> verify the EIP-712 permit and store it
 *   GET  ?wallet=0x…          -> the live-permit query (relayer + UI)
 *
 * A user signs an ExitPermit in their wallet; the backend recomputes the SAME
 * digest the contract does, on the EXECUTOR's domain (Base Sepolia 84532, NOT
 * the mainnet 8453 SIWE uses — see server/exitPermit.ts), recovers the signer,
 * and stores the SIGNED permit so the Phase 4.A relayer can later submit it. No
 * key is ever custodied; the permit carries no recipient, so a stored row can
 * only pay permit.user. The GET resolves every row against on-chain state, so a
 * permit the chain would reject is never reported live.
 *
 * WHICH HANDLER SERVES PRODUCTION: not this one. `.vercelignore` excludes api/,
 * so every /api/* request lands on the Railway Express server
 * (scripts/api-server.ts). This is the deliberate fallback and gets the SAME
 * method guard, rate limit and verification as its Express twin — a fallback
 * weaker than the primary is just a slower way in. Supabase REST + viem only.
 */

import { denyRequest, keyedRateLimit } from "../../server/rateLimit";
import { SupabaseDelegationStore } from "../../server/exitDelegationStore";
import { ViemExitChainReader } from "../../server/exitChain";
import { listLiveDelegations, submitDelegation } from "../../server/exitDelegations";

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader?(name: string, value: string): void;
}

// Matches `strictLimit` (POST mints state) / `walletLimit` (GET) in
// scripts/api-server.ts. The stricter POST budget governs here since one
// keyedRateLimit guards the file; the GET twin on Express keeps its own budget.
const limit = keyedRateLimit({ limit: 10 });
const chain = ViemExitChainReader.fromEnv();

export default async function handler(req: Req, res: Res): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const denied = denyRequest(limit, req);
  if (denied) {
    res.setHeader?.("Retry-After", String(denied.retryAfterSec));
    res.status(denied.status).json({ error: denied.error, retryAfterSec: denied.retryAfterSec });
    return;
  }

  let store: SupabaseDelegationStore;
  try {
    store = SupabaseDelegationStore.fromEnv();
  } catch (err) {
    res.status(503).json({ error: `delegations unconfigured: ${(err as Error).message}` });
    return;
  }

  try {
    const result =
      method === "POST"
        ? await submitDelegation(req.body, { store, chain })
        : await listLiveDelegations(req.query.wallet, { store, chain });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`/api/exit/delegations -> 500: ${(err as Error).message}`);
    res.status(500).json({ error: "internal error" });
  }
}
