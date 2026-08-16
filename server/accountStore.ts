/**
 * Account data over the Supabase REST APIs. Pure fetch with the service key
 * (bypasses the deny-all RLS on memberships / account_wallets), mirroring
 * server/campaignStore.ts and server/telegramStore.ts. No `pg` and no
 * @supabase/supabase-js, so the same module serves the Railway Express server
 * and the api/ serverless mirror unchanged.
 *
 * Two upstreams, one key:
 *   /rest/v1/*             PostgREST, for the two tables this feature owns.
 *   /auth/v1/admin/users   GoTrue's admin listing, for the operator roster.
 *                          The SECRET key is required there and is exactly why
 *                          that call may only ever happen behind the admin gate.
 *
 * Tables + comments: supabase/migrations/20260816000001_accounts.sql.
 */

import { isEvmAddress } from "./profileDeps";

/**
 * PostgREST error bodies quote the failing SQL and, on an auth failure, the
 * project ref. They belong in the server log, never in a thrown message an
 * account-facing route might echo back. Same rule as server/campaignStore.ts.
 */
async function logErrorBody(scope: string, res: { status: number; text(): Promise<string> }): Promise<void> {
  const body = await res.text().catch(() => "");
  console.error(`${scope}: HTTP ${res.status} ${body.slice(0, 300)}`);
}

export type MembershipStatus = "trial" | "active" | "lapsed";

export interface Membership {
  id: string;
  status: MembershipStatus;
  source: string;
  voucherCode: string | null;
  startedAt: string;
  /** ISO timestamp, or null for a grant with no expiry. */
  expiresAt: string | null;
}

export interface AccountWallet {
  wallet: string;
  verifiedAt: string;
  createdAt: string;
}

/**
 * THE BODY GET /api/account ANSWERS WITH, as a type and as a builder.
 *
 * Six fields, and the SPA refuses the whole body if the ones it renders are
 * missing (lib/account.ts asAccount). The Express route and the dev mock both
 * hand-wrote it, which is a shape with two authors: a field renamed on one
 * side leaves `npm run dev:mock` exercising a screen against a body the
 * server does not send, and the mock is the only place most of these states
 * are ever seen.
 *
 * `voucherCode` is derived here rather than passed in, because it is not an
 * independent fact: it is the live grant's own code, surfaced so support can
 * match a person to a printed card without an admin round trip.
 */
export interface AccountResponse {
  account: { userId: string; email: string };
  /**
   * The server's verdict, stated rather than left for the client to derive
   * from the status string. `isLiveMembership` is the one place that decides
   * what counts, and a browser applying it would be a second copy.
   */
  member: boolean;
  membership: Membership | null;
  /**
   * Every grant this account has held, newest first, so the UI can say "your
   * trial ended on the 3rd" instead of rendering a stranger's empty state.
   */
  history: Membership[];
  wallets: AccountWallet[];
  voucherCode: string | null;
}

export function buildAccountResponse(fields: {
  userId: string;
  email: string;
  member: boolean;
  membership: Membership | null;
  history: Membership[];
  wallets: AccountWallet[];
}): AccountResponse {
  return {
    account: { userId: fields.userId, email: fields.email },
    member: fields.member,
    membership: fields.membership,
    history: fields.history,
    wallets: fields.wallets,
    voucherCode: fields.membership?.voucherCode ?? null,
  };
}

/** What POST /api/account/voucher inserts once the code has been validated. */
export interface NewMembership {
  userId: string;
  status: MembershipStatus;
  source: string;
  voucherCode?: string | null;
  expiresAt?: string | null;
}

/** One row of the admin roster. No PII beyond the email. */
export interface AccountSummary {
  userId: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  membership: Membership | null;
  /** How many wallets this account has proven it holds. Not the addresses. */
  walletCount: number;
  /** Whether ANY linked wallet has a Telegram chat attached. */
  telegramLinked: boolean;
}

