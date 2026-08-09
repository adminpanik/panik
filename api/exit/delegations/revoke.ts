/**
 * POST /api/exit/delegations/revoke  {wallet, txHash?}  (Phase 2.B)
 *
 * Records the user's ON-CHAIN revocation. Revocation itself is the user's own
 * msg.sender action (invalidateUnorderedNonces / revokeAll) — the backend holds
 * no key that could do it. This endpoint only reflects reality: it resolves the
 * wallet's active rows against LIVE chain state (revocationEpoch + isNonceUsed)
 * and flips only the ones the chain already killed, so "revoked" is never a mere
 * claim. An optional txHash is verified (mined, succeeded, sent by the wallet to
 * the executor) and stored as evidence; a hash failing those checks is rejected.
 *
 * WHICH HANDLER SERVES PRODUCTION: not this one — see api/exit/delegations.ts.
 * Deliberate fallback, same method guard + rate limit + on-chain verification.
 */

import { denyRequest, keyedRateLimit } from "../../../server/rateLimit";
import { SupabaseDelegationStore } from "../../../server/exitDelegationStore";
import { ViemExitChainReader } from "../../../server/exitChain";
import { revokeDelegation } from "../../../server/exitDelegations";

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

/** Matches `strictLimit` in scripts/api-server.ts: this mutates stored state. */
const limit = keyedRateLimit({ limit: 10 });
const chain = ViemExitChainReader.fromEnv();

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method && req.method !== "POST") {
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
    const result = await revokeDelegation(req.body, { store, chain });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(`/api/exit/delegations/revoke -> 500: ${(err as Error).message}`);
    res.status(500).json({ error: "internal error" });
  }
}
