/**
 * The account boundary. Two questions, and the tests exist because confusing
 * them is the whole risk:
 *
 *   requireAccount  WHO is calling. A bearer Supabase does not recognise is a
 *                   401, and the token's own claims are never believed - the
 *                   verdict comes from /auth/v1/user, exactly as it does for
 *                   the admin surface.
 *
 *   requireMember   MAY THEY BE HERE YET. Signing in is not membership. During
 *                   the closed beta an account with no live grant gets 403 and
 *                   nothing else, and a TRIAL counts as a member - that was a
 *                   product decision, and a gate that quietly asked "paid?"
 *                   would lock out every card redeemer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOSED_BETA_MESSAGE,
  clearIdentityCache,
  isMember,
  requireAccount,
  requireMember,
  verifyAccountToken,
  type AccountContext,
} from "./accountAuth";
import type { AccountStore, Membership } from "./accountStore";

const NOW = 1_800_000_000_000;
const USER = "3ad213e2-d05d-404f-a0ef-ad249256d493";
const EMAIL = "beta@example.com";

/** Build an UNSIGNED token with the given claims. Shape only; never valid. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.sig`;
}

const LIVE = fakeJwt({ exp: Math.floor(NOW / 1000) + 3600, sub: USER });
const EXPIRED = fakeJwt({ exp: Math.floor(NOW / 1000) - 1, sub: USER });

function userResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const okUser = () => userResponse({ id: USER, email: EMAIL });

function membership(over: Partial<Membership> = {}): Membership {
  return {
    id: "m1",
    status: "trial",
    source: "voucher",
    voucherCode: "PANIK-TRY-ABCD",
    startedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    ...over,
  };
}

/** Just enough AccountStore for the middleware. Records what it was asked. */
function fakeStore(over: Partial<AccountStore> = {}): AccountStore {
  return {
    liveMembership: vi.fn(async () => null),
    ...over,
  } as unknown as AccountStore;
}

interface FakeRes {
  locals: Record<string, unknown>;
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    locals: {},
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const fakeReq = (authorization?: string) =>
  ({ header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined) }) as never;

beforeEach(() => {
  clearIdentityCache();
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "pk_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearIdentityCache();
});

