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
import { ArrowRight, CheckCircle2, ExternalLink, X } from "lucide-react";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { injected } from "wagmi/connectors";
import { asContractClient, bufferedGas, explorerTxUrl } from "../lib/exit";
import { formatTokenAmount } from "../lib/exitLegs";
import type { AdvisorOpenPlan, Band } from "../lib/live";
import { useProspective } from "../lib/live";
import { CHAIN_MODE_LABEL, getChainMode } from "../lib/chainMode";
import { classifyExitError, StatedFailure } from "../lib/exitRpc";
import { Button, Chip, Field, LAYER, Notice, SCRIM } from "../ui";
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
import {
  BAND_WORD,
  bandOfScore,
  liquidationOutlook,
  PROTOCOL_LABEL,
  RISK_CHIP,
} from "../lib/utils";

/**
 * The "liquidates if" cell's answer, built entirely from `liquidationOutlook`'s
 * own fields rather than re-parsed out of its prose: `strip` is the exact,
 * already-rounded percentage the engine computed, so the one span this
 * component sets in mono is a verbatim copy, never a second computation of
 * `1 - 1/HF`. The no-debt and liquidatable-now cases have no percentage to
 * highlight, so they render the engine's own sentence whole.
 */
function LiquidatesIfValue({
  outlook,
  symbol,
}: {
  outlook: ReturnType<typeof liquidationOutlook>;
  symbol: string;
}) {
  if (outlook.stripNote === "no debt" || outlook.stripNote === "liquidatable now") {
    return <span className="font-sans text-lg leading-snug text-text-primary">{outlook.sentence}</span>;
  }
  return (
    <span className="font-sans text-lg leading-snug text-text-primary">
      {symbol} falls <span className="font-mono font-bold">{outlook.strip}</span>
    </span>
  );
}

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
  // The chain named in a failure sentence: the one this modal is frozen to,
  // never the wallet's current network. Frozen with the mode above, so the
  // sentence cannot name a chain the sequence did not run on.
  const networkLabel = CHAIN_MODE_LABEL[chainMode];

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
  const { completedSteps } = progress;

  // Rehydrate whenever the identity changes (mount, reconnect, plan switch).
  // A brand-new identity hydrates to EMPTY_PROGRESS, which is the only reset
  // path there is - no input edit can zero the cursor.
  useEffect(() => {
    setProgress(progressKey ? loadProgress(progressKey) : EMPTY_PROGRESS);
  }, [progressKey]);

  /**
   * One signing sequence at a time.
   *
   * `executing` is state, so it is stale for the rest of the frame in which it
   * is set: two clicks landing before React re-renders both read
   * `executing === false`, both pass the button's `disabled` prop, and both run
   * a full simulate + `writeContractAsync` sequence. That is two wallet prompts
   * on a good day and two supplies of the same collateral on a wallet that
   * confirms without asking. A ref is written synchronously, so the second call
   * sees the first one's mark. The state stays for rendering only.
   */
  const inFlightRef = useRef(false);

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
  /**
   * The projected health factor as the reader meets it: the price drop that
   * would liquidate this position, with the exact ratio kept in the hover. The
   * review step used to append "· HF 1.75" to the score, which is the engine's
   * own shorthand on the last screen before a signature. Derived rather than
   * memoised - it is one lookup over two numbers already in hand.
   */
  const projectedOutlook = liquidationOutlook(projectedHf, plan.collateralSymbol);
  // `projectedHf` is typed `number | null` end to end (no debt is null, never
  // NaN), so this is belt-and-suspenders rather than a reachable branch: a
  // corrupted figure renders nothing in the "liquidates if" cell rather than
  // a stale sentence built from it.
  const hfUnknown = projectedHf !== null && !Number.isFinite(projectedHf);

  // The engine's own band for the live-scored figure; `bandOfScore` is the
  // same fallback path Compass and the Portfolio table use while the debounced
  // `/api/prospective` call has not landed yet. UNKNOWN only if the score
  // itself is somehow not a finite number, which the plan's own type does not
  // allow - defensive for the same reason as `hfUnknown` above.
  const projectedBand: Band | "UNKNOWN" =
    projected?.band ?? (Number.isFinite(projectedScore) ? bandOfScore(projectedScore) : "UNKNOWN");
  const projectedBandWord = projectedBand === "UNKNOWN" ? null : BAND_WORD[projectedBand];

  // "OPEN <asset> ON <protocol>", built from the plan the modal already
  // carries - never a second name for a protocol `PROTOCOL_LABEL` already
  // states.
  const heading = `Open ${plan.collateralSymbol} on ${PROTOCOL_LABEL[plan.protocol] ?? plan.protocol}`;

  const execute = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!publicClient || !address || !progressKey) return;
    // Claimed here, released in `finally`. Nothing between this line and the
    // `try` awaits, so no second call can slip in behind it.
    inFlightRef.current = true;
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
            // `StatedFailure`, not a plain Error: this sentence was written for
            // the user and is the only one that says what to do about the
            // shortfall, so the classifier hands it through instead of
            // flattening it to "Something went wrong". It names two amounts and
            // a symbol - no endpoint, no calldata, nothing to leak.
            throw new StatedFailure(
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
      // The same rule the exit flow already follows, for the same reason: viem
      // builds a transport error's `.message` out of the endpoint URL and the
      // whole JSON-RPC request body, so the old
      // `.message.split("\n")[0].slice(0, 300)` could put an https:// endpoint
      // and a line of calldata on screen, and made a wallet dismissal, an
      // unreachable node and an on-chain revert read identically. The raw text
      // goes to the console, where it is useful; the modal gets a sentence.
      // A `StatedFailure` this flow raised itself keeps its own wording.
      const failure = classifyExitError(err, networkLabel);
      console.error(`[open] execution failed (${failure.kind}):`, failure.detail, err);
      if (mountedRef.current) setError(failure.message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setExecuting(false);
    }
  }, [
    publicClient,
    address,
    progressKey,
    config,
    networkLabel,
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
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto hard-edge shadow-hard bg-surface-raised">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b-[3px] border-solid border-border-strong px-6 py-5">
          <h2 className="min-w-0 truncate font-sans text-lg font-black uppercase tracking-[0.02em] text-text-primary">
            {heading}
          </h2>
          <div className="flex shrink-0 items-center gap-3.5">
            {/* What kind of money this moves, in two words, from the same
                faucet flag the deleted paragraph branched on. It is not
                withheld on mainnet: "Real funds" is the half of this a reader
                most needs. */}
            {step !== "unsupported" ? (
              <Chip>{config.faucet ? "Test assets" : "Real funds"}</Chip>
            ) : null}
            <button
              type="button"
              onClick={requestClose}
              disabled={executing}
              aria-label="Close"
              title={executing ? "Finish or cancel the pending transaction first" : "Close"}
              className="shrink-0 cursor-pointer text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {step === "unsupported" ? (
          <div className="space-y-4 p-6">
            <p className="font-sans text-sm leading-relaxed text-text-secondary">
              {unsupportedLine}
            </p>
            <Button variant="secondary" className="w-full" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : null}

        {step === "connect" ? (
          <div className="p-6">
            <Button className="w-full" onClick={() => connect({ connector: injected() })}>
              Connect wallet
            </Button>
          </div>
        ) : null}

        {step === "chain" ? (
          <div className="p-6">
            <Button
              className="w-full"
              onClick={() => void switchChainAsync({ chainId: openChainId })}
            >
              Switch to {CHAIN_MODE_LABEL[chainMode]}
            </Button>
          </div>
        ) : null}

        {step === "review" || step === "executing" ? (
          <>
            <div className="flex flex-col gap-4 p-6">
              <Field
                size="lg"
                mono
                label="Collateral, USD"
                type="number"
                min={1}
                value={collateralUsd}
                onChange={(e) => setCollateralUsd(Math.max(0, Number(e.target.value)))}
                disabled={executing || completedSteps > 0}
                title={
                  completedSteps > 0
                    ? "Collateral is already supplied on-chain and cannot be resized here"
                    : undefined
                }
              />
              <Field
                size="lg"
                mono
                label={`Borrow, ${config.borrowSymbol}`}
                type="number"
                min={0}
                max={borrowCap}
                value={borrowUsd}
                onChange={(e) =>
                  setBorrowUsd(Math.min(borrowCap, Math.max(0, Number(e.target.value))))
                }
                disabled={executing}
              />
            </div>

            {/* What this sizing produces: the projected band, as the one
                coloured block this modal spends, and the price drop that band
                means, straight out of `liquidationOutlook` - never a second
                copy of the health-factor math. "HF 1.75" appended to the score
                was the engine's own shorthand and is gone with the rest of the
                prose; the exact ratio still opens in the hover. */}
            <div className="grid grid-cols-[200px_minmax(0,1fr)] border-y-[3px] border-solid border-border-strong">
              <div
                className={`flex flex-col justify-center gap-1 border-r-[3px] border-solid border-border-strong px-6 py-4 ${RISK_CHIP[projectedBand]}`}
              >
                <span className="label-type text-xs">Projected score</span>
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-score font-bold">{projectedScore}</span>
                  {projectedBandWord ? (
                    <span className="label-type text-xs">{projectedBandWord}</span>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col justify-center gap-1 px-6 py-4">
                <span className="label-type text-xs text-text-muted">Liquidates if</span>
                {hfUnknown ? null : (
                  <LiquidatesIfValue outlook={projectedOutlook} symbol={plan.collateralSymbol} />
                )}
              </div>
            </div>

            {/* Not in the mockup: a failed transaction on a real-money flow
                has to say so, and a stalled resume needs the same. Both are
                exceptional states the steady-state layout above does not
                carry text for. */}
            {error ? (
              <div className="px-6 pt-4">
                <Notice text={error} />
              </div>
            ) : null}

            <div className="p-6">
              <Button
                size="lg"
                className="w-full"
                onClick={() => void execute()}
                disabled={executing || collateralUsd <= 0}
              >
                {executing ? (
                  status
                ) : (
                  <>
                    {completedSteps > 0 ? "Resume open" : "Open position"}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            </div>
          </>
        ) : null}

        {step === "done" && doneHash ? (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-3">
              {/* Black, not the LOW band: an open that landed is news about a
                  transaction, and the risk ramp is what a position is in. */}
              <CheckCircle2 className="h-6 w-6 shrink-0 text-text-primary" aria-hidden="true" />
              <h3 className="font-sans text-lg font-black uppercase tracking-tight text-text-primary">
                Position opened
              </h3>
            </div>
            {/* The one sentence left in either modal, and it is left
                deliberately: `doneSummary` is composed inside `execute()` out
                of the RECORDED amounts (`formatTokenAmount` over the landed
                legs), which is frozen money-path code this pass may not
                rewrite into rows. "Your wallet is watched, scoring picks the
                position up within a minute" went with the rest. */}
            {doneSummary ? (
              <p className="font-sans text-sm leading-relaxed text-text-secondary">
                {doneSummary}
              </p>
            ) : null}
            <a
              href={explorerTxUrl(config.chainId, doneHash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-sans text-xs text-text-primary"
            >
              View on Basescan <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
            <Button variant="secondary" className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
