/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { CtaBand } from "./components/CtaBand";
import { Faq } from "./components/Faq";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { Navigation } from "./components/Navigation";
import { ProofStrip } from "./components/ProofStrip";
import { Rule } from "./components/Rule";
import { WaitlistModal } from "./components/WaitlistModal";
import { WhyPanik } from "./components/WhyPanik";
import type { WaitlistCta } from "./components/cta";

/**
 * The public page, top to bottom, and nothing else. The app mockup, the scroll
 * preview and the seeded subscriber feed that used to live behind this file are
 * gone: the first two were a second, drifting copy of the product's own screens
 * and the third put invented names on a marketing surface.
 *
 * `panik_has_subscribed` is the only state that outlives a visit, and it exists
 * to stop the page asking a reader who has already signed up to sign up three
 * more times on the way down.
 */
const SUBSCRIBED_KEY = "panik_has_subscribed";

export default function App() {
  const [isWaitlistOpen, setIsWaitlistOpen] = useState(false);
  const [hasSubscribed, setHasSubscribed] = useState(
    () => localStorage.getItem(SUBSCRIBED_KEY) === "true",
  );

  const cta: WaitlistCta = {
    label: hasSubscribed ? "You are on the list" : "Get early access",
    disabled: hasSubscribed,
    onClick: () => setIsWaitlistOpen(true),
  };

  const handleJoinSuccess = () => {
    setHasSubscribed(true);
    localStorage.setItem(SUBSCRIBED_KEY, "true");
  };

  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <Navigation cta={cta} />
      <Rule />
      <Hero cta={cta} />
      <Rule />
      <ProofStrip />
      <Rule />
      <WhyPanik />
      <Rule />
      <HowItWorks />
      <Rule />
      <CtaBand cta={cta} />
      <Rule />
      <Faq />
      <Rule />
      <Footer />

      <WaitlistModal
        isOpen={isWaitlistOpen}
        onClose={() => setIsWaitlistOpen(false)}
        onJoinSuccess={handleJoinSuccess}
      />
    </div>
  );
}