export interface AccountPage {
  users: AccountSummary[];
  page: number;
  perPage: number;
  /** True when another page exists — GoTrue does not return a total. */
  hasMore: boolean;
}

/** Hard ceiling on the admin roster page size. */
export const ROSTER_PAGE_MAX = 200;
const ROSTER_PAGE_DEFAULT = 50;

/**
 * Is this grant open right now? THE definition of membership, in one place.
 * A trial counts — the closed-beta gate asks "trial or active and not past
 * expires_at", never "paid" (see the status comment in the migration).
 *
 * A row is judged, never rewritten: nothing flips `status` to 'lapsed' on read.
 * A read path that writes is a read path that fails under load and a cache that
 * cannot be trusted; the column records what an operator set, and expiry is
 * arithmetic anyone can redo.
 */
export function isLiveMembership(m: Membership, now = Date.now()): boolean {
  if (m.status !== "trial" && m.status !== "active") return false;
  if (m.expiresAt === null) return true;
  const at = Date.parse(m.expiresAt);
  // An unparseable expiry is NOT treated as "no expiry": a malformed timestamp
  // must not silently grant an unbounded membership.
  return Number.isFinite(at) && at > now;
}

interface RawMembership {
  id: string;
  status: MembershipStatus;
  source: string;
  voucher_code: string | null;
  started_at: string;
  expires_at: string | null;
}

const MEMBERSHIP_COLS = "id,status,source,voucher_code,started_at,expires_at";

function decodeMembership(r: RawMembership): Membership {
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    voucherCode: r.voucher_code,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
  };
}

/** Thrown when a write loses to the uniqueness the database enforces. */
export class AccountConflict extends Error {
  constructor(
    message: string,
    readonly kind: "membership-exists" | "wallet-taken",
  ) {
    super(message);
    this.name = "AccountConflict";
  }
}

