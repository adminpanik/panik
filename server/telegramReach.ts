/**
 * Telegram reachability (Phase 4.B) — LINKED, SUBSCRIBED and REACHABLE are
 * three different facts, and the product used to report one number for all
 * three.
 *
 * ── THE HONESTY GAP THIS CLOSES ─────────────────────────────────────────────
 *
 * `/api/telegram/status` returned `{ linked: Boolean(link?.enabled) }`. That
 * flag is set once, when the user presses Start, and is only ever cleared in
 * two places: the user sending /stop, and the dispatcher seeing a 403 AFTER a
 * failed send. So a user who blocks the bot the day after linking reads as
 * fully alerted until the first alert fails — and the first alert IS the
 * emergency. The UI showed a green Telegram card to a user the bot could not
 * reach, which is exactly "the user believed they were protected and were not".
 *
 * ── THE THREE STATES ────────────────────────────────────────────────────────
 *
 *   LINKED       a telegram_links row exists for this wallet. The user did the
 *                setup. Nothing more.
 *   SUBSCRIBED   `enabled` is true: they have not sent /stop and the bot has
 *                not been 403'd off them.
 *   REACHABLE    the bot has PROVEN it can deliver, recently. Proof is either a
 *                real alert that Telegram accepted, or a lightweight probe.
 *
 * Reachability is deliberately THREE-valued, not boolean. A link created five
 * minutes ago has no delivery history, and calling that "unreachable" would be
 * inventing a failure exactly as dishonestly as calling it "reachable" invents
 * a success. `unverified` is the truthful third answer, and the API ships the
 * timestamp with it so a surface can say "unverified since <date>" instead of
 * picking a side.
 *
 * ── WHY sendChatAction IS THE PROBE ─────────────────────────────────────────
 *
 * `getChat` still succeeds for a user who blocked the bot, so it proves
 * nothing. `sendMessage` proves everything and spams the user. `sendChatAction`
 * with "typing" is the middle: Telegram runs the same delivery permission check
 * and returns 403 "bot was blocked by the user", but the user sees at most a
 * typing indicator that disappears on its own. It is the only lightweight call
 * that actually answers the question.
 */

/** What the bot's ability to deliver is currently known to be. */
export type ReachabilityStatus = "reachable" | "unreachable" | "unverified";

/** The stored link, as far as reachability is concerned. */
export interface TelegramLinkRow {
  chatId: number;
  enabled: boolean;
  /** Last alert Telegram ACCEPTED, epoch ms. Null when none ever landed. */
  lastDeliveredAt: number | null;
  /** Last probe attempt, epoch ms. */
  lastProbeAt: number | null;
  /** Did that probe succeed? Null when never probed. */
  lastProbeOk: boolean | null;
  /** When the bot was first observed to be blocked, epoch ms. */
  unreachableSince: number | null;
}

/**
 * How long a successful delivery keeps counting as proof.
 *
 * Seven days. A user can block the bot at any moment, so no window makes this
 * certain; what the window buys is a bound on how stale the claim can be before
 * the surface stops asserting it. Seven days also matches the probe cadence
 * below with room for a few missed probes.
 */
export const REACHABILITY_TTL_MS = 7 * 86_400_000;

/**
 * How often to probe a link whose reachability proof is going stale.
 *
 * Daily. Cheap (one API call per linked wallet per day, well inside Telegram's
 * limits) and it keeps every active link inside the TTL without ever messaging
 * anyone.
 */
export const PROBE_INTERVAL_MS = 24 * 3_600_000;

/** The full state, as the API reports it. */
export interface TelegramLinkState {
  linked: boolean;
  subscribed: boolean;
  reachability: ReachabilityStatus;
  /** When reachability was last PROVEN, epoch ms. Null when never. */
  reachableAt: number | null;
  /** When the bot was first seen blocked, epoch ms. */
  unreachableSince: number | null;
  /**
   * May an alert be attempted at all? False only when we have EVIDENCE it
   * would fail. This is the flag a UI may use to claim the user is alerted —
   * and it is strictly stronger than the old `enabled` bit it replaces.
   */
  alertsDeliverable: boolean;
}

