/**
 * ExitFlow - the Atomic Exit / Reduce transaction modal (Phase 2).
 *
 * connect -> switch-chain -> load position -> review -> approvals -> simulate
 * -> execute -> receipt. Every transaction is simulated before signing; the
 * LockChecker pre-flight runs at load; gas comes from the successful
 * simulation (never a hardcoded limit).
 *
 * Testnet honesty gate: execution targets the wallet's REAL Base Sepolia
 * position - the user's mainnet position is never touched, and the banner says
 * so. Nothing here creates a position: a wallet with none on Base Sepolia is
 * told that in plain words rather than shown a button that cannot work.
 * Mainnet cutover is a config flip.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, X } from "lucide-react";
import { parseEventLogs } from "viem";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { injected } from "wagmi/connectors";
import type { LiveProtocol } from "../lib/live";
import {
  asContractClient,
  EXIT_ERC20_ABI,
  EXIT_NETWORK_LABEL,
  exitExplorerTxUrl,
  getExitChain,
  isExitExecutable,
} from "../lib/exit";
import {
  CHAIN_MODE_LABEL,
  exitUnavailableLine,
  exitsExecutableOn,
  useChainMode,
} from "../lib/chainMode";
import { classifyExitError } from "../lib/exitRpc";
// `Notice` is aliased because this file already names a local shape `Notice`
// (the tone + message the flow raises); the primitive is the box that renders
// the `problem` half of it.
import { Button, Card, Chip, LAYER, Notice as ProblemNotice, SCRIM, Skeleton } from "../ui";
// `exitReserves` is shared with the relayer (server/relayerChain.ts) and the
// coverage sweep (server/coverageChain.ts); `exitPosition` is shared with the
// Settings pre-authorization card, which sizes its approvals from the same
// debt and deposit balances an exit would.
import { resolveATokens } from "../lib/exitReserves";
import { readUserReserves } from "../lib/exitPosition";
import {
  AMOUNT_FULL,
  approvalStepsFor,
  buildExitLegs,
  capRepayToWallet,
  formatTokenAmount,
  withAccrualBuffer,
  type ExitLegView,
  type SwapConfigRead,
  type WalletRepayCap,
} from "../lib/exitLegs";
import { liquidationOutlook, PROTOCOL_LABEL } from "../lib/utils";
import { fmtUsd } from "../../../packages/scoring/src/advisor/fallback";
import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  // `executor.usdc()`: the token the executor SWEEPS PROCEEDS IN. It is not a
  // reserve, and reading a user's Aave position against it is the bug
  // `exitReserves` exists to prevent. Used here only for the payout decimals.
  EXIT_USDC_ADDRESS,
  LOCK_CHECKER_ABI,
  LOCK_CHECKER_ADDRESS,
} from "../lib/exit.generated";
import { useExitApprovals, type ApprovalStep } from "../lib/useExitApprovals";
import { RevokeExitApprovals } from "./ExitApprovals";

export interface ExitPrefill {
  protocol: LiveProtocol;
  /**
   * Three different outcomes, and the user is told which one before signing:
   * `full` closes the position, `full_repay` clears the debt and leaves the
   * collateral deposited, `partial` repays the advisor's sized fraction.
   */
  kind: "full" | "partial" | "full_repay";
  /** Display only. Never converted back into a token amount. */
  repayUsd?: number;
  /**
   * Fraction of each debt leg to repay, from the advisor's `RepayPlan`. This is
   * what a partial exit is sized from: the dollar figure cannot be turned into
   * token units without a price, and the debt is not always USDC.
   */
  repayFraction?: number;
  /**
   * Engine readings this flow cannot make for itself. It reads the chain, so it
   * knows the debt in token units and nothing about the dollars, the health
   * factor, or the collateral those dollars are levered against. They are what
   * lets a repay CAPPED to the wallet balance say what protection it buys
   * instead of only how much smaller it got. Display only.
   */
  borrowUsd?: number | null;
  healthFactor?: number | null;
  collateralSymbol?: string;
}

/**
 * The three words that separate the three outcomes, and nothing else.
 *
 * `outcome` is gone. It was a sentence per kind stating what the user would be
 * left holding ("Debt repaid, collateral sold for USDC, position closed"), and
 * every clause of it is now a row in the ledger below, with the amount beside
 * it. A heading, a ledger and a button say it; a paragraph over them repeated
 * it in words with no figures.
 *
 * `full` and `full_repay` are still the pair worth being careful about: both
 * repay the entire debt, and only one also empties the position. The ledger
 * separates them, because only one of them carries a Withdraw row.
 */
