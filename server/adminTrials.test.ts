/**
 * Forcibly ending a trial.
 *
 * Two levels, for two different kinds of mistake:
 *
 *   endTrialForEmail   against fake deps - the four answers an operator can
 *                      get, and the fact that the audit line is written on the
 *                      success path and only there.
 *   AdminTrialStore    against a fake PostgREST / GoTrue, the same HTTP-boundary
 *                      harness server/accountStore.test.ts uses - what the
 *                      PATCH actually sends, and that the write is FILTERED on
 *                      the live statuses rather than only targeted by id.
 *
 * The load-bearing assertion is the status column. `isLiveMembership` would be
 * satisfied by expires_at alone, but `uq_memberships_live_per_user` is a
 * partial index over status in ('trial','active') and would keep the account's
 * one live-grant slot occupied - so the next redemption, which is the entire
 * reason for the feature, would 409. Both columns move, and neither may
 * quietly stop.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminTrialStore,
  END_TRIAL_REFUSAL,
  endTrialForEmail,
  normalizeEmail,
  type EndTrialDeps,
  type TrialSummary,
} from "./adminTrials";

const URL_BASE = "https://proj.supabase.co";
const USER = "3ad213e2-d05d-404f-a0ef-ad249256d493";
const EMAIL = "tester@panik.fi";
const NOW = 1_800_000_000_000;

const store = () => new AdminTrialStore(URL_BASE, "sk_test");

interface Reply {
  status?: number;
  body?: unknown;
}

/** Route a request by "METHOD url" to a canned reply. */
function routedFetch(routes: Array<[RegExp, Reply | ((url: string, init?: RequestInit) => Reply)]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const key = `${method} ${url}`;
    for (const [pattern, reply] of routes) {
      if (!pattern.test(key)) continue;
      const { status = 200, body = [] } = typeof reply === "function" ? reply(url, init) : reply;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }
    throw new Error(`unrouted request: ${key}`);
  });
  vi.stubGlobal("fetch", impl as unknown as typeof globalThis.fetch);
  return calls;
}

const rawMembership = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  user_id: USER,
  status: "trial",
  source: "voucher",
  voucher_code: "PANIK-TRY-ABCDEFGH",
  started_at: new Date(NOW - 86_400_000).toISOString(),
  expires_at: new Date(NOW + 86_400_000).toISOString(),
  ...over,
});

const summary = (over: Partial<TrialSummary> = {}): TrialSummary => ({
  userId: USER,
  email: null,
  membershipId: "m1",
  status: "trial",
  source: "voucher",
  voucherCode: "PANIK-TRY-ABCDEFGH",
  startedAt: new Date(NOW - 86_400_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  ...over,
});

/**
 * Deps that find the account, find a live grant, end it, and close the
 * campaign grant behind it. Overridable.
 */
function deps(over: Partial<EndTrialDeps> = {}): EndTrialDeps {
  return {
    findUserByEmail: vi.fn(async () => ({ userId: USER, email: EMAIL })),
    liveTrialFor: vi.fn(async () => summary()),
    endTrial: vi.fn(async (_id: string, at: string) =>
      summary({ status: "lapsed", expiresAt: at }),
    ),
    closeGrantFor: vi.fn(async () => true),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeEmail", () => {
  it("is case and whitespace insensitive, so a pasted address still resolves", () => {
    expect(normalizeEmail("  Tester@Panik.FI \n")).toBe(EMAIL);
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(null)).toBe("");
  });
});

