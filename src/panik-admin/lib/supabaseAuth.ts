/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Supabase Auth over plain fetch. `@supabase/supabase-js` is not a dependency
 * of this repo and the design system forbids adding one for a single internal
 * screen, so the three GoTrue endpoints we need are called directly:
 *
 *   POST /auth/v1/token?grant_type=password        sign in
 *   POST /auth/v1/token?grant_type=refresh_token   keep the session alive
 *   POST /auth/v1/logout                           sign out (revokes it)
 *
 * VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are public by design: the
 * publishable key authorizes nothing on its own, and every admin table is
 * deny-all RLS. Nothing prefixed VITE_ may ever hold the secret key.
 *
 * ── WHAT THIS MODULE IS AND IS NOT ────────────────────────────────────────
 * It is a sign-in flow and a token cupboard. It is NOT the access boundary.
 * The email check below only decides which message the operator reads; the
 * decision that matters is made in server/adminIdentity.ts, which asks
 * Supabase whose session this is on every single /api/admin/* request. Editing
 * localStorage here gets a would-be admin a nicer screen and zero data.
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

/** Mirrors ADMIN_ALLOWED_EMAIL / DEFAULT_ADMIN_EMAIL in server/adminIdentity.ts. */
export const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL ?? "admin.panik@gmail.com")
  .trim()
  .toLowerCase();

const SESSION_STORAGE_KEY = "panik_admin_session";

/** Refresh this far before the token actually lapses, so a request never races it. */
const REFRESH_MARGIN_MS = 60_000;

/** Shortest password this console will set. Supabase's own floor is 6. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Marker written into the account's user_metadata the first time the operator
 * sets their own password. Its presence is the whole "is this still the
 * credential that was handed over in a chat window" test.
 *
 * It is a timestamp, not a password and not a hash of one. Nothing derived from
 * the password is ever stored, sent anywhere but Supabase, or kept in the
 * browser: the new value goes straight from the form into the authenticated
 * update call and is dropped.
 */
export const ROTATED_AT_KEY = "password_rotated_at";

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  email: string;
  /** False while the account is still on the credential it was created with. */
  passwordRotated: boolean;
}

export function isConfigured(): boolean {
  return SUPABASE_URL !== "" && PUBLISHABLE_KEY !== "";
}

/** True when this session belongs to the one address the console is built for. */
export function isAdminSession(session: Session | null): boolean {
  return session !== null && session.email === ADMIN_EMAIL;
}

// ── storage ─────────────────────────────────────────────────────────────────

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.email !== "string"
    ) {
      return null;
    }
    return { ...(parsed as Session), passwordRotated: parsed.passwordRotated === true };
  } catch {
    return null;
  }
}

function storeSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

// ── GoTrue ──────────────────────────────────────────────────────────────────

interface SupabaseUser {
  email?: string;
  user_metadata?: Record<string, unknown>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: SupabaseUser;
  error_description?: string;
  msg?: string;
  error?: string;
}

function hasRotated(user: SupabaseUser | undefined): boolean {
  return typeof user?.user_metadata?.[ROTATED_AT_KEY] === "string";
}

function toSession(body: TokenResponse): Session | null {
  if (!body.access_token || !body.refresh_token || !body.user?.email) return null;
  const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + lifetimeMs,
    email: body.user.email.trim().toLowerCase(),
    passwordRotated: hasRotated(body.user),
  };
}

