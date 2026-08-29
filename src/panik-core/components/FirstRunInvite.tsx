/**
 * The Portfolio surface when there is no wallet to score.
 *
 * It replaces four skeleton cards, an empty allocation chart, an empty alert
 * feed and a permanent "Live feed unavailable" panel, a dashboard's worth of
 * chrome describing nothing, shown to someone who has not handed us an address
 * yet. A product whose pitch is "give us a wallet and we watch it" cannot open
 * on a graveyard of its own eventual UI.
 *
 * ONE HEADING, ONE BUTTON: the same treatment `Settings` and the sign-in gate
 * get. This used to carry a subtitle, a three-step explainer and a read-only
 * footnote ahead of the control that matters, none of which changed what a
 * reader did here: the one thing to do is press "Add your wallet", and the
 * wallet step behind it (`Onboarding`) is where the address itself, and its
 * own read-only line, live.
 *
 * `Card`, not a hand-rolled panel: this is the app's one bordered-tile
 * primitive, and a second copy of its edge and shadow classes is exactly the
 * drift `docs/DESIGN_SYSTEM.md` exists to stop.
 */

import { ArrowRight, Wallet } from "lucide-react";
import { Button, Card } from "../ui";

interface FirstRunInviteProps {
  /** Opens the onboarding flow (address, then the profile questions). */
  onAddWallet: () => void;
}

export function FirstRunInvite({ onAddWallet }: FirstRunInviteProps) {
  return (
    /* Capped and centred rather than stretched to the tab's 1600px measure. At
       2000 an edge-to-edge panel is a 1600px box holding a 576px column, which
       reads as an empty dashboard again; 768px is a block with a shape. */
    <Card tone="raised" className="mx-auto w-full max-w-3xl px-6 py-12 sm:px-10 sm:py-14">
      <div className="flex flex-col items-start gap-6">
        <span className="flex h-12 w-12 items-center justify-center hard-edge bg-surface-sunken">
          <Wallet className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </span>

        {/* h1: on this state the invitation IS the page, so the "DeFi
            Portfolio" heading and its Open position button are not rendered
            above it. A page title over a card telling you the page is empty
            is two headings competing to be the first thing read. */}
        <h1 className="font-sans text-2xl font-black uppercase tracking-tight text-text-primary">
          Add your wallet and PANIK watches it from there
        </h1>

        {/* One primary action. Anything else on this screen would be a second
            way to not start. */}
        <Button size="lg" onClick={onAddWallet}>
          Add your wallet
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}
