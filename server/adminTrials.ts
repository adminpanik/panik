/**
 * Forcibly ending a beta trial, for the operator.
 *
 * The QA case this exists for: a renewal flow can only be tested by somebody
 * whose trial has just run out, and waiting three days for one is not a test
 * plan. This ends a named account's live grant NOW, so the next redemption can
 * be exercised against the same address minutes later.
 *
 * ── WHAT "ENDED" MEANS, AND WHY IT IS TWO COLUMNS ─────────────────────────
 * `isLiveMembership` in server/accountStore.ts is THE definition of a live
 * grant and it is imported here rather than restated: status in
 * (trial, active) AND expires_at either absent or in the future. On that
 * definition alone, `expires_at = now()` would be enough.
 *
 * It is not enough, because of the OTHER rule the same row is subject to.
 * `uq_memberships_live_per_user` (supabase/migrations/20260816000001_accounts.sql)
 * is a unique index over `user_id` WHERE status in ('trial','active'). It
 * reads the status column and knows nothing about expiry. A row left at
 * 'trial' therefore keeps occupying the account's one live-grant slot after
 * its clock has run out, and the next `createMembership` for that account
 * comes back 409. Ending a trial in a way that blocks the very redemption the
 * ending was for would be a feature that does not work.
 *
 * So both columns move, and 'lapsed' is not invented for the occasion: the
 * migration defines it as "recorded history, grants nothing", which is exactly
 * what an operator-ended trial is. No new status value appears anywhere.
 *
 * ── THE WRITE IS FILTERED, NOT JUST TARGETED ──────────────────────────────
 * The PATCH carries `status=in.(trial,active)` alongside the row id, so two
 * operators pressing End on the same person leave one winner and one honest
 * "that account has no live trial": the database decides, not a read this
 * code did a moment earlier.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * No delete. The migration keeps lapsed rows on purpose ("a spent voucher must
 * not read as an unredeemed one"), and an operator tool that erases history to
 * make a test easier is how support loses the ability to answer questions.
 * The trial_grants row is left alone too: it is the campaign's own record of a
 * redemption, and the membership is what the beta gate reads.
 *
 * Reached only through the admin gate (server/adminGate.ts), from
 * `/api/admin/trials` in scripts/api-server.ts and its api/admin/trials.ts
 * mirror. Pure fetch over PostgREST + GoTrue with the service key, the same
 * shape as server/campaignStore.ts and server/accountStore.ts, so one module
 * serves the Railway Express server and the serverless mirror unchanged.
 */

import { isLiveMembership, type Membership, type MembershipStatus } from "./accountStore";

/**
 * PostgREST and GoTrue error bodies quote the failing SQL and, on an auth
 * failure, the project ref. They go to the server log, never into a thrown
 * message a route might echo. Same rule as server/campaignStore.ts.
 */
async function logErrorBody(
  scope: string,
  res: { status: number; text(): Promise<string> },
): Promise<void> {
  const body = await res.text().catch(() => "");
  console.error(`${scope}: HTTP ${res.status} ${body.slice(0, 300)}`);
}

/**
 * The status an ended grant lands on. One of the three the migration's CHECK
 * already allows, and the one it documents as "recorded history".
 */
const ENDED_STATUS: MembershipStatus = "lapsed";

/** GoTrue's admin listing is page/per_page and reports no total. */
const USER_PAGE = 200;

/**
 * How many pages of accounts the email lookup will walk before it gives up.
 * 200 x 20 = 4000 accounts. Running past it THROWS rather than answering "no
 * such account": a lookup that quietly stops looking would tell an operator
 * their user does not exist, which is a worse answer than an error.
 */
const USER_PAGE_MAX = 20;

/** One live grant, with the address it belongs to. No PII beyond the email. */
export interface TrialSummary {
  userId: string;
  email: string | null;
  membershipId: string;
  status: MembershipStatus;
  source: string;
  voucherCode: string | null;
  startedAt: string;
  expiresAt: string | null;
}

/** What the caller gets back after a successful end. */
export interface EndedTrial extends TrialSummary {
  /** When the operator ended it. Equal to the new `expires_at`. */
  endedAt: string;
}

export type EndTrialOutcome = "ended" | "missing_email" | "no_account" | "no_live_trial";

