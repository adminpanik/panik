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

import type { Membership } from "../../panik-core/lib/account";
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

// ── dashboard metrics ───────────────────────────────────────────────────────

/**
 * The tile set. Mirrors `AdminMetrics` in server/metricsStore.ts.
 *
 * Every numeric that can be unknown is `number | null` all the way down, and
 * the panel renders null as the unknown glyph rather than a zero. `eventsReady`
 * is false where the Goldsky pipeline is not provisioned, which is a different
 * statement from "no transactions happened" and is shown as such.
 *
 * The two `*At` fields are both the OLDEST of their set, not the newest: they
 * exist to bound how much of the figure beside them is stale, and a best-case
 * timestamp cannot do that.
 */
export interface AdminMetrics {
  walletsConnected: number;
  positionsMonitored: number;
  positionsPriced: number;
  collateralUsd: number | null;
  oldestReadingAt: string | null;
  eventsReady: boolean;
  txCount: number | null;
  txVolumeUsd: number | null;
  txUnpriced: number | null;
  txOldestAt: string | null;
  generatedAt: string;
}

export const getMetrics = (session: Session) =>
  call<AdminMetrics>("/api/admin/metrics", session);

// ── market-event simulator ──────────────────────────────────────────────────

/**
 * The armed scenario as the server describes it. Mirrors `SimulationWire` in
 * server/simulationStore.ts. `expiresAt` is epoch ms, so the console renders
 * the countdown from the operator's own clock and never from a server string it
 * would have to parse a timezone out of.
 */
export interface Simulation {
  id: string;
  scenario: string;
  label: string;
  multipliers: Record<string, number>;
  startedAt: number;
  expiresAt: number;
}

/**
 * One watched position a scenario touches, as of the last watch tick.
 *
 * `multiplier` is null when the position's collateral asset was never recorded:
 * "we do not know what this holds" is not "this one is unaffected", and the
 * console renders them differently.
 */
export interface AffectedPosition {
  wallet: string;
  protocol: string;
  collateralSymbol: string | null;
  multiplier: number | null;
  updatedAt: string;
}

export interface SimulationState {
  simulation: Simulation | null;
  affected: AffectedPosition[];
  /**
   * Every collateral asset a watched wallet currently holds. The console offers
   * these rather than a free-text box, so an operator cannot arm a scenario
   * against a symbol that matches nothing and watch the demo do nothing.
   * Optional: an older server, or the serverless mirror, omits it.
   */
  assets?: string[];
}

export interface ArmSimulationInput {
  scenario: string;
  label: string;
  /** SYMBOL -> price multiplier. 0.6 = that asset is priced 40% lower. */
  multipliers: Record<string, number>;
  durationMinutes: number;
}

export const getSimulation = (session: Session) =>
  call<SimulationState>("/api/admin/simulation", session);

export const armSimulation = (session: Session, input: ArmSimulationInput) =>
  call<SimulationState>("/api/admin/simulation", session, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const clearSimulation = (session: Session) =>
  call<SimulationState>("/api/admin/simulation", session, { method: "DELETE" });

// ── accounts (the closed-beta identity roster) ──────────────────────────────

/** Frontend copy of `AccountSummary` in server/accountStore.ts. No PII beyond the email. */
export interface AccountSummary {
  userId: string;
  email: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  membership: Membership | null;
  /** The server's verdict on the grant (`isLiveMembership`); never re-derived here. */
  live: boolean;
  walletCount: number;
  telegramLinked: boolean;
}

/** Frontend copy of `AccountPage`. GoTrue returns no total, hence `hasMore`. */
export interface AccountPage {
  users: AccountSummary[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

export const listAccounts = (session: Session, page: number, perPage: number) =>
  call<AccountPage>(`/api/admin/users?page=${page}&perPage=${perPage}`, session);

/**
 * A grant as words, and the ONLY place a membership status becomes any. The
 * status is an engine enum and must never reach a screen, so the panel renders
 * this and never branches on the enum itself. Whether the grant is OPEN is the
 * server's `live`, not a second reading of `expiresAt` on this clock.
 *
 * `detail` is a second line rather than a clause inside the label: prose in a
 * value field renders clipped the moment something truncates it.
 */
export function describeAccess(
  row: Pick<AccountSummary, "membership" | "live">,
): { label: string; detail: string | null } {
  const m = row.membership;
  if (!m) return { label: "Not in beta", detail: null };
  if (!row.live) return { label: "Ended", detail: null };
  if (m.status === "trial") {
    return {
      label: "Trial",
      detail: m.expiresAt === null ? null : `until ${new Date(m.expiresAt).toLocaleDateString()}`,
    };
  }
  return { label: "Member", detail: null };
}
