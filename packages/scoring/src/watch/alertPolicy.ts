/**
 * Dispatcher send-decision: the anti-spam / false-alarm gate applied to a
 * confirmed transition BEFORE a Telegram message goes out. Pure given inputs so
 * it is unit-testable; the worker (scripts/watch-worker.ts) supplies the rows.
 *
 * Layers (see params.ALERT_POLICY and the plan's anti-spam section):
 *  0. Recovery (to_status === "within"): a resolution notification, rate-limited
 *     to one per alert actually sent.
 *  1. Materiality: no debt (HF null) or sub-dust borrow never alerts - a "safe"
 *     position cannot be liquidated, whatever its composite score.
 *  2. Escalation bypass: approaching -> outside always sends (strictly worse).
 *  3. Cooldown: otherwise at most one alert per (wallet, protocol) per window.
 *
 * Recovery transitions used to be filtered out upstream; since 7.2 they reach
 * this function and are routed to `formatResolution` when it returns "send".
 *
 * 7.4 / 7.5 add a fourth layer ON TOP, never underneath: the user's own
 * preferences (watch/alertSettings.ts). Mute, quiet hours and digest batching
 * are consulted only AFTER the layers above said "send", and only for an alert
 * `isCriticalAlert` says is not critical. That ordering is the safety property:
 * there is no path from a preference to withholding a critical alert, and the
 * tests in tests/alertPolicy.test.ts assert it rather than a comment claiming it.
 */

import type { Band, ProfileStatus, Protocol } from "../types";
import {
  DEFAULT_ALERT_SETTINGS,
  effectiveCooldownMs,
  inQuietHours,
  isCriticalAlert,
  isMuted,
  type AlertSettings,
} from "./alertSettings";

/** The most recent Telegram message actually SENT for this (wallet, protocol). */
export interface PriorAlert {
  toStatus: ProfileStatus;
  /** epoch ms */
  createdAt: number;
}

export interface SendDecisionInput {
  /** "within" (resolution) | "approaching" | "outside" (alert). */
  toStatus: ProfileStatus;
  /** This transition's timestamp (epoch ms). */
  createdAt: number;
  /** Latest known health factor; null = no debt. */
  healthFactor: number | null;
  /** Latest known borrow value in USD; null/0 = no debt. */
  borrowUsd: number | null;
  /**
   * True when the reader could not value the position in USD (degraded price
   * feed). `borrowUsd` is then null for want of a PRICE, not for want of DEBT
   * — the materiality gate must be waived, not silently failed.
   */
  usdValuesUnavailable?: boolean;
  /**
   * The last message SENT for this position, or null if none.
   *
   * For an alert this is the last sent ALERT, recoveries excluded, so a
   * resolution never resets the alert cooldown clock. For a recovery it is the
   * last sent message of EITHER kind, which is what makes one resolution per
   * alert the ceiling.
   */
  prior: PriorAlert | null;
  /**
   * The subscriber's own tuning. Absent = `DEFAULT_ALERT_SETTINGS`, which is
   * byte-for-byte the behaviour this function had before 7.4.
   */
  settings?: AlertSettings;
  /** Engine band for this transition, used only to widen what counts as critical. */
  band?: Band | null;
  /** Watched wallet + protocol, for the per-position / per-protocol mute. */
  wallet?: string;
  protocol?: Protocol;
  /**
   * When the decision is being MADE, which is not when the transition happened:
   * quiet hours are a fact about the clock at send time. Defaults to
   * `createdAt`, so a caller that does not care keeps the old behaviour.
   */
  nowMs?: number;
}

export type SendReason =
  | "send"
  | "skipped"
  | "suppressed_immaterial"
  | "suppressed_cooldown"
  /** The user muted this protocol or this position. Resolved, never sent. */
  | "suppressed_muted"
  /** Held until quiet hours end. NOT resolved - the caller must re-consider it. */
  | "deferred_quiet"
  /** Held for the next digest. NOT resolved - the caller batches and sends it. */
  | "deferred_digest";

