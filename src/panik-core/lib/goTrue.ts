/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Supabase Auth (GoTrue) over plain fetch: the transport the two signed-in
 * surfaces in this repo share, and nothing above it.
 *
 * TWO CONSUMERS, ONE WIRE. `src/panik-admin/lib/supabaseAuth.ts` signs an
 * operator in with a password; `src/panik-core/lib/account.ts` signs a reader
 * in with an email link. What they had in common was every line that touches
 * the service: the two public settings, the token endpoint, the refresh margin,
 * the logout call and the localStorage cupboard. What they do NOT have in
 * common is the session SHAPE (the console carries an email and a
 * password-rotated flag; the app carries neither), the storage KEY, or a single
 * sentence of copy, so none of that is here.
 *
 * WHY THIS EXISTS RATHER THAN TWO COPIES. The copies had already disagreed on
 * the branch that matters most: a refresh whose request never completed. One
 * treated it as a spent token and erased the session; the other kept it. A
 * dropped request is not evidence about a credential, and signing a user out
 * because their train went into a tunnel is the failure that rule exists to
 * stop. `ensureFresh` below is the one place that decides it, so the two
 * surfaces cannot answer it differently again.
 *
 * WHY PLAIN fetch AND NOT @supabase/supabase-js: that package is not a
 * dependency of this repo, the design system forbids adding one, and the five
 * endpoints between them are ordinary HTTP.
 *
 * NOTHING HERE IS A TRUST BOUNDARY. A token this module hands back says only
 * what the server will later re-check: server/accountAuth.ts and
 * server/adminIdentity.ts both ask Supabase whose session a bearer is, on every
 * request. Editing localStorage gets a caller a nicer screen and zero data.
 */

/** Public by design: neither value authorizes anything on its own. */
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
export const PUBLISHABLE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

/**
 * Whether this deployment has a sign-in service at all.
 *
 * Read once at module scope, because both values come from the build's env and
 * a rebuilt string per call was answering a question that cannot change while
 * the page is open.
 */
export const CONFIGURED = SUPABASE_URL !== "" && PUBLISHABLE_KEY !== "";

/** The same fact as a call, for the surfaces that pass it around as a function. */
export function isConfigured(): boolean {
  return CONFIGURED;
}

/** Refresh this far before the token lapses, so an API call never races it. */
export const REFRESH_MARGIN_MS = 60_000;

/** apikey plus whatever the call adds. The key is public; see the header. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { apikey: PUBLISHABLE_KEY, ...extra };
}

// ── the token cupboard ──────────────────────────────────────────────────────

/**
 * A stored session, validated by its owner.
 *
 * The VALIDATOR is the caller's, because the two sessions are different shapes
 * and a half-believed one is worse than none: a missing field here becomes an
 * undefined address in a header chip or a bearer that no request can use.
 * Anything unreadable (absent, not JSON, or refused by the validator) is the
 * same answer, `null`, which every caller already treats as signed out.
 */
export function readStored<S>(key: string, validate: (parsed: unknown) => S | null): S | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a session, or clear the key when it is null. */
export function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

// ── what GoTrue answers with ────────────────────────────────────────────────

/**
 * The refusal half of a GoTrue body, on its own: every endpoint here can
 * answer with one of these three fields and no tokens at all, and the routes
 * that only ever produce a sentence (a rejected magic link) have no business
 * being handed a type that promises an access token.
 */
export interface GoTrueError {
  msg?: string;
  error?: string;
  error_description?: string;
}

/** A token grant, plus the refusal fields any of them may answer with instead. */
export interface TokenBody extends GoTrueError {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Returned with a grant. Only the admin console reads it. */
  user?: { email?: string; user_metadata?: Record<string, unknown> };
}

/**
 * Supabase's own sentence about a refusal, or undefined when it wrote none.
 *
 * Deliberately `unknown`: the caller decides what a service's raw string is
 * worth on ITS screen, and both of them already have a rule for that
 * (`readableServerError` in the app, a fixed line in the console, which must
 * not leak whether an address exists).
 */
export function goTrueMessage(body: GoTrueError | null): unknown {
  return body?.error_description ?? body?.msg ?? body?.error;
}

/**
 * One call to the token endpoint, and THREE outcomes rather than two.
 *
 * `reached: false` is the one the callers get wrong: the request never
 * completed, so the service said nothing at all. It is not a refusal and must
 * never be read as one. A refusal is `reached: true, ok: false`, which is the
 * service telling us the credential is no good.
 *
 * A 200 whose body will not parse comes back as an empty object rather than a
 * failure: the grant did happen, but nothing usable arrived, and the caller's
 * decoder is the right place to notice that.
 */
export type TokenResult = { reached: true; ok: boolean; body: TokenBody } | { reached: false };

export async function tokenRequest(query: string, body: unknown): Promise<TokenResult> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?${query}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return { reached: true, ok: res.ok, body: (await res.json().catch(() => ({}))) as TokenBody };
  } catch {
    return { reached: false };
  }
}

// ── keeping a session alive ─────────────────────────────────────────────────

/** The two fields `ensureFresh` needs of whatever session shape it is given. */
export interface Refreshable {
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * The session to use for the next call, refreshed first when it is close to
 * lapsing, and THE ONE PLACE that decides what a failed refresh means.
 *
 *   still fresh          the session it was handed, untouched
 *   refreshed            the decoded new one, written to storage
 *   refused by GoTrue    null, and storage is CLEARED: the token is spent
 *   never reached        null, and storage is KEPT: a dropped request says
 *                        nothing about the credential, and the next load
 *                        must be able to retry with it
 *
 * The caller drops its in-memory session on either null, because neither can
 * make the next request; only the definitive branch is allowed to erase what
 * a reload would find. This is the whole reason the module exists, so both
 * branches are exercised in goTrue.test.ts.
 */
export async function ensureFresh<S extends Refreshable>(
  session: S,
  key: string,
  decode: (body: TokenBody) => S | null,
): Promise<S | null> {
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;
  const result = await tokenRequest("grant_type=refresh_token", {
    refresh_token: session.refreshToken,
  });
  if (!result.reached) return null;
  const next = result.ok ? decode(result.body) : null;
  writeStored(key, next);
  return next;
}

/**
 * Revoke server-side, then forget it locally EITHER WAY.
 *
 * The local drop is unconditional on purpose: a sign-out that leaves the token
 * in storage because the network hiccuped is the app disobeying the one
 * instruction a person can give it about their own credential. The token is
 * short-lived and the server re-asks Supabase about it on every request, so
 * the worst an unrevoked one costs is its remaining minutes.
 */
export async function revokeSession(key: string, accessToken: string | null): Promise<void> {
  if (accessToken && CONFIGURED) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: authHeaders({ Authorization: `Bearer ${accessToken}` }),
      });
    } catch {
      /* the local copy is dropped regardless; the token lapses on its own */
    }
  }
  writeStored(key, null);
}
