import { describe, expect, it } from "vitest";
import type { ActiveScore } from "../src/adapters/active";
import type { ActiveReading } from "../src/adapters/activeAave";
import { fallbackSections, overallHeadline } from "../src/advisor/fallback";
import { findOpportunities } from "../src/advisor/opportunities";
import {
  collateralFundedRepayToTargetHf,
  REDUCE_TO_EXIT_RATIO,
  REPAY_FRACTION_SCALE,
  repayAmountFromFraction,
  repayFractionNumerator,
  repayFractionOfDebt,
  repayToTargetHf,
  TARGET_HF,
} from "../src/advisor/repayMath";
import { drawdownToLiquidation } from "../src/prospective";
import { adviseLeg, adviseWallet, safestAlternativeProtocol } from "../src/advisor/rules";
import type { AdvisorRecommendation, WalletInsights } from "../src/advisor/types";
import { MARKETS } from "../src/markets";
import { AdvisorNarrator } from "../src/providers/advisorNarrator";
import type { Band, Protocol } from "../src/types";

const WALLET = "0x1111111111111111111111111111111111111111";

function leg(overrides: Partial<ActiveScore> = {}): ActiveScore {
  return {
    total: 20,
    band: "LOW" as Band,
    subScores: { positionHealth: 20, assetRisk: 30, protocolSafety: 10, systemicRisk: 10 },
    protocol: "aave_v3" as Protocol,
    wallet: WALLET,
    healthFactor: 1.8,
    collateralValueUsd: 20_000,
    borrowValueUsd: 8_000,
    usdValuesUnavailable: false,
    marketContextUnavailable: false,
    dominantCollateralUnpriced: false,
    scoredCollateralSymbol: "WETH",
    dominantBorrowSymbol: "USDC",
    assetRiskIsProxy: false,
    ...overrides,
  };
}

