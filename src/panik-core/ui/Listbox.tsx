/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The app's ONE dropdown: a trigger that names the current value, and a floating
 * list of rows to choose a new one from.
 *
 * This is the WAI-ARIA select-only combobox, and it is here because the product
 * had two dropdowns that were not the same control. `WalletSelector` had all of
 * this; the Watch market picker had a button, a `<ul>`, and nothing else, so on
 * the one screen where a reader compares four positions before acting on one,
 * the list could not be opened, moved through, or dismissed from a keyboard at
 * all. It also carried its own copy of the outside-click effect, which is the
 * state a duplicated contract is in right up until one copy gets a fix.
 *
 * WHAT THE MECHANISM IS, all of which the consumers get for free:
 *   - focus never leaves the trigger. `aria-activedescendant` points at the row
 *     the arrows are on, so a screen reader is told the row while the visible
 *     focus ring stays on the control the reader is standing on. Moving focus
 *     into the panel instead would draw the global `:focus-visible` ring around
 *     a 320px floating box after a MOUSE click, announcing something the reader
 *     already knows.
 *   - the active row is NOT the selection. Arrowing through a list must not
 *     change what the page shows on every press: on Watch each step would
 *     reseed the simulator, so a reader passing two markets to reach a third
 *     would watch the panel rebuild twice on the way. Enter (or Space) commits.
 *   - arrows, Home and End, each pinned into view with `scrollIntoView`, since
 *     a highlight moved out of frame has moved somewhere the reader cannot see.
 *   - Escape closes; Tab closes WITHOUT preventDefault, so the reader leaves
 *     forwards rather than being trapped or dropped at the top of the document;
 *     a mousedown anywhere outside closes.
 *   - the panel's edge is MEASURED on open, not guessed at in a breakpoint. Both
 *     triggers sit after a heading, so their left edge moves with the text above
 *     them: on a phone a left-hung panel is the only one that fits, and once the
 *     sidebar appears the same panel would run past the window.
 *
 * WHAT THE CONSUMER OWNS: the trigger's content and skin, and each row's content
 * and skin. Those genuinely differ (one lists wallets with a check, the other
 * markets with a band chip), and pretending otherwise would mean one of them
 * rendering a row it did not want. Everything else, including the panel's own
 * box, is decided here so the two lists cannot drift apart again.
 */

import React, { useEffect, useId, useRef, useState } from "react";

/**
 * The panel's width, and it is the `w-80` on the `<ul>` below written as a
 * number. THE TWO TRAVEL TOGETHER: this is what decides which edge the panel
 * hangs from, and it is read before the panel exists, so it cannot be measured
 * off the element. Change one and change the other in the same edit.
 *
 * 320 is what the widest row needs. Under it, the row a list exists to state
 * (the selected one, which is the only one wearing a marker) is the one that
 * ellipsises. It does not go wider either: at a 390px viewport the panel hangs
 * from the content column's 16px margin, so 320 ends at 336 and 384 (`w-96`)
 * would end 10px past the window.
 */
const PANEL_W = 320;

/** What a row is being asked to look like. */
export interface ListboxOptionState {
  /** This row is the current value. */
  selected: boolean;
  /** This row is where the arrow keys are. Not the selection: see the header. */
  active: boolean;
}

export interface ListboxProps {
  /**
   * The control's name, rendered hidden and pointed at by both the trigger and
   * the list. `aria-labelledby` pairs it with the trigger's own text so a screen
   * reader reads the label and then the value; an `aria-label` on the trigger
   * would replace the value with the label and the reader would never hear which
   * row is selected.
   */
  label: string;
  count: number;
  /** The current value's row, and where the arrow keys start on open. */
  selectedIndex: number;
  onCommit: (index: number) => void;
  renderTrigger: (open: boolean) => React.ReactNode;
  triggerClassName: string;
  renderOption: (index: number, state: ListboxOptionState) => React.ReactNode;
  optionClassName: (state: ListboxOptionState) => string;
  /**
   * A row's three facts as one string, for the rows whose markers are invisible
   * to a screen reader (a chip is decoration to it, a glyph is `aria-hidden`).
   * Omitted where the row's own text already says everything.
   */
  optionLabel?: (index: number) => string;
  /** Extra utilities on the positioning wrapper, which is always `relative`. */
  className?: string;
}

export function Listbox({
  label,
  count,
  selectedIndex,
  onCommit,
  renderTrigger,
  triggerClassName,
  renderOption,
  optionClassName,
  optionLabel,
  className = "",
}: ListboxProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const triggerId = `${baseId}-trigger`;
  const labelId = `${baseId}-label`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const [open, setOpen] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  /**
   * Which edge of the trigger the panel hangs from, measured on open. Left by
   * default, and the fallback when the panel fits at neither edge, which is the
   * honest answer on a viewport narrower than the panel.
   */
  const [alignRight, setAlignRight] = useState(false);

  /**
   * Opening is one event, so it decides everything about the panel at once:
   * where the arrow keys start and which edge it hangs from. The trigger is on
   * screen and measurable right here, so the anchor's box is read before the
   * panel exists rather than after a layout effect has already painted it on the
   * wrong side.
   */
  const openList = () => {
    setActiveIndex(selectedIndex);
    const box = wrap.current?.getBoundingClientRect();
    if (box) {
      // 16px of gutter on both sides, the page's own narrowest padding.
      const room = document.documentElement.clientWidth - 16;
      setAlignRight(box.left + PANEL_W > room && box.right - PANEL_W >= 16);
    }
    setOpen(true);
  };

  const commit = (i: number) => {
    onCommit(i);
    setOpen(false);
  };

  /**
   * The active row, and the scroll that keeps it visible. Both together, because
   * they are one act: either list can hold more rows than `max-h-72` shows. The
   * rows are all mounted, so the element at `next` is already there.
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

  /** Every key, on the trigger, because the trigger never gives up focus. */
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
        moveTo(Math.min(count - 1, activeIndex + 1));
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
        moveTo(count - 1);
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
        // No preventDefault: see the header.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className={`relative ${className}`} ref={wrap}>
      <span id={labelId} hidden>
        {label}
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
        className={triggerClassName}
      >
        {renderTrigger(open)}
      </button>

      {open && (
        <ul
          ref={list}
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          // Keeps the press from blurring the trigger: an option is not
          // focusable, so without this the browser drops focus on the body and
          // the reader's next Tab starts from the top of the document.
          onMouseDown={(e) => e.preventDefault()}
          /* `w-80` is `PANEL_W`, and the two travel together. `overlay` is the
             token for a popover; `border-subtle` because this edge is decoration
             around content, not the boundary of a control. */
          className={`absolute top-full z-50 mt-2 max-h-72 w-80 overflow-y-auto rounded-md border border-border-subtle bg-surface-overlay py-1 shadow-2xl ${
            alignRight ? "right-0" : "left-0"
          }`}
        >
          {Array.from({ length: count }, (_, i) => {
            const state = { selected: i === selectedIndex, active: i === activeIndex };
            return (
              <li
                key={i}
                id={optionId(i)}
                role="option"
                aria-selected={state.selected}
                aria-label={optionLabel?.(i)}
                onClick={() => commit(i)}
                /* Two highlights, one look, and they are not the same thing.
                   The pointer's is `hover:` and stays in CSS: it follows the
                   mouse and nothing in React needs to know where that is.
                   `active` is the KEYBOARD's row, which is also what
                   `aria-activedescendant` points at, so letting the mouse write
                   it would have a stray pointer move silently redirect what
                   Enter commits. */
                className={optionClassName(state)}
              >
                {renderOption(i, state)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
