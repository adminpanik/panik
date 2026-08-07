import { describe, expect, it } from "vitest";
import {
  buildOpenSteps,
  collateralStepCount,
  openProgressKey,
  resumeIndex,
  type OpenPlanInput,
} from "./openProtocols";

const USER = "0x1111111111111111111111111111111111111111" as const;
const COLLATERAL = 2_000_000_000_000_000_000n; // 2 WETH
const BORROW = 3_000_000_000n; // 3000 USDC

function aavePlan(overrides: Partial<OpenPlanInput> = {}): OpenPlanInput {
  return {
    protocol: "aave_v3",
    collateralSymbol: "WETH",
    collateralAmount: COLLATERAL,
    borrowAmount: BORROW,
    user: USER,
    ...overrides,
  };
}

describe("buildOpenSteps step kinds", () => {
  it("orders collateral legs before the borrow leg on every protocol", () => {
    const protocols: OpenPlanInput["protocol"][] = ["aave_v3", "moonwell", "compound_v3"];
    for (const protocol of protocols) {
      const steps = buildOpenSteps(aavePlan({ protocol }));
      expect(steps[0]!.kind).toBe("approve");
      expect(steps[1]!.kind).toBe("supply");
      expect(steps[steps.length - 1]!.kind).toBe("borrow");
      expect(collateralStepCount(steps)).toBe(steps.length - 1);
    }
  });

  it("omits the borrow leg when nothing is borrowed", () => {
    const steps = buildOpenSteps(aavePlan({ borrowAmount: 0n }));
    expect(steps.map((s) => s.kind)).toEqual(["approve", "supply"]);
    expect(collateralStepCount(steps)).toBe(2);
  });
});

describe("resumeIndex - double-supply guard", () => {
  const steps = buildOpenSteps(aavePlan());

  it("NEVER replays a landed supply when the borrow is retried at a new size", () => {
    // approve + supply landed, borrow reverted (borrow cap / HF). The user
    // lowers the borrow and retries: the rebuilt step list is fresh, and the
    // exact-amount approval has been consumed by the supply (allowance 0).
    const retried = buildOpenSteps(aavePlan({ borrowAmount: BORROW / 3n }));
    expect(retried).not.toEqual(steps); // genuinely a re-built list

    const start = resumeIndex({
      steps: retried,
      completedSteps: 2,
      allowance: 0n,
      collateralAmount: COLLATERAL,
    });

    expect(start).toBe(2);
    expect(retried[start]!.kind).toBe("borrow");
    // The load-bearing assertion: no collateral leg is scheduled to re-run.
    expect(retried.slice(start).some((s) => s.kind === "supply")).toBe(false);
  });

  it("keeps the cursor past the supply regardless of on-chain allowance", () => {
    for (const allowance of [0n, 1n, COLLATERAL - 1n, COLLATERAL, COLLATERAL * 2n]) {
      expect(
        resumeIndex({ steps, completedSteps: 2, allowance, collateralAmount: COLLATERAL }),
      ).toBe(2);
    }
  });

  it("does not walk backwards when the whole sequence already landed", () => {
    expect(
      resumeIndex({ steps, completedSteps: 3, allowance: 0n, collateralAmount: COLLATERAL }),
    ).toBe(3);
  });

  it("clamps a corrupt or out-of-range cursor into the step list", () => {
    expect(
      resumeIndex({ steps, completedSteps: 99, allowance: 0n, collateralAmount: COLLATERAL }),
    ).toBe(steps.length);
    expect(
      resumeIndex({ steps, completedSteps: -5, allowance: 0n, collateralAmount: COLLATERAL }),
    ).toBe(0);
    expect(
      resumeIndex({ steps, completedSteps: NaN, allowance: 0n, collateralAmount: COLLATERAL }),
    ).toBe(0);
  });
});

describe("resumeIndex - approval freshness", () => {
  const steps = buildOpenSteps(aavePlan());

  it("re-approves when a landed approval no longer covers the supply", () => {
    // Approve landed, supply did NOT. Re-running approve is safe here and is
    // required: exact-amount approvals are not topped up.
    expect(
      resumeIndex({ steps, completedSteps: 1, allowance: COLLATERAL - 1n, collateralAmount: COLLATERAL }),
    ).toBe(0);
  });

  it("resumes at the supply when the landed approval still covers it", () => {
    expect(
      resumeIndex({ steps, completedSteps: 1, allowance: COLLATERAL, collateralAmount: COLLATERAL }),
    ).toBe(1);
  });

  it("skips an approval the chain already grants", () => {
    expect(
      resumeIndex({ steps, completedSteps: 0, allowance: COLLATERAL * 2n, collateralAmount: COLLATERAL }),
    ).toBe(1);
  });

  it("runs the approval from scratch when there is no allowance", () => {
    expect(
      resumeIndex({ steps, completedSteps: 0, allowance: 0n, collateralAmount: COLLATERAL }),
    ).toBe(0);
  });
});

describe("openProgressKey", () => {
  it("is stable across sizing edits and distinct per wallet/market", () => {
    const base = { protocol: "aave_v3", collateralSymbol: "WETH", user: USER, chainId: 8453 };
    expect(openProgressKey(base)).toBe(openProgressKey({ ...base }));
    expect(openProgressKey({ ...base, user: USER.toUpperCase() })).toBe(openProgressKey(base));
    expect(openProgressKey({ ...base, protocol: "morpho" })).not.toBe(openProgressKey(base));
    expect(openProgressKey({ ...base, collateralSymbol: "cbBTC" })).not.toBe(
      openProgressKey(base),
    );
    expect(openProgressKey({ ...base, chainId: 84532 })).not.toBe(openProgressKey(base));
  });
});
