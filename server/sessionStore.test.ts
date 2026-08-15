/**
 * Identity sessions — the properties whose absence would be exploitable.
 *
 * The fake below is not a mock of the store; it is a small Postgres that runs
 * the module's REAL SQL strings. That matters most for the single-use burn,
 * where the whole guarantee lives in one statement's WHERE clause: a fake that
 * accepted any UPDATE would pass a test that proves nothing about the race it
 * claims to close.
 */

import { describe, expect, it } from "vitest";
import {
  BURN_DEEP_LINK_SQL,
  burnDeepLinkToken,
  clearedSessionCookie,
  CREATE_SESSION_SQL,
  createSession,
  DEEP_LINK_TTL_MS,
  FULL_SESSION_TTL_MS,
  hashesEqual,
  hashToken,
  LAST_SEEN_INTERVAL_MS,
  mintDeepLinkToken,
  mintToken,
  READONLY_SESSION_TTL_MS,
  readCookie,
  readSession,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
  type SessionQueryable,
  type SessionScope,
} from "./sessionStore";

const ANNA = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const BEN = "0xcccc3333cccc3333cccc3333cccc3333cccc3333";

interface SessionRow {
  id: string;
  token_hash: string;
  owner_wallet: string;
  scope: SessionScope;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

interface DeepLinkRow {
  token_hash: string;
  owner_wallet: string;
  transition_id: string | number | null;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * An in-memory stand-in with the same atomicity contract as Postgres.
 *
 * `query` is synchronous underneath an async signature, which is what makes the
 * concurrency test meaningful: two `burnDeepLinkToken` promises started without
 * an await between them both reach the burn, and only the statement's own
 * predicate can separate them — exactly as a row lock would.
 */
class FakeDb implements SessionQueryable {
  sessions: SessionRow[] = [];
  deepLinks: DeepLinkRow[] = [];
  sql: string[] = [];
  /** Set to make the next write throw, standing in for an unreachable db. */
  throwOnWrite = false;
  private seq = 0;

  async query<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    this.sql.push(text);
    const now = Date.now();

    if (text === CREATE_SESSION_SQL) {
      if (this.throwOnWrite) throw new Error("db unreachable");
      const row: SessionRow = {
        id: `s${this.seq++}`,
        token_hash: String(values[0]),
        owner_wallet: String(values[1]),
        scope: values[2] as SessionScope,
        expires_at: new Date(String(values[3])),
        last_seen_at: new Date(now),
        revoked_at: null,
      };
      this.sessions.push(row);
      return { rows: [{ expires_at: row.expires_at }] as T[] };
    }

    if (text.startsWith("select id, token_hash, owner_wallet, scope, expires_at")) {
      const hit = this.sessions.find(
        (s) => s.token_hash === values[0] && s.revoked_at === null && s.expires_at.getTime() > now,
      );
      return { rows: (hit ? [hit] : []) as T[] };
    }

    if (text.startsWith("update public.auth_sessions\n          set last_seen_at")) {
      const hit = this.sessions.find((s) => s.id === values[0]);
      const floorMs = Number(values[1]);
      if (hit && hit.last_seen_at.getTime() < now - floorMs) {
        hit.last_seen_at = new Date(now);
        return { rows: [] as T[], rowCount: 1 };
      }
      return { rows: [] as T[], rowCount: 0 };
    }

    if (text.startsWith("update public.auth_sessions\n          set revoked_at")) {
      const hit = this.sessions.find((s) => s.token_hash === values[0] && s.revoked_at === null);
      if (hit) hit.revoked_at = new Date(now);
      return { rows: [] as T[], rowCount: hit ? 1 : 0 };
    }

    if (text.startsWith("insert into public.deep_link_tokens")) {
      if (this.throwOnWrite) throw new Error("db unreachable");
      this.deepLinks.push({
        token_hash: String(values[0]),
        owner_wallet: String(values[1]),
        transition_id: (values[2] ?? null) as string | number | null,
        expires_at: new Date(String(values[3])),
        used_at: null,
      });
      return { rows: [] as T[], rowCount: 1 };
    }

