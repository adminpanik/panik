/**
 * Relayer attempt ledger (Phase 4.A) — the durable half of "never submit the
 * same permit twice".
 *
 * There are two independent guards and they cover different failures:
 *
 *   ON-CHAIN  `isNonceUsed(user, nonce)` is the truth, and the executor itself
 *             reverts a replay. But it only tells you about a permit that has
 *             ALREADY LANDED. Between broadcast and the receipt there is a
 *             window where the chain still says "unused" and a second tick — or
 *             a process that restarted inside that window — would happily
 *             submit again. Two transactions, one succeeds, one reverts, gas
 *             burned for nothing.
 *
 *   THIS TABLE closes that window. A row is claimed BEFORE the transaction is
 *             broadcast, and the unique index on (chain, executor, user, nonce)
 *             makes the claim atomic: the second claimant gets a conflict, not
 *             a race. Because it is in Postgres and not in memory, a crash and
 *             restart mid-flight finds the `in_flight` row and refuses to
 *             re-fire the permit.
 *
 * RETRIES. A reverted atomicExitFor unwinds its own nonce spend, so a failed
 * attempt leaves the permit genuinely reusable. Blindly retrying it is how a
 * relayer burns a wallet on a permit that will never succeed, so a row carries
 * an attempt counter and the relayer stops at `maxAttemptsPerPermit`. The row
 * is never deleted on failure: "we tried three times and stopped" is the fact
 * an operator needs, and a deleted row says nothing.
 *
 * Pure fetch against PostgREST with the service key, matching
 * server/exitDelegationStore.ts — no `pg`, so it bundles as an ESM function.
 *
 * Table + RLS: supabase/migrations/20260810000001_relayer_attempts.sql.
 */

/** Lifecycle of one permit's submission. */
export type AttemptStatus = "in_flight" | "succeeded" | "failed";

/** The identity of a permit, which is also the idempotency key. */
export interface AttemptKey {
  chainId: number;
  executor: `0x${string}`;
  user: `0x${string}`;
  /** uint256 permit nonce. */
  nonce: bigint;
}

export interface AttemptRow {
  id: string;
  status: AttemptStatus;
  attempts: number;
  txHash: string | null;
  signerAddress: string | null;
  updatedAt: number;
}

/** What a finished attempt records. All wei/gas values stay BigInt. */
export interface AttemptOutcome {
  status: AttemptStatus;
  txHash?: string | null;
  gasUsed?: bigint | null;
  effectiveGasPrice?: bigint | null;
  error?: string | null;
}

export interface RelayerAttemptStore {
  /**
   * Atomically claim the right to submit this permit.
   *
   * Resolves `true` when this caller owns the attempt, `false` when someone
   * else already does or the permit is finished. FALSE IS NOT AN ERROR — it is
   * the guard doing its job — and the caller must skip, not retry.
   */
  claim(key: AttemptKey, signer: `0x${string}`, maxAttempts: number): Promise<boolean>;
  /** Record the result of a claimed attempt. */
  finish(key: AttemptKey, outcome: AttemptOutcome): Promise<void>;
  /** Current row, or null when the permit has never been attempted. */
  find(key: AttemptKey): Promise<AttemptRow | null>;
  /**
   * Rows still marked in_flight — read once at boot. A row left in flight by a
   * crash is unresolved, not free: the relayer reconciles it against the chain
   * before it will touch that permit again.
   */
  listInFlight(chainId: number, executor: `0x${string}`): Promise<(AttemptRow & AttemptKey)[]>;
}

interface RawAttempt {
  id: string;
  status: AttemptStatus;
  attempts: number;
  tx_hash: string | null;
  signer_address: string | null;
  updated_at: string;
  chain_id: number;
  executor_address: string;
  user_address: string;
  permit_nonce: string;
}

const decode = (r: RawAttempt): AttemptRow => ({
  id: String(r.id),
  status: r.status,
  attempts: r.attempts,
  txHash: r.tx_hash,
  signerAddress: r.signer_address,
  updatedAt: new Date(r.updated_at).getTime(),
});