const FLOW_COPY: Record<ExitPrefill["kind"], { title: string; cta: string; done: string }> = {
  full: {
    // "Atomic" was the contract's word, not the reader's. What the heading has
    // to separate is this outcome from the two below it, which the verb does.
    title: "Exit position",
    cta: "Approve & exit",
    done: "Position exited",
  },
  full_repay: {
    title: "Clear your debt",
    cta: "Approve & repay",
    done: "Debt cleared",
  },
  partial: {
    title: "Reduce position",
    cta: "Approve & reduce",
    done: "Position reduced",
  },
};

/**
 * The one sentence stating what the exit will do, shared by the connect step
 * (which has nothing else explaining the button) and the top of the review
 * step, so both read as the same modal.
 *
 * Built only from what the prefill already carries: the protocol and, when the
 * recommendation supplied one, the collateral symbol. Never a fetch, never a
 * figure - the ledger rows are what state the numbers.
 *
 * The `full` branch keeps the shape of the Advisor card's own line
 * (`AdvisorPanel.tsx`, `routesFor`'s EXIT lead: "Repays your debt from your
 * wallet, then sells your ${symbol} collateral for USDC.") rather than a
 * second, different sentence for the same outcome. `full_repay` and `partial`
 * both leave the collateral deposited, so they borrow "Your collateral stays
 * deposited" from the same card's REDUCE protection line instead of inventing
 * a third phrase for the same fact.
 */
function exitActionLine(
  kind: ExitPrefill["kind"],
  protocolLabel: string,
  collateralSymbol: string | undefined,
): string {
  if (kind === "full") {
    const collateral = collateralSymbol ? `${collateralSymbol} ` : "";
    return `Repays your debt on ${protocolLabel} from your wallet, then sells your ${collateral}collateral for USDC.`;
  }
  if (kind === "full_repay") {
    return `Repays your debt on ${protocolLabel} from your wallet. Your collateral stays deposited.`;
  }
  return `Repays part of your debt on ${protocolLabel} from your wallet. Your collateral stays deposited.`;
}

/**
 * One fact of the transaction: what it is on the left, the figure on the right.
 *
 * Composed here rather than taken from `ui/`, because `Stat` is a label above a
 * large figure and this is a ledger line - eight of them stacked as Stats would
 * be eight 28px numerals on the screen before a signature. The label stays in
 * Archivo rather than `label-type`: it carries a ticker (`cbBTC`), and
 * `label-type` uppercases.
 */
function LedgerRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3" title={title}>
      <span className="font-sans text-sm text-text-secondary">{label}</span>
      <span className="ml-auto font-mono text-sm font-bold tabular-nums text-text-primary">
        {value}
      </span>
    </div>
  );
}

type Step =
  | "connect"
  | "chain"
  | "loading"
  | "review"
  | "executing"
  | "done"
  | "unavailable"
  | "error";

/**
 * What the wallet must hold to fund one repay leg, in that debt asset's own
 * units. The old shape assumed a single USDC requirement; a WETH borrower then
 * saw a USDC number that had nothing to do with their position.
 */
interface FundingRow {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Repay + accrual buffer, in the debt asset's units. */
  required: bigint;
  balance: bigint;
  /** `getSwapConfig(token)`; null when the read failed. */
  swapConfig: SwapConfigRead | null;
}

/**
 * Something the user needs to read before they can go on.
 *
 * `tone` exists because two different things used to share one red box. A
 * transport failure or a revert is a problem. "This wallet holds nothing on the
 * test network" is a fact about the wallet, and painting a fact in the risk ramp
 * spends a hue this product reserves for risk indicators.
 */
interface Notice {
  tone: "problem" | "info";
  message: string;
}

interface LoadedPosition {
  legs: ReturnType<typeof buildExitLegs>["legs"];
  views: ExitLegView[];
  approvals: ApprovalStep[];
  funding: FundingRow[];
  /**
   * Set when the wallet could not fund the whole sized repay and the legs were
   * rebuilt smaller. Null on every other load, including a shortfall too deep
   * to cap. What is on screen is always what these legs execute.
   */
  cap: WalletRepayCap | null;
  /** For the receipt line only: the executor sweeps proceeds as USDC. */
  usdcDecimals: number;
}

