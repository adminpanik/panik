/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which watched wallet the Portfolio is about.
 *
 * A hand-rolled listbox rather than a `<select>`, which is what this was. A
 * native select paints its own popup from the OS: system chrome, a system blue
 * highlight, and no way to put a label, a hex address and a marker on one row
 * without flattening them into a single string with separators in it. The
 * flattened string was the actual cost — "Cold storage · 0x9b1f…a5c7 · your
 * wallet" is three facts a reader has to parse out of one line, and the marker
 * that says whose money this is sat at the end of it.
 *
 * WHAT THE ROWS CARRY, and why each is not colour. The selected row is marked
 * with a check (SC 1.4.1: never state anything by hue alone, and the tinted
 * background here is the second signal, not the first). The owner's row wears
 * the same neutral chip WalletsPanel gives it, so one wallet does not have two
 * names for the same fact across two surfaces. Every other row is watch-only by
 * construction and wears the eye.
 *
 * NO RISK HUE ANYWHERE. Which wallet you are looking at is not a risk band, and
 * the eye is an informational glyph: `text-muted`, like every other one.
 */

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Eye } from "lucide-react";
import { truncateAddress } from "../lib/utils";
import { InfoTip } from "./InfoTip";

export interface WalletChoice {
  /** Lowercased address. */
  wallet: string;
  /** What the user called it on the watchlist, or null when unnamed. */
  label: string | null;
  /** The bound wallet: the owner, the signer, and where alerts go. */
  own: boolean;
}

export interface WalletSelectorProps {
  options: WalletChoice[];
  /** The wallet currently shown, already validated against `options`. */
  value: string;
  /**
   * The bound wallet, for the watch-only note.
   *
   * Passed in rather than read off `options.find(o => o.own)` at the call site's
   * convenience: the note names the address alerts are actually sent to, and
   * that is a fact about the session, not about this list.
   */
  ownerWallet: string;
  onChange: (wallet: string) => void;
}

/**
 * What is and is not true of a wallet you only watch.
 *
 * The three facts the header used to state as a standing sentence under the
 * page title. Two of them are answers to a question nobody asks twice (PANIK
 * cannot act on it) and the third is the one nobody would guess (switching the
 * view does not move where alerts go, because the subscription belongs to the
 * wallet that signed for it). That is the `InfoTip` case exactly: valuable on
 * request, noise on every glance.
 */
export function watchOnlyNote(ownerWallet: string): string {
  return (
    "A wallet you watch, not one you control. PANIK cannot act on it, so exits are not " +
    `offered here. Alerts still go to ${truncateAddress(ownerWallet)}.`
  );
}

/** The neutral marker WalletsPanel already gives the owner's row. */
const CHIP =
  "shrink-0 rounded-sm border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-2xs font-sans font-bold text-text-muted";

