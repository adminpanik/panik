/**
 * Identity sessions — the thing that lets a returning browser be recognised
 * without a wallet popup, and the thing that must never be mistaken for
 * authorization.
 *
 * ── THE PRINCIPLE, IN ONE LINE ─────────────────────────────────────────────
 * SIGNATURES AUTHORIZE ACTIONS; SESSIONS ONLY RESTORE IDENTITY.
 *
 * A session answers "which wallet is this browser?" and stops there. Every
 * wallet-scoped write — the watchlist batch, the Telegram link, the wallet
 * registration — still demands its own single-use SIWE proof bound to its own
 * action URN, on every request, exactly as it did before sessions existed
 * (server/walletAuth.ts). Nothing in this module is consulted by any of them,
 * and server/sessionBoundary.test.ts fails the build if that ever changes.
 *
 * That containment is what makes a 30-day cookie a defensible thing to issue.
 * Invert it — let the session authorize writes — and a stolen cookie becomes
 * the alert-redirect takeover that the single-use nonce work closed, except now
 * with a month-long window instead of a five-minute one. The blast radius of
 * losing a session cookie is therefore: someone sees which wallet you watch.
 * Not: someone redirects your liquidation alerts.
 *
 * ── TWO TIERS, TWO HONEST LIFETIMES ────────────────────────────────────────
 *   full (30d)      minted from a SIWE proof of `session-start`. The holder
 *                   demonstrably controls the wallet's key.
 *   readonly (7d)   traded from a Telegram alert deep-link token. The holder
 *                   demonstrably reads the chat the alerts go to — which is a
 *                   real claim, and a weaker one. Shorter, and separately
 *                   labelled so the UI can ask for a signature when it needs
 *                   more than a name.
 *
 * The scope is NOT a write permission ladder. Both scopes authorize exactly
 * nothing; the distinction exists so the product can tell a visitor the truth
 * about how it knows who they are.
 *
 * ── TOKENS ARE NEVER STORED RAW ────────────────────────────────────────────
 * 256 bits from crypto.randomBytes, handed out once, stored only as SHA-256.
 * A read of the database yields nothing replayable. Comparison is
 * constant-time (see hashesEqual) — the lookup is already by hash, so this is
 * belt-and-braces against a store that ever grows a prefix or pattern match,
 * but it is cheap and it is the line that decides acceptance.
 *
 * ── WHY pg AND NOT THE SUPABASE REST TRANSPORT ─────────────────────────────
 * server/nonceStore.ts goes over PostgREST because it also serves the Vercel
 * functions. These routes are Express-only (api/ is vercelignored), and the
 * single-use burn below wants `update ... where used_at is null returning`,
 * which is one statement in SQL and a race in PostgREST. The client is an
 * interface rather than a `pg` import so the tests can run the REAL statements
 * against a recording fake, the same shape server/watchDispatch.ts uses.
 *
 * Tables: supabase/migrations/20260815000001_auth_sessions.sql.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The slice of `pg.Pool` this module uses. */
export interface SessionQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** What a session says about its holder. Never a write permission. */
export type SessionScope = "full" | "readonly";

/**
 * Cookie name. Prefixed `__Host-`? No — deliberately not.
 *
 * `__Host-` would be a real upgrade (it forces Secure, Path=/ and no Domain at
 * the browser level, which is exactly our shape). It is rejected here because
 * the API is reached through the Vercel rewrite from www.panik.fi AND directly
 * on the Railway origin during ops work, and a `__Host-` cookie set on one is
 * silently dropped by any request that is not an exact host match — a failure
 * mode that reads as "sign-in randomly does not stick". The attributes below
 * are set explicitly instead, which gets the same guarantees without the cliff.
 */
export const SESSION_COOKIE = "panik_session";

/** A wallet signature is strong evidence, and re-signing monthly is tolerable. */
export const FULL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Reading the alert chat is weaker evidence, so it buys less time. */
export const READONLY_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a Telegram deep-link token stays tradeable.
 *
 * Fifteen minutes, matching the Telegram link code. It is the gap between an
 * alert arriving and a worried person tapping it, and nothing more: the token
 * sits in a chat history forever, so its lifetime is the whole of its exposure.
 */
export const DEEP_LINK_TTL_MS = 15 * 60 * 1000;
/**
 * Floor between `last_seen_at` bumps.
 *
 * The dashboard polls. Without this, every poll turns a pure read into a row
 * write, which is a self-inflicted write amplification on the busiest path in
 * the app for a column nothing makes a decision on.
 */
export const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

/** Bytes of entropy per token. 32 = 256 bits; guessing is not a threat model. */
const TOKEN_BYTES = 32;

/** base64url of 32 bytes is always 43 chars, no padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** What a caller learns about the session it presented. */
export interface SessionIdentity {
  wallet: string;
  scope: SessionScope;
  /** ISO 8601. */
  expiresAt: string;
}

