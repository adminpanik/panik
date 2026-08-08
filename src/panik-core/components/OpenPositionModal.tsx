/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DEMO-ONLY position-opening flow (business-dev QA request 2026-07-03).
 * No wallet signing and no transaction ever leaves the browser - it simulates
 * the deposit-and-borrow UX end to end (configure, submit, confirm) so the
 * full "open a position from PANIK" journey can be walked in demos. Every
 * screen carries an explicit DEMO marker.
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, CheckCircle2, Loader2, X } from "lucide-react";
import { formatCurrency } from "../lib/utils";
import { ProtocolLogo } from "./ProtocolLogo";

export interface OpenPositionTarget {
  protocol: "Aave V3" | "Moonwell" | "Morpho" | "Compound V3";
  assetPair: string;
  collateralAsset: string;
  debtAsset: string;
  baseRisk: number;
  /** Supply APY shown in the projection (live pool APY where available). */
  apy: number;
  customCollateralUsd?: number;
  customBorrowPct?: number;
}

const DEPOSIT_PRESETS = [1_000, 5_000, 10_000, 25_000];

function fakeTxHash(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function OpenPositionModal(props: { target: OpenPositionTarget; onClose: () => void }) {
  const { target, onClose } = props;
  const [depositUsd, setDepositUsd] = useState(() => Math.round(target.customCollateralUsd ?? 5_000));
  const [borrowPct, setBorrowPct] = useState(() => Math.round(target.customBorrowPct ?? 40)); // borrow as % of deposit
  const [phase, setPhase] = useState<"config" | "submitting" | "done">("config");
  const [txHash, setTxHash] = useState("");

  const maxLTV = target.protocol === "Aave V3" ? 0.82 : 0.78;
  const borrowUsd = (depositUsd * borrowPct) / 100;
  const estHf = borrowUsd > 0 ? (depositUsd * maxLTV) / borrowUsd : Infinity;
  const liqBufferPct = borrowUsd > 0 ? Math.max(0, Math.round((1 - borrowUsd / maxLTV / depositUsd) * 100)) : 100;

  const submit = () => {
    setTxHash(fakeTxHash());
    setPhase("submitting");
    window.setTimeout(() => setPhase("done"), 2_200);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="open-position-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
        onClick={phase === "config" ? onClose : undefined}
      >
        <motion.div
          initial={{ scale: 0.96, y: 10, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md bg-surface-raised/98 border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
        >
          <div className="h-1 w-full bg-gradient-to-r from-white/0 via-white/20 to-white/0" />

          {/* Header */}
          <div className="p-5 border-b border-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ProtocolLogo protocol={target.protocol} size="w-8 h-8" />
              <div>
                <h3 className="font-sans font-bold text-text-primary text-sm">Open position</h3>
                <span className="block text-2xs font-sans text-text-secondary">
                  {target.protocol} · {target.assetPair}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-2xs font-sans font-bold px-2 py-0.5 rounded-sm border bg-risk-elevated/10 text-risk-elevated border-risk-elevated/25">
                DEMO
              </span>
              {phase !== "submitting" && (
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary hover:text-text-primary cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Body */}
          {phase === "config" && (
            <div className="p-5 space-y-5">
              {/* Deposit */}
              <div>
                <span className="block text-2xs font-sans text-text-secondary mb-2">
                  Deposit amount (USD, supplied as {target.collateralAsset})
                </span>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {DEPOSIT_PRESETS.map((v) => (
                    <button
                      key={v}
                      onClick={() => setDepositUsd(v)}
                      className={`py-1.5 rounded-md border text-2xs font-sans tabular-nums transition-all cursor-pointer ${
                        depositUsd === v
                          ? "bg-white/10 text-text-primary border-border-strong font-bold"
                          : "bg-white/[0.02] text-text-secondary border-border-subtle hover:bg-white/[0.05]"
                      }`}
                    >
                      ${v >= 1000 ? `${v / 1000}k` : v}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={depositUsd}
                  onChange={(e) => setDepositUsd(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-black/40 border border-border-strong rounded-md px-3 py-2 text-text-primary text-sm font-sans tabular-nums focus:border-border-strong"
                  aria-label="Deposit amount in USD"
                />
              </div>

              {/* Borrow */}
              <div>
                <div className="flex justify-between text-2xs font-sans text-text-secondary mb-2">
                  <span>Borrow ({target.debtAsset})</span>
                  <span className="text-text-primary normal-case tabular-nums">
                    {formatCurrency(borrowUsd)} · {borrowPct}% of deposit
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.round(maxLTV * 100) - 4}
                  step={5}
                  value={borrowPct}
                  onChange={(e) => setBorrowPct(Number(e.target.value))}
                  className="w-full h-1.5 bg-white/10 rounded-md appearance-none cursor-pointer accent-text-primary"
                  aria-label="Borrow percent of deposit"
                />
                <div className="flex justify-between text-xs font-sans text-text-muted mt-1">
                  <span>No debt (0%)</span>
                  <span>Near max LTV ({Math.round(maxLTV * 100) - 4}%)</span>
                </div>
              </div>

              {/* Projection */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-white/[0.02] border border-border-subtle rounded-md p-2.5">
                  <span className="block text-xs font-sans text-text-muted mb-0.5">Est. health</span>
                  <strong className={`text-sm font-sans tabular-nums ${
                    !Number.isFinite(estHf) ? "text-risk-low" : estHf < 1.3 ? "text-risk-critical" : estHf < 1.7 ? "text-risk-elevated" : "text-risk-low"
                  }`}>
                    {Number.isFinite(estHf) ? estHf.toFixed(2) : "∞"}
                  </strong>
                </div>
                <div className="bg-white/[0.02] border border-border-subtle rounded-md p-2.5">
                  <span className="block text-xs font-sans text-text-muted mb-0.5">Liq. buffer</span>
                  <strong className="text-sm font-sans tabular-nums text-text-primary">{liqBufferPct}%</strong>
                </div>
                <div className="bg-white/[0.02] border border-border-subtle rounded-md p-2.5">
                  <span className="block text-xs font-sans text-text-muted mb-0.5">Supply APY</span>
                  <strong className="text-sm font-sans tabular-nums text-risk-low">{target.apy.toFixed(1)}%</strong>
                </div>
              </div>

              <button
                onClick={submit}
                disabled={depositUsd <= 0}
                className="w-full py-3 rounded-md font-sans text-xs font-bold text-surface-base bg-text-primary hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all flex items-center justify-center gap-2"
              >
                <span>Open position (demo)</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <p className="text-xs font-sans text-text-secondary text-center leading-relaxed">
                Demo flow - nothing is signed and no funds move.
              </p>
            </div>
          )}

          {phase === "submitting" && (
            <div className="p-10 flex flex-col items-center text-center gap-3">
              <Loader2 className="w-8 h-8 text-text-primary animate-spin" />
              <span className="text-sm font-sans text-text-primary">Simulating transaction…</span>
              <span className="text-xs font-sans text-text-secondary">
                approve {target.collateralAsset} → supply → borrow {target.debtAsset}
              </span>
            </div>
          )}

          {phase === "done" && (
            <div className="p-7 flex flex-col items-center text-center gap-3">
              <CheckCircle2 className="w-10 h-10 text-risk-low" />
              <h4 className="text-base font-sans font-bold text-text-primary">Position opened (simulated)</h4>
              <p className="text-xs font-sans text-text-secondary leading-relaxed">
                {formatCurrency(depositUsd)} of {target.collateralAsset} supplied
                {borrowUsd > 0 && <> / {formatCurrency(borrowUsd)} {target.debtAsset} borrowed</>} on {target.protocol}.
                PANIK is now watching it.
              </p>
              <div className="w-full bg-surface-base/80 border border-border-subtle rounded-md px-3 py-2 font-sans text-2xs text-text-muted break-all select-all">
                {txHash}
              </div>
              <span className="text-2xs font-sans text-risk-elevated/80">
                Demo only - no on-chain transaction was sent
              </span>
              <button
                onClick={onClose}
                className="mt-1 w-full py-2.5 rounded-md font-sans text-xs font-bold text-text-primary bg-white/[0.06] hover:bg-white/[0.1] border border-border-subtle cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
