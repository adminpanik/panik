/**
 * The coverage sweep (Phase 4.B) — the "believes protected but isn't" detector.
 *
 * Every other alert in this system watches a component. This one watches the
 * PROMISE. For each wallet whose UI would show standing protection as active,
 * it asks the only question that matters: if the trigger fired right now, would
 * `atomicExitFor` actually go through?
 *
 * A permit being live on-chain is NOT that question. A permit can be perfectly
 * live — unspent nonce, matching epoch, deadline in the future — and still be
 * dead weight, because the exit it authorises needs approvals the user granted
 * separately and can revoke at any time from any wallet UI, with nothing in
 * this system noticing. That is the gap this file closes:
 *
 *   Aave         the executor pulls the debt asset from the user
 *                (`_pullFromUser` -> safeTransferFrom) and, for a full exit,
 *                pulls aTokens. Both are plain ERC-20 allowances TO THE
 *                EXECUTOR, and both go to zero the moment a user revokes.
 *   Moonwell     same shape, on the mToken.
 *   Compound V3  `comet.allow(compoundAdapter, true)`, revocable with one call.
 *   Morpho       `morpho.setAuthorization(morphoAdapter, true)`, likewise.
 *
 * Plus the EIP-7702 transition (Issue #41, layer 3): a signer can install a
 * delegate AFTER granting, which turns a valid permit into one the executor
 * will refuse via its ERC-1271 branch. Grant time records the baseline (see
 * server/exit7702.ts); the sweep compares it against live code.
 *
 * ── THE RULE THAT SHAPES EVERYTHING HERE ────────────────────────────────────
 *
 * UNVERIFIED IS NOT VERIFIED. When the sweep cannot check an authorization —
 * a Comet market whose address is not configured, a permit whose signer-code
 * baseline predates the column — it emits `coverage.unverifiable`. It never
 * omits the check and it never reports the wallet as covered. "Never state a
 * fact the code does not know" is the whole reason this module exists; a sweep
 * that quietly skips what it cannot see is a more convincing version of the bug
 * it was built to catch.
 *
 * Delegation status is NEVER re-derived here: `reconcile` from
 * server/exitDelegations.ts is the single place a stored row becomes a live
 * one, and a second opinion about that is exactly how a monitor and a relayer
 * end up disagreeing about who is protected.
 */

import { reconcile, type DelegationDeps } from "./exitDelegations";
import type { DelegationRow } from "./exitDelegationStore";
import { EXIT_KIND, type ExitPermit } from "./exitPermit";
import { codeStateFrom, codeTransition } from "./exit7702";
import { PROTOCOL_ID, type ExitReserveState } from "../src/panik-core/lib/exitLegs";
import type { LiveProtocol } from "../src/panik-core/lib/live";
import type { MonitorAlert } from "./monitorAlerts";

/** Why a live permit would not execute. Stable strings; grouped on downstream. */
export type CoverageGapKind =
  | "repay_allowance_missing"
  | "collateral_allowance_missing"
  | "comet_not_authorized"
  | "morpho_not_authorized"
  | "signer_gained_code"
  | "signer_code_changed";

/** One concrete reason a wallet's coverage would fail today. */
export interface CoverageGap {
  kind: CoverageGapKind;
  protocol: LiveProtocol | null;
  /** Human-readable, facts only. */
  detail: string;
}

/** Something the sweep tried to check and could not. Unknown, not fine. */
export interface CoverageUnknown {
  protocol: LiveProtocol | null;
  reason: string;
}

/** The reads the sweep needs. Injected so the logic tests without an RPC. */
export interface CoverageChain {
  /** eth_getCode on the signer. "0x" for a plain EOA. */
  codeAt(address: `0x${string}`): Promise<`0x${string}`>;
  /** ERC-20 allowance(owner, spender). */
  allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
  /** Aave aToken for a reserve, or null when the reserve is not listed. */
  aTokenFor(reserve: `0x${string}`): Promise<`0x${string}` | null>;
  /** Per-reserve aToken balance / debt for the user, as the relayer reads them. */
  reserveStates(user: `0x${string}`): Promise<ExitReserveState[]>;
  /** Comet `isAllowed(owner, manager)`. */
  cometAllowed(comet: `0x${string}`, owner: `0x${string}`, manager: `0x${string}`): Promise<boolean>;
  /** Morpho `isAuthorized(authorizer, authorized)`. */
  morphoAuthorized(
    morpho: `0x${string}`,
    owner: `0x${string}`,
    authorized: `0x${string}`,
  ): Promise<boolean>;
}

