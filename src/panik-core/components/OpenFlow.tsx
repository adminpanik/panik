/**
 * OpenFlow - in-app position opening (Phase 2).
 *
 * connect -> switch to Base MAINNET -> review (editable sizing, live
 * projected PANIK score) -> execute step-by-step -> receipt. Opens are plain
 * protocol transactions signed by the user's own wallet - no PANIK contracts
 * in the path. Every step is simulated before it is signed; builder targets
 * are sanity-checked on-chain before any funds move.
 */

import React, { useCallback, useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { injected } from "wagmi/connectors";
import { asContractClient } from "../lib/exit";
import type { AdvisorOpenPlan } from "../lib/live";
import { useProspective } from "../lib/live";
import {
  buildOpenSteps,
  isOpenSupported,
  OPEN_CHAIN_ID,
  OPEN_ERC20_ABI,
  OPEN_TOKENS,
  readCollateralPriceUsd8,
  verifyOpenTargets,
  type MorphoMarketParams,
} from "../lib/openProtocols";
import { registerWatchedWallet } from "../lib/telegram";

const PROTOCOL_LABEL: Record<string, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

type Step = "connect" | "chain" | "review" | "executing" | "done" | "unsupported";

export function OpenFlow({
  plan,
  riskProfile,
  onClose,
}: {
  plan: AdvisorOpenPlan;
  riskProfile: string;
  onClose: () => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: OPEN_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const supported = isOpenSupported(plan.protocol, plan.collateralSymbol);
  const [collateralUsd, setCollateralUsd] = useState<number>(Math.round(plan.collateralUsd));
  const [borrowUsd, setBorrowUsd] = useState<number>(Math.round(plan.borrowUsd));
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [doneHash, setDoneHash] = useState<string | null>(null);

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
        : chainId !== OPEN_CHAIN_ID
          ? "chain"
          : executing
            ? "executing"
            : "review";

  const projectedScore = projected?.total ?? plan.projectedScore;
  const projectedHf = projected?.healthFactor ?? plan.projectedHf;

  const execute = useCallback(async () => {
    if (!publicClient || !address) return;
    const client = asContractClient(publicClient);
    setExecuting(true);
    setError(null);
    try {
      const token = OPEN_TOKENS[plan.collateralSymbol];
      if (!token) throw new Error(`unknown token ${plan.collateralSymbol}`);

      setStatus("Reading oracle price...");
      const price8 = await readCollateralPriceUsd8(client, plan.collateralSymbol);
      if (price8 === 0n) throw new Error("oracle price unavailable");
      const usd8 = BigInt(Math.round(collateralUsd * 1e8));
      const collateralAmount = (usd8 * 10n ** BigInt(token.decimals)) / price8;
      const borrowAmount = BigInt(Math.round(Math.min(borrowUsd, borrowCap) * 1e6));

      const balance = (await client.readContract({
        address: token.address,
        abi: OPEN_ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
      if (balance < collateralAmount) {
        throw new Error(
          `Insufficient ${plan.collateralSymbol}: need ~${(Number(collateralAmount) / 10 ** token.decimals).toFixed(5)}, ` +
            `have ${(Number(balance) / 10 ** token.decimals).toFixed(5)}`,
        );
      }

      let morphoMarket: MorphoMarketParams | undefined;
      if (plan.protocol === "morpho") {
        setStatus("Resolving Morpho market...");
        const res = await fetch(`/api/morpho/market?symbol=${plan.collateralSymbol}`);
        if (!res.ok) throw new Error("Morpho market lookup failed");
        const body = (await res.json()) as {
          marketParams: Omit<MorphoMarketParams, "lltv"> & { lltv: string };
        };
        morphoMarket = { ...body.marketParams, lltv: BigInt(body.marketParams.lltv) };
      }

      const input = {
        protocol: plan.protocol,
        collateralSymbol: plan.collateralSymbol,
        collateralAmount,
        borrowAmount,
        user: address,
        morphoMarket,
      };
      setStatus("Verifying protocol addresses...");
      await verifyOpenTargets(client, input);

      const steps = buildOpenSteps(input);
      const hashes: string[] = [];
      for (const s of steps) {
        setStatus(`${s.label} - simulating...`);
        const { request } = await client.simulateContract({
          account: address,
          address: s.address,
          abi: s.abi,
          functionName: s.functionName,
          args: s.args,
        });
        setStatus(`${s.label} - confirm in wallet...`);
        const hash = await writeContractAsync(request as never);
        setStatus(`${s.label} - waiting for confirmation...`);
        await client.waitForTransactionReceipt({ hash });
        hashes.push(hash);
        setTxHashes([...hashes]);
      }

      // Watch the new position immediately (fire-and-forget).
      const profile3 = ["conservative", "moderate", "aggressive"].includes(riskProfile)
        ? (riskProfile as "conservative" | "moderate" | "aggressive")
        : "moderate";
      void registerWatchedWallet(address, profile3);
      setDoneHash(hashes[hashes.length - 1] ?? null);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      setError(message.split("\n")[0]?.slice(0, 300) ?? "transaction failed");
    } finally {
      setExecuting(false);
    }
  }, [publicClient, address, plan, collateralUsd, borrowUsd, borrowCap, riskProfile, writeContractAsync]);

  const inputCls =
    "w-full bg-[#111318] border border-white/10 rounded-xl px-3 py-2 text-sm font-mono text-white focus:border-panik-orange/50 focus:outline-none";

  const summary = useMemo(
    () =>
      `${plan.collateralSymbol} on ${PROTOCOL_LABEL[plan.protocol] ?? plan.protocol}` +
      (plan.apy !== null ? ` · ~${(plan.apy * 100).toFixed(1)}% APY` : ""),
    [plan],
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-lg bg-[#0d0f14] border border-white/10 rounded-2xl p-6 space-y-5 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-display font-bold text-white">Open Position</h2>
            <p className="text-[11px] font-mono text-white/40 mt-0.5">{summary}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs text-panik-text-secondary font-sans leading-relaxed">
          Executes on <b className="text-white">Base mainnet</b> with real funds. Non-custodial:
          every step is a standard protocol transaction signed by your own wallet - PANIK never
          holds your assets.
        </div>

        {step === "unsupported" ? (
          <div className="space-y-4">
            <p className="text-sm text-panik-text-secondary font-sans">
              In-app opening for {plan.collateralSymbol} on{" "}
              {PROTOCOL_LABEL[plan.protocol] ?? plan.protocol} is not yet address-verified. Use the
              protocol's own app for now.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm font-mono text-white hover:bg-white/[0.1] transition-colors"
            >
              Close
            </button>
          </div>
        ) : null}

        {step === "connect" ? (
          <button
            onClick={() => connect({ connector: injected() })}
            className="w-full py-3 rounded-xl bg-panik-orange/15 border border-panik-orange/30 text-panik-orange font-mono font-bold text-sm hover:bg-panik-orange/25 transition-colors"
          >
            Connect wallet
          </button>
        ) : null}

        {step === "chain" ? (
          <button
            onClick={() => void switchChainAsync({ chainId: OPEN_CHAIN_ID })}
            className="w-full py-3 rounded-xl bg-panik-orange/15 border border-panik-orange/30 text-panik-orange font-mono font-bold text-sm hover:bg-panik-orange/25 transition-colors"
          >
            Switch to Base
          </button>
        ) : null}

        {step === "review" || step === "executing" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-[10px] font-mono tracking-widest uppercase text-white/35">
                  Collateral (USD)
                </span>
                <input
                  type="number"
                  min={1}
                  value={collateralUsd}
                  onChange={(e) => setCollateralUsd(Math.max(0, Number(e.target.value)))}
                  className={inputCls}
                  disabled={executing}
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] font-mono tracking-widest uppercase text-white/35">
                  Borrow USDC (max {borrowCap})
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

            <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
              <span className="text-[10px] font-mono tracking-widest uppercase text-white/35">
                Projected PANIK score
              </span>
              <span className="text-sm font-mono text-white">
                {projectedScore}
                {projectedHf !== null ? ` · HF ${projectedHf?.toFixed(2)}` : ""}
              </span>
            </div>
            <p className="text-[10px] font-mono text-white/30">
              Borrow is capped at your {riskProfile} profile's target health factor - the advisor
              sized this plan to stay within your risk band.
            </p>

            {error ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-3 text-xs text-red-300 font-mono break-words">
                {error}
              </div>
            ) : null}

            <button
              onClick={() => void execute()}
              disabled={executing || collateralUsd <= 0}
              className="w-full py-3 rounded-xl bg-panik-orange text-black font-mono font-bold text-sm hover:bg-panik-orange/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {executing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> {status}
                </>
              ) : (
                <>
                  Open position <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
            {txHashes.length > 0 && !doneHash ? (
              <p className="text-[10px] font-mono text-white/40 text-center">
                {txHashes.length} transaction{txHashes.length > 1 ? "s" : ""} confirmed...
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "done" && doneHash ? (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
            <div>
              <p className="text-white font-display font-bold">Position opened</p>
              <p className="text-sm text-panik-text-secondary font-mono mt-1">
                Your wallet is now watched - scoring picks the position up within a minute.
              </p>
            </div>
            <a
              href={`https://basescan.org/tx/${doneHash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-panik-orange hover:underline"
            >
              View on Basescan <ExternalLink className="w-3 h-3" />
            </a>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm font-mono text-white hover:bg-white/[0.1] transition-colors"
            >
              Done
            </button>
          </div>
        ) : null}

        {step !== "unsupported" && step !== "done" && !executing && error === null ? (
          <p className="text-[10px] font-mono text-white/25 text-center flex items-center justify-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Real funds. Review every wallet prompt before
            signing.
          </p>
        ) : null}
      </motion.div>
    </div>
  );
}