describe("repayMath", () => {
  it("returns 0 at or above target", () => {
    expect(repayToTargetHf(10_000, 1.75, 1.75)).toBe(0);
    expect(repayToTargetHf(10_000, 2.1, 1.75)).toBe(0);
    expect(repayToTargetHf(0, 1.2, 1.75)).toBe(0);
  });

  it("round-trips: repaying R lifts HF exactly to target", () => {
    const d = 10_000;
    const hf = 1.31;
    const t = 1.75;
    const r = repayToTargetHf(d, hf, t);
    const l = hf * d; // liquidation-weighted collateral implied by HF
    expect(l / (d - r)).toBeCloseTo(t, 9);
  });

  it("is monotonic in the target", () => {
    const a = repayToTargetHf(10_000, 1.3, 1.5);
    const b = repayToTargetHf(10_000, 1.3, 1.75);
    const c = repayToTargetHf(10_000, 1.3, 2.0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("clamps to total debt for extreme targets", () => {
    expect(repayToTargetHf(10_000, 0.01, 2.0)).toBeLessThanOrEqual(10_000);
  });

  it("repayFractionOfDebt: repay/debt, quantised to the fixed-point scale", () => {
    expect(repayFractionOfDebt(2_500, 10_000)).toBe(0.25);
    // Not representable at 1/1e6: rounds half up, and stays exactly on grid.
    const third = repayFractionOfDebt(1, 3) as number;
    expect(third).toBe(0.333333);
    expect(third * REPAY_FRACTION_SCALE).toBe(333_333);
  });

  it("repayFractionOfDebt: clamps into (0, 1] and rejects the unusable", () => {
    // Never above 1: a repay cannot exceed the debt it repays.
    expect(repayFractionOfDebt(20_000, 10_000)).toBe(1);
    // Never 0: a repay too small to quantise is pinned to one unit of scale,
    // because a 0 fraction builds a no-op leg that looks like a success.
    expect(repayFractionOfDebt(0.0001, 10_000)).toBe(1 / REPAY_FRACTION_SCALE);
    // Null, not 0, for "there is nothing here to size".
    expect(repayFractionOfDebt(0, 10_000)).toBeNull();
    expect(repayFractionOfDebt(500, 0)).toBeNull();
    expect(repayFractionOfDebt(Number.NaN, 10_000)).toBeNull();
    expect(repayFractionOfDebt(500, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("repayFractionNumerator: recovers the EXACT integer over the scale", () => {
    for (const n of [1, 2, 333_333, 500_000, 999_999, 1_000_000]) {
      expect(repayFractionNumerator(n / REPAY_FRACTION_SCALE)).toBe(BigInt(n));
    }
    expect(repayFractionNumerator(0)).toBeNull();
    expect(repayFractionNumerator(Number.NaN)).toBeNull();
    // Above contract: clamped rather than allowed to over-repay.
    expect(repayFractionNumerator(1.5)).toBe(BigInt(REPAY_FRACTION_SCALE));
  });

  it("repayAmountFromFraction: BigInt-exact on an 18-decimal debt", () => {
    const debt = 12_345_678_901_234_567_890n; // ~12.35 WETH, above 2^53
    const amount = repayAmountFromFraction(debt, 0.25) as bigint;
    expect(amount).toBe((debt * 250_000n) / 1_000_000n);
    // Every unit survives: Number() on this debt loses the low digits entirely.
    expect(amount).toBe(3_086_419_725_308_641_972n);
    expect(repayAmountFromFraction(debt, 1)).toBe(debt);
  });

  it("repayAmountFromFraction: floors, so it never over-repays", () => {
    // 7 units at one third: 7 * 333333 / 1e6 = 2.333 -> 2, never 3.
    expect(repayAmountFromFraction(7n, 0.333333)).toBe(2n);
    // Rounding to nothing is null, not 0n: the caller must be able to tell
    // "repay nothing here" from "this leg is too small to reduce".
    expect(repayAmountFromFraction(1n, 0.4)).toBeNull();
    expect(repayAmountFromFraction(0n, 0.5)).toBeNull();
    expect(repayAmountFromFraction(1_000n, 0)).toBeNull();
  });

  it("drawdownToLiquidation: HF 2.0 -> 50% drop; null when no debt", () => {
    expect(drawdownToLiquidation(2.0)).toBeCloseTo(0.5, 9);
    expect(drawdownToLiquidation(null)).toBeNull();
    expect(drawdownToLiquidation(0.9)).toBe(0);
  });
});

/**
 * The Deleverager's sizing function, dormant until the flash-loan flow ships.
 * `weightedLiquidationThreshold` now reaches it from every active reader, so
 * the contract between them is pinned here before the first caller exists.
 * Per the function's own header: HF' = (L - LT_w×R)/(D - R), L = HF_now × D.
 */
describe("collateralFundedRepayToTargetHf", () => {
  /** Solves the same equation the function does, from its documented form. */
  const hfAfter = (d: number, hf: number, lt: number, r: number) =>
    (hf * d - lt * r) / (d - r);

  it.each([
    ["a shallow lift", 250_000, 1.45, 1.75, 0.83],
    ["a deep lift", 10_000, 1.02, 2.0, 0.75],
    ["a high-threshold market (Morpho 94.5% lltv)", 50_000, 1.1, 1.5, 0.945],
  ])("reaches the target on %s", (_label, d, hf, t, lt) => {
    const r = collateralFundedRepayToTargetHf(d, hf, t, lt);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(d);
    expect(hfAfter(d, hf, lt, r)).toBeCloseTo(t, 9);
  });

  it("costs more than a wallet-funded repay to the same target", () => {
    // Every dollar repaid out of collateral also leaves the numerator, so the
    // same target is strictly more expensive than repaying from the wallet.
    expect(collateralFundedRepayToTargetHf(10_000, 1.2, 1.75, 0.8)).toBeGreaterThan(
      repayToTargetHf(10_000, 1.2, 1.75),
    );
  });

  it.each([
    ["no debt", 0, 1.2, 1.75, 0.83],
    ["negative debt", -1, 1.2, 1.75, 0.83],
    ["no health factor", 10_000, 0, 1.75, 0.83],
    ["already at target", 10_000, 1.75, 1.75, 0.83],
    ["already above target", 10_000, 2.4, 1.75, 0.83],
    // At or below LT_w each dollar sold removes more collateral value than
    // debt, so HF falls as the repay grows: no size reaches the target, and
    // the honest answer is "no plan" rather than a number that makes it worse.
    ["target at the threshold", 10_000, 0.5, 0.8, 0.8],
    ["target below the threshold", 10_000, 0.5, 0.75, 0.8],
  ])("returns 0 for %s", (_label, d, hf, t, lt) => {
    expect(collateralFundedRepayToTargetHf(d, hf, t, lt)).toBe(0);
  });

  it("clamps at total debt when the position is already under the threshold", () => {
    // HF 0.70 against a 0.80 threshold: the unclamped solve wants $11,052 of a
    // $10,000 debt, and nobody can repay more than they owe.
    expect(collateralFundedRepayToTargetHf(10_000, 0.7, 1.75, 0.8)).toBe(10_000);
  });

  it("is not called when the reader could not establish a threshold", () => {
    // Null-propagation contract for the future call site: a reading with no
    // weightedLiquidationThreshold produces no plan, rather than a plan built
    // on a substituted number.
    const reading: Pick<ActiveReading, "weightedLiquidationThreshold"> = {
      weightedLiquidationThreshold: null,
    };
    const plan =
      reading.weightedLiquidationThreshold === null
        ? null
        : collateralFundedRepayToTargetHf(
            10_000,
            1.2,
            1.75,
            reading.weightedLiquidationThreshold,
          );
    expect(plan).toBeNull();

    // Why 0 is not an acceptable stand-in: at LT_w = 0 this collapses exactly
    // onto the wallet-funded formula, so an unknown threshold would be
    // answered with a confident and materially undersized repay.
    expect(collateralFundedRepayToTargetHf(10_000, 1.2, 1.75, 0)).toBeCloseTo(
      repayToTargetHf(10_000, 1.2, 1.75),
      9,
    );
    expect(collateralFundedRepayToTargetHf(10_000, 1.2, 1.75, 0.83)).toBeGreaterThan(
      collateralFundedRepayToTargetHf(10_000, 1.2, 1.75, 0),
    );
  });
});

describe("adviseLeg decision table", () => {
  it("rule 1: CRITICAL band -> full EXIT, critical, floor trigger", () => {
    const rec = adviseLeg(
      leg({ total: 80, band: "CRITICAL", healthFactor: 1.05 }),
      "moderate",
    );
    expect(rec.action).toBe("EXIT");
    expect(rec.urgency).toBe("critical");
    expect(rec.exitPrefill).toEqual({ protocol: "aave_v3", kind: "full" });
    expect(rec.triggers).toContain("floor:hf<=1.1");
  });

  it("rule 2: crash regime below CRITICAL band still exits", () => {
    const rec = adviseLeg(
      leg({
        total: 60,
        band: "HIGH",
        healthFactor: 1.2,
        subScores: { positionHealth: 50, assetRisk: 65, protocolSafety: 10, systemicRisk: 20 },
      }),
      "aggressive",
    );
    expect(rec.action).toBe("EXIT");
    expect(rec.triggers).toContain("regime:crash");
  });

  it("rule 3: HIGH band -> REDUCE with exact repay plan", () => {
    const rec = adviseLeg(
      leg({ total: 55, band: "HIGH", healthFactor: 1.31, borrowValueUsd: 10_000 }),
      "moderate",
    );
    expect(rec.action).toBe("REDUCE");
    expect(rec.urgency).toBe("warning");
    const expected = Math.round(10_000 * (1 - 1.31 / TARGET_HF.moderate));
    expect(rec.repayPlan?.repayUsd).toBe(expected);
    expect(rec.repayPlan?.targetHf).toBe(1.75);
    const fraction = repayFractionOfDebt(10_000 * (1 - 1.31 / TARGET_HF.moderate), 10_000);
    expect(rec.exitPrefill).toEqual({
      protocol: "aave_v3",
      kind: "partial",
      repayUsd: expected,
      repayFraction: fraction,
    });
  });

  // The repay is executed in the debt asset's own units, so the symbol decides
  // which token the user is told to hold and which token gets approved. It was
  // hardcoded to "USDC", which was wrong for every wallet borrowing anything
  // else.
  it("rule 3: names the leg's ACTUAL borrow asset, not an assumed USDC", () => {
    const rec = adviseLeg(
      leg({
        total: 55,
        band: "HIGH",
        healthFactor: 1.31,
        borrowValueUsd: 10_000,
        dominantBorrowSymbol: "WETH",
      }),
      "moderate",
    );
    expect(rec.repayPlan?.repayAssetSymbol).toBe("WETH");
    expect(rec.sections.recommendation).toContain("WETH");
    expect(rec.sections.recommendation).not.toContain("USDC");
    // The fraction is the executable form: repay/debt, in (0, 1].
    expect(rec.repayPlan?.repayFraction).toBeGreaterThan(0);
    expect(rec.repayPlan?.repayFraction).toBeLessThanOrEqual(1);
    expect(rec.repayPlan?.repayFraction).toBeCloseTo(1 - 1.31 / TARGET_HF.moderate, 5);
  });

  it("rule 3: a USDC borrower is unchanged", () => {
    const rec = adviseLeg(
      leg({ total: 55, band: "HIGH", healthFactor: 1.31, borrowValueUsd: 10_000 }),
      "moderate",
    );
    expect(rec.repayPlan?.repayAssetSymbol).toBe("USDC");
    expect(rec.sections.recommendation).toContain("USDC");
  });

  // Naming the wrong token is worse than naming none: the sentence is where the
  // user learns what to hold before pressing Reduce.
  it("rule 3: an unnamed borrow asset drops the symbol instead of guessing", () => {
    const rec = adviseLeg(
      leg({
        total: 55,
        band: "HIGH",
        healthFactor: 1.31,
        borrowValueUsd: 10_000,
        dominantBorrowSymbol: null,
      }),
      "moderate",
    );
    expect(rec.repayPlan?.repayAssetSymbol).toBeNull();
    expect(rec.sections.recommendation).not.toContain("USDC");
    expect(rec.sections.recommendation).not.toContain("undefined");
    expect(rec.sections.recommendation).not.toContain("null");
    expect(rec.sections.execution).not.toContain("undefined");
    // The repay is still sized: the amount does not depend on the symbol.
    expect(rec.repayPlan?.repayFraction).toBeGreaterThan(0);
  });

  it("rule 3: outside-profile (conservative) triggers REDUCE below HIGH band", () => {
    const rec = adviseLeg(
      leg({ total: 30, band: "ELEVATED", healthFactor: 1.6 }),
      "conservative",
    );
    expect(rec.action).toBe("REDUCE");
    expect(rec.repayPlan?.targetHf).toBe(2.0);
  });

  it("rule 3 promotion: repaying > 90% of debt becomes a full EXIT", () => {
    const rec = adviseLeg(
      leg({ total: 60, band: "HIGH", healthFactor: 0.15, borrowValueUsd: 10_000 }),
      "moderate",
    );
    // repay ratio = 1 - 0.15/1.75 = 0.914 > REDUCE_TO_EXIT_RATIO
    expect(1 - 0.15 / TARGET_HF.moderate).toBeGreaterThan(REDUCE_TO_EXIT_RATIO);
    expect(rec.action).toBe("EXIT");
    expect(rec.triggers).toContain("promoted:reduce_to_exit");
    expect(rec.exitPrefill?.kind).toBe("full");
  });

  it("rule 4: approaching + unsafe protocol -> REBALANCE to safest alternative", () => {
    const rec = adviseLeg(
      leg({
        protocol: "moonwell",
        total: 45,
        band: "ELEVATED",
        healthFactor: 2.5,
        subScores: { positionHealth: 20, assetRisk: 30, protocolSafety: 62, systemicRisk: 20 },
      }),
      "moderate",
    );
    expect(rec.action).toBe("REBALANCE");
    expect(rec.rebalance?.toProtocol).toBe("aave_v3");
  });

  it("rule 4: approaching + TVL flight -> REBALANCE with tvl trigger", () => {
    const rec = adviseLeg(
      leg({ protocol: "morpho", total: 42, band: "ELEVATED", healthFactor: 2.5 }),
      "moderate",
      { protocolTvl7dPct: -0.1 },
    );
    expect(rec.action).toBe("REBALANCE");
    expect(rec.triggers.some((t) => t.startsWith("protocol:tvl"))).toBe(true);
  });

  it("rule 5: approaching without stress -> MONITOR", () => {
    const rec = adviseLeg(
      leg({ total: 42, band: "ELEVATED", healthFactor: 2.5 }),
      "moderate",
    );
    expect(rec.action).toBe("MONITOR");
    expect(rec.urgency).toBe("info");
  });

  it("rule 6: within profile -> HOLD", () => {
    const rec = adviseLeg(leg(), "moderate");
    expect(rec.action).toBe("HOLD");
  });

  it("zero-debt legs never escalate past MONITOR", () => {
    const withinRec = adviseLeg(
      leg({ healthFactor: null, borrowValueUsd: 0, total: 20, band: "LOW" }),
      "moderate",
    );
    expect(withinRec.action).toBe("HOLD");
    const outsideRec = adviseLeg(
      leg({ healthFactor: null, borrowValueUsd: 0, total: 80, band: "CRITICAL" }),
      "moderate",
    );
    expect(outsideRec.action).toBe("MONITOR");
    expect(outsideRec.triggers).toContain("debt:none");
  });

  it("every recommendation carries non-empty 4-section fallback text", () => {
    const rec = adviseLeg(
      leg({ total: 55, band: "HIGH", healthFactor: 1.31 }),
      "moderate",
    );
    for (const section of Object.values(rec.sections)) {
      expect(section.length).toBeGreaterThan(10);
    }
    expect(rec.sections.recommendation).toContain("Repay");
  });
});

describe("adviseWallet", () => {
  it("overall = worst leg, with headline", () => {
    const { overall, recommendations } = adviseWallet(
      [
        leg(),
        leg({ protocol: "moonwell", total: 80, band: "CRITICAL", healthFactor: 1.02 }),
      ],
      "moderate",
    );
    expect(recommendations).toHaveLength(2);
    expect(overall.action).toBe("EXIT");
    expect(overall.urgency).toBe("critical");
    expect(overall.headline).toContain("Moonwell");
  });

  it("empty wallet -> HOLD overall", () => {
    const { overall } = adviseWallet([], "moderate");
    expect(overall.action).toBe("HOLD");
    expect(overallHeadline("HOLD", [])).toContain("within");
  });
});

describe("safestAlternativeProtocol", () => {
  it("moonwell WETH -> aave_v3 (lowest protocol-safety risk)", () => {
    expect(safestAlternativeProtocol("moonwell", "WETH")).toBe("aave_v3");
  });
  it("aave_v3 WETH -> compound_v3 (next safest with WETH listed)", () => {
    expect(safestAlternativeProtocol("aave_v3", "WETH")).toBe("compound_v3");
  });
  it("unknown symbol -> null", () => {
    expect(safestAlternativeProtocol("aave_v3", "SHIB")).toBeNull();
  });
});

describe("findOpportunities", () => {
  const calmScorer = async () => ({
    total: 15,
    band: "LOW" as Band,
    subScores: { positionHealth: 10, assetRisk: 20, protocolSafety: 10, systemicRisk: 10 },
    healthFactor: 1.75,
    liquidationDrawdown: 0.43,
  });

  it("sizes borrow to the profile target HF and returns top 3 within profile", async () => {
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: calmScorer,
    });
    expect(out.length).toBe(3);
    for (const rec of out) {
      expect(rec.action).toBe("OPEN");
      const plan = rec.openPlan!;
      const lt = MARKETS[plan.protocol][plan.collateralSymbol]!.liquidationThreshold;
      expect(plan.borrowUsd).toBeCloseTo((plan.collateralUsd * lt) / TARGET_HF.moderate, 1);
      expect(rec.sections.recommendation).toContain("Deposit");
    }
  });

  it("filters scenarios outside the profile", async () => {
    const riskyScorer = async () => ({
      total: 60,
      band: "HIGH" as Band,
      subScores: { positionHealth: 60, assetRisk: 60, protocolSafety: 30, systemicRisk: 30 },
      healthFactor: 1.3,
      liquidationDrawdown: 0.2,
    });
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: riskyScorer,
    });
    expect(out).toHaveLength(0);
  });

  it("suppresses protocols and assets the advisor says to EXIT", async () => {
    const exitRec = adviseLeg(
      leg({ protocol: "aave_v3", total: 80, band: "CRITICAL", healthFactor: 1.05, scoredCollateralSymbol: "WETH" }),
      "moderate",
    );
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: calmScorer,
      currentRecommendations: [exitRec],
      limit: 20,
    });
    expect(out.every((r) => r.protocol !== "aave_v3")).toBe(true);
    expect(out.every((r) => r.openPlan!.collateralSymbol !== "WETH")).toBe(true);
  });

  it("familiarity boost ranks known protocols first when yields tie", async () => {
    const insights: WalletInsights = {
      profile: "moderate",
      archetype: "test",
      protocols: ["moonwell"],
      topProtocol: "moonwell",
      topCollateralSymbol: null,
      liquidations: 0,
      lendingAgeDays: 300,
      borrowToDepositRatio: 0.4,
      stableBorrowPct: 0.9,
      daysSinceLastActivity: 2,
      confidence: 0.8,
    };
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: calmScorer,
      insights,
    });
    expect(out[0]!.protocol).toBe("moonwell");
    expect(out[0]!.triggers).toContain("history:familiar_protocol");
  });

  it("ranks by APY when yields are provided", async () => {
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: calmScorer,
      yields: { compound_v3: { WETH: 0.09 } },
    });
    expect(out[0]!.protocol).toBe("compound_v3");
    expect(out[0]!.openPlan!.apy).toBe(0.09);
  });

  it("a throwing scorer drops that market, not the scan", async () => {
    let calls = 0;
    const flaky = async (s: { protocol: Protocol }) => {
      calls += 1;
      if (s.protocol === "morpho") throw new Error("provider down");
      return calmScorer();
    };
    const out = await findOpportunities({
      wallet: WALLET,
      profile: "moderate",
      scoreScenario: flaky,
      limit: 20,
    });
    expect(calls).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.protocol !== "morpho")).toBe(true);
  });
});

