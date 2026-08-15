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
 * `Chip`, literally the marker WalletsPanel gives it, so one wallet does not
 * have two names for the same fact across two surfaces. Every other row is
 * watch-only by construction and wears the eye.
 *
 * NO RISK HUE ANYWHERE. Which wallet you are looking at is not a risk band, and
 * the eye is an informational glyph: `text-muted`, like every other one.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Eye } from "lucide-react";
import { truncateAddress } from "../lib/utils";
import type { WalletChoice } from "../lib/watchlist";
import { Chip } from "../ui";
import { InfoTip } from "./InfoTip";

export interface WalletSelectorProps {
  /** Built by `viewableWallets`, which is the authority on what may be shown. */
  options: WalletChoice[];
  /** The wallet currently shown, already validated against `options`. */
  value: string;
  onChange: (wallet: string) => void;
}

/**
 * The panel's width, and it is `w-72` on the `<ul>` below written as a number.
 * THE TWO TRAVEL TOGETHER: this is what decides which edge the panel hangs
 * from, and it is read before the panel exists, so it cannot be measured off
 * the element. Change one and change the other in the same edit.
 */
const PANEL_W = 288;

export function WalletSelector({ options, value, onChange }: WalletSelectorProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const triggerId = `${baseId}-trigger`;
  const labelId = `${baseId}-label`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const target = value.toLowerCase();
  // The one guard, and it is here rather than at every read of `selected`:
  // `value` arrives pre-validated against `options` (AppDemo falls back to the
  // bound wallet the moment a selection stops being watched), so a miss is a
  // caller bug and the first row is the honest thing to draw while it lasts.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.wallet === target),
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
  const viewingWatchOnly = !selected.own;

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

  /**
   * Opening is one event, so it decides everything about the panel at once:
   * where the arrow keys start and which edge it hangs from. The trigger is on
   * screen and measurable right here, so the anchor's box is read before the
   * panel exists rather than after a layout effect has already painted it on
   * the wrong side.
   */
  const openList = () => {
    setActiveIndex(selectedIndex);
    const box = wrap.current?.getBoundingClientRect();
    if (box) {
      // 16px of gutter on both sides, the page's own narrowest padding. Falls
      // back to the left anchor when the panel fits at neither edge, which is
      // the honest answer on a viewport narrower than the panel.
      const room = document.documentElement.clientWidth - 16;
      setAlignRight(box.left + PANEL_W > room && box.right - PANEL_W >= 16);
    }
    setOpen(true);
  };

  const commit = (i: number) => {
    onChange(options[i].wallet);
    setOpen(false);
  };

  /**
   * The active row, and the scroll that keeps it visible.
   *
   * Both together, because they are one act: eleven wallets is more than the
   * panel's `max-h-72` shows, and an arrow key that moves a highlight out of
   * frame has moved it nowhere the reader can see. The rows are all mounted,
   * so the element at `next` is already there to scroll to.
   */
  const moveTo = (next: number) => {
    setActiveIndex(next);
    list.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  // The one thing a keypress cannot do: the panel does not exist yet when
  // `openList` runs, so the row it opened on is put in view once it does.
  // Deliberately NOT keyed on `activeIndex` - `moveTo` owns every move after
  // this, and re-running here would scroll twice per press.
  useEffect(() => {
    if (!open) return;
    list.current?.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [open]);

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
        openList();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(Math.min(options.length - 1, activeIndex + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(Math.max(0, activeIndex - 1));
        break;
      case "Home":
        e.preventDefault();
        moveTo(0);
        break;
      case "End":
        e.preventDefault();
        moveTo(options.length - 1);
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
          onClick={() => (open ? setOpen(false) : openList())}
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
          <WalletName wallet={selected.wallet} label={selected.label} />
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
            /* `w-72` is `PANEL_W`, and the two travel together: at a 390px
               viewport the trigger sits at the content column's left margin
               and the panel ends at 304px, so it cannot push the page wide.
               `overlay` is the token for a popover; `border-subtle` because
               this edge is decoration around content, not the boundary of a
               control. */
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
                  /* Two highlights, one look, and they are not the same thing.
                     The pointer's is `hover:` and stays in CSS: it follows the
                     mouse and nothing in React needs to know where that is.
                     `activeIndex` is the KEYBOARD's row, which is also what
                     `aria-activedescendant` points at, so letting the mouse
                     write it would have a stray pointer move silently
                     redirect what Enter commits. */
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 transition-colors hover:bg-white/[0.06] ${
                    i === activeIndex ? "bg-white/[0.06]" : ""
                  }`}
                >
                  <WalletName wallet={o.wallet} label={o.label} />
                  {o.own ? (
                    <Chip>Your wallet</Chip>
                  ) : (
                    /* No `title`: the glyph is decoration for a fact the row's
                       own `aria-label` already states, and a second hover
                       wording is a second thing to keep true. */
                    <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />
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
