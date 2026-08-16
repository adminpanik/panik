/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * /try - where a scanned or printed card lands.
 *
 * IT IS THE SAME GATE AS /app, DELIBERATELY. `components/AccountGate` driven by
 * `useAccountSession` + `gateScreen` is the product's one sign-in, and the code
 * on a business card is an invite code like any other: sign in, redeem it, come
 * in. A second sign-in built around the card would be a second account layer to
 * keep in step with the first, and the one thing this surface actually needs
 * that /app does not - a block of socials for whoever is holding the card - is
 * a slot on the shell rather than a reason to fork it.
 *
 * THE CODE ON THE CARD NEEDS NO HANDLING HERE. The account boot in
 * lib/account.ts reads `?code=` from any URL it starts on, keeps it across the
 * sign-in round trip (which comes home to a bare path), and the voucher screen
 * takes it from there.
 *
 * A MEMBER IS NOT SHOWN A GATE. `gateScreen` returning null means the server
 * says this account is in the beta, and the thing a card holder wants at that
 * point is the app. `replace`, not `assign`: /try is not a step anybody should
 * be able to go back to.
 */

import { useEffect } from "react";
import { Globe } from "lucide-react";
import { AccountGate } from "../panik-core/components/AccountGate";
import { gateScreen, useAccountSession } from "../panik-core/lib/account";
import { BootSkeleton, Card } from "../panik-core/ui";

const SITE_URL = "https://panik.fi";
const X_URL = "https://x.com/panik_fi";

/**
 * The X mark, from Simple Icons (CC0), path data copied verbatim on its own
 * 24x24 canvas, drawn in `currentColor`. Never hand-drawn, same rule as the
 * Google mark on the sign-in card (docs/DESIGN_SYSTEM.md).
 */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  );
}

/** Every row on the card reads the same, and hovers the same as the gate's links. */
const ROW =
  "inline-flex min-h-6 items-center gap-2.5 text-xs font-sans text-text-secondary transition-colors hover:text-text-primary";

/**
 * The card the printed one points at. Neutral: two links are not a risk state
 * and not the thing on this page to press, so nothing here takes the accent.
 */
function Socials() {
  return (
    <Card tone="raised" className="space-y-3">
      <h2 className="text-xs font-sans font-bold text-text-primary">Follow our socials</h2>
      <div className="flex flex-col items-start gap-2">
        <a href={SITE_URL} target="_blank" rel="noreferrer noopener" className={ROW}>
          <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
          panik.fi
        </a>
        <a href={X_URL} target="_blank" rel="noreferrer noopener" className={ROW}>
          <XMark />
          @panik_fi on X
        </a>
      </div>
    </Card>
  );
}

export default function App() {
  const account = useAccountSession();
  const screen = gateScreen(account);

  useEffect(() => {
    if (screen === null) window.location.replace("/app");
  }, [screen]);

  /**
   * Wordless while the browser is on its way to /app, for the same reason the
   * gate's own boot is: there is nothing true to say in the gap.
   */
  if (screen === null) return <BootSkeleton />;

  return <AccountGate screen={screen} account={account} after={<Socials />} />;
}
