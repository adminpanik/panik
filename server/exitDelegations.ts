/**
 * Delegation lifecycle orchestration (Phase 2.B) — transport-agnostic so the
 * Railway Express server (scripts/api-server.ts) and the Vercel fallbacks
 * (api/exit/*) share ONE implementation. Each function returns {status, body}
 * ready for either res.status().json(); a fallback weaker than the primary is
 * just a slower way in (the rule stated in api/telegram/link.ts).
 *
 * DO WE REQUIRE A SEPARATE SIWE OWNERSHIP PROOF (walletAuth.ts)? NO — and the
 * reasoning is the whole security argument for this phase:
 *
 *   - Submitting a delegation ALREADY requires an EIP-712 signature that
 *     recovers to `permit.user`. That is itself an ownership proof, and a
 *     stronger one than SIWE for this action: it is bound to the exact scope
 *     (kind, caps, trigger, slippage, protocols, deadline) and is single-use
 *     via the on-chain nonce. An attacker cannot forge it for a victim.
 *   - The permit can never redirect value: it carries no recipient and the
 *     contract always pays `permit.user`. So even a hostile submit of a
 *     genuinely-signed permit hands the "attacker" nothing — it stores the
 *     user's own authorization to be paid their own funds. A second SIWE popup
 *     would add friction for zero gain.
 *   - Revocation is verified against LIVE chain state, not the caller's word
 *     (see revokeDelegation): a row flips to revoked/consumed ONLY when the
 *     chain proves it, so a stranger cannot falsely revoke a victim's coverage.
 *
 * What SIWE would add (anti-spam, binding to a server nonce) is covered instead
 * by the per-IP rate limit every route carries. NOTE (tracked, restated in the
 * PR): the Railway-origin rate-limit bypass is an open risk and MUST be closed
 * before this path drives real spend.
 */

import {
  parsePermitBody,
  validatePermitScope,
  verifyPermitSignature,
  type ExitPermit,
} from "./exitPermit";
import type { ExitChainReader } from "./exitChain";
import type { DelegationRow, DelegationStatus, DelegationStore } from "./exitDelegationStore";
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import { isEvmAddress } from "./profileDeps";

/** A response the caller writes verbatim to whichever transport it holds. */
export interface HandlerResult {
  status: number;
  body: unknown;
}

/** Injected collaborators; production wires the Supabase store + viem reader. */
export interface DelegationDeps {
  store: DelegationStore;
  chain: ExitChainReader;
  /** The executor's chain and address. Defaults to the generated config. */
  chainId?: number;
  executor?: `0x${string}`;
  /** Overridable for deterministic tests; defaults to Date.now(). */
  nowSec?: number;
}

const chainOf = (d: DelegationDeps): number => d.chainId ?? EXIT_CHAIN_ID;
const executorOf = (d: DelegationDeps): `0x${string}` => d.executor ?? EXECUTOR_ADDRESS;
const nowSecOf = (d: DelegationDeps): number => d.nowSec ?? Math.floor(Date.now() / 1000);

/** A permit reduced to JSON-safe fields (bigints stringified) for responses. */
function permitToJson(p: ExitPermit): Record<string, unknown> {
  return {
    user: p.user,
    kind: p.kind,
    maxRepayFractionBps: p.maxRepayFractionBps,
    triggerHealthFactorWad: p.triggerHealthFactorWad.toString(),
    maxSlippageBps: p.maxSlippageBps,
    protocolsMask: p.protocolsMask,
    epoch: p.epoch.toString(),
    nonce: p.nonce.toString(),
    deadline: p.deadline.toString(),
  };
}

/**
 * The single place a stored delegation's TRUE status is derived from live chain
 * state — "never state a fact the code does not know" applied to coverage. The
 * order matters: an expired permit is expired whatever the chain says; a permit
 * on a stale epoch is revoked; a spent nonce is consumed; only then is it live.
 */
export function resolveLiveStatus(
  row: DelegationRow,
  chainEpoch: bigint,
  nonceUsed: boolean,
  nowSec: number,
): DelegationStatus {
  if (row.permit.deadline <= BigInt(nowSec)) return "expired";
  if (row.permit.epoch !== chainEpoch) return "revoked";
  if (nonceUsed) return "consumed";
  return "active";
}

/** A row plus the status the chain actually implies for it right now. */
interface ReconciledRow {
  row: DelegationRow;
  status: DelegationStatus;
}

