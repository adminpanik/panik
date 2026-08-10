/**
 * The anti-spam gate (Phase 4.B).
 *
 * A monitoring system that spams gets muted, and a muted monitor is a coverage
 * failure with extra steps — so the gate is as load-bearing as the detectors it
 * sits in front of. What is asserted here is the pair of properties that make
 * it trustworthy: it SUPPRESSES a standing condition, and it never suppresses
 * NEW information (an escalation, or a genuinely different condition).
 *
 * The last test is the important one: a ledger outage must not silence a page.
 */

import { describe, expect, it } from "vitest";
import {
  ALERT_REPEAT_MS,
  AlertDispatcher,
  MemoryAlertLedger,
  ONCE,
  formatAlertLine,
  isEscalation,
  repeatWindowFor,
  type AlertLedger,
  type AlertSink,
  type MonitorAlert,
} from "./monitorAlerts";

const T0 = 1_800_000_000_000;

function alert(over: Partial<MonitorAlert> = {}): MonitorAlert {
  return {
    kind: "coverage.gap",
    severity: "warning",
    key: "coverage.gap:0xabc:aave_v3:repay_allowance_missing",
    summary: "allowance is zero",
    at: T0,
    ...over,
  };
}

function collector(): { sink: AlertSink; seen: MonitorAlert[] } {
  const seen: MonitorAlert[] = [];
  return {
    seen,
    sink: async (a) => {
      seen.push(a);
    },
  };
}

describe("repeatWindowFor", () => {
  it("uses the severity window for ordinary kinds", () => {
    expect(repeatWindowFor(alert({ severity: "critical" }))).toBe(ALERT_REPEAT_MS.critical);
    expect(repeatWindowFor(alert({ severity: "warning" }))).toBe(ALERT_REPEAT_MS.warning);
    expect(repeatWindowFor(alert({ severity: "info" }))).toBe(ALERT_REPEAT_MS.info);
  });

  it("makes expiry escalation once-per-key", () => {
    // The threshold is IN the key, so once-per-key IS once-per-threshold.
    expect(repeatWindowFor(alert({ kind: "coverage.expiring" }))).toBe(ONCE);
  });
});

describe("isEscalation", () => {
  it("is true only when severity strictly increases", () => {
    expect(isEscalation("warning", "critical")).toBe(true);
    expect(isEscalation("info", "warning")).toBe(true);
    expect(isEscalation("critical", "warning")).toBe(false);
    expect(isEscalation("warning", "warning")).toBe(false);
    // No prior send is not an escalation; it is a first send.
    expect(isEscalation(null, "critical")).toBe(false);
  });
});

describe("MemoryAlertLedger", () => {
  it("suppresses the same key inside its window and releases it after", async () => {
    const ledger = new MemoryAlertLedger();
    const a = alert();
    expect(await ledger.claim(a, ALERT_REPEAT_MS.warning, T0)).toBe(true);
    expect(await ledger.claim(a, ALERT_REPEAT_MS.warning, T0 + 60_000)).toBe(false);
    expect(await ledger.claim(a, ALERT_REPEAT_MS.warning, T0 + ALERT_REPEAT_MS.warning)).toBe(true);
  });

  it("lets an escalation through inside the window", async () => {
    const ledger = new MemoryAlertLedger();
    expect(await ledger.claim(alert({ severity: "warning" }), ALERT_REPEAT_MS.warning, T0)).toBe(true);
    // Same condition, now urgent: "this got worse" is new information.
    expect(
      await ledger.claim(alert({ severity: "critical" }), ALERT_REPEAT_MS.critical, T0 + 1_000),
    ).toBe(true);
    // ...but it does not open the gate for every later repeat.
    expect(
      await ledger.claim(alert({ severity: "critical" }), ALERT_REPEAT_MS.critical, T0 + 2_000),
    ).toBe(false);
  });

  it("never resends a once-only key", async () => {
    const ledger = new MemoryAlertLedger();
    const a = alert({ kind: "coverage.expiring", key: "coverage.expiring:row-1:7d" });
    expect(await ledger.claim(a, ONCE, T0)).toBe(true);
    expect(await ledger.claim(a, ONCE, T0 + 365 * 86_400_000)).toBe(false);
  });

  it("treats different keys as different conditions", async () => {
    const ledger = new MemoryAlertLedger();
    expect(await ledger.claim(alert({ key: "a" }), ALERT_REPEAT_MS.warning, T0)).toBe(true);
    expect(await ledger.claim(alert({ key: "b" }), ALERT_REPEAT_MS.warning, T0)).toBe(true);
  });
});

describe("AlertDispatcher", () => {
  it("delivers a first alert to every sink and suppresses the repeat", async () => {
    const one = collector();
    const two = collector();
    const dispatcher = new AlertDispatcher(new MemoryAlertLedger(), [one.sink, two.sink], () => T0);

    expect(await dispatcher.dispatch([alert()])).toHaveLength(1);
    expect(await dispatcher.dispatch([alert()])).toHaveLength(0);
    expect(one.seen).toHaveLength(1);
    expect(two.seen).toHaveLength(1);
  });

  it("keeps going when a sink throws", async () => {
    const good = collector();
    const bad: AlertSink = async () => {
      throw new Error("webhook down");
    };
    const dispatcher = new AlertDispatcher(new MemoryAlertLedger(), [bad, good.sink], () => T0);
    await dispatcher.dispatch([alert()]);
    expect(good.seen).toHaveLength(1);
  });

  it("FAILS OPEN when the ledger is unreachable", async () => {
    // A duplicate alert is an annoyance. A swallowed one is the bug this whole
    // file exists to prevent, so a broken gate must never mean silence.
    const broken: AlertLedger = {
      claim: async () => {
        throw new Error("postgrest unreachable");
      },
    };
    const sink = collector();
    const dispatcher = new AlertDispatcher(broken, [sink.sink], () => T0);
    expect(await dispatcher.dispatch([alert(), alert()])).toHaveLength(2);
    expect(sink.seen).toHaveLength(2);
  });
});

describe("formatAlertLine", () => {
  it("renders severity, kind, wallet and detail", () => {
    const line = formatAlertLine(
      alert({ severity: "critical", wallet: "0xabc", detail: { protocol: "aave_v3", atRisk: true } }),
    );
    expect(line).toContain("CRITICAL");
    expect(line).toContain("coverage.gap");
    expect(line).toContain("0xabc");
    expect(line).toContain("protocol=aave_v3");
  });

  it("renders an unknown detail as unknown, never as a zero", () => {
    expect(formatAlertLine(alert({ detail: { overdueMs: null } }))).toContain("overdueMs=unknown");
  });
});
