/**
 * Dispatcher send-decision: the anti-spam / false-alarm gate applied to a
 * confirmed transition BEFORE a Telegram message goes out. Pure given inputs so
 * it is unit-testable; the worker (scripts/watch-worker.ts) supplies the rows.
 *
 * Layers (see params.ALERT_POLICY and the plan's anti-spam section):
 *  1. Materiality: no debt (HF null) or sub-dust borrow never alerts - a "safe"
 *     position cannot be liquidated, whatever its composite score.
 *  2. Escalation bypass: approaching -> outside always sends (strictly worse).
 *  3. Cooldown: otherwise at most one alert per (wallet, protocol) per window.
 *
 * Recovery transitions (to_status === "within") are filtered out upstream and
 * never reach this function.
 */

import { ALERT_POLICY } from "../params";
import type { ProfileStatus } from "../types";

/** The most recent Telegram alert actually SENT for this (wallet, protocol). */
export interface PriorAlert {
  toStatus: ProfileStatus;
  /** epoch ms */
  createdAt: number;
}

export interface SendDecisionInput {
  /** "approaching" | "outside" (recovery filtered earlier). */
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
  /** Last sent alert for this position, or null if none. */
  prior: PriorAlert | null;
}

export type SendReason = "send" | "suppressed_immaterial" | "suppressed_cooldown";

export function decideSend(input: SendDecisionInput): SendReason {
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