export type EndTrialResult =
  | { outcome: "ended"; trial: EndedTrial }
  | { outcome: Exclude<EndTrialOutcome, "ended"> };

/**
 * What each refusal answers with, status and sentence together so a new
 * outcome cannot be added without deciding both.
 *
 * "no account with that email" and "that account has no live trial" stay
 * DISTINCT. This route is behind the admin gate, so there is no stranger to
 * leak account existence to, and an operator who mistyped an address needs to
 * know which of the two they are looking at.
 */
export const END_TRIAL_REFUSAL: Record<
  Exclude<EndTrialOutcome, "ended">,
  { status: number; error: string }
> = {
  missing_email: { status: 400, error: "missing email" },
  no_account: { status: 404, error: "no account with that email" },
  no_live_trial: { status: 404, error: "that account has no live trial" },
};

interface RawMembership {
  id: string;
  user_id: string;
  status: MembershipStatus;
  source: string;
  voucher_code: string | null;
  started_at: string;
  expires_at: string | null;
}

const MEMBERSHIP_COLS = "id,user_id,status,source,voucher_code,started_at,expires_at";

/** The judged shape, for `isLiveMembership`. */
function asMembership(r: RawMembership): Membership {
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    voucherCode: r.voucher_code,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
  };
}

function asSummary(r: RawMembership, email: string | null): TrialSummary {
  return {
    userId: r.user_id,
    email,
    membershipId: r.id,
    status: r.status,
    source: r.source,
    voucherCode: r.voucher_code,
    startedAt: r.started_at,
    expiresAt: r.expires_at,
  };
}

/**
 * An address in the one shape it is compared in. GoTrue lowercases the address
 * it stores, and an operator pasting one out of a support thread should not
 * have to match its case or its surrounding whitespace.
 */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export class AdminTrialStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): AdminTrialStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new AdminTrialStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Every account, as id -> email, walked a page at a time.
   *
   * One request per 200 accounts rather than one per account: both callers
   * here need the mapping in BOTH directions (an address to end, and an id to
   * name in a list), and GoTrue offers no bulk id lookup. The walk stops on
   * the first short page, so a closed beta costs exactly one request.
   */
  private async userIndex(): Promise<Map<string, string | null>> {
    const index = new Map<string, string | null>();
    for (let page = 1; page <= USER_PAGE_MAX; page++) {
      const res = await fetch(
        `${this.base}/auth/v1/admin/users?page=${page}&per_page=${USER_PAGE}`,
        { headers: this.headers() },
      );
      if (!res.ok) {
        await logErrorBody("userIndex", res);
        throw new Error(`userIndex: HTTP ${res.status}`);
      }
      type RawUser = { id?: unknown; email?: unknown };
      const body = (await res.json()) as { users?: RawUser[] } | RawUser[];
      const raw = Array.isArray(body) ? body : (body.users ?? []);
      for (const u of raw) {
        if (typeof u.id !== "string") continue;
        index.set(u.id, typeof u.email === "string" ? u.email : null);
      }
      if (raw.length < USER_PAGE) return index;
    }
    // Every page came back full. Saying "not found" here would be a claim this
    // code cannot make, so it refuses instead and the route reports the reason.
    throw new Error(`userIndex: more than ${USER_PAGE_MAX * USER_PAGE} accounts to scan`);
  }

  /** The account holding this address, or null. Case and space insensitive. */
  async findUserByEmail(rawEmail: string): Promise<{ userId: string; email: string } | null> {
    const wanted = normalizeEmail(rawEmail);
    if (wanted === "") return null;
    for (const [userId, email] of await this.userIndex()) {
      if (email !== null && normalizeEmail(email) === wanted) return { userId, email };
    }
    return null;
  }

  /**
   * Every grant that is open right now, newest first, with the address it
   * belongs to.
   *
   * The console needs this to decide which rows may be ended: the Trials
   * roster and the voucher drill-down both list REDEMPTIONS, and a redemption
   * is not a membership: the grant's own clock says nothing about whether an
   * operator already ended the membership it produced. Rather than let two
   * panels guess from an expiry they happen to hold, the server states which
   * addresses are live and they look themselves up in it.
   *
   * Filtered in SQL on the same statuses the partial unique index covers, then
   * judged by `isLiveMembership` so a row whose clock has run out but whose
   * status was never rewritten is correctly reported as not live.
   */
  async liveTrials(now = Date.now()): Promise<TrialSummary[]> {
    const url =
      `${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}` +
      `&status=in.(trial,active)&order=created_at.desc`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("liveTrials", res);
      throw new Error(`liveTrials: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as RawMembership[];
    const open = rows.filter((r) => isLiveMembership(asMembership(r), now));
    if (open.length === 0) return [];
    const index = await this.userIndex();
    return open.map((r) => asSummary(r, index.get(r.user_id) ?? null));
  }

  /**
   * This account's live grant, or null. Same query and same judgement as
   * `AccountStore.liveMembership`, kept here only because the summary carries
   * the membership id the end write needs.
   */
  async liveTrialFor(userId: string, now = Date.now()): Promise<TrialSummary | null> {
    const url =
      `${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&status=in.(trial,active)&order=created_at.desc&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      await logErrorBody("liveTrialFor", res);
      throw new Error(`liveTrialFor: HTTP ${res.status}`);
    }
    const row = ((await res.json()) as RawMembership[])[0];
    if (!row) return null;
    return isLiveMembership(asMembership(row), now) ? asSummary(row, null) : null;
  }

  /**
   * Close one grant: 'lapsed', expiring now. Returns the updated row, or null
   * if the filter matched nothing, which is the same answer as "somebody else
   * ended it first", and is why the status filter is on the write rather than
   * only on the read above.
   */
  async endTrial(membershipId: string, at: string): Promise<TrialSummary | null> {
    const url =
      `${this.base}/rest/v1/memberships?select=${MEMBERSHIP_COLS}` +
      `&id=eq.${encodeURIComponent(membershipId)}&status=in.(trial,active)`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({ status: ENDED_STATUS, expires_at: at }),
    });
    if (!res.ok) {
      await logErrorBody("endTrial", res);
      throw new Error(`endTrial: HTTP ${res.status}`);
    }
    const row = ((await res.json()) as RawMembership[])[0];
    return row ? asSummary(row, null) : null;
  }
}

