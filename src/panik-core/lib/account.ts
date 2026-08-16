/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The ACCOUNT, browser side: who is signed in to PANIK, and whether the closed
 * beta has let them in yet.
 *
 * ── THIS IS A DIFFERENT THING FROM lib/session.ts, AND THE TWO DO NOT MIX ──
 * `lib/session.ts` is the WALLET session: a SIWE signature or an alert link
 * proves which address a browser may be shown, and every wallet-scoped write
 * still signs its own action-bound proof. Nothing here weakens that and nothing
 * here is consulted to decide whether a write is allowed.
 *
 * This module is the outer layer: a Supabase Auth user, carried as a bearer, so
 * the server can say which ACCOUNT is calling and whether it holds a live
 * membership. An account never names a wallet and never authorizes one.
 *
 * ── WHERE THE GoTrue WIRE LIVES ───────────────────────────────────────────
 * lib/goTrue.ts, shared with the admin console, which had every one of these
 * lines already. It owns the two public settings, the token endpoint, the
 * refresh margin, logout and the localStorage cupboard; this file owns the
 * account's own shape, its storage key, and every sentence on screen.
 *
 * The four GoTrue endpoints this flow uses, all ordinary HTTP:
 *
 *   POST /auth/v1/otp                              email a sign-in link
 *   GET  /auth/v1/authorize?provider=google        hand off to Google
 *   POST /auth/v1/token?grant_type=refresh_token   keep the session alive
 *   POST /auth/v1/logout                           revoke it
 *
 * Both flows return through the URL FRAGMENT (`#access_token=...`), which is
 * Supabase's implicit grant. `readAuthHash` below is the whole of that return
 * leg and it is a pure function of the fragment, so it is testable without a
 * browser.
 *
 * ── WHERE THE TOKENS LIVE, AND WHAT THAT COSTS ────────────────────────────
 * localStorage, under a PANIK-scoped key, exactly as the admin console does.
 * A bearer that a single-page app must attach to its own API calls has to be
 * readable by script; there is no arrangement in which it is not. What IS
 * controlled is the blast radius: the key is namespaced so it cannot collide
 * with another app on the same origin, the value is never logged, never put in
 * a URL, and never sent anywhere but Supabase and this product's own /api.
 * The access token is short-lived and the server re-asks Supabase who it
 * belongs to (server/accountAuth.ts), so a stolen one lapses on its own.
 *
 * ── THE EMAIL ON SCREEN COMES FROM THE SERVER, NOT FROM THE TOKEN ─────────
 * A JWT payload is readable without verifying it, so decoding one here to find
 * an address would be the client asserting an identity it cannot check. Every
 * email this UI renders arrives on GET /api/account, which the server answered
 * only after asking Supabase whose session this is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readableServerError } from "./session";
import {
  authHeaders,
  ensureFresh as ensureFreshSession,
  goTrueMessage,
  isConfigured,
  readStored,
  revokeSession,
  SUPABASE_URL,
  writeStored,
  type GoTrueError,
  type TokenBody,
} from "./goTrue";

export { isConfigured };

/**
 * Namespaced, so this cannot be confused with `panik_admin_session` (the
 * console's own key, a different audience and a different set of rights) by
 * anything reading storage on this origin.
 */
export const ACCOUNT_STORAGE_KEY = "panik_account_session";

/**
 * How long the "send another link" control stays disabled.
 *
 * It mirrors Supabase's DEFAULT minimum interval between two sign-in emails to
 * one address. The point is not to enforce anything, which a browser cannot do,
 * but to stop the screen offering an action the service is going to refuse: a
 * resend inside that window comes back as an error, and a button that produces
 * an error every time is worse than a button that says when it is ready.
 */
export const RESEND_COOLDOWN_MS = 60_000;

/** Where a signed-out visitor is sent to ask for an invite. */
export const WAITLIST_URL = "https://www.panik.fi/";

/**
 * What a reader is told when the session they were holding is no longer one.
 * Two paths reach it (no session at all, and a refresh that produced none) and
 * they are the same news, so they say the same words.
 */
const SIGN_IN_EXPIRED = "Your sign-in expired. Sign in again and retry.";