/**
 * Mint a fresh opaque token. Returned ONCE; only its hash is ever persisted.
 * base64url so it survives a cookie value and a query string unescaped.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256, lowercase hex — the only form that reaches the database. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time hash comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be the leak
 * it exists to prevent, so both sides are shape-checked first and a mismatch is
 * a plain false. Both inputs are our own 64-char hex by construction; anything
 * else is a corrupt row or a caller bug, and both mean "no".
 */
export function hashesEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ── the cookie ──────────────────────────────────────────────────────────────

/**
 * One cookie out of a raw `Cookie:` header.
 *
 * Hand-rolled rather than adding `cookie-parser`: the app parses exactly one
 * cookie, on four routes, and a dependency in the auth path has to earn more
 * than eight lines. Splits on ";", takes the FIRST match (browsers send the
 * most specific path first), and tolerates the whitespace variance real clients
 * emit. No decoding beyond trimming — our token is base64url, which is already
 * cookie-safe, and running decodeURIComponent over attacker-supplied bytes to
 * then compare against a hash buys nothing but a throw to catch.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * The Set-Cookie value for a live session.
 *
 * NO `Domain` ATTRIBUTE, AND THAT IS THE LOAD-BEARING PART. The frontend
 * reaches this API through the Vercel rewrite (www.panik.fi/api/* -> Railway),
 * so the browser believes the cookie came from www.panik.fi and, absent a
 * Domain, binds it HOST-ONLY to exactly that origin. Adding `Domain=panik.fi`
 * would widen it to every present and future subdomain — a preview deploy, a
 * docs site, a marketing page, anything that ever gets a hostname — and each
 * one of those becomes a place a session cookie can leak from. Host-only is
 * both the tighter choice and the one that actually matches how the request
 * arrives.
 *
 * The rest:
 *   HttpOnly   script cannot read it, so an XSS bug cannot exfiltrate it
 *   Secure     https only; browsers exempt http://localhost, so dev is fine
 *   SameSite=Lax  sent on top-level navigation (the Telegram button lands on a
 *              GET, which must be recognised) but not on cross-site subrequests
 *   Path=/     the app and the API share an origin through the rewrite
 */