/**
 * The market addresses the sweep is able to check.
 *
 * Deliberately explicit rather than discovered. A protocol the operator has not
 * configured produces `coverage.unverifiable`, which is the honest outcome; a
 * scan that guessed markets would produce confident answers about positions it
 * had never looked at.
 */
export interface CoverageMarkets {
  /** Aave reserves to read (same list the relayer uses). */
  aaveReserves: readonly `0x${string}`[];
  /** Comet markets, paired with the adapter that must be `allow`ed. */
  comets: readonly `0x${string}`[];
  compoundAdapter: `0x${string}` | null;
  /** The Morpho Blue singleton, and the adapter that must be authorized. */
  morpho: `0x${string}` | null;
  morphoAdapter: `0x${string}` | null;
  /** Moonwell mTokens the user might hold, keyed by nothing but their address. */
  mTokens: readonly `0x${string}`[];
}

/** One wallet as the worker sees it this tick. */
export interface SweepTarget {
  wallet: `0x${string}`;
  /** Protocols the engine is currently scoring for this wallet. */
  protocols: readonly LiveProtocol[];
  /**
   * Is at least one of this wallet's positions in trouble right now? Drives
   * severity: a broken authorization on a healthy position is a warning, the
   * same break on a position near liquidation is a page.
   */
  atRisk: boolean;
}

export interface SweepDeps {
  delegations: DelegationDeps;
  chain: CoverageChain;
  markets: CoverageMarkets;
  /** The executor: the spender on every ERC-20 leg of a delegated exit. */
  executor: `0x${string}`;
  nowSec: number;
  nowMs: number;
}

/**
 * Renewal escalation ladder, in seconds before `permit.deadline`.
 *
 * Descending on purpose — the sweep takes the FIRST (largest) threshold the
 * permit has crossed, so a permit at 40 hours reports the 48h rung and not the
 * 7d one it also satisfies. Each rung carries its own alert key, so each fires
 * exactly once and an ignored prompt escalates instead of repeating.
 */
export const EXPIRY_THRESHOLDS: readonly { label: string; sec: number }[] = [
  { label: "12h", sec: 12 * 3_600 },
  { label: "48h", sec: 48 * 3_600 },
  { label: "7d", sec: 7 * 86_400 },
];

/** Severity of each rung. The last one before expiry is the loud one. */
const EXPIRY_SEVERITY: Record<string, "info" | "warning" | "critical"> = {
  "7d": "info",
  "48h": "warning",
  "12h": "critical",
};

/** The rung this permit is on, or null when it is not near expiry. */
export function expiryRung(secondsLeft: number): { label: string; sec: number } | null {
  if (secondsLeft <= 0) return null;
  for (const t of EXPIRY_THRESHOLDS) {
    if (secondsLeft <= t.sec) return t;
  }
  return null;
}

/** Does this permit's mask authorise a leg on this protocol? */
function covers(permit: ExitPermit, protocol: LiveProtocol): boolean {
  return (permit.protocolsMask & (1 << PROTOCOL_ID[protocol])) !== 0;
}

/**
 * The repay the executor is authorised to pull, from LIVE debt.
 *
 * Mirrors `_capRepay` in PanikExecutor.sol: `liveDebt * maxRepayFractionBps /
 * 10000`, BigInt throughout. An allowance below this figure means the transfer
 * inside `atomicExitFor` reverts and the whole exit unwinds.
 */
export function authorizedRepay(debt: bigint, maxRepayFractionBps: number): bigint {
  return (debt * BigInt(maxRepayFractionBps)) / 10_000n;
}

/** The result of sweeping one wallet. */
export interface WalletCoverage {
  wallet: `0x${string}`;
  /** Rows the database still calls active, whatever the chain says. */
  claimedActive: number;
  /** Rows the chain would actually accept. */
  live: number;
  gaps: CoverageGap[];
  unknowns: CoverageUnknown[];
  alerts: MonitorAlert[];
}

/**
 * Sweep one wallet.
 *
 * Never throws for a per-wallet problem: one unreadable position must not stop
 * the sweep for everyone else (the same rule server/exitRelayer.ts follows).
 * A read that fails becomes an `unknown`, which becomes an alert, which is the
 * correct outcome — a monitor that silently drops a wallet is the failure it
 * was built to detect.
 */
