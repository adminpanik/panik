import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ADMIN_EMAIL,
  allowedAdminEmail,
  bearerToken,
  verifyAdminIdentity,
} from "./adminIdentity";

const NOW = 1_800_000_000_000;

/** Build an UNSIGNED token with the given claims. Shape only; never valid. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.sig`;
}

const LIVE = fakeJwt({ exp: Math.floor(NOW / 1000) + 3600, email: DEFAULT_ADMIN_EMAIL });

function userResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function withEnv(extra: Record<string, string | undefined>): void {
  vi.stubEnv("SUPABASE_URL", extra.SUPABASE_URL ?? "https://proj.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", extra.SUPABASE_PUBLISHABLE_KEY ?? "pk_test");
  vi.stubEnv("ADMIN_ALLOWED_EMAIL", extra.ADMIN_ALLOWED_EMAIL ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bearerToken", () => {
  it("extracts the token regardless of header case", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("returns empty for an absent or non-bearer header", () => {
    expect(bearerToken(undefined)).toBe("");
    expect(bearerToken("Basic dXNlcjpwdw==")).toBe("");
    expect(bearerToken("Bearer   ")).toBe("");
  });
});

describe("allowedAdminEmail", () => {
  it("defaults to the founding admin address", () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAIL", "");
    expect(allowedAdminEmail()).toBe(DEFAULT_ADMIN_EMAIL);
  });

  it("honours the env override, normalized", () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAIL", "  Someone@Example.COM ");
    expect(allowedAdminEmail()).toBe("someone@example.com");
  });
});

describe("verifyAdminIdentity", () => {
  it("accepts a session Supabase resolves to the allowed address", async () => {
    withEnv({});
    const fetchSpy = vi.fn(async () =>
      userResponse({ id: "3ad213e2-d05d-404f-a0ef-ad249256d493", email: DEFAULT_ADMIN_EMAIL }),
    );
    const verdict = await verifyAdminIdentity(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: true, email: DEFAULT_ADMIN_EMAIL });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/auth/v1/user");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LIVE}`);
  });

  it("rejects a session belonging to any other address", async () => {
    withEnv({});
    const fetchSpy = vi.fn(async () => userResponse({ id: "u2", email: "someone@else.com" }));
    const verdict = await verifyAdminIdentity(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: false, status: 403, error: "this account is not an admin" });
  });

  // The whole point of the round trip: the claims in the token are the
  // attacker's text, and an unsigned token asserting the admin address must
  // lose to whatever Supabase says the session actually is.
  it("believes Supabase, not the token's own email claim", async () => {
    withEnv({});
    const forged = fakeJwt({ exp: Math.floor(NOW / 1000) + 3600, email: DEFAULT_ADMIN_EMAIL });
    const fetchSpy = vi.fn(async () => userResponse({ error: "bad jwt" }, 401));
    const verdict = await verifyAdminIdentity(forged, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
  });

  it("refuses an expired token without spending a round trip", async () => {
    withEnv({});
    const stale = fakeJwt({ exp: Math.floor(NOW / 1000) - 1, email: DEFAULT_ADMIN_EMAIL });
    const fetchSpy = vi.fn(async () => userResponse({}));
    const verdict = await verifyAdminIdentity(stale, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses malformed text without spending a round trip", async () => {
    withEnv({});
    const fetchSpy = vi.fn(async () => userResponse({}));
    for (const junk of ["", "not-a-jwt", "a.b", `a.${"x".repeat(5000)}.c`]) {
      const verdict = await verifyAdminIdentity(junk, { fetch: fetchSpy, now: () => NOW });
      expect(verdict.ok).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase is unreachable", async () => {
    withEnv({});
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const verdict = await verifyAdminIdentity(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict).toEqual({
      ok: false,
      status: 502,
      error: "could not reach the sign-in service",
    });
  });

  it("reports 503 when the project is not configured", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const fetchSpy = vi.fn(async () => userResponse({}));
    const verdict = await verifyAdminIdentity(LIVE, { fetch: fetchSpy, now: () => NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ status: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a user payload with no id or no email", async () => {
    withEnv({});
    for (const body of [{ email: DEFAULT_ADMIN_EMAIL }, { id: "u1" }, {}]) {
      const verdict = await verifyAdminIdentity(LIVE, {
        fetch: vi.fn(async () => userResponse(body)),
        now: () => NOW,
      });
      expect(verdict).toEqual({ ok: false, status: 401, error: "session expired or invalid" });
    }
  });

  it("matches the allowed address case-insensitively", async () => {
    withEnv({ ADMIN_ALLOWED_EMAIL: "Admin.Panik@Gmail.com" });
    const verdict = await verifyAdminIdentity(LIVE, {
      fetch: vi.fn(async () => userResponse({ id: "u1", email: "ADMIN.PANIK@GMAIL.COM" })),
      now: () => NOW,
    });
    expect(verdict).toEqual({ ok: true, email: "admin.panik@gmail.com" });
  });
});
