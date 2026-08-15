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

/**
 * Whether a scored thing BELONGS to a profile: its score is under the limit
 * that profile alerts at.
 *
 * Membership is one boundary, not a window. A conservative reader is not shown
 * a market and told "too safe for you"; the profile says where the alerts start
 * and everything below that is theirs to pick from. `approaching` therefore
 * fits: it is under the limit, and the point of the warning zone is that it has
 * not been crossed yet.
 *
 * Exported because the Compass grid was partitioning its catalog on windows it
 * invented (<20 / 20-49 / >=50 by profile) while the engine alerted at 25 / 50 /
 * 75, so an aggressive reader was recommended only the markets their own limit
 * would fire on, and the two safest markets in the catalog were filed under
 * "Outside your profile". It delegates to `statusFor` rather than comparing
 * against `ALERT_THRESHOLD` again, so there is still exactly one place the
 * boundary is read and the split and the alert can never disagree.
 */
export function fitsProfile(profile: RiskProfile, score: number): boolean {
  return statusFor(profile, score) !== "outside";
}
