import { describe, expect, it } from "vitest";
import {
  formatAlert,
  formatResolution,
  formatSubScores,
  formatWelcome,
  truncateWallet,
  whyNow,
  type WhyNowFacts,
  type WhyNowInput,
} from "../src/watch/alertMessage";
import { ALERT_THRESHOLD, warnFrom } from "../src/profile";
import type { WatchTransition } from "../src/watch/loop";

const base: WatchTransition = {
  wallet: "0x76f88702325c92c83efad341a932fb326957056f",
  protocol: "moonwell",
  profile: "moderate",
  score: 58,
  band: "HIGH",
  from: "approaching",
  to: "outside",
  simulation: null,
};

// Em dash (U+2014) and en dash (U+2013) are banned by house style. Built from
// char codes so this test file itself contains no literal long dash.
const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/**
 * A DIGIT, a decimal point, and three or more digits: the shape of an engine
 * float that escaped into a chat. A real alert once read "Asset volatility
 * 38.41310180298047", which is the whole reason this regex exists.
 *
 * The leading `\d` is load-bearing - without it the ellipsis in a truncated
 * address ("0x76f8...056f") reads as a five-decimal number.
 */
const LONG_DECIMAL = /\d\.\d{3,}/;

const facts: WhyNowFacts = {
  healthFactor: 1.08,
  scoredCollateralSymbol: "cbBTC",
  subScores: { positionHealth: 88, assetRisk: 52, protocolSafety: 30, systemicRisk: 22 },
  protocol: "moonwell",
  profile: "moderate",
};

/** The unrounded sub-scores the engine actually produces. */
const rawFacts: WhyNowFacts = {
  ...facts,
  subScores: {
    positionHealth: 6.8848496510374195,
    assetRisk: 38.41310180298047,
    protocolSafety: 9.75,
    systemicRisk: 1.4403550393903641,
  },
};

const why: WhyNowInput = { triggers: ["band:HIGH", "profile:outside", "floor:hf<=1.1"], facts };

