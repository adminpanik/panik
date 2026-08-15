/**
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   SIGNATURES AUTHORIZE ACTIONS; SESSIONS ONLY RESTORE IDENTITY.
 *
 * A session says which wallet a browser is. It must never be what decides that
 * the browser may CHANGE something. The moment a mutating route starts reading
 * the cookie, a stolen 30-day session becomes the alert-redirect takeover that
 * single-use SIWE nonces were introduced to close — with a month-long window
 * instead of a five-minute one.
 *
 * That is a property of the whole API surface, not of any one function, so the
 * test is a scan of the real route table in scripts/api-server.ts. It is
 * deliberately blunt: a future PR that wires `readSession` into a POST fails
 * here, with this comment attached, whatever it was trying to accomplish.
 *
 * Source-scanning is the honest instrument. The alternative — booting the app —
 * is not available (importing scripts/api-server.ts calls app.listen and exits
 * on missing env), and a hand-built replica of the route would only prove the
 * replica safe. The scan reads the code that actually ships.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSession, readSession, type SessionQueryable } from "./sessionStore";
import { verifyWalletOwnership } from "./walletAuth";

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/api-server.ts", import.meta.url)),
  "utf8",
);

/** Anything that would mean "this handler consulted the caller's session". */
const SESSION_READERS = ["readSession", "presentedToken", "readCookie", "SESSION_COOKIE", "req.headers.cookie"];

/** The four routes that ARE the session surface, and may therefore read one. */
const SESSION_ROUTES = new Set([
  "post /api/session",
  "get /api/session",
  "delete /api/session",
  "post /api/session/exchange",
]);

interface Route {
  method: string;
  path: string;
  key: string;
  body: string;
}

/**
 * Every route in the file, with its handler body.
 *
 * A body ends at whichever comes first: the handler's own closing `});` at
 * column 0 (this file's consistent style for an inline handler), or the next
 * route registration (which is what terminates the one-line admin routes, whose
 * handlers are imported rather than inline).
 *
 * Taking only "up to the next registration" was WRONG and quietly so: helper
 * functions declared between two routes were attributed to the route above
 * them, which made this scan report the nonce route as reading a session
 * cookie. A body that over-reaches produces false positives now and, worse,
 * hides real ones behind a suppression someone eventually adds.
 */
function routes(): Route[] {
  const found: Route[] = [];
  const re = /^app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm;
  const starts: Array<{ method: string; path: string; at: number }> = [];
  for (const m of SERVER_SRC.matchAll(re)) {
    starts.push({ method: m[1]!, path: m[2]!, at: m.index! });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const nextStart = i + 1 < starts.length ? starts[i + 1]!.at : SERVER_SRC.length;
    const close = SERVER_SRC.indexOf("\n});", s.at);
    const end = close >= 0 ? Math.min(nextStart, close + 4) : nextStart;
    found.push({
      method: s.method,
      path: s.path,
      key: `${s.method} ${s.path}`,
      body: SERVER_SRC.slice(s.at, end),
    });
  }
  return found;
}

const ALL = routes();
const MUTATING = ALL.filter((r) => r.method !== "get" && r.path.startsWith("/api/"));

describe("the route table parsed for these assertions", () => {
  it("found the routes it is meant to be guarding", () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, which is the failure mode of every source-scanning test.
    expect(ALL.length).toBeGreaterThan(20);
    expect(MUTATING.length).toBeGreaterThan(8);
    const keys = ALL.map((r) => r.key);
    expect(keys).toContain("post /api/watchlist");
    expect(keys).toContain("post /api/wallets/register");
    expect(keys).toContain("post /api/telegram/link");
    for (const k of SESSION_ROUTES) expect(keys).toContain(k);
  });
});

