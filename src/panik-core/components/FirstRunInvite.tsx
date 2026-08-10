/**
 * The Portfolio surface when there is no wallet to score.
 *
 * It replaces four skeleton cards, an empty allocation chart, an empty alert
 * feed and a permanent "Live feed unavailable" panel — a dashboard's worth of
 * chrome describing nothing, shown to someone who has not handed us an address
 * yet. A product whose pitch is "give us a wallet and we watch it" cannot open
 * on a graveyard of its own eventual UI.
 *
 * Not `EmptyState`: that primitive is a one-line notice sized to sit ABOVE
 * content, and this is the whole page. Everything below is `@theme` tokens and
 * the shared `Button` — no new values, no local colour.
 *
 * Every claim here is one the code can keep. It scores positions and it
 * messages you; it does not close anything for you. The exit is signed by the
 * user, the relayer is not armed, and this screen is exactly where an
 * overstatement would be believed.
 */

import { ArrowRight, Bell, Gauge, ScanLine, Wallet } from "lucide-react";
import { Button } from "../ui";

interface FirstRunInviteProps {
  /** Opens the onboarding flow (address, then the profile questions). */
  onAddWallet: () => void;
  /** Chain the API says it scores, or the configured default. */
  chainLabel: string;
  /** e.g. "Aave V3, Moonwell, Morpho and Compound V3". */
  protocolSentence: string;
}

export function FirstRunInvite({ onAddWallet, chainLabel, protocolSentence }: FirstRunInviteProps) {
  /**
   * What actually happens, in order, with nothing on the list the product
   * cannot do today. The alert step names Telegram AND names the connect step:
   * "we message you" is only true once a channel exists, and a monitoring
   * product that implies coverage it does not have is the one lie that costs
   * money.
   */
  const steps = [
    {
      icon: ScanLine,
      text: `PANIK reads the wallet's public lending positions on ${chainLabel}, across ${protocolSentence}.`,
    },
    {
      icon: Gauge,
      text: "Each position gets a risk score and the price drop that would liquidate it, rechecked about once a minute.",
    },
    {
      icon: Bell,
      text: "Connect Telegram in Settings and PANIK messages you when a position crosses the risk limit your profile sets.",
    },
  ];

  return (
    /* Capped and centred rather than stretched to the tab's 1600px measure. At
       2000 an edge-to-edge panel is a 1600px box holding a 576px column, which
       reads as an empty dashboard again; 768px is a block with a shape. */
    <section className="mx-auto w-full max-w-3xl rounded-lg border border-border-subtle bg-white/[0.01] px-6 py-12 sm:px-10 sm:py-14">
      <div className="flex flex-col items-start gap-7">
        <span className="flex h-12 w-12 items-center justify-center rounded-md border border-border-subtle bg-surface-raised">
          <Wallet className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </span>

        <div className="space-y-3">
          {/* h1: on this state the invitation IS the page, so the "DeFi
              Portfolio" heading and its Open position button are not rendered
              above it. A page title over a card telling you the page is empty
              is two headings competing to be the first thing read. */}
          <h1 className="text-2xl font-sans font-extrabold tracking-tight text-text-primary">
            Add your wallet and PANIK watches it from there
          </h1>
          <p className="text-base font-sans leading-relaxed text-text-secondary">
            One address is all it takes. Paste it, or connect the wallet you already
            use in this browser.
          </p>
        </div>

        <ul className="w-full space-y-4">
          {steps.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              {/* Neutral ink, deliberately. The risk ramp belongs to risk
                  indicators, and an onboarding step is not a risk state. */}
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="text-sm font-sans leading-relaxed text-text-secondary">{text}</span>
            </li>
          ))}
        </ul>

        {/* One primary action. Anything else on this screen would be a second
            way to not start. */}
        <Button size="lg" onClick={onAddWallet}>
          Add your wallet
          <ArrowRight className="h-4 w-4" />
        </Button>

        <p className="text-xs font-sans leading-relaxed text-text-muted">
          Read only. PANIK never moves your funds: it scores what the wallet holds
          and tells you, and closing or repaying a position stays something you do
          yourself.
        </p>
      </div>
    </section>
  );
}