export async function sweepWallet(target: SweepTarget, deps: SweepDeps): Promise<WalletCoverage> {
  const wallet = target.wallet.toLowerCase() as `0x${string}`;
  const gaps: CoverageGap[] = [];
  const unknowns: CoverageUnknown[] = [];
  const alerts: MonitorAlert[] = [];
  const at = deps.nowMs;

  let reconciled;
  try {
    reconciled = await reconcile(wallet, deps.delegations);
  } catch (err) {
    return {
      wallet,
      claimedActive: 0,
      live: 0,
      gaps,
      unknowns: [{ protocol: null, reason: `delegation reconcile failed: ${(err as Error).message}` }],
      alerts: [
        {
          kind: "coverage.unverifiable",
          severity: "warning",
          key: `coverage.unverifiable:${wallet}:reconcile`,
          summary: `coverage for ${wallet} could not be verified: the delegation reconcile failed`,
          detail: { error: (err as Error).message.slice(0, 200) },
          wallet,
          at,
        },
      ],
    };
  }

  const live = reconciled.filter((r) => r.status === "active");

  // ── Coverage that LAPSED ──────────────────────────────────────────────────
  // A row the store still lists as active but the chain has killed. `revoked`
  // and `consumed` are the user's own actions or a completed exit, so they are
  // facts to record, not pages. An EXPIRED permit is the one that matters: it
  // died of time passing, which nobody chose.
  for (const r of reconciled) {
    if (r.status !== "expired") continue;
    alerts.push({
      kind: target.atRisk ? "coverage.expired_at_risk" : "coverage.expired",
      severity: target.atRisk ? "critical" : "warning",
      key: `coverage.expired:${r.row.id}`,
      summary: target.atRisk
        ? `standing protection for ${wallet} expired and the position is at risk right now`
        : `standing protection for ${wallet} expired`,
      detail: {
        delegationId: r.row.id,
        deadline: new Date(Number(r.row.permit.deadline) * 1000).toISOString(),
        atRisk: target.atRisk,
      },
      wallet,
      userMessage:
        "Your standing exit protection has expired. Open Panik and grant it again to stay covered.",
      at,
    });
  }

  if (live.length === 0) {
    return { wallet, claimedActive: reconciled.length, live: 0, gaps, unknowns, alerts };
  }

  // ── EIP-7702: did the signer gain (or change) code since granting? ────────
  let liveCodeState: ReturnType<typeof codeStateFrom> | null = null;
  try {
    liveCodeState = codeStateFrom(await deps.chain.codeAt(wallet));
  } catch (err) {
    unknowns.push({ protocol: null, reason: `getCode failed: ${(err as Error).message}` });
    alerts.push(unverifiable(wallet, null, `the signer's on-chain code could not be read`, at, `code`));
  }

  if (liveCodeState) {
    for (const { row } of live) {
      const transition = codeTransition(
        { hadCode: row.signerHadCode, codeHash: row.signerCodeHash },
        liveCodeState,
      );
      if (transition === "none") continue;

      if (transition === "unknown_baseline") {
        unknowns.push({
          protocol: null,
          reason: "signer has code but the grant-time baseline was not recorded",
        });
        alerts.push(
          unverifiable(
            wallet,
            null,
            "the signer address has contract code and this permit predates the grant-time code " +
              "baseline, so whether the executor's ERC-1271 branch will accept it is unknown",
            at,
            `baseline:${row.id}`,
          ),
        );
        continue;
      }

      const gained = transition === "gained_code";
      gaps.push({
        kind: gained ? "signer_gained_code" : "signer_code_changed",
        protocol: null,
        detail: gained
          ? "signer address gained contract code after the permit was signed"
          : "signer's contract code changed after the permit was verified against it",
      });
      alerts.push({
        kind: gained ? "coverage.signer_gained_code" : "coverage.signer_code_changed",
        severity: "critical",
        key: `coverage.signer_code:${row.id}`,
        summary: gained
          ? `${wallet} installed contract code (EIP-7702 delegate or smart account) after signing ` +
            `its exit permit; the executor will verify through ERC-1271 and this permit was not ` +
            `checked against it`
          : `${wallet} changed the contract code its exit permit was verified against; the ` +
            `executor's ERC-1271 branch may now refuse it`,
        detail: {
          delegationId: row.id,
          grantHadCode: row.signerHadCode,
          grantCodeHash: row.signerCodeHash,
          liveCodeHash: liveCodeState.codeHash,
        },
        wallet,
        userMessage:
          "Your wallet now has contract code at its address, which changes how your exit " +
          "permission is verified. Open Panik and grant protection again so it stays valid.",
        at,
      });
    }
  }

  // ── Expiry escalation ─────────────────────────────────────────────────────
  for (const { row } of live) {
    const secondsLeft = Number(row.permit.deadline) - deps.nowSec;
    const rung = expiryRung(secondsLeft);
    if (!rung) continue;
    alerts.push({
      kind: "coverage.expiring",
      severity: EXPIRY_SEVERITY[rung.label] ?? "warning",
      // The rung is IN the key, so each threshold fires exactly once and an
      // ignored prompt escalates rather than repeating.
      key: `coverage.expiring:${row.id}:${rung.label}`,
      summary:
        `standing protection for ${wallet} expires in ${Math.round(secondsLeft / 3_600)}h ` +
        `(${rung.label} threshold)`,
      detail: {
        delegationId: row.id,
        threshold: rung.label,
        secondsLeft,
        deadline: new Date(Number(row.permit.deadline) * 1000).toISOString(),
      },
      wallet,
      userMessage:
        `Your standing exit protection expires in about ${Math.round(secondsLeft / 3_600)} hours. ` +
        `Open Panik to renew it.`,
      at,
    });
  }

  // ── Authorizations, per protocol the permits actually cover ───────────────
  const protocols = new Set(target.protocols);
  for (const protocol of protocols) {
    const covering = live.filter((r) => covers(r.row.permit, protocol));
    if (covering.length === 0) continue;
    try {
      await checkProtocol(protocol, wallet, covering.map((r) => r.row), deps, gaps, unknowns, alerts, target);
    } catch (err) {
      unknowns.push({ protocol, reason: (err as Error).message });
      alerts.push(
        unverifiable(wallet, protocol, `the authorization read failed: ${(err as Error).message}`, at, protocol),
      );
    }
  }

  return { wallet, claimedActive: reconciled.length, live: live.length, gaps, unknowns, alerts };
}

