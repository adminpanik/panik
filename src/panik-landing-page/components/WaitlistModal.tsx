/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  X, Mail, ArrowRight, CheckCircle2, ChevronRight, ChevronLeft,
  ShieldAlert, Check, Info, HeartHandshake, Twitter, Wallet, Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  submitSignup, deriveAppetite, isValidEvmAddress, connectWallet,
  waitlistConfigured, type SignupAnswers, type Appetite, type WalletRdns,
} from "../lib/waitlist";

// ── Wallet logos (from the original design) ──────────────────────────────────
const MetaMaskLogo = () => (
  <svg className="w-6 h-6 mr-3" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M29.5 13.5L25.3 4.2C25.1 3.8 24.6 3.6 24.2 3.8L16.2 7.8L8.2 3.8C7.8 3.6 7.3 3.8 7.1 4.2L2.9 13.5C2.7 13.9 2.8 14.4 3.1 14.7L15.3 26.9C15.7 27.3 16.3 27.3 16.7 26.9L28.9 14.7C29.2 14.4 29.3 13.9 29.5 13.5Z" fill="#F6851B" />
    <path d="M16 19.5L10.5 16.5L8.5 17.5L16 23.5L23.5 17.5L21.5 16.5L16 19.5Z" fill="#E2761B" />
  </svg>
);
const CoinbaseLogo = () => (
  <svg className="w-6 h-6 mr-3" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="14" fill="#0052FF" />
    <path d="M9 16C9 12.134 12.134 9 16 9C19.866 9 23 12.134 23 16C23 19.866 19.866 23 16 23C12.134 23 9 19.866 9 16Z" fill="white" />
  </svg>
);

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
      { key: "active_1_2", label: "I actively manage 1–2 positions, check at least weekly" },
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
      { key: "no_unified_view", label: "No unified view — I check multiple dashboards for full exposure" },
      { key: "slow_reaction", label: "Slow reaction — by the time I knew, it was too late to act well" },
      { key: "silent_risk", label: "Silent risk — I had no alerts set up and missed a critical change" },
      { key: "execution_friction", label: "Execution friction — acting across protocols takes too long" },
    ],
  },
  {
    id: "q5", kind: "single",
    text: "How much do you currently have in active DeFi positions?",
    hint: "Collateral + borrowed, current market value",
    options: [
      { key: "lt_1k", label: "Less than $1,000" },
      { key: "1k_10k", label: "$1,000 – $10,000" },
      { key: "10k_50k", label: "$10,000 – $50,000" },
      { key: "50k_200k", label: "$50,000 – $200,000" },
      { key: "gt_200k", label: "More than $200,000" },
    ],
  },
];

const APPETITE_LABEL: Record<Appetite, string> = { conservative: "Conservative", moderate: "Moderate", aggressive: "Aggressive" };
const APPETITE_BLURB: Record<Appetite, string> = {
  conservative: "You prize safety — Panik will surface risk early and favor low-leverage vaults.",
  moderate: "Balanced — Panik will flag meaningful risk while leaving room to run.",
  aggressive: "You run lean and chase yield — Panik will alert mainly near real danger.",
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

interface WaitlistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoinSuccess: (email: string, source: string) => void;
  initialEmail?: string;
}

