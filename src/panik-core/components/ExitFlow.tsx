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

import React, { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
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
  EXIT_DATA_PROVIDER_ABI,
  EXIT_ERC20_ABI,
  EXIT_NETWORK_LABEL,
  exitExplorerTxUrl,
  getExitChain,
  isExitExecutable,
} from "../lib/exit";
import {
  CHAIN_MODE_LABEL,
  exitAvailabilityLine,
  exitsExecutableOn,
  useChainMode,
} from "../lib/chainMode";
import { classifyExitError } from "../lib/exitRpc";
import { LAYER, SCRIM } from "../ui";
// Shared with the relayer (server/relayerChain.ts) and the coverage sweep
// (server/coverageChain.ts). One resolution, cached per deployment; see the
// module header for why the reads live there rather than here.
import { loadExitReserveSet } from "../lib/exitReserves";
import {
  AMOUNT_FULL,
  buildExitLegs,
  capRepayToWallet,
  formatTokenAmount,
  swapAcquisitionNote,
  withAccrualBuffer,
  type ExitLegView,
  type ExitReserveState,
  type SwapConfigRead,
  type WalletRepayCap,
} from "../lib/exitLegs";
import { liquidationOutlook } from "../lib/utils";
import { fmtUsd } from "../../../packages/scoring/src/advisor/fallback";
import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
  // `executor.usdc()`: the token the executor SWEEPS PROCEEDS IN. It is not a
  // reserve, and reading a user's Aave position against it is the bug
  // `exitReserves` exists to prevent. Used here only for the payout decimals.
  EXIT_USDC_ADDRESS,
  LOCK_CHECKER_ABI,
  LOCK_CHECKER_ADDRESS,
} from "../lib/exit.generated";
import { useExitApprovals, type ApprovalStep } from "../lib/useExitApprovals";

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
 * What each outcome leaves the user holding, in the words they read before they
 * sign, plus the labels that have to agree with it.
 *
 * `full` and `full_repay` are the pair worth being careful about: both repay
 * the entire debt, and only one of them also empties the position. That
 * difference used to live in a button label alone, which is not where a user
 * checks what they are about to do. `outcome` states the result first, in
 * plain language, and it sits above the amounts on the review step.
 */
const FLOW_COPY: Record<
  ExitPrefill["kind"],
  { title: string; cta: string; done: string; outcome: string }
> = {
  full: {
    title: "Atomic Exit",
    cta: "Approve & exit",
    done: "Position exited",
    outcome:
      "Your debt is repaid, your collateral is withdrawn and converted to USDC, and the position is closed.",
  },
  full_repay: {
    title: "Clear Your Debt",
    cta: "Approve & repay",
    done: "Debt cleared",
    outcome:
      "Your debt is cleared, your collateral stays deposited, and the position stays open with nothing left to liquidate.",
  },
  partial: {
    title: "Reduce Position",
    cta: "Approve & reduce",
    done: "Position reduced",
    outcome:
      "Part of your debt is repaid, your collateral stays deposited, and the position stays open.",
  },
};

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

