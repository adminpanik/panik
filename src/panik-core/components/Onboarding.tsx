/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Sparkles, Wallet, X } from "lucide-react";
import {
  QUESTIONS,
  computeProfile,
  type Answers,
  type OptionKey,
  type ProfileResult,
} from "../lib/profiling";
import { useWalletProfile, type WalletProfileData } from "../lib/profileApi";
import { Button, Chip, Field, LAYER, Notice, SCRIM, Skeleton } from "../ui";

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
 * The wallet step's title, per job it is doing. A module-level table rather
 * than a nested ternary, so the copy is compile-time constant and the three
 * variants cannot drift apart from each other.
 */
const WALLET_COPY = {
  "first-run": { label: "Step 1: your wallet", title: "Start with your wallet" },
  switch: { label: "Switch wallet", title: "Switch wallet" },
  add: { label: "Add a wallet", title: "Add a wallet" },
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
      onComplete(saved, trimmed);
      return;
    }
    void profile.start(trimmed); // fire the background scan now
    setStep(1);
  };

  const selectAnswer = (qid: keyof Answers, key: OptionKey) => {
    setAnswers((prev) => ({ ...prev, [qid]: key }));
    setStep((s) => Math.min(s + 1, REVEAL_STEP));
  };

  const goBack = () => setStep((s) => Math.max(startStep, s - 1));

  const handleEnter = () => {
    onComplete(computeProfile(answers), wallet.trim());
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
    <div
      className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4 sm:p-6 ${SCRIM}`}
    >
      <div className="relative w-full max-w-lg hard-edge shadow-hard bg-surface-raised">
        <div className="p-6 sm:p-8">
          {/* Header: brand + step indicator */}
          <div className="flex items-center justify-between gap-4 border-b-[3px] border-solid border-border-strong pb-4">
            <div className="flex items-center gap-2.5">
              <img src="/panik-mark.svg" alt="" width={28} height={28} style={{ objectFit: "contain" }} />
              <span className="font-sans font-extrabold text-base text-text-primary leading-none">PANIK</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="label-type text-2xs text-text-secondary">{stepLabel}</span>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label={retakeWallet ? "Cancel retaking the questions" : "Cancel wallet change"}
                  title={retakeWallet ? "Keep your current risk profile" : "Keep current wallet"}
                  className="cursor-pointer text-text-secondary hover:text-text-primary"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {/* Progress bar. A flat fill snapped to its width, not animated: this
              look has no transitions, so the bar simply reads the current step
              on every render. */}
          <div className="mt-4 mb-6 h-2 w-full hard-edge bg-surface-sunken">
            <div className="h-full bg-brand" style={{ width: `${progressPct}%` }} />
          </div>

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
        </div>
      </div>
    </div>
  );
}

// ── Wallet step ─────────────────────────────────────────────────────────────
function WalletStep(props: {
  /** One entry of `WALLET_COPY`, so the title cannot be paired with a
      different variant's. */
  copy: WalletCopy;
  wallet: string;
  walletValid: boolean;
  walletError: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <h2 className="mb-4 font-sans text-lg font-black uppercase tracking-tight text-text-primary sm:text-2xl">
        {props.copy.title}
      </h2>

      <Field
        id="onboarding-wallet"
        label="Wallet address"
        mono
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={props.wallet}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && props.walletValid) props.onSubmit();
        }}
        aria-invalid={Boolean(props.walletError)}
      />

      {props.walletError && <Notice text={props.walletError} />}

      <Button
        onClick={props.onSubmit}
        disabled={!props.walletValid}
        className="mt-4 w-full justify-center"
      >
        Continue
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
      <p className="mt-3 text-center font-sans text-2xs text-text-muted">
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
      <h2 className="mb-1.5 font-sans text-lg font-black uppercase tracking-tight text-text-primary sm:text-2xl">
        {q.text}
      </h2>
      {q.subtitle && (
        <p className="mb-5 font-sans text-sm leading-relaxed text-text-secondary">{q.subtitle}</p>
      )}

      <div role="radiogroup" aria-label={q.text} className="space-y-3">
        {q.options.map((o) => {
          const selected = props.selectedKey === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onSelect(q.id, o.key)}
              className={`flex w-full cursor-pointer items-start gap-3 p-3.5 text-left hard-edge font-sans ${
                selected ? "bg-highlight" : "bg-surface-raised hover:bg-highlight"
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center hard-edge ${
                  selected ? "bg-brand" : "bg-surface-raised"
                }`}
              >
                {selected && <Check className="h-3 w-3 stroke-[3.5] text-white" aria-hidden="true" />}
              </span>
              <span className="flex-1 text-sm leading-relaxed text-text-primary">{o.label}</span>
            </button>
          );
        })}
      </div>

      {props.onBack && (
        <button
          type="button"
          onClick={props.onBack}
          className="mt-6 flex cursor-pointer items-center gap-1.5 font-sans text-xs font-bold text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Back</span>
        </button>
      )}
    </>
  );
}

// ── Reveal step (AI analyzer) ───────────────────────────────────────────────
const ALIGN_LABEL: Record<string, string> = {
  aligned: "Matches your answers",
  understated: "Riskier than you said",
  overstated: "Tamer than you said",
};

function RevealStep(props: {
  phase: ReturnType<typeof useWalletProfile>["phase"];
  data: WalletProfileData | null;
  quiz: ProfileResult;
  onEnter: () => void;
}) {
  const { phase, data, quiz } = props;

  // Loading — the background scan hasn't resolved yet. Static hatched blocks,
  // the same "pending" texture as `Skeleton` everywhere else: this look has no
  // spinners, because a moving glyph in a risk product reads as a value
  // changing rather than as a wait.
  if (phase === "scanning" || phase === "revealing" || phase === "idle") {
    return (
      <div className="space-y-3 py-2">
        <h2 className="font-sans text-lg font-black uppercase tracking-tight text-text-primary sm:text-2xl">
          Reading your on-chain history
        </h2>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  // Graceful fallback — API offline, non-EVM wallet, or error: show quiz result.
  if (phase === "error" || !data) {
    return (
      <RevealShell onEnter={props.onEnter} badge={quiz.segmentLabel} headline={`${quiz.riskTierLabel} risk profile`}>
        <p className="font-sans text-sm leading-relaxed text-text-secondary">
          Based on your answers. Panik refines this from your live positions once you are in.
        </p>
      </RevealShell>
    );
  }

  // No lending footprint — friendly newcomer card.
  if (data.features.lendingTxCount === 0) {
    return (
      <RevealShell onEnter={props.onEnter} badge={data.archetype} headline={data.tagline}>
        <p className="font-sans text-sm leading-relaxed text-text-secondary">{data.description}</p>
      </RevealShell>
    );
  }

  // Full combined reveal.
  const alignLabel = data.alignment ? ALIGN_LABEL[data.alignment] : null;
  const ratioPct = Math.round((data.features.borrowToDepositRatio ?? 0) * 100);
  return (
    <RevealShell onEnter={props.onEnter} badge={data.archetype} headline={data.tagline}>
      <p className="mb-4 font-sans text-sm leading-relaxed text-text-secondary">{data.description}</p>

      {/* Stated vs revealed. Neutral chips, not the risk ramp: a quiz answer
          disagreeing with on-chain history is not a risk state. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip>
          You said <span className="font-mono normal-case">{quiz.riskProfile3}</span>
        </Chip>
        <ArrowRight className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />
        <Chip>
          On-chain <span className="font-mono normal-case">{data.profile}</span>
        </Chip>
        {alignLabel && <Chip className="ml-auto">{alignLabel}</Chip>}
      </div>

      {/* What was read off the chain, as labelled facts. */}
      <div className="grid grid-cols-2 gap-2">
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
 * reader ends up importing the wrong one. The figure is Space Mono: every
 * numeral in the product is.
 */
function Fact(props: { k: string; v: string }) {
  return (
    <div className="hard-edge bg-surface-sunken px-3 py-2">
      <div className="font-sans text-2xs text-text-secondary">{props.k}</div>
      <div className="mt-0.5 font-mono text-sm font-bold text-text-primary">{props.v}</div>
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
      <Chip className="mb-3">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        {props.badge}
      </Chip>
      <h2 className="mb-3 font-sans text-lg font-black uppercase leading-snug tracking-tight text-text-primary sm:text-2xl">
        {props.headline}
      </h2>
      {props.children}
      <Button onClick={props.onEnter} className="mt-6 w-full justify-center">
        Enter Panik
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </>
  );
}