/** A decision the dispatcher must revisit rather than stamp. */
export function isDeferred(reason: SendReason): boolean {
  return reason === "deferred_quiet" || reason === "deferred_digest";
}

/**
 * The preference layer, applied to a decision the safety layers already
 * approved. Critical alerts never reach it (see `decideSend`).
 */
function applyPreferences(input: SendDecisionInput, settings: AlertSettings): SendReason {
  const at = input.nowMs ?? input.createdAt;
  if (inQuietHours(at, settings)) return "deferred_quiet";
  if (settings.digest !== "off") return "deferred_digest";
  return "send";
}

export function decideSend(input: SendDecisionInput): SendReason {
  const settings = input.settings ?? DEFAULT_ALERT_SETTINGS;
  // Computed FIRST and consulted before every preference branch below. This is
  // the structural form of "critical always breaks through": the preference
  // code is unreachable for a critical alert, rather than guarded by a flag
  // somebody could reorder.
  const critical = isCriticalAlert(input.toStatus, input.band);
  const muted =
    input.wallet !== undefined &&
    input.protocol !== undefined &&
    isMuted(settings, input.wallet, input.protocol);

  // 0. Recovery -> resolution notification (7.2).
  //
  // The materiality gate is deliberately NOT applied here: a debt repaid to
  // zero leaves HF null, and that is the best recovery there is, not an
  // immaterial one. The prior alert already passed the gate, which is exactly
  // why requiring one is the whole check.
  if (input.toStatus === "within") {
    const prior = input.prior;
    // Never alerted on this position, so there is nothing to resolve. Recorded
    // as "skipped" (the channel value recoveries have always carried).
    if (!prior) return "skipped";
    // Already sent the all-clear since the last alert: this is a flap, not
    // news. Without this, outside -> within -> outside -> within is four
    // messages for one position that never left its band.
    if (prior.toStatus === "within") return "suppressed_cooldown";
    // An all-clear is good news and good news can wait: it is muted, held for
    // quiet hours and batched exactly like a non-critical alert.
    if (muted) return "suppressed_muted";
    return applyPreferences(input, settings);
  }

  // 1. Materiality: a position with no real debt cannot be liquidated.
  if (input.healthFactor == null || !Number.isFinite(input.healthFactor)) {
    return "suppressed_immaterial";
  }
  // A non-null HF already proves debt exists; minBorrowUsd only filters dust.
  // With the USD magnitude unknown the gate is unevaluable, so it is EXEMPTED
  // (a degraded six-figure debt must not be silently classed as dust).
  //
  // The threshold is the user's when they set one: raising it says "this
  // position is too small to be worth a message", which is a statement about
  // STAKES and stays true whatever the urgency, so it applies to critical
  // alerts too.
  if (
    !input.usdValuesUnavailable &&
    (input.borrowUsd == null || input.borrowUsd < settings.minBorrowUsd)
  ) {
    return "suppressed_immaterial";
  }

  // 1b. Mute (7.4) - never for a critical alert. A muted protocol means "spare
  // me the warnings", not "let me be liquidated in peace".
  if (muted && !critical) return "suppressed_muted";

  const prior = input.prior;
  // 2. Escalation: approaching -> outside is worse news; bypass the cooldown.
  const escalation =
    prior !== null && input.toStatus === "outside" && prior.toStatus === "approaching";

  if (prior !== null && !escalation) {
    // 3. Cooldown ceiling. A user may shorten it; for a critical alert they may
    // not lengthen it past the calibrated default (see effectiveCooldownMs).
    if (input.createdAt - prior.createdAt < effectiveCooldownMs(settings, critical)) {
      return "suppressed_cooldown";
    }
  }

  // 4. Preferences, last and only for the non-critical.
  return critical ? "send" : applyPreferences(input, settings);
}