/**
 * Derive the three states from a stored row.
 *
 * The ordering encodes the honesty rule: evidence of failure beats evidence of
 * success beats no evidence. `unreachableSince` is set only when Telegram
 * itself returned 403, so it is the strongest signal available and it wins even
 * over a recent delivery.
 */
export function linkState(row: TelegramLinkRow | null, now: number): TelegramLinkState {
  if (!row) {
    return {
      linked: false,
      subscribed: false,
      reachability: "unverified",
      reachableAt: null,
      unreachableSince: null,
      alertsDeliverable: false,
    };
  }

  const proofAt = lastProofAt(row);
  let reachability: ReachabilityStatus;
  if (row.unreachableSince !== null) {
    reachability = "unreachable";
  } else if (proofAt !== null && now - proofAt <= REACHABILITY_TTL_MS) {
    reachability = "reachable";
  } else {
    reachability = "unverified";
  }

  return {
    linked: true,
    subscribed: row.enabled,
    reachability,
    reachableAt: proofAt,
    unreachableSince: row.unreachableSince,
    alertsDeliverable: row.enabled && reachability !== "unreachable",
  };
}

/** The most recent moment delivery was PROVEN, by either route. */
export function lastProofAt(row: TelegramLinkRow): number | null {
  const probe = row.lastProbeOk === true ? row.lastProbeAt : null;
  if (row.lastDeliveredAt === null) return probe;
  if (probe === null) return row.lastDeliveredAt;
  return Math.max(row.lastDeliveredAt, probe);
}

/** Is this link due for a reachability probe? */
export function probeDue(row: TelegramLinkRow, now: number, intervalMs = PROBE_INTERVAL_MS): boolean {
  // A link already known to be unreachable is not probed again: the 403 is
  // terminal until the user re-links, and re-probing a blocked bot every day is
  // a rate-limit bill for a fact already known.
  if (!row.enabled || row.unreachableSince !== null) return false;
  const proof = lastProofAt(row);
  const lastTouch = Math.max(proof ?? 0, row.lastProbeAt ?? 0);
  return now - lastTouch >= intervalMs;
}

/**
 * The alert for a user who has an at-risk position and cannot be reached.
 *
 * Gated on `atRisk` on purpose. Every unreachable link is a coverage gap in
 * principle, but paging on all of them is how a monitoring channel becomes
 * noise; paging on the ones where an alert is imminently needed is the subset
 * that can actually hurt someone today.
 */
export function unreachableAlert(
  wallet: string,
  state: TelegramLinkState,
  now: number,
): import("./monitorAlerts").MonitorAlert | null {
  if (!state.linked) return null;
  if (state.alertsDeliverable && state.reachability !== "unverified") return null;

  const unverified = state.reachability === "unverified";
  return {
    kind: "telegram.unreachable",
    severity: unverified ? "warning" : "critical",
    key: `telegram.unreachable:${wallet.toLowerCase()}`,
    summary: unverified
      ? `${wallet} has an at-risk position and its Telegram link has not been proven deliverable` +
        `${state.reachableAt ? ` since ${new Date(state.reachableAt).toISOString()}` : " at any point"}`
      : `${wallet} has an at-risk position and the Telegram bot cannot reach them` +
        `${state.subscribed ? " (delivery returned 403)" : " (alerts are switched off)"}`,
    detail: {
      subscribed: state.subscribed,
      reachability: state.reachability,
      reachableAt: state.reachableAt === null ? null : new Date(state.reachableAt).toISOString(),
      unreachableSince:
        state.unreachableSince === null ? null : new Date(state.unreachableSince).toISOString(),
    },
    wallet,
    at: now,
  };
}
