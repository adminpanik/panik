/**
 * AccountStore against a fake PostgREST / GoTrue, mocked at the HTTP boundary
 * the way server/metricsStore.test.ts and server/campaignStore's callers do.
 *
 * What is worth pinning here:
 *   - the two uniqueness rules the migration encodes surface as AccountConflict
 *     rather than a 502, because "you already have one" and "that wallet belongs
 *     to someone else" are answers a user can act on;
 *   - unlink is filtered by user_id, so naming a stranger's address deletes
 *     nothing - that filter IS the authorization;
 *   - the admin roster carries a COUNT of wallets and no addresses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountConflict, AccountStore, isLiveMembership, type Membership } from "./accountStore";

const URL_BASE = "https://proj.supabase.co";
const USER = "3ad213e2-d05d-404f-a0ef-ad249256d493";
const OTHER = "9f0b1c22-7777-4444-8888-aaaabbbbcccc";
const WALLET = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";

const store = () => new AccountStore(URL_BASE, "sk_test");

const NOW = 1_800_000_000_000;

interface Reply {
  status?: number;
  body?: unknown;
}

/** Route a request by "METHOD path?query" to a canned reply. */
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
  status: "trial",
  source: "voucher",
  voucher_code: "PANIK-TRY-ABCD",
  started_at: new Date(NOW).toISOString(),
  expires_at: new Date(NOW + 86_400_000).toISOString(),
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLiveMembership", () => {
  const m = (over: Partial<Membership>): Membership => ({
    id: "m1",
    status: "trial",
    source: "voucher",
    voucherCode: null,
    startedAt: new Date(NOW).toISOString(),
    expiresAt: null,
    ...over,
  });

  it("accepts trial and active, refuses lapsed", () => {
    expect(isLiveMembership(m({ status: "trial" }), NOW)).toBe(true);
    expect(isLiveMembership(m({ status: "active" }), NOW)).toBe(true);
    expect(isLiveMembership(m({ status: "lapsed" }), NOW)).toBe(false);
  });

  it("refuses a grant past its expiry and accepts one with none", () => {
    expect(isLiveMembership(m({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(isLiveMembership(m({ expiresAt: new Date(NOW + 1).toISOString() }), NOW)).toBe(true);
    expect(isLiveMembership(m({ expiresAt: null }), NOW)).toBe(true);
  });
});

describe("liveMembership", () => {
  it("filters on the live statuses in SQL and decodes the row", async () => {
    routedFetch([[/^GET .*\/memberships\?/, { body: [rawMembership()] }]]);
    const found = await store().liveMembership(USER, NOW);
    expect(found).toMatchObject({ id: "m1", status: "trial", voucherCode: "PANIK-TRY-ABCD" });
    const [call] = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(call![0])).toContain("status=in.(trial,active)");
    expect(String(call![0])).toContain(`user_id=eq.${USER}`);
  });

  it("returns null when there is no row", async () => {
    routedFetch([[/^GET .*\/memberships\?/, { body: [] }]]);
    expect(await store().liveMembership(USER, NOW)).toBeNull();
  });

  it("returns null for a row whose expiry has passed", async () => {
    // The status filter is SQL's; the clock is ours, and a stale row must not
    // read as a live grant just because nothing has flipped it to 'lapsed'.
    routedFetch([
      [/^GET .*\/memberships\?/, { body: [rawMembership({ expires_at: new Date(NOW - 1).toISOString() })] }],
    ]);
    expect(await store().liveMembership(USER, NOW)).toBeNull();
  });

  it("throws on an error status rather than reporting 'no membership'", async () => {
    // A silent null here would 403 a paying member on a transient blip.
    routedFetch([[/^GET .*\/memberships\?/, { status: 500, body: { message: "boom" } }]]);
    await expect(store().liveMembership(USER, NOW)).rejects.toThrow(/HTTP 500/);
  });
});

describe("createMembership", () => {
  it("inserts the grant and returns the decoded row", async () => {
    const calls = routedFetch([[/^POST .*\/memberships\?/, { status: 201, body: [rawMembership()] }]]);
    const created = await store().createMembership({
      userId: USER,
      status: "trial",
      source: "voucher",
      voucherCode: "PANIK-TRY-ABCD",
      expiresAt: new Date(NOW + 1000).toISOString(),
    });
    expect(created.status).toBe("trial");
    expect(calls[0]!.body).toMatchObject({ user_id: USER, status: "trial", source: "voucher" });
  });

  it("turns the one-live-membership index into an AccountConflict", async () => {
    routedFetch([[/^POST .*\/memberships\?/, { status: 409, body: { message: "duplicate key" } }]]);
    await expect(
      store().createMembership({ userId: USER, status: "trial", source: "voucher" }),
    ).rejects.toBeInstanceOf(AccountConflict);
  });
});

describe("linkWallet", () => {
  it("upserts on (user_id, wallet) and lowercases the address", async () => {
    const calls = routedFetch([
      [
        /^POST .*\/account_wallets\?/,
        { status: 201, body: [{ wallet: WALLET, verified_at: "t0", created_at: "t0" }] },
      ],
    ]);
    const linked = await store().linkWallet(USER, WALLET.toUpperCase().replace("0X", "0x"));
    expect(linked.wallet).toBe(WALLET);
    expect(calls[0]!.body).toMatchObject({ user_id: USER, wallet: WALLET });
    expect(String(calls[0]!.url)).toContain("account_wallets");
  });

  it("turns another account's claim on the address into an AccountConflict", async () => {
    routedFetch([[/^POST .*\/account_wallets\?/, { status: 409, body: { message: "duplicate key" } }]]);
    await expect(store().linkWallet(USER, WALLET)).rejects.toMatchObject({
      name: "AccountConflict",
      kind: "wallet-taken",
    });
  });

  it("refuses anything that is not an EVM address before it reaches SQL", async () => {
    routedFetch([]);
    await expect(store().linkWallet(USER, "not-a-wallet")).rejects.toThrow(/EVM/);
  });
});

describe("unlinkWallet", () => {
  it("filters the DELETE by user_id - that filter IS the authorization", async () => {
    const calls = routedFetch([[/^DELETE .*\/account_wallets\?/, { body: [{ wallet: WALLET }] }]]);
    expect(await store().unlinkWallet(USER, WALLET)).toBe(true);
    expect(calls[0]!.url).toContain(`user_id=eq.${USER}`);
    expect(calls[0]!.url).toContain(`wallet=eq.${encodeURIComponent(WALLET)}`);
  });

  it("reports false when the row was not this account's to delete", async () => {
    routedFetch([[/^DELETE .*\/account_wallets\?/, { body: [] }]]);
    expect(await store().unlinkWallet(USER, WALLET)).toBe(false);
  });

  it("never sends a malformed address as a filter", async () => {
    routedFetch([]);
    expect(await store().unlinkWallet(USER, "0xnope")).toBe(false);
  });
});

describe("listAccounts", () => {
  const roster = () =>
    routedFetch([
      [
        /^GET .*\/auth\/v1\/admin\/users/,
        {
          body: {
            users: [
              { id: USER, email: "beta@example.com", created_at: "t1", last_sign_in_at: "t2" },
              { id: OTHER, email: "nobody@example.com", created_at: "t3", last_sign_in_at: null },
            ],
          },
        },
      ],
      [/^GET .*\/memberships\?/, { body: [{ user_id: USER, ...rawMembership() }] }],
      [
        /^GET .*\/account_wallets\?/,
        { body: [{ user_id: USER, wallet: WALLET }, { user_id: USER, wallet: `0xbbbb${"2".repeat(36)}` }] },
      ],
      [/^GET .*\/telegram_links\?/, { body: [{ wallet: WALLET }] }],
    ]);

  it("joins membership, wallet count and Telegram reachability per account", async () => {
    roster();
    const page = await store().listAccounts({ page: 1, perPage: 50 });
    expect(page.users).toHaveLength(2);
    expect(page.users[0]).toMatchObject({
      userId: USER,
      email: "beta@example.com",
      live: true,
      walletCount: 2,
      telegramLinked: true,
    });
    expect(page.users[0]!.membership).toMatchObject({ status: "trial", voucherCode: "PANIK-TRY-ABCD" });
    expect(page.users[1]).toMatchObject({
      userId: OTHER,
      membership: null,
      live: false,
      walletCount: 0,
      telegramLinked: false,
    });
  });

  it("carries no PII beyond the email - no addresses, no chat ids", async () => {
    roster();
    const page = await store().listAccounts();
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(WALLET);
    expect(Object.keys(page.users[0]!).sort()).toEqual([
      "createdAt",
      "email",
      "lastSignInAt",
      "live",
      "membership",
      "telegramLinked",
      "userId",
      "walletCount",
    ]);
  });

  it("only counts an ENABLED Telegram link as reachable", async () => {
    const calls = roster();
    await store().listAccounts();
    const link = calls.find((c) => c.url.includes("telegram_links"))!;
    expect(link.url).toContain("enabled=is.true");
  });

  it("clamps the page size and reports hasMore from a full page", async () => {
    routedFetch([
      [/^GET .*\/auth\/v1\/admin\/users/, { body: { users: [{ id: USER, email: "a@b.c" }] } }],
      [/^GET .*\/memberships\?/, { body: [] }],
      [/^GET .*\/account_wallets\?/, { body: [] }],
    ]);
    const page = await store().listAccounts({ page: 2, perPage: 9_999 });
    expect(page.perPage).toBe(200);
    expect(page.page).toBe(2);
    // One user came back for a 200-wide page, so there is nothing after it.
    expect(page.hasMore).toBe(false);
  });

  it("does not fan out per user when the page is empty", async () => {
    const calls = routedFetch([[/^GET .*\/auth\/v1\/admin\/users/, { body: { users: [] } }]]);
    const page = await store().listAccounts();
    expect(page.users).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
