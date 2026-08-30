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
 * The keyboard contract it implements is listed in docs/DESIGN_SYSTEM.md. Two
 * pieces of it are decisions rather than the spec, and they are the two a future
 * edit is likeliest to undo:
 *
 * FOCUS NEVER LEAVES THE TRIGGER. `aria-activedescendant` points at the row the
 * arrows are on, so a screen reader is told the row while the visible focus ring
 * stays on the control the reader is standing on. Moving focus into the panel
 * instead would draw the global `:focus-visible` ring around a 320px floating
 * box after a MOUSE click, announcing something the reader already knows. It
 * also makes the active row NOT the selection: arrowing must not reseed the
 * simulator on every press, so Enter (or Space) commits.
 *
 * THE PANEL'S EDGE IS MEASURED on open, not guessed at in a breakpoint. Both
 * triggers sit after a heading, so their left edge moves with the text above
 * them: on a phone a left-hung panel is the only one that fits, and once the
 * sidebar appears the same panel would run past the window.
 *
 * WHAT THE CONSUMER OWNS: the trigger's content and skin, each row's CONTENT,
 * and any per-row decoration that is the consumer's own fact (the market
 * picker's left rule on the selected row). Those genuinely differ - one lists
 * wallets with a check, the other markets with a band chip - and pretending
 * otherwise would mean one of them rendering a row it did not want.
 *
 * WHAT THIS FILE OWNS: the panel's box, the chevron that says which way it
 * opens, and - since the light theme - a row's HEIGHT and its active/hover
 * fill. That last pair moved in from the consumers, and the reason is on the
 * `<li>` below: both were painting the active row `bg-white/[0.06]`, which is a
 * visible wash on a dark panel and nothing at all on a white one. A listbox
 * whose active row is invisible has no keyboard affordance left, which is not a
 * fact either consumer should be able to get wrong on its own.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LAYER } from "./overlay";
import { useDismissOnOutsidePress } from "./useDismissOnOutsidePress";

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
  /**
   * What the trigger SAYS: the current value, in the consumer's own words. The
   * chevron is not part of it, because "there is a list behind this" is the
   * control's fact rather than the value's, and the two consumers had already
   * drawn it at two sizes.
   */
  trigger: React.ReactNode;
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
  /**
   * Replaces the panel's own width, `w-80` by default (see `PANEL_W` above).
   * The sidebar's block is 264px and has no room for a 320px panel spilling
   * past its own edge, so it passes `w-full` here to match the trigger
   * instead. A REPLACEMENT rather than an appended class: two width utilities
   * of equal specificity have the same problem `Card`'s doc comment already
   * names for `className` overrides, whichever one Tailwind emits last wins,
   * not whichever is listed last in the string. Omit it and every existing
   * caller is pixel-identical, since the default is the same `w-80` this
   * always rendered.
   */
  panelClassName?: string;
  /**
   * Which edge of the trigger the panel hangs from vertically, `"bottom"` by
   * default (the only value every existing caller ever rendered). The
   * sidebar's trigger sits at the bottom of a 900px viewport, and a panel
   * opening downward from there is clipped by the window with only its first
   * row visible. `"top"` swaps `top-full mt-2` for `bottom-full mb-2`, the
   * same 8px gap on the other edge; nothing about `alignRight`'s horizontal
   * measurement changes, since that answers a different question.
   */
  placement?: "bottom" | "top";
}

export function Listbox({
  label,
  count,
  selectedIndex,
  onCommit,
  trigger,
  triggerClassName,
  renderOption,
  optionClassName,
  optionLabel,
  className = "",
  panelClassName = "w-80",
  placement = "bottom",
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
   * Anywhere outside closes. The listener contract, and the reasoning that
   * settled on `mousedown` over a click or a backdrop element, now lives in
   * ui/useDismissOnOutsidePress so the app's two overlays cannot answer it
   * differently. The trigger is inside `wrap`, so one ref covers both.
   */
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePress([wrap], open ? dismiss : null);

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
        // No preventDefault: the reader leaves forwards rather than being
        // trapped or dropped at the top of the document.
        setOpen(false);
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
        {trigger}
        {/* The one mark that says this control has a list behind it, and it
            points where the list will appear. `aria-hidden`: `role="combobox"`
            and `aria-expanded` are what state this to a screen reader, and a
            glyph repeating it would be read as a second thing. */}
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-text-primary ${open ? "rotate-180" : ""}`}
        />
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
          /* A hard-edged white block with the 6px offset shadow, like every
             other floating surface here. The edge is `strong` rather than the
             old `subtle`: a popover on a light page is a control's boundary,
             and there is no darker surface underneath to separate it by tone.
             `shadow-hard` replaces `shadow-2xl`: the blurred shadow scale is
             gone from the theme entirely. */
          className={`absolute ${placement === "top" ? "bottom-full mb-2" : "top-full mt-2"} ${LAYER.popover} max-h-72 ${panelClassName} overflow-y-auto hard-edge bg-surface-overlay shadow-hard ${
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
                /* The row's HEIGHT and its highlight are the primitive's, and
                   they moved here from the two consumers for the same reason
                   the panel's own box did: both were painting the active row
                   `bg-white/[0.06]`, which was a visible wash on a dark panel
                   and is nothing at all on a white one. A listbox whose active
                   row is invisible has no keyboard affordance left, and that is
                   not a fact either consumer should be able to get wrong on its
                   own. `highlight` is the lavender the rest of the system uses
                   for "the thing you are on", and it is off the risk ramp, so a
                   highlighted market row is never read as a verdict.

                   The pointer's highlight stays in CSS (`hover:`). Letting the
                   mouse write `active` would have a stray pointer move silently
                   redirect what Enter commits. */
                className={`min-h-12 hover:bg-highlight ${state.active ? "bg-highlight" : ""} ${optionClassName(state)}`}
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
