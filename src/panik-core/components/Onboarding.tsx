/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldAlert, Sparkles, Wallet } from "lucide-react";
import {
  QUESTIONS,
  computeProfile,
  type Answers,
  type OptionKey,
  type ProfileResult,
} from "../lib/profiling";
import { useWalletProfile, type WalletProfileData } from "../lib/profileApi";

/**
 * Address format check (purely client-side).
 * Base (EVM): 0x + 40 hex chars (42 total). EVM-only by design: the on-chain
 * analyzer, alert worker, and every backend table are EVM-only, so accepting
 * anything else would onboard a wallet that can never be monitored.
 */
export function isPlausibleWalletAddress(raw: string): boolean {
  const a = raw.trim();
  if (!a) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

const TOTAL_QUESTIONS = QUESTIONS.length; // 5
const WALLET_STEP = 0;                     // step 0 → wallet (FIRST)
const REVEAL_STEP = TOTAL_QUESTIONS + 1;   // step 6 → AI analysis

interface OnboardingProps {
  /** Called with the computed (quiz) profile + the wallet address. */
  onComplete: (result: ProfileResult, wallet: string) => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(WALLET_STEP);      // 0 wallet, 1..5 questions, 6 reveal
  const [answers, setAnswers] = useState<Answers>({});
  const [wallet, setWallet] = useState("");
  const [walletError, setWalletError] = useState("");
  const [exiting, setExiting] = useState(false);

  const profile = useWalletProfile();
  const resolveStarted = useRef(false);

  const walletValid = isPlausibleWalletAddress(wallet);
  const onWalletStep = step === WALLET_STEP;
  const onReveal = step === REVEAL_STEP;
  const qIndex = step - 1; // question index for steps 1..5
  const progressPct = Math.round((step / REVEAL_STEP) * 100);

  // Kick off the reveal once we land on the final step (poll the background scan
  // with the quiz's stated profile). Runs exactly once.
  useEffect(() => {
    if (onReveal && !resolveStarted.current) {
      resolveStarted.current = true;
      const stated = computeProfile(answers).riskProfile3;
      void profile.resolve({ riskProfile3: stated });
    }
  }, [onReveal, answers, profile]);

  const submitWallet = () => {
    if (!walletValid) {
      setWalletError("That doesn't look like a valid Base (0x...) address.");
      return;
    }
    void profile.start(wallet.trim()); // fire the background scan now
    setStep(1);
  };

  const selectAnswer = (qid: keyof Answers, key: OptionKey) => {
    setAnswers((prev) => ({ ...prev, [qid]: key }));
    // Auto-advance; after the last question, go to the reveal.
    window.setTimeout(() => setStep((s) => Math.min(s + 1, REVEAL_STEP)), 280);
  };

  const goBack = () => setStep((s) => Math.max(WALLET_STEP, s - 1));

  const handleEnter = () => {
    const result = computeProfile(answers);
    setExiting(true);
    window.setTimeout(() => onComplete(result, wallet.trim()), 320);
  };

  const handleWalletChange = (value: string) => {
    setWallet(value);
    if (walletError) setWalletError("");
  };

  const stepLabel = onWalletStep
    ? "Step 1 — your wallet"
    : onReveal
      ? "Your analysis"
      : `Question ${step} of ${TOTAL_QUESTIONS}`;

  return (
    <AnimatePresence>
      {!exiting && (
        <motion.div
          key="onboarding-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md"
        >
          <div className="absolute inset-0 panik-radial-ambient pointer-events-none" />

          <motion.div
            initial={{ scale: 0.96, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-lg panik-glass rounded-2xl border border-white/[0.08] bg-[#0E1015]/95 shadow-2xl overflow-hidden"
          >
            <div className="h-1 w-full bg-gradient-to-r from-panik-orange/0 via-panik-orange to-panik-orange/0" />

            <div className="p-7 sm:p-9">
              {/* Header: brand + step indicator */}
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2.5">
                  <img src="/panik-logo.png" alt="PANIK" width={28} height={28} style={{ objectFit: "contain" }} />
                  <span className="font-display font-extrabold text-base tracking-widest text-white leading-none">PANIK</span>
                </div>
                <span className="text-[10px] font-mono uppercase tracking-widest text-panik-text-secondary">
                  {stepLabel}
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-1 w-full bg-white/[0.05] rounded-full overflow-hidden mb-7">
                <motion.div
                  className="h-full bg-panik-orange rounded-full"
                  initial={false}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                />
              </div>

              <motion.div
                key={onWalletStep ? "wallet" : onReveal ? "reveal" : `q-${step}`}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22 }}
                className="w-full"
              >
                {onWalletStep && (
                  <WalletStep
                    wallet={wallet}
                    walletValid={walletValid}
                    walletError={walletError}
                    onChange={handleWalletChange}
                    onSubmit={submitWallet}
                  />
                )}

                {!onWalletStep && !onReveal && (
                  <QuestionStep
                    qIndex={qIndex}
                    selectedKey={answers[QUESTIONS[qIndex].id]}
                    onSelect={selectAnswer}
                    onBack={goBack}
                  />
                )}

                {onReveal && (
                  <RevealStep
                    phase={profile.phase}
                    data={profile.data}
                    quiz={computeProfile(answers)}
                    onEnter={handleEnter}
                  />
                )}
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Wallet step ─────────────────────────────────────────────────────────────
function WalletStep(props: {
  wallet: string;
  walletValid: boolean;
  walletError: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <h2 className="font-display font-extrabold text-2xl text-white tracking-tight mb-1.5">
        Start with your wallet
      </h2>
      <p className="text-panik-text-secondary text-sm font-sans mb-6 leading-relaxed">
        Paste your wallet address. While you answer a few quick questions, Panik reads your on-chain
        history to profile what kind of DeFi user you are.
      </p>

      <div className="relative">
        <Wallet className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-panik-text-secondary pointer-events-none" />
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={props.wallet}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && props.walletValid) props.onSubmit();
          }}
          placeholder="0x... your Base wallet address"
          aria-invalid={Boolean(props.walletError)}
          aria-describedby={props.walletError ? "wallet-error" : undefined}
          className={`w-full h-12 pl-10 pr-4 rounded-xl bg-[#090C12] border text-sm font-mono text-white placeholder:text-white/25 outline-none transition-all ${
            props.walletError ? "border-red-500/50 focus:border-red-500/70" : "border-white/[0.08] focus:border-panik-orange/60"
          }`}
        />
      </div>

      {props.walletError && (
        <p id="wallet-error" role="alert" className="mt-2.5 flex items-center gap-1.5 text-red-400 text-xs font-mono">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{props.walletError}</span>
        </p>
      )}

      <button
        type="button"
        onClick={props.onSubmit}
        disabled={!props.walletValid}
        className="mt-7 w-full h-12 rounded-xl font-mono text-sm font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-panik-orange hover:bg-panik-orange/90 text-white panik-glow-orange disabled:bg-white/[0.06] disabled:text-panik-text-secondary disabled:shadow-none"
      >
        <span>Continue</span>
        <ArrowRight className="w-4 h-4" />
      </button>
      <p className="mt-3 text-center text-[10px] font-mono text-panik-text-secondary/70">
        Read-only. Panik never moves funds — it only reads public on-chain data.
      </p>
    </>
  );
}

// ── Question step ───────────────────────────────────────────────────────────
function QuestionStep(props: {
  qIndex: number;
  selectedKey: OptionKey | undefined;
  onSelect: (qid: keyof Answers, key: OptionKey) => void;
  onBack: () => void;
}) {
  const q = QUESTIONS[props.qIndex];
  return (
    <>
      <h2 className="font-display font-extrabold text-xl sm:text-2xl text-white tracking-tight leading-snug mb-1.5">
        {q.text}
      </h2>
      {q.subtitle && (
        <p className="text-panik-text-secondary text-sm font-sans mb-5 leading-relaxed">{q.subtitle}</p>
      )}

      <div role="radiogroup" aria-label={q.text} className="space-y-2.5">
        {q.options.map((o) => {
          const selected = props.selectedKey === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onSelect(q.id, o.key)}
              className={`w-full text-left flex items-start gap-3 p-3.5 rounded-xl border transition-all cursor-pointer ${
                selected
                  ? "border-panik-orange/60 bg-panik-orange/[0.07] ring-2 ring-panik-orange/30"
                  : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.12]"
              }`}
            >
              <span
                aria-hidden="true"
                className={`shrink-0 mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center transition-all ${
                  selected ? "border-panik-orange text-panik-orange" : "border-white/20"
                }`}
              >
                {selected && <Check className="w-3 h-3 stroke-[3.5]" />}
              </span>
              <span className={`flex-1 text-sm leading-relaxed font-sans ${selected ? "text-white" : "text-white/80"}`}>
                {o.label}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={props.onBack}
        className="mt-6 flex items-center gap-1.5 text-xs font-mono text-panik-text-secondary hover:text-white transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back</span>
      </button>
    </>
  );
}

// ── Reveal step (AI analyzer) ───────────────────────────────────────────────
const ALIGN_COPY: Record<string, { label: string; cls: string }> = {
  aligned: { label: "Matches your answers", cls: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" },
  understated: { label: "Riskier than you said", cls: "text-panik-orange border-panik-orange/30 bg-panik-orange/10" },
  overstated: { label: "Tamer than you said", cls: "text-sky-400 border-sky-400/30 bg-sky-400/10" },
};

function RevealStep(props: {
  phase: ReturnType<typeof useWalletProfile>["phase"];
  data: WalletProfileData | null;
  quiz: ProfileResult;
  onEnter: () => void;
}) {
  const { phase, data, quiz } = props;

  // Loading — the background scan hasn't resolved yet.
  if (phase === "scanning" || phase === "revealing" || phase === "idle") {
    return (
      <div className="py-8 flex flex-col items-center text-center">
        <Loader2 className="w-7 h-7 text-panik-orange animate-spin mb-4" />
        <h2 className="font-display font-extrabold text-xl text-white tracking-tight mb-1.5">
          Reading your on-chain history…
        </h2>
        <p className="text-panik-text-secondary text-sm font-sans max-w-xs leading-relaxed">
          Scanning your lifetime lending activity across every chain to profile your DeFi persona.
        </p>
      </div>
    );
  }

  // Graceful fallback — API offline, non-EVM wallet, or error: show quiz result.
  if (phase === "error" || !data) {
    return (
      <RevealShell onEnter={props.onEnter} badge={quiz.segmentLabel} headline={`${quiz.riskTierLabel} risk profile`}>
        <p className="text-panik-text-secondary text-sm font-sans leading-relaxed">
          We couldn't read your on-chain history right now, so this is based on your answers. Panik
          will refine it from your live positions once you're in.
        </p>
      </RevealShell>
    );
  }

  // No lending footprint — friendly newcomer card.
  if (data.features.lendingTxCount === 0) {
    return (
      <RevealShell onEnter={props.onEnter} badge={data.archetype} headline={data.tagline}>
        <p className="text-panik-text-secondary text-sm font-sans leading-relaxed">{data.description}</p>
      </RevealShell>
    );
  }

  // Full combined reveal.
  const align = data.alignment ? ALIGN_COPY[data.alignment] : null;
  const ratioPct = Math.round((data.features.borrowToDepositRatio ?? 0) * 100);
  return (
    <RevealShell onEnter={props.onEnter} badge={data.archetype} headline={data.tagline}>
      <p className="text-panik-text-secondary text-sm font-sans leading-relaxed mb-4">{data.description}</p>

      {/* Stated vs revealed */}
      <div className="flex items-center gap-2 mb-4 text-[11px] font-mono">
        <span className="px-2 py-1 rounded-md border border-white/10 bg-white/[0.03] text-white/70">
          You said: <span className="text-white uppercase">{quiz.riskProfile3}</span>
        </span>
        <span className="text-panik-text-secondary">→</span>
        <span className="px-2 py-1 rounded-md border border-white/10 bg-white/[0.03] text-white/70">
          On-chain: <span className="text-white uppercase">{data.profile}</span>
        </span>
        {align && (
          <span className={`ml-auto px-2 py-1 rounded-md border font-bold uppercase tracking-wide ${align.cls}`}>
            {align.label}
          </span>
        )}
      </div>

      {/* Data chips */}
      <div className="grid grid-cols-2 gap-2 mb-1">
        <Chip k="Chains" v={String(data.features.chainsActive)} />
        <Chip k="Protocols" v={String(data.features.protocolsUsed)} />
        <Chip k="Leverage" v={`${ratioPct}% borrow/deposit`} />
        <Chip k="Liquidations" v={String(data.features.liquidations)} />
      </div>
    </RevealShell>
  );
}

function Chip(props: { k: string; v: string }) {
  return (
    <div className="px-3 py-2 rounded-lg border border-white/[0.07] bg-white/[0.02]">
      <div className="text-[9px] font-mono uppercase tracking-widest text-panik-text-secondary">{props.k}</div>
      <div className="text-sm font-bold text-white mt-0.5 font-mono">{props.v}</div>
    </div>
  );
}

function RevealShell(props: {
  badge: string;
  headline: string;
  children: React.ReactNode;
  onEnter: () => void;
}) {
  return (
    <>
      <div className="inline-flex items-center gap-1.5 mb-3 px-2.5 py-1 rounded-full border border-panik-orange/30 bg-panik-orange/10">
        <Sparkles className="w-3 h-3 text-panik-orange" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-panik-orange font-bold">{props.badge}</span>
      </div>
      <h2 className="font-display font-extrabold text-xl sm:text-2xl text-white tracking-tight leading-snug mb-3">
        {props.headline}
      </h2>
      {props.children}
      <button
        type="button"
        onClick={props.onEnter}
        className="mt-7 w-full h-12 rounded-xl font-mono text-sm font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer bg-panik-orange hover:bg-panik-orange/90 text-white panik-glow-orange"
      >
        <span>Enter Panik</span>
        <ArrowRight className="w-4 h-4" />
      </button>
    </>
  );
}
