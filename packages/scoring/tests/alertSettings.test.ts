/**
 * Per-user tuning (7.4) and digest mode (7.5).
 *
 * The tests that matter here are the ones that must FAIL if somebody ever makes
 * a preference able to withhold a critical alert. Everything else in this file
 * is input validation, which is the other place this feature can silently
 * mis-set someone's alerts.
 */

import { describe, expect, it } from "vitest";
import { decideSend } from "../src/watch/alertPolicy";
import {
  DEFAULT_ALERT_SETTINGS,
  digestDueAtMs,
  effectiveCooldownMs,
  inQuietHours,
  isCriticalAlert,
  isMuted,
  parseAlertSettings,
  positionKey,
  type AlertSettings,
} from "../src/watch/alertSettings";
import { ALERT_POLICY } from "../src/params";

const WHALE = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const t0 = Date.parse("2026-08-23T12:00:00Z");
/** 03:00 UTC, inside a 22:00 -> 07:00 quiet window. */
const night = Date.parse("2026-08-23T03:00:00Z");

const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  ...DEFAULT_ALERT_SETTINGS,
  ...over,
});

const QUIET_NIGHT = settings({ quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 });

/** A material alert with debt well over the dust floor. */
const alert = (over: Partial<Parameters<typeof decideSend>[0]> = {}) =>
  decideSend({
    toStatus: "approaching",
    createdAt: t0,
    healthFactor: 1.3,
    borrowUsd: 180_000,
    prior: null,
    wallet: WHALE,
    protocol: "aave_v3",
    ...over,
  });

describe("quiet hours", () => {
  it("holds a non-critical alert raised inside the window", () => {
    expect(alert({ settings: QUIET_NIGHT, nowMs: night })).toBe("deferred_quiet");
  });

  // THE SAFETY PROPERTY. A position over the user's own limit is a liquidation
  // warning; 3am is exactly when it matters most.
  it("CRITICAL alerts break through quiet hours", () => {
    expect(alert({ toStatus: "outside", settings: QUIET_NIGHT, nowMs: night })).toBe("send");
  });

  it("CRITICAL band breaks through even when the user is only approaching their limit", () => {
    expect(alert({ band: "CRITICAL", settings: QUIET_NIGHT, nowMs: night })).toBe("send");
  });

  it("sends normally once the window has passed", () => {
    expect(alert({ settings: QUIET_NIGHT, nowMs: t0 })).toBe("send");
  });

  it("wraps past midnight and ignores a half-set window", () => {
    expect(inQuietHours(night, QUIET_NIGHT)).toBe(true);
    expect(inQuietHours(t0, QUIET_NIGHT)).toBe(false);
    expect(inQuietHours(night, settings({ quietStartMinute: 60, quietEndMinute: null }))).toBe(false);
  });
});

describe("digest batching", () => {
  const DIGEST = settings({ digest: "daily" });

  it("holds a non-critical alert for the next digest", () => {
    expect(alert({ settings: DIGEST })).toBe("deferred_digest");
  });

  // THE SAFETY PROPERTY. Batching must be structurally incapable of delaying a
  // critical alert - not "configured not to".
  it("CRITICAL alerts are never batched", () => {
    expect(alert({ toStatus: "outside", settings: DIGEST })).toBe("send");
    expect(alert({ band: "CRITICAL", settings: DIGEST })).toBe("send");
  });

  it("a digest is due one interval after the last one, or after the oldest held alert", () => {
    expect(digestDueAtMs(DIGEST, t0, t0 + 5_000)).toBe(t0 + 24 * 60 * 60 * 1000);
    expect(digestDueAtMs(DIGEST, null, t0)).toBe(t0 + 24 * 60 * 60 * 1000);
    expect(digestDueAtMs(settings(), null, t0)).toBeNull();
  });
});

describe("mute", () => {
  const MUTED_PROTOCOL = settings({ mutedProtocols: ["aave_v3"] });
  const MUTED_POSITION = settings({ mutedPositions: [positionKey(WHALE, "aave_v3")] });

  it("suppresses a non-critical alert for a muted protocol", () => {
    expect(alert({ settings: MUTED_PROTOCOL })).toBe("suppressed_muted");
  });

  it("suppresses a non-critical alert for a muted position", () => {
    expect(alert({ settings: MUTED_POSITION })).toBe("suppressed_muted");
  });

  it("leaves other positions on a muted-position setting alone", () => {
    expect(isMuted(MUTED_POSITION, WHALE, "morpho")).toBe(false);
    expect(alert({ settings: MUTED_POSITION, protocol: "morpho" })).toBe("send");
  });

  it("CRITICAL alerts break through a mute", () => {
    expect(alert({ toStatus: "outside", settings: MUTED_PROTOCOL })).toBe("send");
    expect(alert({ toStatus: "outside", settings: MUTED_POSITION })).toBe("send");
  });
});

