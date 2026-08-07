/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { WagmiProvider, useReadContract } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  wagmiConfig,
  ESCROW_ABI,
  getEscrowAddress,
  getEscrowChainId,
} from "./lib/contracts";
import { DepositFlow } from "./components/DepositFlow";
import { RefundBanner } from "./components/RefundBanner";
import { EscrowStats } from "./components/EscrowStats";

const queryClient = new QueryClient();

/**
 * Reads the contract's single global `refundDeadline()` and formats it as an
 * absolute date.
 *
 * The deadline is ONE timestamp fixed at deployment, shared by every
 * depositor — it is NOT 90 days from your own deposit. Copy on this page must
 * never imply otherwise: someone depositing on day 85 has 5 days left, not 90.
 * Returns `null` until the read resolves (or if no contract is configured), in
 * which case callers fall back to naming the deployment as the start date.
 */
function useGlobalDeadline(): string | null {
  let escrowAddress: `0x${string}` | null = null;
  try {
    escrowAddress = getEscrowAddress();
  } catch {
    // Contract not deployed yet — callers fall back to generic copy.
  }

  const { data: refundDeadline } = useReadContract(
    escrowAddress
      ? {
          address: escrowAddress,
          abi: ESCROW_ABI,
          functionName: "refundDeadline",
          chainId: getEscrowChainId(),
        }
      : undefined
  );

  if (refundDeadline === undefined) return null;

  return new Date(Number(refundDeadline) * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Benefits list for founding users */
const BENEFITS = [
  {
    icon: "💰",
    title: "12-Month Fee Reduction",
    desc: "50% off transaction fees for the first 12 months, locked to your depositor wallet.",
  },
  {
    icon: "⚡",
    title: "Earlier Access",
    desc: "Access to PANIK before the public — you're first in line.",
  },
  {
    icon: "📡",
    title: "Early News",
    desc: "Product updates, feature previews, and launch timing before any public announcement.",
  },
  {
    icon: "🎯",
    title: "Direct Product Input",
    desc: "Direct access to the team during build — your feedback shapes features pre-launch.",
  },
  {
    icon: "🏆",
    title: "Founding User Status",
    desc: "Permanently recognized as an OG founding member of PANIK.",
  },
];

function FoundingApp() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const deadlineDate = useGlobalDeadline();

  return (
    <div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 selection:text-white overflow-x-clip">
      {/* Ambient background */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-gradient-to-b from-orange-500/[0.04] via-orange-600/[0.02] to-transparent blur-3xl" />
        <div className="absolute bottom-0 right-0 w-[600px] h-[400px] rounded-full bg-gradient-to-t from-orange-500/[0.03] to-transparent blur-3xl" />
      </div>

      {/* Dot grid overlay */}
      <div className="fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-50" />

      {/* Header */}
      <header className="relative z-10 border-b border-white/[0.06]">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <a
            href="/"
            className="flex items-center gap-2.5 group"
            id="founding-logo-link"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center font-display font-bold text-sm text-white shadow-lg shadow-orange-500/20 group-hover:shadow-orange-500/40 transition-shadow">
              P
            </div>
            <span className="font-display font-semibold text-lg tracking-tight text-white/90 group-hover:text-white transition-colors">
              PANIK
            </span>
          </a>
          <div className="flex items-center gap-2 text-xs font-mono text-white/30">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500/60 animate-pulse" />
            Invite Only
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 py-12 md:py-20">
        {/* Hero section */}
        <section className="text-center mb-16 md:mb-20">
          <div
            className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-orange-500/20 bg-orange-500/[0.06] mb-6 transition-all duration-700 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
          >
            <span className="text-orange-400 text-xs font-semibold tracking-wide uppercase">
              Founding User Program
            </span>
          </div>

          <h1
            className={`font-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1] mb-6 transition-all duration-700 delay-100 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
          >
            <span className="text-white">Back PANIK with </span>
            <span className="bg-gradient-to-r from-orange-400 via-orange-500 to-amber-500 bg-clip-text text-transparent">
              $5 USDC
            </span>
          </h1>

          <p
            className={`text-lg md:text-xl text-white/50 max-w-2xl mx-auto leading-relaxed mb-4 transition-all duration-700 delay-200 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
          >
            There is one deadline for everyone:{" "}
            <span className="text-white/80 font-medium tabular-nums">
              {deadlineDate ?? "90 days from contract deployment"}
            </span>
            . If we haven't shipped PANIK by then, you claim your money back
            directly from the smart contract. No questions asked.
          </p>

          <p
            className={`text-sm text-white/30 font-mono transition-all duration-700 delay-300 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
          >
            Your deposit is held on Base · USDC · Non-custodial escrow
          </p>
        </section>

        {/* Two-column layout: Benefits + Deposit */}
        <div className="grid lg:grid-cols-2 gap-8 md:gap-10 mb-16">
          {/* Left: Benefits */}
          <div
            className={`transition-all duration-700 delay-300 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
          >
            <h2 className="font-display text-xl font-semibold mb-6 text-white/90">
              What founding users get
            </h2>
            <div className="space-y-4">
              {BENEFITS.map((b, i) => (
                <div
                  key={i}
                  className="group panik-glass rounded-xl px-5 py-4 flex items-start gap-4 hover:border-orange-500/20 transition-all"
                >
                  <span className="text-2xl mt-0.5 shrink-0">{b.icon}</span>
                  <div>
                    <h3 className="font-semibold text-white/90 text-sm mb-1 group-hover:text-orange-300 transition-colors">
                      {b.title}
                    </h3>
                    <p className="text-xs text-white/40 leading-relaxed">
                      {b.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Escrow Stats + Deposit Flow */}
          <div
            className={`space-y-6 transition-all duration-700 delay-400 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
          >
            <EscrowStats />
            <DepositFlow />
            <RefundBanner />
          </div>
        </div>

        {/* How it works */}
        <section
          className={`mb-16 transition-all duration-700 delay-500 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
        >
          <h2 className="font-display text-xl font-semibold mb-8 text-center text-white/90">
            How the escrow works
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                step: "01",
                title: "Deposit $5 USDC",
                desc: "Connect your wallet on Base and deposit exactly 5 USDC into the escrow contract. One deposit per wallet.",
              },
              {
                step: "02",
                title: "We build PANIK",
                desc: `Your deposit sits in the escrow contract. We have until ${
                  deadlineDate ?? "the deadline"
                } to ship — one date fixed when the contract was deployed, identical for every depositor whenever you deposit.`,
              },
              {
                step: "03",
                title: "Ship or refund",
                desc: "If we ship, your $5 unlocks and you get founding-user benefits. If we don't, you claim your full refund from the contract.",
              },
            ].map((s, i) => (
              <div
                key={i}
                className="panik-glass rounded-xl p-6 text-center group hover:border-orange-500/20 transition-all"
              >
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-orange-500/10 text-orange-400 font-mono font-bold text-sm mb-4 group-hover:bg-orange-500/20 transition-colors">
                  {s.step}
                </div>
                <h3 className="font-display font-semibold text-white/90 mb-2">
                  {s.title}
                </h3>
                <p className="text-sm text-white/40 leading-relaxed">
                  {s.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Trust section */}
        <section className="text-center mb-16">
          <div className="panik-glass rounded-2xl p-8 md:p-10 max-w-2xl mx-auto">
            <h2 className="font-display text-lg font-semibold mb-4 text-white/90">
              🔒 Trust by design
            </h2>
            <ul className="text-sm text-white/40 space-y-3 text-left">
              <li className="flex items-start gap-3">
                <span className="text-orange-400 mt-0.5">✓</span>
                <span>
                  <strong className="text-white/60">Held by the contract.</strong>{" "}
                  Funds sit in the escrow contract, not a team wallet. Until the
                  deadline, we can sweep the balance to our treasury by calling{" "}
                  <code className="text-white/50">ship()</code> — a team
                  decision, taken on-chain and publicly visible. The contract
                  cannot check that we actually launched.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-orange-400 mt-0.5">✓</span>
                <span>
                  <strong className="text-white/60">Refunds forever.</strong>{" "}
                  There is no sweep function. Your refund right never expires.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-orange-400 mt-0.5">✓</span>
                <span>
                  <strong className="text-white/60">
                    One deadline for everyone.
                  </strong>{" "}
                  {deadlineDate
                    ? `It was fixed when the contract was deployed — ${deadlineDate} — not 90 days from your own deposit.`
                    : "It is fixed when the contract is deployed — 90 days from deployment, not 90 days from your own deposit."}{" "}
                  Once it passes without a release, the team is locked out of
                  your funds permanently.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-orange-400 mt-0.5">✓</span>
                <span>
                  <strong className="text-white/60">Verifiable.</strong> Contract
                  source is public on Basescan — read it yourself.
                </span>
              </li>
            </ul>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/[0.06] py-8">
        <div className="max-w-5xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-white/25">
          <span>© 2026 PANIK. All rights reserved.</span>
          <span className="font-mono">
            Built on{" "}
            <a
              href="https://base.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/40 hover:text-orange-400 transition-colors"
            >
              Base
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FoundingApp />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