describe("verifyAccountToken", () => {
  it("resolves the account Supabase says the token belongs to", async () => {
    const fetchSpy = vi.fn(async () => okUser());
    const verdict = await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: true, userId: USER, email: EMAIL });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/auth/v1/user");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LIVE}`);
  });

  it("believes Supabase, not the token's own claims", async () => {
    // The forged token asserts a subject. Supabase says no, and Supabase wins.
    const fetchSpy = vi.fn(async () => userResponse({ error: "bad jwt" }, 401));
    const verdict = await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
  });

  it("refuses an expired token without spending a round trip", async () => {
    const fetchSpy = vi.fn(async () => okUser());
    const verdict = await verifyAccountToken(EXPIRED, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses malformed text without spending a round trip", async () => {
    const fetchSpy = vi.fn(async () => okUser());
    for (const junk of ["", "not-a-jwt", "a.b", `a.${"x".repeat(5000)}.c`]) {
      expect((await verifyAccountToken(junk, { fetch: fetchSpy, now: () => NOW })).ok).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the sign-in service is unreachable", async () => {
    const verdict = await verifyAccountToken(LIVE, {
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      now: () => NOW,
    });
    expect(verdict).toEqual({ ok: false, status: 502, error: "could not reach the sign-in service" });
  });

  it("reports 503 when the project is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const fetchSpy = vi.fn(async () => okUser());
    expect(await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW })).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a user payload with no id or no email", async () => {
    for (const body of [{ email: EMAIL }, { id: USER }, {}]) {
      const verdict = await verifyAccountToken(LIVE, {
        fetch: vi.fn(async () => userResponse(body)),
        now: () => NOW,
      });
      expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
    }
  });

  it("reuses a resolved identity for the cache window, then re-asks", async () => {
    const fetchSpy = vi.fn(async () => okUser());
    await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW });
    await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW + 59_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW + 61_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("never caches past the token's own expiry", async () => {
    // A token with 10 seconds left must not be trusted for the full 60.
    const short = fakeJwt({ exp: Math.floor(NOW / 1000) + 10, sub: USER });
    const fetchSpy = vi.fn(async () => okUser());
    await verifyAccountToken(short, { fetch: fetchSpy, now: () => NOW });
    const verdict = await verifyAccountToken(short, { fetch: fetchSpy, now: () => NOW + 11_000 });
    // Past its exp the local screen refuses it outright — no second round trip,
    // and crucially not a cache hit either.
    expect(verdict.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("drops a cached identity the moment Supabase rejects the token", async () => {
    const fetchSpy = vi
      .fn(async () => okUser())
      .mockImplementationOnce(async () => okUser())
      .mockImplementationOnce(async () => userResponse({ error: "revoked" }, 401))
      .mockImplementationOnce(async () => userResponse({ error: "revoked" }, 401));
    expect((await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW })).ok).toBe(true);
    // Cache expires; the re-ask is refused and the stale entry must go with it.
    expect((await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW + 61_000 })).ok).toBe(false);
    expect((await verifyAccountToken(LIVE, { fetch: fetchSpy, now: () => NOW + 61_001 })).ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("isMember", () => {
  it("counts a live trial", () => {
    expect(isMember(membership({ status: "trial" }), NOW)).toBe(true);
  });

  it("counts an open-ended active membership", () => {
    expect(isMember(membership({ status: "active", expiresAt: null }), NOW)).toBe(true);
  });

  it("does not count a lapsed row, an expired one, or no row at all", () => {
    expect(isMember(membership({ status: "lapsed" }), NOW)).toBe(false);
    expect(isMember(membership({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(isMember(null, NOW)).toBe(false);
  });

  it("does not read an unparseable expiry as 'no expiry'", () => {
    // A malformed timestamp must not silently grant an unbounded membership.
    expect(isMember(membership({ expiresAt: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("requireAccount", () => {
  it("401s a request carrying no bearer, and never asks Supabase", async () => {
    const fetchSpy = vi.fn(async () => okUser());
    const res = fakeRes();
    const next = vi.fn();
    await requireAccount({ fetch: fetchSpy, store: fakeStore() })(fakeReq(), res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("401s a bearer Supabase does not recognise", async () => {
    const res = fakeRes();
    const next = vi.fn();
    await requireAccount({
      fetch: vi.fn(async () => userResponse({ error: "bad jwt" }, 401)),
      now: () => NOW,
      store: fakeStore(),
    })(fakeReq(`Bearer ${LIVE}`), res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("stamps identity and membership, and lets a member through", async () => {
    const live = membership();
    const res = fakeRes();
    const next = vi.fn();
    await requireAccount({
      fetch: vi.fn(async () => okUser()),
      now: () => NOW,
      store: fakeStore({ liveMembership: vi.fn(async () => live) }),
    })(fakeReq(`Bearer ${LIVE}`), res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.account).toEqual({ userId: USER, email: EMAIL, membership: live });
  });

  it("admits an account with NO membership - the beta gate is a separate step", async () => {
    // GET /api/account must answer a signed-in non-member, or the SPA cannot
    // render the screen that asks for a voucher.
    const res = fakeRes();
    const next = vi.fn();
    await requireAccount({
      fetch: vi.fn(async () => okUser()),
      now: () => NOW,
      store: fakeStore(),
    })(fakeReq(`Bearer ${LIVE}`), res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((res.locals.account as AccountContext).membership).toBeNull();
  });

  it("refuses rather than guesses when the membership lookup fails", async () => {
    // Failing open here would hand the closed beta to anyone who can make the
    // database blink.
    const res = fakeRes();
    const next = vi.fn();
    await requireAccount({
      fetch: vi.fn(async () => okUser()),
      now: () => NOW,
      store: fakeStore({
        liveMembership: vi.fn(async () => {
          throw new Error("PostgREST unreachable");
        }),
      }),
    })(fakeReq(`Bearer ${LIVE}`), res as never, next);
    expect(res.statusCode).toBe(502);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireMember", () => {
  const run = (account: AccountContext | undefined) => {
    const res = fakeRes();
    if (account) res.locals.account = account;
    const next = vi.fn();
    requireMember({} as never, res as never, next);
    return { res, next };
  };

  it("403s an account with no membership, and says how to fix it", () => {
    const { res, next } = run({ userId: USER, email: EMAIL, membership: null });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: CLOSED_BETA_MESSAGE });
    expect(next).not.toHaveBeenCalled();
  });

  it("403s an account whose membership has lapsed", () => {
    const { res, next } = run({
      userId: USER,
      email: EMAIL,
      membership: membership({ status: "lapsed" }),
    });
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a TRIAL through - a trial is a membership", () => {
    const { res, next } = run({ userId: USER, email: EMAIL, membership: membership() });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it("401s when requireAccount never ran, rather than assuming anything", () => {
    const { res, next } = run(undefined);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