export function WaitlistModal({ isOpen, onClose, onJoinSuccess, initialEmail = "" }: WaitlistModalProps) {
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
        setEmail(d.email ?? initialEmail);
        setAnswers({ ...EMPTY, ...(d.answers ?? {}) });
        setNotes(d.notes ?? "");
        return;
      } catch { /* fall through to fresh start */ }
    }
    setStep(1); setQIndex(0);
    setEmail(initialEmail); setAnswers(EMPTY); setNotes("");
  }, [isOpen, initialEmail]);

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
  }, [isOpen, step, onClose]);

  if (!isOpen) return null;

  const appetite: Appetite | null =
    answers.q1 && answers.q2 && answers.q5
      ? deriveAppetite(answers.q1 as SignupAnswers["q1DefiActivity"], answers.q2 as SignupAnswers["q2Liquidation"], answers.q5 as SignupAnswers["q5PortfolioSize"])
      : null;

  const handleEmailNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError("Please enter a valid email address");
      return;
    }
    setEmailError("");
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

  const mapSubmitError = (error: string | undefined): string => {
    if (!error) return "Something went wrong. Please try again.";
    if (error === "config_missing") return "Signup is not configured yet. Please try again later.";
    if (error === "network") return "Connection failed. Please check your internet and retry.";
    if (error.includes("23505") || error.includes("http_409") || error.includes("duplicate"))
      return "This email is already registered.";
    return "Something went wrong. Please try again.";
  };

  const handleSubmit = async () => {
    if (!isValidEvmAddress(wallet)) { setWalletError("Enter a valid EVM address (0x + 40 hex chars) to continue."); return; }
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
    onJoinSuccess(email.trim(), appetite ? `${APPETITE_LABEL[appetite]} profile` : "Waitlist");
    setStep(5);
    sessionStorage.removeItem(DRAFT_KEY);
  };

  const pct = Math.round((step / 4) * 100);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overflow-y-auto">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => {
        if ((step >= 2 || (step === 1 && email.trim())) && step < 5) {
          if (!window.confirm("Leave the waitlist signup? Your progress is saved for this session.")) return;
        }
        onClose();
      }} className="absolute inset-0 bg-black/75 backdrop-blur-md" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", duration: 0.5 }}
        className="w-full max-w-[650px] bg-[#0E1016]/95 border border-white/[0.08] hover:border-orange-500/15 p-6 sm:p-10 rounded-2xl relative shadow-2xl backdrop-blur-2xl z-10 my-8"
      >
        <div className="absolute top-0 right-0 w-44 h-44 bg-panik-orange/5 rounded-full blur-[60px] pointer-events-none" />
        <div className="absolute -bottom-20 -left-20 w-56 h-56 bg-panik-orange/3 rounded-full blur-[80px] pointer-events-none" />

        {/* Header */}
        <div className="flex justify-between items-center mb-6 relative z-10">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-panik-orange animate-pulse" />
            <span className="text-[10px] font-mono tracking-widest text-[#94A3B8] uppercase">Early Access</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/5 text-white/50 hover:text-white transition-all duration-200" aria-label="Close modal">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress */}
        {step < 5 && (
          <div className="mb-8 w-full">
            <div className="flex justify-between items-center text-[10px] font-mono text-white/40 mb-1.5 tracking-wider uppercase">
              <span>Waitlist Pipeline</span>
              <span>
                Step {step} of 4 ({pct}%)
                {step === 2 && <span className="text-white/25 ml-1.5 normal-case not-italic font-mono">· Q{qIndex + 1}/5</span>}
              </span>
            </div>
            <div className="h-[2px] w-full bg-white/[0.05] rounded-full overflow-hidden">
              <motion.div className="h-full bg-panik-orange" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.3 }} />
            </div>
          </div>
        )}

        {/* Honeypot — off-screen, not in tab order. Non-semantic name + autoComplete
            off so password managers don't autofill it and drop a real signup. */}
        <input type="text" name="panik_hp_field" tabIndex={-1} autoComplete="off" aria-hidden="true" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} className="absolute opacity-0 pointer-events-none -left-[9999px] h-0 w-0" />

        <AnimatePresence mode="wait">
          {/* STEP 1 — EMAIL */}
          {step === 1 && (
            <motion.div key="s1" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.2 }} className="space-y-6">
              <div>
                <h2 className="font-display font-medium text-2xl sm:text-3xl text-white tracking-tight leading-snug">Join the Panik Early Access Program</h2>
                <p className="text-panik-text-secondary text-sm font-sans mt-2.5 leading-relaxed">
                  Help us build the future of DeFi risk intelligence. Answer a few quick profiling questions to secure early access and reserve your queue slot.
                </p>
              </div>
              <form noValidate onSubmit={handleEmailNext} className="space-y-4">
                <div>
                  <label htmlFor="modal-email-input" className="block text-[11px] font-mono tracking-wider text-white/50 uppercase mb-2">{email ? "Email (saved)" : "Enter email address"}</label>
                  <div className="relative flex items-center">
                    <Mail className="absolute left-4 w-4.5 h-4.5 text-white/30" />
                    <input
                      type="email" id="modal-email-input" value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com (or wallet email if applicable)"
                      aria-describedby={emailError ? "email-error" : undefined}
                      className="w-full h-12 pl-12 pr-4 bg-[#111318] border border-white/[0.08] hover:border-white/18 focus:border-panik-orange/50 focus:ring-1 focus:ring-panik-orange/20 text-[#F0F4FF] placeholder-white/25 text-sm font-sans rounded-lg outline-none transition-all duration-300"
                      required
                    />
                  </div>
                  {emailError && (
                    <p id="email-error" role="alert" className="text-red-400 text-xs font-mono mt-2.5 flex items-center gap-1.5">
                      <ShieldAlert aria-hidden="true" className="w-3.5 h-3.5 shrink-0" /><span>{emailError}</span>
                    </p>
                  )}
                </div>
                <button type="submit" disabled={!email} className="w-full h-12 bg-panik-orange hover:bg-panik-orange/90 disabled:opacity-50 disabled:hover:bg-panik-orange text-white font-mono text-xs uppercase tracking-wider font-semibold rounded-lg flex items-center justify-center gap-2 cursor-pointer transition-all duration-300 shadow-lg shadow-orange-500/5 active:scale-[0.99]">
                  <span>Continue</span><ArrowRight className="w-4 h-4" />
                </button>
              </form>
            </motion.div>
          )}

          {/* STEP 2 — PAGINATED MULTIPLE-CHOICE QUIZ */}
          {step === 2 && (
            <motion.div key={`s2-${qIndex}`} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.25 }} className="space-y-6 min-h-[360px] flex flex-col">
              <div className="flex justify-between items-center border-b border-white/[0.03] pb-3">
                <span className="text-[10px] font-mono tracking-widest text-[#F97316] uppercase font-bold">Building Your Risk Profile</span>
                <span className="text-[10px] font-mono text-white/35">Question {qIndex + 1} of {QUESTIONS.length}</span>
              </div>

              {/* in-quiz progress dots */}
              <div className="flex items-center gap-1.5">
                {QUESTIONS.map((_, i) => (
                  <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < qIndex ? "bg-panik-orange" : i === qIndex ? "bg-panik-orange/60" : "bg-white/[0.06]"}`} />
                ))}
              </div>

              <div className="flex-1">
                <h3 id={`q-heading-${q.id}`} className="font-display font-medium text-lg sm:text-xl text-white tracking-tight leading-snug mb-1">{q.text}</h3>
                {q.hint && <p className="text-[11px] font-mono text-white/40 uppercase tracking-wider mb-4">{q.hint}</p>}
                {!q.hint && <div className="mb-4" />}

                <div
                  role={q.kind === "single" ? "radiogroup" : "group"}
                  aria-labelledby={`q-heading-${q.id}`}
                  className="space-y-2.5"
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
                        className={`w-full text-left px-4 py-3.5 rounded-lg border flex items-center gap-3 transition-all duration-200 ${
                          selected ? "bg-panik-orange/[0.07] border-panik-orange/40 text-white" : "bg-[#111318] border-white/[0.06] hover:border-white/[0.16] text-white/75"
                        } ${capped ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                      >
                        <span aria-hidden="true" className={`shrink-0 w-5 h-5 flex items-center justify-center border transition-colors ${q.kind === "multi" ? "rounded" : "rounded-full"} ${selected ? "bg-panik-orange border-panik-orange" : "border-white/25"}`}>
                          {selected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                        </span>
                        <span className="text-sm font-sans leading-snug">{o.label}</span>
                      </button>
                    );
                  })}
                </div>
                {capMsg && q.kind === "multi" && q.max && (
                  <p role="status" aria-live="polite" className="text-[10px] font-mono text-amber-400/80 mt-2.5">You can only select up to {q.max} options.</p>
                )}

                {/* optional notes appear on the last question */}
                {qIndex === QUESTIONS.length - 1 && (
                  <div className="mt-5 space-y-2">
                    <label className="font-display font-medium text-sm text-white/80 leading-snug block">
                      Anything else about how you manage DeFi positions? <span className="text-white/40">(Optional)</span>
                    </label>
                    <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Protocols you use, alerting strategies, features you want…"
                      className="w-full p-3.5 bg-[#111318] border border-white/[0.08] hover:border-white/18 focus:border-panik-orange/50 focus:ring-1 focus:ring-panik-orange/20 text-[#F0F4FF] placeholder-white/25 text-sm font-sans rounded-lg outline-none transition-all resize-none" />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-white/[0.03]">
                <button type="button" onClick={handleQuestionBack} className="text-xs font-mono text-white/45 hover:text-white transition-colors uppercase h-10 px-4 rounded hover:bg-white/[0.02] flex items-center gap-1">
                  <ChevronLeft className="w-4 h-4" /><span>Back</span>
                </button>
                <button type="button" onClick={handleQuestionNext} disabled={!currentAnswered}
                  className="h-10 px-6 bg-panik-orange hover:bg-panik-orange/90 disabled:opacity-40 text-white font-mono text-xs uppercase tracking-wider font-semibold rounded-lg flex items-center gap-1.5 transition-all duration-300 disabled:pointer-events-none">
                  <span>{qIndex === QUESTIONS.length - 1 ? "Review" : "Next"}</span><ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 3 — REVIEW */}
          {step === 3 && (
            <motion.div key="s3" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.2 }} className="space-y-6">
              <div>
                <h2 className="font-display font-medium text-2xl text-white tracking-tight">Onboarding Profile Summary</h2>
                <p className="text-panik-text-secondary text-sm mt-1">Review your answers before reserving your slot.</p>
              </div>

              <div className="bg-[#111318]/80 border border-white/[0.06] rounded-xl overflow-hidden divide-y divide-white/[0.04]">
                <div className="p-4 flex justify-between items-center text-xs">
                  <span className="font-mono text-white/40 uppercase">Email</span>
                  <span className="font-mono text-white font-semibold truncate max-w-[220px] sm:max-w-xs">{email}</span>
                </div>
                {(["q1", "q2", "q5"] as const).map((id) => (
                  <div key={id} className="p-4 flex flex-col gap-1 text-xs">
                    <span className="font-mono text-white/40 uppercase">{QUESTIONS.find((x) => x.id === id)!.text}</span>
                    <span className="font-sans text-[#F0F4FF] font-medium">{answers[id] ? Q_SUMMARY_LABEL[id][answers[id]!] : "—"}</span>
                  </div>
                ))}
                {answers.q3.length > 0 && (
                  <div className="p-4 flex flex-col gap-1 text-xs">
                    <span className="font-mono text-white/40 uppercase">Risk tracking</span>
                    <span className="font-sans text-[#F0F4FF] font-medium">{answers.q3.map((k) => Q_SUMMARY_LABEL.q3[k]).join("; ")}</span>
                  </div>
                )}
                {answers.q4.length > 0 && (
                  <div className="p-4 flex flex-col gap-1 text-xs">
                    <span className="font-mono text-white/40 uppercase">Biggest frustration</span>
                    <span className="font-sans text-[#F0F4FF] font-medium">{answers.q4.map((k) => Q_SUMMARY_LABEL.q4[k]).join("; ")}</span>
                  </div>
                )}
              </div>

              {appetite && (
                <div className="p-4 rounded-xl bg-orange-500/[0.03] border border-panik-orange/15 flex items-start gap-3">
                  <HeartHandshake className="w-5 h-5 text-panik-orange shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-mono uppercase tracking-widest text-panik-orange mb-0.5">Your Panik profile · {APPETITE_LABEL[appetite]}</p>
                    <p className="text-xs text-panik-text-secondary leading-relaxed">{APPETITE_BLURB[appetite]}</p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => { setStep(2); setQIndex(QUESTIONS.length - 1); }} className="text-xs font-mono text-white/45 hover:text-white transition-colors uppercase h-10 px-4 rounded hover:bg-white/[0.02] flex items-center gap-1">
                  <ChevronLeft className="w-4 h-4" /><span>Back</span>
                </button>
                <button type="button" onClick={() => setStep(4)} className="h-12 px-7 bg-panik-orange hover:bg-panik-orange/90 text-white font-mono text-xs uppercase tracking-wider font-bold rounded-lg flex items-center gap-2 cursor-pointer transition-all active:scale-[0.99] shadow-lg shadow-orange-500/5">
                  <span>Continue to Wallet</span><ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 4 — WALLET (required) + SUBMIT */}
          {step === 4 && (
            <motion.div key="s4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }} className="space-y-6">
              <div>
                <h2 className="font-display font-medium text-2xl text-white tracking-tight leading-snug">Reserve Your Beta Access</h2>
                <p className="text-panik-text-secondary text-sm font-sans mt-2 leading-relaxed">
                  Connect your wallet to verify on-chain DeFi activity and tailor your early access. No transaction or signing required.
                </p>
              </div>

              {showManualInput ? (
                <div className="space-y-3">
                  <label htmlFor="manual-wallet-input" className="block text-[11px] font-mono tracking-wider text-white/50 uppercase">Enter a public EVM address</label>
                  <div className="relative flex items-center">
                    <Wallet className="absolute left-4 w-4.5 h-4.5 text-white/30" />
                    <input type="text" id="manual-wallet-input" value={wallet}
                      onChange={(e) => { setWallet(e.target.value.trim()); if (walletError) setWalletError(""); }}
                      onBlur={() => {
                        if (wallet && !isValidEvmAddress(wallet))
                          setWalletError("That doesn't look like a valid EVM address (0x + 40 hex characters).");
                      }}
                      placeholder="0x…"
                      className="w-full h-12 pl-12 pr-4 bg-[#111318] border border-white/[0.08] hover:border-white/18 focus:border-panik-orange/50 focus:ring-1 focus:ring-panik-orange/20 text-[#F0F4FF] placeholder-white/25 text-sm font-mono rounded-lg outline-none transition-all" />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <button type="button" disabled={connectingWallet !== null} onClick={() => handleConnect("io.metamask")} className={`p-4 flex items-center bg-[#111318] hover:bg-[#151821] border text-left rounded-xl transition-all duration-200 select-none disabled:opacity-60 ${connectingWallet === "io.metamask" ? "border-panik-orange" : "border-white/[0.06] hover:border-white/[0.15]"}`}>
                    {connectingWallet === "io.metamask" ? <Loader2 className="w-6 h-6 mr-3 text-panik-orange animate-spin" /> : <MetaMaskLogo />}
                    <div className="flex-1"><span className="block text-white text-sm font-sans font-semibold">MetaMask</span><span className="text-[10px] font-mono text-white/40 uppercase">{connectingWallet === "io.metamask" ? "Connecting…" : "EVM Wallet"}</span></div>
                  </button>
                  <button type="button" disabled={connectingWallet !== null} onClick={() => handleConnect("com.coinbase.wallet")} className={`p-4 flex items-center bg-[#111318] hover:bg-[#151821] border text-left rounded-xl transition-all duration-200 select-none disabled:opacity-60 ${connectingWallet === "com.coinbase.wallet" ? "border-panik-orange" : "border-white/[0.06] hover:border-white/[0.15]"}`}>
                    {connectingWallet === "com.coinbase.wallet" ? <Loader2 className="w-6 h-6 mr-3 text-panik-orange animate-spin" /> : <CoinbaseLogo />}
                    <div className="flex-1"><span className="block text-white text-sm font-sans font-semibold">Coinbase Wallet</span><span className="text-[10px] font-mono text-white/40 uppercase">{connectingWallet === "com.coinbase.wallet" ? "Connecting…" : "Injected"}</span></div>
                  </button>
                </div>
              )}

              <div className="text-center">
                <button type="button" onClick={() => { if (showManualInput) setWallet(""); setShowManualInput(!showManualInput); setWalletError(""); }} disabled={connectingWallet !== null} className="text-xs font-mono text-panik-orange hover:text-panik-orange/80 tracking-wider pb-0.5 border-b border-transparent hover:border-panik-orange/30 transition-all duration-200 uppercase cursor-pointer">
                  {showManualInput ? "Use a browser wallet instead" : "…or paste a wallet address"}
                </button>
              </div>

              {wallet && isValidEvmAddress(wallet) && connectingWallet === null && (
                <div className="py-2.5 px-4 flex items-center gap-2.5 bg-emerald-500/[0.05] border border-emerald-500/25 rounded-lg text-xs font-mono text-emerald-400">
                  <CheckCircle2 className="w-4 h-4 shrink-0" /><span>Connected: {wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
                </div>
              )}
              {walletError && (
                <p role="alert" className="text-red-400 text-xs font-mono flex items-center gap-1.5"><ShieldAlert aria-hidden="true" className="w-3.5 h-3.5 shrink-0" /><span>{walletError}</span></p>
              )}
              {submitError && (
                <div role="alert" className="p-3.5 rounded-lg bg-red-500/[0.06] border border-red-500/25 flex items-start gap-2.5 text-xs text-red-300 font-mono leading-relaxed">
                  <ShieldAlert aria-hidden="true" className="w-4 h-4 shrink-0 mt-0.5" /><span>{submitError}</span>
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.04] flex gap-3 text-xs text-white/50 leading-relaxed font-sans">
                <Info className="w-5 h-5 text-white/30 shrink-0 mt-0.5" />
                <p>Connecting reserves eligibility for future beta releases. Your funds stay under your control — no transactions are required.</p>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => setStep(3)} disabled={submitting} className="text-xs font-mono text-white/45 hover:text-white transition-colors uppercase h-10 px-4 rounded hover:bg-white/[0.02] flex items-center gap-1 disabled:opacity-40">
                  <ChevronLeft className="w-4 h-4" /><span>Back</span>
                </button>
                <button type="button" onClick={handleSubmit} disabled={submitting || !quizComplete || !isValidEvmAddress(wallet)}
                  className="h-12 px-7 bg-panik-orange hover:bg-panik-orange/90 disabled:opacity-50 text-white font-mono text-xs uppercase tracking-wider font-bold rounded-lg flex items-center gap-2 cursor-pointer transition-all active:scale-[0.99]">
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Submitting…</span></> : <><span>{submitError ? "Retry" : "Join the waitlist"}</span><ArrowRight className="w-4 h-4" /></>}
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 5 — SUCCESS */}
          {step === 5 && (
            <motion.div key="s5" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }} className="py-4 text-center space-y-6">
              <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                <div className="absolute inset-0 bg-emerald-500/10 rounded-full blur-xl scale-125 select-none" />
                <div className="w-16 h-16 rounded-full border-2 border-emerald-500/30 bg-[#0E1016] flex items-center justify-center relative z-10 select-none">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 stroke-[2px]" />
                </div>
              </div>
              <div className="space-y-2">
                <h2 className="font-display font-medium text-2xl sm:text-3xl text-white tracking-tight">You're on the list.</h2>
                <p className="text-panik-text-secondary text-sm max-w-sm mx-auto leading-relaxed">
                  {position ? <>Your position is <span className="text-white font-semibold">#{position}</span>.</> : <>Your slot is confirmed.</>}{" "}
                  We'll contact you when Panik enters beta and new testing opportunities open.
                </p>
              </div>
              <div className="max-w-xs mx-auto text-left bg-white/[0.02] border border-white/[0.05] rounded-xl p-4.5 space-y-2.5 font-sans text-xs">
                <div className="flex items-center gap-2.5 text-white/80">
                  <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[9px]">✓</span>
                  <span className="truncate">Email registered ({email})</span>
                </div>
                <div className="flex items-center gap-2.5 text-white/80">
                  <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[9px]">✓</span>
                  <span>Risk profile submitted{appetite ? ` (${APPETITE_LABEL[appetite]})` : ""}</span>
                </div>
                <div className="flex items-center gap-2.5 text-white/80">
                  <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[9px]">✓</span>
                  <span>Wallet verified ({wallet.slice(0, 6)}…{wallet.slice(-4)})</span>
                </div>
              </div>
              <div className="space-y-3 pt-2">
                <button type="button" onClick={onClose} className="w-full h-11 bg-white/[0.04] hover:bg-white/[0.08] text-white border border-white/[0.08] hover:border-white/[0.15] font-mono text-xs uppercase tracking-wider rounded-lg transition-colors cursor-pointer">Return to Site</button>
                <a href="https://x.com/panik_fi" target="_blank" rel="noreferrer noopener" className="h-10 px-4 bg-white/[0.02] hover:bg-white/[0.06] text-white border border-white/[0.05] hover:border-white/[0.12] font-mono text-[10px] uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 transition-colors">
                  <Twitter className="w-3.5 h-3.5 fill-current" /><span>Follow on X for launch news</span>
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