describe("endTrialForEmail", () => {
  it("ends a live trial and reports the closed grant", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();

    const result = await endTrialForEmail(d, { email: `  ${EMAIL.toUpperCase()} `, actor: "ops@panik.fi", now: NOW });

    expect(result.outcome).toBe("ended");
    if (result.outcome !== "ended") throw new Error("unreachable");
    expect(result.trial.email).toBe(EMAIL);
    expect(result.trial.status).toBe("lapsed");
    // The expiry it reports IS the moment it was ended - one fact, not two
    // timestamps a reader has to reconcile.
    expect(result.trial.endedAt).toBe(new Date(NOW).toISOString());
    expect(result.trial.expiresAt).toBe(result.trial.endedAt);
    // The lookup is normalized before it reaches the store.
    expect(d.findUserByEmail).toHaveBeenCalledWith(EMAIL);

    // One audit line, naming who did it to whom - and carrying no credential.
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain(EMAIL);
    expect(line).toContain(USER);
    expect(line).toContain("ops@panik.fi");
    expect(line).not.toContain("PANIK-TRY-ABCDEFGH");
  });

  it("names the shared-secret caller rather than inventing an operator", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await endTrialForEmail(deps(), { email: EMAIL, now: NOW });
    expect(log.mock.calls[0]![0] as string).toContain("shared-secret");
  });

  it("answers no_live_trial when the account's grant is already over", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const endTrial = vi.fn();
    const result = await endTrialForEmail(
      deps({ liveTrialFor: vi.fn(async () => null), endTrial }),
      { email: EMAIL, now: NOW },
    );

    expect(result).toEqual({ outcome: "no_live_trial" });
    // Nothing was written, and an action that did not happen leaves no line.
    expect(endTrial).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("answers no_live_trial when another operator won the race to the write", async () => {
    // The read found a live grant; the filtered PATCH matched no row, because
    // somebody else lapsed it in between. Same answer, not an error.
    const result = await endTrialForEmail(deps({ endTrial: vi.fn(async () => null) }), {
      email: EMAIL,
      now: NOW,
    });
    expect(result).toEqual({ outcome: "no_live_trial" });
  });

  it("answers no_account for an address nobody holds", async () => {
    const liveTrialFor = vi.fn();
    const result = await endTrialForEmail(
      deps({ findUserByEmail: vi.fn(async () => null), liveTrialFor }),
      { email: "nobody@example.com", now: NOW },
    );
    expect(result).toEqual({ outcome: "no_account" });
    expect(liveTrialFor).not.toHaveBeenCalled();
  });

  it("refuses a missing or blank address before it looks anything up", async () => {
    const findUserByEmail = vi.fn();
    for (const email of [undefined, null, "", "   "]) {
      expect(await endTrialForEmail(deps({ findUserByEmail }), { email, now: NOW })).toEqual({
        outcome: "missing_email",
      });
    }
    expect(findUserByEmail).not.toHaveBeenCalled();
  });

  it("keeps the two 404s distinct, because an operator can act on the difference", () => {
    expect(END_TRIAL_REFUSAL.no_account.status).toBe(404);
    expect(END_TRIAL_REFUSAL.no_live_trial.status).toBe(404);
    expect(END_TRIAL_REFUSAL.no_account.error).not.toBe(END_TRIAL_REFUSAL.no_live_trial.error);
    expect(END_TRIAL_REFUSAL.missing_email.status).toBe(400);
  });
});

/**
 * The half added on 2026-09-01. `redeem_campaign_code` decides whether a code
 * is spent for an address from the GRANT's two clock columns and cannot see
 * memberships, so an operator ending a membership has to close the grant with
 * it. A grant left running behind an ended trial answers the next redemption
 * of the same card with "here is your token", which is the renewal loop the
 * whole change exists to close, reopened by the action meant to test it.
 */
describe("endTrialForEmail, closing the grant behind the membership", () => {
  it("closes the campaign grant with the same code, address and timestamp", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();

    const result = await endTrialForEmail(d, { email: EMAIL, now: NOW });

    expect(result.outcome).toBe("ended");
    expect(d.closeGrantFor).toHaveBeenCalledWith(
      "PANIK-TRY-ABCDEFGH",
      EMAIL,
      new Date(NOW).toISOString(),
    );
  });

  it("ends the membership FIRST, so a grant is never closed on a live trial", async () => {
    const order: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({
      endTrial: vi.fn(async (_id: string, at: string) => {
        order.push("membership");
        return summary({ status: "lapsed", expiresAt: at });
      }),
      closeGrantFor: vi.fn(async () => {
        order.push("grant");
        return true;
      }),
    });

    await endTrialForEmail(d, { email: EMAIL, now: NOW });
    expect(order).toEqual(["membership", "grant"]);
  });

  it("still reports the trial ended when the grant close fails, and logs it", async () => {
    // The operator asked for the access to stop and it has. Refusing here
    // would leave the trial running, which is strictly worse than a code that
    // can still be re-redeemed.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      closeGrantFor: vi.fn(async () => {
        throw new Error("PostgREST unreachable");
      }),
    });

    const result = await endTrialForEmail(d, { email: EMAIL, now: NOW });

    expect(result.outcome).toBe("ended");
    // The audit line is still written, and the failure is loud beside it.
    expect(log).toHaveBeenCalledTimes(1);
    const line = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("grant close FAILED");
    expect(line).toContain(EMAIL);
    expect(line).toContain("re-redeemed");
  });

  it("notes a grant that was not there rather than claiming one was closed", async () => {
    // Retention clears grants 30 days past expiry, and Clear use deletes them
    // outright, so a membership can outlive the row it was redeemed from.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ closeGrantFor: vi.fn(async () => false) });

    expect((await endTrialForEmail(d, { email: EMAIL, now: NOW })).outcome).toBe("ended");
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("no campaign grant to close");
  });

  it("looks for no grant when the membership carries no code", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps({
      endTrial: vi.fn(async (_id: string, at: string) =>
        summary({ status: "lapsed", expiresAt: at, voucherCode: null }),
      ),
    });

    expect((await endTrialForEmail(d, { email: EMAIL, now: NOW })).outcome).toBe("ended");
    expect(d.closeGrantFor).not.toHaveBeenCalled();
  });
});