describe("AdvisorNarrator", () => {
  const rec: AdvisorRecommendation = adviseLeg(
    leg({ total: 55, band: "HIGH", healthFactor: 1.31 }),
    "moderate",
  );
  const sections = {
    position: "Position text.",
    market: "Market text.",
    recommendation: "Repay text.",
    execution: "Button text.",
  };
  const okResponse = (content: unknown) =>
    ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    }) as Response;

  it("returns LLM sections on the happy path", async () => {
    const narrator = new AdvisorNarrator("key", { fetchFn: async () => okResponse(sections) });
    expect(await narrator.narrate(rec, "moderate")).toEqual(sections);
  });

  it("falls back to deterministic sections on malformed JSON", async () => {
    const narrator = new AdvisorNarrator("key", {
      fetchFn: async () => okResponse({ position: "only one key" }),
    });
    expect(await narrator.narrate(rec, "moderate")).toEqual(rec.sections);
  });

  it("falls back on HTTP failure", async () => {
    const narrator = new AdvisorNarrator("key", {
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    });
    expect(await narrator.narrate(rec, "moderate")).toEqual(rec.sections);
  });

  it("sends the recommendation as ground truth in the user message", async () => {
    let sentBody = "";
    const narrator = new AdvisorNarrator("key", {
      fetchFn: async (_url, init) => {
        sentBody = String(init?.body);
        return okResponse(sections);
      },
    });
    await narrator.narrate(rec, "moderate");
    const payload = JSON.parse(sentBody);
    const user = JSON.parse(payload.messages[1].content);
    expect(user.action).toBe("REDUCE");
    expect(user.repayPlan.repayUsd).toBe(rec.repayPlan!.repayUsd);
    expect(payload.response_format.type).toBe("json_object");
  });
});

describe("fallbackSections", () => {
  it("REDUCE execution names the pre-filled amount", () => {
    const rec = adviseLeg(leg({ total: 55, band: "HIGH", healthFactor: 1.31 }), "moderate");
    const s = fallbackSections(rec);
    expect(s.execution).toContain("Reduce");
    expect(s.execution).toContain("USDC");
  });
});
