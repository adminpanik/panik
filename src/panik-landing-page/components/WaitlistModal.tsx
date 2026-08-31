/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Wallet, X } from "lucide-react";
import { Button, Card, Chip, LAYER, Notice, SCRIM, TextField } from "../../panik-core/ui";
import { truncateAddress } from "../../panik-core/lib/utils";
import { MarkPlate } from "./MarkPlate";
import {
  submitSignup, checkEmailExists, deriveAppetite, isValidEvmAddress, stripAddressInvisibles, connectWallet,
  type SignupAnswers, type Appetite, type WalletRdns,
} from "../lib/waitlist";

/**
 * The signup flow, restyled onto the neo-brutalist primitives. THE LOGIC IS
 * UNCHANGED: the same five questions with the same option keys (they are the
 * DB's CHECK lists), the same draft persistence, the same honeypot, the same
 * `submitSignup` payload. Only the pixels moved.
 *
 * Two things went out with the old skin rather than being ported. The spinner:
 * this system has no motion, so a control that is working says so in its label
 * ("Checking", "Submitting") and stays disabled. And the MetaMask and Coinbase
 * marks: they were two hand-drawn approximations of somebody else's logo, which
 * is both the icon rule and a trademark question, so the wallet choices are
 * their names now.
 */

// ── 5 qualification questions (keys MUST match the DB CHECK lists) ────────────
type Single = { id: "q1" | "q2" | "q5"; kind: "single"; text: string; hint?: string; options: { key: string; label: string }[] };
type Multi = { id: "q3" | "q4"; kind: "multi"; max?: number; text: string; hint: string; options: { key: string; label: string }[] };
type Question = Single | Multi;

const QUESTIONS: Question[] = [
  {
    id: "q1", kind: "single",
    text: "How actively do you use DeFi lending or borrowing right now?",
    options: [
      { key: "never", label: "I have never borrowed or lent on a DeFi protocol" },
      { key: "tried", label: "I have tried it but do not use it regularly" },
      { key: "active_1_2", label: "I actively manage 1 to 2 positions, check at least weekly" },
      { key: "active_3_plus", label: "I actively manage 3+ positions across protocols, weekly" },
    ],
  },
  {
    id: "q2", kind: "single",
    text: "Have you ever been liquidated or come close to liquidation?",
    options: [
      { key: "no_unsure", label: "No, and I am not sure what triggers it" },
      { key: "no_managed", label: "No, but I actively manage my health factor to avoid it" },
      { key: "yes_caught", label: "Yes, it caught me off guard at least once" },
      { key: "yes_accept", label: "Yes, I accept liquidation as part of how I trade" },
    ],
  },
  {
    id: "q3", kind: "multi",
    text: "How do you currently track the risk of your open positions?",
    hint: "Select all that apply",
    options: [
      { key: "manual_dashboard", label: "I check the protocol dashboard manually when I remember" },
      { key: "portfolio_tracker", label: "I use a portfolio tracker (DeBank, Zerion, DeFi Saver)" },
      { key: "custom_alerts", label: "I set up my own alerts (scripts, third-party apps)" },
      { key: "protocol_alerts", label: "I rely on liquidation price alerts from the protocol itself" },
    ],
  },
  {
    id: "q4", kind: "multi", max: 2,
    text: "Your biggest frustration managing DeFi positions today?",
    hint: "Pick up to two",
    options: [
      { key: "no_unified_view", label: "No unified view. I check multiple dashboards for full exposure" },
      { key: "slow_reaction", label: "Slow reaction. By the time I knew, it was too late to act well" },
      { key: "silent_risk", label: "Silent risk. I had no alerts set up and missed a critical change" },
      { key: "execution_friction", label: "Execution friction. Acting across protocols takes too long" },
    ],
  },
  {
    id: "q5", kind: "single",
    text: "How much do you currently have in active DeFi positions?",
    hint: "Collateral + borrowed, current market value",
    options: [
      { key: "lt_1k", label: "Less than $1,000" },
      { key: "1k_10k", label: "$1,000 to $10,000" },
      { key: "10k_50k", label: "$10,000 to $50,000" },
      { key: "50k_200k", label: "$50,000 to $200,000" },
      { key: "gt_200k", label: "More than $200,000" },
    ],
  },
];

