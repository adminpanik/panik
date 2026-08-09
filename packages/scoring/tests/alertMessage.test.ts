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

const facts: WhyNowFacts = {
  healthFactor: 1.08,
  scoredCollateralSymbol: "cbBTC",
  subScores: { positionHealth: 88, assetRisk: 52, protocolSafety: 30, systemicRisk: 22 },
  protocol: "moonwell",
  profile: "moderate",
};

const why: WhyNowInput = { triggers: ["band:HIGH", "profile:outside", "floor:hf<=1.1"], facts };

describe("formatAlert", () => {
  it("contains no em dash or en dash (house style)", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, collateralUsd: 5000, borrowUsd: 2600 });
    expect(LONG_DASH.test(msg)).toBe(false);
  });

  it("truncates the wallet and shows the profile limit + band", () => {
    const msg = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 });
    expect(msg).toContain("0x76f8...056f");
    expect(msg).toContain("moderate limit is 50"); // ALERT_THRESHOLD.moderate
    expect(msg).toContain("(HIGH)");
    expect(msg).toContain("Moonwell");
  });

  it("flags 'near liquidation' below HF 1.15 and omits the HF line when null", () => {
    const low = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 });
    expect(low).toContain("near liquidation");

    const safeHf = formatAlert(base, { healthFactor: 1.4, borrowUsd: 2600 });
    expect(safeHf).toContain("Health factor 1.40");
    expect(safeHf).not.toContain("near liquidation");

    const noHf = formatAlert(base, { healthFactor: null, borrowUsd: 0 });
    expect(noHf).not.toContain("Health factor");
  });

  it("uses the approaching copy for an approaching transition", () => {
    const msg = formatAlert({ ...base, to: "approaching", score: 44, band: "ELEVATED" }, { healthFactor: 1.3, borrowUsd: 800 });
    expect(msg).toContain("nearing your risk limit");
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

  it("leads with the severity emoji (push-preview signal)", () => {
    const outside = formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 });
    expect(outside.startsWith("🚨")).toBe(true);

    const approaching = formatAlert({ ...base, to: "approaching", score: 44, band: "ELEVATED" }, { healthFactor: 1.3, borrowUsd: 800 });
    expect(approaching.startsWith("⚠️")).toBe(true);
  });

  it("pictograms each fact line and flips the heart below the near-liquidation HF", () => {
    const low = formatAlert(base, { healthFactor: 1.08, collateralUsd: 5000, borrowUsd: 2600 });
    expect(low).toContain("👛 Wallet");
    expect(low).toContain("🏦 Protocol");
    expect(low).toContain("📊 Risk score");
    expect(low).toContain("💰 Position");
    expect(low).toContain("💔 Health factor 1.08");

    const safe = formatAlert(base, { healthFactor: 1.4, borrowUsd: 2600 });
    expect(safe).toContain("❤️ Health factor 1.40");
    expect(safe).not.toContain("💔");
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

  it("opens with the wave emoji and marks the mute command", () => {
    const msg = formatWelcome(wallet);
    expect(msg.startsWith("👋")).toBe(true);
    expect(msg).toContain("🔕 /stop");
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
    expect(w?.text).toContain("78 / 100");
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
    expect(w?.text).toBe("position health is the largest contributor to this score, at 88 / 100.");
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
    expect(msg).toContain("🔎 Why now:");
    expect(msg).not.toContain("floor:hf<=");
    expect(msg).not.toContain("band:");
  });

  it("omits the why-now line entirely when the dispatcher has no facts", () => {
    expect(formatAlert(base, { healthFactor: 1.08, borrowUsd: 2600 })).not.toContain("Why now");
  });
});

describe("formatSubScores", () => {
  it("orders by share of the composite and omits unmeasured terms", () => {
    expect(formatSubScores(facts.subScores)).toBe(
      "🧩 Risk drivers: position health 88, asset volatility 52, protocol risk 30, market stress 22",
    );
    // Unmeasured is not zero: the term is dropped, never printed as 0.
    const degraded = formatSubScores({ ...facts.subScores, assetRisk: null, systemicRisk: null });
    expect(degraded).toBe("🧩 Risk drivers: position health 88, protocol risk 30");
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
      healthFactor: 1.9,
      collateralUsd: 5000,
      borrowUsd: 1200,
      why: { ...why, facts: safeFacts },
    });
    expect(msg.startsWith("✅")).toBe(true);
    expect(msg).toContain("back under your risk limit");
    expect(msg).toContain("🔁 What changed: this position was over your risk limit");
    expect(msg).toContain("📊 Risk score 31 / 100 (LOW), your moderate limit is 50");
    expect(msg).toContain("🛟 Liquidates if cbBTC falls 47%");
    expect(msg).toContain("❤️ Health factor 1.90");
    expect(msg).toContain("💰 Position $5,000 collateral / $1,200 debt");
    expect(LONG_DASH.test(msg)).toBe(false);
  });

  it("does not re-explain why the alert fired", () => {
    const msg = formatResolution(recovered, { healthFactor: 1.9, why: { ...why, facts: safeFacts } });
    expect(msg).not.toContain("Why now");
  });

  it("omits the money line rather than printing a zero for an unknown", () => {
    const msg = formatResolution(recovered, { healthFactor: null, collateralUsd: null, borrowUsd: null });
    expect(msg).not.toContain("💰");
    expect(msg).not.toContain("Health factor");
    expect(msg).not.toContain("$0");
  });

  it("omits the origin clause when the position was never seen before", () => {
    const msg = formatResolution({ ...recovered, from: null }, { healthFactor: 1.9 });
    expect(msg).toContain("🔁 What changed: this position is now under your risk limit.");
  });
});

describe("truncateWallet", () => {
  it("shortens long addresses and leaves short strings alone", () => {
    expect(truncateWallet("0x76f88702325c92c83efad341a932fb326957056f")).toBe("0x76f8...056f");
    expect(truncateWallet("short")).toBe("short");
  });
});
