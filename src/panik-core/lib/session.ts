/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The identity session, browser side: how this tab finds out which wallet it is
 * allowed to call itself, and the four requests that change that answer.
 *
 * SIGNATURES AUTHORIZE ACTIONS; SESSIONS ONLY RESTORE IDENTITY. That sentence
 * is `server/sessionStore.ts`'s and it is repeated here because this file is
 * where it is easiest to forget: nothing below may ever be consulted to decide
 * whether a write is allowed. Every wallet-scoped write still signs its own
 * single-use, action-bound proof on every request (`lib/telegram.ts`,
 * `lib/watchlist.ts`), exactly as it did before sessions existed. A `readonly`
 * scope is therefore NOT a permission level the client enforces: it is the
 * server telling us how it knows who this is, so the UI can stop offering
 * controls whose signature the reader demonstrably cannot produce.
 *
 * NO `credentials` OPTION ANYWHERE. The API is same-origin through the Vercel
 * rewrite (www.panik.fi/api/* -> Railway), and fetch's default credentials mode
 * is already `same-origin`, so the cookie rides along. `credentials: "include"`
 * would be a no-op here and `mode: "cors"` is the one setting that would break
 * it, which is why neither appears. The server deliberately does not send
 * `Access-Control-Allow-Credentials` (scripts/api-server.ts), so a genuinely
 * cross-origin caller gets nothing.
 *
 * THE COOKIE IS NEVER READ HERE. It is HttpOnly, so script cannot see it and
 * this module never tries: the only way to learn who we are is to ask the
 * server, which is also the only party that can tell the truth about expiry and
 * revocation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { noWalletAvailable, OwnershipError, rejectedSignature, type GetProof } from "./telegram";

/** How the server knows who this browser is. Never a write permission. */
export type SessionScope = "full" | "readonly";

const SCOPES: readonly SessionScope[] = ["full", "readonly"];

/** What GET /api/session answers when it can vouch for the caller. */
export interface Session {
  wallet: string;
  scope: SessionScope;
  /** ISO 8601, the server's own value. Never computed here. */
  expiresAt: string;
}

const SESSION_URL = "/api/session";
const EXCHANGE_URL = "/api/session/exchange";

/** The alert link's single-use token, as it arrives in the URL. */
export const SID_PARAM = "sid";

// ── the URL ─────────────────────────────────────────────────────────────────

/**
 * The `?sid=` an alert button carried, or null.
 *
 * No shape check. The token's format is the server's business and a client-side
 * regex here would only decide, wrongly, that a token from a newer mint is not
 * worth presenting. Anything non-empty is offered once and the server rejects
 * what it does not recognise.
 */
export function sidParam(search: string): string | null {
  const raw = new URLSearchParams(search).get(SID_PARAM);
  const token = raw?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * The same query string with the sid removed AND NOTHING ELSE TOUCHED.
 *
 * `?view=` and `&tab=` have to survive: they are the other half of the same
 * alert link and the deep-link handling in AppDemo reads them from the URL
 * after this has run. What must not survive is the credential, because a URL is
 * the least private thing in a browser - it goes out as `Referer` on the next
 * outbound request, it lands in history, and it is what gets pasted into a chat
 * when someone asks "what are you looking at". The token is single-use and
 * short-lived, which bounds that exposure; stripping it is what ends it.
 */
export function searchWithoutSid(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(SID_PARAM)) return search;
  params.delete(SID_PARAM);
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : "";
}

// ── talking to the API ──────────────────────────────────────────────────────

/**
 * A session out of a response body, or null.
 *
 * Every field is checked because every field is rendered: the scope decides
 * which controls a reader is offered and the wallet decides whose money is on
 * screen, so a malformed body has to read as "not signed in" rather than as a
 * session with an `undefined` wallet in it.
 */
function asSession(body: unknown): Session | null {
  const wire = body as { wallet?: unknown; scope?: unknown; expiresAt?: unknown } | null;
  const wallet = typeof wire?.wallet === "string" ? wire.wallet.trim().toLowerCase() : "";
  const scope = wire?.scope;
  const expiresAt = wire?.expiresAt;
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return null;
  if (typeof scope !== "string" || !SCOPES.includes(scope as SessionScope)) return null;
  if (typeof expiresAt !== "string" || expiresAt.length === 0) return null;
  return { wallet, scope: scope as SessionScope, expiresAt };
}

/**
 * A sentence the SERVER wrote, in this product's house style.
 *
 * The API's message is used rather than a local rewrite because the server is
 * the only party that knows what happened, and PR #101 phrased it for a human
 * on purpose. Two house rules are applied on the way to the screen: no em
 * dashes (a founder rule this repo enforces on UI copy, and the API string
 * carries one), and a sentence starts with a capital and ends with a stop.
 *
 * Anything that is not a short string becomes the caller's fallback. A body
 * that is not the shape we expect is a proxy error page or a newer API, and
 * neither is something to paste across the top of the app.
 */
export function readableServerError(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const text = raw.trim();
  if (text.length === 0 || text.length > 160) return fallback;
  const cleaned = text.replace(/\s*[—–]\s*/g, ", ");
  const capitalised = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * Who does the server say this browser is? Null for every answer that is not a
 * live session.
 *
 * A 401 and an unreachable API collapse into the same null on purpose: both
 * leave the visitor with the signed-out app, which is what every visitor got
 * before sessions existed, and neither is ever rendered as a claim. Nothing on
 * screen says "you are signed out" as a statement of fact; the app simply asks
 * for a wallet, which it can always honestly do.
 */
export async function fetchSession(): Promise<Session | null> {
  try {
    const res = await fetch(SESSION_URL);
    if (!res.ok) return null;
    return asSession(await res.json());
  } catch {
    return null;
  }
}

/** What POST /api/session/exchange did with the token we presented. */
export interface ExchangeResult {
  /** The server accepted the token. The cookie is set even if the body was odd. */
  ok: boolean;
  session: Session | null;
  /** Present only when `ok` is false. Safe to render. */
  error: string | null;
}

const STALE_LINK =
  "That alert link is no longer valid. Open PANIK from a fresh alert to pick up where it left off.";

/**
 * Trade an alert link's token for a read-only session.
 *
 * Single-use server-side, so this is called ONCE per page load and never
 * retried: a second attempt with the same token is guaranteed to fail and would
 * replace a working session with an error message.
 */
export async function exchangeAlertLink(token: string): Promise<ExchangeResult> {
  try {
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok) return { ok: false, session: null, error: readableServerError(body?.error, STALE_LINK) };
    return { ok: true, session: asSession(body), error: null };
  } catch {
    // The request never landed, so the token may or may not have been spent.
    // "This link is stale" would be a guess; "we could not reach PANIK" is what
    // we know.
    return {
      ok: false,
      session: null,
      error: "PANIK could not be reached to open that alert link. Try again in a moment.",
    };
  }
}

/** Sign-in either happened or it did not, and the failure is sayable. */
export type SignInResult = { ok: true; session: Session | null } | { ok: false; error: string };

const SIGN_IN_FAILED = "PANIK could not sign this browser in, so it stays signed out.";

/**
 * Mint a full session from one `session-start` signature.
 *
 * The proof is an ordinary single-use ownership proof, the same shape the
 * watchlist and the Telegram link demand. What is different is what it buys: a
 * name, for thirty days, and nothing else. Declining it is a normal choice and
 * leaves today's per-visit behaviour exactly as it was, which is why every
 * failure here returns a sentence instead of throwing.
 */
export async function startSession(wallet: string, getProof: GetProof): Promise<SignInResult> {
  try {
    const proof = await getProof(wallet.trim().toLowerCase(), "session-start");
    const res = await fetch(SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok) return { ok: false, error: readableServerError(body?.error, SIGN_IN_FAILED) };
    return { ok: true, session: asSession(body) };
  } catch (err) {
    return { ok: false, error: describeSignInFailure(err) };
  }
}

/**
 * Whatever was thrown, as a sentence with its consequence attached.
 *
 * NO LIBRARY MESSAGE REACHES THIS RETURN VALUE. A raw wagmi or viem string
 * names an internal for a developer reading a stack trace, and one of them once
 * rendered as "Provider not found. Version: @wagmi/core@3.5.1" across the top
 * of the app. The predicates are `lib/telegram.ts`'s so there is one place that
 * knows which wagmi shape means what.
 */
function describeSignInFailure(err: unknown): string {
  if (rejectedSignature(err)) return "Signature declined, so this browser stays signed out.";
  // Our own message, written for a screen: the only class safe to pass along.
  if (err instanceof OwnershipError) return err.message;
  if (noWalletAvailable(err)) {
    return "Staying signed in needs a signature from your wallet. Connect it and try again.";
  }
  return SIGN_IN_FAILED;
}

/**
 * Sign out: revoke server-side and clear the cookie.
 *
 * Returns whether the server confirmed it, because the caller must not report a
 * sign-out that did not happen. Someone pressing this is often precisely the
 * person who believes a copy of that cookie is somewhere it should not be, and
 * telling them it is gone when the revocation failed is the one answer this
 * button cannot give.
 */
export async function endSession(): Promise<boolean> {
  try {
    const res = await fetch(SESSION_URL, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

/** What one page load worked out about who is here. */
export interface BootResult {
  session: Session | null;
  /** A sentence about the alert link that did not work, or null. */
  note: string | null;
}

/**
 * The whole boot sequence, as a function of a query string.
 *
 * ORDER IS THE POINT. The sid is traded FIRST, before anything asks who we are,
 * because that request is what makes the answer true for a reader arriving from
 * Telegram. It is stripped out of the URL immediately afterwards WHETHER OR NOT
 * it worked, in a `finally`, because a token that failed is exactly as unwanted
 * in the address bar as one that succeeded. Only then does the identity read
 * happen, and only then does the app know which screen to show.
 *
 * `replaceSearch` is injected rather than reaching for `window` so this is
 * testable as the pure sequence it is; the hook below passes the real one.
 *
 * A failed trade is SILENT when a session came back anyway. The reader is
 * already someone we can name, the `?view=` half of their link still works, and
 * a note about a spent token would be the app raising a problem the reader does
 * not have.
 */
export async function bootSession(
  search: string,
  replaceSearch: (search: string) => void,
): Promise<BootResult> {
  const sid = sidParam(search);
  let traded: ExchangeResult | null = null;
  if (sid) {
    try {
      traded = await exchangeAlertLink(sid);
    } finally {
      replaceSearch(searchWithoutSid(search));
    }
  }
  if (traded?.ok && traded.session) return { session: traded.session, note: null };
  const session = await fetchSession();
  return { session, note: session === null ? (traded?.error ?? null) : null };
}

/** Where the boot has got to. `checking` must never render the signed-out app. */
export type SessionStatus = "checking" | "resolved";

export interface SessionState {
  status: SessionStatus;
  session: Session | null;
  /**
   * One line about the session itself: a stale alert link, a declined
   * signature, a sign-out that did not land. One surface for all three, because
   * they are the same kind of news and three separate strips would be three
   * places to look.
   */
  note: string | null;
  dismissNote: () => void;
  signIn: (wallet: string, getProof: GetProof) => Promise<void>;
  /** Whether the server confirmed the revocation. The caller resets what it
   *  owns only on a true, so a failed sign-out cannot leave the app claiming to
   *  have forgotten an identity the server still honours on the next load. */
  signOut: () => Promise<boolean>;
}

/**
 * The session, for the app shell.
 *
 * Runs its boot exactly once per mount, guarded by a ref rather than by an
 * empty dependency array: StrictMode invokes effects twice in development, the
 * sid is single-use, and the second trade of a burnt token would answer "this
 * link is no longer valid" over a session the first one had just established.
 */
export function useSession(): SessionState {
  const [status, setStatus] = useState<SessionStatus>("checking");
  const [session, setSession] = useState<Session | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const booted = useRef(false);
  /**
   * Whether this component is still mounted, as a ref that is REARMED on every
   * effect run.
   *
   * A plain `let cancelled` closed over by the effect deadlocks the app under
   * StrictMode, and it did: run one starts the boot, the immediate cleanup sets
   * cancelled, run two is skipped by the guard above, and the in-flight boot
   * then resolves into a closure that has been told to discard its answer. The
   * status stays `checking` forever and the whole app is a skeleton. Rearming
   * here is what makes the second run adopt the first run's request.
   */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!booted.current) {
      booted.current = true;
      void (async () => {
        const result = await bootSession(window.location.search, (next) => {
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${next}${window.location.hash}`,
          );
        });
        if (!mounted.current) return;
        setSession(result.session);
        setNote(result.note);
        setStatus("resolved");
      })();
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  const signIn = useCallback(async (wallet: string, getProof: GetProof) => {
    const result = await startSession(wallet, getProof);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    setNote(null);
    // The POST's own body when it parsed, and a re-read when it did not: the
    // cookie is set either way, and inventing a scope or an expiry to fill the
    // gap would put a made-up date in the Settings card.
    setSession(result.session ?? (await fetchSession()));
  }, []);

  const signOut = useCallback(async () => {
    if (!(await endSession())) {
      setNote("PANIK could not sign this browser out. Check your connection and try again.");
      return false;
    }
    setNote(null);
    setSession(null);
    return true;
  }, []);

  const dismissNote = useCallback(() => setNote(null), []);

  return { status, session, note, dismissNote, signIn, signOut };
}
