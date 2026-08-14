import type { ProfileStatus, RiskProfile } from "./types";

/** Alert thresholds — arch §Risk Profiles / biz plan profile table. */
export const ALERT_THRESHOLD: Record<RiskProfile, number> = {
  conservative: 25,
  moderate: 50,
  aggressive: 75,
};

/** Width of the "Approaching" zone below the threshold (arch: 10 points). */
export const APPROACHING_WINDOW = 10;

/**
 * The score at which this profile starts WARNING - the bottom of the
 * approaching zone, and the number an alert has to be able to quote.
 *
 * Exported because the alert copy has to explain itself: a score of 15 with a
 * conservative limit of 25 reads as a contradiction ("LOW, and you are
 * messaging me?") until the message names the boundary it actually crossed.
 * `statusFor` below is the only other place the arithmetic appears, and it uses
 * this function rather than repeating it, so the sentence and the decision can
 * never disagree.
 */
export function warnFrom(profile: RiskProfile): number {
  return ALERT_THRESHOLD[profile] - APPROACHING_WINDOW;
}

/**
 * Position status relative to the USER's profile, not a generic band —
 * powers Watch's "Within / Approaching / Outside" display.
 */
export function statusFor(profile: RiskProfile, score: number): ProfileStatus {
  if (score >= ALERT_THRESHOLD[profile]) return "outside";
  if (score >= warnFrom(profile)) return "approaching";
  return "within";
}
