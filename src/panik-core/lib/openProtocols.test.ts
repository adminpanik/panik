import { describe, expect, it } from "vitest";
import {
  buildOpenSteps,
  collateralStepCount,
  faucetDeficit,
  isOpenSupported,
  openAvailabilityLine,
  openChainConfig,
  openControlState,
  openProgressKey,
  resumeIndex,
  AAVE_POOL,
  AAVE_POOL_SEPOLIA,
  SEPOLIA_OPEN_ASSETS,
  type OpenPlanInput,
} from "./openProtocols";

const USER = "0x1111111111111111111111111111111111111111" as const;
const COLLATERAL = 2_000_000_000_000_000_000n; // 2 WETH
const BORROW = 3_000_000_000n; // 3000 USDC

const MAINNET = openChainConfig("mainnet");
const SEPOLIA = openChainConfig("testnet");

const lower = (a: string) => a.toLowerCase();

function aavePlan(overrides: Partial<OpenPlanInput> = {}): OpenPlanInput {
  return {
    config: MAINNET,
    protocol: "aave_v3",
    collateralSymbol: "WETH",
    collateralAmount: COLLATERAL,
    borrowAmount: BORROW,
    user: USER,
    ...overrides,
  };
}

function sepoliaPlan(overrides: Partial<OpenPlanInput> = {}): OpenPlanInput {
  return {
    config: SEPOLIA,
    protocol: "aave_v3",
    collateralSymbol: "USDC",
    collateralAmount: 1_000_000n, // 1 test USDC (6 decimals)
    borrowAmount: 500_000n, // 0.5 test USDT (6 decimals)
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

describe("openChainConfig", () => {
  it("resolves Base mainnet from the existing constants", () => {
    expect(MAINNET.chainId).toBe(8453);
    expect(lower(MAINNET.aavePool)).toBe(lower(AAVE_POOL));
    expect(lower(MAINNET.aaveOracle)).toBe(lower("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156"));
    // Mainnet assets are real, so there is nothing to mint.
    expect(MAINNET.faucet).toBeNull();
    expect(MAINNET.borrowSymbol).toBe("USDC");
  });

  // Literal addresses on purpose: the Sepolia config derives from the scoring
  // table (SCORING_CHAINS.testnet), so these pin the DEPLOYMENT itself - a
  // drift in that table fails here instead of being inherited silently.
  it("resolves Base Sepolia to its own pool, oracle, faucet and reserves", () => {
    expect(SEPOLIA.chainId).toBe(84532);
    expect(lower(SEPOLIA.aavePool)).toBe(lower("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"));
    expect(lower(SEPOLIA.aaveOracle)).toBe(lower("0x943b0dE18d4abf4eF02A85912F8fc07684C141dF"));
    expect(lower(SEPOLIA.faucet!)).toBe(lower("0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc"));
    expect(SEPOLIA.borrowSymbol).toBe("USDT");

    expect(Object.keys(SEPOLIA.tokens).sort()).toEqual(["USDC", "USDT"]);
    expect(lower(SEPOLIA.tokens.USDC!.address)).toBe(
      lower("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
    );
    expect(SEPOLIA.tokens.USDC!.decimals).toBe(6);
    expect(lower(SEPOLIA.tokens.USDT!.address)).toBe(
      lower("0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a"),
    );
    expect(SEPOLIA.tokens.USDT!.decimals).toBe(6);
  });

  it("keeps the two chains' assets distinct by ADDRESS, not by symbol", () => {
    // Both chains have a "USDC" and they are different contracts. Anything
    // that matched on the symbol would have silently agreed here.
    expect(lower(SEPOLIA.tokens.USDC!.address)).not.toBe(lower(MAINNET.tokens.USDC!.address));
    expect(SEPOLIA.aavePool).not.toBe(MAINNET.aavePool);
  });

  it("does not offer WETH on Sepolia (the OP-stack predeploy is unmintable)", () => {
    expect(SEPOLIA.tokens.WETH).toBeUndefined();
    expect(isOpenSupported(SEPOLIA, "aave_v3", "WETH")).toBe(false);
  });
});

describe("isOpenSupported per chain", () => {
  it("carries all four protocols on mainnet", () => {
    expect(isOpenSupported(MAINNET, "aave_v3", "WETH")).toBe(true);
    expect(isOpenSupported(MAINNET, "moonwell", "USDC")).toBe(true);
    expect(isOpenSupported(MAINNET, "compound_v3", "cbBTC")).toBe(true);
    expect(isOpenSupported(MAINNET, "morpho", "wstETH")).toBe(true);
    expect(isOpenSupported(MAINNET, "aave_v3", "USDT")).toBe(false);
  });

  it("carries USDC on Aave V3 only on Sepolia", () => {
    expect(isOpenSupported(SEPOLIA, "aave_v3", "USDC")).toBe(true);
    // USDT is a reserve so the borrow leg can reach it, but it is not offered
    // as collateral.
    expect(isOpenSupported(SEPOLIA, "aave_v3", "USDT")).toBe(false);
    for (const protocol of ["moonwell", "compound_v3", "morpho"] as const) {
      expect(isOpenSupported(SEPOLIA, protocol, "USDC")).toBe(false);
    }
  });
});

describe("openControlState", () => {
  const handler = () => {};

  it("enables the control for a market this chain opens", () => {
    expect(openControlState(handler, "testnet", "aave_v3", "USDC")).toEqual({
      enabled: true,
      hint: undefined,
    });
    expect(openControlState(handler, "mainnet", "aave_v3", "WETH")).toEqual({
      enabled: true,
      hint: undefined,
    });
  });

  // The hint is pinned to the helper, not to copy fragments: which sentence
  // the policy picks is this block's fact; the wording is openAvailabilityLine's.
  it("disables a testnet market the flow does not carry, naming what it does", () => {
    const state = openControlState(handler, "testnet", "moonwell", "WETH");
    expect(state.enabled).toBe(false);
    expect(state.hint).toBe(openAvailabilityLine("testnet", "moonwell", "WETH"));
  });

  it("disables an unverified mainnet market with the address-verified reason", () => {
    const state = openControlState(handler, "mainnet", "aave_v3", "LINK");
    expect(state.enabled).toBe(false);
    expect(state.hint).toBe(openAvailabilityLine("mainnet", "aave_v3", "LINK"));
  });

  // The chain-support check comes FIRST: an unsupported market is unsupported
  // whether or not the surface wired the flow in, and the hover has to name the
  // reason the user can act on.
  it("falls back to the unwired-flow reason only on a supported market", () => {
    expect(openControlState(null, "testnet", "aave_v3", "USDC")).toEqual({
      enabled: false,
      hint: "In-app opening ships with the position flows",
    });
    expect(openControlState(null, "testnet", "moonwell", "WETH").hint).toBe(
      openAvailabilityLine("testnet", "moonwell", "WETH"),
    );
  });
});

describe("openAvailabilityLine", () => {
  it("names the chain and the markets from the tables that own them", () => {
    const line = openAvailabilityLine("testnet", "moonwell", "WETH");
    expect(line).toContain("Base Sepolia");
    expect(line).toContain("USDC on Aave V3");
    expect(line).toContain("Use the protocol's own app for WETH on Moonwell.");
  });

  // The repo's enum-leak grep, as a test: no rendered sentence may carry an
  // engine id, an internal mode string, or an em dash (both founder rules).
  it("leaks no raw enum value or em dash into the rendered sentence", () => {
    const lines = [
      openAvailabilityLine("testnet", "moonwell", "WETH"),
      openAvailabilityLine("testnet", "aave_v3", "WETH"),
      openAvailabilityLine("mainnet", "compound_v3", "LINK"),
    ];
    for (const line of lines) {
      for (const leak of ["aave_v3", "moonwell", "compound_v3", "morpho", "testnet", "mainnet"]) {
        expect(line).not.toContain(leak);
      }
      expect(line).not.toMatch(/[–—]/);
    }
  });
});

describe("buildOpenSteps on Base Sepolia", () => {
  const steps = buildOpenSteps(sepoliaPlan());

  it("targets the Sepolia pool on every leg, never the mainnet one", () => {
    expect(steps.map((s) => s.kind)).toEqual(["approve", "supply", "borrow"]);
    const supply = steps.find((s) => s.kind === "supply")!;
    const borrow = steps.find((s) => s.kind === "borrow")!;
    const approve = steps.find((s) => s.kind === "approve")!;
    expect(lower(supply.address)).toBe(lower(AAVE_POOL_SEPOLIA));
    expect(lower(borrow.address)).toBe(lower(AAVE_POOL_SEPOLIA));
    expect(lower(approve.spender!)).toBe(lower(AAVE_POOL_SEPOLIA));
    for (const s of steps) expect(lower(s.address)).not.toBe(lower(AAVE_POOL));
  });

  it("approves and supplies the Sepolia USDC contract", () => {
    const approve = steps.find((s) => s.kind === "approve")!;
    const supply = steps.find((s) => s.kind === "supply")!;
    expect(lower(approve.address)).toBe(lower(SEPOLIA_OPEN_ASSETS.USDC!.address));
    expect(lower(String(supply.args[0]))).toBe(lower(SEPOLIA_OPEN_ASSETS.USDC!.address));
    // The mainnet USDC contract must never appear on a Sepolia plan.
    expect(lower(approve.address)).not.toBe(lower(MAINNET.tokens.USDC!.address));
  });

  it("borrows the Sepolia USDT contract and labels it USDT", () => {
    const borrow = steps.find((s) => s.kind === "borrow")!;
    expect(borrow.label).toBe("Borrow USDT");
    expect(lower(String(borrow.args[0]))).toBe(lower(SEPOLIA_OPEN_ASSETS.USDT!.address));
    expect(borrow.args[1]).toBe(500_000n);
  });

  it("omits the borrow leg when nothing is borrowed", () => {
    const collateralOnly = buildOpenSteps(sepoliaPlan({ borrowAmount: 0n }));
    expect(collateralOnly.map((s) => s.kind)).toEqual(["approve", "supply"]);
  });

  it("refuses a protocol whose addresses are mainnet-only", () => {
    for (const protocol of ["moonwell", "compound_v3", "morpho"] as const) {
      expect(() => buildOpenSteps(sepoliaPlan({ protocol }))).toThrow(/not configured on chain/);
    }
  });

  it("refuses a collateral the chain does not carry", () => {
    expect(() => buildOpenSteps(sepoliaPlan({ collateralSymbol: "WETH" }))).toThrow(
      /unknown collateral/,
    );
  });
});

describe("faucetDeficit", () => {
  it("is zero when covered, the exact shortfall otherwise", () => {
    expect(faucetDeficit(10n, 10n)).toBe(0n);
    expect(faucetDeficit(9n, 10n)).toBe(1n);
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

  it("separates the same open on the two chains", () => {
    const base = { protocol: "aave_v3", collateralSymbol: "USDC", user: USER };
    expect(openProgressKey({ ...base, chainId: MAINNET.chainId })).not.toBe(
      openProgressKey({ ...base, chainId: SEPOLIA.chainId }),
    );
  });
});