export function WalletSelector({ options, value, ownerWallet, onChange }: WalletSelectorProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const triggerId = `${baseId}-trigger`;
  const labelId = `${baseId}-label`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.wallet === value.toLowerCase()),
  );
  /**
   * The row the arrow keys are on, which is NOT the selection. Moving through a
   * listbox with the keyboard must not change what the page is showing on every
   * press: each step would refetch a wallet's positions, and a reader arrowing
   * past two names to reach a third would watch the dashboard rebuild twice on
   * the way. Enter commits.
   */
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const selected = options[selectedIndex];
  const viewingWatchOnly = selected !== undefined && !selected.own;

  /**
   * Which edge of the trigger the panel hangs from.
   *
   * Left by default, and it has to flip: this control sits after the page
   * heading, so its left edge is wherever "DeFi Portfolio" ends. On a phone the
   * heading wraps and the trigger starts at the content column's left margin,
   * where a left-hung panel is the only one that fits. Once the sidebar appears
   * the trigger has moved ~470px right and the same panel runs to the window
   * edge, past the column's own padding. Neither anchor is right at both sizes,
   * so it is measured on open rather than guessed at in a breakpoint.
   */
  const [alignRight, setAlignRight] = useState(false);

  const openAt = (i: number) => {
    setActiveIndex(i);
    setOpen(true);
  };

  const commit = (i: number) => {
    const choice = options[i];
    if (choice) onChange(choice.wallet);
    setOpen(false);
  };

  // Measured before paint, so an opened panel never renders on the wrong edge
  // and then jumps to the other one.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = list.current;
    const anchor = wrap.current;
    if (!panel || !anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    // 16px of gutter on both sides, the page's own narrowest padding. Falls
    // back to the left anchor when the panel fits at neither edge, which is
    // the honest answer on a viewport narrower than the panel.
    const room = document.documentElement.clientWidth - 16;
    setAlignRight(box.left + width > room && box.right - width >= 16);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  /**
   * Anywhere outside closes, which is the whole job a backdrop element would do
   * and none of the cost: a `fixed inset-0` catcher swallows the first click on
   * whatever the reader was actually reaching for, so dismissing the list and
   * pressing the next control takes two clicks instead of one.
   *
   * `mousedown`, not `click`: a press that starts outside and ends inside (a
   * drag over the panel) should still dismiss, and waiting for the click lets
   * the list eat it.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /**
   * Every key, on the trigger, because the trigger never gives up focus.
   *
   * This is the APG select-only combobox rather than a listbox the focus moves
   * into, and the reason is what the two look like. Focusing the panel puts the
   * app's `:focus-visible` ring around the whole floating list, which after a
   * MOUSE click is a 288px orange rectangle announcing something the reader
   * already knows. Keeping focus on the trigger and pointing
   * `aria-activedescendant` at the active row gives a screen reader the same
   * information with the indicator on the control the reader is actually on.
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openAt(selectedIndex);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        // No preventDefault: the panel closes and the browser moves on from the
        // trigger, so the reader leaves the control forwards rather than being
        // trapped or dropped back at the top of the page.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="relative min-w-0" ref={wrap}>
        {/* The control's NAME, hidden because the page heading beside it names
            the page rather than this. `aria-labelledby` pairs it with the
            button's own text so a screen reader reads the label and then the
            wallet; an `aria-label` here would replace the value with the label
            and the reader would never hear which wallet is selected. */}
        <span id={labelId} hidden>
          Which watched wallet to show
        </span>
        <button
          id={triggerId}
          type="button"
          onClick={() => (open ? setOpen(false) : openAt(selectedIndex))}
          onKeyDown={onKey}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          aria-labelledby={`${labelId} ${triggerId}`}
          /* `border-strong`, not `subtle`. This is a control edge, and WCAG
             1.4.11 asks 3:1 of one: `surface-raised` on `surface-base` is a
             1.2:1 step, so the border is the only thing making the hit area
             findable. The floating panel below is a container rather than a
             control and takes the decorative edge. */
          className="flex h-9 max-w-full cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface-raised px-3 font-sans text-xs transition-colors hover:bg-surface-overlay"
        >
          <WalletName wallet={selected?.wallet ?? value} label={selected?.label ?? null} />
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <ul
            ref={list}
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            // Keeps the press from blurring the trigger: an option is not
            // focusable, so without this the browser drops focus on the body
            // and the reader's next Tab starts from the top of the document.
            onMouseDown={(e) => e.preventDefault()}
            /* `w-72` is 288px: at a 390px viewport the trigger sits at the
               content column's left margin and the panel ends at 304px, so it
               cannot push the page wide. `overlay` is the token for a popover;
               `border-subtle` because this edge is decoration around content,
               not the boundary of a control. */
            className={`absolute top-full z-50 mt-2 max-h-72 w-72 overflow-y-auto rounded-md border border-border-subtle bg-surface-overlay py-1 shadow-2xl ${alignRight ? "right-0" : "left-0"}`}
          >
            {options.map((o, i) => {
              const isSelected = i === selectedIndex;
              const named = o.label?.trim();
              // The address once, not twice: an unnamed wallet IS its address,
              // and "0x9b1f…a5c7, 0x9b1f…a5c7" is a row read out stuttering.
              const spoken = named ? `${named}, ${truncateAddress(o.wallet)}` : truncateAddress(o.wallet);
              return (
                <li
                  key={o.wallet}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  /* The row's three facts as one string, because a screen
                     reader gets the chip and the eye as nothing otherwise: the
                     chip is decoration to it and the glyph is `aria-hidden`. */
                  aria-label={`${spoken}, ${o.own ? "your wallet" : "watch only"}`}
                  onClick={() => commit(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors ${
                    i === activeIndex ? "bg-white/[0.06]" : ""
                  }`}
                >
                  <WalletName wallet={o.wallet} label={o.label} />
                  {o.own ? (
                    <span className={CHIP}>Your wallet</span>
                  ) : (
                    <span className="flex shrink-0 items-center" title="A wallet you watch">
                      <Eye aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
                    </span>
                  )}
                  {/* Reserved either way, so committing a different row does not
                      reflow the list under the pointer. */}
                  <span className="ml-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {isSelected && <Check aria-hidden="true" className="h-3.5 w-3.5 text-text-primary" />}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The watch-only note, on the glyph rather than as a paragraph under the
          heading. `InfoTip` puts the whole sentence on the wrapper's
          `aria-label` and makes it focusable, so the fact is not hover-only. */}
      {viewingWatchOnly && (
        <InfoTip text={watchOnlyNote(ownerWallet)}>
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
          the control. */}
      <span
        className={`shrink-0 font-mono text-xs ${name ? "text-text-muted" : "text-text-primary"}`}
      >
        {truncateAddress(wallet)}
      </span>
    </span>
  );
}
