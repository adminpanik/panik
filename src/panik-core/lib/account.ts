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
 * ── WHY PLAIN fetch AND NOT @supabase/supabase-js ─────────────────────────
 * The same reason src/panik-admin/lib/supabaseAuth.ts gives: that package is
 * not a dependency of this repo, the design system forbids adding one, and the
 * four GoTrue endpoints needed here are ordinary HTTP:
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

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const PUBLISHABLE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

/**
 * Namespaced, so this cannot be confused with `panik_admin_session` (the
 * console's own key, a different audience and a different set of rights) by
 * anything reading storage on this origin.
 */
export const ACCOUNT_STORAGE_KEY = "panik_account_session";

/** Refresh this far before the token lapses, so an API call never races it. */
const REFRESH_MARGIN_MS = 60_000;

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

export function isConfigured(): boolean {
  return SUPABASE_URL !== "" && PUBLISHABLE_KEY !== "";
}

// ── storage ─────────────────────────────────────────────────────────────────

export function loadAccountSession(): AccountSession | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccountSession>;
    if (
      typeof parsed.accessToken !== "string" ||
      parsed.accessToken === "" ||
      typeof parsed.refreshToken !== "string" ||
      parsed.refreshToken === "" ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function storeAccountSession(session: AccountSession | null): void {
  try {
    if (session) localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

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

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  msg?: string;
  error?: string;
  error_description?: string;
}

/** Supabase's own sentence when it wrote one, else the caller's fallback. */
function goTrueError(body: TokenBody | null, fallback: string): string {
  return readableServerError(body?.error_description ?? body?.msg ?? body?.error, fallback);
}

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
        headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
        // `create_user` is what makes this a sign-UP as well as a sign-in. The
        // closed beta is enforced by the VOUCHER, not by who may hold an
        // account, so refusing to create one here would only replace a screen
        // that explains the gate with an error that does not.
        body: JSON.stringify({ email: address, create_user: true }),
      },
    );
    if (res.ok) return { ok: true, error: null };
    const body = (await res.json().catch(() => null)) as TokenBody | null;
    return {
      ok: false,
      error: goTrueError(body, "That sign-in link could not be sent. Try again in a moment."),
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

/** Exchange the refresh token for a fresh access token. Null if it is spent. */
async function refreshAccountSession(session: AccountSession): Promise<AccountSession | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) {
      storeAccountSession(null);
      return null;
    }
    const body = (await res.json().catch(() => null)) as TokenBody | null;
    if (!body?.access_token || !body.refresh_token) {
      storeAccountSession(null);
      return null;
    }
    const next: AccountSession = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
    };
    storeAccountSession(next);
    return next;
  } catch {
    // The network failed, which is NOT evidence the refresh token is spent.
    // Keeping what we hold lets the next attempt succeed; discarding it would
    // sign a user out because their train went into a tunnel.
    return null;
  }
}

/** The session to use for the next call, refreshed first when it is close to lapsing. */
export async function ensureFresh(session: AccountSession): Promise<AccountSession | null> {
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;
  return refreshAccountSession(session);
}

/** Revoke server-side, then forget it locally either way. */
export async function signOutAccount(session: AccountSession | null): Promise<void> {
  if (session && isConfigured()) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${session.accessToken}` },
      });
    } catch {
      /* the local copy is dropped regardless; the token lapses on its own */
    }
  }
  storeAccountSession(null);
}

// ── PANIK's own API ─────────────────────────────────────────────────────────

const ACCOUNT_URL = "/api/account";
const VOUCHER_URL = "/api/account/voucher";

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
  if (!m || typeof m.status !== "string") return null;
  if (m.status !== "trial" && m.status !== "active" && m.status !== "lapsed") return null;
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
  let res: Response;
  try {
    res = await fetch(ACCOUNT_URL, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, expired: false, error: UNREACHABLE };
  }
  if (res.status === 401) return { ok: false, expired: true };
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    return { ok: false, expired: false, error: readableServerError(body?.error, ACCOUNT_UNAVAILABLE) };
  }
  const account = asAccount(body);
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
  let res: Response;
  try {
    res = await fetch(VOUCHER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
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
  const booted = useRef(false);

  /**
   * Resolve one session into an account. Shared by the boot and by `reload`,
   * because "refresh the token, ask the server, and act on a 401 by forgetting
   * the session" is one sequence and two copies of it drift on the 401 branch,
   * which is the branch that decides whether a signed-out user sees a sign-in
   * screen or a stuck one.
   */
  const resolve = useCallback(async (held: AccountSession): Promise<void> => {
    const fresh = await ensureFresh(held);
    if (!fresh) {
      setSession(null);
      setAccount(null);
      return;
    }
    setSession(fresh);
    const read = await fetchAccount(fresh.accessToken);
    if (read.ok) {
      setAccount(read.account);
      setError(null);
      return;
    }
    setAccount(null);
    if (read.expired) {
      storeAccountSession(null);
      setSession(null);
      setError(null);
      return;
    }
    setError(read.error);
  }, []);

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
      const held = loadAccountSession();
      if (held) await resolve(held);
      setStatus("resolved");
    })();
  }, [resolve]);

  const sendLink = useCallback(async (email: string) => {
    setBusy(true);
    const result = await sendMagicLink(email);
    setBusy(false);
    return result;
  }, []);

  const startGoogle = useCallback(() => {
    if (!isConfigured()) {
      setError(UNCONFIGURED);
      return;
    }
    setBusy(true);
    window.location.assign(googleAuthUrl());
  }, []);

  const redeem = useCallback(
    async (code: string) => {
      const held = session;
      if (!held) return { ok: false, error: "Your sign-in expired. Sign in again and retry." };
      setBusy(true);
      const fresh = await ensureFresh(held);
      if (!fresh) {
        setBusy(false);
        setSession(null);
        setAccount(null);
        return { ok: false, error: "Your sign-in expired. Sign in again and retry." };
      }
      setSession(fresh);
      const result = await redeemVoucher(fresh.accessToken, code);
      setBusy(false);
      return result;
    },
    [session],
  );

  const signOut = useCallback(async () => {
    setBusy(true);
    await signOutAccount(session);
    setSession(null);
    setAccount(null);
    setError(null);
    setBusy(false);
  }, [session]);

  const reload = useCallback(async () => {
    const held = session ?? loadAccountSession();
    if (!held) return;
    setBusy(true);
    await resolve(held);
    setBusy(false);
  }, [session, resolve]);

  return useMemo(
    () => ({
      status,
      configured: isConfigured(),
      session,
      account,
      error,
      busy,
      sendLink,
      startGoogle,
      redeem,
      signOut,
      reload,
    }),
    [status, session, account, error, busy, sendLink, startGoogle, redeem, signOut, reload],
  );
}

/**
 * Does the account layer stand between this reader and the app?
 *
 * One predicate, so the shell asks once and the screen component answers the
 * same question the same way. It is true while the answer is still unknown:
 * rendering the dashboard for a moment and replacing it with a sign-in page is
 * the app telling someone they are in and then that they are not.
 */
export function accountGateBlocks(state: AccountState): boolean {
  return state.status !== "resolved" || state.account === null || !state.account.member;
}
