/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which wallet PANIK is watching, and the control that changes it.
 *
 * THE CARD IS THE TRIGGER. The sidebar shape used to be a static block (name,
 * address, a "Switch" button, an inline `<ul>` of plain buttons under it) built
 * on the theory that the options were already in the page, so a combobox model
 * would teach a keyboard contract for something reachable with Tab alone.
 * Measured against the header's wallet menu and the Watch market picker, that
 * was two ideas of "a dropdown" in one product: one had `aria-activedescendant`
 * and arrow keys, the other was a button toggling a `<ul>` with none of it. The
 * block now wears the same `Listbox` primitive the phone strip below already
 * uses, so there is exactly one keyboard contract for "collapsed value, panel
 * of rows" anywhere in the app.
 *
 * WHAT STAYS A PLAIN BLOCK is the ONE-OPTION case: a trigger with nothing to
 * switch to is a picker that cannot pick, so with a single wallet this renders
 * the same identity as an inert `<div>`, no chevron, no pointer, nothing to
 * press. `checkedAt` sits under the block either way, outside the trigger,
 * because it is a fact about the reading, not part of the value being chosen.
 *
 * THE PANEL MATCHES THE SIDEBAR'S 264PX rather than the 320px every other
 * `Listbox` opens at, via the `panelClassName` escape hatch: a popover
 * spilling past the rail's own right edge would be the one floating surface
 * in the product that does not fit the space it opens from.
 *
 * WHAT THE ROWS CARRY, and why none of it is colour. The current wallet is
 * marked with a check (SC 1.4.1: never state anything by hue alone, and the
 * lavender behind it is the second signal, not the first). A watch-only row
 * wears the eye and the owner's wears nothing, which is the same distinction
 * WalletsPanel draws with a `Chip` and is all a 208px rail has room for. No
 * risk hue anywhere: which wallet you are looking at is not a risk band.
 */

import React from "react";
import { Check, Eye } from "lucide-react";
import { truncateAddress } from "../lib/utils";
import type { WalletChoice } from "../lib/watchlist";
import { Listbox } from "../ui";

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
   * The TOP-STRIP form, for the phone, where there is no sidebar to put a block
   * in.
   *
   * A prop rather than responsive classes because the two mounts are already
   * exclusive: the sidebar renders this only on a desktop and the shell's strip
   * renders it only when `!isDesktop`. One of them is the phone, so the phone's
   * shape is a fact about the call site, not about the width.
   *
   * It replaces the compact block this tab used to carry. That block was three
   * lines and a "Switch" button, sitting under the Portfolio's own heading and
   * above the recommendation the reader opened the tab for - roughly 90px of
   * the first screenful spent restating an address the strip above it was
   * already showing. The strip's address is the control now, so the fact and
   * the way to change it are one thing rather than two, and the Portfolio gets
   * that space back for the positions.
   *
   * BOTH SHAPES ARE `Listbox` NOW, the strip and the sidebar block alike, so
   * there is one keyboard contract for "collapsed value, panel of rows"
   * anywhere this control appears. What still differs is size and context: the
   * strip is `h-8` inside a 56px header with only the address on show, where
   * the sidebar's `h-14` trigger is the whole block, carrying a name line and
   * the panel sized to the rail's own 264px rather than this primitive's usual
   * 320px.
   */
  bar?: boolean;
}

