/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which watched wallet the Portfolio is about.
 *
 * A listbox rather than a `<select>`, which is what this was. A native select
 * paints its own popup from the OS: system chrome, a system blue highlight, and
 * no way to put a label, a hex address and a marker on one row without
 * flattening them into a single string with separators in it. The flattened
 * string was the actual cost — "Cold storage · 0x9b1f…a5c7 · your wallet" is
 * three facts a reader has to parse out of one line, and the marker that says
 * whose money this is sat at the end of it.
 *
 * The MECHANISM (roving `aria-activedescendant`, arrows with scroll pinning,
 * Enter to commit, Escape / Tab / outside-click to dismiss, the panel's edge
 * measured on open) now lives in `ui/Listbox`, which the Watch market picker
 * also uses. This file is what a wallet row looks like and nothing else.
 *
 * WHAT THE ROWS CARRY, and why each is not colour. The selected row is marked
 * with a check (SC 1.4.1: never state anything by hue alone, and the tinted
 * background here is the second signal, not the first). The owner's row wears
 * `Chip`, literally the marker WalletsPanel gives it, so one wallet does not
 * have two names for the same fact across two surfaces. Every other row is
 * watch-only by construction and wears the eye.
 *
 * NO RISK HUE ANYWHERE. Which wallet you are looking at is not a risk band, and
 * the eye is an informational glyph: `text-muted`, like every other one.
 */

import React from "react";
import { Check, ChevronDown, Eye } from "lucide-react";
import { truncateAddress } from "../lib/utils";
import type { WalletChoice } from "../lib/watchlist";
import { Chip, Listbox } from "../ui";
import { InfoTip } from "./InfoTip";

export interface WalletSelectorProps {
  /** Built by `viewableWallets`, which is the authority on what may be shown. */
  options: WalletChoice[];
  /** The wallet currently shown, already validated against `options`. */
  value: string;
  onChange: (wallet: string) => void;
}

export function WalletSelector({ options, value, onChange }: WalletSelectorProps) {
  const target = value.toLowerCase();
  // The one guard, and it is here rather than at every read of `selected`:
  // `value` arrives pre-validated against `options` (AppDemo falls back to the
  // bound wallet the moment a selection stops being watched), so a miss is a
  // caller bug and the first row is the honest thing to draw while it lasts.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.wallet === target),
  );

  const selected = options[selectedIndex];
  const viewingWatchOnly = !selected.own;

  // The address once, not twice: an unnamed wallet IS its address, and
  // "0x9b1f…a5c7, 0x9b1f…a5c7" is a row read out stuttering.
  const spokenName = (o: WalletChoice) => {
    const named = o.label?.trim();
    return named ? `${named}, ${truncateAddress(o.wallet)}` : truncateAddress(o.wallet);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Listbox
        className="min-w-0"
        /* The control's NAME, hidden because the page heading beside it names
           the page rather than this. */
        label="Which watched wallet to show"
        count={options.length}
        selectedIndex={selectedIndex}
        onCommit={(i) => onChange(options[i].wallet)}
        /* `border-strong`, not `subtle`. This is a control edge, and WCAG 1.4.11
           asks 3:1 of one: `surface-raised` on `surface-base` is a 1.2:1 step, so
           the border is the only thing making the hit area findable. The floating
           panel is a container rather than a control and takes the decorative
           edge. */
        triggerClassName="flex h-9 max-w-full cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface-raised px-3 font-sans text-xs transition-colors hover:bg-surface-overlay"
        renderTrigger={(open) => (
          <>
            <WalletName wallet={selected.wallet} label={selected.label} />
            <ChevronDown
              aria-hidden="true"
              className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
            />
          </>
        )}
        /* The row's three facts as one string, because a screen reader gets the
           chip and the eye as nothing otherwise: the chip is decoration to it
           and the glyph is `aria-hidden`. */
        optionLabel={(i) =>
          `${spokenName(options[i])}, ${options[i].own ? "your wallet" : "watch only"}`
        }
        optionClassName={({ active }) =>
          `flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-white/[0.06] ${
            active ? "bg-white/[0.06]" : ""
          }`
        }
        renderOption={(i, { selected: isSelected }) => {
          const o = options[i];
          return (
            <>
              <WalletName wallet={o.wallet} label={o.label} />
              {o.own ? (
                <Chip>Your wallet</Chip>
              ) : (
                /* No `title`: the glyph is decoration for a fact the row's own
                   `aria-label` already states, and a second hover wording is a
                   second thing to keep true. */
                <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              )}
              {/* Reserved either way, so committing a different row does not
                  reflow the list under the pointer. */}
              <span className="ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {isSelected && <Check aria-hidden="true" className="h-3.5 w-3.5 text-text-primary" />}
              </span>
            </>
          );
        }}
      />

      {/* The marker, not an essay: the full watch-only explanation lives in the
          Wallets panel and on the alerts themselves. `InfoTip` keeps it
          focusable, so the fact is not hover-only. */}
      {viewingWatchOnly && (
        <InfoTip text="Watch-only">
          <Eye className="h-4 w-4 shrink-0 cursor-help text-text-muted transition-colors hover:text-text-primary" />
        </InfoTip>
      )}
    </div>
  );
}

/**
 * A wallet as the reader knows it: what they called it, and the address that
 * proves which one it is. Both, because a name alone cannot be checked against
 * a wallet and an address alone is not what anyone called it.
 *
 * Unnamed wallets render the address once, in the primary ink. The alternative
 * was the address twice, or a placeholder name the user never chose.
 */
function WalletName({ wallet, label }: { wallet: string; label: string | null }) {
  const name = label?.trim();
  return (
    <span className="flex min-w-0 items-center gap-2">
      {name && (
        <span className="truncate font-sans text-xs font-bold text-text-primary">{name}</span>
      )}
      {/* Mono is reserved for hexadecimal, and this is the only hexadecimal in
          the control. The whole address on hover, as the Wallets panel does
          it: 42 characters is not something a reader checks by reading, it is
          something they check by comparing the ends. */}
      <span
        title={wallet}
        className={`shrink-0 font-mono text-xs ${name ? "text-text-muted" : "text-text-primary"}`}
      >
        {truncateAddress(wallet)}
      </span>
    </span>
  );
}