/** The parts of the store the decision below actually uses. */
export interface EndTrialDeps {
  findUserByEmail(email: string): Promise<{ userId: string; email: string } | null>;
  liveTrialFor(userId: string, now?: number): Promise<TrialSummary | null>;
  endTrial(membershipId: string, at: string): Promise<TrialSummary | null>;
}

export interface EndTrialInput {
  email: unknown;
  /** The signed-in operator, for the audit line. Null on the shared-secret path. */
  actor?: string | null;
  now?: number;
}

/**
 * End the named account's trial.
 *
 * Transport-free so both routes call one decision, and so the four answers can
 * be pinned without a database. The audit line is written HERE, on the success
 * path only, for the same reason: an operator action that removes somebody's
 * access has to leave a trace wherever it was invoked from.
 */
export async function endTrialForEmail(
  deps: EndTrialDeps,
  input: EndTrialInput,
): Promise<EndTrialResult> {
  const email = normalizeEmail(input.email);
  if (email === "") return { outcome: "missing_email" };

  const account = await deps.findUserByEmail(email);
  if (!account) return { outcome: "no_account" };

  const now = input.now ?? Date.now();
  const live = await deps.liveTrialFor(account.userId, now);
  if (!live) return { outcome: "no_live_trial" };

  const at = new Date(now).toISOString();
  const updated = await deps.endTrial(live.membershipId, at);
  // Lost the race to another operator (or another tab). The grant is closed
  // either way, and "somebody already did this" is the honest answer rather
  // than an error the caller cannot act on.
  if (!updated) return { outcome: "no_live_trial" };

  // The audit line. Address, account, grant, who did it and when, and no
  // token, no key and no voucher secret, because a log line is not a place to
  // move a credential.
  console.log(
    `admin trial end: ${account.email} (user ${account.userId}, membership ${updated.membershipId}) ` +
      `by ${input.actor ?? "shared-secret"} at ${at}`,
  );

  return { outcome: "ended", trial: { ...updated, email: account.email, endedAt: at } };
}
