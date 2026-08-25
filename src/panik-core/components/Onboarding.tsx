/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldAlert, Sparkles, Wallet, X } from "lucide-react";
import {
  QUESTIONS,
  computeProfile,
  type Answers,
  type OptionKey,
  type ProfileResult,
} from "../lib/profiling";
import { useWalletProfile, type WalletProfileData } from "../lib/profileApi";
import { LAYER, SCRIM } from "../ui";

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

/**
 * Why the overlay is open. The three entry points want three different things,
 * and an onboarded user re-entering must never be told they are on step 1 of a
 * first run: "switch-wallet" still asks for an address but says which job it is
 * doing, and "retake-quiz" keeps the bound wallet and opens on question 1.
 */
export type OnboardingMode = "first-run" | "switch-wallet" | "retake-quiz";

/**
 * What the wallet step says, per job it is doing.
 *
 * A module-level table rather than a nested ternary building three object
 * literals on every render: the copy is compile-time constant, and the ternary
 * put its three variants far enough apart that "Switch wallet" and "Add a
 * wallet" could drift into two different explanations of the same field.
 */
const WALLET_COPY = {
  "first-run": {
    label: "Step 1: your wallet",
    title: "Start with your wallet",
    blurb:
      "Paste your wallet address. Panik reads its public history while you answer a few questions.",
  },
  switch: {
    label: "Switch wallet",
    title: "Switch wallet",
    blurb:
      "Paste the address Panik should watch instead. An address you have onboarded before skips the questions.",
  },
  add: {
    label: "Add a wallet",
    title: "Add a wallet",
    blurb:
      "Paste the address Panik should watch. An address you have onboarded before skips the questions.",
  },
} as const;

type WalletCopy = (typeof WALLET_COPY)[keyof typeof WALLET_COPY];

interface OnboardingProps {
  /** Called with the computed (quiz) profile + the wallet address. */
  onComplete: (result: ProfileResult, wallet: string) => void;
  /**
   * Profiles from previous onboardings, keyed by lowercase wallet. A wallet
   * found here completes IMMEDIATELY with its saved answers - the quiz is
   * never asked twice for the same address.
   */
  savedProfiles?: Record<string, ProfileResult>;
  /**
   * When set, a close button is shown (wallet-switch flow). First-run
   * onboarding omits it - completing the flow is mandatory there.
   */
  onCancel?: () => void;
  mode?: OnboardingMode;
  /** The bound wallet. "retake-quiz" completes against it and skips its step. */
  initialWallet?: string;
}

