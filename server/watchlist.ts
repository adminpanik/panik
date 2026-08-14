/**
 * Watchlist core — the ONE place a watch subscription is created, edited or
 * removed, and the only writer of `watched_wallets`.
 *
 * THE SHAPE OF THE PROBLEM. Until 2026-08-14 `watched_wallets` was both the
 * intent ("I want this watched") and the registry ("the worker polls this"),
 * which is why the old register RPC could rewrite a stranger's risk_profile:
 * a row with no owner cannot be checked against a caller. `watch_subscriptions`
 * carries the owner, and this module is what keeps the derived registry honest.
 *
 * TWO INVARIANTS, AND BOTH ARE TRANSACTIONAL.
 *
 *   1. A wallet is `is_active` in the registry IFF at least one subscription
 *      references it. Every mutation here re-derives the registry rows it
 *      touched, inside the same transaction, through
 *      `public.watchlist_sync_registry`. A registry that disagrees with the
 *      intent is either a wallet nobody is paying attention to being polled
 *      every 60s forever, or a wallet somebody IS watching going unpolled — and
 *      the second one is the product's whole promise failing silently.
 *
 *   2. At most `WATCHLIST_MAX` subscriptions per owner. Enforced AFTER the whole
 *      batch has been applied, under a per-owner advisory lock, so it cannot be
 *      beaten by "remove one, add two" arithmetic or by two requests racing.
 *      The lock key is shared with `public.register_watched_wallet`, which takes
 *      the same one for the same reason.
 *
 * THE CALLER IS ALREADY AUTHENTICATED. `ownerWallet` reaching these functions
 * means a SIWE proof for `urn:panik:action:watchlist-manage` verified — address
 * format is not authorization (server/walletAuth.ts). Nothing here re-checks
 * that, and nothing here should be called on an unproven address.
 *
 * No `pg` import: the client is an interface so the unit tests can run the real
 * statements against a recording fake, and so this file stays importable from
 * anywhere. Tables: supabase/migrations/20260814000004_watch_subscriptions.sql.
 */

import { isEvmAddress } from "./profileDeps";
import type { RiskProfile } from "../packages/scoring/src/types";

/**
 * How many wallets one owner may watch.
 *
 * Ten. Each subscription is a wallet the worker reads every tick across four
 * protocols, so the cap is a spend control as much as a product decision. It
 * lives in TWO places on purpose — here and in
 * `public.register_watched_wallet` — because the RPC is a second door that must
 * not be able to step over it; the migration names this constant so the pair
 * cannot drift unnoticed.
 */
export const WATCHLIST_MAX = 10;

/**
 * How many operations one signed batch may carry.
 *
 * A batch is authorized by ONE signature, so its size is the blast radius of a
 * single proof. Generous enough to replace a full list in one go
 * (WATCHLIST_MAX removes + WATCHLIST_MAX adds), and bounded so a proof cannot
 * be turned into an unmetered write loop.
 */
export const WATCHLIST_MAX_OPS = WATCHLIST_MAX * 2;

/** Longest user-chosen name for a watched wallet. */
export const WATCHLIST_LABEL_MAX = 60;

const PROFILES: readonly RiskProfile[] = ["conservative", "moderate", "aggressive"];

export function isRiskProfile(value: unknown): value is RiskProfile {
  return typeof value === "string" && (PROFILES as readonly string[]).includes(value);
}

/**
 * One operation in a batch.
 *
 * `label: undefined` and `label: null` are DIFFERENT and the difference is
 * load-bearing: undefined means "leave whatever is there", null means "clear
 * it". Collapsing them is how onboarding used to stamp 'onboarded user' over a
 * name the user had chosen.
 */
export type WatchOp =
  | { op: "add"; wallet: string; profile: RiskProfile; label?: string | null }
  | { op: "update"; wallet: string; profile?: RiskProfile; label?: string | null }
  | { op: "remove"; wallet: string };

export interface WatchSubscription {
  wallet: string;
  profile: RiskProfile;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A failure the caller should return verbatim; `status` is the HTTP code. */
export class WatchlistError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WatchlistError";
  }
}

// ── request parsing ──────────────────────────────────────────────────────────

/**
 * Validate a request body into ops, or explain what is wrong with it.
 *
 * Everything here is a REJECTION, never a repair. A malformed profile is not
 * silently defaulted to "moderate": this is a mutation of the thresholds that
 * decide whether someone is warned before a liquidation, and quietly writing a
 * value the caller did not ask for is the same class of bug as rendering an
 * unknown as a zero. (Read paths still default — `riskProfileParam` in
 * scripts/api-server.ts — because there the value only picks a view.)
 */
