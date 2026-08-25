/**
 * OpenFlow - in-app position opening (Phase 2).
 *
 * connect -> switch to the chain the app is looking at -> review (editable
 * sizing, live projected PANIK score) -> execute step-by-step -> receipt. Opens
 * are plain protocol transactions signed by the user's own wallet - no PANIK
 * contracts in the path. Every step is simulated before it is signed; builder
 * targets are sanity-checked on-chain before any funds move.
 *
 * The chain is whichever one the app's chain mode selects, and it is FROZEN at
 * mount: flipping the mode while a sequence is executing must not re-target the
 * remaining steps or the resume cursor. Base mainnet moves real funds across
 * four protocols; Base Sepolia moves faucet assets on Aave V3 only, and tops the
 * wallet up from the faucet when the collateral balance is short. No sentence
 * on this screen may be true on one of those chains and false on the other.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { injected } from "wagmi/connectors";
import { asContractClient, bufferedGas, explorerTxUrl } from "../lib/exit";
import { formatTokenAmount } from "../lib/exitLegs";
import type { AdvisorOpenPlan } from "../lib/live";
import { useProspective } from "../lib/live";
import { CHAIN_MODE_LABEL, getChainMode } from "../lib/chainMode";
import { LAYER, SCRIM } from "../ui";
import {
  borrowAsset,
  buildOpenSteps,
  collateralStepCount,
  faucetDeficit,
  isOpenSupported,
  openAvailabilityLine,
  openChainConfig,
  openProgressKey,
  OPEN_ERC20_ABI,
  OPEN_FAUCET_ABI,
  readCollateralPriceUsd8,
  resumeIndex,
  verifyOpenTargets,
  type MorphoMarketParams,
} from "../lib/openProtocols";
import {
  registerWatchedWallet,
  useWalletOwnership,
  type RegisterResult,
  type RiskProfile as WatchRiskProfile,
} from "../lib/telegram";
import { PROTOCOL_LABEL } from "../lib/utils";

type Step = "connect" | "chain" | "review" | "executing" | "done" | "unsupported";

/**
 * Progress through the step list, persisted so that closing the modal or
 * refreshing the tab cannot lose it. Losing it would replay `supply` and
 * deposit the collateral a second time with real funds.
 */
interface OpenProgress {
  completedSteps: number;
  txHashes: string[];
  /**
   * Collateral amount (token units, decimal string) actually committed by the
   * landed steps. Frozen on the first landed step: the oracle re-read on a
   * retry must not desync the approve amount from the supplied amount.
   */
  collateralAmount: string | null;
  /**
   * Borrow amount (token units, decimal string) the LANDED borrow leg carried,
   * recorded when its receipt confirms. The done screen states this figure and
   * never the input box: the input is USD while this is token units, and in
   * the crash window between the borrow landing and the done screen rendering
   * the input can be edited to a number no transaction ever carried.
   */
  borrowAmount: string | null;
}

const EMPTY_PROGRESS: OpenProgress = {
  completedSteps: 0,
  txHashes: [],
  collateralAmount: null,
  borrowAmount: null,
};

/**
 * A stored amount is only an amount if it parses as bare token units. Checked
 * HERE so no consumer can feed a hand-edited record to `BigInt()` and throw
 * from inside a success path.
 */
function unitString(v: unknown): string | null {
  return typeof v === "string" && /^\d+$/.test(v) ? v : null;
}