/**
 * Read every active row for a user, resolve each against live chain state, and
 * lazily persist the ones the chain has since killed (best-effort — a failed
 * write never corrupts the response, because the status was computed live).
 */
async function reconcile(user: `0x${string}`, deps: DelegationDeps): Promise<ReconciledRow[]> {
  const chainId = chainOf(deps);
  const executor = executorOf(deps);
  const nowSec = nowSecOf(deps);

  const rows = await deps.store.listActive(user, chainId, executor);
  if (rows.length === 0) return [];

  // One epoch read per user; one nonce read per row, in parallel.
  const epoch = await deps.chain.revocationEpoch(user);
  const nonceUsed = await Promise.all(rows.map((r) => deps.chain.isNonceUsed(user, r.permit.nonce)));

  const reconciled = rows.map((row, i) => ({
    row,
    status: resolveLiveStatus(row, epoch, nonceUsed[i]!, nowSec),
  }));

  // Converge the DB toward the chain, but do not let a write failure break the
  // read: the returned status is already the live truth.
  await Promise.all(
    reconciled
      .filter((r) => r.status !== "active")
      .map((r) =>
        deps.store.setStatus(r.row.id, r.status).catch((err) => {
          console.error(`delegation ${r.row.id} status persist failed: ${(err as Error).message}`);
        }),
      ),
  );

  return reconciled;
}

/**
 * POST /api/exit/delegations — verify a signed permit and store it.
 *
 * Rejects, mirroring exactly what the contract would reject, so no unusable row
 * is ever stored: bad shape (400), signature not recovering to permit.user
 * (401), scope the contract's _validatePermitScope would revert (400), and a
 * permit already dead on-chain — wrong epoch or a spent nonce (409).
 */
export async function submitDelegation(body: unknown, deps: DelegationDeps): Promise<HandlerResult> {
  const parsed = parsePermitBody(body);
  if (!parsed.ok || !parsed.permit || !parsed.signature) {
    return { status: 400, body: { error: parsed.error || "invalid permit" } };
  }
  const permit = parsed.permit;
  const signature = parsed.signature;

  const chainId = chainOf(deps);
  const executor = executorOf(deps);

  // The trust check: a signature recovering to permit.user, on the executor's
  // own domain (chainId + verifyingContract). Address format is not authorization.
  const signerOk = await verifyPermitSignature(permit, signature, { chainId, verifyingContract: executor });
  if (!signerOk) return { status: 401, body: { error: "signature does not recover to permit.user" } };

  // Scope, against the executor's live immutable ceiling.
  let ceiling: number;
  try {
    ceiling = await deps.chain.maxPermitSlippageBps();
  } catch (err) {
    console.error(`maxPermitSlippageBps read failed: ${(err as Error).message}`);
    return { status: 503, body: { error: "executor unavailable" } };
  }
  const scope = validatePermitScope(permit, ceiling, nowSecOf(deps));
  if (!scope.ok) return { status: 400, body: { error: scope.error } };

  // Liveness on-chain: refuse a permit the contract would already reject at
  // execution — one on a stale revocation epoch, or whose nonce is spent.
  let epoch: bigint;
  let nonceUsed: boolean;
  try {
    [epoch, nonceUsed] = await Promise.all([
      deps.chain.revocationEpoch(permit.user),
      deps.chain.isNonceUsed(permit.user, permit.nonce),
    ]);
  } catch (err) {
    console.error(`delegation liveness read failed: ${(err as Error).message}`);
    return { status: 503, body: { error: "executor unavailable" } };
  }
  if (permit.epoch !== epoch) {
    return { status: 409, body: { error: "permit epoch does not match the wallet's current revocation epoch" } };
  }
  if (nonceUsed) return { status: 409, body: { error: "permit nonce is already spent on-chain" } };

  let created: boolean;
  try {
    created = await deps.store.insert({ permit, signature, chainId, executor });
  } catch (err) {
    console.error(`delegation insert failed: ${(err as Error).message}`);
    return { status: 502, body: { error: "could not store delegation" } };
  }

  return {
    status: 200,
    body: { ok: true, duplicate: !created, delegation: { permit: permitToJson(permit), status: "active" } },
  };
}

/**
 * The live-permit query as TYPED ROWS — what the relayer (4.A) consumes.
 *
 * Deliberately the same `reconcile` the HTTP handler below uses, so there is
 * exactly ONE place a stored row becomes "the chain would accept this". The
 * relayer must never re-derive delegation status: a permit the chain would
 * reject is not coverage, and a second opinion about that is how a relayer ends
 * up burning gas on a revoked permit. Returns only genuinely live rows, with
 * the permit as bigints (not the JSON strings the HTTP shape carries) because
 * the relayer feeds them straight into an ABI encoder.
 */