describe("formatAlert", () => {
  it("contains no em dash or en dash (house style)", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, collateralUsd: 5000, borrowUsd: 2600 });
    expect(LONG_DASH.test(msg)).toBe(false);
  });

  // The welcome was de-emojied first; the alert and the all-clear follow it.
  it("reads as plain professional text with no emoji", () => {
    const msgs = [
      formatAlert(base, { healthFactor: 1.08, collateralUsd: 5000, borrowUsd: 2600, why }),
      formatAlert({ ...base, to: "approaching" }, { healthFactor: 1.3, why }),
      formatAlert(base, { simulation: { label: "Crash" }, healthFactor: 1.08, why }),
      formatResolution({ ...base, to: "within" }, { healthFactor: 1.9, why }),
      formatResolution({ ...base, to: "within" }, { simulation: { label: "Crash" } }),
    ];
    for (const m of msgs) expect(EMOJI.test(m)).toBe(false);
  });

  it("leads with WHICH position, by the reader's own name for it", () => {
    const named = formatAlert(base, { label: "Simulation target", healthFactor: 1.08 });
    expect(named.split("\n")[0]).toBe(
      "Simulation target (0x76f8...056f) on Moonwell is over your moderate limit.",
    );
    // No label: the address alone still identifies it. Never an empty paren.
    const unnamed = formatAlert(base, { healthFactor: 1.08 });
    expect(unnamed.split("\n")[0]).toBe("0x76f8...056f on Moonwell is over your moderate limit.");
    expect(unnamed).not.toContain("()");
  });

  it("treats a whitespace-only label as no label and collapses newlines in one", () => {
    expect(formatAlert(base, { label: "   " }).split("\n")[0]).toBe(
      "0x76f8...056f on Moonwell is over your moderate limit.",
    );
    // A label is user-written text going into the first line of the message;
    // its newlines must not become the message's structure.
    const messy = formatAlert(base, { label: "Cold\nwallet\t 2" });
    expect(messy.split("\n")[0]).toBe(
      "Cold wallet 2 (0x76f8...056f) on Moonwell is over your moderate limit.",
    );
  });

  it("cuts an over-long label rather than letting it push the address away", () => {
    const msg = formatAlert(base, { label: "x".repeat(200) });
    const headline = msg.split("\n")[0]!;
    expect(headline).toContain("... (0x76f8...056f)");
    expect(headline.indexOf("(0x76f8")).toBeLessThan(70);
  });

  it("explains the warn boundary instead of contradicting itself", () => {
    // The bug this replaces: "Risk score 15 / 100 (LOW), your conservative
    // limit is 25" - a low score, under the limit, with an alert attached.
    const msg = formatAlert(
      { ...base, profile: "conservative", score: 15, band: "LOW", from: "within", to: "approaching" },
      {},
    );
    expect(msg).toContain(
      `Risk score 15 of 100. Your conservative limit is ${ALERT_THRESHOLD.conservative}, and alerts warn from ${warnFrom("conservative")}.`,
    );
    // The number is the engine's, not a literal typed twice.
    expect(warnFrom("conservative")).toBe(15);
  });

  it("states no warn boundary once the limit itself is crossed", () => {
    const msg = formatAlert(base, {});
    expect(msg).toContain("Risk score 58 of 100. Your moderate limit is 50.");
    expect(msg).not.toContain("warn from");
  });

  it("flags 'close to liquidation' below HF 1.15 and omits the HF line when null", () => {
    const low = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 });
    expect(low).toContain("close to liquidation");

    const safeHf = formatAlert(base, { healthFactor: 1.4, borrowUsd: 2600 });
    expect(safeHf).toContain("Health factor 1.40.");
    expect(safeHf).not.toContain("close to liquidation");

    const noHf = formatAlert(base, { healthFactor: null, borrowUsd: 0 });
    expect(noHf).not.toContain("Health factor");
  });

  it("uses the approaching copy for an approaching transition", () => {
    const msg = formatAlert(
      { ...base, to: "approaching", score: 44, band: "ELEVATED" },
      { healthFactor: 1.3, borrowUsd: 800 },
    );
    expect(msg).toContain("nearing your moderate limit");
    expect(msg).toContain("Add collateral or repay debt to widen the buffer.");
  });

  // DESIGN_SYSTEM: the LIMIT_STATE wording is chosen so an enum token never
  // appears as a substring, which makes this check a mechanical grep.
  it("leaks no ProfileStatus enum token into the copy", () => {
    const msgs = [
      formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600, why }),
      formatAlert({ ...base, to: "approaching" }, { healthFactor: 1.3, borrowUsd: 800, why }),
      formatResolution({ ...base, from: "outside", to: "within" }, { healthFactor: 1.9, borrowUsd: 800, why }),
    ];
    for (const m of msgs) {
      expect(m).not.toMatch(/within|approaching|outside/);
    }
  });
});

/**
 * THE FLOOR. A message with no facts in it was actually delivered: a lone
 * "your position has crossed your risk threshold, act now" with nothing saying
 * which position, how bad, or against what. Every fact below comes from the
 * TRANSITION row, whose columns are never null, so no state of the snapshot
 * join can take them away.
 */
describe("the fact floor", () => {
  const bare = { wallet: true, protocol: true, score: true };

  it("names the wallet, the protocol and the score with no extras at all", () => {
    for (const msg of [formatAlert(base), formatResolution({ ...base, to: "within" })]) {
      expect(msg).toContain("0x76f8...056f");
      expect(msg).toContain("Moonwell");
      expect(msg).toContain("Risk score 58 of 100");
      expect(msg.split("\n").filter((l) => l.trim().length > 0).length).toBeGreaterThanOrEqual(3);
    }
    expect(Object.keys(bare)).toHaveLength(3);
  });

  it("keeps the floor when every optional fact is explicitly unknown", () => {
    const msg = formatAlert(base, {
      label: null,
      healthFactor: null,
      collateralUsd: null,
      borrowUsd: null,
      simulation: null,
      why: undefined,
    });
    expect(msg).toContain("0x76f8...056f on Moonwell is over your moderate limit.");
    expect(msg).toContain("Risk score 58 of 100. Your moderate limit is 50.");
    // Unknown is still never a zero.
    expect(msg).not.toContain("$0");
    expect(msg).not.toContain("Health factor");
  });

  it("keeps the floor when the health factor is a non-finite number", () => {
    const msg = formatAlert(base, {
      healthFactor: Number.POSITIVE_INFINITY,
      collateralUsd: Number.NaN,
      borrowUsd: Number.NaN,
    });
    expect(msg).toContain("Risk score 58 of 100");
    expect(msg).not.toContain("Infinity");
    expect(msg).not.toContain("NaN");
  });
});

