import { describe, expect, it } from "vitest";
import { formatAlert, formatWelcome, truncateWallet } from "../src/watch/alertMessage";
import type { WatchTransition } from "../src/watch/loop";

const base: WatchTransition = {
  wallet: "0x76f88702325c92c83efad341a932fb326957056f",
  protocol: "moonwell",
  profile: "moderate",
  score: 58,
  band: "HIGH",
  from: "approaching",
  to: "outside",
};

// Em dash (U+2014) and en dash (U+2013) are banned by house style. Built from
// char codes so this test file itself contains no literal long dash.
const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");

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
    expect(msg).toContain("approaching your risk limit");
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

describe("truncateWallet", () => {
  it("shortens long addresses and leaves short strings alone", () => {
    expect(truncateWallet("0x76f88702325c92c83efad341a932fb326957056f")).toBe("0x76f8...056f");
    expect(truncateWallet("short")).toBe("short");
  });
});
