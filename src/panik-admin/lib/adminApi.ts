/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin client for /api/admin/campaigns. The admin secret (ADMIN_ACCESS_KEY) is
 * held in sessionStorage and sent as the X-Admin-Key header on every call - the
 * same header-secret gate the backend checks (server/adminCampaigns.ts).
 */

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

const KEY_STORAGE = "panik_admin_key";

export const getStoredKey = (): string => sessionStorage.getItem(KEY_STORAGE) ?? "";
export const setStoredKey = (k: string): void => sessionStorage.setItem(KEY_STORAGE, k);
export const clearStoredKey = (): void => sessionStorage.removeItem(KEY_STORAGE);

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function call<T>(path: string, key: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Admin-Key": key, ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `http_${res.status}` };
    return { ok: true, status: res.status, data: body };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

export const listCampaigns = (key: string) =>
  call<{ campaigns: Campaign[] }>("/api/admin/campaigns", key);

/** The redeemed-user roster (newest first) - count + emails across all campaigns. */
export const listGrants = (key: string) =>
  call<{ grants: TrialGrant[] }>("/api/admin/campaigns?view=emails", key);

export const createCampaign = (key: string, input: CreateInput) =>
  call<{ campaign: Campaign }>("/api/admin/campaigns", key, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const expireCampaign = (key: string, id: string) =>
  call<{ campaign: Campaign }>("/api/admin/campaigns?action=expire", key, {
    method: "POST",
    body: JSON.stringify({ id }),
  });
