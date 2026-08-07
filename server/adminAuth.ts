/**
 * Brute-force brake for the admin shared secret (ADMIN_ACCESS_KEY).
 *
 * ── WHY THIS IS NOT KEYED ON THE CLIENT IP ────────────────────────────────
 * An IP-keyed failed-auth lockout is a weapon pointed at the operator: anyone
 * can burn 5 wrong keys and lock the real admin out for 15 minutes, renewably,
 * from an address the admin may even share with them (behind a proxy the whole
 * site can share one address). An unauthenticated caller must never be able to
 * degrade service for the legitimate admin.
 *
 * So the counter is keyed on the CREDENTIAL that was presented — a digest
 * prefix of the supplied key. Guessing "hunter2" repeatedly only ever locks out
 * "hunter2"; the real key is untouched, and because each distinct typo has its
 * own counter, an admin who fat-fingers different values is never locked either.
 * A correct key skips every gate and resets the counters (the "consecutive" in
 * the docs is now true — failures reset on success).
 *
 * On top of that a GLOBAL exponential backoff throttles a distributed guessing
 * campaign that rotates both IPs and candidate keys. It can only ever reject
 * requests that already failed authentication, so it cannot lock out the admin.
 */

import { createHash } from "node:crypto";

import { checkAdminKey, type AdminAuth } from "./adminCampaigns";

/** Consecutive failures on ONE credential before it is locked out. */
const MAX_CREDENTIAL_FAILURES = 5;
/** Lockout applied to that credential once the threshold is reached. */
const CREDENTIAL_LOCKOUT_MS = 15 * 60_000;
/** Distinct wrong credentials tracked. Bounded: the keys are caller-supplied. */
const MAX_TRACKED_CREDENTIALS = 4_096;
/** Global failures tolerated before the exponential backoff kicks in. */
const GLOBAL_FAILURE_THRESHOLD = 20;
/** First global backoff step; doubles per further failure, capped. */
const GLOBAL_BACKOFF_BASE_MS = 1_000;
const GLOBAL_BACKOFF_MAX_MS = 5 * 60_000;

export type AdminVerdict = AdminAuth | "locked";

export interface AdminAuthResult {
  auth: AdminVerdict;
  /** Seconds the caller should wait; only set for "locked". */
  retryAfterSec?: number;
}

interface CredentialState {
  failures: number;
  lockedUntil: number;
  /** Epoch ms of the last failure — a stale counter ages out (see track()). */
  lastFailureAt: number;
}

/** Digest prefix of the presented key — never the key itself, this is logged-adjacent. */
function credentialId(provided: string | undefined): string {
  if (provided === undefined || provided === "") return "absent";
  return createHash("sha256").update(provided).digest("hex").slice(0, 16);
}

export class AdminAuthGate {
  private readonly credentials = new Map<string, CredentialState>();
  private globalFailures = 0;
  private globalBackoffUntil = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly verify: (provided: string | undefined) => AdminAuth = checkAdminKey,
  ) {}

  /**
   * Authorize one admin request. `provided` is the raw x-admin-key header.
   * Never throws; the caller maps the verdict to a status code.
   */
  authorize(provided: string | undefined): AdminAuthResult {
    const now = this.now();
    const id = credentialId(provided);
    const state = this.credentials.get(id);

    if (state && state.lockedUntil > now) {
      return { auth: "locked", retryAfterSec: seconds(state.lockedUntil - now) };
    }
    if (this.globalBackoffUntil > now && !this.isCorrect(provided)) {
      return { auth: "locked", retryAfterSec: seconds(this.globalBackoffUntil - now) };
    }

    const verdict = this.verify(provided);
    if (verdict === "unconfigured") return { auth: verdict };
    if (verdict === "ok") {
      // M3: reset on success, so "consecutive" means consecutive.
      this.credentials.delete(id);
      this.globalFailures = 0;
      this.globalBackoffUntil = 0;
      return { auth: "ok" };
    }

    this.recordFailure(id, state, now);
    return { auth: "forbidden" };
  }

  /** Tracked wrong-credential count — for tests and diagnostics. */
  size(): number {
    return this.credentials.size;
  }

  private isCorrect(provided: string | undefined): boolean {
    return this.verify(provided) === "ok";
  }

  private recordFailure(id: string, state: CredentialState | undefined, now: number): void {
    const entry = state ?? this.track(id, now);
    if (entry) {
      // A counter that has gone quiet for a whole lockout period starts over:
      // "consecutive" must not mean "ever, across days".
      if (now - entry.lastFailureAt >= CREDENTIAL_LOCKOUT_MS) entry.failures = 0;
      entry.failures += 1;
      entry.lastFailureAt = now;
      if (entry.failures >= MAX_CREDENTIAL_FAILURES) {
        entry.lockedUntil = now + CREDENTIAL_LOCKOUT_MS;
        entry.failures = 0;
      }
    }
    this.globalFailures += 1;
    if (this.globalFailures >= GLOBAL_FAILURE_THRESHOLD) {
      const step = this.globalFailures - GLOBAL_FAILURE_THRESHOLD;
      const wait = Math.min(GLOBAL_BACKOFF_BASE_MS * 2 ** step, GLOBAL_BACKOFF_MAX_MS);
      this.globalBackoffUntil = now + wait;
    }
  }

  /**
   * Start tracking a new wrong credential, dropping EXPIRED entries to make
   * room. A live lockout is never evicted — that is exactly the "flood the map
   * to clear the lockout" bypass. When every slot is locked we simply stop
   * tracking new credentials; the global backoff still covers that case.
   */
  private track(id: string, now: number): CredentialState | null {
    if (this.credentials.size >= MAX_TRACKED_CREDENTIALS) {
      for (const [key, value] of this.credentials) {
        const dead = value.lockedUntil <= now && now - value.lastFailureAt >= CREDENTIAL_LOCKOUT_MS;
        if (dead) this.credentials.delete(key);
      }
      if (this.credentials.size >= MAX_TRACKED_CREDENTIALS) return null;
    }
    const fresh: CredentialState = { failures: 0, lockedUntil: 0, lastFailureAt: now };
    this.credentials.set(id, fresh);
    return fresh;
  }
}

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** Process-wide gate used by the Express route and the Vercel function. */
export const adminAuthGate = new AdminAuthGate();
