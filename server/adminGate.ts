/**
 * The gate on /api/admin/*. Two credentials are accepted and neither is
 * optional: whichever one arrives, something has to authenticate.
 *
 *   Authorization: Bearer <supabase jwt>  -> the console's signed-in operator,
 *                                            resolved by server/adminIdentity.
 *   X-Admin-Key: <shared secret>          -> the pre-existing script/curl path,
 *                                            resolved by server/adminAuth.
 *
 * A bearer, once presented, is answered here and never falls through to the
 * shared secret: a caller who offered a credential and failed does not get a
 * second guess at a different one, and the secret's brute-force brake stays
 * keyed on the secret alone (see the note at the top of server/adminAuth.ts
 * about why that brake must never be keyed on anything a stranger controls).
 *
 * Two faces on one core, the same shape as server/rateLimit.ts:
 *   - adminBearerGate()       Express middleware (scripts/api-server.ts). Owns
 *                             ONLY the bearer branch; with no bearer it calls
 *                             next() and the route's existing requireAdmin()
 *                             shared-secret check runs unchanged. On success it
 *                             stamps res.locals.adminAuthed so that check
 *                             short-circuits rather than demanding a secret the
 *                             signed-in operator never had.
 *   - authorizeAdminRequest() transport-agnostic, for the api/ serverless
 *                             fallbacks, which have no middleware chain.
 */

import type { NextFunction, Request, Response } from "express";

import { adminAuthGate } from "./adminAuth";
import { bearerToken, verifyAdminIdentity } from "./adminIdentity";

export type AdminReqHeaders = Record<string, string | string[] | undefined>;

export type AdminRequestVerdict =
  | { ok: true; email?: string }
  | { ok: false; status: number; body: { error: string; retryAfterSec?: number } };

function header(headers: AdminReqHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function adminBearerGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req.header("authorization"));
  if (token === "") {
    next();
    return;
  }
  const verdict = await verifyAdminIdentity(token);
  if (verdict.ok) {
    res.locals.adminAuthed = true;
    res.locals.adminEmail = verdict.email;
    next();
    return;
  }
  res.status(verdict.status).json({ error: verdict.error });
}

/**
 * Whole-request authorization for a transport with no middleware chain. Same
 * precedence as the Express pair: bearer if one is presented, shared secret
 * otherwise, refusal if neither authenticates.
 */
export async function authorizeAdminRequest(
  headers: AdminReqHeaders,
): Promise<AdminRequestVerdict> {
  const token = bearerToken(header(headers, "authorization"));
  if (token !== "") {
    const identity = await verifyAdminIdentity(token);
    return identity.ok
      ? { ok: true, email: identity.email }
      : { ok: false, status: identity.status, body: { error: identity.error } };
  }

  // Guessing brake keyed on the PRESENTED credential (server/adminAuth.ts), so
  // no stranger can lock the real admin out. State is per-isolate on the
  // serverless side, which only ever makes the brake more lenient — never the
  // admin less available.
  const { auth, retryAfterSec } = adminAuthGate.authorize(header(headers, "x-admin-key"));
  if (auth === "unconfigured") {
    return { ok: false, status: 503, body: { error: "admin unconfigured (ADMIN_ACCESS_KEY)" } };
  }
  if (auth === "locked") {
    return {
      ok: false,
      status: 429,
      body: { error: "too many failed admin auth attempts", retryAfterSec },
    };
  }
  if (auth === "forbidden") return { ok: false, status: 401, body: { error: "unauthorized" } };
  return { ok: true };
}