export function parseWatchlistOps(body: unknown): { ops: WatchOp[] } | { error: string } {
  const raw = (body as { ops?: unknown } | null | undefined)?.ops;
  if (!Array.isArray(raw)) return { error: "body.ops must be an array of operations" };
  if (raw.length === 0) return { error: "body.ops is empty, so there is nothing to do" };
  if (raw.length > WATCHLIST_MAX_OPS) {
    return { error: `body.ops may carry at most ${WATCHLIST_MAX_OPS} operations` };
  }

  const ops: WatchOp[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const at = `ops[${index}]`;
    if (typeof entry !== "object" || entry === null) return { error: `${at} is not an object` };
    const { op, wallet, profile, label } = entry as Record<string, unknown>;

    if (op !== "add" && op !== "update" && op !== "remove") {
      return { error: `${at}.op must be one of add, update, remove` };
    }
    if (!isEvmAddress(wallet)) return { error: `${at}.wallet is not an EVM address` };
    const target = wallet.trim().toLowerCase();
    // Two ops on one wallet in one batch have no defined order once they reach
    // SQL, so "add then remove" and "remove then add" would differ by luck.
    if (seen.has(target)) return { error: `${at}.wallet appears more than once in this batch` };
    seen.add(target);

    if (op === "remove") {
      ops.push({ op: "remove", wallet: target });
      continue;
    }

    if (profile !== undefined && !isRiskProfile(profile)) {
      return { error: `${at}.profile must be one of ${PROFILES.join(", ")}` };
    }
    if (op === "add" && profile === undefined) {
      return { error: `${at}.profile is required when adding a wallet` };
    }

    let cleanLabel: string | null | undefined;
    if (label !== undefined) {
      if (label === null) {
        cleanLabel = null;
      } else if (typeof label !== "string") {
        return { error: `${at}.label must be a string or null` };
      } else {
        const trimmed = label.trim();
        if (trimmed.length > WATCHLIST_LABEL_MAX) {
          return { error: `${at}.label is longer than ${WATCHLIST_LABEL_MAX} characters` };
        }
        // An empty string is a cleared label, not a label that is the empty
        // string — the UI cannot tell them apart and neither should the row.
        cleanLabel = trimmed.length === 0 ? null : trimmed;
      }
    }

    if (op === "add") {
      ops.push({ op: "add", wallet: target, profile: profile as RiskProfile, ...(label !== undefined ? { label: cleanLabel ?? null } : {}) });
    } else {
      if (profile === undefined && label === undefined) {
        return { error: `${at} changes nothing. Supply a profile or a label` };
      }
      ops.push({
        op: "update",
        wallet: target,
        ...(profile !== undefined ? { profile: profile as RiskProfile } : {}),
        ...(label !== undefined ? { label: cleanLabel ?? null } : {}),
      });
    }
  }

  return { ops };
}

// ── database seam ────────────────────────────────────────────────────────────

/** The slice of `pg.Pool`/`pg.PoolClient` this module uses. */
export interface WatchlistQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface WatchlistClient extends WatchlistQueryable {
  release(): void;
}

export interface WatchlistPool extends WatchlistQueryable {
  connect(): Promise<WatchlistClient>;
}

