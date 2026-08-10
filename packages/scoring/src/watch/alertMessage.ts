/**
 * Telegram alert copy for a profile-relative status transition.
 *
 * Pure + deterministic so it is unit-testable in-package; the HTTP send lives
 * in server/telegram.ts. Plain text (no MarkdownV2) so addresses, dots and
 * hyphens need no escaping; emojis are literal text and need no escaping
 * either. House style: hyphens only, never em dashes.
 *
 * Emoji layout: the header emoji doubles as the severity signal in the push
 * notification preview (🚨 outside, ⚠️ approaching); each fact line gets a
 * stable pictogram so the eye can find a field without reading labels; the
 * health-factor heart flips to 💔 below the near-liquidation threshold.
 */

import { ALERT_THRESHOLD } from "../profile";
import { simulationAlertLine } from "../simulation";
import type { SimulationMark } from "../simulation";
import type { Protocol } from "../types";
import type { WatchTransition } from "./loop";

/** Health factor below which we explicitly flag "near liquidation". */
const NEAR_LIQUIDATION_HF = 1.15;

const PROTOCOL_LABEL: Record<Protocol, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/** Position facts the dispatcher reads from the latest score snapshot. */
export interface AlertExtras {
  /** Protocol health factor; null = no debt (should not normally alert). */
  healthFactor?: number | null;
  collateralUsd?: number | null;
  borrowUsd?: number | null;
  /**
   * Set when the transition was produced under a market simulation. Callers
   * normally leave this alone: `formatAlert` reads the stamp off the transition
   * itself, which is the record of what was true when the crossing happened.
   * This is the path for a caller that reconstructs the transition from a
   * database row, where the label is all that was persisted.
   */
  simulation?: SimulationMark | null;
}

/** 0xabcdef...1234 */
export function truncateWallet(wallet: string): string {
  const w = wallet.trim();
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}...${w.slice(-4)}`;
}

function usd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Welcome message sent when a user connects their Telegram via the /start <code>
 * deep-link. Plain text, hyphens only (house style). Shared by both webhook
 * handlers (Railway api-server + Vercel fallback) so the copy never drifts.
 */
export function formatWelcome(wallet: string): string {
  return [
    "👋 Welcome to PANIK alerts.",
    "",
    `🔗 This chat is now linked to wallet ${truncateWallet(wallet)}.`,
    "",
    "🛡️ I'll message you here the moment this position drifts toward its liquidation limit. Alerts are debounced and deduped, so only real risk reaches you - never spam.",
    "",
    "Commands:",
    "🔕 /stop - pause alerts anytime",
    "",
    "Stay safe out there. 🧡",
  ].join("\n");
}

/**
 * Build the alert body for a transition INTO approaching/outside. (Recovery
 * transitions are filtered out by the dispatcher and never reach here.)
 */
export function formatAlert(t: WatchTransition, extras: AlertExtras = {}): string {
  const limit = ALERT_THRESHOLD[t.profile];
  const wallet = truncateWallet(t.wallet);
  const protocol = PROTOCOL_LABEL[t.protocol] ?? t.protocol;
  const outside = t.to === "outside";
  // The transition's own stamp is the record of what was true at the crossing;
  // `extras` only fills in for the dispatcher reading it back out of the row.
  const simulation = t.simulation ?? extras.simulation ?? null;

  const lines: string[] = [];
  // FIRST, above the siren, and that placement is the requirement rather than a
  // preference: a push notification shows the opening characters and nothing
  // else, so a marker buried in the body reaches the user only after they have
  // already believed the headline. A crash alert for a crash that did not happen
  // is the worst false alarm a liquidation alerter can send - it teaches the
  // user to discount the next one, which is the real one.
  if (simulation) {
    lines.push(simulationAlertLine(simulation));
    lines.push("");
  }
  lines.push(
    outside
      ? "🚨 Panik alert - position past your risk limit"
      : "⚠️ Panik alert - position approaching your risk limit",
  );
  lines.push("");
  lines.push(`👛 Wallet ${wallet}`);
  lines.push(`🏦 Protocol ${protocol}`);
  lines.push(`📊 Risk score ${t.score} / 100 (${t.band}), your ${t.profile} limit is ${limit}`);

  if (extras.healthFactor != null && Number.isFinite(extras.healthFactor)) {
    const hf = extras.healthFactor.toFixed(2);
    lines.push(
      extras.healthFactor < NEAR_LIQUIDATION_HF
        ? `💔 Health factor ${hf} - near liquidation`
        : `❤️ Health factor ${hf}`,
    );
  }

  const collateral = usd(extras.collateralUsd);
  const borrow = usd(extras.borrowUsd);
  if (collateral && borrow) lines.push(`💰 Position ${collateral} collateral / ${borrow} debt`);

  lines.push("");
  lines.push(
    outside
      ? "⛔ Your position has crossed your risk threshold and is trending toward liquidation. Act now: add collateral or repay debt to pull it back."
      : "⏳ This position is getting close to your liquidation comfort zone. Consider adding collateral or repaying debt before it crosses the line.",
  );

  // Bookended on purpose. The action line above tells the user to act, and under
  // a simulation that instruction is answering a price that did not move; the
  // marker has to be the last thing read as well as the first, so no crop of
  // this message shows an instruction without the reason it was issued.
  if (simulation) {
    lines.push("");
    lines.push(
      "🧪 Reminder: the price move above is simulated. Nothing has happened to the market.",
    );
  }

  return lines.join("\n");
}
