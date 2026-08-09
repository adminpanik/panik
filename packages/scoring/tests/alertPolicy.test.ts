import { describe, expect, it } from "vitest";
import { decideSend } from "../src/watch/alertPolicy";
import { ALERT_POLICY } from "../src/params";

const t0 = Date.parse("2026-06-27T00:00:00Z");

describe("decideSend", () => {
  it("suppresses positions with no debt (HF null)", () => {
    expect(
      decideSend({ toStatus: "outside", createdAt: t0, healthFactor: null, borrowUsd: 5000, prior: null }),
    ).toBe("suppressed_immaterial");
  });

  it("suppresses sub-dust borrow", () => {
    expect(
      decideSend({ toStatus: "outside", createdAt: t0, healthFactor: 1.05, borrowUsd: ALERT_POLICY.minBorrowUsd - 1, prior: null }),
    ).toBe("suppressed_immaterial");
  });

  // A degraded price feed leaves borrowUsd null for want of a PRICE, not for
  // want of DEBT. Failing the dust gate there is how a $120k position became
  // "immaterial" and never alerted.
  it("waives the dust gate when the USD value is unavailable", () => {
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0,
        healthFactor: 1.2,
        borrowUsd: null,
        usdValuesUnavailable: true,
        prior: null,
      }),
    ).toBe("send");
  });

  it("still suppresses a null borrow when prices are healthy", () => {
    expect(
      decideSend({ toStatus: "outside", createdAt: t0, healthFactor: 1.2, borrowUsd: null, prior: null }),
    ).toBe("suppressed_immaterial");
  });

  it("never alerts a degraded leg with no debt at all (HF null)", () => {
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0,
        healthFactor: null,
        borrowUsd: null,
        usdValuesUnavailable: true,
        prior: null,
      }),
    ).toBe("suppressed_immaterial");
  });

  it("sends the first material alert", () => {
    expect(
      decideSend({ toStatus: "approaching", createdAt: t0, healthFactor: 1.2, borrowUsd: 800, prior: null }),
    ).toBe("send");
  });

  it("suppresses a same-severity re-crossing inside the cooldown window", () => {
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0 + ALERT_POLICY.cooldownMs - 1,
        healthFactor: 1.05,
        borrowUsd: 800,
        prior: { toStatus: "outside", createdAt: t0 },
      }),
    ).toBe("suppressed_cooldown");
  });

  it("sends again once the cooldown has elapsed", () => {
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0 + ALERT_POLICY.cooldownMs,
        healthFactor: 1.05,
        borrowUsd: 800,
        prior: { toStatus: "outside", createdAt: t0 },
      }),
    ).toBe("send");
  });

  it("escalation approaching -> outside bypasses the cooldown", () => {
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0 + 60_000, // well within cooldown
        healthFactor: 1.05,
        borrowUsd: 800,
        prior: { toStatus: "approaching", createdAt: t0 },
      }),
    ).toBe("send");
  });
});

// 7.2 - a flagged position returning to safety notifies, rate-limited.
describe("decideSend - resolution notifications", () => {
  const recovery = (over: Partial<Parameters<typeof decideSend>[0]> = {}) =>
    decideSend({
      toStatus: "within",
      createdAt: t0 + 60_000,
      healthFactor: 1.9,
      borrowUsd: 800,
      prior: { toStatus: "outside", createdAt: t0 },
      ...over,
    });

  it("sends an all-clear after an alert was actually delivered", () => {
    expect(recovery()).toBe("send");
    expect(recovery({ prior: { toStatus: "approaching", createdAt: t0 } })).toBe("send");
  });

  it("stays silent when no alert was ever sent for this position", () => {
    expect(recovery({ prior: null })).toBe("skipped");
  });

  it("resolves a debt repaid to zero (HF null is the best recovery, not dust)", () => {
    // The materiality gate must NOT apply to a recovery: a fully repaid debt
    // reads as HF null / no borrow, which is exactly what we want to confirm.
    expect(recovery({ healthFactor: null, borrowUsd: null })).toBe("send");
  });

  it("rate-limits a flapping position to one all-clear per alert", () => {
    // outside -> within -> outside -> within, all inside the cooldown window.
    // 1. the alert
    expect(
      decideSend({ toStatus: "outside", createdAt: t0, healthFactor: 1.05, borrowUsd: 800, prior: null }),
    ).toBe("send");
    // 2. the all-clear (prior sent = that alert)
    expect(recovery()).toBe("send");
    // 3. back over the limit inside the cooldown: the prior ALERT is still the
    //    one at t0, same severity, so the existing cooldown holds it.
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: t0 + 120_000,
        healthFactor: 1.05,
        borrowUsd: 800,
        prior: { toStatus: "outside", createdAt: t0 },
      }),
    ).toBe("suppressed_cooldown");
    // 4. recovers again: the prior sent message is the all-clear at t0+60s, so
    //    the second all-clear is suppressed. Two messages total, not four.
    expect(
      recovery({ createdAt: t0 + 180_000, prior: { toStatus: "within", createdAt: t0 + 60_000 } }),
    ).toBe("suppressed_cooldown");
  });

  it("sends a fresh all-clear once a new alert has gone out", () => {
    // Cooldown elapsed, position re-alerted, then recovered again: that is a new
    // loop to close, not a flap.
    const reAlert = t0 + ALERT_POLICY.cooldownMs;
    expect(
      decideSend({
        toStatus: "outside",
        createdAt: reAlert,
        healthFactor: 1.05,
        borrowUsd: 800,
        prior: { toStatus: "outside", createdAt: t0 },
      }),
    ).toBe("send");
    expect(
      recovery({ createdAt: reAlert + 60_000, prior: { toStatus: "outside", createdAt: reAlert } }),
    ).toBe("send");
  });
});
