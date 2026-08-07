/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * /try - the 2-in-1 business card. One QR + short code does two jobs:
 *   1. Business card: PANIK website + X, ALWAYS visible (every code state).
 *   2. Trial code: "Try Now" redeems a campaign code and mints the visitor a
 *      unique, expiring link into the core app (/app?trial=PANIK-XXXXXX).
 *
 * Two paths (see redeem_campaign_code): the SCAN path auto-detects ?code= from
 * the QR URL for a one-tap redemption; the NO-SCAN fallback reveals a manual
 * "Enter your code" input for the printed short code. Limit checks happen only
 * on the redemption attempt - idle scans never burn the usage count.
 */

import { useEffect, useRef, useState } from "react";
import { Globe, ArrowRight, Copy, Check, Loader2, Ticket, AlertCircle, Mail } from "lucide-react";
import { BUSINESS_CARD } from "./businessCard";
import { parseCode, normalizeCode, isValidEmail, normalizeEmail, type RedeemOutcome } from "./lib/trialLogic";
import { redeemCode } from "./lib/api";

type Phase = "idle" | "manual" | "submitting" | "success" | "invalid" | "error";

const INVALID_COPY: Record<Exclude<RedeemOutcome, "success">, { title: string; sub: string }> = {
  not_found: { title: "Code not found", sub: "Double-check the code on your card and try again." },
  disabled: { title: "This code is turned off", sub: "The campaign behind this code is no longer active." },
  expired: { title: "This code has expired", sub: "Its time window has closed. Reach out for a fresh one." },
  exhausted: { title: "This code is used up", sub: "It reached its redemption limit. Reach out for a fresh one." },
};

