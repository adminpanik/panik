/**
 * Telegram three-state reachability (Phase 4.B).
 *
 * The bug being fixed: `enabled` was reported as `linked`, and `enabled` is set
 * once at /start and only cleared AFTER a send fails with a 403. So a user who
 * blocked the bot read as fully alerted right up until the first alert — and
 * the first alert IS the emergency. The UI showed a green card to somebody the
 * bot could never reach.
 *
 * The headline test is the last one in the second block: an unreachable user
 * must never be reported as covered.
 */

import { describe, expect, it } from "vitest";
import {
  PROBE_INTERVAL_MS,
  REACHABILITY_TTL_MS,
  lastProofAt,
  linkState,
  probeDue,
  unreachableAlert,
  type TelegramLinkRow,
} from "./telegramReach";

const NOW = 1_800_000_000_000;
const WALLET = "0x00000000000000000000000000000000000000a1";

function row(over: Partial<TelegramLinkRow> = {}): TelegramLinkRow {
  return {
    chatId: 4242,
    enabled: true,
    lastDeliveredAt: null,
    lastProbeAt: null,
    lastProbeOk: null,
    unreachableSince: null,
    ...over,
  };
}

describe("lastProofAt", () => {
  it("takes the most recent SUCCESSFUL evidence from either route", () => {
    expect(lastProofAt(row({ lastDeliveredAt: NOW - 1_000, lastProbeAt: NOW, lastProbeOk: true }))).toBe(NOW);
    expect(lastProofAt(row({ lastDeliveredAt: NOW, lastProbeAt: NOW - 1_000, lastProbeOk: true }))).toBe(NOW);
  });

  it("ignores a FAILED probe: a failure is not evidence of success", () => {
    expect(lastProofAt(row({ lastProbeAt: NOW, lastProbeOk: false }))).toBeNull();
    expect(lastProofAt(row({ lastDeliveredAt: NOW - 5, lastProbeAt: NOW, lastProbeOk: false }))).toBe(NOW - 5);
  });

  it("is null when nothing has ever been proven", () => {
    expect(lastProofAt(row())).toBeNull();
  });
});

describe("linkState — three distinct facts", () => {
  it("reports nothing linked when there is no row", () => {
    const s = linkState(null, NOW);
    expect(s).toMatchObject({ linked: false, subscribed: false, reachability: "unverified" });
    expect(s.alertsDeliverable).toBe(false);
  });

  it("separates linked from subscribed after /stop", () => {
    const s = linkState(row({ enabled: false, lastDeliveredAt: NOW }), NOW);
    expect(s.linked).toBe(true);
    expect(s.subscribed).toBe(false);
    // Delivery was proven; the user simply turned alerts off.
    expect(s.reachability).toBe("reachable");
    expect(s.alertsDeliverable).toBe(false);
  });

  it("reports a fresh link as UNVERIFIED, not as reachable and not as broken", () => {
    // Pressing Start proves the user can reach the bot, not the reverse.
    // Inventing either verdict here is the dishonesty this module exists for.
    const s = linkState(row(), NOW);
    expect(s).toMatchObject({ linked: true, subscribed: true, reachability: "unverified" });
    expect(s.reachableAt).toBeNull();
    // Still deliverable: there is no EVIDENCE of failure, so refusing to try
    // would be its own invented fact.
    expect(s.alertsDeliverable).toBe(true);
  });

  it("counts a recent delivery as proof and lets it go stale", () => {
    expect(linkState(row({ lastDeliveredAt: NOW - 1_000 }), NOW).reachability).toBe("reachable");
    expect(
      linkState(row({ lastDeliveredAt: NOW - REACHABILITY_TTL_MS - 1 }), NOW).reachability,
    ).toBe("unverified");
  });

  it("counts a successful probe as proof", () => {
    const s = linkState(row({ lastProbeAt: NOW - 1_000, lastProbeOk: true }), NOW);
    expect(s.reachability).toBe("reachable");
    expect(s.reachableAt).toBe(NOW - 1_000);
  });

  it("REPORTS A BLOCKED BOT AS UNREACHABLE AND NOT DELIVERABLE", () => {
    // The whole point: a 403 outranks even a delivery from five minutes ago.
    const s = linkState(row({ lastDeliveredAt: NOW - 300_000, unreachableSince: NOW - 1_000 }), NOW);
    expect(s.linked).toBe(true);
    expect(s.reachability).toBe("unreachable");
    expect(s.alertsDeliverable).toBe(false);
  });
});

describe("probeDue", () => {
  it("probes a link whose proof has gone stale", () => {
    expect(probeDue(row({ lastDeliveredAt: NOW - PROBE_INTERVAL_MS - 1 }), NOW)).toBe(true);
    expect(probeDue(row({ lastDeliveredAt: NOW - 1_000 }), NOW)).toBe(false);
  });

  it("probes a link that has never been proven", () => {
    expect(probeDue(row(), NOW)).toBe(true);
  });

  it("does not re-probe a bot already known to be blocked", () => {
    // The 403 is terminal until the user re-links; probing daily would be a
    // rate-limit bill for a fact already known.
    expect(probeDue(row({ unreachableSince: NOW - 10 * PROBE_INTERVAL_MS }), NOW)).toBe(false);
  });

  it("does not probe an unsubscribed link", () => {
    expect(probeDue(row({ enabled: false }), NOW)).toBe(false);
  });

  it("backs off after a FAILED probe instead of retrying every pass", () => {
    expect(probeDue(row({ lastProbeAt: NOW - 1_000, lastProbeOk: false }), NOW)).toBe(false);
  });
});

describe("unreachableAlert", () => {
  it("says nothing about a wallet that never linked", () => {
    expect(unreachableAlert(WALLET, linkState(null, NOW), NOW)).toBeNull();
  });

  it("says nothing about a link that is proven reachable", () => {
    const state = linkState(row({ lastDeliveredAt: NOW - 1_000 }), NOW);
    expect(unreachableAlert(WALLET, state, NOW)).toBeNull();
  });

  it("pages CRITICAL when the bot is blocked", () => {
    const state = linkState(row({ unreachableSince: NOW - 1_000 }), NOW);
    const alert = unreachableAlert(WALLET, state, NOW)!;
    expect(alert.kind).toBe("telegram.unreachable");
    expect(alert.severity).toBe("critical");
    expect(alert.wallet).toBe(WALLET);
    expect(alert.detail?.reachability).toBe("unreachable");
  });

  it("warns, rather than pages, when reachability is merely unverified", () => {
    const alert = unreachableAlert(WALLET, linkState(row(), NOW), NOW)!;
    expect(alert.severity).toBe("warning");
    expect(alert.summary).toContain("not been proven deliverable");
  });

  it("pages when the user has switched alerts off but has an at-risk position", () => {
    const state = linkState(row({ enabled: false, lastDeliveredAt: NOW - 1_000 }), NOW);
    const alert = unreachableAlert(WALLET, state, NOW)!;
    expect(alert.summary).toContain("alerts are switched off");
  });

  it("keys on the wallet, so one condition is one page", () => {
    const state = linkState(row({ unreachableSince: NOW }), NOW);
    expect(unreachableAlert(WALLET, state, NOW)!.key).toBe(`telegram.unreachable:${WALLET}`);
  });
});