describe("no session authorizes a write", () => {
  it("no mutating route reads the session cookie", () => {
    const offenders = MUTATING.filter(
      (r) => !SESSION_ROUTES.has(r.key) && SESSION_READERS.some((needle) => r.body.includes(needle)),
    ).map((r) => r.key);

    // If this fails: a POST/DELETE started consulting the session. Sessions
    // restore identity; they do not grant permission. Require the action's own
    // SIWE proof (server/walletAuth.ts) instead.
    expect(offenders).toEqual([]);
  });

  it("every wallet-scoped write still demands its own SIWE proof", () => {
    const expected: Record<string, string> = {
      "post /api/watchlist": '"watchlist-manage"',
      "post /api/wallets/register": '"wallet-register"',
      "post /api/telegram/link": '"telegram-link"',
    };
    for (const [key, action] of Object.entries(expected)) {
      const route = ALL.find((r) => r.key === key);
      expect(route, `${key} disappeared from the route table`).toBeDefined();
      expect(route!.body).toContain("verifyWalletOwnership(req.body,");
      expect(route!.body).toContain(action);
    }
  });

  it("the session routes are the ONLY place a session is read", () => {
    const readers = ALL.filter((r) => SESSION_READERS.some((n) => r.body.includes(n))).map((r) => r.key);
    // A SUBSET, not an equality. Two of the four session routes deliberately do
    // NOT read a cookie: POST /api/session establishes identity from a SIWE
    // proof, and the exchange establishes it from a body token. Demanding they
    // read one would be asserting a fact that is not true and not wanted.
    expect(readers.filter((k) => !SESSION_ROUTES.has(k))).toEqual([]);
    // Named explicitly so a route quietly gaining or losing a cookie read shows
    // up as a diff here rather than passing under a subset check.
    expect(new Set(readers)).toEqual(new Set(["get /api/session", "delete /api/session"]));
  });

  it("the cookie is read through exactly one helper", () => {
    // The scan above matches on names, so a SECOND way to reach the cookie —
    // a new helper with a new name — would be invisible to it. Pinning the
    // call site count means adding one forces a deliberate visit to this file.
    expect(SERVER_SRC.match(/readCookie\(/g)).toHaveLength(1);
    expect(SERVER_SRC.match(/req\.headers\.cookie/g)).toHaveLength(1);
  });

  it("all four session routes are strict-tiered", () => {
    // They mint rows, burn rows, or are an unauthenticated guess at a
    // credential. None is a cheap cached GET.
    for (const key of SESSION_ROUTES) {
      const route = ALL.find((r) => r.key === key)!;
      expect(route.body, `${key} is not strictLimit`).toContain("strictLimit");
    }
  });

  it("session-start mints only a session, never a subscription", () => {
    const mint = ALL.find((r) => r.key === "post /api/session")!;
    expect(mint.body).toContain('"session-start"');
    // The write helpers must not be reachable from the identity route.
    expect(mint.body).not.toContain("applyWatchlistOps");
    expect(mint.body).not.toContain("registerSelfSubscription");
  });
});

describe("a valid full session alone cannot write", () => {
  /** Records whether the write path ever asked the session store anything. */
  class WatchfulDb implements SessionQueryable {
    rows: Array<{ token_hash: string; owner_wallet: string; scope: string; expires_at: Date }> = [];
    consultedAfterArming = false;
    armed = false;

    async query<T = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount?: number | null }> {
      if (this.armed) this.consultedAfterArming = true;
      if (text.startsWith("insert into public.auth_sessions")) {
        this.rows.push({
          token_hash: String(values[0]),
          owner_wallet: String(values[1]),
          scope: String(values[2]),
          expires_at: new Date(String(values[3])),
        });
        return { rows: [] as T[], rowCount: 1 };
      }
      if (text.startsWith("select id, token_hash")) {
        const hit = this.rows.find((r) => r.token_hash === values[0]);
        return { rows: (hit ? [{ id: "s0", ...hit }] : []) as T[] };
      }
      return { rows: [] as T[], rowCount: 0 };
    }
  }

  it("POST /api/watchlist's auth check refuses a body with no proof, session or not", async () => {
    process.env.SIWE_ALLOWED_DOMAINS = "panik.fi";
    process.env.NODE_ENV = "test";

    const db = new WatchfulDb();
    const session = await createSession(db, "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222", "full");
    // Genuinely valid: this is what a signed-in browser holds.
    expect(await readSession(db, session.token)).toMatchObject({ scope: "full" });

    db.armed = true;
    // Exactly what the route runs. It reads req.body and nothing else — there
    // is no parameter through which a cookie could reach it.
    const check = await verifyWalletOwnership({ profile: "moderate" }, "watchlist-manage");

    expect(check.ok).toBe(false);
    expect(check.status).toBe(401);
    expect(check.error).toMatch(/proof/i);
    // The decisive assertion: holding a valid session did not even get the
    // store consulted, let alone consulted and believed.
    expect(db.consultedAfterArming).toBe(false);
  });

  it("a session for the right wallet does not satisfy the proof either", async () => {
    process.env.SIWE_ALLOWED_DOMAINS = "panik.fi";
    const db = new WatchfulDb();
    const wallet = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    const session = await createSession(db, wallet, "full");
    const identity = await readSession(db, session.token);

    // The strongest form of the temptation: the session names the very wallet
    // the caller wants to act as, and the body names it too. Still a 401 — the
    // wallet field is not a credential and never was.
    const check = await verifyWalletOwnership({ wallet: identity!.wallet }, "watchlist-manage");
    expect(check.ok).toBe(false);
    expect(check.status).toBe(401);
  });
});
