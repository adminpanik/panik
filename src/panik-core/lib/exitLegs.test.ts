/**
 * Leg derivation for the Exit / Reduce flow.
 *
 * These are the amounts a user signs for, so every assertion here is exact
 * BigInt: a repay that is off by a decimal place is a repay in the wrong
 * currency. The case that motivated the module is the third one down - the
 * flow used to convert `repayUsd` with `10 ** usdcDecimals` and only fire for
 * USDC, so a WETH borrower got either nothing or a number 10^12 too small.
 */

import { describe, expect, it } from "vitest";
import {
  AMOUNT_FULL,
  buildExitLegs,
  formatTokenAmount,
  PROTOCOL_ID,
  REPAY_FRACTION_SCALE,
  swapAcquisitionNote,
  swapSlippageFloor,
  type ExitReserveState,
} from "./exitLegs";

const USDC = "0x0000000000000000000000000000000000000001" as const;
const WETH = "0x0000000000000000000000000000000000000002" as const;

const usdc = (over: Partial<ExitReserveState> = {}): ExitReserveState => ({
  reserve: USDC,
  symbol: "USDC",
  decimals: 6,
  aBalance: 0n,
  debt: 0n,
  ...over,
});
const weth = (over: Partial<ExitReserveState> = {}): ExitReserveState => ({
  reserve: WETH,
  symbol: "WETH",
  decimals: 18,
  aBalance: 0n,
  debt: 0n,
  ...over,
});

describe("buildExitLegs - full exit", () => {
  it("uses the AMOUNT_FULL sentinel on both sides, never a read amount", () => {
    const { legs, views } = buildExitLegs(
      [usdc({ debt: 5_000_000000n }), weth({ aBalance: 3n * 10n ** 18n })],
      { protocol: "aave_v3", kind: "full" },
    );

    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({
      protocol: PROTOCOL_ID.aave_v3,
      asset: USDC,
      repayAmount: AMOUNT_FULL,
      withdrawAmount: 0n,
      data: "0x",
    });
    expect(legs[1]?.withdrawAmount).toBe(AMOUNT_FULL);
    expect(legs[1]?.repayAmount).toBe(0n);
    // Interest accrues between the read and the signature, so the sentinel is
    // what closes the position; the read amount is only what must be funded.
    expect(views[0]?.repayFunding).toBe(5_000_000000n);
    expect(views[1]?.repayFunding).toBe(0n);
  });

  it("skips a reserve the wallet has neither side of", () => {
    const { legs, views } = buildExitLegs([usdc(), weth({ debt: 1n })], {
      protocol: "aave_v3",
      kind: "full",
    });
    expect(legs).toHaveLength(1);
    expect(views[0]?.symbol).toBe("WETH");
  });

  it("ignores repayFraction entirely", () => {
    const { legs } = buildExitLegs([weth({ debt: 4n * 10n ** 18n })], {
      protocol: "aave_v3",
      kind: "full",
      repayFraction: 0.25,
    });
    expect(legs[0]?.repayAmount).toBe(AMOUNT_FULL);
  });
});