export function WalletSelector({
  options,
  value,
  onChange,
  checkedAt,
  bar = false,
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

  // The address once, not twice: an unnamed wallet IS its address, and
  // "0x9b1f…a5c7, 0x9b1f…a5c7" is a row read out stuttering.
  const spokenName = (o: WalletChoice) => {
    const named = o.label?.trim();
    return named ? `${named}, ${truncateAddress(o.wallet)}` : truncateAddress(o.wallet);
  };
  /** A row's accessible name: its identity plus which KIND of wallet it is. */
  const rowLabel = (o: WalletChoice) =>
    `${spokenName(o)}, ${o.own ? "your wallet" : "watch only"}`;

  /**
   * What a row SHOWS, written once and rendered by both lists below. The two
   * differ in the widget they sit in and in nothing a reader can see, so a
   * second copy of this would be two wallet rows that drift apart.
   */
  const rowBody = (o: WalletChoice, current: boolean) => (
    <>
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
      {/* The eye marks a watch-only row, and its ABSENCE marks the owner's. The
          owner's row used to wear the `Chip` WalletsPanel gives it, which is the
          right marker on a panel and the wrong one in a 208px rail: measured,
          "Your wallet" at 90px left the name and the address 60px between them
          and both ellipsised to "Moc…" and "0x4c…". The fact is not lost, it is
          in the row's accessible name, and losing the address is losing the only
          thing that identifies the wallet.

          No `title` on the glyph: it is decoration for a fact the row's own
          accessible name already states, and a second hover wording is a second
          thing to keep true. */}
      {!o.own && <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
      {/* Reserved either way, so committing a different row does not reflow the
          list under the pointer. */}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {current && <Check aria-hidden="true" className="h-3.5 w-3.5 text-text-primary" />}
      </span>
    </>
  );

  if (bar) {
    /* With one wallet there is nothing to switch TO, so the strip states the
       address and offers no control: a trigger with one option is a picker that
       cannot pick, and on a 56px strip it would be the only thing next to the
       mark implying the app could be showing something else. Same test the
       sidebar block applies to its own button. */
    if (options.length < 2) {
      return (
        <span
          title={selected.wallet}
          className="truncate font-mono text-xs font-bold text-text-primary"
        >
          {truncateAddress(selected.wallet)}
        </span>
      );
    }
    return (
      <Listbox
        label="Which wallet to show"
        count={options.length}
        selectedIndex={selectedIndex}
        onCommit={(i) => onChange(options[i].wallet)}
        /* `h-8` rather than the 48px a `Button` is: the strip it sits in is
           56px tall. Still over the 24px target floor (SC 2.5.8). */
        triggerClassName="flex h-8 min-w-0 cursor-pointer items-center gap-1.5 hard-edge px-2"
        trigger={
          /* The address and nothing else, because that is what the strip said
             before this became pressable: a label here would be a second name
             for the wallet in the one place there is no room for one. */
          <span className="truncate font-mono text-xs font-bold text-text-primary">
            {truncateAddress(selected.wallet)}
          </span>
        }
        optionLabel={(i) => rowLabel(options[i])}
        optionClassName={({ selected: sel, active }) =>
          `flex w-full items-center gap-2 px-3 py-2.5 text-left ${
            active ? "bg-highlight" : sel ? "bg-highlight" : ""
          }`
        }
        renderOption={(i, { selected: sel }) => rowBody(options[i], sel)}
      />
    );
  }

  /**
   * The block's left column, shared by both shapes below: a name (when the
   * wallet has one) over the truncated address, both truncating rather than
   * wrapping so the block never grows past its own two lines.
   */
  const identity = (
    <span className="flex min-w-0 flex-1 flex-col">
      {selected.label?.trim() && (
        <span className="truncate font-sans text-sm font-bold text-text-primary">
          {selected.label.trim()}
        </span>
      )}
      <span
        title={selected.wallet}
        className="truncate font-mono text-xs font-bold text-text-primary"
      >
        {truncateAddress(selected.wallet)}
      </span>
    </span>
  );

  return (
    <div>
      {options.length < 2 ? (
        /* With one wallet there is nothing to switch TO, so the block states
           the identity and offers no control: a trigger with one option is a
           picker that cannot pick. Same test the bar shape applies to
           itself above. */
        <div className="flex h-14 w-full items-center justify-between gap-2 hard-edge bg-surface-raised px-3">
          {identity}
          {!selected.own && (
            <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          )}
        </div>
      ) : (
        <Listbox
          label="Which wallet to show"
          count={options.length}
          selectedIndex={selectedIndex}
          onCommit={(i) => onChange(options[i].wallet)}
          trigger={
            <>
              {identity}
              {!selected.own && (
                <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              )}
            </>
          }
          triggerClassName="flex h-14 w-full cursor-pointer items-center justify-between gap-2 hard-edge bg-surface-raised px-3"
          /* The panel matches the trigger's own 264px rather than the 320px
             every other `Listbox` opens at: the sidebar has no room for a
             floating panel spilling past its own right edge. */
          panelClassName="w-full"
          optionLabel={(i) => rowLabel(options[i])}
          optionClassName={({ selected: sel, active }) =>
            `flex w-full items-center gap-2 px-3 py-2.5 text-left ${
              active ? "bg-highlight" : sel ? "bg-highlight" : ""
            }`
          }
          renderOption={(i, { selected: sel }) => rowBody(options[i], sel)}
        />
      )}

      {/* A fact the code knows, so it stays: how old the reading on screen is
          is the one thing a reader cannot work out by looking at it. */}
      {checkedAt && (
        <span className="mt-1.5 block font-sans text-xs text-text-muted">{checkedAt}</span>
      )}
    </div>
  );
}