export function sessionCookie(token: string, maxAgeSec: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * The Set-Cookie value that removes it. Same attributes as the setter — a
 * browser matches a deletion on name+path+domain, so a clear that forgets
 * `Path=/` leaves the original cookie sitting there, still being sent.
 */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// ── sessions ────────────────────────────────────────────────────────────────

export const CREATE_SESSION_SQL = `insert into public.auth_sessions
         (token_hash, owner_wallet, scope, expires_at)
       values ($1, $2, $3, $4)
       returning expires_at`;

/**
 * The read.
 *
 * Expiry and revocation are PREDICATES, not post-checks: a session cannot be
 * accepted a microsecond after it lapses, and there is no window in which
 * application code holds a row it is about to reject. The retention cron is
 * therefore hygiene only — an unswept row is already unreadable.
 */
export const READ_SESSION_SQL = `select id, token_hash, owner_wallet, scope, expires_at
       from public.auth_sessions
      where token_hash = $1
        and revoked_at is null
        and expires_at > now()
      limit 1`;

/**
 * Bump at most hourly. The predicate IS the throttle — no read-modify-write,
 * so two concurrent reads cannot both decide the row is due.
 *
 * `$2::double precision` is explicit because `interval * bigint` relies on an
 * implicit numeric cast, and an auth-adjacent statement should not depend on
 * one being there.
 */
export const TOUCH_SESSION_SQL = `update public.auth_sessions
          set last_seen_at = now()
        where id = $1
          and last_seen_at < now() - ($2::double precision * interval '1 millisecond')`;

/**
 * Server-side revocation. Clearing the cookie is not enough on its own: the
 * user pressing "sign out" is often precisely the user who thinks a copy of
 * that cookie is somewhere it should not be.
 */
export const REVOKE_SESSION_SQL = `update public.auth_sessions
          set revoked_at = now()
        where token_hash = $1
          and revoked_at is null`;

/** Session lifetime for a scope. The only place the two TTLs are chosen. */
export function ttlForScope(scope: SessionScope): number {
  return scope === "full" ? FULL_SESSION_TTL_MS : READONLY_SESSION_TTL_MS;
}

export interface MintedSession {
  token: string;
  expiresAt: string;
  maxAgeSec: number;
}

/**
 * Mint a session for `wallet`.
 *
 * The caller is responsible for having established the identity — a verified
 * SIWE proof for `full`, a burnt deep-link token for `readonly`. This function
 * checks neither, and must not be reachable from anywhere that has not.
 */
export async function createSession(
  db: SessionQueryable,
  wallet: string,
  scope: SessionScope,
): Promise<MintedSession> {
  const token = mintToken();
  const ttl = ttlForScope(scope);
  const expiresAt = new Date(Date.now() + ttl);
  await db.query(CREATE_SESSION_SQL, [
    hashToken(token),
    wallet.trim().toLowerCase(),
    scope,
    expiresAt.toISOString(),
  ]);
  return { token, expiresAt: expiresAt.toISOString(), maxAgeSec: Math.floor(ttl / 1000) };
}

interface SessionRow {
  id: string;
  token_hash: string;
  owner_wallet: string;
  scope: SessionScope;
  expires_at: string | Date;
}

/**
 * Resolve a presented token to an identity, or null.
 *
 * Null covers every failure the caller is allowed to distinguish: absent,
 * malformed, unknown, revoked, expired. They are one answer on purpose — a
 * response that told a prober WHICH of those applied would turn this endpoint
 * into a token oracle.
 *
 * `last_seen_at` is bumped opportunistically and its failure is swallowed: it
 * is a diagnostic column, and no read should fail because a statistic did.
 */
export async function readSession(
  db: SessionQueryable,
  token: string | null,
): Promise<SessionIdentity | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = hashToken(token);
  const { rows } = await db.query<SessionRow>(READ_SESSION_SQL, [hash]);
  const row = rows[0];
  if (!row) return null;
  // The lookup was already keyed on the hash, so this can only disagree if the
  // store stopped doing an exact match. That is exactly the regression worth
  // spending a constant-time compare on, and it is the line that decides.
  if (!hashesEqual(row.token_hash, hash)) return null;

  // try/catch AND .catch: a store that throws synchronously would otherwise
  // take the read down with it, which is the exact outcome this is fire-and-
  // forget to avoid.
  try {
    void db.query(TOUCH_SESSION_SQL, [row.id, LAST_SEEN_INTERVAL_MS]).catch(() => undefined);
  } catch {
    // A diagnostic column is never worth a failed read.
  }

  return {
    wallet: row.owner_wallet,
    scope: row.scope,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Revoke by presented token. Silent on a miss — sign-out is idempotent. */
export async function revokeSession(db: SessionQueryable, token: string | null): Promise<void> {
  if (!token || !TOKEN_RE.test(token)) return;
  await db.query(REVOKE_SESSION_SQL, [hashToken(token)]);
}

// ── deep-link tokens ────────────────────────────────────────────────────────

export const MINT_DEEP_LINK_SQL = `insert into public.deep_link_tokens
         (token_hash, owner_wallet, transition_id, expires_at)
       values ($1, $2, $3, $4)`;

/**
 * The burn, and the whole reason this is one statement.
 *
 * `used_at is null` in the WHERE plus the UPDATE plus RETURNING is atomic:
 * Postgres row-locks the tuple, and under READ COMMITTED the loser re-evaluates
 * the predicate against the committed row and matches nothing. Of two
 * simultaneous redemptions of one token, exactly one gets a row and exactly one
 * gets a session. Split into a SELECT-then-UPDATE and both would win.
 */
export const BURN_DEEP_LINK_SQL = `update public.deep_link_tokens
          set used_at = now()
        where token_hash = $1
          and used_at is null
          and expires_at > now()
      returning owner_wallet, token_hash`;

/**
 * Mint one alert's deep-link token. Returns the RAW token for the URL; only its
 * hash is stored.
 *
 * `ownerWallet` is the SUBSCRIBER the alert was delivered to, never the watched
 * wallet — a watchlist alert is about a position the reader does not own, and a
 * token that signed them in as that stranger would be an account takeover
 * dressed as a convenience.
 */
export async function mintDeepLinkToken(
  db: SessionQueryable,
  ownerWallet: string,
  transitionId: string | number | null,
): Promise<string> {
  const token = mintToken();
  await db.query(MINT_DEEP_LINK_SQL, [
    hashToken(token),
    ownerWallet.trim().toLowerCase(),
    transitionId ?? null,
    new Date(Date.now() + DEEP_LINK_TTL_MS).toISOString(),
  ]);
  return token;
}

/**
 * Trade a deep-link token for the identity it carries, or null.
 *
 * Null again collapses unknown / expired / already-used into one answer. The
 * caller phrases it honestly for a human ("this link is no longer valid") — it
 * cannot say "already used" because it does not know that, and claiming it
 * would be both a guess and a probe oracle.
 */
export async function burnDeepLinkToken(
  db: SessionQueryable,
  token: string | null,
): Promise<string | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = hashToken(token);
  const { rows } = await db.query<{ owner_wallet: string; token_hash: string }>(
    BURN_DEEP_LINK_SQL,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  if (!hashesEqual(row.token_hash, hash)) return null;
  return row.owner_wallet;
}