function loadProgress(key: string): OpenProgress {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return EMPTY_PROGRESS;
    const parsed = JSON.parse(raw) as Partial<OpenProgress>;
    return {
      completedSteps: Number(parsed.completedSteps) || 0,
      txHashes: Array.isArray(parsed.txHashes) ? parsed.txHashes.map(String) : [],
      collateralAmount: unitString(parsed.collateralAmount),
      borrowAmount: unitString(parsed.borrowAmount),
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

function saveProgress(key: string, progress: OpenProgress): void {
  try {
    if (progress.completedSteps === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(progress));
  } catch {
    // Private-browsing / quota. The in-memory index still guards this session.
  }
}

export function OpenFlow({
  plan,
  riskProfile,
  onClose,
  onMonitoring,
}: {
  plan: AdvisorOpenPlan;
  /** Already validated at the localStorage boundary in AppDemo - no re-narrowing here. */
  riskProfile: WatchRiskProfile;
  onClose: () => void;
  /** Result of watch-registering the freshly opened position (see below). */
  onMonitoring?: (wallet: string, profile: WatchRiskProfile, result: RegisterResult) => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { getProof } = useWalletOwnership();

  // Frozen at mount, deliberately not `useChainMode()`. A mode flip in another
  // tab (or in Settings behind this modal) must not re-point a half-executed
  // sequence at another chain, nor move the resume cursor out from under the
  // collateral that is already supplied.
  const [chainMode] = useState(getChainMode);
  const config = useMemo(() => openChainConfig(chainMode), [chainMode]);
  const openChainId = config.chainId;
  const isTestnet = chainMode === "testnet";

  const publicClient = usePublicClient({ chainId: openChainId });

  const supported = isOpenSupported(config, plan.protocol, plan.collateralSymbol);

  // The dead-end sentence, from the same helper the gated buttons hover with:
  // this screen is the safety net for a path that bypassed one of them, and the
  // net must not word the reason differently from the control that stopped it.
  const unsupportedLine = openAvailabilityLine(
    chainMode,
    plan.protocol,
    plan.collateralSymbol,
  );
  const [collateralUsd, setCollateralUsd] = useState<number>(Math.round(plan.collateralUsd));
  const [borrowUsd, setBorrowUsd] = useState<number>(Math.round(plan.borrowUsd));
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [doneHash, setDoneHash] = useState<string | null>(null);
  /** What actually landed on-chain, phrased for the done screen. See execute(). */
  const [doneSummary, setDoneSummary] = useState<string | null>(null);

  /**
   * Which steps already landed. Keyed by plan IDENTITY (protocol / collateral
   * / wallet), deliberately NOT by the sizing inputs: lowering the borrow to
   * retry after a borrow-cap revert must resume the same open, never restart
   * it. Restarting would re-run `supply` on collateral already deposited.
   */
  const progressKey = useMemo(
    () =>
      address
        ? openProgressKey({
            protocol: plan.protocol,
            collateralSymbol: plan.collateralSymbol,
            user: address,
            chainId: openChainId,
          })
        : null,
    [address, plan.protocol, plan.collateralSymbol, openChainId],
  );
  const [progress, setProgress] = useState<OpenProgress>(EMPTY_PROGRESS);
  const { completedSteps, txHashes } = progress;

  // Rehydrate whenever the identity changes (mount, reconnect, plan switch).
  // A brand-new identity hydrates to EMPTY_PROGRESS, which is the only reset
  // path there is - no input edit can zero the cursor.
  useEffect(() => {
    setProgress(progressKey ? loadProgress(progressKey) : EMPTY_PROGRESS);
  }, [progressKey]);

  // The executor loop is async and outlives an unmount; stop touching state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const say = useCallback((message: string) => {
    if (mountedRef.current) setStatus(message);
  }, []);

  /** Persist first, re-render second - the durable record is what matters. */
  const commitProgress = useCallback(
    (key: string, next: OpenProgress) => {
      saveProgress(key, next);
      if (mountedRef.current) setProgress(next);
    },
    [],
  );

  // The advisor sized borrowUsd to the profile's target HF - that is the cap.
  const borrowCap = Math.round(plan.borrowUsd);

  // Live projected score as the user edits (same endpoint Compass uses).
  const projected = useProspective({
    protocol: plan.protocol,
    symbol: plan.collateralSymbol,
    collateralUsd,
    borrowUsd,
  });

  const step: Step = !supported
    ? "unsupported"
    : doneHash
      ? "done"
      : !isConnected
        ? "connect"
        : chainId !== openChainId
          ? "chain"
          : executing
            ? "executing"
            : "review";

  const projectedScore = projected?.total ?? plan.projectedScore;
  const projectedHf = projected?.healthFactor ?? plan.projectedHf;

  const execute = useCallback(async () => {
    if (!publicClient || !address || !progressKey) return;
    const client = asContractClient(publicClient);
    setExecuting(true);
    setError(null);
    // Snapshot: the persisted record is the source of truth for this attempt.
    const started = loadProgress(progressKey);
    /**
     * One transaction, start to finish: simulate + buffered gas estimate (same
     * params, so they run as one round trip), sign, then require the receipt
     * to land `success` - viem does not throw on revert. Every transaction the
     * flow sends goes through here, so the gas buffer and the receipt check
     * cannot be fixed in one copy and not another.
     */
    const runCall = async (label: string, call: unknown): Promise<`0x${string}`> => {
      say(`${label} - simulating...`);
      const [{ request }, gas] = await Promise.all([
        client.simulateContract(call),
        bufferedGas(client, call),
      ]);
      (request as { gas?: bigint }).gas = gas;
      say(`${label} - confirm in wallet...`);
      const hash = await writeContractAsync(request as never);
      say(`${label} - waiting for confirmation...`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${label} reverted on-chain`);
      return hash;
    };
    try {
      const token = config.tokens[plan.collateralSymbol];
      if (!token) throw new Error(`unknown token ${plan.collateralSymbol}`);

      // Once a step has landed, the collateral size is settled on-chain and
      // must be reused verbatim. Re-deriving it from a moved oracle price
      // would leave the exact-amount approval short of the supply.
      let collateralAmount: bigint;
      if (started.collateralAmount !== null) {
        collateralAmount = BigInt(started.collateralAmount);
      } else {
        say("Reading oracle price...");
        const price8 = await readCollateralPriceUsd8(client, config, plan.collateralSymbol);
        if (price8 === 0n) throw new Error("oracle price unavailable");
        const usd8 = BigInt(Math.round(collateralUsd * 1e8));
        collateralAmount = (usd8 * 10n ** BigInt(token.decimals)) / price8;
      }
      // Scale by the borrow asset's DECLARED decimals, never a hardcoded 1e6:
      // the borrow asset differs per chain (USDC on Base, USDT on Sepolia).
      const borrow = borrowAsset(config);
      const borrowAmount =
        (BigInt(Math.round(Math.min(borrowUsd, borrowCap) * 1e8)) *
          10n ** BigInt(borrow.decimals)) /
        10n ** 8n;

      let morphoMarket: MorphoMarketParams | undefined;
      if (plan.protocol === "morpho") {
        say("Resolving Morpho market...");
        const res = await fetch(`/api/morpho/market?symbol=${plan.collateralSymbol}`);
        if (!res.ok) throw new Error("Morpho market lookup failed");
        const body = (await res.json()) as {
          marketParams: Omit<MorphoMarketParams, "lltv"> & { lltv: string };
        };
        morphoMarket = { ...body.marketParams, lltv: BigInt(body.marketParams.lltv) };
      }

      const input = {
        config,
        protocol: plan.protocol,
        collateralSymbol: plan.collateralSymbol,
        collateralAmount,
        borrowAmount,
        user: address,
        morphoMarket,
      };
      say("Verifying protocol addresses...");
      await verifyOpenTargets(client, input);

      const steps = buildOpenSteps(input);

      // Cross-check the recorded cursor against the chain before running
      // anything: an exact-amount approval that no longer covers the supply
      // has to be re-issued, and one the chain already grants is skipped.
      const approveStep = steps.find((s) => s.kind === "approve");
      let allowance = 0n;
      if (approveStep?.spender) {
        say("Checking allowance...");
        allowance = (await client.readContract({
          address: approveStep.address,
          abi: OPEN_ERC20_ABI,
          functionName: "allowance",
          args: [address, approveStep.spender],
        })) as bigint;
      }
      const start = resumeIndex({
        steps,
        completedSteps: started.completedSteps,
        allowance,
        collateralAmount,
      });

      // Only meaningful while the collateral is still in the user's wallet -
      // after the supply landed the balance is legitimately gone.
      if (start < collateralStepCount(steps)) {
        const balance = (await client.readContract({
          address: token.address,
          abi: OPEN_ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        })) as bigint;
        const deficit = faucetDeficit(balance, collateralAmount);
        if (deficit > 0n) {
          if (!config.faucet) {
            throw new Error(
              `Insufficient ${plan.collateralSymbol}: need ~${(Number(collateralAmount) / 10 ** token.decimals).toFixed(5)}, ` +
                `have ${(Number(balance) / 10 ** token.decimals).toFixed(5)}`,
            );
          }
          // Test assets: mint the shortfall rather than dead-ending the demo on
          // an empty wallet. Deliberately NOT recorded in the resume cursor -
          // it re-derives from the live balance every attempt, so a retry after
          // a reverted borrow mints nothing instead of minting blindly.
          await runCall(`Mint test ${plan.collateralSymbol}`, {
            account: address,
            address: config.faucet,
            abi: OPEN_FAUCET_ABI,
            functionName: "mint",
            args: [token.address, address, deficit],
          });
        }
      }

      const hashes: string[] = [...started.txHashes];
      let committed = started.collateralAmount;
      let borrowed = started.borrowAmount;
      for (let i = start; i < steps.length; i += 1) {
        const s = steps[i]!;
        const hash = await runCall(s.label, {
          account: address,
          address: s.address,
          abi: s.abi,
          functionName: s.functionName,
          args: s.args,
        });
        hashes.push(hash);
        // Freeze the collateral size on the first landed step, and persist
        // BEFORE the next iteration so a crash here still resumes correctly.
        committed = committed ?? collateralAmount.toString();
        if (s.kind === "borrow") borrowed = borrowAmount.toString();
        commitProgress(progressKey, {
          completedSteps: i + 1,
          txHashes: [...hashes],
          collateralAmount: committed,
          borrowAmount: borrowed,
        });
      }

      // Watch the new position immediately (fire-and-forget). Proofs are
      // single-use now, so there is no signature to reuse; instead
      // registerWatchedWallet skips outright when this wallet was already
      // registered in this session (the usual case, since onboarding did it),
      // which is what stops a second popup landing on the user the instant
      // they finish confirming an on-chain open. A failure is reported up so
      // it raises the "Alerts inactive" banner rather than vanishing.
      void registerWatchedWallet(address, riskProfile, getProof).then((result) =>
        onMonitoring?.(address.toLowerCase(), riskProfile, result),
      );
      // The open is finished; the resume record has nothing left to protect.
      saveProgress(progressKey, EMPTY_PROGRESS);
      // The RECORDED figures, never the input boxes (see OpenProgress). A
      // record predating the borrow field omits that clause rather than guess.
      const borrowedClause = borrowed
        ? ` and borrowed ${formatTokenAmount(BigInt(borrowed), borrow.decimals)} ${config.borrowSymbol}`
        : "";
      if (mountedRef.current) {
        setDoneSummary(
          `Supplied ${formatTokenAmount(BigInt(committed ?? collateralAmount.toString()), token.decimals)} ` +
            `${plan.collateralSymbol}${borrowedClause} on ${PROTOCOL_LABEL[plan.protocol] ?? plan.protocol}.`,
        );
        setDoneHash(hashes[hashes.length - 1] ?? null);
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (mountedRef.current) {
        setError(message.split("\n")[0]?.slice(0, 300) ?? "transaction failed");
      }
    } finally {
      if (mountedRef.current) setExecuting(false);
    }
  }, [
    publicClient,
    address,
    progressKey,
    config,
    commitProgress,
    say,
    plan,
    collateralUsd,
    borrowUsd,
    borrowCap,
    riskProfile,
    writeContractAsync,
    getProof,
    onMonitoring,
  ]);

  const inputCls =
    "w-full bg-surface-raised border border-border-strong rounded-md px-3 py-2 text-sm font-sans tabular-nums text-text-primary focus:border-border-strong";

  const summary = useMemo(
    () =>
      `${plan.collateralSymbol} on ${PROTOCOL_LABEL[plan.protocol] ?? plan.protocol}` +
      (plan.apy !== null ? ` · ~${(plan.apy * 100).toFixed(1)}% APY` : ""),
    [plan],
  );

  // Dismissing mid-sequence would strand a wallet prompt and (before the
  // persisted cursor existed) lose the resume point entirely. Block it.
  const requestClose = useCallback(() => {
    if (executing) return;
    onClose();
  }, [executing, onClose]);

  return (
    <div className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4`}>
      {/* The app's one scrim, from `ui/overlay`. */}
      <div className={`absolute inset-0 ${SCRIM}`} onClick={requestClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-lg bg-surface-sunken border border-border-subtle rounded-lg p-6 space-y-5 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-sans font-bold text-text-primary">Open position</h2>
            <p className="text-2xs font-sans text-text-muted mt-0.5">{summary}</p>
          </div>
          <button
            onClick={requestClose}
            disabled={executing}
            title={executing ? "Finish or cancel the pending transaction first" : "Close"}
            className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-text-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="rounded-md border border-border-subtle bg-white/[0.02] p-3 text-xs text-text-secondary font-sans leading-relaxed">
          Executes on{" "}
          <b className="text-text-primary">{isTestnet ? CHAIN_MODE_LABEL.testnet : "Base mainnet"}</b>{" "}
          with {config.faucet ? "test assets that have no value" : "real funds"}. Non-custodial:
          every step is a standard protocol transaction signed by your own wallet - PANIK never
          holds your assets.
        </div>

        {step === "unsupported" ? (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary font-sans">{unsupportedLine}</p>
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
            onClick={() => void switchChainAsync({ chainId: openChainId })}
            className="w-full py-3 rounded-md bg-white/10 border border-border-subtle text-text-primary font-sans font-bold text-sm hover:bg-white/15 transition-colors"
          >
            Switch to {CHAIN_MODE_LABEL[chainMode]}
          </button>
        ) : null}

        {step === "review" || step === "executing" ? (
          <div className="space-y-4">
            {completedSteps > 0 ? (
              <div className="rounded-md border border-risk-elevated/30 bg-risk-elevated/[0.06] p-3 text-xs text-risk-elevated/90 font-sans leading-relaxed">
                <b className="text-risk-elevated">
                  {completedSteps} step{completedSteps > 1 ? "s" : ""} already landed on-chain.
                </b>{" "}
                This open resumes from the next step - your collateral is already supplied and is
                locked at its original size, so it can never be supplied twice. Adjust the borrow
                and retry.
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-2xs font-sans text-text-muted">
                  Collateral (USD)
                </span>
                <input
                  type="number"
                  min={1}
                  value={collateralUsd}
                  onChange={(e) => setCollateralUsd(Math.max(0, Number(e.target.value)))}
                  className={`${inputCls} disabled:opacity-50 disabled:cursor-not-allowed`}
                  disabled={executing || completedSteps > 0}
                  title={
                    completedSteps > 0
                      ? "Collateral is already supplied on-chain and cannot be resized here"
                      : undefined
                  }
                />
              </label>
              <label className="space-y-1">
                <span className="text-2xs font-sans text-text-muted">
                  Borrow {config.borrowSymbol} (max {borrowCap})
                </span>
                <input
                  type="number"
                  min={0}
                  max={borrowCap}
                  value={borrowUsd}
                  onChange={(e) =>
                    setBorrowUsd(Math.min(borrowCap, Math.max(0, Number(e.target.value))))
                  }
                  className={inputCls}
                  disabled={executing}
                />
              </label>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border-subtle bg-white/[0.02] p-3">
              <span className="text-2xs font-sans text-text-muted">
                Projected PANIK score
              </span>
              <span className="text-sm font-sans tabular-nums text-text-primary">
                {projectedScore}
                {projectedHf !== null ? ` · HF ${projectedHf?.toFixed(2)}` : ""}
              </span>
            </div>
            <p className="text-2xs font-sans text-text-muted">
              Borrow is capped at your {riskProfile} profile's target health factor.
            </p>

            {error ? (
              <div className="rounded-md border border-risk-critical/30 bg-risk-critical/[0.06] p-3 text-xs text-risk-critical font-sans break-words">
                {error}
              </div>
            ) : null}

            <button
              onClick={() => void execute()}
              disabled={executing || collateralUsd <= 0}
              className="w-full py-3 rounded-md bg-text-primary text-surface-base font-sans font-bold text-sm hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {executing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {status}
                </>
              ) : (
                <>
                  {completedSteps > 0 ? "Resume open" : "Open position"}{" "}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            {txHashes.length > 0 && !doneHash ? (
              <p className="text-2xs font-sans text-text-muted text-center">
                {txHashes.length} transaction{txHashes.length > 1 ? "s" : ""} confirmed
                {executing ? "..." : " - retrying continues from the next step"}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "done" && doneHash ? (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="w-10 h-10 text-risk-low mx-auto" />
            <div>
              <p className="text-text-primary font-sans font-bold">Position opened</p>
              {doneSummary ? (
                <p className="text-sm text-text-secondary font-sans mt-1 tabular-nums">
                  {doneSummary}
                </p>
              ) : null}
              <p className="text-sm text-text-secondary font-sans mt-1">
                Your wallet is now watched - scoring picks the position up within a minute.
              </p>
            </div>
            <a
              href={explorerTxUrl(config.chainId, doneHash)}
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

        {step !== "unsupported" && step !== "done" && !executing && error === null ? (
          <p className="text-2xs font-sans text-text-muted text-center flex items-center justify-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {config.faucet ? "Test assets." : "Real funds."}{" "}
            Review every wallet prompt before signing.
          </p>
        ) : null}
      </motion.div>
    </div>
  );
}