/** The "unknown, not fine" alert. One shape so it is always recognisable. */
function unverifiable(
  wallet: string,
  protocol: LiveProtocol | null,
  reason: string,
  at: number,
  keySuffix: string,
): MonitorAlert {
  return {
    kind: "coverage.unverifiable",
    severity: "warning",
    key: `coverage.unverifiable:${wallet}:${keySuffix}`,
    summary: `coverage for ${wallet}${protocol ? ` on ${protocol}` : ""} is UNVERIFIED: ${reason}`,
    detail: { protocol: protocol ?? null, reason: reason.slice(0, 300) },
    wallet,
    at,
  };
}

/** The gap alert. Severity is driven by whether the position is in trouble. */
function gapAlert(
  wallet: string,
  gap: CoverageGap,
  atRisk: boolean,
  at: number,
): MonitorAlert {
  return {
    kind: "coverage.gap",
    severity: atRisk ? "critical" : "warning",
    key: `coverage.gap:${wallet}:${gap.protocol ?? "-"}:${gap.kind}`,
    summary:
      `${wallet} has live exit protection that would NOT execute` +
      `${gap.protocol ? ` on ${gap.protocol}` : ""}: ${gap.detail}`,
    detail: { protocol: gap.protocol, gap: gap.kind, atRisk },
    wallet,
    userMessage:
      "Panik cannot execute your protected exit right now because a token approval it needs " +
      "is no longer in place. Open Panik and set up protection again to restore it.",
    at,
  };
}

