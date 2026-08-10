/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client for /api/admin/*. Every call carries the signed-in operator's Supabase
 * access token as `Authorization: Bearer <jwt>`; the server resolves that token
 * with Supabase and refuses any identity other than the allow-listed admin
 * (server/adminIdentity.ts). The token is short lived and is refreshed by
 * lib/supabaseAuth.ts immediately before each call.
 *
 * The older `x-admin-key` shared-secret path still works server-side for
 * scripts and curl; this console no longer uses it, so no long-lived secret is
 * kept in browser storage at all.
 */

import { activeAccessToken, type Session } from "./supabaseAuth";

/** Frontend copy of the campaign row shape (server type lives in campaignStore). */
export interface Campaign {
  id: string;
  campaign_code: string;
  label: string | null;
  max_redemptions: number;
  redemption_count: number;
  trial_duration_hours: number;
  claim_window_expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateInput {
  label?: string;
  trialDays: number;
  maxRedemptions: number;
  claimWindowDays?: number;
}

/**
 * One redeemed grant = one user. This is the "how many + who" roster: the row
 * count is the user count, and `email` is the captured contact. Mirrors the
 * server TrialGrant in server/campaignStore.ts.
 */
export interface TrialGrant {
  email: string | null;
  campaign_code: string | null;
  campaign_label: string | null;
  first_opened_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** One successful redemption of a single campaign. Mirrors CampaignRedemption. */
export interface CampaignRedemption {
  email: string | null;
  claim_ip: string | null;
  claim_user_agent: string | null;
  first_opened_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export type RedeemOutcome = "success" | "not_found" | "disabled" | "expired" | "exhausted";

/** One attempt against a code, successful or not. Mirrors RedemptionAttempt. */
export interface RedemptionAttempt {
  outcome: RedeemOutcome;
  ip: string | null;
  user_agent: string | null;
  granted: boolean;
  created_at: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** Status the caller must treat as "you are signed out", not as a retryable error. */
export const isSignedOut = (status: number): boolean => status === 401;

async function call<T>(path: string, session: Session, init?: RequestInit): Promise<ApiResult<T>> {
  const token = await activeAccessToken(session);
  if (!token) return { ok: false, status: 401, error: "Your session has expired." };
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `http_${res.status}` };
    return { ok: true, status: res.status, data: body };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server." };
  }
}

export const listCampaigns = (session: Session) =>
  call<{ campaigns: Campaign[] }>("/api/admin/campaigns", session);

/** The redeemed-user roster (newest first) - count + emails across all campaigns. */
export const listGrants = (session: Session) =>
  call<{ grants: TrialGrant[] }>("/api/admin/campaigns?view=emails", session);

/** Who redeemed ONE campaign, plus every attempt against it (failures included). */
export const listRedemptions = (session: Session, code: string) =>
  call<{ code: string; redemptions: CampaignRedemption[]; attempts: RedemptionAttempt[] }>(
    `/api/admin/redemptions?code=${encodeURIComponent(code)}`,
    session,
  );

export const createCampaign = (session: Session, input: CreateInput) =>
  call<{ campaign: Campaign }>("/api/admin/campaigns", session, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const expireCampaign = (session: Session, id: string) =>
  call<{ campaign: Campaign }>("/api/admin/campaigns?action=expire", session, {
    method: "POST",
    body: JSON.stringify({ id }),
  });