describe("rounding", () => {
  /** Every message this file can build, from the engine's raw float output. */
  const everyMessage = (): string[] => {
    const rawWhy: WhyNowInput = { triggers: ["band:HIGH"], facts: rawFacts };
    const floorWhy: WhyNowInput = { triggers: ["floor:hf<=1.1"], facts: rawFacts };
    const crashWhy: WhyNowInput = {
      triggers: ["regime:crash"],
      facts: { ...rawFacts, healthFactor: 1.3333333333 },
    };
    const protocolWhy: WhyNowInput = { triggers: ["protocol:safety"], facts: rawFacts };
    const extras = {
      label: "Simulation target",
      healthFactor: 4.531234567891234,
      collateralUsd: 175_293.4412345,
      borrowUsd: 31_426.109876,
    };
    return [
      formatAlert({ ...base, score: 58.4444444 }, { ...extras, why: rawWhy }),
      formatAlert({ ...base, to: "approaching" }, { ...extras, why: floorWhy }),
      formatAlert(base, { ...extras, why: crashWhy }),
      formatAlert(base, { ...extras, why: protocolWhy }),
      formatAlert(base, { ...extras, why: rawWhy, simulation: { label: "Crash" } }),
      formatResolution({ ...base, to: "within" }, { ...extras, why: rawWhy }),
    ];
  };

  it("never renders a number with three or more decimal places", () => {
    for (const msg of everyMessage()) {
      expect(LONG_DECIMAL.test(msg)).toBe(false);
    }
  });

  it("rounds the score, the drivers, the health factor and the dollars", () => {
    const msg = formatAlert(
      { ...base, score: 58.4444444 },
      {
        healthFactor: 4.531234567891234,
        collateralUsd: 175_293.4412345,
        borrowUsd: 31_426.109876,
        why: { triggers: ["band:HIGH"], facts: rawFacts },
      },
    );
    expect(msg).toContain("Risk score 58 of 100");
    expect(msg).toContain("Health factor 4.53.");
    expect(msg).toContain("Position $175,293 collateral and $31,426 debt.");
    expect(msg).toContain(
      "Main driver: asset volatility (38 of 100). Position health 7, protocol risk 10, market stress 1.",
    );
  });
});

describe("formatWelcome", () => {
  const wallet = "0x76f88702325c92c83efad341a932fb326957056f";

  it("greets, shows the truncated wallet, and the /stop command", () => {
    const msg = formatWelcome(wallet);
    expect(msg).toContain("Welcome to PANIK alerts");
    expect(msg).toContain("0x76f8...056f");
    expect(msg).toContain("/stop");
  });

  it("contains no em dash or en dash (house style)", () => {
    expect(LONG_DASH.test(formatWelcome(wallet))).toBe(false);
  });

  it("reads as plain professional text with no emoji", () => {
    const msg = formatWelcome(wallet);
    expect(msg.startsWith("Welcome")).toBe(true);
    expect(EMOJI.test(msg)).toBe(false);
  });
});