describe("buildExitLegs - full repay", () => {
  it("repays every debt leg with the sentinel and withdraws nothing", () => {
    const { legs, views } = buildExitLegs(
      [
        usdc({ debt: 5_000_000000n, aBalance: 1_000_000000n }),
        weth({ debt: 2n * 10n ** 18n, aBalance: 3n * 10n ** 18n }),
      ],
      { protocol: "aave_v3", kind: "full_repay" },
    );

    expect(legs).toHaveLength(2);
    // The sentinel, not a fraction of the read debt: interest accrues between
    // the read and the signature, and a leftover unit of debt means the
    // position is not actually unlevered.
    expect(legs.map((l) => l.repayAmount)).toEqual([AMOUNT_FULL, AMOUNT_FULL]);
    // The whole point of the outcome: the collateral stays deposited.
    expect(legs.map((l) => l.withdrawAmount)).toEqual([0n, 0n]);
    expect(views.map((v) => v.withdraw)).toEqual([0n, 0n]);
    // Funding is the read debt, which is what a wallet balance compares to.
    expect(views.map((v) => v.repayFunding)).toEqual([5_000_000000n, 2n * 10n ** 18n]);
  });

  it("skips a collateral-only reserve instead of building an empty leg", () => {
    const { legs, views } = buildExitLegs(
      [usdc({ debt: 0n, aBalance: 9_000_000000n }), weth({ debt: 10n ** 18n })],
      { protocol: "aave_v3", kind: "full_repay" },
    );
    expect(legs).toHaveLength(1);
    expect(views[0]?.symbol).toBe("WETH");
    expect(views[0]?.aBalance).toBe(0n);
  });

  it("builds nothing at all for a position with no debt", () => {
    const { legs, dust } = buildExitLegs([usdc({ aBalance: 9_000_000000n })], {
      protocol: "aave_v3",
      kind: "full_repay",
    });
    expect(legs).toHaveLength(0);
    // Not dust: there is no debt to round away, which the flow words differently.
    expect(dust).toEqual([]);
  });

  it("ignores repayFraction, exactly as a full exit does", () => {
    const { legs } = buildExitLegs([weth({ debt: 4n * 10n ** 18n })], {
      protocol: "aave_v3",
      kind: "full_repay",
      repayFraction: 0.25,
    });
    expect(legs[0]?.repayAmount).toBe(AMOUNT_FULL);
    expect(legs[0]?.withdrawAmount).toBe(0n);
  });

  it("carries the protocol id through", () => {
    const { legs } = buildExitLegs([usdc({ debt: 100n })], {
      protocol: "moonwell",
      kind: "full_repay",
    });
    expect(legs[0]?.protocol).toBe(PROTOCOL_ID.moonwell);
  });
});

describe("buildExitLegs - partial reduce", () => {
  it("repays WETH debt in WETH units, exact at 18 decimals", () => {
    const debt = 12_345_678_901_234_567_890n; // ~12.35 WETH, past 2^53
    const { legs, views } = buildExitLegs([weth({ debt })], {
      protocol: "aave_v3",
      kind: "partial",
      repayFraction: 0.25,
    });

    expect(legs).toHaveLength(1);
    expect(legs[0]?.asset).toBe(WETH);
    expect(legs[0]?.repayAmount).toBe(3_086_419_725_308_641_972n);
    expect(legs[0]?.withdrawAmount).toBe(0n); // wallet-funded: collateral untouched
    // The USD path this replaced produced `repayUsd * 10 ** 6` - twelve orders
    // of magnitude short of a WETH amount, and only for a reserve named USDC.
    expect(views[0]?.repayFunding).toBe(legs[0]?.repayAmount);
    expect(views[0]?.decimals).toBe(18);
  });

  it("repays every reserve that carries debt, at the same fraction", () => {
    // Health factor is L/D, so scaling every debt leg by f scales D by f and
    // lands the health factor where the advisor promised. Repaying one chosen
    // asset only works when that asset happens to carry enough debt.
    const { legs } = buildExitLegs(
      [usdc({ debt: 10_000_000000n }), weth({ debt: 2n * 10n ** 18n })],
      { protocol: "aave_v3", kind: "partial", repayFraction: 0.5 },
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]?.repayAmount).toBe(5_000_000000n);
    expect(legs[1]?.repayAmount).toBe(1n * 10n ** 18n);
  });

  it("never repays more than the debt, whatever the fraction says", () => {
    const { legs } = buildExitLegs([usdc({ debt: 1_000_000000n })], {
      protocol: "aave_v3",
      kind: "partial",
      repayFraction: 1.4,
    });
    expect(legs[0]?.repayAmount).toBe(1_000_000000n);
  });

  it("builds nothing when the prefill carries no fraction", () => {
    // The dollar figure is display only: without a fraction there is no size,
    // and inventing one from `repayUsd` needs the price this design removed.
    const { legs, dust } = buildExitLegs([usdc({ debt: 10_000_000000n })], {
      protocol: "aave_v3",
      kind: "partial",
    });
    expect(legs).toHaveLength(0);
    expect(dust).toEqual(["USDC"]);
  });

  it("leaves collateral alone and skips zero-debt reserves", () => {
    const { legs, views } = buildExitLegs(
      [usdc({ debt: 0n, aBalance: 9_000_000000n }), weth({ debt: 10n ** 18n })],
      { protocol: "aave_v3", kind: "partial", repayFraction: 0.5 },
    );
    expect(legs).toHaveLength(1);
    expect(views[0]?.symbol).toBe("WETH");
    expect(views[0]?.withdraw).toBe(0n);
  });

  it("names a leg it dropped as dust instead of silently skipping it", () => {
    // 1 unit of USDC at the smallest representable fraction rounds to nothing.
    const { legs, dust } = buildExitLegs([usdc({ debt: 1n }), weth({ debt: 10n ** 18n })], {
      protocol: "aave_v3",
      kind: "partial",
      repayFraction: 1 / REPAY_FRACTION_SCALE,
    });
    expect(dust).toEqual(["USDC"]);
    expect(legs).toHaveLength(1);
    // The WETH leg is far above the scale, so it survives: 1e18 / 1e6.
    expect(legs[0]?.repayAmount).toBe(10n ** 12n);
  });

  it("floors at the fixed-point scale, so it never over-repays", () => {
    // 7 units at one third: 7 * 333333 / 1e6 = 2.333..., taken as 2.
    const { legs } = buildExitLegs([usdc({ debt: 7n })], {
      protocol: "aave_v3",
      kind: "partial",
      repayFraction: 0.333333,
    });
    expect(legs[0]?.repayAmount).toBe(2n);
  });

  it("carries the protocol id through", () => {
    const { legs } = buildExitLegs([usdc({ debt: 100n })], {
      protocol: "moonwell",
      kind: "partial",
      repayFraction: 1,
    });
    expect(legs[0]?.protocol).toBe(PROTOCOL_ID.moonwell);
  });
});