async function checkProtocol(
  protocol: LiveProtocol,
  wallet: `0x${string}`,
  rows: readonly DelegationRow[],
  deps: SweepDeps,
  gaps: CoverageGap[],
  unknowns: CoverageUnknown[],
  alerts: MonitorAlert[],
  target: SweepTarget,
): Promise<void> {
  const push = (gap: CoverageGap) => {
    gaps.push(gap);
    alerts.push(gapAlert(wallet, gap, target.atRisk, deps.nowMs));
  };
  const cannot = (reason: string, keySuffix: string) => {
    unknowns.push({ protocol, reason });
    alerts.push(unverifiable(wallet, protocol, reason, deps.nowMs, keySuffix));
  };

  if (protocol === "aave_v3") {
    if (deps.markets.aaveReserves.length === 0) {
      cannot("no Aave reserves are configured for the sweep", "aave-reserves");
      return;
    }
    const states = await deps.chain.reserveStates(wallet);
    // The widest scope any live permit grants. Checking the narrowest would
    // report a gap for coverage the user never asked for.
    const maxBps = rows.reduce((m, r) => Math.max(m, r.permit.maxRepayFractionBps), 0);
    const wantsWithdraw = rows.some((r) => r.permit.kind === EXIT_KIND.FULL_EXIT);

    for (const state of states) {
      if (state.debt > 0n) {
        const needed = authorizedRepay(state.debt, maxBps);
        if (needed > 0n) {
          const allowance = await deps.chain.allowance(state.reserve, wallet, deps.executor);
          if (allowance < needed) {
            push({
              kind: "repay_allowance_missing",
              protocol,
              detail:
                `${state.symbol} allowance to the executor is ${allowance}, below the ${needed} ` +
                `the authorised repay would pull`,
            });
          }
        }
      }
      if (wantsWithdraw && state.aBalance > 0n) {
        const aToken = await deps.chain.aTokenFor(state.reserve);
        if (!aToken) {
          cannot(`the aToken for ${state.symbol} could not be resolved`, `atoken:${state.reserve}`);
          continue;
        }
        const allowance = await deps.chain.allowance(aToken, wallet, deps.executor);
        if (allowance < state.aBalance) {
          push({
            kind: "collateral_allowance_missing",
            protocol,
            detail:
              `a${state.symbol} allowance to the executor is ${allowance}, below the ` +
              `${state.aBalance} collateral balance a full exit would move`,
          });
        }
      }
    }
    return;
  }

  if (protocol === "compound_v3") {
    if (!deps.markets.compoundAdapter || deps.markets.comets.length === 0) {
      cannot(
        "no Comet markets / adapter are configured, so comet.allow could not be checked",
        "comet-config",
      );
      return;
    }
    for (const comet of deps.markets.comets) {
      const allowed = await deps.chain.cometAllowed(comet, wallet, deps.markets.compoundAdapter);
      if (!allowed) {
        push({
          kind: "comet_not_authorized",
          protocol,
          detail: `comet ${comet} has not authorized the exit adapter (comet.allow is false)`,
        });
      }
    }
    return;
  }

  if (protocol === "morpho") {
    if (!deps.markets.morpho || !deps.markets.morphoAdapter) {
      cannot(
        "the Morpho singleton / adapter is not configured, so setAuthorization could not be checked",
        "morpho-config",
      );
      return;
    }
    const authorized = await deps.chain.morphoAuthorized(
      deps.markets.morpho,
      wallet,
      deps.markets.morphoAdapter,
    );
    if (!authorized) {
      push({
        kind: "morpho_not_authorized",
        protocol,
        detail: "Morpho has not authorized the exit adapter (setAuthorization is false)",
      });
    }
    return;
  }

  if (protocol === "moonwell") {
    if (deps.markets.mTokens.length === 0) {
      cannot("no Moonwell mTokens are configured, so the allowance could not be checked", "mtoken-config");
      return;
    }
    for (const mToken of deps.markets.mTokens) {
      const allowance = await deps.chain.allowance(mToken, wallet, deps.executor);
      if (allowance === 0n) {
        push({
          kind: "collateral_allowance_missing",
          protocol,
          detail: `mToken ${mToken} allowance to the executor is zero`,
        });
      }
    }
  }
}

/** Sweep many wallets, isolating failures per wallet. */
export async function sweepCoverage(
  targets: readonly SweepTarget[],
  deps: SweepDeps,
): Promise<WalletCoverage[]> {
  const out: WalletCoverage[] = [];
  for (const target of targets) {
    try {
      out.push(await sweepWallet(target, deps));
    } catch (err) {
      out.push({
        wallet: target.wallet,
        claimedActive: 0,
        live: 0,
        gaps: [],
        unknowns: [{ protocol: null, reason: (err as Error).message }],
        alerts: [
          unverifiable(target.wallet, null, (err as Error).message, deps.nowMs, "sweep"),
        ],
      });
    }
  }
  return out;
}