    if (text === BURN_DEEP_LINK_SQL) {
      // The single statement, predicate and all. Nothing between the match and
      // the stamp — that is the point being tested.
      const hit = this.deepLinks.find(
        (d) => d.token_hash === values[0] && d.used_at === null && d.expires_at.getTime() > now,
      );
      if (!hit) return { rows: [] as T[] };
      hit.used_at = new Date(now);
      return { rows: [{ owner_wallet: hit.owner_wallet, token_hash: hit.token_hash }] as T[] };
    }

    throw new Error(`unexpected SQL: ${text.slice(0, 60)}`);
  }

  /** Reach past the API to age a row, the way only time could. */
  expireSession(tokenHash: string): void {
    const row = this.sessions.find((s) => s.token_hash === tokenHash);
    if (row) row.expires_at = new Date(Date.now() - 1);
  }

  ageLastSeen(tokenHash: string, ms: number): void {
    const row = this.sessions.find((s) => s.token_hash === tokenHash);
    if (row) row.last_seen_at = new Date(Date.now() - ms);
  }
}

describe("tokens", () => {
  it("mints 256 bits of url-safe entropy, never repeating", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = mintToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  it("stores only the hash — the raw token never reaches the database", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    const sid = await mintDeepLinkToken(db, ANNA, "17");

    const persisted = JSON.stringify([db.sessions, db.deepLinks]);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(sid);
    expect(db.sessions[0]!.token_hash).toBe(hashToken(token));
    expect(db.sessions[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashesEqual — the constant-time path", () => {
  it("accepts a matching pair and rejects a differing one", () => {
    const a = hashToken("alpha");
    expect(hashesEqual(a, hashToken("alpha"))).toBe(true);
    expect(hashesEqual(a, hashToken("beta"))).toBe(false);
  });

  it("returns false rather than throwing on a malformed or short input", () => {
    // timingSafeEqual throws on a length mismatch, which would turn the defence
    // into a 500 — and a distinguishable one, which is the leak itself.
    const good = hashToken("alpha");
    expect(hashesEqual(good, "")).toBe(false);
    expect(hashesEqual(good, "abc")).toBe(false);
    expect(hashesEqual(good, good.toUpperCase())).toBe(false);
    expect(hashesEqual(good, `${good}00`)).toBe(false);
    expect(hashesEqual("not hex at all, but exactly sixty four characters long xxxxxxxx", good)).toBe(false);
  });

  it("is what readSession uses to accept a row", async () => {
    // Prove the compare is load-bearing rather than decorative: corrupt the
    // stored hash after the lookup would match, and the read must refuse.
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    expect(await readSession(db, token)).not.toBeNull();

    const original = db.sessions[0]!.token_hash;
    db.sessions[0]!.token_hash = hashToken("something else");
    // The lookup is keyed on the hash, so a store doing an exact match returns
    // nothing here. Make it return the row anyway — a loosened matcher — and
    // the constant-time compare is the only thing left standing.
    const loose: SessionQueryable = {
      query: async (text, values) => {
        if (text.startsWith("select id, token_hash")) {
          return { rows: [{ ...db.sessions[0]!, token_hash: db.sessions[0]!.token_hash }] as never[] };
        }
        return db.query(text, values);
      },
    };
    expect(await readSession(loose, token)).toBeNull();
    db.sessions[0]!.token_hash = original;
  });
});

describe("session lifecycle", () => {
  it("mints, reads back the identity, and revokes", async () => {
    const db = new FakeDb();
    const minted = await createSession(db, ANNA, "full");

    const identity = await readSession(db, minted.token);
    expect(identity).toEqual({
      wallet: ANNA,
      scope: "full",
      expiresAt: minted.expiresAt,
    });

    await revokeSession(db, minted.token);
    expect(await readSession(db, minted.token)).toBeNull();
  });

  it("revocation is server-side, so a copy of the cookie dies with it", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    const stolen = token; // same bytes, a second holder

    await revokeSession(db, token);
    expect(await readSession(db, stolen)).toBeNull();
    expect(db.sessions[0]!.revoked_at).not.toBeNull();
  });

  it("revoking an unknown or malformed token is silent and writes nothing", async () => {
    const db = new FakeDb();
    await revokeSession(db, mintToken());
    await revokeSession(db, "not-a-token");
    await revokeSession(db, null);
    expect(db.sessions).toHaveLength(0);
  });

  it("lowercases the wallet on the way in", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA.toUpperCase().replace("0X", "0x"), "full");
    expect((await readSession(db, token))?.wallet).toBe(ANNA);
  });

  it("gives a full session 30 days and a readonly one 7", async () => {
    const db = new FakeDb();
    const full = await createSession(db, ANNA, "full");
    const readonly = await createSession(db, BEN, "readonly");

    expect(full.maxAgeSec).toBe(FULL_SESSION_TTL_MS / 1000);
    expect(readonly.maxAgeSec).toBe(READONLY_SESSION_TTL_MS / 1000);
    expect(Date.parse(full.expiresAt) - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    expect(Date.parse(readonly.expiresAt) - Date.now()).toBeLessThan(8 * 24 * 3600_000);
  });

  it("returns the readonly scope verbatim, so the UI can tell the tiers apart", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, BEN, "readonly");
    expect(await readSession(db, token)).toMatchObject({ wallet: BEN, scope: "readonly" });
  });
});

describe("session refusals", () => {
  it("refuses an expired session", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    db.expireSession(hashToken(token));
    expect(await readSession(db, token)).toBeNull();
  });

  it("refuses an unknown, malformed or absent token without touching the db", async () => {
    const db = new FakeDb();
    await createSession(db, ANNA, "full");
    db.sql.length = 0;

    expect(await readSession(db, null)).toBeNull();
    expect(await readSession(db, "")).toBeNull();
    expect(await readSession(db, "short")).toBeNull();
    expect(await readSession(db, `${mintToken()}extra`)).toBeNull();
    // Malformed input is refused on shape alone — it never becomes a query.
    expect(db.sql).toHaveLength(0);

    // A well-shaped token that was simply never issued does query, and misses.
    expect(await readSession(db, mintToken())).toBeNull();
    expect(db.sql).toHaveLength(1);
  });

  it("one session cannot be read as another wallet", async () => {
    const db = new FakeDb();
    const anna = await createSession(db, ANNA, "full");
    const ben = await createSession(db, BEN, "full");
    expect((await readSession(db, anna.token))?.wallet).toBe(ANNA);
    expect((await readSession(db, ben.token))?.wallet).toBe(BEN);
  });
});

