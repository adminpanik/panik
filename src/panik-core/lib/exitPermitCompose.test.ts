/**
 * Permit composition defaults + revoke-status gating (Phase 2.C).
 *
 * Two things are load-bearing enough to pin here. First, that the defaults trace
 * to the engine/chain and that a composed permit passes the SAME scope check the
 * backend runs (validatePermitScope) — a UI that composes a permit the contract
 * would reject sends the user to a wallet popup that ends in a 400. Second, the
 * revoke gate: a revocation is only ever reflected on a `success` receipt, never
 * on a reverted or missing one, because that is the difference between telling a
 * user their coverage is gone truthfully and telling them so while it is still
 * live on-chain.
 */

import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  EXIT_KIND,
  validatePermitScope,
} from "../../../server/exitPermit";
import { TARGET_HF } from "../../../packages/scoring/src/advisor/repayMath";
import { PROTOCOL_ID } from "./exitLegs";
import {
  clampSlippageBps,
  composeExitPermit,
  defaultProtocolsMask,
  defaultTriggerHf,
  grantActionMeta,
  hfToWad,
  nonceFromBytes,
  nonceInvalidation,
  permitToRequestBody,
  protocolsMaskFor,
  repayFractionBpsFor,
  revocationConfirmed,
  wadToHf,
  WAD,
  type ComposeInput,
} from "./exitPermitCompose";

const USER = "0xAbC0000000000000000000000000000000000001" as `0x${string}`;
const CEILING_BPS = 300; // a stand-in for the executor's maxPermitSlippageBps

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  user: USER,
  action: "full_exit",
  triggerHf: defaultTriggerHf("moderate"),
  maxSlippageBps: CEILING_BPS,
  protocolsMask: defaultProtocolsMask("testnet"),
  deadline: 2_000_000_000,
  epoch: 0n,
  nonce: 42n,
  ...over,
});

describe("defaults come from the engine, not the UI", () => {
  it("trigger HF is the risk-profile target from TARGET_HF", () => {
    expect(defaultTriggerHf("conservative")).toBe(TARGET_HF.conservative);
    expect(defaultTriggerHf("moderate")).toBe(TARGET_HF.moderate);
    expect(defaultTriggerHf("aggressive")).toBe(TARGET_HF.aggressive);
  });

  it("testnet protocol mask enables Aave V3 alone", () => {
    expect(defaultProtocolsMask("testnet")).toBe(1 << PROTOCOL_ID.aave_v3);
    expect(defaultProtocolsMask("testnet")).toBe(0b0001);
  });

  it("mainnet protocol mask enables all four protocols", () => {
    const mask = defaultProtocolsMask("mainnet");
    expect(mask & (1 << PROTOCOL_ID.aave_v3)).toBeTruthy();
    expect(mask & (1 << PROTOCOL_ID.moonwell)).toBeTruthy();
    expect(mask & (1 << PROTOCOL_ID.compound_v3)).toBeTruthy();
    expect(mask & (1 << PROTOCOL_ID.morpho)).toBeTruthy();
    expect(mask & 0x0f).toBe(0b1111);
  });

  it("protocolsMaskFor OR-s the named protocols", () => {
    expect(protocolsMaskFor(["aave_v3", "morpho"])).toBe(
      (1 << PROTOCOL_ID.aave_v3) | (1 << PROTOCOL_ID.morpho),
    );
  });
});

describe("slippage clamps to the on-chain ceiling", () => {
  it("passes a value at or below the ceiling through", () => {
    expect(clampSlippageBps(100, CEILING_BPS)).toBe(100);
    expect(clampSlippageBps(CEILING_BPS, CEILING_BPS)).toBe(CEILING_BPS);
  });
  it("never exceeds the ceiling", () => {
    expect(clampSlippageBps(CEILING_BPS + 1, CEILING_BPS)).toBe(CEILING_BPS);
    expect(clampSlippageBps(9999, CEILING_BPS)).toBe(CEILING_BPS);
  });
  it("falls back to the ceiling on a malformed input rather than guessing", () => {
    expect(clampSlippageBps(NaN, CEILING_BPS)).toBe(CEILING_BPS);
    expect(clampSlippageBps(-5, CEILING_BPS)).toBe(CEILING_BPS);
    expect(clampSlippageBps(1.5, CEILING_BPS)).toBe(CEILING_BPS);
  });
});

