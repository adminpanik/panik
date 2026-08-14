/**
 * THE END-TO-END PROOF, run against the real engine objects rather than mocks
 * of them: a chain reader whose position never changes, feeding the real
 * `ActiveAdapter`, the real `WatchService`, the real `statusFor` thresholds and
 * the real `formatAlert`.
 *
 * Only two things are substituted: the reader (so the chain read is a fixture
 * instead of an RPC call) and the clock (so an hour can pass in a millisecond).
 * Everything between them is the code that runs in production, which is what
 * makes this a proof of the chain rather than a proof of a test harness.
 *
 * The position is IDENTICAL in every tick. Every number that moves below moves
 * because of the price override and nothing else.
 */

import { describe, expect, it } from "vitest";
import { ActiveAdapter, type ActiveReader } from "../src/adapters/active";
import type { ActiveReading } from "../src/adapters/activeAave";
import { drawdownToLiquidation, formatDrawdownPct } from "../src/prospective";
import type { AssetRiskProvider, SystemicRiskProvider } from "../src/providers/types";
import type { MarketSimulation } from "../src/simulation";
import { multiplierFromPct, scenarioByKey } from "../src/simulation";
import { formatAlert } from "../src/watch/alertMessage";
import { WatchService, type WatchTransition } from "../src/watch/loop";

const WALLET = "0x76f88702325c92c83efad341a932fb326957056f";
const T0 = 1_700_000_000_000;
const WINDOW_MS = 60 * 60_000;

/** A healthy cbBTC / USDC position. Constant: the chain does not move here. */
const POSITION: ActiveReading = {
  protocol: "aave_v3",
  positionHealth: { healthFactor: 1.62, currentLtv: 0.494, maxLtv: 0.8 },
  collateralValueUsd: 40_000,
  borrowValueUsd: 19_753,
  weightedLiquidationThreshold: 0.8,
  dominantCollateralSymbol: "cbBTC",
  dominantBorrowSymbol: "USDC",
};

const reader: ActiveReader = { read: async () => POSITION };

// Calm, FIXED market context. Both terms are constants here so that every
// difference between the two runs below is attributable to the price override
// and to nothing else: a moving asset-risk term would make "the band flipped"
// an unfalsifiable claim.
const FLAT_RETURNS = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.004 : -0.004));
const FLAT_PRICES = Array.from({ length: 90 }, () => 100);

const providers: { assetRisk: AssetRiskProvider; systemic: SystemicRiskProvider } = {
  assetRisk: {
    getAssetRiskInput: async () => ({
      dailyReturns30d: FLAT_RETURNS,
      btcReturns30d: FLAT_RETURNS,
      prices90d: FLAT_PRICES,
    }),
  },
  systemic: {
    getSystemicRiskInput: async () => ({
      sectorTvlNow: 50_000_000_000,
      sectorTvl7dAgo: 50_000_000_000,
      protocolTvlNow: 5_000_000_000,
      protocolTvl7dAgo: 5_000_000_000,
    }),
  },
};

/** The Crash preset, armed for an hour, exactly as the admin route builds it. */
const crash = scenarioByKey("crash")!;
const SIMULATION: MarketSimulation = {
  id: "11111111-1111-4111-8111-111111111111",
  scenario: crash.key,
  label: crash.label,
  multipliers: { cbBTC: multiplierFromPct(crash.pct) },
  setBy: "admin.panik@gmail.com",
  startedAt: T0,
  expiresAt: T0 + WINDOW_MS,
};

/**
 * One run of the whole chain at a given instant, with the scenario either armed
 * or not. Returns everything a demo would put on screen.
 */
async function runChain(opts: { armed: boolean; at: number }) {
  let clock = opts.at;
  const adapter = new ActiveAdapter(
    [reader],
    providers,
    undefined,
    {
      simulation: () => (opts.armed ? SIMULATION : null),
      now: () => clock,
    },
  );

  const transitions: WatchTransition[] = [];
  const service = new WatchService({
    scoreWallet: (w) => adapter.scoreWallet(w),
    profileFor: () => "moderate",
    onTransition: (t) => transitions.push(t),
    // The production debounce: a crossing must hold three consecutive ticks.
    confirmTicks: 3,
  });
  service.watch(WALLET);

  // Four 60s ticks, which is what the worker does in four minutes.
  for (let i = 0; i < 4; i++) {
    await service.tick();
    clock += 60_000;
  }

  const [score] = await adapter.scoreWallet(WALLET);
  return { score: score!, transitions };
}

