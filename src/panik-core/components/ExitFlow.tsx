/**
 * ExitFlow - the Atomic Exit / Reduce transaction modal (Phase 2).
 *
 * connect -> switch-chain -> load position -> review -> approvals -> simulate
 * -> execute -> receipt. Every transaction is simulated before signing; the
 * LockChecker pre-flight runs at load; gas comes from the successful
 * simulation (never a hardcoded limit).
 *
 * Testnet honesty gate: execution targets the wallet's REAL Base Sepolia
 * position (seed one via the demo docs) - the user's mainnet position is
 * never touched, and the banner says so. Mainnet cutover is a config flip.
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
  EXIT_ENV,
  EXIT_ERC20_ABI,
  exitExplorerTxUrl,
  getExitChain,
  isExitExecutable,
} from "../lib/exit";
import {
  AMOUNT_FULL,
  buildExitLegs,
  formatTokenAmount,
  swapAcquisitionNote,
  type ExitLegView,
  type ExitReserveState,
  type SwapConfigRead,
} from "../lib/exitLegs";
import {
  EXECUTOR_ABI,
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
  EXIT_USDC_ADDRESS,
  EXIT_WETH_ADDRESS,
  LOCK_CHECKER_ABI,
  LOCK_CHECKER_ADDRESS,
} from "../lib/exit.generated";
import { useExitApprovals, withAccrualBuffer, type ApprovalStep } from "../lib/useExitApprovals";

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

interface LoadedPosition {
  legs: ReturnType<typeof buildExitLegs>["legs"];
  views: ExitLegView[];
  approvals: ApprovalStep[];
  funding: FundingRow[];
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

  const executable = isExitExecutable(prefill.protocol);
  const [step, setStep] = useState<Step>(executable ? "connect" : "unavailable");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<LoadedPosition | null>(null);
  const [receipt, setReceipt] = useState<{ hash: string; usdcReceived: bigint } | null>(null);

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
    setError(null);
    try {
      const known: { reserve: `0x${string}`; symbol: string }[] = [
        { reserve: EXIT_USDC_ADDRESS, symbol: "USDC" },
        { reserve: EXIT_WETH_ADDRESS, symbol: "WETH" },
      ];

      // Decimals come from each token, never from the symbol: the repay is
      // denominated in the debt asset, and a WETH repay scaled by 10^6 is off
      // by twelve orders of magnitude.
      const reserves: ExitReserveState[] = [];
      for (const { reserve, symbol } of known) {
        const [aBal, stableDebt, varDebt] = (await client.readContract({
          address: EXIT_DATA_PROVIDER_ADDRESS,
          abi: EXIT_DATA_PROVIDER_ABI,
          functionName: "getUserReserveData",
          args: [reserve, address],
        })) as [bigint, bigint, bigint];
        const decimals = Number(
          await client.readContract({
            address: reserve,
            abi: EXIT_ERC20_ABI,
            functionName: "decimals",
          }),
        );
        reserves.push({
          reserve,
          symbol,
          decimals,
          aBalance: aBal,
          debt: stableDebt + varDebt,
        });
      }
      const usdcDecimals =
        reserves.find((r) => r.reserve === EXIT_USDC_ADDRESS)?.decimals ?? 6;

      const { legs, views, dust } = buildExitLegs(reserves, {
        protocol: prefill.protocol,
        kind: prefill.kind,
        repayFraction: prefill.repayFraction,
      });

      if (legs.length === 0) {
        setError(
          prefill.kind === "partial"
            ? dust.length > 0
              ? `The suggested reduction is too small to execute against your ${dust.join(" and ")} debt on the Base Sepolia demo position.`
              : "This wallet has no debt to reduce on the Base Sepolia demo position."
            : prefill.kind === "full_repay"
              ? "This wallet has no debt to repay on the Base Sepolia demo position."
              : "This wallet has no Aave position on Base Sepolia. Seed a demo position first (see docs).",
        );
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
        setError(`Position is currently locked by the protocol (${locked.join(", ")}). Try again later.`);
        setStep("error");
        return;
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
          funding.push({
            token: v.reserve,
            symbol: v.symbol,
            decimals: v.decimals,
            required: withAccrualBuffer(v.repayFunding),
            balance,
            swapConfig,
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

      setPosition({ legs, views, approvals, funding, usdcDecimals });
      setStep("review");
    } catch (err) {
      setError((err as Error).message.slice(0, 300));
      setStep("error");
    }
  }, [publicClient, address, prefill]);

  useEffect(() => {
    if (step === "loading") void loadPosition();
  }, [step, loadPosition]);

  const execute = useCallback(async () => {
    if (!publicClient || !address || !position) return;
    const client = asContractClient(publicClient);
    setStep("executing");
    setError(null);
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
      const message = (err as Error).message ?? String(err);
      setError(message.split("\n")[0]?.slice(0, 300) ?? "transaction failed");
      setStep("review");
    }
  }, [publicClient, address, position, ensureApprovals, writeContractAsync]);

  const copy = FLOW_COPY[prefill.kind];
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

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-lg bg-surface-sunken border border-border-subtle rounded-lg p-6 space-y-5 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-sans font-bold text-text-primary">{copy.title}</h2>
            {EXIT_ENV === "testnet" ? (
              <span className="px-2 py-0.5 rounded-sm border border-risk-elevated/40 bg-risk-elevated/10 text-risk-elevated text-2xs font-sans font-bold">
                TESTNET
              </span>
            ) : null}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {EXIT_ENV === "testnet" && step !== "unavailable" ? (
          <div className="rounded-md border border-risk-elevated/25 bg-risk-elevated/[0.06] p-3 text-xs text-risk-elevated/90 font-sans leading-relaxed">
            Execution runs on <b>Base Sepolia</b> against a demo position - your mainnet position
            is not touched. Mainnet execution ships after audit.
          </div>
        ) : null}

        {step === "unavailable" ? (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary font-sans leading-relaxed">
              {`${prefill.protocol.replace("_", " ")} exits are proven against Base mainnet in the
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

            {error ? (
              <div className="rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-sans break-words">
                {error}
              </div>
            ) : null}

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
            <div className="rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-sans break-words">
              {error}
            </div>
            <button
              onClick={() => setStep("loading")}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-sans text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Retry
            </button>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
