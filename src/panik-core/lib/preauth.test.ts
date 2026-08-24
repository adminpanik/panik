/**
 * Pre-authorization and revoke-all.
 *
 * Two things are load-bearing here and both are safety claims rather than
 * styling: the "one signature at panic" promise must be recomputed from what
 * was actually read, and a revoke-all must never report a revocation that did
 * not happen.
 *
 * The four grant patterns are covered even though only Aave is executable on
 * the current testnet deployment (`EXECUTABLE_PROTOCOLS` in `./exit`), so the
 * shape of a Comet `allow` or a Morpho `setAuthorization` is pinned before
 * there is an address to send it to.
 */

import { describe, expect, it } from "vitest";
import {
  grantCovered,
  operatorCall,
  operatorReadCall,
  preauthCoverage,
  PROTOCOL_GRANTS,
  revokeSummary,
  type GrantState,
} from "./preauth";
import { approvalStepsFor, type ExitLegView } from "./exitLegs";

const EXECUTOR = "0x00000000000000000000000000000000000000EE" as const;
const OWNER = "0x0000000000000000000000000000000000000001" as const;
const MARKET = "0x00000000000000000000000000000000000000AA" as const;

function erc20(id: string, required: bigint, current: bigint): GrantState {
  return { id, spec: PROTOCOL_GRANTS.aave_v3[0], required, current };
}

describe("PROTOCOL_GRANTS", () => {
  it("covers every protocol the engine knows, with a repay grant and a collateral grant", () => {
    for (const [protocol, grants] of Object.entries(PROTOCOL_GRANTS)) {
      expect(grants.length, protocol).toBe(2);
      expect(grants[0].kind, protocol).toBe("erc20");
    }
  });

  it("uses the boolean pattern exactly where the protocol does", () => {
    expect(PROTOCOL_GRANTS.aave_v3[1].kind).toBe("erc20");
    expect(PROTOCOL_GRANTS.moonwell[1].kind).toBe("erc20");
    expect(PROTOCOL_GRANTS.compound_v3[1]).toMatchObject({
      kind: "operator",
      method: "allow",
    });
    expect(PROTOCOL_GRANTS.morpho[1]).toMatchObject({
      kind: "operator",
      method: "setAuthorization",
    });
  });

  it("explains every grant without an em dash", () => {
    for (const grants of Object.values(PROTOCOL_GRANTS)) {
      for (const g of grants) {
        expect(g.permits.length).toBeGreaterThan(40);
        expect(g.permits).not.toContain("—");
      }
    }
  });
});

describe("operatorCall", () => {
  it("builds Comet's allow and Morpho's setAuthorization against the market", () => {
    expect(operatorCall(PROTOCOL_GRANTS.compound_v3[1], MARKET, EXECUTOR, true)).toEqual({
      address: MARKET,
      functionName: "allow",
      args: [EXECUTOR, true],
    });
    expect(operatorCall(PROTOCOL_GRANTS.morpho[1], MARKET, EXECUTOR, false)).toEqual({
      address: MARKET,
      functionName: "setAuthorization",
      args: [EXECUTOR, false],
    });
  });

  it("is the same call with the flag flipped, which is what makes revoke reach it", () => {
    const grant = operatorCall(PROTOCOL_GRANTS.compound_v3[1], MARKET, EXECUTOR, true);
    const revoke = operatorCall(PROTOCOL_GRANTS.compound_v3[1], MARKET, EXECUTOR, false);
    expect(revoke?.address).toBe(grant?.address);
    expect(revoke?.functionName).toBe(grant?.functionName);
    expect(revoke?.args[1]).toBe(false);
  });

  it("refuses an allowance grant, which has no boolean to set", () => {
    expect(operatorCall(PROTOCOL_GRANTS.aave_v3[0], MARKET, EXECUTOR, true)).toBeNull();
    expect(operatorReadCall(PROTOCOL_GRANTS.aave_v3[0], MARKET, OWNER, EXECUTOR)).toBeNull();
  });

  it("reads each boolean back through the protocol's own view", () => {
    expect(operatorReadCall(PROTOCOL_GRANTS.compound_v3[1], MARKET, OWNER, EXECUTOR)).toEqual({
      address: MARKET,
      functionName: "isAllowed",
      args: [OWNER, EXECUTOR],
    });
    expect(operatorReadCall(PROTOCOL_GRANTS.morpho[1], MARKET, OWNER, EXECUTOR)).toEqual({
      address: MARKET,
      functionName: "isAuthorized",
      args: [OWNER, EXECUTOR],
    });
  });
});

describe("grantCovered", () => {
  it("covers when the allowance meets the requirement exactly", () => {
    expect(grantCovered(erc20("a", 1_000n, 1_000n))).toBe(true);
    expect(grantCovered(erc20("a", 1_000n, 999n))).toBe(false);
  });

  it("treats a nothing-to-approve leg as covered, so a wallet on one protocol needs no special case", () => {
    expect(grantCovered(erc20("a", 0n, 0n))).toBe(true);
  });

  it("never treats an unread allowance as covered", () => {
    expect(grantCovered({ id: "a", spec: PROTOCOL_GRANTS.aave_v3[0], required: 5n })).toBe(false);
  });

  it("reads an operator grant off the boolean and nothing else", () => {
    const spec = PROTOCOL_GRANTS.compound_v3[1];
    expect(grantCovered({ id: "o", spec, granted: true })).toBe(true);
    expect(grantCovered({ id: "o", spec, granted: false })).toBe(false);
    // Unread is not granted.
    expect(grantCovered({ id: "o", spec })).toBe(false);
  });
});