describe("materiality and cooldown tuning", () => {
  it("honours a raised materiality threshold", () => {
    expect(alert({ borrowUsd: 900, settings: settings({ minBorrowUsd: 5_000 }) })).toBe(
      "suppressed_immaterial",
    );
  });

  it("honours a lowered one", () => {
    expect(alert({ borrowUsd: 10, settings: settings({ minBorrowUsd: 5 }) })).toBe("send");
  });

  it("lets a user shorten their cooldown", () => {
    const short = settings({ cooldownMs: 60_000 });
    expect(
      alert({
        toStatus: "approaching",
        createdAt: t0 + 60_000,
        settings: short,
        prior: { toStatus: "approaching", createdAt: t0 },
      }),
    ).toBe("send");
  });

  // A preference may not make somebody LESS safe than the shipped default.
  it("clamps a lengthened cooldown back to the engine default for a critical alert", () => {
    const long = settings({ cooldownMs: 7 * 24 * 60 * 60 * 1000 });
    expect(effectiveCooldownMs(long, true)).toBe(ALERT_POLICY.cooldownMs);
    expect(effectiveCooldownMs(long, false)).toBe(long.cooldownMs);
    expect(
      alert({
        toStatus: "outside",
        createdAt: t0 + ALERT_POLICY.cooldownMs,
        settings: long,
        prior: { toStatus: "outside", createdAt: t0 },
      }),
    ).toBe("send");
  });

  it("still suppresses a non-critical re-crossing inside the user's own window", () => {
    const long = settings({ cooldownMs: 12 * 60 * 60 * 1000 });
    expect(
      alert({
        createdAt: t0 + 7 * 60 * 60 * 1000,
        settings: long,
        prior: { toStatus: "approaching", createdAt: t0 },
      }),
    ).toBe("suppressed_cooldown");
  });
});

describe("resolutions follow the same preferences", () => {
  const priorAlert = { toStatus: "outside" as const, createdAt: t0 - 60_000 };

  it("batches an all-clear into the digest", () => {
    expect(
      decideSend({
        toStatus: "within",
        createdAt: t0,
        healthFactor: null,
        borrowUsd: null,
        prior: priorAlert,
        settings: settings({ digest: "daily" }),
      }),
    ).toBe("deferred_digest");
  });

  it("holds an all-clear through quiet hours", () => {
    expect(
      decideSend({
        toStatus: "within",
        createdAt: night,
        healthFactor: null,
        borrowUsd: null,
        prior: priorAlert,
        settings: QUIET_NIGHT,
        nowMs: night,
      }),
    ).toBe("deferred_quiet");
  });
});

describe("isCriticalAlert", () => {
  it("counts being over the user's own limit, and the engine's own top band", () => {
    expect(isCriticalAlert("outside", "HIGH")).toBe(true);
    expect(isCriticalAlert("approaching", "CRITICAL")).toBe(true);
    expect(isCriticalAlert("approaching", "HIGH")).toBe(false);
    expect(isCriticalAlert("within", null)).toBe(false);
  });
});

describe("parseAlertSettings", () => {
  it("defaults an empty body to the shipped policy", () => {
    expect(parseAlertSettings({})).toEqual({ settings: DEFAULT_ALERT_SETTINGS });
  });

  it("accepts a full body", () => {
    const parsed = parseAlertSettings({
      minBorrowUsd: 2500,
      cooldownMinutes: 120,
      quietStartMinute: 1320,
      quietEndMinute: 420,
      mutedProtocols: ["morpho", "morpho"],
      mutedPositions: [`${WHALE.toUpperCase()}:aave_v3`],
      digest: "hourly",
    });
    expect(parsed).toEqual({
      settings: {
        minBorrowUsd: 2500,
        cooldownMs: 120 * 60_000,
        quietStartMinute: 1320,
        quietEndMinute: 420,
        mutedProtocols: ["morpho"],
        mutedPositions: [`${WHALE}:aave_v3`],
        digest: "hourly",
      },
    });
  });

  it("rejects rather than repairs", () => {
    for (const body of [
      { cooldownMinutes: -1 },
      { cooldownMinutes: 1.5 },
      { cooldownMinutes: 99_999 },
      { minBorrowUsd: -5 },
      { minBorrowUsd: "50" },
      { quietStartMinute: 1440, quietEndMinute: 0 },
      { quietStartMinute: 60 },
      { mutedProtocols: ["aave_v4"] },
      { mutedPositions: ["not-a-wallet:aave_v3"] },
      { mutedPositions: [`${WHALE}:sushi`] },
      { digest: "weekly" },
    ]) {
      expect(parseAlertSettings(body)).toHaveProperty("error");
    }
  });
});