describe("formatTokenAmount", () => {
  it("keeps every digit of an 18-decimal balance", () => {
    // Number(v) / 1e18 on this value rounds the tail away.
    expect(formatTokenAmount(123_456_789_012_345_678_901n, 18)).toBe("123.46");
    expect(formatTokenAmount(1_000_000000n, 6)).toBe("1,000");
    expect(formatTokenAmount(1_234_560000n, 6)).toBe("1,234.56");
  });

  it("rounds half up at the display precision", () => {
    expect(formatTokenAmount(1_005000n, 6)).toBe("1.01");
    expect(formatTokenAmount(1_004000n, 6)).toBe("1");
  });
});

describe("swapSlippageFloor", () => {
  it("turns the deployed 9500 bps floor into a 5% tolerance", () => {
    expect(swapSlippageFloor({ enabled: true, minOutBps: 9_500 })).toBeCloseTo(0.05, 12);
  });

  it("returns null rather than a 0% for anything unusable", () => {
    expect(swapSlippageFloor(null)).toBeNull();
    expect(swapSlippageFloor({ enabled: false, minOutBps: 9_500 })).toBeNull();
    expect(swapSlippageFloor({ enabled: true, minOutBps: 0 })).toBeNull();
    expect(swapSlippageFloor({ enabled: true, minOutBps: 10_001 })).toBeNull();
  });
});

describe("swapAcquisitionNote", () => {
  const base = { symbol: "WETH", decimals: 18, shortfall: 2n * 10n ** 18n };

  it("says nothing when the wallet already covers the repay", () => {
    expect(
      swapAcquisitionNote({ ...base, shortfall: 0n, config: { enabled: true, minOutBps: 9_500 } }),
    ).toBeNull();
  });

  it("names the shortfall and the cost of swapping for it", () => {
    const note = swapAcquisitionNote({ ...base, config: { enabled: true, minOutBps: 9_500 } });
    expect(note).toBe(
      "You need 2 more WETH in your wallet before you can do this. Swapping another asset for WETH is one way to get it, and that swap is held to within 5.0% of the oracle price.",
    );
    expect(note).not.toContain("—");
  });

  it("says the route is unavailable rather than going quiet", () => {
    const note = swapAcquisitionNote({ ...base, config: { enabled: false, minOutBps: 9_500 } });
    expect(note).toContain("no swap route set up for WETH");
    expect(note).toContain("2 more WETH");
  });

  it("drops the percentage rather than inventing one when the read failed", () => {
    const note = swapAcquisitionNote({ ...base, config: null });
    expect(note).toBe("You need 2 more WETH in your wallet before you can do this.");
    expect(note).not.toContain("%");
  });
});
