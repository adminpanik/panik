/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which wallet PANIK is watching, and the control that changes it.
 *
 * IT IS A BLOCK NOW, NOT A DROPDOWN, and that is the whole change. It used to
 * be a `Listbox` beside the Portfolio heading, one of three floating panels the
 * shell could open over itself: a wallet menu in the header, an account menu
 * beside it and this. Every one of them was a shadowed layer that appeared
 * somewhere the pointer was not, over content the reader was mid-way through.
 * The sidebar has a permanent 208px of room at the bottom and nothing in it,
 * which is where a fact that is true on every screen belongs.
 *
 * So the block STATES the answer - the name, the address and when it was last
 * read - and the list only appears when there is a choice to make, inline,
 * pushing the block up rather than covering anything. No shadow on it, because
 * it is not floating over anything to cast one.
 *
 * A PLAIN LIST OF BUTTONS, not the `Listbox` primitive. That one is a combobox:
 * a collapsed trigger reporting a value, with `aria-activedescendant` and a
 * roving cursor, and every part of that contract exists because the options are
 * NOT in the page. These are: they are five buttons in the sidebar's own flow,
 * each reachable with Tab and pressable with Enter or Space for free, and
 * dressing them as a combobox would add a keyboard model a reader has to learn
 * in order to use something they can already see.
 *
 * WHAT THE ROWS CARRY, and why none of it is colour. The current wallet is
 * marked with a check (SC 1.4.1: never state anything by hue alone, and the
 * lavender behind it is the second signal, not the first). A watch-only row
 * wears the eye and the owner's wears nothing, which is the same distinction
 * WalletsPanel draws with a `Chip` and is all a 208px rail has room for. No
 * risk hue anywhere: which wallet you are looking at is not a risk band.
 */

import React, { useId, useState } from "react";
import { Check, Eye } from "lucide-react";
import { truncateAddress } from "../lib/utils";
import type { WalletChoice } from "../lib/watchlist";
import { Button } from "../ui";

export interface WalletSelectorProps {
  /** Built by `viewableWallets`, which is the authority on what may be shown. */
  options: WalletChoice[];
  /** The wallet currently shown, already validated against `options`. */
  value: string;
  onChange: (wallet: string) => void;
  /**
   * When the figures for this wallet were last read, already worded, or null
   * when the feed has not answered. Null renders no line rather than an epoch
   * date: see `checkedAgo` in lib/utils.
   */
  checkedAt: string | null;
  /**
   * The one-line form, for the mount inside the Portfolio tab below `md`.
   *
   * A prop rather than responsive classes because the two mounts are already
   * exclusive: the sidebar renders this only on a desktop and the Portfolio tab
   * renders it only when `!isDesktop`. One of them is the phone, so the phone's
   * shape is a fact about the call site, not about the width.
   *
   * What it drops is what the phone states elsewhere: the address is in the top
   * strip on every screen, and how old the reading is has a whole feed card of
   * its own on this tab. What it keeps is the name, the watch-only marker and
   * the control, because those three are the wallet's identity and the only
   * thing this block does.
   */
  compact?: boolean;
}