export default function App() {
  const [mounted, setMounted] = useState(false);
  const [detectedCode] = useState<string | null>(() =>
    typeof window !== "undefined" ? parseCode(window.location.search) : null,
  );
  // No detected code → the manual code field is the resting state, shown next to
  // the (always-required) email field.
  const [phase, setPhase] = useState<Phase>(detectedCode ? "idle" : "manual");
  const [manualCode, setManualCode] = useState("");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState(false);
  const [trialUrl, setTrialUrl] = useState<string | null>(null);
  const [invalidOutcome, setInvalidOutcome] = useState<Exclude<RedeemOutcome, "success">>("not_found");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  const absoluteTrialUrl = trialUrl
    ? `${typeof window !== "undefined" ? window.location.origin : ""}${trialUrl}`
    : "";

  async function submit(code: string): Promise<void> {
    // Email is required (it's the whole point of this gate): screen it before we
    // ever burn a redemption, and focus the offending field.
    const cleanEmail = normalizeEmail(email);
    if (!isValidEmail(cleanEmail)) {
      setEmailError(true);
      emailInputRef.current?.focus();
      return;
    }
    const clean = normalizeCode(code);
    if (!clean) {
      manualInputRef.current?.focus();
      return;
    }
    setPhase("submitting");
    const res = await redeemCode(clean, cleanEmail, honeypotRef.current?.value ?? "");
    if (res.ok && res.trialUrl) {
      setTrialUrl(res.trialUrl);
      setPhase("success");
      return;
    }
    if (res.outcome && res.outcome !== "success") {
      setInvalidOutcome(res.outcome);
      setPhase("invalid");
      return;
    }
    setErrorMsg(res.error === "network" ? "Network error - check your connection and retry." : "Something went wrong. Please retry.");
    setPhase("error");
  }

  function onTryNow(): void {
    void submit(detectedCode ?? manualCode);
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(absoluteTrialUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked - user can still tap the button link */
    }
  }

  function resetToIdle(): void {
    setPhase(detectedCode ? "idle" : "manual");
    setErrorMsg("");
  }

  const fade = (delay: string) =>
    `transition-all duration-700 ${delay} ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`;

  // Gate the button: both required fields must be filled before it's clickable.
  // On the scan path the code is auto-detected, so only the email is typed; on
  // the manual path both the code and the email are required.
  const hasCode = Boolean(detectedCode) || manualCode.trim().length > 0;
  const canSubmit = hasCode && email.trim().length > 0 && phase !== "submitting";

  return (
    <div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 selection:text-white overflow-x-clip">
      {/* Ambient background */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-gradient-to-b from-orange-500/[0.05] via-orange-600/[0.02] to-transparent blur-3xl" />
      </div>
      <div className="fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-50" />

      <main className="relative z-10 max-w-md mx-auto px-6 py-14 md:py-20 flex flex-col gap-6">
        {/* Brand mark */}
        <div className={`flex items-center gap-2.5 justify-center ${fade("delay-0")}`}>
          <img src="/panik-logo.png" alt="PANIK" width={36} height={36} className="rounded-lg object-contain" />
          <span className="font-display font-semibold text-xl tracking-tight text-white/90">PANIK</span>
        </div>

        {/* ── Redemption panel (the interactive half) ── */}
        <section className={`panik-glass rounded-2xl p-6 md:p-7 ${fade("delay-100")}`}>
          {/* Honeypot - real users never see or fill this. */}
          <input
            ref={honeypotRef}
            type="text"
            name="company_website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="hidden"
          />

          {phase === "success" ? (
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-orange-500/15 flex items-center justify-center mb-4">
                <Check className="w-6 h-6 text-orange-400" />
              </div>
              <h1 className="font-display text-xl font-bold text-white mb-1.5">You're in.</h1>
              <p className="text-sm text-white/50 leading-relaxed mb-5">
                Here's your personal access link. It's unique to you and the trial
                clock starts the moment you open the app.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 mb-4">
                <span className="font-mono text-xs text-white/60 truncate flex-1 text-left">{absoluteTrialUrl}</span>
                <button
                  onClick={copyLink}
                  className="shrink-0 text-white/40 hover:text-orange-400 transition-colors"
                  aria-label="Copy link"
                >
                  {copied ? <Check className="w-4 h-4 text-orange-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <a
                href={trialUrl ?? "/app"}
                className="group flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all"
              >
                Open the PANIK app
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </a>
            </div>
          ) : phase === "invalid" ? (
            <div className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center mb-4">
                <AlertCircle className="w-6 h-6 text-red-400" />
              </div>
              <h1 className="font-display text-xl font-bold text-white mb-1.5">{INVALID_COPY[invalidOutcome].title}</h1>
              <p className="text-sm text-white/50 leading-relaxed mb-5">{INVALID_COPY[invalidOutcome].sub}</p>
              <button
                onClick={resetToIdle}
                className="w-full rounded-xl border border-white/12 bg-white/[0.03] px-5 py-3 font-medium text-white/80 hover:bg-white/[0.06] transition-colors"
              >
                Enter a different code
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Ticket className="w-4 h-4 text-orange-400" />
                <h1 className="font-display text-lg font-bold text-white">Try PANIK free</h1>
              </div>
              <p className="text-sm text-white/45 leading-relaxed mb-5">
                {detectedCode
                  ? "Your card's code is ready. Add your email and one tap starts your trial."
                  : "Enter the code printed on your card and your email to start your trial."}
              </p>

              {detectedCode && (
                <div className="flex items-center gap-2 rounded-lg border border-orange-500/20 bg-orange-500/[0.06] px-3 py-2.5 mb-4">
                  <span className="text-xs font-mono uppercase tracking-wide text-orange-300/80">Code detected</span>
                  <span className="font-mono text-sm text-white/90 ml-auto">{detectedCode}</span>
                </div>
              )}

              {phase === "manual" && !detectedCode && (
                <input
                  ref={manualInputRef}
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && emailInputRef.current?.focus()}
                  placeholder="PANIK-TRY-XXXXXXXX"
                  spellCheck={false}
                  autoCapitalize="characters"
                  className="w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2.5 mb-3 font-mono text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors"
                />
              )}

              {/* Email gate - required in every path (scan or manual). This is how
                  we count real users and build the contact list. */}
              <div className="relative mb-1.5">
                <Mail className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  ref={emailInputRef}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(false); }}
                  onKeyDown={(e) => e.key === "Enter" && onTryNow()}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  placeholder="you@email.com"
                  aria-invalid={emailError}
                  aria-label="Email address"
                  className={`w-full rounded-lg border bg-black/30 pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-white/25 outline-none transition-colors ${
                    emailError ? "border-red-500/50 focus:border-red-500/60" : "border-white/12 focus:border-orange-500/40"
                  }`}
                />
              </div>
              {emailError ? (
                <p className="text-xs text-red-400/90 mb-4">Enter a valid email to start your trial.</p>
              ) : (
                <p className="text-xs text-white/30 mb-4">We'll only use this to send you PANIK updates.</p>
              )}

              {phase === "error" && (
                <p className="text-xs text-red-400/90 mb-3 text-center">{errorMsg}</p>
              )}

              <button
                onClick={onTryNow}
                disabled={!canSubmit}
                className="group flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:hover:shadow-none"
              >
                {phase === "submitting" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Checking…
                  </>
                ) : (
                  <>
                    Try Now
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                  </>
                )}
              </button>
            </div>
          )}
        </section>

        {/* ── Business card (ALWAYS visible, every code state) ── */}
        <section className={`panik-glass rounded-2xl p-6 ${fade("delay-200")}`}>
          <p className="text-[11px] font-mono uppercase tracking-widest text-white/30 mb-3">Business card</p>
          <h2 className="font-display text-lg font-semibold text-white/90">{BUSINESS_CARD.name}</h2>
          <p className="text-sm text-white/45 mb-4">{BUSINESS_CARD.tagline}</p>
          <div className="flex flex-col gap-2.5">
            <a
              href={BUSINESS_CARD.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 text-sm text-white/70 hover:text-orange-300 transition-colors"
            >
              <Globe className="w-4 h-4 text-white/40 group-hover:text-orange-400 transition-colors" />
              {BUSINESS_CARD.website}
            </a>
            <a
              href={BUSINESS_CARD.twitterUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 text-sm text-white/70 hover:text-orange-300 transition-colors"
            >
              <svg className="w-4 h-4 text-white/40 group-hover:text-orange-400 transition-colors" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              {BUSINESS_CARD.twitterHandle}
            </a>
          </div>
        </section>

        <p className={`text-center text-[11px] text-white/25 ${fade("delay-300")}`}>© 2026 PANIK</p>
      </main>
    </div>
  );
}
