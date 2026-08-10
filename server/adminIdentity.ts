/**
 * Supabase-session identity check for /api/admin/*.
 *
 * The admin console signs in with email + password against Supabase Auth and
 * then carries the access token as `Authorization: Bearer <jwt>`. THIS module
 * is the trust boundary: it asks Supabase who the token belongs to and compares
 * that answer against a single allow-listed address.
 *
 * ── WHY WE CALL SUPABASE INSTEAD OF READING THE CLAIMS ────────────────────
 * A JWT is caller-supplied text. Its `email` claim is a claim, not a fact, and
 * decoding it locally without checking the signature authenticates nobody — an
 * attacker can hand us `{"email":"admin.panik@gmail.com"}` with no signature at
 * all. So the verdict comes from `GET /auth/v1/user`, which validates the
 * signature, the expiry AND the session's revocation state on Supabase's side.
 * There is deliberately no positive cache: a cache is a window in which a
 * signed-out or deleted session still opens the door.
 *
 * The local pre-check below is a COST filter, never an authorization step. It
 * rejects text that cannot possibly be a live token so that a flood of garbage
 * does not turn one unauthenticated request into one outbound round trip.
 *
 * The allowed address lives in ADMIN_ALLOWED_EMAIL so it is configuration, not
 * a literal sprinkled through the code. Emails are not secrets, so the compare
 * is a plain normalized equality; the secret in this exchange is the token, and
 * only Supabase ever compares that.
 */

/** Sole account permitted through the admin surface unless overridden. */
export const DEFAULT_ADMIN_EMAIL = "admin.panik@gmail.com";

/** Tokens longer than this are refused before we spend a network call. */
const MAX_TOKEN_CHARS = 4_096;

export type IdentityVerdict =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 502 | 503; error: string };

export interface IdentityDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** The one address allowed in, normalized the way Supabase stores emails. */
export function allowedAdminEmail(): string {
  const configured = process.env.ADMIN_ALLOWED_EMAIL?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_ADMIN_EMAIL).toLowerCase();
}

/**
 * The `apikey` header GoTrue requires alongside the bearer token. The
 * publishable key is the right one (it grants nothing on its own); the secret
 * key is only a last resort so a deploy that never set the publishable one
 * still authenticates rather than silently refusing the admin.
 */
function supabaseApiKey(): string | undefined {
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_SECRET_KEY
  );
}

/** Pull the token out of an Authorization header. Returns "" when absent. */
export function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : "";
}

/**
 * Cheap shape + expiry screen. NOT verification: the payload is read without
 * checking the signature, so a `true` here means only "worth asking Supabase".
 * A forged token sails through this and is rejected by the round trip below.
 */
function couldBeLiveToken(token: string, now: number): boolean {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    // No exp is not our call to make; let Supabase decide. A past exp is.
    if (typeof payload.exp === "number" && payload.exp * 1000 <= now) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bearer token to the admin identity, or say why not. Never throws.
 * The error strings are deliberately coarse: they tell the operator which wall
 * they hit without telling a prober whether the account exists.
 */
export async function verifyAdminIdentity(
  token: string,
  deps: IdentityDeps = {},
): Promise<IdentityVerdict> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = (deps.now ?? Date.now)();

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const apikey = supabaseApiKey();
  if (!url || !apikey) {
    return { ok: false, status: 503, error: "admin sign-in unconfigured (SUPABASE_URL / key)" };
  }
  if (!couldBeLiveToken(token, now)) {
    return { ok: false, status: 401, error: "session expired or invalid" };
  }

  let res: Response;
  try {
    res = await doFetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
  } catch {
    // Upstream unreachable. Failing closed is the only safe direction here.
    return { ok: false, status: 502, error: "could not reach the sign-in service" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 401, error: "session expired or invalid" };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: "could not reach the sign-in service" };
  }

  let user: { id?: unknown; email?: unknown };
  try {
    user = (await res.json()) as { id?: unknown; email?: unknown };
  } catch {
    return { ok: false, status: 502, error: "could not reach the sign-in service" };
  }

  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  if (typeof user.id !== "string" || user.id === "" || email === "") {
    return { ok: false, status: 401, error: "session expired or invalid" };
  }
  if (email !== allowedAdminEmail()) {
    return { ok: false, status: 403, error: "this account is not an admin" };
  }
  return { ok: true, email };
}
