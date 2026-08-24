/**
 * Pre-authorization: the grants an exit needs, described in calm and counted
 * honestly.
 *
 * The panic path costs one signature only if every grant it needs is already in
 * place. This module is the part of that which can be reasoned about without a
 * chain: WHICH grants each protocol needs, what each one permits in words a
 * non-expert can check, and how many signatures a panic exit would still cost
 * given what is currently granted.
 *
 * It deliberately owns no amounts. Sizing is `exitLegs` (BigInt, the token's own
 * units) and the +2% accrual buffer is `withAccrualBuffer` there; running the
 * approvals is `useExitApprovals`. A second copy of either would be the money
 * path existing twice.
 *
 * No wagmi, no viem, no React, so this stays unit-testable under vitest's node
 * environment.
 */

import type { LiveProtocol } from "./live";

/**
 * The two shapes a grant takes on chain, and they revoke differently.
 *
 * `erc20` is an allowance: a number, revoked by setting it to zero.
 * `operator` is a boolean on the protocol's own market contract
 * (`Comet.allow`, `Morpho.setAuthorization`), revoked by setting it false.
 *
 * They are told apart because a revoke-all that silently covered only the first
 * kind would leave a live operator grant behind while reporting everything
 * revoked, which is the exact failure this box exists to prevent.
 */
export type GrantKind = "erc20" | "operator";

export interface GrantSpec {
  kind: GrantKind;
  /** What is being granted over, as the user would name it. */
  subject: string;
  /**
   * Exactly what this permits, in one sentence with no jargon. Shown next to
   * the grant, not behind a tip: a user approving a token movement is entitled
   * to read what it allows before they sign, on the same glance.
   */
  permits: string;
  /** The on-chain call, for the operator kind only. */
  method?: "allow" | "setAuthorization";
}

/**
 * Every grant a full exit needs, per protocol.
 *
 * Two per protocol in every case, and the pair is always the same idea: one
 * grant lets the executor take the debt asset out of the wallet to repay with,
 * and one lets it move the deposit so the collateral can be withdrawn. Only the
 * second one's shape differs, and that is what `kind` records.
 */
export const PROTOCOL_GRANTS: Record<LiveProtocol, readonly GrantSpec[]> = {
  aave_v3: [
    {
      kind: "erc20",
      subject: "Borrowed asset",
      permits:
        "Lets the exit contract take the borrowed asset out of your wallet to repay your Aave V3 loan, up to the amount you approve and no further.",
    },
    {
      kind: "erc20",
      subject: "aToken deposit receipt",
      permits:
        "Lets the exit contract move the aTokens that stand for your Aave V3 deposit, which is how your collateral gets withdrawn.",
    },
  ],
  moonwell: [
    {
      kind: "erc20",
      subject: "Borrowed asset",
      permits:
        "Lets the exit contract take the borrowed asset out of your wallet to repay your Moonwell loan, up to the amount you approve and no further.",
    },
    {
      kind: "erc20",
      subject: "mToken deposit receipt",
      permits:
        "Lets the exit contract move the mTokens that stand for your Moonwell deposit, which is how your collateral gets withdrawn.",
    },
  ],
  compound_v3: [
    {
      kind: "erc20",
      subject: "Base asset",
      permits:
        "Lets the exit contract take the base asset out of your wallet to repay your Compound V3 loan, up to the amount you approve and no further.",
    },
    {
      kind: "operator",
      method: "allow",
      subject: "Account manager on Compound V3",
      permits:
        "Names the exit contract as a manager on your Compound V3 account so it can withdraw your collateral. This one is a yes or no switch, not an amount, and turning it off takes effect immediately.",
    },
  ],
  morpho: [
    {
      kind: "erc20",
      subject: "Loan asset",
      permits:
        "Lets the exit contract take the loan asset out of your wallet to repay your Morpho position, up to the amount you approve and no further.",
    },
    {
      kind: "operator",
      method: "setAuthorization",
      subject: "Authorized manager on Morpho",
      permits:
        "Authorizes the exit contract to act on your Morpho position so it can withdraw your collateral. This one is a yes or no switch, not an amount, and turning it off takes effect immediately.",
    },
  ],
};

