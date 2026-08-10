/**
 * ExitPermit delegation store over the Supabase PostgREST API (Phase 2.B).
 *
 * Pure fetch with the service key (bypasses the deny-all RLS on
 * public.exit_delegations), mirroring server/telegramStore.ts and
 * server/nonceStore.ts — no `pg`, so it bundles cleanly as an ESM Vercel
 * serverless function.
 *
 * WHAT IS STORED: the SIGNED permit and its signature, never a key. The
 * signature IS the delegation (PANIK custodies nothing that can act on a
 * wallet). The uint256 fields (triggerHealthFactorWad, epoch, nonce) are kept
 * as text so a full 256-bit value round-trips exactly — a bigint that Postgres
 * bigint would overflow. `deadline` is a unix-seconds uint that fits bigint.
 *
 * Table + RLS: supabase/migrations/20260809000002_exit_delegations.sql.
 */

import type { ExitPermit } from "./exitPermit";

/** Lifecycle status. `active` is a claim the on-chain reader can override. */
export type DelegationStatus = "active" | "revoked" | "expired" | "consumed";

/**
 * What the signer address looked like WHEN THE PERMIT WAS VERIFIED.
 *
 * Recorded so the coverage sweep can detect an EIP-7702 delegate installed
 * AFTER the grant (Issue #41 layer 3) — a transition no grant-time check can
 * see. Both fields are null on rows written before the column existed, which
 * the sweep reports as unverifiable rather than as fine.
 */
export interface SignerCodeBaseline {
  /** Did permit.user carry code at grant time? Null = not recorded. */
  signerHadCode: boolean | null;
  /** keccak256 of that code, or null for none / not recorded. */
  signerCodeHash: string | null;
}

/** A stored delegation, decoded back into typed fields. */
export interface DelegationRow extends SignerCodeBaseline {
  id: string;
  createdAt: number;
  permit: ExitPermit;
  signature: `0x${string}`;
  status: DelegationStatus;
  chainId: number;
  executor: `0x${string}`;
  revocationTx: string | null;
}

/** Everything needed to persist a freshly verified delegation. */
export interface DelegationInsert {
  permit: ExitPermit;
  signature: `0x${string}`;
  chainId: number;
  executor: `0x${string}`;
  /** The signer-code baseline; see SignerCodeBaseline. */
  signerHadCode?: boolean;
  signerCodeHash?: string | null;
}

/** The store contract, injectable so orchestration and tests never hit the API. */
export interface DelegationStore {
  /**
   * Insert an active delegation. Resolves `false` on a duplicate (the unique
   * (chain, executor, user, nonce) row already exists — the same permit
   * resubmitted), which is idempotent, not an error. Throws only on transport
   * failure (caller maps to 502).
   */
  insert(row: DelegationInsert): Promise<boolean>;
  /** Every row for a user still marked `active`, newest first. */
  listActive(user: `0x${string}`, chainId: number, executor: `0x${string}`): Promise<DelegationRow[]>;
  /** Flip a row to a terminal status; records the revocation tx when supplied. */
  setStatus(id: string, status: DelegationStatus, revocationTx?: string | null): Promise<void>;
}

interface RawRow {
  id: string;
  created_at: string;
  user_address: string;
  kind: number;
  max_repay_fraction_bps: number;
  trigger_health_factor_wad: string;
  max_slippage_bps: number;
  protocols_mask: number;
  epoch: string;
  nonce: string;
  deadline: string | number;
  signature: string;
  status: DelegationStatus;
  chain_id: number;
  executor_address: string;
  revocation_tx: string | null;
  signer_had_code: boolean | null;
  signer_code_hash: string | null;
}

function decode(r: RawRow): DelegationRow {
  return {
    id: String(r.id),
    createdAt: new Date(r.created_at).getTime(),
    signature: r.signature as `0x${string}`,
    status: r.status,
    chainId: r.chain_id,
    executor: r.executor_address as `0x${string}`,
    revocationTx: r.revocation_tx,
    // `?? null` rather than a default of false: a row written before the
    // column existed genuinely does not know, and "false" would tell the sweep
    // that an address which has code today must have gained it.
    signerHadCode: r.signer_had_code ?? null,
    signerCodeHash: r.signer_code_hash ?? null,
    permit: {
      user: r.user_address as `0x${string}`,
      kind: r.kind,
      maxRepayFractionBps: r.max_repay_fraction_bps,
      triggerHealthFactorWad: BigInt(r.trigger_health_factor_wad),
      maxSlippageBps: r.max_slippage_bps,
      protocolsMask: r.protocols_mask,
      epoch: BigInt(r.epoch),
      nonce: BigInt(r.nonce),
      deadline: BigInt(r.deadline),
    },
  };
}

export class SupabaseDelegationStore implements DelegationStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): SupabaseDelegationStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SupabaseDelegationStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async insert(row: DelegationInsert): Promise<boolean> {
    const { permit } = row;
    const res = await fetch(`${this.base}/rest/v1/exit_delegations`, {
      method: "POST",
      // Ignore a unique-constraint conflict: the same permit resubmitted is a
      // no-op, not a failure. The signature can only have been produced by the
      // user's own wallet, so re-storing it never redirects value.
      headers: this.headers({ Prefer: "return=minimal,resolution=ignore-duplicates" }),
      body: JSON.stringify({
        user_address: permit.user.toLowerCase(),
        kind: permit.kind,
        max_repay_fraction_bps: permit.maxRepayFractionBps,
        trigger_health_factor_wad: permit.triggerHealthFactorWad.toString(),
        max_slippage_bps: permit.maxSlippageBps,
        protocols_mask: permit.protocolsMask,
        epoch: permit.epoch.toString(),
        nonce: permit.nonce.toString(),
        deadline: permit.deadline.toString(),
        signature: row.signature,
        status: "active",
        chain_id: row.chainId,
        executor_address: row.executor.toLowerCase(),
        signer_had_code: row.signerHadCode ?? null,
        signer_code_hash: row.signerCodeHash ?? null,
      }),
    });
    // 201 created, or 200 with ignore-duplicates when the row already existed.
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`insert delegation: HTTP ${res.status}`);
    return true;
  }

  async listActive(
    user: `0x${string}`,
    chainId: number,
    executor: `0x${string}`,
  ): Promise<DelegationRow[]> {
    const url =
      `${this.base}/rest/v1/exit_delegations` +
      `?user_address=eq.${encodeURIComponent(user.toLowerCase())}` +
      `&chain_id=eq.${chainId}` +
      `&executor_address=eq.${encodeURIComponent(executor.toLowerCase())}` +
      `&status=eq.active&order=created_at.desc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`list delegations: HTTP ${res.status}`);
    const rows = (await res.json()) as RawRow[];
    return Array.isArray(rows) ? rows.map(decode) : [];
  }

  async setStatus(id: string, status: DelegationStatus, revocationTx?: string | null): Promise<void> {
    const body: Record<string, unknown> = { status };
    if (revocationTx !== undefined) body.revocation_tx = revocationTx;
    const res = await fetch(`${this.base}/rest/v1/exit_delegations?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`set delegation status: HTTP ${res.status}`);
  }
}