export function ExitFlow({ prefill, onClose }: { prefill: ExitPrefill; onClose: () => void }) {
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
   * notice it came with has been replaced — press the primary again, get a
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
      // Which assets this exit may name, from the chain rather than a hardcoded
      // pair. The old `[EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS]` named the payout
      // token as a reserve, and Aave does not list it, so the very first read
      // reverted for every wallet.
      const known = await loadExitReserveSet(client);
      if (known.length === 0) {
        setNotice({
          tone: "problem",
          message: `No asset on ${EXIT_NETWORK_LABEL} is both listed by Aave V3 and enabled for exits right now, so there is nothing this can act on. This is a problem on our side, not with your wallet.`,
        });
        setStep("error");
        return;
      }

      // Reserves the configured market will not answer for. Tracked apart from
      // a transport failure on purpose: "this asset is not in this market" is a
      // fact about the deployment and "we cannot reach the chain" is a fact
      // about the connection, and telling a user one when it is the other sends
      // them to retry something that cannot start working.
      const unreadable: string[] = [];

      // Every read below is issued in one tick rather than awaited in sequence.
      // They have no dependency on each other, and one at a time meant one round
      // trip each against a rate-limited public node; together, wagmi's
      // Multicall3 batching folds them into a single request. `Promise.all`
      // preserves `known`'s order.
      //
      // Decimals come from each token, never from the symbol: the repay is
      // denominated in the debt asset, and a WETH repay scaled by 10^6 is off
      // by twelve orders of magnitude.
      const [readings, rawPayoutDecimals] = await Promise.all([
        Promise.all(
          known.map(async ({ reserve, symbol }): Promise<ExitReserveState | null> => {
            try {
              const [userReserve, rawDecimals] = await Promise.all([
                client.readContract({
                  address: EXIT_DATA_PROVIDER_ADDRESS,
                  abi: EXIT_DATA_PROVIDER_ABI,
                  functionName: "getUserReserveData",
                  args: [reserve, address],
                }) as Promise<[bigint, bigint, bigint]>,
                client.readContract({
                  address: reserve,
                  abi: EXIT_ERC20_ABI,
                  functionName: "decimals",
                }),
              ]);
              const [aBal, stableDebt, varDebt] = userReserve;
              return {
                reserve,
                symbol,
                // uint8 token metadata, not a wei amount - the one place
                // `Number` is safe on a chain read in this file.
                decimals: Number(rawDecimals),
                aBalance: aBal,
                debt: stableDebt + varDebt,
              };
            } catch (err) {
              const failure = classifyExitError(err, EXIT_NETWORK_LABEL);
              // A transport failure says nothing about this particular reserve -
              // every read is failing. Let it out so the outer catch reports the
              // connection, rather than blaming the asset.
              if (failure.kind === "network") throw err;
              console.error(
                `[exit] reserve ${symbol} (${reserve}) is unreadable on ${EXIT_NETWORK_LABEL}:`,
                failure.detail,
              );
              unreadable.push(symbol);
              return null;
            }
          }),
        ),
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
      const reserves = readings.filter((r): r is ExitReserveState => r !== null);

      // Legs built from a partial view of the position would repay what could be
      // read and leave the rest, under a button that says the position is
      // closed. Refusing is the only honest option, and the sentence says whose
      // fault it is: this is the same for every wallet, so it is not the user's.
      if (unreadable.length > 0) {
        setNotice({
          tone: "problem",
          message: `We cannot read this wallet's ${unreadable.join(" and ")} position on ${EXIT_NETWORK_LABEL} right now, so we cannot promise a complete exit and nothing has been sent. This is a problem on our side, not with your wallet.`,
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
                ? `The suggested reduction is too small to execute against this wallet's ${dust.join(" and ")} debt on ${EXIT_NETWORK_LABEL}.`
                : `This wallet has no debt to reduce on ${EXIT_NETWORK_LABEL}.`
              : kind === "full_repay"
                ? `This wallet has no debt to repay on ${EXIT_NETWORK_LABEL}.`
                : `This wallet has no Aave V3 position on ${EXIT_NETWORK_LABEL}, so there is nothing here to exit. Execution runs against what this wallet actually holds on the test network, and it holds nothing there yet. To try it, open a small Aave V3 borrow on ${EXIT_NETWORK_LABEL} with this wallet first.`,
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
          message:
            "This position cannot be exited right now because the protocol has it locked. Try again in a little while.",
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

      const approvals: ApprovalStep[] = [];
      const funding: FundingRow[] = [];
      for (const v of views) {
        if (v.repayFunding > 0n) {
          approvals.push({
            token: v.reserve,
            spender: EXECUTOR_ADDRESS,
            amount: v.repayFunding,
            label: `Approve ${v.symbol} for debt repayment`,
          });
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
        if (v.withdraw > 0n) {
          const [aToken] = (await client.readContract({
            address: EXIT_DATA_PROVIDER_ADDRESS,
            abi: EXIT_DATA_PROVIDER_ABI,
            functionName: "getReserveTokensAddresses",
            args: [v.reserve],
          })) as [`0x${string}`];
          approvals.push({
            token: aToken,
            spender: EXECUTOR_ADDRESS,
            amount: v.aBalance,
            label: `Approve a${v.symbol} collateral transfer`,
          });
        }
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
    if (!publicClient || !address || !position) return;
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
          ? `${failure.message} Panik can still repay the debt in full and leave your collateral deposited, which is the part that moves you away from liquidation.`
          : failure.message,
      });
      setStep("review");
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
  const shortfallNotes = (position?.funding ?? [])
    .map((f) =>
      swapAcquisitionNote({
        symbol: f.symbol,
        decimals: f.decimals,
        shortfall: f.required - f.balance,
        config: f.swapConfig,
      }),
    )
    .filter((note): note is string => note !== null);

  /**
   * What a capped repay actually buys, in two sentences.
   *
   * Every number in them is the engine's: the dollars come from
   * `repayUsdFromFraction` against the fraction that will execute, and both
   * outlooks come from `liquidationOutlook`, the one helper that turns a health
   * factor into the price drop it means. The component picks no rounding and
   * runs no arithmetic of its own, so this line and the Advisor card that sent
   * the user here cannot state the same quantity two different ways.
   *
   * Skipped entirely when the leg was unpriced: a repay whose dollars the
   * engine never established is stated as a token amount by the rows above, and
   * inventing "$0 of $0 suggested" is the exact failure this product bans.
   */
  const cap = position?.cap ?? null;
  const capNotice =
    cap === null ||
    cap.appliedRepayUsd === null ||
    cap.appliedHf === null ||
    cap.requestedHf === null ||
    prefill.repayUsd === undefined ||
    prefill.collateralSymbol === undefined
      ? null
      : {
          amounts: `Your wallet covers ${fmtUsd(cap.appliedRepayUsd)} of the ${fmtUsd(prefill.repayUsd)} suggested repay, so that is what this will repay.`,
          outcome: `${liquidationOutlook(cap.appliedHf, prefill.collateralSymbol).sentence} after it, instead of ${liquidationOutlook(cap.requestedHf, prefill.collateralSymbol).strip}.`,
        };

  // One box, both places it is shown, so the review step and the terminal error
  // step cannot drift into styling the same sentence two different ways.
  const noticeBox = notice ? (
    <div
      className={
        notice.tone === "problem"
          ? "rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-sans leading-relaxed"
          : "rounded-md border border-border-subtle bg-white/[0.02] p-3 text-xs text-text-secondary font-sans leading-relaxed"
      }
    >
      {notice.message}
    </div>
  ) : null;

  return (
    <div className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4`}>
      {/* The app's one scrim, from `ui/overlay`. This was `bg-black/70`, one of
          four hand-typed dims that between them used two blacks and three
          blurs, so which one you got depended on which button you pressed. */}
      <div className={`absolute inset-0 ${SCRIM}`} onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-lg bg-surface-sunken border border-border-subtle rounded-lg p-6 space-y-5 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-sans font-bold text-text-primary">{copy.title}</h2>
            {/* Follows the SWITCH, not the build: what the badge asserts is
                that the chain you are looking at is a test network, and that is
                now the user's choice rather than a property of the bundle. */}
            {chainMode === "testnet" ? (
              <span className="px-2 py-0.5 rounded-sm border border-risk-elevated/40 bg-risk-elevated/10 text-risk-elevated text-2xs font-sans font-bold">
                TESTNET
              </span>
            ) : null}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {chainMode === "testnet" && step !== "unavailable" ? (
          <div className="rounded-md border border-risk-elevated/25 bg-risk-elevated/[0.06] p-3 text-xs text-risk-elevated/90 font-sans leading-relaxed">
            {/* "against a demo position" used to stand here, which told every
                reader that a position had been prepared for them. Nothing in
                this app creates one, and the founder's fresh wallet held
                nothing. What is true is the chain the transaction lands on and
                the position it cannot touch. */}
            Execution runs on <b>{CHAIN_MODE_LABEL.testnet}</b>, against whatever this wallet holds
            there. Your {CHAIN_MODE_LABEL.mainnet} position is not touched.{" "}
            {CHAIN_MODE_LABEL.mainnet} execution ships after the audit.
          </div>
        ) : null}

        {step === "unavailable" ? (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary font-sans leading-relaxed">
              {!chainExecutable
                ? exitAvailabilityLine(chainMode)
                : `${prefill.protocol.replace("_", " ")} exits are proven against Base mainnet in the
              executor's fork suite, but this protocol has no Base Sepolia demo deployment - it
              unlocks with the mainnet release. The Aave V3 demo exit is available today.`}
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-sans text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Close
            </button>
          </div>
        ) : null}

        {step === "connect" ? (
          <button
            onClick={() => connect({ connector: injected() })}
            className="w-full py-3 rounded-md bg-white/10 border border-border-subtle text-text-primary font-sans font-bold text-sm hover:bg-white/15 transition-colors"
          >
            Connect wallet
          </button>
        ) : null}

        {step === "chain" ? (
          <button
            onClick={() => void switchChainAsync({ chainId: EXIT_CHAIN_ID })}
            className="w-full py-3 rounded-md bg-white/10 border border-border-subtle text-text-primary font-sans font-bold text-sm hover:bg-white/15 transition-colors"
          >
            Switch to {getExitChain().name}
          </button>
        ) : null}

        {step === "loading" ? (
          <div className="flex items-center gap-3 text-sm text-text-secondary font-sans py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading position + running pre-flight...
          </div>
        ) : null}

        {(step === "review" || step === "executing") && position ? (
          <div className="space-y-4">
            {/* The outcome, before the amounts: what you still own after this
                transaction is the thing the amounts do not tell you. */}
            <p className="text-sm font-sans leading-relaxed text-text-secondary">{copy.outcome}</p>

            {/* The cap, above the amounts it explains. Neutral ink and a plain
                inset: a repay that had to be trimmed is a fact about the
                wallet, not a risk band, and painting it would spend a hue the
                Advisor card that sent the user here already spends on the
                dial. */}
            {capNotice ? (
              <div className="rounded-md border border-border-subtle bg-white/[0.02] p-3 space-y-1">
                <p className="text-sm font-sans leading-relaxed text-text-primary">
                  {capNotice.amounts}
                </p>
                <p className="text-xs font-sans leading-relaxed text-text-secondary">
                  {capNotice.outcome}
                </p>
              </div>
            ) : null}

            <div className="space-y-2">
              {position.views.map((v) => (
                <div
                  key={v.reserve}
                  className="rounded-md border border-border-subtle bg-white/[0.02] p-3 flex items-center justify-between text-sm"
                >
                  <span className="font-sans text-text-primary">{v.symbol}</span>
                  <span className="font-sans text-xs tabular-nums text-text-secondary text-right">
                    {v.repay > 0n
                      ? `repay ${formatTokenAmount(v.repayFunding, v.decimals)} ${v.symbol}`
                      : ""}
                    {v.repay > 0n && v.withdraw > 0n ? " · " : ""}
                    {v.withdraw > 0n
                      ? `withdraw ${formatTokenAmount(v.withdraw === AMOUNT_FULL ? v.aBalance : v.withdraw, v.decimals)} ${v.symbol}`
                      : ""}
                  </span>
                </div>
              ))}
            </div>

            {position.funding.length > 0 ? (
              // ONE risk-hued element, whatever the debt asset count: the tint
              // lives on this wrapper and the individual shortfalls are marked
              // by an icon and words, never by colour alone (SC 1.4.1).
              <div
                className={`text-xs font-sans space-y-1.5 ${
                  underfunded ? "text-risk-critical" : "text-text-muted"
                }`}
              >
                {position.funding.map((f) => (
                  <div key={f.token} className="flex items-start gap-2">
                    {f.balance < f.required ? (
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    ) : null}
                    <span className="tabular-nums">
                      Wallet-funded repay: needs ~{formatTokenAmount(f.required, f.decimals)}{" "}
                      {f.symbol} (you have {formatTokenAmount(f.balance, f.decimals)})
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {shortfallNotes.length > 0 ? (
              <div className="text-2xs font-sans text-text-muted leading-relaxed space-y-1">
                {shortfallNotes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            ) : null}

            {noticeBox}

            <button
              onClick={() => void execute()}
              disabled={step === "executing" || underfunded}
              className="w-full py-3 rounded-md bg-text-primary text-black font-sans font-bold text-sm hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {step === "executing" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {status}
                </>
              ) : (
                <>
                  {copy.cta}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            {/* The smaller plan, offered only after the larger one has actually
                failed. It sits BELOW the primary and stays `quiet`: the user
                came here to close the position, and this is the consolation, not
                a second equal answer. It disappears once taken, because `kind`
                is then already `full_repay`. */}
            {fallbackOffered && kind === "full" ? (
              <button
                onClick={narrowToRepay}
                disabled={step === "executing"}
                className="w-full py-2.5 rounded-md border border-border-subtle bg-transparent text-text-secondary font-sans font-bold text-xs hover:text-text-primary hover:bg-white/[0.04] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                Repay the debt instead
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : null}

            <p className="text-2xs font-sans text-text-muted text-center">
              Approvals are exact-amount (+2% accrual buffer). Every transaction is simulated
              before you sign it.
            </p>
          </div>
        ) : null}

        {step === "done" && receipt ? (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="w-10 h-10 text-risk-low mx-auto" />
            <div>
              <p className="text-text-primary font-sans font-bold">{copy.done}</p>
              {receipt.usdcReceived > 0n && position ? (
                <p className="text-sm text-text-secondary font-sans tabular-nums mt-1">
                  {formatTokenAmount(receipt.usdcReceived, position.usdcDecimals)} USDC swept to
                  your wallet
                </p>
              ) : null}
            </div>
            <a
              href={exitExplorerTxUrl(receipt.hash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-sans text-text-primary hover:underline"
            >
              View on Basescan <ExternalLink className="w-3 h-3" />
            </a>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-sans text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Done
            </button>
          </div>
        ) : null}

        {step === "error" ? (
          <div className="space-y-4">
            {noticeBox}
            <button
              onClick={() => setStep("loading")}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-sans text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              {notice?.tone === "info" ? "Check again" : "Retry"}
            </button>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