export function ExitFlow({
  prefill,
  onClose,
  gasGwei,
}: {
  prefill: ExitPrefill;
  onClose: () => void;
  /**
   * The network gas reading, or null when the telemetry poll has not answered.
   *
   * PASSED IN rather than read here, because the poll already runs once in the
   * shell and a second subscription would be a second reading of one market
   * fact. It arrives at THIS component because this is the only surface in the
   * product where a gas price changes a decision: the review step is the last
   * screen before a signature, and what it costs to sign is part of what is
   * being decided. It used to sit in the app header, on every tab, beside a
   * wallet chip and an account menu, where it was a number nobody was deciding
   * anything with.
   *
   * Null renders no line at all. A gas figure the code does not have is not a
   * zero and not a placeholder.
   */
  gasGwei?: number | null;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: EXIT_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensureApprovals } = useExitApprovals(address);

  // Two independent gates, and they fail for different reasons, so the
  // `unavailable` step below has to tell them apart: the protocol may have no
  // deployment on the exit chain, or the user may be LOOKING at a chain the
  // executor is not deployed on at all. Sending someone to "Aave V3 works, try
  // that" when the real answer is "no exit works on Base yet" is the dead end
  // this switch exists to close.
  const chainMode = useChainMode();
  const chainExecutable = exitsExecutableOn(chainMode);
  const executable = chainExecutable && isExitExecutable(prefill.protocol);
  const [step, setStep] = useState<Step>(executable ? "connect" : "unavailable");
  const [status, setStatus] = useState<string>("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [position, setPosition] = useState<LoadedPosition | null>(null);
  const [receipt, setReceipt] = useState<{ hash: string; usdcReceived: bigint } | null>(null);

  /**
   * One signing sequence at a time.
   *
   * `step` is state, so it is stale for the rest of the frame in which it is
   * set: two clicks landing before React re-renders both see `step === "review"`,
   * both pass the button's `disabled` prop, and both run the approvals, the
   * simulation and `writeContractAsync`. That is two wallet prompts, and on a
   * wallet that confirms without asking, two `atomicExit` transactions against
   * the same position. A ref is written synchronously, so the second call sees
   * the first one's mark; `step` stays for rendering only.
   */
  const inFlightRef = useRef(false);

  /**
   * What this modal is CURRENTLY doing, which starts as what the advisor asked
   * for and can be narrowed once by the user (see `fallbackOffered`).
   *
   * State rather than a straight read of `prefill.kind`, because a full exit has
   * a part that can fail on its own. Repaying the debt and withdrawing the
   * collateral are one atomic transaction, but only the withdrawal has to
   * convert the collateral to USDC, and that conversion depends on a swap route
   * being liquid enough to fill at the executor's floor. When it is not, the
   * whole transaction reverts, including the repay that would have worked.
   *
   * The repay is the half that answers the danger: it is what moves the health
   * factor away from liquidation. Ending on "this network would not accept the
   * transaction" leaves the user in front of a position they could have made
   * safe, so the modal offers the half that still executes.
   */
  const [kind, setKind] = useState<ExitPrefill["kind"]>(prefill.kind);
  /**
   * Set the first time a full exit reverts, and never cleared.
   *
   * It is what keeps the `Repay the debt instead` button on screen after the
   * notice it came with has been replaced: press the primary again, get a
   * second revert, and the smaller plan is still there to take. What it does
   * NOT do is stop the offer reappearing after narrowing: `kind` becomes
   * `full_repay` and never goes back, so the `kind === "full"` guard below
   * already covers that on its own.
   *
   * Its one narrowing effect is on the sentence: appended to the first revert
   * and not to later ones, because the user has already read it and it is the
   * button underneath that carries the offer from then on.
   */
  const [fallbackOffered, setFallbackOffered] = useState(false);

  // Advance connect/chain steps automatically as their conditions are met.
  useEffect(() => {
    if (!executable || step === "done" || step === "executing" || step === "error") return;
    if (!isConnected) setStep("connect");
    else if (chainId !== EXIT_CHAIN_ID) setStep("chain");
    else if (step === "connect" || step === "chain") setStep("loading");
  }, [executable, isConnected, chainId, step]);

  const loadPosition = useCallback(async () => {
    if (!publicClient || !address) return;
    const client = asContractClient(publicClient);
    setNotice(null);
    try {
      // The position and the payout token's decimals, issued together so a
      // batching transport folds them into one request. The reserve reads live
      // in `lib/exitPosition` because the Settings pre-authorization card sizes
      // its approvals from the same debt and the same deposit balances.
      const [{ reserves, unreadable, noCoverage }, rawPayoutDecimals] = await Promise.all([
        readUserReserves(client, address),
        // The PAYOUT token's own decimals, read from the payout token. This used
        // to be `reserves.find(r => r.reserve === EXIT_USDC_ADDRESS)?.decimals
        // ?? 6` - a lookup that can no longer match, because the payout token is
        // deliberately not in the reserve set, and a fallback that would have
        // rendered the receipt in a guessed scale.
        client.readContract({
          address: EXIT_USDC_ADDRESS,
          abi: EXIT_ERC20_ABI,
          functionName: "decimals",
        }),
      ]);

      if (noCoverage) {
        setNotice({
          tone: "problem",
          message: `Nothing on ${EXIT_NETWORK_LABEL} can be exited right now.`,
        });
        setStep("error");
        return;
      }

      // Legs built from a partial view of the position would repay what could be
      // read and leave the rest, under a button that says the position is
      // closed. Refusing is the only honest option, and the sentence says whose
      // fault it is: this is the same for every wallet, so it is not the user's.
      if (unreadable.length > 0) {
        setNotice({
          tone: "problem",
          message: `Could not read this wallet's ${unreadable.join(" and ")} position. Nothing was sent.`,
        });
        setStep("error");
        return;
      }

      const usdcDecimals = Number(rawPayoutDecimals);

      const build = (repayFraction: number | undefined) =>
        buildExitLegs(reserves, {
          protocol: prefill.protocol,
          kind,
          repayFraction,
        });

      // A narrowed plan carries no fraction: `full_repay` clears the whole debt
      // by sentinel, and passing the original request's fraction here would size
      // it against a number the user is no longer being offered.
      let { legs, views, dust } = build(kind === prefill.kind ? prefill.repayFraction : undefined);

      if (legs.length === 0) {
        // Nothing failed here. The reads worked and the answer is that there is
        // nothing to act on, so this says so in the same register as the rest of
        // the modal instead of the developer note ("Seed a demo position first
        // (see docs)") that used to stand here pointing at docs that do not
        // exist.
        setNotice({
          tone: "info",
          message:
            kind === "partial"
              ? dust.length > 0
                ? `Reduction too small for this wallet's ${dust.join(" and ")} debt on ${EXIT_NETWORK_LABEL}.`
                : `No debt to reduce on ${EXIT_NETWORK_LABEL}.`
              : kind === "full_repay"
                ? `No debt to repay on ${EXIT_NETWORK_LABEL}.`
                : `No Aave V3 position on ${EXIT_NETWORK_LABEL}.`,
        });
        setStep("error");
        return;
      }

      // LockChecker pre-flight (protocol-side pauses / zero liquidity). It runs
      // before the funding reads, so a locked position costs no extra calls.
      const locked = (await client.readContract({
        address: LOCK_CHECKER_ADDRESS,
        abi: LOCK_CHECKER_ABI,
        functionName: "getLockedLegs",
        args: [address, legs],
      })) as `0x${string}`[];
      if (locked.length > 0) {
        // `locked` is a list of bytes32 protocol ids. It belongs in the console,
        // not on screen: a user cannot act on a hash, and the actionable part of
        // this is entirely in the sentence.
        console.info("[exit] legs locked by protocol", locked);
        setNotice({
          tone: "info",
          message: "The protocol has this position locked. Try again shortly.",
        });
        setStep("error");
        return;
      }

      // Wallet balances first, before the legs are final: a wallet-funded repay
      // is decided BY these numbers, and a repay the wallet cannot cover is
      // rebuilt smaller rather than simply refused.
      const wallet = new Map<
        `0x${string}`,
        { balance: bigint; swapConfig: SwapConfigRead | null }
      >();
      for (const v of views) {
        if (v.repayFunding <= 0n) continue;
        const [balance, swapConfig] = await Promise.all([
          client.readContract({
            address: v.reserve,
            abi: EXIT_ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
          // Display only: the deployed slippage floor for this asset, so a
          // user who has to go get the token knows what that will cost.
          // A failed read shows no figure rather than a made-up one.
          client
            .readContract({
              address: EXECUTOR_ADDRESS,
              abi: EXECUTOR_ABI,
              functionName: "getSwapConfig",
              args: [v.reserve],
            })
            .then((res) => {
              const [enabled, , minOutBps] = res as [boolean, `0x${string}`, number, boolean];
              return { enabled, minOutBps: Number(minOutBps) } satisfies SwapConfigRead;
            })
            .catch(() => null),
        ]);
        wallet.set(v.reserve, { balance, swapConfig });
      }

      // Cap a SIZED repay to what the wallet holds. A full exit and a full
      // repay are all-or-nothing by definition (both carry the AMOUNT_FULL
      // sentinel, and half a close is not a close), so only `partial` can be
      // cut down.
      let cap: WalletRepayCap | null = null;
      if (kind === "partial" && prefill.repayFraction !== undefined) {
        const candidate = capRepayToWallet({
          rows: views
            .filter((v) => v.repayFunding > 0n)
            .map((v) => ({ debt: v.debt, balance: wallet.get(v.reserve)?.balance ?? 0n })),
          requestedFraction: prefill.repayFraction,
          borrowUsd: prefill.borrowUsd ?? null,
          healthFactor: prefill.healthFactor ?? null,
        });
        if (candidate !== null) {
          const rebuilt = build(candidate.appliedFraction);
          // A smaller fraction can round a small leg out of the plan entirely,
          // and legs that no longer scale together no longer land the health
          // factor this cap is about to promise. Drop the cap in that case and
          // let the shortfall message stand: a wrong promise is worse than a
          // blocked button.
          if (rebuilt.legs.length === legs.length) {
            legs = rebuilt.legs;
            views = rebuilt.views;
            cap = candidate;
          }
        }
      }

      // The aTokens the withdrawal legs need, resolved here because only the
      // market can supply them, then handed to `approvalStepsFor` - the one
      // derivation of "which approvals, for how much", shared with the
      // pre-authorization card in Settings.
      const aTokens = await resolveATokens(client, views);
      const { steps: approvals, missing } = approvalStepsFor(views, EXECUTOR_ADDRESS, aTokens);
      if (missing.length > 0) {
        setNotice({
          tone: "problem",
          message: `Could not locate this wallet's ${missing.join(" and ")} deposit. Nothing was sent.`,
        });
        setStep("error");
        return;
      }

      const funding: FundingRow[] = [];
      for (const v of views) {
        if (v.repayFunding <= 0n) continue;
        const held = wallet.get(v.reserve);
        funding.push({
          token: v.reserve,
          symbol: v.symbol,
          decimals: v.decimals,
          required: withAccrualBuffer(v.repayFunding),
          balance: held?.balance ?? 0n,
          swapConfig: held?.swapConfig ?? null,
        });
      }

      setPosition({ legs, views, approvals, funding, cap, usdcDecimals });
      setStep("review");
    } catch (err) {
      // viem builds a transport error's `.message` out of the endpoint URL and
      // the full JSON-RPC request body, so the old `.message.slice(0, 300)` put
      // an https:// endpoint and a page of `aggregate3` calldata in front of the
      // user. The raw text goes to the console, where it is useful; the modal
      // gets a sentence.
      const failure = classifyExitError(err, EXIT_NETWORK_LABEL);
      console.error(`[exit] position load failed (${failure.kind}):`, failure.detail, err);
      setNotice({ tone: "problem", message: failure.message });
      setStep("error");
    }
    // `kind` is a dependency because narrowing a failed full exit to a repay
    // rebuilds the legs, the approvals and every amount on the review step.
  }, [publicClient, address, prefill, kind]);

  useEffect(() => {
    if (step === "loading") void loadPosition();
  }, [step, loadPosition]);

  const execute = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!publicClient || !address || !position) return;
    // Claimed here, released in `finally`. Nothing between this line and the
    // `try` awaits, so no second call can slip in behind it.
    inFlightRef.current = true;
    const client = asContractClient(publicClient);
    setStep("executing");
    setNotice(null);
    try {
      setStatus("Checking approvals...");
      await ensureApprovals(position.approvals, (label) => setStatus(`${label}...`));

      // Simulate the exit AFTER approvals so transferFrom paths are real; gas
      // comes from this simulation, never a hardcoded limit.
      setStatus("Simulating exit...");
      const { request } = await client.simulateContract({
        account: address,
        address: EXECUTOR_ADDRESS,
        abi: EXECUTOR_ABI,
        functionName: "atomicExit",
        args: [position.legs, []],
      });

      setStatus("Confirm the exit in your wallet...");
      const hash = await writeContractAsync(request as never);
      setStatus("Waiting for confirmation...");
      const txReceipt = await client.waitForTransactionReceipt({ hash });
      // viem resolves on a reverted tx too - the receipt status is the only
      // proof the exit actually executed.
      if (txReceipt.status !== "success") {
        throw new Error("Exit transaction reverted on-chain");
      }

      let usdcReceived = 0n;
      try {
        const events = parseEventLogs({
          abi: EXECUTOR_ABI,
          logs: txReceipt.logs as never,
          eventName: "ExitCompleted",
        });
        const args = (events[0] as { args?: { usdcReceived?: bigint } } | undefined)?.args;
        usdcReceived = args?.usdcReceived ?? 0n;
      } catch {
        /* event decode is cosmetic */
      }
      setReceipt({ hash, usdcReceived });
      setStep("done");
    } catch (err) {
      // Same rule as the loader, plus the two cases only signing can produce: a
      // wallet rejection reads as a dismissal rather than a failure, and a
      // revert is named as a revert so the user is not told to retry something
      // that will fail the same way every time.
      const failure = classifyExitError(err, EXIT_NETWORK_LABEL);
      console.error(`[exit] execution failed (${failure.kind}):`, failure.detail, err);
      // A reverted FULL exit is the one failure with a smaller plan behind it.
      // The message says what Panik can still do rather than only what the
      // network refused, and it does NOT name a cause: from here a revert is a
      // revert, and blaming the swap route would be a claim about a contract
      // this modal did not get to run.
      const canNarrow = failure.kind === "reverted" && kind === "full" && !fallbackOffered;
      if (canNarrow) setFallbackOffered(true);
      setNotice({
        tone: "problem",
        message: canNarrow
          ? `${failure.message} The debt can still be repaid in full.`
          : failure.message,
      });
      setStep("review");
    } finally {
      inFlightRef.current = false;
    }
  }, [publicClient, address, position, ensureApprovals, writeContractAsync, kind, fallbackOffered]);

  /**
   * Narrow a failed full exit to the repay half and reload from the chain.
   *
   * A reload rather than a reshape of the legs already in hand: debt accrues,
   * and the approvals, the funding rows and the amounts on screen all have to
   * describe the transaction that is about to be signed. The full exit's
   * approvals cover this one (its debt approval is the same token for the same
   * amount, plus the collateral approval it no longer needs), so nothing here
   * asks the user for a signature they have already given.
   */
  const narrowToRepay = useCallback(() => {
    setKind("full_repay");
    setNotice(null);
    setPosition(null);
    setStep("loading");
  }, []);

  const copy = FLOW_COPY[kind];
  // Wallet-funded: the executor pulls the debt asset from the user, so a
  // shortfall in ANY debt asset blocks the whole atomic transaction.
  const underfunded = (position?.funding ?? []).some((f) => f.balance < f.required);

  // The connect step's one sentence, and the same one repeated at the top of
  // the review step. `kind` (state), not `prefill.kind`, so a narrowed exit
  // reads "clears the debt" once the fallback has been taken.
  const actionLine = exitActionLine(kind, PROTOCOL_LABEL[prefill.protocol], prefill.collateralSymbol);

  // What the connect step can say before the chain has been read at all: only
  // the two facts the recommendation itself carried. Either can be absent (a
  // full-band EXIT prefill is only ever `{ protocol, kind }`), and an absent
  // one is a row that does not render, never a placeholder.
  const connectLedgerRows: { label: string; value: string }[] = [];
  if (prefill.borrowUsd !== undefined && prefill.borrowUsd !== null) {
    connectLedgerRows.push({ label: "Debt", value: fmtUsd(prefill.borrowUsd) });
  }
  if (prefill.collateralSymbol) {
    connectLedgerRows.push({ label: "Collateral", value: prefill.collateralSymbol });
  }

  /**
   * What a capped repay actually buys, as rows rather than as two sentences.
   *
   * Every number is still the engine's: the dollars come from
   * `repayUsdFromFraction` against the fraction that will execute, and the
   * outlook comes from `liquidationOutlook`, the one helper that turns a health
   * factor into the price drop it means. The component picks no rounding and
   * runs no arithmetic of its own, so these rows and the Advisor card that sent
   * the user here cannot state the same quantity two different ways.
   *
   * What went with the sentences is the "instead of X" comparison against the
   * repay that was asked for. The two dollar rows are that comparison, side by
   * side and in mono, which is what a reader is doing with them anyway.
   *
   * Null entirely when the leg was unpriced: a repay whose dollars the engine
   * never established is stated as a token amount by the legs above, and
   * inventing "$0 of $0 suggested" is the exact failure this product bans.
   */
  const cap = position?.cap ?? null;
  const capRows =
    cap === null ||
    cap.appliedRepayUsd === null ||
    cap.appliedHf === null ||
    cap.requestedHf === null ||
    prefill.repayUsd === undefined ||
    prefill.collateralSymbol === undefined
      ? null
      : (() => {
          const applied = liquidationOutlook(cap.appliedHf, prefill.collateralSymbol);
          return [
            { label: "Your wallet covers", value: fmtUsd(cap.appliedRepayUsd) },
            { label: "Suggested repay", value: fmtUsd(prefill.repayUsd) },
            { label: applied.statLabel, value: applied.statValue, title: applied.hover },
          ];
        })();

  /**
   * One box, both places it is shown, so the review step and the terminal error
   * step cannot drift into styling the same sentence two different ways.
   *
   * The `problem` half used to be a red tint. It is the hatched `ui/Notice` now:
   * a transport failure or a revert is a thing that did not work, which is what
   * that primitive states everywhere else in the product, and painting it from
   * the risk ramp spent one of this screen's two risk-hued elements on a
   * sentence about the network rather than on the position.
   */
  const noticeBox = notice ? (
    notice.tone === "problem" ? (
      <ProblemNotice text={notice.message} />
    ) : (
      <p className="font-sans text-sm leading-relaxed text-text-secondary">{notice.message}</p>
    )
  ) : null;

  return (
    <div className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4`}>
      {/* The app's one scrim, from `ui/overlay`. This was `bg-black/70`, one of
          four hand-typed dims that between them used two blacks and three
          blurs, so which one you got depended on which button you pressed. */}
      <div className={`absolute inset-0 ${SCRIM}`} onClick={onClose} />
      <div className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto hard-edge shadow-hard bg-surface-raised">
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-3 border-b-[3px] border-solid border-border-strong pb-4">
            <h2 className="min-w-0 font-sans text-lg font-black uppercase tracking-tight text-text-primary">
              {copy.title}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              {/* The whole environment statement. It was a paragraph under the
                  heading as well ("Runs on Base Sepolia, against what this
                  wallet holds there. Your Base position is not touched."), which
                  is this chip in twenty words: naming the test chain is already
                  saying the other one is untouched.

                  Follows the SWITCH, not the build, so it asserts the chain the
                  reader chose rather than a property of the bundle. */}
              {chainMode === "testnet" ? <Chip>{CHAIN_MODE_LABEL.testnet}</Chip> : null}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="cursor-pointer text-text-secondary hover:text-text-primary"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {step === "unavailable" ? (
            <div className="space-y-4">
              <p className="font-sans text-sm leading-relaxed text-text-secondary">
                {!chainExecutable
                  ? exitUnavailableLine(chainMode)
                  : `${PROTOCOL_LABEL[prefill.protocol]} exits ship with the mainnet release. The Aave V3 exit works today.`}
              </p>
              <Button variant="secondary" className="w-full" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : null}

          {step === "connect" ? (
            <div className="space-y-4">
              <p className="font-sans text-sm leading-relaxed text-text-secondary">{actionLine}</p>
              {connectLedgerRows.length > 0 ? (
                <Card tone="set-back" className="space-y-2">
                  {connectLedgerRows.map((row) => (
                    <LedgerRow key={row.label} label={row.label} value={row.value} />
                  ))}
                </Card>
              ) : null}
              <Button className="w-full" onClick={() => connect({ connector: injected() })}>
                Connect wallet
              </Button>
            </div>
          ) : null}

          {step === "chain" ? (
            <Button
              className="w-full"
              onClick={() => void switchChainAsync({ chainId: EXIT_CHAIN_ID })}
            >
              Switch to {getExitChain().name}
            </Button>
          ) : null}

          {/* Hatched blocks in the shape of what is arriving, not a spinner:
              this look has no motion, and a reserved layout is what stops the
              modal jumping when the reads land. */}
          {step === "loading" ? (
            <div aria-busy="true" className="space-y-2">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : null}

          {(step === "review" || step === "executing") && position ? (
            <div className="space-y-4">
              {/* Same sentence as the connect step, so a reader who lands
                  directly on review (wallet already connected) still gets it. */}
              <p className="font-sans text-sm leading-relaxed text-text-secondary">{actionLine}</p>
              {/* ONE ledger, and it is the whole review step. Every figure this
                  transaction carries is a row in it: what a capped repay covers
                  against what was asked for, the legs, what the wallet must
                  fund them with, and what signing costs.

                  What it replaces: an outcome sentence per kind, a two-sentence
                  cap notice, a red funding strip that restated a balance the
                  ledger already had, a swap-route note and a footnote about
                  approvals. Six blocks of prose sitting over the numbers they
                  were describing. */}
              <Card tone="set-back" className="space-y-2">
                {capRows?.map((row) => (
                  <LedgerRow key={row.label} label={row.label} value={row.value} title={row.title} />
                ))}
                {position.views.map((v) => (
                  <React.Fragment key={v.reserve}>
                    {v.repay > 0n ? (
                      <LedgerRow
                        label={`Repay ${v.symbol}`}
                        value={formatTokenAmount(v.repayFunding, v.decimals)}
                      />
                    ) : null}
                    {v.withdraw > 0n ? (
                      <LedgerRow
                        label={`Withdraw ${v.symbol}`}
                        value={formatTokenAmount(
                          v.withdraw === AMOUNT_FULL ? v.aBalance : v.withdraw,
                          v.decimals,
                        )}
                      />
                    ) : null}
                  </React.Fragment>
                ))}
                {/* The wallet-funded repay, as the two figures a reader
                    compares. A shortfall in any debt asset blocks the whole
                    atomic transaction, and it is these two rows plus the dead
                    button that say so. `swapAcquisitionNote`'s advice on where
                    to go and get the token was a paragraph, and paragraphs are
                    what this pass removes. */}
                {position.funding.map((f) => (
                  <React.Fragment key={f.token}>
                    <LedgerRow
                      label={`${f.symbol} needed`}
                      value={formatTokenAmount(f.required, f.decimals)}
                    />
                    <LedgerRow
                      label={`${f.symbol} in your wallet`}
                      value={formatTokenAmount(f.balance, f.decimals)}
                    />
                  </React.Fragment>
                ))}
                {/* The gas reading, on the one screen where what it costs to
                    sign is part of the decision. Absent until the telemetry
                    poll answers: a gas figure the code does not have is not a
                    zero and not a placeholder. */}
                {gasGwei !== null && gasGwei !== undefined ? (
                  <LedgerRow label="Network gas" value={`${gasGwei.toFixed(2)} gwei`} />
                ) : null}
              </Card>

              {noticeBox}

              <Button
                size="lg"
                className="w-full"
                onClick={() => void execute()}
                disabled={step === "executing" || underfunded}
              >
                {step === "executing" ? (
                  status
                ) : (
                  <>
                    {copy.cta}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </Button>

              {/* The smaller plan, offered only after the larger one has
                  actually failed. It sits BELOW the primary and stays
                  secondary: the user came here to close the position, and this
                  is the consolation, not a second equal answer. It disappears
                  once taken, because `kind` is then already `full_repay`. */}
              {fallbackOffered && kind === "full" ? (
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={narrowToRepay}
                  disabled={step === "executing"}
                >
                  Repay the debt instead
                </Button>
              ) : null}
            </div>
          ) : null}

          {step === "done" && receipt ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {/* Black, not the LOW band. A transaction that landed is good
                    news about a transaction; the risk ramp is what a POSITION
                    is in, and spending green here makes a claim about the
                    wallet that this modal has not measured. */}
                <CheckCircle2 className="h-6 w-6 shrink-0 text-text-primary" aria-hidden="true" />
                <h3 className="font-sans text-lg font-black uppercase tracking-tight text-text-primary">
                  {copy.done}
                </h3>
              </div>
              {receipt.usdcReceived > 0n && position ? (
                <Card tone="set-back">
                  <LedgerRow
                    label="USDC received"
                    value={formatTokenAmount(receipt.usdcReceived, position.usdcDecimals)}
                  />
                </Card>
              ) : null}
              <a
                href={exitExplorerTxUrl(receipt.hash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-sans text-xs text-text-primary"
              >
                View on Basescan <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              {/* The way back out, offered where the user actually is. An exit
                  leaves live token approvals behind it, and Settings is two
                  clicks and a tab away from a modal somebody is about to close.
                  It reads its own allowances first, so it renders nothing when
                  there is nothing left standing. */}
              {position ? <RevokeExitApprovals approvals={position.approvals} /> : null}
              <Button variant="secondary" className="w-full" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : null}

          {step === "error" ? (
            <div className="space-y-4">
              {noticeBox}
              <Button variant="secondary" className="w-full" onClick={() => setStep("loading")}>
                {notice?.tone === "info" ? "Check again" : "Retry"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