// 7.1 - every alert says which input fired it, and with what value.
describe("whyNow", () => {
  it("picks the severity-dominant trigger, not the first one pushed", () => {
    // Both orderings resolve to the proximity floor: the table is the severity
    // order, so the advisor's own push order cannot change the answer.
    const forward = whyNow({ triggers: ["floor:hf<=1.1", "protocol:safety"], facts });
    const reversed = whyNow({ triggers: ["protocol:safety", "floor:hf<=1.1"], facts });
    expect(forward?.trigger).toBe("floor:hf<=1.1");
    expect(reversed).toEqual(forward);
  });

  it("crash regime outranks the proximity floor", () => {
    const w = whyNow({ triggers: ["floor:hf<=1.1", "regime:crash"], facts: { ...facts, subScores: { ...facts.subScores, assetRisk: 78 } } });
    expect(w?.trigger).toBe("regime:crash");
    expect(w?.text).toContain("78 of 100");
    expect(w?.text).toContain("cbBTC");
  });

  it("states the value that fired it, led by the price-drop buffer", () => {
    const w = whyNow(why);
    // 1 - 1/1.08 = 7.4%
    expect(w?.text).toBe(
      "Liquidation is a 7.4% cbBTC drop away, at a health factor of 1.08.",
    );
  });

  it("falls through to the next trigger when the dominant one has no value", () => {
    // Same crash regime, but asset risk was never measured. Rather than print a
    // missing number it drops to the proximity floor, which it can state.
    const w = whyNow({
      triggers: ["regime:crash", "floor:hf<=1.1"],
      facts: { ...facts, subScores: { ...facts.subScores, assetRisk: null } },
    });
    expect(w?.trigger).toBe("floor:hf<=1.1");
  });

  it("rounds the protocol-risk figure it quotes", () => {
    const w = whyNow({
      triggers: ["protocol:safety"],
      facts: { ...facts, subScores: { ...facts.subScores, protocolSafety: 9.75 } },
    });
    expect(w?.text).toContain("(10 of 100 on audits");
  });

  it("names the degraded price feed and claims no dollar value", () => {
    const w = whyNow({
      triggers: ["band:HIGH", "profile:outside", "prices:degraded", "target:hf=1.75"],
      facts: { ...facts, healthFactor: null },
    });
    expect(w?.trigger).toBe("prices:degraded");
    expect(w?.text).toContain("degraded");
    expect(w?.text).not.toMatch(/\$|0%/);
  });

  it("falls back to the largest weighted sub-score contribution", () => {
    const w = whyNow({ triggers: ["band:HIGH", "profile:outside"], facts });
    expect(w?.trigger).toBe("driver:positionHealth");
    expect(w?.text).toBe("Position health is the largest contributor to this score, at 88 of 100.");
  });

  it("returns nothing when there is nothing measured to report", () => {
    expect(
      whyNow({
        triggers: [],
        facts: {
          ...facts,
          subScores: { positionHealth: null, assetRisk: null, protocolSafety: null, systemicRisk: null } as unknown as WhyNowFacts["subScores"],
        },
      }),
    ).toBeNull();
  });

  it("never puts a raw trigger string in the copy", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600, why });
    expect(msg).toContain("Why now:");
    expect(msg).not.toContain("floor:hf<=");
    expect(msg).not.toContain("band:");
  });

  it("omits the explanation entirely when the dispatcher has no facts", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 });
    expect(msg).not.toContain("Why now");
    expect(msg).not.toContain("Main driver");
  });

  it("says the dominant driver ONCE, with the rest behind it", () => {
    // The old form printed the top driver in a "why now" sentence and again at
    // the head of a "risk drivers" list, at full float precision both times.
    const msg = formatAlert(base, { why: { triggers: ["band:HIGH"], facts } });
    expect(msg).toContain(
      "Main driver: position health (88 of 100). Asset volatility 52, protocol risk 30, market stress 22.",
    );
    expect(msg).not.toContain("Why now");
  });

  it("keeps the drivers as context behind a named trigger", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, why });
    expect(msg).toContain(
      "Why now: Liquidation is a 7.4% cbBTC drop away, at a health factor of 1.08. " +
        "Risk drivers: position health 88, asset volatility 52, protocol risk 30, market stress 22.",
    );
  });
});

describe("formatSubScores", () => {
  it("orders by share of the composite and omits unmeasured terms", () => {
    // Labels are `DRIVER_LABEL`'s, shared with the app's score surfaces.
    expect(formatSubScores(facts.subScores)).toBe(
      "position health 88, asset volatility 52, protocol risk 30, market stress 22",
    );
    // Unmeasured is not zero: the term is dropped, never printed as 0.
    const degraded = formatSubScores({ ...facts.subScores, assetRisk: null, systemicRisk: null });
    expect(degraded).toBe("position health 88, protocol risk 30");
    expect(degraded).not.toContain("asset volatility");
    expect(degraded).not.toContain("market stress");
  });
});