// ── shapes ──────────────────────────────────────────────────────────────────

/** The credential pair this browser holds. Never rendered, never logged. */
export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Mirrors server/accountStore.ts. `lapsed` is a grant that has ended. */
export type MembershipStatus = "trial" | "active" | "lapsed";

export interface Membership {
  id: string;
  status: MembershipStatus;
  source: string;
  voucherCode: string | null;
  startedAt: string;
  /** ISO 8601, or null for a grant with no expiry. */
  expiresAt: string | null;
}

export interface AccountWallet {
  wallet: string;
  verifiedAt: string;
  createdAt: string;
}

/** What GET /api/account reports. */
export interface Account {
  userId: string;
  email: string;
  /**
   * THE SERVER'S VERDICT, not a derivation. server/accountStore.ts
   * `isLiveMembership` is the one place that decides what counts as being in
   * the beta, and a browser re-deriving it from the status string would be a
   * second copy of that rule, free to disagree.
   */
  member: boolean;
  membership: Membership | null;
  wallets: AccountWallet[];
}

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * The stored pair, or null when either token is missing or the expiry is not a
 * finite number. A half-written entry is refused rather than repaired: a
 * session with no refresh token cannot survive its first hour, and one with a
 * NaN expiry is either always fresh or never, depending on which way the
 * comparison falls.
 */
export function loadAccountSession(): AccountSession | null {
  return readStored(ACCOUNT_STORAGE_KEY, (parsed) => {
    const p = parsed as Partial<AccountSession> | null;
    if (typeof p?.accessToken !== "string" || p.accessToken === "") return null;
    if (typeof p.refreshToken !== "string" || p.refreshToken === "") return null;
    if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) return null;
    return { accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt: p.expiresAt };
  });
}

const storeAccountSession = (session: AccountSession | null) =>
  writeStored(ACCOUNT_STORAGE_KEY, session);

// ── the invite code a reader arrived holding ────────────────────────────────

/**
 * Where a `?code=` from a scanned card waits for the voucher screen.
 *
 * `returnUrl()` below is origin plus PATH and nothing else, which is what makes
 * a Supabase redirect allow-list checkable. That also means the query on /try
 * does not survive the round trip through Google or a mailbox: the browser
 * comes home to a bare path. So the boot below keeps the code here on the way
 * out and reads it back on the way in; a successful redemption clears it. The
 * value is a printed campaign code, not a credential - the server still
 * decides whether it opens anything.
 */
const PENDING_VOUCHER_KEY = "panik_pending_voucher";

/** The code a URL carries, uppercased, or null. */
function voucherFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get("code")?.trim().toUpperCase();
  return raw ? raw : null;
}

const readPendingVoucher = () =>
  readStored(PENDING_VOUCHER_KEY, (v) => (typeof v === "string" && v ? v : null));

// ── the return leg (both flows land here) ───────────────────────────────────

/** What a fragment carried back from Supabase, or nothing it recognises. */
export interface AuthHashResult {
  session: AccountSession | null;
  /** A sentence about a return that did not work, safe to render. */
  error: string | null;
}

const LINK_FAILED = "That sign-in link did not work. Ask for a new one and try again.";

/**
 * Read a Supabase implicit-grant fragment.
 *
 * Returns null when the fragment says nothing about auth, which is the signal
 * to leave the URL alone: a `#section` anchor belongs to the page, and a boot
 * that stripped every fragment would break deep links it knows nothing about.
 *
 * `expires_in` is preferred over `expires_at` because it is a DURATION and
 * therefore immune to a browser clock that disagrees with the server's. The
 * absolute value is used only as a fallback, and a missing pair falls back to
 * an hour, which is GoTrue's own default and is the conservative direction: the
 * worst a short guess produces is one extra refresh.
 */
export function readAuthHash(hash: string, now = Date.now()): AuthHashResult | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  const params = new URLSearchParams(raw);

  const error = params.get("error") ?? params.get("error_code");
  if (error) {
    return { session: null, error: readableServerError(params.get("error_description"), LINK_FAILED) };
  }

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;

  const expiresIn = Number(params.get("expires_in"));
  const expiresAt = Number(params.get("expires_at"));
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn * 1000
    : Number.isFinite(expiresAt) && expiresAt * 1000 > now
      ? expiresAt * 1000 - now
      : 3_600_000;

  return { session: { accessToken, refreshToken, expiresAt: now + lifetimeMs }, error: null };
}