describe("AdminTrialStore.closeGrantFor", () => {
  const grantRow = (over: Record<string, unknown> = {}) => ({
    id: "g1",
    email: EMAIL,
    first_opened_at: new Date(NOW - 3_600_000).toISOString(),
    expires_at: new Date(NOW + 86_400_000).toISOString(),
    created_at: new Date(NOW - 7_200_000).toISOString(),
    ...over,
  });

  it("runs the clock out without rewriting a real first open", async () => {
    const at = new Date(NOW).toISOString();
    const calls = routedFetch([
      [/^GET .*\/trial_grants/, { body: [grantRow()] }],
      [/^PATCH .*\/trial_grants/, { body: [{ id: "g1" }] }],
    ]);

    expect(await store().closeGrantFor("PANIK-TRY-ABCDEFGH", EMAIL, at)).toBe(true);

    const patch = calls[1]!;
    expect(patch.url).toContain("id=eq.g1");
    // The first open is the campaign's record of when the clock started and is
    // not an operator's to move; only the end of it is.
    expect(patch.body).toEqual({
      expires_at: at,
      first_opened_at: grantRow().first_opened_at,
    });
  });

  it("stamps a first open on a grant whose open never landed", async () => {
    // A closed clock with no start reads as "unopened", and an unopened grant
    // is judged LIVE by the redeem RPC, so the code would come straight back.
    const at = new Date(NOW).toISOString();
    const calls = routedFetch([
      [/^GET .*\/trial_grants/, { body: [grantRow({ first_opened_at: null, expires_at: null })] }],
      [/^PATCH .*\/trial_grants/, { body: [{ id: "g1" }] }],
    ]);

    await store().closeGrantFor("PANIK-TRY-ABCDEFGH", EMAIL, at);
    expect(calls[1]!.body).toEqual({ expires_at: at, first_opened_at: at });
  });

  it("is false, and writes nothing, when that address has no grant on the code", async () => {
    const calls = routedFetch([[/^GET .*\/trial_grants/, { body: [grantRow({ email: "someone@else.test" })] }]]);
    expect(await store().closeGrantFor("PANIK-TRY-ABCDEFGH", EMAIL, new Date(NOW).toISOString())).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("AdminTrialStore.endTrial", () => {
  it("writes BOTH columns and filters the write on the live statuses", async () => {
    const at = new Date(NOW).toISOString();
    const calls = routedFetch([
      [/^PATCH .*\/memberships/, { body: [rawMembership({ status: "lapsed", expires_at: at })] }],
    ]);

    const ended = await store().endTrial("m1", at);

    expect(ended?.status).toBe("lapsed");
    expect(ended?.expiresAt).toBe(at);

    const patch = calls[0]!;
    expect(patch.method).toBe("PATCH");
    // The status is not cosmetic: uq_memberships_live_per_user is a partial
    // index over status in ('trial','active'), so a row left at 'trial' keeps
    // blocking the next redemption however its expiry reads.
    expect(patch.body).toEqual({ status: "lapsed", expires_at: at });
    expect(patch.url).toContain("id=eq.m1");
    // The filter is what makes two operators pressing End safe.
    expect(patch.url).toContain("status=in.(trial,active)");
  });

  it("returns null when the filtered write matched nothing", async () => {
    routedFetch([[/^PATCH .*\/memberships/, { body: [] }]]);
    expect(await store().endTrial("m1", new Date(NOW).toISOString())).toBeNull();
  });

  it("throws rather than reporting a phantom success on an upstream failure", async () => {
    routedFetch([[/^PATCH .*\/memberships/, { status: 503, body: { message: "boom" } }]]);
    await expect(store().endTrial("m1", new Date(NOW).toISOString())).rejects.toThrow("HTTP 503");
  });
});

describe("AdminTrialStore.liveTrialFor", () => {
  it("finds the account's open grant and carries its membership id", async () => {
    routedFetch([[/^GET .*\/memberships\?/, { body: [rawMembership()] }]]);
    const live = await store().liveTrialFor(USER, NOW);
    expect(live?.membershipId).toBe("m1");
    expect(live?.userId).toBe(USER);
  });

  it("judges expiry rather than trusting the status column", async () => {
    // Still 'trial', but the clock ran out. isLiveMembership says no, so this
    // does too - the row is history that nothing has rewritten yet.
    routedFetch([
      [/^GET .*\/memberships\?/, { body: [rawMembership({ expires_at: new Date(NOW - 1).toISOString() })] }],
    ]);
    expect(await store().liveTrialFor(USER, NOW)).toBeNull();
  });

  it("does not treat an unparseable expiry as an unbounded grant", async () => {
    routedFetch([[/^GET .*\/memberships\?/, { body: [rawMembership({ expires_at: "whenever" })] }]]);
    expect(await store().liveTrialFor(USER, NOW)).toBeNull();
  });
});

describe("AdminTrialStore.findUserByEmail", () => {
  it("matches an address whatever its case, and pages until a short page", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.test` }));
    const calls = routedFetch([
      [/page=1/, { body: { users: page1 } }],
      [/page=2/, { body: { users: [{ id: USER, email: "Tester@Panik.FI" }] } }],
    ]);

    expect(await store().findUserByEmail("  TESTER@panik.fi ")).toEqual({
      userId: USER,
      email: "Tester@Panik.FI",
    });
    expect(calls).toHaveLength(2);
  });

  it("is null for an address nobody holds", async () => {
    routedFetch([[/page=1/, { body: { users: [{ id: USER, email: EMAIL }] } }]]);
    expect(await store().findUserByEmail("nobody@example.com")).toBeNull();
  });
});

describe("AdminTrialStore.liveTrials", () => {
  it("returns only the open grants, each with its address", async () => {
    routedFetch([
      [
        /^GET .*\/memberships\?/,
        {
          body: [
            rawMembership(),
            rawMembership({ id: "m2", user_id: "other", expires_at: new Date(NOW - 1).toISOString() }),
          ],
        },
      ],
      [
        /admin\/users/,
        { body: { users: [{ id: USER, email: EMAIL }, { id: "other", email: "gone@x.test" }] } },
      ],
    ]);

    const trials = await store().liveTrials(NOW);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.email).toBe(EMAIL);
    expect(trials[0]!.membershipId).toBe("m1");
  });

  it("spends no user lookup when nothing is open", async () => {
    const calls = routedFetch([[/^GET .*\/memberships\?/, { body: [] }]]);
    expect(await store().liveTrials(NOW)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

/**
 * The gate, on the route table that actually ships.
 *
 * Source-scanning for the reason server/accountRoutes.test.ts gives: importing
 * scripts/api-server.ts calls app.listen and exits on missing env, and a
 * hand-built replica would only prove the replica safe. This route WRITES, and
 * what it writes is somebody's access, so an unauthenticated twin of it is the
 * one failure worth a test that cannot be satisfied by a mock.
 */
const SERVER_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/api-server.ts", import.meta.url)),
  "utf8",
);
const API_MIRROR_SRC = readFileSync(
  fileURLToPath(new URL("../api/admin/trials.ts", import.meta.url)),
  "utf8",
);

describe("the end-trial route is admin-gated on both transports", () => {
  it("registers GET and POST behind adminBearerGate and adminLimit", () => {
    for (const method of ["get", "post"]) {
      expect(SERVER_SRC).toContain(
        `app.${method}("/api/admin/trials", adminLimit, adminBearerGate, adminTrials);`,
      );
    }
  });

  it("runs requireAdmin before it touches the store", () => {
    const handler = SERVER_SRC.slice(
      SERVER_SRC.indexOf("async function adminTrials("),
      SERVER_SRC.indexOf('app.get("/api/admin/users"'),
    );
    // The regex above must not have matched nothing.
    expect(handler.length).toBeGreaterThan(200);
    expect(handler.indexOf("requireAdmin(req, res)")).toBeGreaterThan(-1);
    expect(handler.indexOf("requireAdmin(req, res)")).toBeLessThan(
      handler.indexOf("AdminTrialStore.fromEnv()"),
    );
  });

  it("has no unauthenticated twin: the store is reached through that handler only", () => {
    expect(SERVER_SRC.match(/AdminTrialStore\.fromEnv\(\)/g)).toHaveLength(1);
    expect(SERVER_SRC.match(/endTrialForEmail\(/g)).toHaveLength(1);
  });

  it("names the signed-in operator as the actor, never a body field", () => {
    expect(SERVER_SRC).toContain("actor: typeof res.locals.adminEmail === \"string\"");
    expect(SERVER_SRC).not.toMatch(/actor:\s*(req\.)?body/);
  });

  it("gates the serverless mirror the same way, before it reads the body", () => {
    expect(API_MIRROR_SRC).toContain("authorizeAdminRequest(req.headers)");
    expect(API_MIRROR_SRC.indexOf("authorizeAdminRequest(req.headers)")).toBeLessThan(
      API_MIRROR_SRC.indexOf("AdminTrialStore.fromEnv()"),
    );
    expect(API_MIRROR_SRC).not.toMatch(/actor:\s*(req\.)?body/);
  });
});
