/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { CheckCircle2 } from "lucide-react";
import { WaitlistEntry } from "../types";
import { ScrollReveal } from "./ScrollReveal";
import { GlassAsset, GLASS } from "./GlassAsset";

interface WaitlistCTAProps {
  subscribersList: WaitlistEntry[];
  hasSubscribed: boolean;
  onOpenWaitlistModal: (initialEmail?: string) => void;
}

const formatSubscriberIdentity = (identity: string) => {
  if (!identity) return "";
  const cleaned = identity.trim();
  
  // Wallet Address (starts with 0x and is hex)
  if (cleaned.startsWith("0x") && cleaned.length >= 10) {
    return `${cleaned.substring(0, 6)}...${cleaned.substring(cleaned.length - 4)}`;
  }
  
  // ENS Domain (.eth)
  if (cleaned.toLowerCase().endsWith(".eth")) {
    const namePart = cleaned.slice(0, -4);
    if (namePart.length <= 4) {
      return `${namePart}***.eth`;
    }
    return `${namePart.substring(0, 3)}***${namePart.substring(namePart.length - 2)}.eth`;
  }

  // Email masking (GDPR Compliant)
  if (cleaned.includes("@")) {
    const [user, domain] = cleaned.split("@");
    const maskedUser = user.length > 3 ? `${user.substring(0, 3)}***` : `${user[0]}***`;
    return `${maskedUser}@${domain}`;
  }
  
  return cleaned.length > 8 ? `${cleaned.substring(0, 4)}...` : cleaned;
};

export function WaitlistCTA({ subscribersList, hasSubscribed, onOpenWaitlistModal }: WaitlistCTAProps) {
  return (
    <section id="waitlist-form" className="relative py-32 px-6 overflow-hidden">
      
      {/* Premium Warm background gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-panik-orange/[0.035] to-transparent pointer-events-none"></div>
      
      {/* Dot matrix */}
      <div className="absolute inset-0 panik-dot-bg opacity-30 pointer-events-none"></div>


      <div className="max-w-4xl mx-auto relative z-10 text-center">

        {/* SHIELD + KEY (Left) - secured, gated early access. */}
        <GlassAsset
          src={GLASS.shieldKey}
          alt="Secured early access"
          className="absolute left-[-140px] sm:left-[-180px] md:left-[-210px] lg:left-[-250px] xl:left-[-280px] top-[38%] -translate-y-1/2 w-[280px] sm:w-[340px] md:w-[400px] lg:w-[460px] xl:w-[500px] z-20"
          rotate={-9}
          tiltY={16}
          floatY={16}
          sway={2.5}
          duration={9.5}
          parallax={26}
          glow="rgb(from var(--color-panik-orange) r g b / 0.34)"
          opacity={0.98}
        />

        {/* MEGAPHONE (Right) - the call to join the waitlist. */}
        <GlassAsset
          src={GLASS.megaphone}
          alt="Join the waitlist announcement"
          className="absolute right-[-150px] sm:right-[-190px] md:right-[-220px] lg:right-[-260px] xl:right-[-290px] top-[42%] -translate-y-1/2 w-[300px] sm:w-[360px] md:w-[420px] lg:w-[480px] xl:w-[520px] z-20"
          rotate={8}
          flip
          tiltY={-14}
          floatX={10}
          floatY={13}
          sway={2}
          duration={9}
          delay={0.6}
          parallax={-24}
          glow="rgb(from var(--color-panik-orange) r g b / 0.32)"
          opacity={0.98}
        />

        {/* Main CTA structure */}
        <ScrollReveal className="panik-glass p-8 sm:p-14 lg:p-16 rounded-lg border border-border-subtle bg-surface-raised/60 relative overflow-hidden z-10" id="cta-inner-block" duration={0.65}>
          
          {/* Accent lighting in background */}
          <div className="absolute -bottom-24 left-1/2 -translate-x-1/2 w-80 h-80 bg-panik-orange/15 rounded-full blur-3xl pointer-events-none"></div>

          <h2 className="font-sans font-bold text-2xl sm:text-4xl tracking-tight leading-tight text-text-primary mb-5">
            Apply for Early Access
          </h2>

          <p className="text-text-secondary text-sm sm:text-base max-w-2xl mx-auto mb-12 leading-relaxed">
            Get first access to Compass, Watch, and Advisor before public launch. Help us shape the future of DeFi risk management.
          </p>

          {/* Onboarding Trigger Button Area */}
          <div className="max-w-md mx-auto mb-10 py-2">
            {hasSubscribed ? (
              <div className="p-6 rounded-md bg-panik-orange/5 border border-panik-orange/30 backdrop-blur-md flex gap-4 items-center justify-start text-left animate-fade-in" id="bottom-form-success">
                <div className="w-10 h-10 rounded-full bg-panik-orange/20 border border-panik-orange/40 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-6 h-6 text-panik-orange" />
                </div>
                <div>
                  <h3 className="font-mono text-xs tracking-wider uppercase text-panik-orange font-semibold">ACCESS GRANTED // SLOT IMMINENT</h3>
                  <p className="text-xs text-text-secondary mt-0.5">
                    You're in. We'll reach out directly when beta opens for your cohort.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={() => onOpenWaitlistModal()}
                  className="w-full sm:w-auto h-14 px-10 bg-panik-orange hover:bg-panik-orange/90 text-surface-base font-mono text-sm uppercase tracking-wider font-bold rounded-md flex items-center justify-center gap-3 cursor-pointer transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] panik-glow-orange shrink-0 shadow-xl shadow-panik-orange/20"
                  id="bottom-btn-submit"
                >
                  <span>JOIN THE WAITLIST →</span>
                </button>
              </div>
            )}
          </div>

        </ScrollReveal>

      </div>
    </section>
  );
}