/** The two boolean-grant calls, so neither signature is retyped at a call site. */
export const OPERATOR_GRANT_ABI = [
  {
    type: "function",
    name: "allow",
    inputs: [
      { name: "manager", type: "address" },
      { name: "isAllowed", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isAllowed",
    inputs: [
      { name: "owner", type: "address" },
      { name: "manager", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setAuthorization",
    inputs: [
      { name: "authorized", type: "address" },
      { name: "newIsAuthorized", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isAuthorized",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "authorized", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export interface OperatorCall {
  address: `0x${string}`;
  functionName: "allow" | "setAuthorization";
  args: readonly [`0x${string}`, boolean];
}

/**
 * The write that grants or revokes a boolean operator permission.
 *
 * One place, because grant and revoke are the same call with the flag flipped:
 * a revoke path that built its own call is a revoke path free to target a
 * different contract than the grant did.
 */
export function operatorCall(
  spec: GrantSpec,
  market: `0x${string}`,
  spender: `0x${string}`,
  allowed: boolean,
): OperatorCall | null {
  if (spec.kind !== "operator" || spec.method === undefined) return null;
  return { address: market, functionName: spec.method, args: [spender, allowed] };
}

/** The matching view, for reading the current state before and after. */
export function operatorReadCall(
  spec: GrantSpec,
  market: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): { address: `0x${string}`; functionName: "isAllowed" | "isAuthorized"; args: readonly [`0x${string}`, `0x${string}`] } | null {
  if (spec.kind !== "operator" || spec.method === undefined) return null;
  return {
    address: market,
    functionName: spec.method === "allow" ? "isAllowed" : "isAuthorized",
    args: [owner, spender],
  };
}

/** One grant and whether it currently covers what an exit would need. */
export interface GrantState {
  /** Stable identity: the token or market address plus what it grants. */
  id: string;
  spec: GrantSpec;
  /** What an exit needs, in the token's own units. Absent for an operator grant. */
  required?: bigint;
  /** What is granted right now. Absent for an operator grant. */
  current?: bigint;
  /** Operator grants only: whether the switch is on. */
  granted?: boolean;
}

/**
 * Whether one grant already covers an exit.
 *
 * An ERC-20 grant covers when the allowance is at or above what the exit needs.
 * `required === 0n` covers trivially, which is what a reserve the wallet has no
 * position in looks like, and is why a wallet with positions on some protocols
 * and not others needs no special case anywhere else.
 */
export function grantCovered(state: GrantState): boolean {
  if (state.spec.kind === "operator") return state.granted === true;
  if (state.required === undefined || state.current === undefined) return false;
  return state.current >= state.required;
}

/**
 * How many wallet signatures a panic exit would still cost, and whether the
 * one-signature promise currently holds.
 *
 * The UI must never assert "one signature" as a standing fact: it is true only
 * while every grant covers, and debt accrues past a grant on its own with
 * nobody touching anything. So the claim is recomputed from the state that was
 * actually read, and the count is what the screen says.
 */
export interface PreauthCoverage {
  /** Grants an exit would have to ask for before it could execute. */
  missing: GrantState[];
  /** Grants already in place. */
  covered: GrantState[];
  /** Approvals still owed, plus the exit itself. */
  signaturesAtPanic: number;
}

export function preauthCoverage(states: readonly GrantState[]): PreauthCoverage {
  const missing: GrantState[] = [];
  const covered: GrantState[] = [];
  for (const s of states) {
    (grantCovered(s) ? covered : missing).push(s);
  }
  return { missing, covered, signaturesAtPanic: missing.length + 1 };
}

/** One revocation attempt, as the chain answered it. */
export interface RevokeOutcome {
  /** Matches `GrantState.id`. */
  id: string;
  label: string;
  ok: boolean;
  /** Why it failed. Present only when `ok` is false. */
  error?: string;
}

/**
 * What to tell the user after a revoke-all, given what actually happened.
 *
 * Never "all approvals revoked" unless every attempt returned a success
 * receipt. A revocation that reverted while the screen said it succeeded leaves
 * a live allowance behind a message promising there is none, which is worse
 * than not offering the button.
 *
 * The failures are NAMED. "Some revocations failed" tells a user nothing they
 * can act on; the protocol and asset tell them which one to go and handle.
 */
export function revokeSummary(outcomes: readonly RevokeOutcome[]): string {
  if (outcomes.length === 0) return "There was nothing to revoke.";
  const failed = outcomes.filter((o) => !o.ok);
  const done = outcomes.length - failed.length;
  if (failed.length === 0) {
    return done === 1
      ? "The one approval this wallet had granted is revoked."
      : `All ${done} approvals are revoked.`;
  }
  const names = failed.map((f) => f.label).join(", ");
  if (done === 0) {
    return `Nothing was revoked. ${failed.length === 1 ? "This one" : "These"} did not go through: ${names}. Your approvals are unchanged.`;
  }
  return `${done} of ${outcomes.length} approvals are revoked. ${failed.length === 1 ? "This one is" : "These are"} still granted: ${names}.`;
}
