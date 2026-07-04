/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * PANIK business-card details. Always shown on /try regardless of code state.
 * Hardcoded here (like the landing/founding marketing copy) - there is no
 * structured "business details" config store in the repo.
 */

export const BUSINESS_CARD = {
  name: "PANIK",
  tagline: "Real-time liquidation risk radar for DeFi.",
  website: "panik.fi",
  websiteUrl: "https://panik.fi",
  twitterHandle: "@panik_fi",
  twitterUrl: "https://x.com/panik_fi",
} as const;