const APPETITE_LABEL: Record<Appetite, string> = { conservative: "Conservative", moderate: "Moderate", aggressive: "Aggressive" };
const APPETITE_BLURB: Record<Appetite, string> = {
  conservative: "You prize safety, so PANIK will surface risk early and favour a wide buffer.",
  moderate: "Balanced. PANIK will flag meaningful risk while leaving room to run.",
  aggressive: "You run lean and chase yield, so PANIK will alert mainly near real danger.",
};
const Q_SUMMARY_LABEL: Record<string, Record<string, string>> = Object.fromEntries(
  QUESTIONS.map((q) => [q.id, Object.fromEntries(q.options.map((o) => [o.key, o.label]))]),
);

interface Answers {
  q1: string | null; q2: string | null; q5: string | null;
  q3: string[]; q4: string[];
}
const EMPTY: Answers = { q1: null, q2: null, q5: null, q3: [], q4: [] };
const DRAFT_KEY = "panik_waitlist_draft";

/**
 * An answer row. Selected is the lavender plate, which is the highlight token
 * and is nowhere on the risk ramp: a reader picking "yes, I have been
 * liquidated" must not have the page colour their own answer as a warning.
 */
const OPTION_BOX = "flex w-full cursor-pointer items-start gap-3 hard-edge p-3 text-left";

/**
 * The two injected wallets `connectWallet` knows how to reach, by their EIP-6963
 * rdns. Hoisted beside the other static data in this file so step 4 is not
 * rebuilding the pair on every keystroke of the address field.
 */
const WALLET_OPTIONS = [
  { rdns: "io.metamask", label: "MetaMask" },
  { rdns: "com.coinbase.wallet", label: "Coinbase Wallet" },
] as const satisfies readonly { rdns: WalletRdns; label: string }[];

/**
 * The heading a step opens with. Three of the five steps had their own copy of
 * the same `h2` plus lead paragraph, and two of the three had already drifted
 * apart on the gap between them.
 *
 * It carries `id="waitlist-heading"`, which the dialog's `aria-labelledby`
 * points at: exactly one step is mounted at a time, so the id is unique, and
 * naming it here is what stops a new step shipping without one.
 */
function StepHeading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 id="waitlist-heading" className="text-2xl font-black uppercase tracking-tight text-text-primary">
        {title}
      </h2>
      <p className="text-sm text-text-secondary">{children}</p>
    </div>
  );
}

/** The step-back control, which is the same button on three steps. */
function BackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" onClick={onClick} disabled={disabled}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Back
    </Button>
  );
}

interface WaitlistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoinSuccess: () => void;
}

