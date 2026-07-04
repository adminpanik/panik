/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Navigation } from "./components/Navigation";
import { Hero } from "./components/Hero";
import { DashboardScrollPreview } from "./components/DashboardScrollPreview";
import { HowItWorks } from "./components/HowItWorks";
import { RiskVisualization } from "./components/RiskVisualization";
import { WhyPanik } from "./components/WhyPanik";
import { ProtocolCoverage } from "./components/ProtocolCoverage";
import { FAQ } from "./components/FAQ";
import { BacktestResults } from "./components/BacktestResults";
import { WaitlistCTA } from "./components/WaitlistCTA";
import { Footer } from "./components/Footer";
import { AppMockup } from "./components/AppMockup";
import { TechyGlobe } from "./components/TechyGlobe";
import { WaitlistModal } from "./components/WaitlistModal";
import { INITIAL_SUBSCRIBERS } from "./data";
import { WaitlistEntry } from "./types";
import { getWaitlistCount } from "./lib/waitlist";

export default function App() {
  const [viewMode, setViewMode] = useState<"landing" | "app">("landing");

  // Subscribers State - Load from localStorage if present to maintain real local persistence
  const [subscribers, setSubscribers] = useState<WaitlistEntry[]>(() => {
    const saved = localStorage.getItem("panik_subscribers");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved waitlist", e);
      }
    }
    return INITIAL_SUBSCRIBERS;
  });

  const [hasSubscribed, setHasSubscribed] = useState<boolean>(() => {
    return localStorage.getItem("panik_has_subscribed") === "true";
  });

  // Real subscriber count from the backend (null until loaded / when offline).
  // The social-proof feed stays seeded — only this number is real.
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const refreshCount = () => { void getWaitlistCount().then(setLiveCount); };
  useEffect(() => { refreshCount(); }, []);

  // Displayed count: prefer the real backend number; fall back to the seeded
  // list length when the backend isn't configured/reachable (dev/offline).
  const displayCount = liveCount ?? subscribers.length;

  const [isWaitlistModalOpen, setIsWaitlistModalOpen] = useState(false);
  const [waitlistInitialEmail, setWaitlistInitialEmail] = useState("");

  // Keep localStorage synched
  useEffect(() => {
    localStorage.setItem("panik_subscribers", JSON.stringify(subscribers));
    localStorage.setItem("panik_has_subscribed", String(hasSubscribed));
  }, [subscribers, hasSubscribed]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [viewMode]);

  // Smooth scroll handler with sticky header offset
  const handleScrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      const navHeight = 80; // h-20 sticky nav
      const elementPosition = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({
        top: elementPosition - navHeight,
        behavior: "smooth",
      });
    }
  };

  const handleOpenWaitlistModal = (initialEmail: string = "") => {
    if (hasSubscribed) return;
    setWaitlistInitialEmail(initialEmail);
    setIsWaitlistModalOpen(true);
  };

  // Submit handler — the modal already persisted the signup to Supabase. We do
  // NOT add the real email to the visible feed (it stays seeded/fake, per the
  // backend plan — never expose real emails to the browser). Just flag the
  // cosmetic "subscribed" state and refresh the real count.
  const handleJoinWaitlist = (_email: string, _source: string = "Waitlist") => {
    setHasSubscribed(true);
    refreshCount();
  };

  if (viewMode === "app") {
    return (
      <AppMockup 
        onBackToLanding={() => setViewMode("landing")}
        onJoinWaitlist={handleJoinWaitlist}
        hasSubscribed={hasSubscribed}
      />
    );
  }

  return (
    <div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 selection:text-white overflow-x-clip">
      {/* Navigation section */}
      <Navigation
        onScrollTo={handleScrollToSection}
        subscriberCount={displayCount}
        onOpenWaitlistModal={handleOpenWaitlistModal}
        hasSubscribed={hasSubscribed}
      />

      {/* Global continuous background techy globe spanning Hero and Dashboard preview */}
      <div className="absolute left-1/2 top-[480px] sm:top-[520px] -translate-y-1/2 -translate-x-1/2 w-full max-w-[110rem] h-[1050px] z-0 select-none overflow-hidden pointer-events-none opacity-30">
        <TechyGlobe />
        <div className="absolute inset-x-0 top-0 h-[250px] bg-gradient-to-b from-[#0A0A0B] to-transparent pointer-events-none z-20"></div>
        <div className="absolute inset-x-0 bottom-0 h-[250px] bg-gradient-to-t from-[#0A0A0B] to-transparent pointer-events-none z-20"></div>
      </div>

      {/* Hero section */}
      <Hero
        subscriberCount={displayCount}
        hasSubscribed={hasSubscribed}
        onLaunchMockup={() => setViewMode("app")}
        onOpenWaitlistModal={handleOpenWaitlistModal}
      />

      {/* Interactive dashboard scroll-revealing preview */}
      <DashboardScrollPreview />

      {/* How It works */}
      <HowItWorks />

      {/* Risk Dimension Score Visualizations */}
      <RiskVisualization />

      {/* Why PANIK Comparison Table */}
      <WhyPanik />

      {/* Protocol coverage benchmarks (Temporarily hidden from frontend as requested, file kept intact) */}
      {/* <ProtocolCoverage /> */}

      {/* Backtest Results */}
      <BacktestResults />

      {/* Bottom CTA & Live allowed addresses queue */}
      <WaitlistCTA
        subscribersList={subscribers}
        hasSubscribed={hasSubscribed}
        onOpenWaitlistModal={handleOpenWaitlistModal}
      />

      {/* Frequently Asked Questions */}
      <FAQ />

      {/* Premium minimal footer */}
      <Footer onScrollTo={handleScrollToSection} />

      {/* Dynamic multi-step onboarding modal */}
      <WaitlistModal 
        isOpen={isWaitlistModalOpen} 
        onClose={() => setIsWaitlistModalOpen(false)} 
        onJoinSuccess={(email, source) => handleJoinWaitlist(email, source)}
        initialEmail={waitlistInitialEmail}
      />
    </div>
  );
}