export async function liveDelegationsFor(
  user: `0x${string}`,
  deps: DelegationDeps,
): Promise<DelegationRow[]> {
  const reconciled = await reconcile(user, deps);
  return reconciled.filter((r) => r.status === "active").map((r) => r.row);
}

/**
 * GET /api/exit/delegations?wallet=… — the live-permit query the relayer (4.A)
 * and the UI (2.C) both consume. Returns ONLY genuinely live delegations (not
 * expired, not on a stale epoch, nonce unspent), each with its computed status,
 * plus the full permit + signature the relayer needs to submit. Exposing the
 * signature is value-safe: it authorizes only an exit that pays the user.
 */
export async function listLiveDelegations(wallet: unknown, deps: DelegationDeps): Promise<HandlerResult> {
  const w = String(wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(w)) return { status: 400, body: { error: "invalid EVM wallet address" } };

  let reconciled: ReconciledRow[];
  try {
    reconciled = await reconcile(w as `0x${string}`, deps);
  } catch (err) {
    console.error(`list delegations failed: ${(err as Error).message}`);
    return { status: 502, body: { error: "could not read delegations" } };
  }

  const live = reconciled
    .filter((r) => r.status === "active")
    .map((r) => ({
      id: r.row.id,
      createdAt: r.row.createdAt,
      status: r.status,
      chainId: r.row.chainId,
      executor: r.row.executor,
      signature: r.row.signature,
      permit: permitToJson(r.row.permit),
    }));

  return { status: 200, body: { wallet: w, delegations: live } };
}

/**
 * POST /api/exit/delegations/revoke {wallet, txHash?} — record the user's
 * on-chain revocation. Revocation itself is the USER's msg.sender action
 * (invalidateUnorderedNonces / revokeAll); this endpoint only reflects it.
 *
 * The status flip is driven ENTIRELY by live chain reads (revocationEpoch +
 * isNonceUsed), so "revoked" reflects reality, never a claim — a stranger
 * naming a victim's wallet can only mark rows the chain already killed, which is
 * truthful. An optional txHash is verified (mined, succeeded, sent BY the wallet
 * TO the executor) and stored as evidence on the rows it revoked; a supplied
 * hash that fails those checks is rejected rather than trusted.
 */
export async function revokeDelegation(body: unknown, deps: DelegationDeps): Promise<HandlerResult> {
  const { wallet, txHash } = (body ?? {}) as { wallet?: unknown; txHash?: unknown };
  const w = String(wallet ?? "").trim().toLowerCase();
  if (!isEvmAddress(w)) return { status: 400, body: { error: "invalid EVM wallet address" } };

  let evidence: string | null = null;
  if (txHash !== undefined && txHash !== null && txHash !== "") {
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { status: 400, body: { error: "malformed txHash" } };
    }
    const receipt = await deps.chain.receiptFor(txHash as `0x${string}`);
    const executor = executorOf(deps).toLowerCase();
    if (
      !receipt ||
      !receipt.success ||
      receipt.from.toLowerCase() !== w ||
      (receipt.to ?? "").toLowerCase() !== executor
    ) {
      return { status: 400, body: { error: "txHash is not a confirmed revocation the wallet sent to the executor" } };
    }
    evidence = txHash;
  }

  let reconciled: ReconciledRow[];
  try {
    reconciled = await reconcile(w as `0x${string}`, deps);
  } catch (err) {
    console.error(`revoke reconcile failed: ${(err as Error).message}`);
    return { status: 502, body: { error: "could not read delegations" } };
  }

  // Attach the tx evidence to rows the chain shows as newly revoked/consumed.
  const killed = reconciled.filter((r) => r.status !== "active");
  if (evidence) {
    await Promise.all(
      killed.map((r) =>
        deps.store.setStatus(r.row.id, r.status, evidence).catch((err) => {
          console.error(`delegation ${r.row.id} evidence persist failed: ${(err as Error).message}`);
        }),
      ),
    );
  }

  return {
    status: 200,
    body: {
      wallet: w,
      revoked: killed.map((r) => ({ id: r.row.id, status: r.status })),
      stillActive: reconciled.filter((r) => r.status === "active").length,
    },
  };
}