export function WaitlistModal({ isOpen, onClose, onJoinSuccess }: WaitlistModalProps) {
  const [step, setStep] = useState(1);
  const [qIndex, setQIndex] = useState(0);

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [notes, setNotes] = useState("");
  const [honeypot, setHoneypot] = useState("");

  // wallet
  const [wallet, setWallet] = useState("");
  const [walletError, setWalletError] = useState("");
  const [connectingWallet, setConnectingWallet] = useState<WalletRdns | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);

  // submit
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [position, setPosition] = useState<number | null>(null);

  // Q4 max-selection inline feedback
  const [capMsg, setCapMsg] = useState(false);

  // On open: restore in-progress draft or start fresh. Always reset transient states.
  useEffect(() => {
    if (!isOpen) return;
    setEmailError(""); setHoneypot(""); setCapMsg(false);
    setWallet(""); setWalletError(""); setConnectingWallet(null); setShowManualInput(false);
    setSubmitting(false); setSubmitError(""); setPosition(null);
    const saved = sessionStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        const d = JSON.parse(saved);
        setStep(d.step ?? 1); setQIndex(d.qIndex ?? 0);
        setEmail(d.email ?? "");
        setAnswers({ ...EMPTY, ...(d.answers ?? {}) });
        setNotes(d.notes ?? "");
        return;
      } catch { /* fall through to fresh start */ }
    }
    setStep(1); setQIndex(0);
    setEmail(""); setAnswers(EMPTY); setNotes("");
  }, [isOpen]);

  // Continuously persist draft while modal is open (not after success).
  useEffect(() => {
    if (!isOpen || step === 5) return;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, qIndex, email, answers, notes }));
  }, [isOpen, step, qIndex, email, answers, notes]);

  // Clear cap message when user moves to a different question.
  useEffect(() => { setCapMsg(false); }, [qIndex]);

  // ESC key closes the modal (same guard as the backdrop click).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((step >= 2 || (step === 1 && email.trim())) && step < 5) {
        if (!window.confirm("Leave the waitlist signup? Your progress is saved for this session.")) return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, step, email, onClose]);

  if (!isOpen) return null;

  const appetite: Appetite | null =
    answers.q1 && answers.q2 && answers.q5
      ? deriveAppetite(answers.q1 as SignupAnswers["q1DefiActivity"], answers.q2 as SignupAnswers["q2Liquidation"], answers.q5 as SignupAnswers["q5PortfolioSize"])
      : null;

  const handleEmailNext = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError("Please enter a valid email address");
      return;
    }
    setCheckingEmail(true);
    setEmailError("");
    const exists = await checkEmailExists(email);
    setCheckingEmail(false);
    if (exists) {
      setEmailError("You have already signed up with this email. We will be in touch when early access opens.");
      return;
    }
    setStep(2); setQIndex(0);
  };

  const q = QUESTIONS[qIndex];
  const selectSingle = (id: "q1" | "q2" | "q5", key: string) => {
    setAnswers((a) => ({ ...a, [id]: key }));
    if (qIndex < QUESTIONS.length - 1) setTimeout(() => setQIndex((prev) => prev + 1), 350);
  };
  const toggleMulti = (id: "q3" | "q4", key: string, max?: number) =>
    setAnswers((a) => {
      const cur = a[id];
      if (cur.includes(key)) return { ...a, [id]: cur.filter((k) => k !== key) };
      if (max && cur.length >= max) return a;
      return { ...a, [id]: [...cur, key] };
    });

  const currentAnswered = q.kind === "single" ? Boolean(answers[q.id]) : true; // multi is optional

  const handleQuestionNext = () => {
    if (!currentAnswered) return;
    if (qIndex < QUESTIONS.length - 1) setQIndex(qIndex + 1);
    else setStep(3);
  };
  const handleQuestionBack = () => {
    if (qIndex > 0) setQIndex(qIndex - 1);
    else setStep(1);
  };

  const handleConnect = async (rdns: WalletRdns) => {
    setWalletError(""); setConnectingWallet(rdns);
    const timeoutId = setTimeout(() => {
      setConnectingWallet(null);
      setWalletError("Connection timed out. Try again or paste your address below.");
    }, 30_000);
    try {
      setWallet(await connectWallet(rdns));
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Wallet connection failed");
    } finally {
      clearTimeout(timeoutId);
      setConnectingWallet(null);
    }
  };

  const quizComplete = Boolean(answers.q1 && answers.q2 && answers.q5);
  /** Read three times on step 4: the guard, the confirmation line, the submit. */
  const walletValid = isValidEvmAddress(wallet);

  const mapSubmitError = (error: string | undefined): string => {
    if (!error) return "Something went wrong. Please try again.";
    if (error === "config_missing") return "Signup is not configured yet. Please try again later.";
    if (error === "network") return "Connection failed. Please check your internet and retry.";
    if (error.includes("23505") || error.includes("http_409") || error.includes("duplicate"))
      return "This email is already registered.";
    return "Something went wrong. Please try again.";
  };

  const handleSubmit = async () => {
    if (!walletValid) { setWalletError("Enter a valid EVM address (0x + 40 hex chars) to continue."); return; }
    if (!quizComplete || submitting) return;
    setSubmitting(true); setSubmitError("");
    const result = await submitSignup({
      email: email.trim(),
      walletAddress: wallet.trim(),
      q1DefiActivity: answers.q1 as SignupAnswers["q1DefiActivity"],
      q2Liquidation: answers.q2 as SignupAnswers["q2Liquidation"],
      q3RiskTracking: answers.q3 as SignupAnswers["q3RiskTracking"],
      q4Frustrations: answers.q4 as SignupAnswers["q4Frustrations"],
      q5PortfolioSize: answers.q5 as SignupAnswers["q5PortfolioSize"],
      additionalNotes: notes.trim() || undefined,
      honeypot,
    });
    setSubmitting(false);
    if (!result.ok) {
      const isDuplicate = result.error?.includes("23505") || result.error?.includes("http_409") || result.error?.includes("duplicate");
      if (isDuplicate) {
        sessionStorage.removeItem(DRAFT_KEY);
        setStep(1); setQIndex(0);
        setEmailError("This email is already on the waitlist.");
        return;
      }
      setSubmitError(mapSubmitError(result.error));
      return;
    }
    setPosition(result.position ?? null);
    onJoinSuccess();
    setStep(5);
    sessionStorage.removeItem(DRAFT_KEY);
  };

  const requestClose = () => {
    if ((step >= 2 || (step === 1 && email.trim())) && step < 5) {
      if (!window.confirm("Leave the waitlist signup? Your progress is saved for this session.")) return;
    }
    onClose();
  };

  const pct = Math.round((step / 4) * 100);

  return (
    <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4">
      {/* Pointer affordance only: `tabIndex={-1}` keeps a full-screen control
          out of the tab order, where it would be a stop that says nothing. The
          keyboard route out is Escape or the close button, both of which run
          the same guard. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={requestClose}
        className={`fixed inset-0 cursor-pointer ${SCRIM} ${LAYER.scrim}`}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-heading"
        className={`relative my-8 w-full max-w-2xl hard-edge bg-surface-overlay p-6 shadow-hard md:p-8 ${LAYER.modal}`}
      >
        {/* Header */}
        <div className="mb-6 flex items-center justify-between gap-4">
          <Chip>Early access</Chip>
          <button
            type="button"
            onClick={requestClose}
            className="flex size-8 cursor-pointer items-center justify-center text-text-primary"
            aria-label="Close signup"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>

        {/* Progress. A bordered track with a cobalt fill: the width is a
            measurement, so it is the one inline style on this surface. */}
        {step < 5 && (
          <div className="mb-8 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4 label-type text-2xs text-text-secondary">
              <span>Waitlist signup</span>
              <span className="font-mono">
                Step {step} of 4{step === 2 ? ` / Q${qIndex + 1} of ${QUESTIONS.length}` : ""}
              </span>
            </div>
            <div className="h-3 w-full hard-edge bg-surface-sunken">
              <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {/* Honeypot, off-screen, not in tab order. Non-semantic name + autoComplete
            off so password managers don't autofill it and drop a real signup. */}
        <input type="text" name="panik_hp_field" tabIndex={-1} autoComplete="off" aria-hidden="true" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} className="absolute h-0 w-0 opacity-0 pointer-events-none -left-[9999px]" />

        {/* STEP 1: EMAIL */}
        {step === 1 && (
          <div className="flex flex-col gap-6">
            <StepHeading title="Join the early access list">
              Five questions about how you manage positions, then a wallet address to reserve your
              place. It takes about a minute.
            </StepHeading>
            <form noValidate onSubmit={handleEmailNext} className="flex flex-col gap-4">
              <TextField
                type="email"
                id="modal-email-input"
                label="Email address"
                inputMode="email"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-describedby={emailError ? "email-error" : undefined}
                required
              />
              {emailError && <div id="email-error"><Notice text={emailError} /></div>}
              <Button type="submit" disabled={!email || checkingEmail} className="w-full">
                {checkingEmail ? "Checking" : "Continue"}
                {!checkingEmail && <ArrowRight aria-hidden="true" className="size-4" />}
              </Button>
            </form>
          </div>
        )}

        {/* STEP 2: PAGINATED MULTIPLE-CHOICE QUIZ */}
        {step === 2 && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h2 id="waitlist-heading" className="label-type text-xs text-text-secondary">
                Building your risk profile
              </h2>
              <h3 id={`q-heading-${q.id}`} className="text-lg font-black tracking-tight text-text-primary">
                {q.text}
              </h3>
              {q.hint && <p className="label-type text-xs text-text-secondary">{q.hint}</p>}
            </div>

            <div
              role={q.kind === "single" ? "radiogroup" : "group"}
              aria-labelledby={`q-heading-${q.id}`}
              className="flex flex-col gap-3"
            >
              {q.options.map((o) => {
                const selected = q.kind === "single" ? answers[q.id] === o.key : answers[q.id].includes(o.key);
                const capped = q.kind === "multi" && !selected && answers[q.id].length >= (q.max ?? 99);
                return (
                  <button
                    key={o.key} type="button"
                    role={q.kind === "single" ? "radio" : "checkbox"}
                    aria-checked={selected}
                    onClick={() => {
                      if (q.kind === "single") { selectSingle(q.id, o.key); }
                      else if (capped) { setCapMsg(true); }
                      else { setCapMsg(false); toggleMulti(q.id, o.key, q.max); }
                    }}
                    className={`${OPTION_BOX} ${selected ? "bg-highlight shadow-hard-sm" : "bg-surface-raised"} ${capped ? "opacity-40" : ""}`}
                  >
                    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center hard-edge bg-surface-raised">
                      {selected && <Check className="size-3.5 text-text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-text-primary">{o.label}</span>
                  </button>
                );
              })}
            </div>
            {capMsg && q.kind === "multi" && q.max && (
              <p role="status" aria-live="polite" className="text-xs text-text-secondary">
                You can only select up to {q.max} options.
              </p>
            )}

            {/* optional notes appear on the last question */}
            {qIndex === QUESTIONS.length - 1 && (
              <div className="flex flex-col gap-2">
                <label htmlFor="waitlist-notes" className="block label-type text-xs text-text-primary">
                  Anything else? (optional)
                </label>
                {/* Not `FIELD_BOX`: that constant pins a 48px height to match a
                    button beside it, and a two-row textarea has neither. The
                    rest of the treatment is the same plate and the same edge. */}
                <textarea id="waitlist-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Protocols you use, alerting strategies, features you want"
                  className="w-full resize-none hard-edge bg-surface-raised p-3 font-sans text-sm text-text-primary placeholder:text-text-muted" />
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <BackButton onClick={handleQuestionBack} />
              <Button onClick={handleQuestionNext} disabled={!currentAnswered}>
                {qIndex === QUESTIONS.length - 1 ? "Review" : "Next"}
                <ChevronRight aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: REVIEW */}
        {step === 3 && (
          <div className="flex flex-col gap-6">
            <StepHeading title="Check your answers">
              Review before you reserve your place.
            </StepHeading>

            <Card tone="set-back" className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="label-type text-xs text-text-secondary">Email</span>
                <span className="min-w-0 truncate font-mono text-sm font-bold text-text-primary">{email}</span>
              </div>
              {(["q1", "q2", "q5"] as const).map((id) => (
                <div key={id} className="flex flex-col gap-1">
                  <span className="label-type text-xs text-text-secondary">{QUESTIONS.find((x) => x.id === id)!.text}</span>
                  <span className="text-sm text-text-primary">{answers[id] ? Q_SUMMARY_LABEL[id][answers[id]!] : "Not answered"}</span>
                </div>
              ))}
              {answers.q3.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="label-type text-xs text-text-secondary">Risk tracking</span>
                  <span className="text-sm text-text-primary">{answers.q3.map((k) => Q_SUMMARY_LABEL.q3[k]).join("; ")}</span>
                </div>
              )}
              {answers.q4.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="label-type text-xs text-text-secondary">Biggest frustration</span>
                  <span className="text-sm text-text-primary">{answers.q4.map((k) => Q_SUMMARY_LABEL.q4[k]).join("; ")}</span>
                </div>
              )}
            </Card>

            {appetite && (
              <Card tone="lead" className="flex flex-col gap-1">
                <span className="label-type text-xs text-text-primary">
                  Your profile: {APPETITE_LABEL[appetite]}
                </span>
                <p className="text-sm text-text-primary">{APPETITE_BLURB[appetite]}</p>
              </Card>
            )}

            <div className="flex items-center justify-between gap-4">
              <BackButton onClick={() => { setStep(2); setQIndex(QUESTIONS.length - 1); }} />
              <Button onClick={() => setStep(4)}>
                Continue to wallet
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        )}

        {/* STEP 4: WALLET (required) + SUBMIT */}
        {step === 4 && (
          <div className="flex flex-col gap-6">
            <StepHeading title="Reserve your place">
              An address lets us see which markets to cover for you first. PANIK only reads it:
              nothing here signs a transaction and no key ever leaves your wallet.
            </StepHeading>

            {showManualInput ? (
              <TextField
                id="manual-wallet-input"
                label="Public EVM address"
                mono
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={wallet}
                // Stripped here, not only inside `isValidEvmAddress`: a paste out
                // of a PDF or rich-text doc can carry a zero-width space, soft
                // hyphen, or BOM anywhere in the string, and leaving it in
                // `wallet` would mean the address this modal submits still
                // carries it even once the format check tolerates it.
                onChange={(e) => { setWallet(stripAddressInvisibles(e.target.value)); if (walletError) setWalletError(""); }}
                onBlur={() => {
                  if (wallet && !isValidEvmAddress(wallet))
                    setWalletError("That does not look like a valid EVM address (0x + 40 hex characters).");
                }}
                placeholder="0x"
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {WALLET_OPTIONS.map(({ rdns, label }) => (
                  <Button
                    key={rdns}
                    variant="secondary"
                    disabled={connectingWallet !== null}
                    onClick={() => handleConnect(rdns)}
                  >
                    <Wallet aria-hidden="true" className="size-4" />
                    {connectingWallet === rdns ? "Connecting" : label}
                  </Button>
                ))}
              </div>
            )}

            <Button
              variant="ghost"
              disabled={connectingWallet !== null}
              onClick={() => { if (showManualInput) setWallet(""); setShowManualInput(!showManualInput); setWalletError(""); }}
            >
              {showManualInput ? "Use a browser wallet instead" : "Or paste a wallet address"}
            </Button>

            {wallet && walletValid && connectingWallet === null && (
              <p className="flex items-center gap-2 hard-edge bg-surface-sunken px-3 py-2 font-mono text-xs text-text-primary">
                <Check aria-hidden="true" className="size-4 shrink-0" />
                Reading {truncateAddress(wallet)}
              </p>
            )}
            {walletError && <Notice text={walletError} />}
            {submitError && <Notice text={submitError} />}

            <div className="flex items-center justify-between gap-4">
              <BackButton onClick={() => setStep(3)} disabled={submitting} />
              <Button onClick={handleSubmit} disabled={submitting || !quizComplete || !walletValid}>
                {submitting ? "Submitting" : submitError ? "Retry" : "Join the waitlist"}
                {!submitting && <ArrowRight aria-hidden="true" className="size-4" />}
              </Button>
            </div>
          </div>
        )}

        {/* STEP 5: SUCCESS */}
        {step === 5 && (
          <div className="flex flex-col items-start gap-6">
            <MarkPlate />
            <div className="flex flex-col gap-2">
              <h2 id="waitlist-heading" className="text-2xl font-black uppercase tracking-tight text-text-primary">
                You are on the list
              </h2>
              <p className="text-sm text-text-secondary">
                {position !== null ? (
                  <>You are number <span className="font-mono font-bold text-text-primary">{position}</span> in the queue. </>
                ) : (
                  <>Your place is confirmed. </>
                )}
                We will email you when early access opens.
              </p>
            </div>
            <Card tone="set-back" className="flex w-full flex-col gap-2">
              <span className="truncate text-sm text-text-primary">Email: {email}</span>
              <span className="text-sm text-text-primary">
                Profile: {appetite ? APPETITE_LABEL[appetite] : "Submitted"}
              </span>
              <span className="font-mono text-sm text-text-primary">
                Address: {truncateAddress(wallet)}
              </span>
            </Card>
            <div className="flex flex-wrap items-center gap-4">
              <Button onClick={onClose}>Back to the site</Button>
              <a href="https://x.com/panik_fi" target="_blank" rel="noreferrer noopener" className="flex h-6 items-center text-sm font-bold text-text-primary">
                Follow on X for launch news
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