// ── GoTrue ──────────────────────────────────────────────────────────────────

/**
 * Where Supabase sends the browser back to. Origin plus path and nothing else:
 * a query string here would be echoed into the email and into Google's redirect
 * chain, and the fragment is what carries the tokens.
 *
 * This exact value has to be in the project's Redirect URLs allow-list, or
 * GoTrue refuses the request rather than silently sending the user elsewhere.
 */
export function returnUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

const UNCONFIGURED = "Sign-in is not configured for this deployment.";
const UNREACHABLE = "PANIK could not reach the sign-in service. Check your connection and retry.";

/** Ask Supabase to email a one-time sign-in link. */
export async function sendMagicLink(email: string): Promise<{ ok: boolean; error: string | null }> {
  if (!isConfigured()) return { ok: false, error: UNCONFIGURED };
  const address = email.trim().toLowerCase();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(returnUrl())}`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        // `create_user` is what makes this a sign-UP as well as a sign-in. The
        // closed beta is enforced by the VOUCHER, not by who may hold an
        // account, so refusing to create one here would only replace a screen
        // that explains the gate with an error that does not.
        body: JSON.stringify({ email: address, create_user: true }),
      },
    );
    if (res.ok) return { ok: true, error: null };
    const body = (await res.json().catch(() => null)) as GoTrueError | null;
    return {
      ok: false,
      error: readableServerError(
        goTrueMessage(body),
        "That sign-in link could not be sent. Try again in a moment.",
      ),
    };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

/**
 * The URL that hands the browser to Google. A full-page navigation, not a
 * fetch: the whole point of an OAuth handoff is that the credential is entered
 * on Google's own origin.
 */
export function googleAuthUrl(): string {
  return `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(returnUrl())}`;
}

/** A grant out of a token body, or null when nothing usable came back. */
function toAccountSession(body: TokenBody): AccountSession | null {
  if (!body.access_token || !body.refresh_token) return null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // GoTrue's own default when it omits the field. A short guess costs one
    // extra refresh; a long one would let a call race the expiry.
    expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
  };
}

/**
 * The session to use for the next call, refreshed first when it is close to
 * lapsing.
 *
 * Null means "not usable now", and lib/goTrue.ts decides what that costs the
 * stored copy: a refusal from GoTrue erases it, a request that never completed
 * leaves it alone. That distinction is the reason this is one shared function
 * and not a per-surface copy, and the callers must not re-clear storage on
 * their own (see `dropSession` below).
 */
export async function ensureFresh(session: AccountSession): Promise<AccountSession | null> {
  return ensureFreshSession(session, ACCOUNT_STORAGE_KEY, toAccountSession);
}

/** Revoke server-side, then forget it locally either way. */
export async function signOutAccount(session: AccountSession | null): Promise<void> {
  await revokeSession(ACCOUNT_STORAGE_KEY, session?.accessToken ?? null);
}

// ── PANIK's own API ─────────────────────────────────────────────────────────

const ACCOUNT_URL = "/api/account";
const VOUCHER_URL = "/api/account/voucher";

/**
 * One authenticated call to PANIK's own account API.
 *
 * Both routes below need the same four things: the bearer, a body parse that
 * cannot throw, the STATUS kept (401 is a decision, not an error string), and
 * a request that never completed told apart from one the server answered.
 * That last distinction is the one a second hand-written copy loses, and it
 * decides whether a reader is signed out or shown "try again in a moment".
 * Null is the unreachable case; everything else is an answer.
 */
async function callApi(
  url: string,
  token: string,
  post?: unknown,
): Promise<{ status: number; ok: boolean; body: unknown } | null> {
  const sending = post !== undefined;
  try {
    const res = await fetch(url, {
      method: sending ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(sending ? { "Content-Type": "application/json" } : {}),
      },
      ...(sending ? { body: JSON.stringify(post) } : {}),
    });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/**
 * An account out of a response body, or null when a field this UI renders is
 * missing. A half-believed body would put an undefined address in the header
 * chip, and `member` is the flag the whole gate turns on: it is required to be
 * a real boolean rather than coerced, so a body that omits it is refused rather
 * than read as "not a member".
 */
export function asAccount(body: unknown): Account | null {
  const wire = body as
    | {
        account?: { userId?: unknown; email?: unknown };
        member?: unknown;
        membership?: unknown;
        wallets?: unknown;
      }
    | null;
  const userId = wire?.account?.userId;
  const email = wire?.account?.email;
  if (typeof userId !== "string" || userId === "") return null;
  if (typeof email !== "string" || email === "") return null;
  if (typeof wire?.member !== "boolean") return null;
  return {
    userId,
    email,
    member: wire.member,
    membership: asMembership(wire.membership),
    wallets: Array.isArray(wire.wallets) ? (wire.wallets as AccountWallet[]) : [],
  };
}

function asMembership(raw: unknown): Membership | null {
  const m = raw as Partial<Membership> | null;
  if (m?.status !== "trial" && m?.status !== "active" && m?.status !== "lapsed") return null;
  return {
    id: typeof m.id === "string" ? m.id : "",
    status: m.status,
    source: typeof m.source === "string" ? m.source : "",
    voucherCode: typeof m.voucherCode === "string" ? m.voucherCode : null,
    startedAt: typeof m.startedAt === "string" ? m.startedAt : "",
    expiresAt: typeof m.expiresAt === "string" ? m.expiresAt : null,
  };
}

/**
 * Three outcomes, and they are three because the screens they produce are
 * different. `expired` means sign in again; an `error` means we could not ask,
 * which is NOT the same as "you have no membership" and must never render as
 * the voucher screen.
 */
export type AccountRead =
  | { ok: true; account: Account }
  | { ok: false; expired: true }
  | { ok: false; expired: false; error: string };

const ACCOUNT_UNAVAILABLE = "PANIK could not check your account. Try again in a moment.";

export async function fetchAccount(token: string): Promise<AccountRead> {
  const res = await callApi(ACCOUNT_URL, token);
  if (!res) return { ok: false, expired: false, error: UNREACHABLE };
  if (res.status === 401) return { ok: false, expired: true };
  if (!res.ok) {
    const body = res.body as { error?: unknown } | null;
    return { ok: false, expired: false, error: readableServerError(body?.error, ACCOUNT_UNAVAILABLE) };
  }
  const account = asAccount(res.body);
  if (!account) return { ok: false, expired: false, error: ACCOUNT_UNAVAILABLE };
  return { ok: true, account };
}

const VOUCHER_FAILED = "That code could not be checked. Try again in a moment.";

/**
 * Redeem an invite code.
 *
 * The refusal is the SERVER'S sentence. server/accounts.ts wrote those for a
 * person to read ("that code was not recognised", "that code has already been
 * used its full number of times"), and the server is the only party that knows
 * which one applies; a local rewrite here would be a second copy of a message
 * set that is free to drift. `readableServerError` applies the two house rules
 * on the way to the screen (no em dashes, sentence case) and falls back when
 * the body is not a short string.
 */
export async function redeemVoucher(
  token: string,
  code: string,
): Promise<{ ok: boolean; error: string | null }> {
  const res = await callApi(VOUCHER_URL, token, { code: code.trim() });
  if (!res) return { ok: false, error: UNREACHABLE };
  const body = res.body as { ok?: unknown; error?: unknown } | null;
  if (res.ok && body?.ok === true) return { ok: true, error: null };
  return { ok: false, error: readableServerError(body?.error, VOUCHER_FAILED) };
}

// ── describing a membership ─────────────────────────────────────────────────

/**
 * Pinned at module scope rather than rebuilt per render: building a formatter
 * is the expensive half of formatting a date. Same reason as
 * components/SessionControls.tsx.
 */
const GRANT_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * One line naming what this account holds, for the header menu.
 *
 * Every branch states only what the row says. A grant with no `expires_at` gets
 * NO date rather than an invented one, an unparseable timestamp is treated as
 * no date at all, and `lapsed` is described as ended rather than as a kind of
 * access. The word "trial" is the row's own `status`, which is the same value
 * the server judged, so the line cannot claim a level of access the gate did
 * not grant.
 */
export function describeMembership(account: Account): string {
  const m = account.membership;
  if (!m || !account.member) return "No closed beta access on this account";
  const kind = m.status === "trial" ? "Closed beta trial" : "Closed beta access";
  if (m.expiresAt === null) return kind;
  const when = new Date(m.expiresAt);
  return Number.isNaN(when.getTime()) ? kind : `${kind} until ${GRANT_FORMAT.format(when)}`;
}

// ── the hook the shell uses ─────────────────────────────────────────────────

/** Where the boot has got to. `checking` must never render a sign-in screen. */
export type AccountStatus = "checking" | "resolved";

export interface AccountState {
  status: AccountStatus;
  /** False when this deployment has no Supabase Auth configured at all. */
  configured: boolean;
  session: AccountSession | null;
  /** Null whenever the account could not be read, INCLUDING when signed out. */
  account: Account | null;
  /** Why the account could not be read, or null. Safe to render. */
  error: string | null;
  /** A sign-in, sign-out or redemption is in flight. */
  busy: boolean;
  /** The invite code the reader arrived holding (`?code=`), until one is redeemed. */
  pendingVoucher: string | null;
  sendLink: (email: string) => Promise<{ ok: boolean; error: string | null }>;
  startGoogle: () => void;
  redeem: (code: string) => Promise<{ ok: boolean; error: string | null }>;
  signOut: () => Promise<void>;
  /** Re-read GET /api/account, e.g. right after a code was accepted. */
  reload: () => Promise<void>;
}

/**
 * The account, for the app shell.
 *
 * Boots exactly once per mount, guarded by a ref rather than by an empty
 * dependency array, for the same reason `useSession` is: StrictMode invokes
 * effects twice in development, and the fragment this reads is consumed and
 * stripped on the first pass.
 */
export function useAccountSession(): AccountState {
  const [status, setStatus] = useState<AccountStatus>("checking");
  const [session, setSession] = useState<AccountSession | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingVoucher, setPendingVoucher] = useState<string | null>(null);
  const booted = useRef(false);

  /**
   * Raise the busy flag for exactly the duration of one account action.
   *
   * `finally`, so a throw cannot leave every control on the gate disabled with
   * no way back. Four callers had four hand-written pairs of setBusy calls and
   * one of them already returned early between them.
   */
  const runBusy = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Forget the session this browser is holding.
   *
   * `forgetStored` is a decision rather than a detail. Storage is erased only
   * when a server DEFINITIVELY said this credential is no longer one: a 401
   * from /api/account, or a refresh GoTrue refused (which lib/goTrue.ts has
   * already cleared by the time we see the null). A request that never
   * completed clears nothing, so the next load retries with what it holds
   * instead of signing someone out for a dropped packet.
   */
  const dropSession = useCallback((forgetStored: boolean) => {
    if (forgetStored) storeAccountSession(null);
    setSession(null);
    setAccount(null);
  }, []);

  /**
   * Resolve one session into an account. Shared by the boot and by `reload`,
   * because "refresh the token, ask the server, and act on a 401 by forgetting
   * the session" is one sequence and two copies of it drift on the 401 branch,
   * which is the branch that decides whether a signed-out user sees a sign-in
   * screen or a stuck one.
   */
  const resolve = useCallback(
    async (held: AccountSession): Promise<void> => {
      const fresh = await ensureFresh(held);
      if (!fresh) {
        // Two different failures arrive here and only ONE of them has already
        // cleared storage: GoTrue refusing the refresh token clears it inside
        // ensureFresh, a request that never completed keeps it. Neither can
        // make the next call, so both drop what is in memory and neither
        // touches storage again from here.
        dropSession(false);
        return;
      }
      setSession(fresh);
      const read = await fetchAccount(fresh.accessToken);
      if (read.ok) {
        setAccount(read.account);
        setError(null);
        return;
      }
      if (read.expired) {
        // The server looked at this bearer and said it is not a session. That
        // is definitive, so the stored copy goes with it.
        dropSession(true);
        setError(null);
        return;
      }
      setAccount(null);
      setError(read.error);
    },
    [dropSession],
  );

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const landed = readAuthHash(window.location.hash);
      if (landed) {
        // The credential is removed from the address bar WHETHER OR NOT it
        // worked, and before anything is awaited: a URL is the least private
        // thing in a browser, and a failed fragment is exactly as unwanted
        // there as a good one.
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        if (landed.session) storeAccountSession(landed.session);
        if (landed.error) setError(landed.error);
      }
      // The code from the URL wins over a stored one and replaces it; with no
      // code in the URL, whatever an earlier visit left behind is what waits.
      const arrived = voucherFromUrl(window.location.search);
      if (arrived) writeStored(PENDING_VOUCHER_KEY, arrived);
      setPendingVoucher(arrived ?? readPendingVoucher());
      const held = loadAccountSession();
      if (held) await resolve(held);
      setStatus("resolved");
    })();
  }, [resolve]);

  const sendLink = useCallback(
    (email: string) => runBusy(() => sendMagicLink(email)),
    [runBusy],
  );

  const startGoogle = useCallback(() => {
    if (!isConfigured()) {
      setError(UNCONFIGURED);
      return;
    }
    setBusy(true);
    window.location.assign(googleAuthUrl());
  }, []);

  const redeem = useCallback(
    (code: string) =>
      runBusy(async () => {
        const held = session;
        if (!held) return { ok: false, error: SIGN_IN_EXPIRED };
        const fresh = await ensureFresh(held);
        if (!fresh) {
          dropSession(false);
          return { ok: false, error: SIGN_IN_EXPIRED };
        }
        setSession(fresh);
        const result = await redeemVoucher(fresh.accessToken, code);
        if (result.ok) {
          writeStored(PENDING_VOUCHER_KEY, null);
          setPendingVoucher(null);
        }
        return result;
      }),
    [session, runBusy, dropSession],
  );

  const signOut = useCallback(
    () =>
      runBusy(async () => {
        // signOutAccount clears storage itself, whatever the revocation did.
        await signOutAccount(session);
        dropSession(false);
        setError(null);
      }),
    [session, runBusy, dropSession],
  );

  const reload = useCallback(async () => {
    const held = session ?? loadAccountSession();
    if (!held) return;
    await runBusy(() => resolve(held));
  }, [session, resolve, runBusy]);

  return useMemo(
    () => ({
      status,
      configured: isConfigured(),
      session,
      account,
      error,
      busy,
      pendingVoucher,
      sendLink,
      startGoogle,
      redeem,
      signOut,
      reload,
    }),
    [status, session, account, error, busy, pendingVoucher, sendLink, startGoogle, redeem, signOut, reload],
  );
}

/**
 * WHICH screen the account layer stands in front of the app with, or null when
 * it stands in front of nothing.
 *
 * A boolean lived here first and it made the caller ask the same question
 * twice: the shell decided whether to show a gate, then the gate re-derived
 * which one from the same three fields. Two chains over one state is how the
 * "we could not find out" branch ends up rendering as "enter your invite code"
 * on one of them, which is the app stating a fact it does not know
 * (docs/DESIGN_SYSTEM.md).
 *
 * Each answer is a DIFFERENT thing being unknown, and the order is the point:
 *
 *   checking      we have not asked yet             wordless, no claim at all
 *   signin        nobody is signed in               ask them to
 *   unavailable   we asked and could not find out   say so, offer a retry
 *   voucher       we asked, the answer is no        ask for the invite code
 *   null          the server says they are a member let them in
 *
 * `checking` is a gate rather than a null on purpose: rendering the dashboard
 * for a moment and replacing it with a sign-in page is the app telling someone
 * they are in and then that they are not.
 *
 * THE READ-ONLY BYPASS IS NOT HERE. An alert link is a WALLET session
 * (lib/session.ts) and this module is the account layer; it never consults the
 * other and the two must not learn about each other. The shell holds both and
 * is where that precedence is decided.
 */
export type GateScreen = "checking" | "signin" | "unavailable" | "voucher";

export function gateScreen(state: AccountState): GateScreen | null {
  if (state.status !== "resolved") return "checking";
  if (state.session === null) return "signin";
  if (state.account === null) return "unavailable";
  return state.account.member ? null : "voucher";
}