describe("preauthCoverage", () => {
  it("promises one signature only when every grant already covers", () => {
    const all = preauthCoverage([erc20("a", 10n, 10n), erc20("b", 5n, 7n)]);
    expect(all.missing).toHaveLength(0);
    expect(all.signaturesAtPanic).toBe(1);
  });

  it("counts every missing grant, plus the exit itself", () => {
    const some = preauthCoverage([
      erc20("a", 10n, 10n),
      erc20("b", 5n, 0n),
      erc20("c", 5n, 4n),
    ]);
    expect(some.missing.map((m) => m.id)).toEqual(["b", "c"]);
    expect(some.covered.map((m) => m.id)).toEqual(["a"]);
    expect(some.signaturesAtPanic).toBe(3);
  });

  it("counts a debt that has accrued past its buffer as no longer covered", () => {
    // Approved for 102 against a debt of 100 (the +2% buffer), then interest
    // took the debt to 103. The promise stops holding and the count says so.
    expect(preauthCoverage([erc20("a", 103n, 102n)]).signaturesAtPanic).toBe(2);
  });
});

describe("revokeSummary", () => {
  const ok = (id: string) => ({ id, label: id, ok: true });
  const bad = (id: string) => ({ id, label: id, ok: false, error: "reverted" });

  it("claims everything only when every receipt succeeded", () => {
    expect(revokeSummary([ok("USDC"), ok("aUSDC")])).toBe("All 2 approvals are revoked.");
  });

  it("names the ones that did not go through", () => {
    const line = revokeSummary([ok("USDC"), bad("aWETH")]);
    expect(line).toContain("aWETH");
    expect(line).toContain("1 of 2");
    expect(line).not.toContain("All ");
  });

  it("never says anything was revoked when nothing was", () => {
    const line = revokeSummary([bad("USDC"), bad("aWETH")]);
    expect(line).toContain("Nothing was revoked");
    expect(line).toContain("USDC");
    expect(line).toContain("aWETH");
    expect(line).toContain("unchanged");
  });

  it("says so when there was nothing to revoke", () => {
    expect(revokeSummary([])).toBe("There was nothing to revoke.");
  });
});

describe("approvalStepsFor", () => {
  const view = (over: Partial<ExitLegView>): ExitLegView => ({
    reserve: "0x00000000000000000000000000000000000000B1",
    symbol: "USDC",
    decimals: 6,
    repay: 0n,
    withdraw: 0n,
    debt: 0n,
    aBalance: 0n,
    repayFunding: 0n,
    ...over,
  });

  it("asks for the debt asset at the funding amount, not the sentinel", () => {
    const { steps, missing } = approvalStepsFor(
      [view({ repay: 2n ** 256n - 1n, repayFunding: 1_500_000n, debt: 1_500_000n })],
      EXECUTOR,
      new Map(),
    );
    expect(missing).toEqual([]);
    expect(steps).toEqual([
      {
        token: "0x00000000000000000000000000000000000000B1",
        spender: EXECUTOR,
        amount: 1_500_000n,
        symbol: "USDC",
        label: "Approve USDC for debt repayment",
      },
    ]);
  });

  it("asks for the aToken at the deposit balance when collateral is withdrawn", () => {
    const reserve = "0x00000000000000000000000000000000000000B2" as const;
    const aToken = "0x00000000000000000000000000000000000000C2" as const;
    const { steps, missing } = approvalStepsFor(
      [view({ reserve, symbol: "WETH", decimals: 18, withdraw: 1n, aBalance: 4_000n })],
      EXECUTOR,
      new Map([[reserve.toLowerCase(), aToken]]),
    );
    expect(missing).toEqual([]);
    expect(steps).toEqual([
      {
        token: aToken,
        spender: EXECUTOR,
        amount: 4_000n,
        symbol: "aWETH",
        label: "Approve aWETH collateral transfer",
      },
    ]);
  });

  it("reports a withdrawal whose aToken is unknown rather than dropping it", () => {
    const { steps, missing } = approvalStepsFor(
      [view({ symbol: "WETH", withdraw: 1n, aBalance: 9n })],
      EXECUTOR,
      new Map(),
    );
    expect(steps).toEqual([]);
    expect(missing).toEqual(["WETH"]);
  });

  it("skips a reserve the wallet has no position in", () => {
    expect(approvalStepsFor([view({})], EXECUTOR, new Map()).steps).toEqual([]);
  });

  it("matches the aToken map case-insensitively, because the two sources are independently checksummed", () => {
    const reserve = "0x00000000000000000000000000000000000000bB" as const;
    const aToken = "0x00000000000000000000000000000000000000C3" as const;
    const { steps } = approvalStepsFor(
      [view({ reserve, withdraw: 1n, aBalance: 1n })],
      EXECUTOR,
      new Map([[reserve.toLowerCase(), aToken]]),
    );
    expect(steps[0]?.token).toBe(aToken);
  });
});