export class SupabaseRelayerAttemptStore implements RelayerAttemptStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  static fromEnv(): SupabaseRelayerAttemptStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SupabaseRelayerAttemptStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private query(key: AttemptKey): string {
    return (
      `chain_id=eq.${key.chainId}` +
      `&executor_address=eq.${encodeURIComponent(key.executor.toLowerCase())}` +
      `&user_address=eq.${encodeURIComponent(key.user.toLowerCase())}` +
      `&permit_nonce=eq.${key.nonce.toString()}`
    );
  }

  async find(key: AttemptKey): Promise<AttemptRow | null> {
    const res = await fetch(`${this.base}/rest/v1/relayer_attempts?${this.query(key)}&limit=1`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`find relayer attempt: HTTP ${res.status}`);
    const rows = (await res.json()) as RawAttempt[];
    return Array.isArray(rows) && rows[0] ? decode(rows[0]) : null;
  }

  async claim(key: AttemptKey, signer: `0x${string}`, maxAttempts: number): Promise<boolean> {
    // First claim: the unique index decides the race. A 409 means another
    // worker (or an earlier crash) already owns this permit.
    const insert = await fetch(`${this.base}/rest/v1/relayer_attempts`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        chain_id: key.chainId,
        executor_address: key.executor.toLowerCase(),
        user_address: key.user.toLowerCase(),
        permit_nonce: key.nonce.toString(),
        status: "in_flight",
        attempts: 1,
        signer_address: signer.toLowerCase(),
      }),
    });
    if (insert.ok) return true;
    if (insert.status !== 409) throw new Error(`claim relayer attempt: HTTP ${insert.status}`);

    // A row exists. Only a FAILED row under the attempt ceiling may be retried;
    // in_flight belongs to someone else and succeeded is done forever. The
    // filter is part of the PATCH so the re-claim is still one atomic
    // conditional write, not a read-then-write race.
    const patch = await fetch(
      `${this.base}/rest/v1/relayer_attempts?${this.query(key)}` +
        `&status=eq.failed&attempts=lt.${maxAttempts}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({
          status: "in_flight",
          signer_address: signer.toLowerCase(),
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!patch.ok) throw new Error(`re-claim relayer attempt: HTTP ${patch.status}`);
    const rows = (await patch.json()) as RawAttempt[];
    if (!Array.isArray(rows) || rows.length === 0) return false;

    // Bump the counter separately: PostgREST cannot express `attempts + 1` in a
    // PATCH body, and the conditional PATCH above already won the claim, so no
    // other writer can be incrementing this row concurrently.
    await fetch(`${this.base}/rest/v1/relayer_attempts?${this.query(key)}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ attempts: (rows[0]!.attempts ?? 0) + 1 }),
    });
    return true;
  }

  async finish(key: AttemptKey, outcome: AttemptOutcome): Promise<void> {
    const body: Record<string, unknown> = {
      status: outcome.status,
      updated_at: new Date().toISOString(),
    };
    if (outcome.txHash !== undefined) body.tx_hash = outcome.txHash;
    if (outcome.gasUsed !== undefined && outcome.gasUsed !== null) {
      body.gas_used = outcome.gasUsed.toString();
    }
    if (outcome.effectiveGasPrice !== undefined && outcome.effectiveGasPrice !== null) {
      body.effective_gas_price = outcome.effectiveGasPrice.toString();
    }
    if (outcome.gasUsed && outcome.effectiveGasPrice) {
      body.fee_wei = (outcome.gasUsed * outcome.effectiveGasPrice).toString();
    }
    if (outcome.error !== undefined) body.error = outcome.error?.slice(0, 500) ?? null;

    const res = await fetch(`${this.base}/rest/v1/relayer_attempts?${this.query(key)}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`finish relayer attempt: HTTP ${res.status}`);
  }

  async listInFlight(
    chainId: number,
    executor: `0x${string}`,
  ): Promise<(AttemptRow & AttemptKey)[]> {
    const url =
      `${this.base}/rest/v1/relayer_attempts?chain_id=eq.${chainId}` +
      `&executor_address=eq.${encodeURIComponent(executor.toLowerCase())}` +
      `&status=eq.in_flight&order=updated_at.asc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`list in-flight attempts: HTTP ${res.status}`);
    const rows = (await res.json()) as RawAttempt[];
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      ...decode(r),
      chainId: r.chain_id,
      executor: r.executor_address as `0x${string}`,
      user: r.user_address as `0x${string}`,
      nonce: BigInt(r.permit_nonce),
    }));
  }
}

/**
 * In-memory store for tests and for a dry run with no Supabase configured.
 *
 * Correct for a single process, which is exactly what it claims to be. It is
 * NOT a substitute for the table in production: the whole point of the durable
 * ledger is surviving the restart this map does not.
 */
export class MemoryRelayerAttemptStore implements RelayerAttemptStore {
  private readonly rows = new Map<string, AttemptRow & AttemptKey>();
  private seq = 0;

  private k(key: AttemptKey): string {
    return `${key.chainId}:${key.executor.toLowerCase()}:${key.user.toLowerCase()}:${key.nonce}`;
  }

  async find(key: AttemptKey): Promise<AttemptRow | null> {
    return this.rows.get(this.k(key)) ?? null;
  }

  async claim(key: AttemptKey, signer: `0x${string}`, maxAttempts: number): Promise<boolean> {
    const id = this.k(key);
    const existing = this.rows.get(id);
    if (existing) {
      if (existing.status !== "failed" || existing.attempts >= maxAttempts) return false;
      existing.status = "in_flight";
      existing.attempts += 1;
      existing.signerAddress = signer.toLowerCase();
      existing.updatedAt = Date.now();
      return true;
    }
    this.rows.set(id, {
      ...key,
      id: String(++this.seq),
      status: "in_flight",
      attempts: 1,
      txHash: null,
      signerAddress: signer.toLowerCase(),
      updatedAt: Date.now(),
    });
    return true;
  }

  async finish(key: AttemptKey, outcome: AttemptOutcome): Promise<void> {
    const row = this.rows.get(this.k(key));
    if (!row) return;
    row.status = outcome.status;
    if (outcome.txHash !== undefined) row.txHash = outcome.txHash;
    row.updatedAt = Date.now();
  }

  async listInFlight(
    chainId: number,
    executor: `0x${string}`,
  ): Promise<(AttemptRow & AttemptKey)[]> {
    return [...this.rows.values()].filter(
      (r) =>
        r.status === "in_flight" &&
        r.chainId === chainId &&
        r.executor.toLowerCase() === executor.toLowerCase(),
    );
  }
}
