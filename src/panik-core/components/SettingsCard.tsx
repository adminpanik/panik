/**
 * One shape for every card on the Settings tab.
 *
 * The tab used to be six cards that agreed on nothing below their headings: a
 * bold line then a muted sentence in one, a sentence with a date folded into it
 * in the next, a filled status box beside a button in the third. Six ways of
 * saying "here is a fact about your account" on one screen, and no two of them
 * put the fact in the same place, so nothing could be read down a column.
 *
 * A LEDGER is what a settings screen actually is: a label on the left naming
 * the thing, the value on the right, and one action at the foot of the card.
 * The value is set in mono because every one of them is a reading (an address,
 * a date, a threshold, a state), which is the same rule the rest of the product
 * applies to numerals.
 *
 * The rules are 3px black and meet the card's edge, so the card is `padded={false}`
 * and every part pads itself. A hairline inset divider would have made these
 * read as a list inside a box rather than as one ruled block.
 *
 * NO RISK HUE ANYWHERE. Nothing on Settings is a risk state: a network, a
 * session expiry and a Telegram link are not bands, and the ramp is rationed to
 * the indicators that carry one (docs/DESIGN_SYSTEM.md).
 */

import React from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "../ui";

/**
 * The title row: icon, uppercase name, 3px rule under it.
 *
 * `extra` is for the one card that has something to hang beside its name (the
 * Telegram hover, the testnet marker). It is not a second heading and nothing
 * that changes what the card does goes in it.
 */
export function SettingsCardTitle({
  icon: Icon,
  title,
  extra,
}: {
  icon: LucideIcon;
  title: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b-[3px] border-solid border-border-strong px-5 py-3.5">
      <Icon className="h-5 w-5 shrink-0 text-text-primary" aria-hidden="true" />
      <h3 className="min-w-0 truncate font-sans text-base font-black uppercase tracking-[0.02em] text-text-primary">
        {title}
      </h3>
      {extra}
    </div>
  );
}

/**
 * One line of the ledger: what it is, and what it currently says.
 *
 * `mono` is on by default because the right column is readings. It is turned
 * off for the two values that are genuinely words rather than a reading, so a
 * phrase does not get set in a face built for digits.
 */
export function SettingsRow({
  label,
  value,
  mono = true,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t-[3px] border-solid border-border-strong px-5 py-3 first:border-t-0">
      <span className="min-w-0 font-sans text-sm text-text-primary">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-sm text-text-primary ${
          mono ? "font-mono font-bold tabular-nums" : "font-sans"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The card's action, at its foot and on its own rule.
 *
 * Right-aligned from `sm` up and full width below it: a 358px column has no
 * room for a button to sit in half of, and a 44px-plus target that spans the
 * card is the one every mobile settings screen ships.
 *
 * `whitespace-nowrap` is inherited by the buttons, and it is load-bearing on the
 * one card that ends on two of them: at 1440 the grid track is 490px and "Sign
 * in with wallet" beside "Forget this browser" comes to within 40px of it, so
 * both labels broke onto a second line inside a 48px plate. Nowrap plus
 * `flex-wrap` moves the second button under the first instead, which is the
 * failure a reader can act on.
 */
export function SettingsCardFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-stretch gap-3 whitespace-nowrap border-t-[3px] border-solid border-border-strong px-5 py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
      {children}
    </div>
  );
}

/** A block that is neither a ledger row nor the footer: the network control. */
export function SettingsCardBlock({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

/** The plate the three parts above sit on. */
export function SettingsCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card tone="raised" padded={false} className={className}>
      {children}
    </Card>
  );
}