export class AccountStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): AccountStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new AccountStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  // ── membership ────────────────────────────────────────────────────────────

  /**
   * The account's live grant, or null. Filtered in SQL on the same statuses the
   * partial unique index covers, so at most one row can come back; the expiry
   * is then judged here by isLiveMembership rather than in the query, because
   * "expired" and "never had one" are different answers and the caller may want
   * to tell the user which it is.
   */
  async liveMembership(userId: string, now = Date.now()): Promise<Membership | null> {
    const url =
      `${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&status=in.(trial,active)&order=created_at.desc&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("liveMembership", res);
      throw new Error(`liveMembership: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as RawMembership[];
    const row = rows[0];
    if (!row) return null;
    const membership = decodeMembership(row);
    return isLiveMembership(membership, now) ? membership : null;
  }

  /** Every grant this account has ever held, newest first (GET /api/account). */
  async membershipHistory(userId: string, limit = 20): Promise<Membership[]> {
    const url =
      `${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&order=created_at.desc&limit=${Math.max(1, Math.min(Math.floor(limit), 100))}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("membershipHistory", res);
      throw new Error(`membershipHistory: HTTP ${res.status}`);
    }
    return ((await res.json()) as RawMembership[]).map(decodeMembership);
  }

  /**
   * Insert a grant. A 409 means the partial unique index caught a concurrent
   * redemption for this account — surfaced as AccountConflict so the caller can
   * say "you already have one" rather than 502 at a user who is, in fact, in.
   */
  async createMembership(input: NewMembership): Promise<Membership> {
    const res = await fetch(`${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: input.userId,
        status: input.status,
        source: input.source,
        voucher_code: input.voucherCode ?? null,
        expires_at: input.expiresAt ?? null,
      }),
    });
    if (res.status === 409) {
      throw new AccountConflict("this account already has a membership", "membership-exists");
    }
    if (!res.ok) {
      await logErrorBody("createMembership", res);
      throw new Error(`createMembership: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as RawMembership[];
    const row = rows[0];
    if (!row) throw new Error("createMembership: insert returned no row");
    return decodeMembership(row);
  }

  // ── wallets ───────────────────────────────────────────────────────────────

  /** The wallets this account has proven it holds, oldest first. */
  async listWallets(userId: string): Promise<AccountWallet[]> {
    const url =
      `${this.base}/rest/v1/account_wallets?select=wallet,verified_at,created_at` +
      `&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("listWallets", res);
      throw new Error(`listWallets: HTTP ${res.status}`);
    }
    type Row = { wallet: string; verified_at: string; created_at: string };
    return ((await res.json()) as Row[]).map((r) => ({
      wallet: r.wallet,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * Record a proven wallet. Idempotent for the SAME account (re-proving simply
   * re-stamps verified_at); a 409 from another account's claim on the address
   * surfaces as AccountConflict, because "someone else has this" is a different
   * sentence to the user than "you already added it".
   *
   * The upsert targets the (user_id, wallet) primary key. That resolves the
   * self-conflict and leaves the wallet-only unique index to raise the real one.
   */
  async linkWallet(userId: string, wallet: string): Promise<AccountWallet> {
    const address = wallet.trim().toLowerCase();
    if (!isEvmAddress(address)) throw new Error("linkWallet: not an EVM address");
    const res = await fetch(
      `${this.base}/rest/v1/account_wallets?select=wallet,verified_at,created_at`,
      {
        method: "POST",
        headers: this.headers({
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify({
          user_id: userId,
          wallet: address,
          verified_at: new Date().toISOString(),
        }),
      },
    );
    if (res.status === 409) {
      throw new AccountConflict("that wallet is linked to another account", "wallet-taken");
    }
    if (!res.ok) {
      await logErrorBody("linkWallet", res);
      throw new Error(`linkWallet: HTTP ${res.status}`);
    }
    type Row = { wallet: string; verified_at: string; created_at: string };
    const rows = (await res.json()) as Row[];
    const row = rows[0];
    if (!row) throw new Error("linkWallet: upsert returned no row");
    return { wallet: row.wallet, verifiedAt: row.verified_at, createdAt: row.created_at };
  }

  /**
   * Remove one of THIS account's wallets. The user_id filter is the whole
   * authorization: an account can only ever delete a row it owns, so a caller
   * naming a stranger's address gets `false`, not a deletion.
   */
  async unlinkWallet(userId: string, wallet: string): Promise<boolean> {
    const address = wallet.trim().toLowerCase();
    if (!isEvmAddress(address)) return false;
    const url =
      `${this.base}/rest/v1/account_wallets?select=wallet` +
      `&user_id=eq.${encodeURIComponent(userId)}&wallet=eq.${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: this.headers({ Prefer: "return=representation" }),
    });
    if (!res.ok) {
      await logErrorBody("unlinkWallet", res);
      throw new Error(`unlinkWallet: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  }

  // ── admin roster ──────────────────────────────────────────────────────────

  /**
   * The operator's user list: every Supabase Auth account, joined with its
   * membership, its wallet COUNT and whether any of those wallets reaches
   * Telegram.
   *
   * Deliberately no wallet addresses and no chat ids. The question this answers
   * is "how many accounts are in the beta and are they reachable", and an
   * address list is a different, more sensitive question that the existing
   * campaign roster already covers for the people who redeemed a card.
   *
   * Four round trips, not four per user: one page of users, then one filtered
   * read each for memberships, wallets and links. GoTrue's admin listing is
   * page/per_page and reports no total, so `hasMore` is "the page came back
   * full", which is the honest answer rather than an invented count.
   */
  async listAccounts(opts: { page?: number; perPage?: number } = {}): Promise<AccountPage> {
    const page = Number.isFinite(opts.page) && (opts.page as number) >= 1 ? Math.floor(opts.page as number) : 1;
    const perPage = Number.isFinite(opts.perPage) && (opts.perPage as number) >= 1
      ? Math.min(Math.floor(opts.perPage as number), ROSTER_PAGE_MAX)
      : ROSTER_PAGE_DEFAULT;

    const res = await fetch(
      `${this.base}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      await logErrorBody("listAccounts", res);
      throw new Error(`listAccounts: HTTP ${res.status}`);
    }
    type RawUser = {
      id?: unknown;
      email?: unknown;
      created_at?: unknown;
      last_sign_in_at?: unknown;
    };
    const body = (await res.json()) as { users?: RawUser[] } | RawUser[];
    const rawUsers = Array.isArray(body) ? body : (body.users ?? []);
    const users = rawUsers.filter((u): u is RawUser & { id: string } => typeof u.id === "string");
    if (users.length === 0) {
      return { users: [], page, perPage, hasMore: false };
    }

    const ids = users.map((u) => u.id);
    const [memberships, wallets] = await Promise.all([
      this.membershipsFor(ids),
      this.walletsFor(ids),
    ]);
    const reachable = await this.telegramReachable([...new Set([...wallets.values()].flat())]);

    return {
      users: users.map((u) => {
        const owned = wallets.get(u.id) ?? [];
        return {
          userId: u.id,
          email: typeof u.email === "string" ? u.email : null,
          createdAt: typeof u.created_at === "string" ? u.created_at : null,
          lastSignInAt: typeof u.last_sign_in_at === "string" ? u.last_sign_in_at : null,
          membership: memberships.get(u.id) ?? null,
          walletCount: owned.length,
          telegramLinked: owned.some((w) => reachable.has(w)),
        };
      }),
      page,
      perPage,
      hasMore: users.length === perPage,
    };
  }

  /** Newest membership per account, live or lapsed — the roster wants both. */
  private async membershipsFor(userIds: string[]): Promise<Map<string, Membership>> {
    const url =
      `${this.base}/rest/v1/memberships?select=user_id,${MEMBERSHIP_COLS}` +
      `&user_id=in.(${userIds.map(encodeURIComponent).join(",")})` +
      `&order=created_at.desc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("membershipsFor", res);
      throw new Error(`membershipsFor: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as (RawMembership & { user_id: string })[];
    const out = new Map<string, Membership>();
    // Ordered newest-first, so the FIRST row seen per account is the one to
    // show. A live grant, when there is one, is by definition the newest.
    for (const row of rows) if (!out.has(row.user_id)) out.set(row.user_id, decodeMembership(row));
    return out;
  }

  private async walletsFor(userIds: string[]): Promise<Map<string, string[]>> {
    const url =
      `${this.base}/rest/v1/account_wallets?select=user_id,wallet` +
      `&user_id=in.(${userIds.map(encodeURIComponent).join(",")})`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("walletsFor", res);
      throw new Error(`walletsFor: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as { user_id: string; wallet: string }[];
    const out = new Map<string, string[]>();
    for (const row of rows) out.set(row.user_id, [...(out.get(row.user_id) ?? []), row.wallet]);
    return out;
  }

  /**
   * Which of these wallets have an ENABLED Telegram link.
   *
   * `enabled` is part of the question on purpose: a row whose user sent /stop,
   * or that Telegram told us is blocked, is a link that delivers nothing, and
   * an operator reading "Telegram: yes" next to an account that cannot receive
   * a liquidation warning is worse off than one reading "no".
   */
  private async telegramReachable(wallets: string[]): Promise<Set<string>> {
    if (wallets.length === 0) return new Set();
    const url =
      `${this.base}/rest/v1/telegram_links?select=wallet` +
      `&wallet=in.(${wallets.map(encodeURIComponent).join(",")})&enabled=is.true`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("telegramReachable", res);
      throw new Error(`telegramReachable: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as { wallet: string }[];
    return new Set(rows.map((r) => r.wallet));
  }
}