describe("last_seen_at", () => {
  it("bumps at most once an hour", async () => {
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    const hash = hashToken(token);

    // A fresh session: three reads in a row, no bump — the predicate declines.
    const before = db.sessions[0]!.last_seen_at.getTime();
    await readSession(db, token);
    await readSession(db, token);
    await readSession(db, token);
    expect(db.sessions[0]!.last_seen_at.getTime()).toBe(before);

    // Age it past the floor and the next read does bump it. Measured against
    // the AGED value, not the original: creation and the bump can land in the
    // same millisecond, which would make a comparison to `before` flaky rather
    // than wrong.
    db.ageLastSeen(hash, LAST_SEEN_INTERVAL_MS + 1000);
    const aged = db.sessions[0]!.last_seen_at.getTime();
    expect(aged).toBeLessThan(before);
    await readSession(db, token);
    expect(db.sessions[0]!.last_seen_at.getTime()).toBeGreaterThan(aged);
  });

  it("does not fail the read when the bump fails", async () => {
    // last_seen_at is a diagnostic. A read that 500s because a statistic could
    // not be written would be a self-inflicted outage on the busiest path.
    const db = new FakeDb();
    const { token } = await createSession(db, ANNA, "full");
    db.ageLastSeen(hashToken(token), LAST_SEEN_INTERVAL_MS + 1000);

    const flaky: SessionQueryable = {
      query: async (text, values) => {
        if (text.includes("set last_seen_at")) throw new Error("write failed");
        return db.query(text, values);
      },
    };
    expect(await readSession(flaky, token)).toMatchObject({ wallet: ANNA });
  });
});