describe("HF <-> WAD is exact at the values a permit uses", () => {
  it("scales without losing the low bits", () => {
    expect(hfToWad(1.75)).toBe(1_750_000_000_000_000_000n);
    expect(hfToWad(2)).toBe(2n * WAD);
    expect(hfToWad(1.5)).toBe(1_500_000_000_000_000_000n);
  });
  it("round-trips back to the number", () => {
    expect(wadToHf(hfToWad(1.75))).toBeCloseTo(1.75, 9);
    expect(wadToHf(hfToWad(TARGET_HF.aggressive))).toBeCloseTo(TARGET_HF.aggressive, 9);
  });
  it("rejects a non-positive health factor", () => {
    expect(() => hfToWad(0)).toThrow();
    expect(() => hfToWad(-1)).toThrow();
  });
});

describe("composeExitPermit maps actions and always passes the backend scope check", () => {
  it("full exit / full repay carry a 100% repay fraction (the contract's rule)", () => {
    expect(grantActionMeta("full_exit").kind).toBe(EXIT_KIND.FULL_EXIT);
    expect(grantActionMeta("full_repay").kind).toBe(EXIT_KIND.FULL_REPAY);
    expect(composeExitPermit(base({ action: "full_exit" })).maxRepayFractionBps).toBe(
      BPS_DENOMINATOR,
    );
    expect(composeExitPermit(base({ action: "full_repay" })).maxRepayFractionBps).toBe(
      BPS_DENOMINATOR,
    );
  });

  it("reduce maps to REDUCE and caps at 100%", () => {
    const p = composeExitPermit(base({ action: "reduce" }));
    expect(p.kind).toBe(EXIT_KIND.REDUCE);
    expect(repayFractionBpsFor(EXIT_KIND.REDUCE)).toBe(BPS_DENOMINATOR);
    expect(p.maxRepayFractionBps).toBe(BPS_DENOMINATOR);
  });

  it("a composed permit passes validatePermitScope for every action", () => {
    const now = 1_900_000_000; // before the deadline in `base`
    for (const action of ["full_exit", "full_repay", "reduce"] as const) {
      const permit = composeExitPermit(base({ action }));
      const check = validatePermitScope(permit, CEILING_BPS, now);
      expect(check.ok, `${action}: ${check.error}`).toBe(true);
    }
  });

  it("the backend scope check rejects a permit past its deadline (gate we rely on)", () => {
    const permit = composeExitPermit(base({ deadline: 1_000 }));
    expect(validatePermitScope(permit, CEILING_BPS, 2_000).ok).toBe(false);
  });

  it("lower-cases the user and stringifies bigints for the request body", () => {
    const permit = composeExitPermit(base());
    const body = permitToRequestBody(permit, "0xdead");
    expect(body.permit.user).toBe(USER.toLowerCase());
    expect(body.permit.triggerHealthFactorWad).toBe(hfToWad(TARGET_HF.moderate).toString());
    expect(body.permit.epoch).toBe("0");
    expect(body.permit.nonce).toBe("42");
    expect(body.signature).toBe("0xdead");
  });
});

describe("nonce helpers", () => {
  it("reads big-endian bytes into a bigint", () => {
    expect(nonceFromBytes(new Uint8Array([0x01, 0x00]))).toBe(256n);
    expect(nonceFromBytes(new Uint8Array([0xff]))).toBe(255n);
  });
  it("splits a nonce into the word and bit invalidateUnorderedNonces takes", () => {
    expect(nonceInvalidation(0n)).toEqual({ wordPos: 0n, mask: 1n });
    expect(nonceInvalidation(255n)).toEqual({ wordPos: 0n, mask: 1n << 255n });
    expect(nonceInvalidation(256n)).toEqual({ wordPos: 1n, mask: 1n });
    expect(nonceInvalidation(258n)).toEqual({ wordPos: 1n, mask: 1n << 2n });
  });
});

describe("revoke-status gating: never show revoked before the chain confirms", () => {
  it("confirms only on a success receipt", () => {
    expect(revocationConfirmed({ status: "success" })).toBe(true);
  });
  it("does not confirm on a reverted receipt (viem does not throw on revert)", () => {
    expect(revocationConfirmed({ status: "reverted" })).toBe(false);
  });
  it("does not confirm on a missing or pending receipt", () => {
    expect(revocationConfirmed(null)).toBe(false);
    expect(revocationConfirmed(undefined)).toBe(false);
  });
});
