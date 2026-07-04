/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Thin client for the /try redemption endpoint. The browser never touches the
 * DB directly here (unlike the waitlist): redemption goes through /api/try/redeem
 * so the backend can capture IP/UA and hold the Supabase secret key.
 */

import type { RedeemOutcome } from "./trialLogic";

export type { RedeemOutcome };

export interface RedeemResponse {
  ok: boolean;
  outcome?: RedeemOutcome;
  /** Present on success: the unique /app?trial=... link for this user. */
  trialUrl?: string;
  error?: string;
}

/** Redeem a campaign code (scan or manual). Never throws - returns a result. */
export async function redeemCode(code: string, honeypot = ""): Promise<RedeemResponse> {
  try {
    const res = await fetch("/api/try/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, honeypot }),
    });
    const body = (await res.json().catch(() => ({}))) as RedeemResponse;
    if (!res.ok && !body.outcome) {
      return { ok: false, error: body.error ?? `http_${res.status}` };
    }
    return body;
  } catch {
    return { ok: false, error: "network" };
  }
}