async function tokenRequest(query: string, body: unknown): Promise<TokenResponse | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?${query}`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as TokenResponse;
    return res.ok ? parsed : { error: parsed.error_description ?? parsed.msg ?? "rejected" };
  } catch {
    return null;
  }
}

export interface SignInResult {
  session?: Session;
  error?: string;
}

/**
 * Sign in with email + password. The error string is deliberately the same for
 * a wrong password and an unknown account: this form is reachable by anyone who
 * finds the URL, and it should not confirm which addresses exist.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!isConfigured()) return { error: "Sign-in is not configured for this deployment." };
  const body = await tokenRequest("grant_type=password", {
    email: email.trim().toLowerCase(),
    password,
  });
  if (body === null) return { error: "Could not reach the sign-in service." };
  if (body.error) return { error: "That email and password did not match." };
  const session = toSession(body);
  if (!session) return { error: "That email and password did not match." };
  storeSession(session);
  return { session };
}

/** Exchange the refresh token for a fresh access token. Null if it is spent. */
async function refresh(session: Session): Promise<Session | null> {
  const body = await tokenRequest("grant_type=refresh_token", {
    refresh_token: session.refreshToken,
  });
  const next = body && !body.error ? toSession(body) : null;
  storeSession(next);
  return next;
}

/**
 * The access token to send with the next API call, refreshing first when it is
 * close to lapsing. Returns null when the session is gone, which the caller
 * treats as "signed out" rather than retrying.
 */
export async function activeAccessToken(session: Session): Promise<string | null> {
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
  const renewed = await refresh(session);
  return renewed?.accessToken ?? null;
}

/** Session after any refresh, so callers can keep their state in step. */
export async function ensureFresh(session: Session): Promise<Session | null> {
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;
  return refresh(session);
}

// ── password rotation ───────────────────────────────────────────────────────

/**
 * Outcomes of a change-password attempt. `reauthenticate` is not a failure: it
 * is Supabase's secure-password-change setting asking for a code emailed to the
 * account, and the form grows a field for it rather than pretending the option
 * does not exist.
 */
export type PasswordChangeResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "reauthenticate" | "weak" | "same" | "expired" | "unavailable"; message: string }
  | { ok: false; reason: "error"; message: string };

/** Ask Supabase to email a reauthentication code to the signed-in account. */
export async function requestReauthentication(session: Session): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/reauthenticate`, {
      method: "GET",
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${session.accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Set a new password on the SIGNED-IN account, with that account's own token.
 *
 * The service-role key is never involved and must never be: an operator
 * changing their own credential is exactly the operation the user's session is
 * meant to authorize, and reaching for an admin key to do it would put a
 * password-reset primitive behind something other than proof of who you are.
 * The new value goes from the form into this request and nowhere else.
 *
 * The same call stamps ROTATED_AT_KEY into user_metadata, so the next sign-in
 * knows the handover credential is retired. `data` here is user_metadata, which
 * the user may write about themselves; it holds a timestamp and no secret.
 */
export async function updatePassword(
  session: Session,
  newPassword: string,
  nonce?: string,
): Promise<PasswordChangeResult> {
  if (!isConfigured()) {
    return { ok: false, reason: "unavailable", message: "Sign-in is not configured for this deployment." };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: "weak",
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const token = await activeAccessToken(session);
  if (!token) {
    return { ok: false, reason: "expired", message: "Your session expired. Sign in again and retry." };
  }

  let res: Response;
  let body: { user_metadata?: Record<string, unknown>; error_code?: string; msg?: string; error?: string; code?: string };
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        password: newPassword,
        data: { [ROTATED_AT_KEY]: new Date().toISOString() },
        ...(nonce ? { nonce } : {}),
      }),
    });
    body = (await res.json().catch(() => ({}))) as typeof body;
  } catch {
    return { ok: false, reason: "unavailable", message: "Could not reach the sign-in service. Check your connection and retry." };
  }

  if (res.ok) {
    // The password changed, so the session's own token may be rotated by the
    // project's settings. Re-establish it rather than assuming, and keep the
    // operator signed in either way.
    const refreshed = (await refresh(session)) ?? {
      ...session,
      passwordRotated: true,
    };
    const next: Session = { ...refreshed, passwordRotated: true };
    storeSession(next);
    return { ok: true, session: next };
  }

  // Coarse, plain-language mapping. The raw upstream string is never shown: it
  // is written for an API consumer, and half of it is a schema path.
  const code = String(body.error_code ?? body.code ?? "");
  const detail = `${body.msg ?? body.error ?? ""}`.toLowerCase();
  if (code === "reauthentication_needed" || detail.includes("reauthentication")) {
    return {
      ok: false,
      reason: "reauthenticate",
      message: "This project asks you to confirm a code before changing a password. We have emailed one to your address.",
    };
  }
  if (code === "reauthentication_not_valid" || detail.includes("nonce")) {
    return { ok: false, reason: "reauthenticate", message: "That code did not match. Check the email and try again." };
  }
  if (code === "same_password" || detail.includes("should be different")) {
    return { ok: false, reason: "same", message: "That is the password you already have. Choose a different one." };
  }
  if (code === "weak_password" || detail.includes("password")) {
    return { ok: false, reason: "weak", message: `That password was rejected. Use at least ${MIN_PASSWORD_LENGTH} characters and avoid a common phrase.` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "expired", message: "Your session expired. Sign in again and retry." };
  }
  return { ok: false, reason: "error", message: "The password could not be changed. Try again in a moment." };
}

/** Revoke the session server-side, then forget it locally either way. */
export async function signOut(session: Session | null): Promise<void> {
  if (session && isConfigured()) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: PUBLISHABLE_KEY,
          Authorization: `Bearer ${session.accessToken}`,
        },
      });
    } catch {
      /* the local session is cleared regardless; the token lapses on its own */
    }
  }
  storeSession(null);
}