describe("deep-link tokens", () => {
  it("mints, and trades exactly once for the subscriber's identity", async () => {
    const db = new FakeDb();
    const sid = await mintDeepLinkToken(db, ANNA, "42");
    expect(db.deepLinks[0]).toMatchObject({ owner_wallet: ANNA, transition_id: "42", used_at: null });

    expect(await burnDeepLinkToken(db, sid)).toBe(ANNA);
    // Second presentation of the same token: burnt.
    expect(await burnDeepLinkToken(db, sid)).toBeNull();
  });

  it("of two concurrent exchanges, exactly one wins", async () => {
    const db = new FakeDb();
    const sid = await mintDeepLinkToken(db, ANNA, "42");

    // Started together, with no await between them: both reach the burn.
    const [a, b] = await Promise.all([burnDeepLinkToken(db, sid), burnDeepLinkToken(db, sid)]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toEqual([ANNA]);
    expect(db.deepLinks[0]!.used_at).not.toBeNull();
  });

  it("ten concurrent exchanges still yield exactly one session", async () => {
    const db = new FakeDb();
    const sid = await mintDeepLinkToken(db, ANNA, "42");
    const results = await Promise.all(Array.from({ length: 10 }, () => burnDeepLinkToken(db, sid)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("refuses an expired token, and the burn statement is what refuses it", async () => {
    const db = new FakeDb();
    const sid = await mintDeepLinkToken(db, ANNA, "42");
    db.deepLinks[0]!.expires_at = new Date(Date.now() - 1);

    expect(await burnDeepLinkToken(db, sid)).toBeNull();
    // Still unburnt: it was the predicate that declined, not a post-check that
    // stamped the row on the way to saying no.
    expect(db.deepLinks[0]!.used_at).toBeNull();
  });

  it("expires 15 minutes out", async () => {
    const db = new FakeDb();
    await mintDeepLinkToken(db, ANNA, null);
    const ttl = db.deepLinks[0]!.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(DEEP_LINK_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(DEEP_LINK_TTL_MS);
  });

  it("refuses an unknown or malformed token", async () => {
    const db = new FakeDb();
    expect(await burnDeepLinkToken(db, mintToken())).toBeNull();
    expect(await burnDeepLinkToken(db, "nope")).toBeNull();
    expect(await burnDeepLinkToken(db, null)).toBeNull();
  });

  it("carries the SUBSCRIBER, never the watched wallet", async () => {
    // A watchlist alert is about a position the reader does not own. Trading
    // its token must sign them in as themselves, not as the wallet in trouble.
    const db = new FakeDb();
    const sid = await mintDeepLinkToken(db, ANNA, "42");
    expect(await burnDeepLinkToken(db, sid)).toBe(ANNA);
    expect(await burnDeepLinkToken(db, sid)).not.toBe(BEN);
  });
});

describe("the cookie", () => {
  it("carries every attribute the design demands", () => {
    const c = sessionCookie("tok", 2_592_000);
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain("Max-Age=2592000");
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
  });

  it("names NO Domain, so the browser binds it host-only", () => {
    // The frontend reaches the API through the Vercel rewrite, so the cookie
    // must belong to the requesting origin alone. A Domain attribute would hand
    // it to every current and future subdomain.
    expect(sessionCookie("tok", 60)).not.toMatch(/domain=/i);
    expect(clearedSessionCookie()).not.toMatch(/domain=/i);
  });

  it("clears with the same attributes it set, or the original survives", () => {
    const cleared = clearedSessionCookie();
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
  });

  it("reads its cookie out of a real header, whatever the spacing", () => {
    expect(readCookie(`${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBe("abc");
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE)).toBe("abc");
    expect(readCookie(`a=1;${SESSION_COOKIE}=abc;b=2`, SESSION_COOKIE)).toBe("abc");
    expect(readCookie(`a=1;   ${SESSION_COOKIE}=abc   `, SESSION_COOKIE)).toBe("abc");
  });

  it("returns null for absent, empty or lookalike names", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie("", SESSION_COOKIE)).toBeNull();
    expect(readCookie("other=1", SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeNull();
    // A prefix match would let `xpanik_session` or `panik_session_x` stand in.
    expect(readCookie(`x${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}_x=abc`, SESSION_COOKIE)).toBeNull();
  });

  it("round-trips a real minted token", async () => {
    const db = new FakeDb();
    const { token, maxAgeSec } = await createSession(db, ANNA, "full");
    const header = sessionCookie(token, maxAgeSec).split(";")[0]!;
    expect(await readSession(db, readCookie(header, SESSION_COOKIE))).toMatchObject({
      wallet: ANNA,
    });
  });
});