interface SubscriptionRow {
  watched_wallet: string;
  risk_profile: RiskProfile;
  label: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

function decode(r: SubscriptionRow): WatchSubscription {
  return {
    wallet: r.watched_wallet,
    profile: r.risk_profile,
    label: r.label,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const LIST_SQL = `select watched_wallet, risk_profile, label, created_at, updated_at
       from public.watch_subscriptions
      where owner_wallet = $1
      order by created_at, watched_wallet`;

/** One owner's list. Public data by design decision — no proof required. */
export async function listSubscriptions(
  db: WatchlistQueryable,
  ownerWallet: string,
): Promise<WatchSubscription[]> {
  const { rows } = await db.query<SubscriptionRow>(LIST_SQL, [ownerWallet.toLowerCase()]);
  return rows.map(decode);
}

/**
 * The add/refresh statement, shared by `add` and by onboarding's
 * self-subscription.
 *
 * `$5` is "the caller mentioned a label". Without it there is no way to say
 * "set this to null" and "do not touch this" in one upsert, and onboarding
 * needs the second one — it knows the wallet and the profile and has no opinion
 * whatsoever about what the user calls it.
 */
const UPSERT_SQL = `insert into public.watch_subscriptions
         (owner_wallet, watched_wallet, risk_profile, label)
       values ($1, $2, $3, $4::text)
       on conflict (owner_wallet, watched_wallet) do update
          set risk_profile = excluded.risk_profile,
              label = case when $5::boolean then excluded.label else public.watch_subscriptions.label end,
              updated_at = now()`;

// Every nullable parameter is cast: a bare `$3` that arrives null leaves
// Postgres unable to infer the type and 42P18s the whole batch.
const UPDATE_SQL = `update public.watch_subscriptions
          set risk_profile = coalesce($3::text, risk_profile),
              label = case when $5::boolean then $4::text else label end,
              updated_at = now()
        where owner_wallet = $1 and watched_wallet = $2`;

const DELETE_SQL = `delete from public.watch_subscriptions
        where owner_wallet = $1 and watched_wallet = $2`;

const COUNT_SQL = `select count(*)::int as count
       from public.watch_subscriptions
      where owner_wallet = $1`;

/**
 * Apply a batch of operations for one PROVEN owner and return the resulting
 * list.
 *
 * Everything happens in one transaction: partially applying a batch would leave
 * the user looking at a list they did not ask for and, worse, leave the
 * registry describing a set of wallets nobody subscribed to.
 *
 * Order inside the transaction is deliberate — mutations, then the cap, then
 * the registry sync. Checking the cap first would let "remove one, add two"
 * pass on the pre-batch count; syncing the registry before the cap check would
 * write rows a rollback then has to take back.
 */
export async function applyWatchlistOps(
  pool: WatchlistPool,
  ownerWallet: string,
  ops: readonly WatchOp[],
): Promise<WatchSubscription[]> {
  const owner = ownerWallet.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialise every writer for this owner. The cap is a count-then-write, and
    // without the lock two concurrent batches each read 9 and each insert one.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`panik:watchlist:${owner}`]);

    const touched = new Set<string>();
    for (const op of ops) {
      touched.add(op.wallet);
      if (op.op === "remove") {
        await client.query(DELETE_SQL, [owner, op.wallet]);
        continue;
      }
      const labelGiven = Object.prototype.hasOwnProperty.call(op, "label");
      const label = labelGiven ? ((op as { label?: string | null }).label ?? null) : null;
      if (op.op === "add") {
        await client.query(UPSERT_SQL, [owner, op.wallet, op.profile, label, labelGiven]);
        continue;
      }
      const res = await client.query(UPDATE_SQL, [
        owner,
        op.wallet,
        op.profile ?? null,
        label,
        labelGiven,
      ]);
      // A no-op update is a caller who thinks they are watching something they
      // are not. Saying so beats returning a list that silently lacks it.
      if (!res.rowCount) {
        throw new WatchlistError(404, `not watching ${op.wallet}, so add it first`);
      }
    }

    const counted = await client.query<{ count: number }>(COUNT_SQL, [owner]);
    const total = Number(counted.rows[0]?.count ?? 0);
    if (total > WATCHLIST_MAX) {
      throw new WatchlistError(
        409,
        `watchlist holds ${WATCHLIST_MAX} wallets at most, and this change would leave ${total}`,
      );
    }

    // Re-derive the registry for every wallet the batch touched. Both
    // directions live in the same function: the last subscription leaving
    // deactivates the wallet, the first one arriving re-activates it.
    for (const wallet of touched) {
      await client.query("select public.watchlist_sync_registry($1)", [wallet]);
    }

    const { rows } = await client.query<SubscriptionRow>(LIST_SQL, [owner]);
    await client.query("commit");
    return rows.map(decode);
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // A rollback that fails means the connection is already gone, which
      // rolls back anyway. The original error is the one worth reporting.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Onboarding: create or refresh the caller's OWN self-subscription.
 *
 * This is what `POST /api/wallets/register` does now, and routing it through
 * `applyWatchlistOps` is the point — the registry sync, the cap and the
 * transaction are the same ones the batch endpoint gets, rather than a second
 * implementation in SQL that drifts. `label` is absent, never null: a re-onboard
 * must not blank the name the user chose.
 */
export async function registerSelfSubscription(
  pool: WatchlistPool,
  wallet: string,
  profile: RiskProfile,
): Promise<WatchSubscription[]> {
  const self = wallet.toLowerCase();
  return applyWatchlistOps(pool, self, [{ op: "add", wallet: self, profile }]);
}

// ── worker-side helpers ──────────────────────────────────────────────────────

/**
 * The DISTINCT profiles the worker must evaluate for one watched wallet.
 *
 * Scoring is per wallet; threshold evaluation is per profile. Ten subscribers
 * holding three different profiles is one chain read and three status
 * evaluations, not ten of either.
 *
 * `fallback` covers a registry row with no subscription at all — a state the
 * migration's backfill rules out but which a hand-edited row could still
 * produce. It falls back to the registry's OWN column rather than to a
 * hardcoded "moderate", because the registry column is the only thing that
 * knows anything about that wallet.
 */
export function subscriberProfiles(raw: unknown, fallback: RiskProfile): RiskProfile[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: RiskProfile[] = [];
  for (const value of list) {
    if (isRiskProfile(value) && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [fallback];
}