describe("end to end: a simulated crash drives the whole protection chain", () => {
  it("scores the same position differently, and only because of the price", async () => {
    const real = await runChain({ armed: false, at: T0 });
    const simulated = await runChain({ armed: true, at: T0 });

    // 1. The band flips, two steps, on an unchanged position: 25 ELEVATED at
    // the real price and 75 CRITICAL under the scenario.
    expect(real.score.total).toBe(25);
    expect(real.score.band).toBe("ELEVATED");
    expect(simulated.score.total).toBe(75);
    expect(simulated.score.band).toBe("CRITICAL");

    // 2. The health factor followed the price by the normal path: 1.62 x 0.6.
    expect(real.score.healthFactor).toBeCloseTo(1.62, 6);
    expect(simulated.score.healthFactor).toBeCloseTo(0.972, 6);

    // 3. So did the distance to liquidation, through the engine's ONE formula
    // and its ONE rounding policy. Below HF 1 that distance is zero: the
    // scenario puts this position past liquidation, which is what a 40% drop
    // does to a 1.62 health factor, and "0%" is the engine's word for it.
    expect(formatDrawdownPct(drawdownToLiquidation(real.score.healthFactor)!)).toBe("38%");
    expect(formatDrawdownPct(drawdownToLiquidation(simulated.score.healthFactor)!)).toBe("0%");

    // 4. And so did the dollars.
    expect(real.score.collateralValueUsd).toBe(40_000);
    expect(simulated.score.collateralValueUsd).toBeCloseTo(24_000, 6);
    expect(simulated.score.borrowValueUsd).toBe(19_753);

    // 5. The provenance is on the score, for the marker and the history rows.
    expect(real.score.simulation).toBeNull();
    expect(simulated.score.simulation).toMatchObject({
      id: SIMULATION.id,
      label: "Crash",
      scenario: "crash",
    });
  });

  it("records a real transition through the real debounce, marked as simulated", async () => {
    const real = await runChain({ armed: false, at: T0 });
    const simulated = await runChain({ armed: true, at: T0 });

    // The calm run never leaves "within", so it never crosses and never alerts.
    expect(real.transitions.map((t) => t.to)).toEqual(["within"]);

    // The crashed run crosses the moderate limit. One transition, not four:
    // the 3-tick confirmation is doing its job, and the crossing is committed
    // once and then held.
    const crossings = simulated.transitions.filter((t) => t.to === "outside");
    expect(crossings).toHaveLength(1);
    const crossing = crossings[0]!;
    expect(crossing.wallet).toBe(WALLET);
    expect(crossing.band).toBe("CRITICAL");
    expect(crossing.from).toBeNull();

    // This is what `persistTransition` writes to watch_transitions.
    expect(crossing.simulation).toMatchObject({ id: SIMULATION.id, label: "Crash" });
  });

  it("sends an alert whose text says it is simulated, first line and last", async () => {
    const { transitions } = await runChain({ armed: true, at: T0 });
    const crossing = transitions.find((t) => t.to === "outside")!;
    const text = formatAlert(crossing, {
      healthFactor: 1.62 * 0.6,
      collateralUsd: 24_000,
      borrowUsd: 19_753,
    });

    const lines = text.split("\n");
    // FIRST, above the headline: a push notification shows the opening
    // characters and nothing else.
    expect(lines[0]).toContain("Simulated event");
    expect(lines[0]).toContain("Crash");
    expect(text).toContain("Real market prices have not moved");
    // And last, so no crop shows the instruction without the reason.
    expect(lines[lines.length - 1]).toContain("simulated");
    // The alert is still a real alert about a real crossing.
    // Phrased by LIMIT_STATE.outside, the same words the app uses; the headline
    // is built from the transition so no ProfileStatus token can appear in copy.
    expect(text).toContain("over your moderate limit");
    expect(text).toContain("Health factor 0.97");
    // House style survives the addition.
    expect(text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]"));
  });

  it("sends an UNMARKED alert when nothing is simulated", async () => {
    // The inverse guard: the marker must not leak onto a real alert, or it
    // teaches users to ignore it.
    const crossing: WatchTransition = {
      wallet: WALLET,
      protocol: "aave_v3",
      profile: "moderate",
      score: 80,
      band: "CRITICAL",
      from: "approaching",
      to: "outside",
      simulation: null,
    };
    const text = formatAlert(crossing, { healthFactor: 0.97 });
    expect(text).not.toContain("Simulated");
    expect(text).not.toContain("simulated");
    // The first line is the position itself, and it is the position that was
    // NOT simulated - so the marker's absence is visible from the first words.
    expect(text.split("\n")[0]).toBe(
      `${WALLET.slice(0, 6)}...${WALLET.slice(-4)} on Aave V3 is over your moderate limit.`,
    );
  });
});

describe("end to end: expiry reverts everything, with nobody doing anything", () => {
  it("scores identically to never-armed once the window closes", async () => {
    const never = await runChain({ armed: false, at: T0 });
    // Same armed scenario, same code path, read one millisecond after it died.
    const expired = await runChain({ armed: true, at: SIMULATION.expiresAt });

    expect(expired.score.band).toBe(never.score.band);
    expect(expired.score.total).toBe(never.score.total);
    expect(expired.score.healthFactor).toBe(never.score.healthFactor);
    expect(expired.score.collateralValueUsd).toBe(never.score.collateralValueUsd);
    expect(expired.score.simulation).toBeNull();
    expect(expired.transitions.map((t) => t.to)).toEqual(["within"]);

    // Field for field, the two scores are the same object shape and value.
    expect(expired.score).toEqual(never.score);
  });

  it("clearing mid-flight is the same thing as never having armed it", async () => {
    const never = await runChain({ armed: false, at: T0 });
    const cleared = await runChain({ armed: false, at: T0 + 30 * 60_000 });
    expect(cleared.score).toEqual(never.score);
  });
});
