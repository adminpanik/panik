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
 */

import { ALERT_POLICY } from "../params";
import type { ProfileStatus } from "../types";

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
}

export type SendReason = "send" | "skipped" | "suppressed_immaterial" | "suppressed_cooldown";

export function decideSend(input: SendDecisionInput): SendReason {
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
    return "send";
  }

  // 1. Materiality: a position with no real debt cannot be liquidated.
  if (input.healthFactor == null || !Number.isFinite(input.healthFactor)) {
    return "suppressed_immaterial";
  }
  // A non-null HF already proves debt exists; minBorrowUsd only filters dust.
  // With the USD magnitude unknown the gate is unevaluable, so it is EXEMPTED
  // (a degraded six-figure debt must not be silently classed as dust).
  if (
    !input.usdValuesUnavailable &&
    (input.borrowUsd == null || input.borrowUsd < ALERT_POLICY.minBorrowUsd)
  ) {
    return "suppressed_immaterial";
  }

  const prior = input.prior;
  if (!prior) return "send"; // first alert for this position

  // 2. Escalation: approaching -> outside is worse news; bypass the cooldown.
  if (input.toStatus === "outside" && prior.toStatus === "approaching") return "send";

  // 3. Cooldown ceiling.
  if (input.createdAt - prior.createdAt >= ALERT_POLICY.cooldownMs) return "send";

  return "suppressed_cooldown";
}