export function Onboarding({
  onComplete,
  savedProfiles,
  onCancel,
  mode = "first-run",
  initialWallet,
}: OnboardingProps) {
  /**
   * The wallet a retake completes against, and the ONE expression of that
   * decision: four things follow from it (the opening step, the pre-filled
   * field, the background scan, and the progress denominator) and they were
   * four separate re-derivations of the same two operands.
   *
   * Undefined covers "not retaking" and "retaking with nothing to retake
   * against": a retake with no bound wallet degrades to the wallet flow rather
   * than opening a quiz whose answer lands nowhere.
   */
  const retakeWallet = mode === "retake-quiz" ? initialWallet : undefined;
  const startStep = retakeWallet ? 1 : WALLET_STEP;

  const [step, setStep] = useState(startStep);        // 0 wallet, 1..5 questions, 6 reveal
  const [answers, setAnswers] = useState<Answers>({});
  const [wallet, setWallet] = useState(retakeWallet ?? "");
  const [walletError, setWalletError] = useState("");
  const [exiting, setExiting] = useState(false);

  const profile = useWalletProfile();
  // Destructured because the effect below depends on it: `profile` is a fresh
  // object every render, so depending on the hook itself re-ran the effect on
  // every one of them. `start` is a `useCallback` with no deps and is stable.
  const { start } = profile;
  const resolveStarted = useRef(false);
  const scanStarted = useRef(false);

  const walletValid = isPlausibleWalletAddress(wallet);
  const onWalletStep = step === WALLET_STEP;
  const onReveal = step === REVEAL_STEP;
  const qIndex = step - 1; // question index for steps 1..5
  // Measured from this flow's own first step, so a mode that skips the wallet
  // step opens at 0% instead of claiming a step the user was never shown.
  const progressPct = Math.round(((step - startStep) / (REVEAL_STEP - startStep)) * 100);

  // The wallet step is what normally fires the background scan, so a flow that
  // skips it has to start the scan here or the reveal has nothing to poll. The
  // ref keeps it to one scan; the deps keep it from being re-evaluated on every
  // render to find that out.
  useEffect(() => {
    if (retakeWallet && !scanStarted.current) {
      scanStarted.current = true;
      void start(retakeWallet);
    }
  }, [retakeWallet, start]);

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
    const trimmed = wallet.trim();
    // Returning wallet: restore its saved profile and skip the quiz entirely.
    const saved = savedProfiles?.[trimmed.toLowerCase()];
    if (saved) {
      setExiting(true);
      window.setTimeout(() => onComplete(saved, trimmed), 320);
      return;
    }
    void profile.start(trimmed); // fire the background scan now
    setStep(1);
  };

  const selectAnswer = (qid: keyof Answers, key: OptionKey) => {
    setAnswers((prev) => ({ ...prev, [qid]: key }));
    // Auto-advance; after the last question, go to the reveal.
    window.setTimeout(() => setStep((s) => Math.min(s + 1, REVEAL_STEP)), 280);
  };

  const goBack = () => setStep((s) => Math.max(startStep, s - 1));

  const handleEnter = () => {
    const result = computeProfile(answers);
    setExiting(true);
    window.setTimeout(() => onComplete(result, wallet.trim()), 320);
  };

  const handleWalletChange = (value: string) => {
    setWallet(value);
    if (walletError) setWalletError("");
  };

  const walletCopy =
    WALLET_COPY[mode === "first-run" ? "first-run" : initialWallet ? "switch" : "add"];

  const stepLabel = onWalletStep
    ? walletCopy.label
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
          /* The app's one scrim and one overlay rung, from `ui/overlay`. This
             was `bg-black/80 backdrop-blur-md` against the exit flow's
             `bg-black/70 backdrop-blur-sm` and the sheet's surface token. */
          className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4 sm:p-6 ${SCRIM}`}
        >

          <motion.div
            initial={{ scale: 0.96, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-lg panik-glass rounded-lg border border-border-subtle bg-surface-raised/95 shadow-2xl overflow-hidden"
          >
            <div className="h-1 w-full bg-gradient-to-r from-white/0 via-white/20 to-white/0" />

            <div className="p-7 sm:p-9">
              {/* Header: brand + step indicator */}
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2.5">
                  <img src="/panik-mark.svg" alt="PANIK" width={28} height={28} style={{ objectFit: "contain" }} />
                  <span className="font-sans font-extrabold text-base text-text-primary leading-none">PANIK</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-2xs font-sans text-text-secondary">
                    {stepLabel}
                  </span>
                  {onCancel && (
                    <button
                      type="button"
                      onClick={onCancel}
                      aria-label={retakeWallet ? "Cancel retaking the questions" : "Cancel wallet change"}
                      title={retakeWallet ? "Keep your current risk profile" : "Keep current wallet"}
                      className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              <div className="h-1 w-full bg-white/[0.05] rounded-full overflow-hidden mb-7">
                <motion.div
                  className="h-full bg-text-primary rounded-full"
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
                    copy={walletCopy}
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
                    onBack={step > startStep ? goBack : undefined}
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
  /** One entry of `WALLET_COPY`, so the title and the blurb cannot be paired
      from two different variants. */
  copy: WalletCopy;
  wallet: string;
  walletValid: boolean;
  walletError: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <h2 className="font-sans font-extrabold text-2xl text-text-primary tracking-tight mb-1.5">
        {props.copy.title}
      </h2>
      <p className="text-text-secondary text-sm font-sans mb-6 leading-relaxed">
        {props.copy.blurb}
      </p>

      <div className="relative">
        <Wallet className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary pointer-events-none" />
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
          className={`w-full h-12 pl-10 pr-4 rounded-md bg-surface-sunken border text-sm font-sans text-text-primary placeholder:text-text-muted transition-all ${
            props.walletError ? "border-risk-critical/50 focus:border-risk-critical/70" : "border-border-strong focus:border-border-strong"
          }`}
        />
      </div>

      {props.walletError && (
        <p id="wallet-error" role="alert" className="mt-2.5 flex items-center gap-1.5 text-risk-critical text-xs font-sans">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{props.walletError}</span>
        </p>
      )}

      <button
        type="button"
        onClick={props.onSubmit}
        disabled={!props.walletValid}
        className="mt-7 w-full h-12 rounded-md font-sans text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-text-primary hover:opacity-90 text-surface-base disabled:bg-white/[0.06] disabled:text-text-secondary disabled:shadow-none"
      >
        <span>Continue</span>
        <ArrowRight className="w-4 h-4" />
      </button>
      <p className="mt-3 text-center text-2xs font-sans text-text-muted">
        Read-only. Panik never moves funds.
      </p>
    </>
  );
}

// ── Question step ───────────────────────────────────────────────────────────
function QuestionStep(props: {
  qIndex: number;
  selectedKey: OptionKey | undefined;
  onSelect: (qid: keyof Answers, key: OptionKey) => void;
  /** Absent on the first step of the flow, where there is nothing behind it. */
  onBack?: () => void;
}) {
  const q = QUESTIONS[props.qIndex];
  return (
    <>
      <h2 className="font-sans font-extrabold text-lg sm:text-2xl text-text-primary tracking-tight leading-snug mb-1.5">
        {q.text}
      </h2>
      {q.subtitle && (
        <p className="text-text-secondary text-sm font-sans mb-5 leading-relaxed">{q.subtitle}</p>
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
              className={`w-full text-left flex items-start gap-3 p-3.5 rounded-md border transition-all cursor-pointer ${
                selected
                  ? "border-border-strong bg-white/[0.05] ring-2 ring-border-strong"
                  : "border-border-subtle bg-white/[0.02] hover:bg-white/[0.04] hover:border-border-strong"
              }`}
            >
              <span
                aria-hidden="true"
                className={`shrink-0 mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center transition-all ${
                  selected ? "border-text-primary text-text-primary" : "border-border-subtle"
                }`}
              >
                {selected && <Check className="w-3 h-3 stroke-[3.5]" />}
              </span>
              <span className={`flex-1 text-sm leading-relaxed font-sans ${selected ? "text-text-primary" : "text-text-secondary"}`}>
                {o.label}
              </span>
            </button>
          );
        })}
      </div>

      {props.onBack && (
        <button
          type="button"
          onClick={props.onBack}
          className="mt-6 flex items-center gap-1.5 text-xs font-sans text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back</span>
        </button>
      )}
    </>
  );
}

// ── Reveal step (AI analyzer) ───────────────────────────────────────────────
const ALIGN_COPY: Record<string, { label: string; cls: string }> = {
  aligned: { label: "Matches your answers", cls: "text-risk-low border-risk-low/30 bg-risk-low/10" },
  understated: { label: "Riskier than you said", cls: "text-text-primary border-border-subtle bg-white/[0.06]" },
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
        <Loader2 className="w-7 h-7 text-text-primary animate-spin mb-4" />
        <h2 className="font-sans font-extrabold text-lg text-text-primary tracking-tight mb-1.5">
          Reading your on-chain history…
        </h2>
      </div>
    );
  }

  // Graceful fallback — API offline, non-EVM wallet, or error: show quiz result.
  if (phase === "error" || !data) {
    return (
      <RevealShell onEnter={props.onEnter} badge={quiz.segmentLabel} headline={`${quiz.riskTierLabel} risk profile`}>
        <p className="text-text-secondary text-sm font-sans leading-relaxed">
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
        <p className="text-text-secondary text-sm font-sans leading-relaxed">{data.description}</p>
      </RevealShell>
    );
  }

  // Full combined reveal.
  const align = data.alignment ? ALIGN_COPY[data.alignment] : null;
  const ratioPct = Math.round((data.features.borrowToDepositRatio ?? 0) * 100);
  return (
    <RevealShell onEnter={props.onEnter} badge={data.archetype} headline={data.tagline}>
      <p className="text-text-secondary text-sm font-sans leading-relaxed mb-4">{data.description}</p>

      {/* Stated vs revealed */}
      <div className="flex items-center gap-2 mb-4 text-2xs font-sans">
        <span className="px-2 py-1 rounded-sm border border-border-subtle bg-white/[0.03] text-text-secondary">
          You said: <span className="text-text-primary">{quiz.riskProfile3}</span>
        </span>
        <span className="text-text-secondary">→</span>
        <span className="px-2 py-1 rounded-sm border border-border-subtle bg-white/[0.03] text-text-secondary">
          On-chain: <span className="text-text-primary">{data.profile}</span>
        </span>
        {align && (
          <span className={`ml-auto px-2 py-1 rounded-sm border font-bold tracking-wide ${align.cls}`}>
            {align.label}
          </span>
        )}
      </div>

      {/* What was read off the chain, as labelled facts. */}
      <div className="grid grid-cols-2 gap-2 mb-1">
        <Fact k="Chains" v={String(data.features.chainsActive)} />
        <Fact k="Protocols" v={String(data.features.protocolsUsed)} />
        <Fact k="Leverage" v={`${ratioPct}% borrow/deposit`} />
        <Fact k="Liquidations" v={String(data.features.liquidations)} />
      </div>
    </RevealShell>
  );
}

/**
 * A label over a figure, in a grid cell. Named `Fact` rather than `Chip`, which
 * is what it was: `ui/Chip` is a one-line neutral marker beside something, and
 * two different components answering to one name in one codebase is how a
 * reader ends up importing the wrong one.
 */
function Fact(props: { k: string; v: string }) {
  return (
    <div className="px-3 py-2 rounded-md border border-border-subtle bg-white/[0.02]">
      <div className="text-2xs font-sans text-text-secondary">{props.k}</div>
      <div className="text-sm font-bold text-text-primary mt-0.5 font-sans tabular-nums">{props.v}</div>
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
      <div className="inline-flex items-center gap-1.5 mb-3 px-2.5 py-1 rounded-full border border-border-subtle bg-white/[0.06]">
        <Sparkles className="w-3 h-3 text-text-primary" />
        <span className="text-2xs font-sans text-text-primary font-bold">{props.badge}</span>
      </div>
      <h2 className="font-sans font-extrabold text-lg sm:text-2xl text-text-primary tracking-tight leading-snug mb-3">
        {props.headline}
      </h2>
      {props.children}
      <button
        type="button"
        onClick={props.onEnter}
        className="mt-7 w-full h-12 rounded-md font-sans text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer bg-text-primary hover:opacity-90 text-surface-base"
      >
        <span>Enter Panik</span>
        <ArrowRight className="w-4 h-4" />
      </button>
    </>
  );
}
