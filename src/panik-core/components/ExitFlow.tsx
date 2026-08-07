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
  AMOUNT_FULL,
  asContractClient,
  EXIT_DATA_PROVIDER_ABI,
  EXIT_ENV,
  EXIT_ERC20_ABI,
  PROTOCOL_ID,
  exitExplorerTxUrl,
  getExitChain,
  isExitExecutable,
  type ExitLegInput,
} from "../lib/exit";
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
  kind: "full" | "partial";
  repayUsd?: number;
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

interface LegView {
  reserve: `0x${string}`;
  symbol: string;
  repay: bigint;
  withdraw: bigint;
  debt: bigint;
  aBalance: bigint;
  decimals: number;
}

interface LoadedPosition {
  legs: ExitLegInput[];
  views: LegView[];
  approvals: ApprovalStep[];
  requiredUsdc: bigint;
  usdcBalance: bigint;
  usdcDecimals: number;
}

const fmtUnits = (v: bigint, decimals: number, dp = 2): string => {
  const s = Number(v) / 10 ** decimals;
  return s.toLocaleString("en-US", { maximumFractionDigits: dp });
};

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
      const reserves: { reserve: `0x${string}`; symbol: string }[] = [
        { reserve: EXIT_USDC_ADDRESS, symbol: "USDC" },
        { reserve: EXIT_WETH_ADDRESS, symbol: "WETH" },
      ];

      const usdcDecimals = Number(
        await client.readContract({
          address: EXIT_USDC_ADDRESS,
          abi: EXIT_ERC20_ABI,
          functionName: "decimals",
        }),
      );

      const views: LegView[] = [];
      const legs: ExitLegInput[] = [];
      const approvals: ApprovalStep[] = [];
      let requiredUsdc = 0n;

      for (const { reserve, symbol } of reserves) {
        const [aBal, stableDebt, varDebt] = (await client.readContract({
          address: EXIT_DATA_PROVIDER_ADDRESS,
          abi: EXIT_DATA_PROVIDER_ABI,
          functionName: "getUserReserveData",
          args: [reserve, address],
        })) as [bigint, bigint, bigint];
        const debt = stableDebt + varDebt;
        const decimals =
          symbol === "USDC"
            ? usdcDecimals
            : Number(
                await client.readContract({
                  address: reserve,
                  abi: EXIT_ERC20_ABI,
                  functionName: "decimals",
                }),
              );

        let repay = 0n;
        let withdraw = 0n;
        if (prefill.kind === "full") {
          if (debt > 0n) repay = AMOUNT_FULL;
          if (aBal > 0n) withdraw = AMOUNT_FULL;
        } else if (symbol === "USDC" && debt > 0n) {
          // REDUCE: partial repay of the (USDC) debt, collateral untouched.
          const requested = BigInt(Math.round((prefill.repayUsd ?? 0) * 10 ** usdcDecimals));
          repay = requested > 0n ? (requested < debt ? requested : debt) : 0n;
        }
        if (repay === 0n && withdraw === 0n) continue;

        legs.push({
          protocol: PROTOCOL_ID[prefill.protocol],
          asset: reserve,
          repayAmount: repay,
          withdrawAmount: withdraw,
          data: "0x",
        });
        views.push({ reserve, symbol, repay, withdraw, debt, aBalance: aBal, decimals });

        if (repay > 0n) {
          const amount = repay === AMOUNT_FULL ? debt : repay;
          if (reserve === EXIT_USDC_ADDRESS) requiredUsdc += withAccrualBuffer(amount);
          approvals.push({
            token: reserve,
            spender: EXECUTOR_ADDRESS,
            amount,
            label: `Approve ${symbol} for debt repayment`,
          });
        }
        if (withdraw > 0n) {
          const [aToken] = (await client.readContract({
            address: EXIT_DATA_PROVIDER_ADDRESS,
            abi: EXIT_DATA_PROVIDER_ABI,
            functionName: "getReserveTokensAddresses",
            args: [reserve],
          })) as [`0x${string}`];
          approvals.push({
            token: aToken,
            spender: EXECUTOR_ADDRESS,
            amount: aBal,
            label: `Approve a${symbol} collateral transfer`,
          });
        }
      }

      if (legs.length === 0) {
        setError(
          prefill.kind === "partial"
            ? "This wallet has no USDC debt on the Base Sepolia demo position."
            : "This wallet has no Aave position on Base Sepolia. Seed a demo position first (see docs).",
        );
        setStep("error");
        return;
      }

      // LockChecker pre-flight (protocol-side pauses / zero liquidity).
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

      const usdcBalance = (await client.readContract({
        address: EXIT_USDC_ADDRESS,
        abi: EXIT_ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;

      setPosition({ legs, views, approvals, requiredUsdc, usdcBalance, usdcDecimals });
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

  const title = prefill.kind === "full" ? "Atomic Exit" : "Reduce Position";

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
            <h2 className="text-lg font-display font-bold text-text-primary">{title}</h2>
            {EXIT_ENV === "testnet" ? (
              <span className="px-2 py-0.5 rounded-sm border border-risk-elevated/40 bg-risk-elevated/10 text-risk-elevated text-2xs font-mono font-bold tracking-widest">
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
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-mono text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Close
            </button>
          </div>
        ) : null}

        {step === "connect" ? (
          <button
            onClick={() => connect({ connector: injected() })}
            className="w-full py-3 rounded-md bg-panik-orange/15 border border-panik-orange/30 text-panik-orange font-mono font-bold text-sm hover:bg-panik-orange/25 transition-colors"
          >
            Connect wallet
          </button>
        ) : null}

        {step === "chain" ? (
          <button
            onClick={() => void switchChainAsync({ chainId: EXIT_CHAIN_ID })}
            className="w-full py-3 rounded-md bg-panik-orange/15 border border-panik-orange/30 text-panik-orange font-mono font-bold text-sm hover:bg-panik-orange/25 transition-colors"
          >
            Switch to {getExitChain().name}
          </button>
        ) : null}

        {step === "loading" ? (
          <div className="flex items-center gap-3 text-sm text-text-secondary font-mono py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading position + running pre-flight...
          </div>
        ) : null}

        {(step === "review" || step === "executing") && position ? (
          <div className="space-y-4">
            <div className="space-y-2">
              {position.views.map((v) => (
                <div
                  key={v.reserve}
                  className="rounded-md border border-border-subtle bg-white/[0.02] p-3 flex items-center justify-between text-sm"
                >
                  <span className="font-mono text-text-primary">{v.symbol}</span>
                  <span className="font-mono text-xs tabular-nums text-text-secondary text-right">
                    {v.repay > 0n
                      ? `repay ${v.repay === AMOUNT_FULL ? fmtUnits(v.debt, v.decimals) : fmtUnits(v.repay, v.decimals)}`
                      : ""}
                    {v.repay > 0n && v.withdraw > 0n ? " · " : ""}
                    {v.withdraw > 0n
                      ? `withdraw ${v.withdraw === AMOUNT_FULL ? fmtUnits(v.aBalance, v.decimals) : fmtUnits(v.withdraw, v.decimals)}`
                      : ""}
                  </span>
                </div>
              ))}
            </div>

            {position.requiredUsdc > 0n ? (
              <div
                className={`text-xs font-mono tabular-nums flex items-center gap-2 ${
                  position.usdcBalance >= position.requiredUsdc ? "text-text-muted" : "text-risk-critical"
                }`}
              >
                {position.usdcBalance < position.requiredUsdc ? (
                  <AlertTriangle className="w-3.5 h-3.5" />
                ) : null}
                Wallet-funded repay: needs ~{fmtUnits(position.requiredUsdc, position.usdcDecimals)}{" "}
                USDC (you have {fmtUnits(position.usdcBalance, position.usdcDecimals)})
              </div>
            ) : null}

            {error ? (
              <div className="rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-mono break-words">
                {error}
              </div>
            ) : null}

            <button
              onClick={() => void execute()}
              disabled={
                step === "executing" ||
                (position.requiredUsdc > 0n && position.usdcBalance < position.requiredUsdc)
              }
              className="w-full py-3 rounded-md bg-text-primary text-black font-mono font-bold text-sm hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {step === "executing" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {status}
                </>
              ) : (
                <>
                  {prefill.kind === "full" ? "Approve & exit" : "Approve & reduce"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            <p className="text-2xs font-mono text-text-muted text-center">
              Approvals are exact-amount (+2% accrual buffer). Every transaction is simulated
              before you sign it.
            </p>
          </div>
        ) : null}

        {step === "done" && receipt ? (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="w-10 h-10 text-risk-low mx-auto" />
            <div>
              <p className="text-text-primary font-display font-bold">
                {prefill.kind === "full" ? "Position exited" : "Position reduced"}
              </p>
              {receipt.usdcReceived > 0n && position ? (
                <p className="text-sm text-text-secondary font-mono tabular-nums mt-1">
                  {fmtUnits(receipt.usdcReceived, position.usdcDecimals)} USDC swept to your wallet
                </p>
              ) : null}
            </div>
            <a
              href={exitExplorerTxUrl(receipt.hash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-panik-orange hover:underline"
            >
              View on Basescan <ExternalLink className="w-3 h-3" />
            </a>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-mono text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Done
            </button>
          </div>
        ) : null}

        {step === "error" ? (
          <div className="space-y-4">
            <div className="rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-mono break-words">
              {error}
            </div>
            <button
              onClick={() => setStep("loading")}
              className="w-full py-2.5 rounded-md bg-white/[0.06] border border-border-subtle text-sm font-mono text-text-primary hover:bg-white/[0.1] transition-colors"
            >
              Retry
            </button>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