export function WalletSelector({
  options,
  value,
  onChange,
  checkedAt,
  compact = false,
}: WalletSelectorProps) {
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
  const [open, setOpen] = useState(false);
  const listId = useId();

  // The address once, not twice: an unnamed wallet IS its address, and
  // "0x9b1f…a5c7, 0x9b1f…a5c7" is a row read out stuttering.
  const spokenName = (o: WalletChoice) => {
    const named = o.label?.trim();
    return named ? `${named}, ${truncateAddress(o.wallet)}` : truncateAddress(o.wallet);
  };

  return (
    <div className="hard-edge bg-surface-raised">
      <div
        className={
          compact
            ? "flex items-center justify-between gap-3 p-3"
            : "space-y-1.5 p-3"
        }
      >
        <div className={compact ? "min-w-0 space-y-0.5" : "space-y-1.5"}>
        <span className="block label-type text-xs text-text-secondary">Watching wallet</span>

        {selected.label?.trim() && (
          <span className="block truncate font-sans text-sm font-bold text-text-primary">
            {selected.label.trim()}
          </span>
        )}
        {/* Mono is reserved for hexadecimal, and this is the only hexadecimal
            in the block. The whole address on hover, as the Wallets panel does
            it: 42 characters is not something a reader checks by reading, it is
            something they check by comparing the ends. */}
        {/* The address is the NAME when there is no other one, so it is
            dropped on the compact form only where a label already stands in
            for it. Otherwise the block would state nothing at all. */}
        {!(compact && selected.label?.trim()) && (
          <span
            title={selected.wallet}
            className="block truncate font-mono text-base font-bold text-text-primary"
          >
            {truncateAddress(selected.wallet)}
          </span>
        )}

        {/* The marker, not an essay: the full watch-only explanation lives in
            the Wallets panel and on the alerts themselves. */}
        {!selected.own && (
          <span className="flex items-center gap-1.5 font-sans text-sm text-text-secondary">
            <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Watch only
          </span>
        )}

        {/* A fact the code knows, so it stays: how old the reading on screen is
            is the one thing a reader cannot work out by looking at it. */}
        {checkedAt && !compact && (
          <span className="block font-sans text-sm text-text-secondary">{checkedAt}</span>
        )}
        </div>

        {/* Only when there is a choice to make. With one wallet on the list the
            control has exactly one option, which is a picker that cannot pick,
            and it would sit in the sidebar on every screen implying the app
            could be showing something else. */}
        {options.length > 1 && (
          <Button
            variant={compact ? "secondary" : "ghost"}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
            className={compact ? "h-11 shrink-0 px-4" : "h-8 px-0"}
          >
            {open ? "Close" : "Switch"}
          </Button>
        )}
      </div>

      {open && options.length > 1 && (
        <ul id={listId} className="border-t-[3px] border-solid border-border-strong">
          {options.map((o, i) => {
            const current = i === selectedIndex;
            return (
              <li
                key={o.wallet}
                className={i > 0 ? "border-t border-border-subtle" : ""}
              >
                <button
                  type="button"
                  /* `aria-current` rather than `aria-selected`: this is a set of
                     links to one of several views, not a set of options inside
                     a widget that reports a value. */
                  aria-current={current ? "true" : undefined}
                  aria-label={`${spokenName(o)}, ${o.own ? "your wallet" : "watch only"}`}
                  onClick={() => {
                    onChange(o.wallet);
                    setOpen(false);
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left hover:bg-highlight ${
                    current ? "bg-highlight" : ""
                  }`}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    {o.label?.trim() && (
                      <span className="truncate font-sans text-xs font-bold text-text-primary">
                        {o.label.trim()}
                      </span>
                    )}
                    <span className="truncate font-mono text-xs text-text-primary">
                      {truncateAddress(o.wallet)}
                    </span>
                  </span>
                  {/* The eye marks a watch-only row, and its ABSENCE marks the
                      owner's. The owner's row used to wear the `Chip`
                      WalletsPanel gives it, which is the right marker on a
                      panel and the wrong one in a 208px rail: measured, "Your
                      wallet" at 90px left the name and the address 60px between
                      them and both ellipsised to "Moc…" and "0x4c…". The fact
                      is not lost, it is in the row's `aria-label`, and losing
                      the address is losing the only thing that identifies the
                      wallet.

                      No `title` on the glyph: it is decoration for a fact the
                      row's own accessible name already states, and a second
                      hover wording is a second thing to keep true. */}
                  {!o.own && (
                    <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  )}
                  {/* Reserved either way, so committing a different row does not
                      reflow the list under the pointer. */}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {current && <Check aria-hidden="true" className="h-3.5 w-3.5 text-text-primary" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