// 7.2 - the loop gets closed, with what changed.
describe("formatResolution", () => {
  const recovered: WatchTransition = { ...base, score: 31, band: "LOW", from: "outside", to: "within" };
  const safeFacts: WhyNowFacts = { ...facts, healthFactor: 1.9 };

  it("leads with the all-clear and states what changed", () => {
    const msg = formatResolution(recovered, {
      label: "Simulation target",
      healthFactor: 1.9,
      collateralUsd: 5000,
      borrowUsd: 1200,
      why: { ...why, facts: safeFacts },
    });
    expect(msg.split("\n")[0]).toBe(
      "Simulation target (0x76f8...056f) on Moonwell is back under your moderate limit.",
    );
    expect(msg).toContain("What changed: this position was over your limit, and is now back under it.");
    expect(msg).toContain("Risk score 31 of 100. Your moderate limit is 50.");
    expect(msg).toContain("Liquidates if cbBTC falls 47%.");
    expect(msg).toContain("Health factor 1.90.");
    expect(msg).toContain("Position $5,000 collateral and $1,200 debt.");
    expect(LONG_DASH.test(msg)).toBe(false);
  });

  it("does not re-explain why the alert fired", () => {
    const msg = formatResolution(recovered, { healthFactor: 1.9, why: { ...why, facts: safeFacts } });
    expect(msg).not.toContain("Why now");
  });

  it("omits the money line rather than printing a zero for an unknown", () => {
    const msg = formatResolution(recovered, { healthFactor: null, collateralUsd: null, borrowUsd: null });
    expect(msg).not.toContain("Position $");
    expect(msg).not.toContain("Health factor");
    expect(msg).not.toContain("$0");
  });

  it("omits the origin clause when the position was never seen before", () => {
    const msg = formatResolution({ ...recovered, from: null }, { healthFactor: 1.9 });
    expect(msg).toContain("What changed: this position is now under your limit.");
  });

  it("marks a simulated all-clear at both ends, like the alert", () => {
    // "Nothing to do" issued against a price that never moved misleads exactly
    // as much as the alert does, so the recovery carries the same bookends.
    const msg = formatResolution(recovered, {
      healthFactor: 1.9,
      simulation: { label: "Crash" },
    });
    const lines = msg.split("\n");
    expect(lines[0]).toContain("Simulated event (Crash)");
    expect(lines[lines.length - 1]).toContain("simulated");
    // Still an all-clear, and still never an alarm.
    expect(msg).toContain("back under your moderate limit");
    expect(msg).toContain("Nothing to do.");
  });
});

describe("the simulation marker", () => {
  it("is the first line of a simulated alert and the last", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, simulation: { label: "Black swan" } });
    const lines = msg.split("\n");
    expect(lines[0]).toBe(
      "Simulated event (Black swan) - prices in this alert are from an armed drill, not the market. " +
        "Real market prices have not moved and your position has not actually changed.",
    );
    expect(lines[lines.length - 1]).toBe(
      "Reminder: the prices above are simulated. Nothing has happened to the market.",
    );
  });

  it("reads the stamp off the transition when the caller passes none", () => {
    const stamped: WatchTransition = {
      ...base,
      simulation: {
        id: "sim-1",
        label: "Crash",
        scenario: "crash",
        collateralMultiplier: 0.6,
        borrowMultiplier: 1,
        healthFactorMultiplier: 0.6,
        expiresAt: 0,
      },
    };
    expect(formatAlert(stamped, { healthFactor: 0.97 })).toContain("Simulated event (Crash)");
  });

  it("never marks a real alert", () => {
    const msg = formatAlert(base, { healthFactor: 1.08 });
    expect(msg).not.toContain("Simulated");
    expect(msg).not.toContain("simulated");
  });
});

describe("truncateWallet", () => {
  it("shortens long addresses and leaves short strings alone", () => {
    expect(truncateWallet("0x76f88702325c92c83efad341a932fb326957056f")).toBe("0x76f8...056f");
    expect(truncateWallet("short")).toBe("short");
  });
});
