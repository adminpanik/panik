/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What this internal console needs that src/panik-core/ui does not have.
 * Everything else (Card, Button, Chip, Stat, EmptyState, Skeleton, Field) is
 * imported from the product's primitives rather than reimplemented, so the
 * admin surface cannot drift into looking like a different product.
 *
 * `Field` is that rule applied to itself: the CONTROL is the product's own
 * `ui/Field`, floating label and all, so an operator types into the same box
 * the app ships. What stays local is the hint line under it, which the
 * product's field does not have and which the console's dense forms need.
 *
 * The other four are shapes the product has but has not extracted: a panel
 * with a title band, a 32px band control, and the ledger table the Portfolio
 * positions list draws by hand inside `AppDemo`. They are built here rather
 * than added to `panik-core/ui` because this console is the only caller so
 * far, and a primitive with one consumer is a guess about the second.
 *
 * No `focus:` classes here on purpose. src/index.css carries one global
 * `:focus-visible` rule, which is what stops a control shipping without a ring.
 */

import React from "react";
import { RefreshCw } from "lucide-react";

import { Card, Field as CoreField } from "../../panik-core/ui";

interface FieldProps extends Omit<React.ComponentProps<typeof CoreField>, "size"> {
  /** Shown under the input. For a constraint, not for restating the label. */
  hint?: string;
  /** Wrapper width and placement. The input inside is always full width. */
  wrapClassName?: string;
}

export function Field({ hint, wrapClassName = "", ...rest }: FieldProps) {
  return (
    <div className={wrapClassName}>
      <CoreField {...rest} />
      {hint ? <p className="mt-1.5 font-sans text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

// ── the shell's header ──────────────────────────────────────────────────────

/**
 * The 64px band across the top of every admin screen, sign-in included.
 *
 * It is here rather than in App.tsx because the sign-in form renders it too and
 * App imports SignIn: putting it there would be a cycle, and copying it would
 * be the second header treatment this console has had.
 *
 * The wordmark shortens below `sm` rather than wrapping. At 390px the right
 * side is a Sign out button and nothing else, and "PANIK Admin" beside it is
 * the difference between one row and two.
 */
export function AdminHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-16 items-center gap-3 border-b-[3px] border-border-strong bg-surface-raised px-4 sm:px-8">
      <img src="/panik-mark.svg" alt="" width={28} height={28} className="shrink-0 object-contain" />
      <span className="font-sans text-base font-bold text-text-primary">
        <span className="hidden sm:inline">PANIK Admin</span>
        <span className="sm:hidden">Admin</span>
      </span>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </header>
  );
}

// ── the panel ───────────────────────────────────────────────────────────────

/**
 * One screen of the console: a raised card whose first row is a title band and
 * whose body is whatever the panel draws.
 *
 * `padded={false}` because several bodies are full bleed. A ledger's black
 * header plate and its 3px row rules have to meet the card's own edge, and
 * 16px of inset around them turns the table into a floating block inside a
 * frame. Bodies that DO want the inset ask for it themselves.
 */
export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title: React.ReactNode;
  /** Right side of the band. Reload, a create button, a state chip. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card tone="raised" padded={false} className={className}>
      {/* `flex-wrap`, and it is load bearing: the Vouchers band carries a
          Reload and a "New voucher code" button, which at 390px is wider than
          the band. Without the wrap the title and the controls overlapped. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b-[3px] border-border-strong px-5 py-3.5">
        <h2 className="min-w-0 label-type text-xs text-text-primary">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </Card>
  );
}

/**
 * A control that lives in a title band, at 32px.
 *
 * NOT `ui/Button variant="ghost"` with a height passed through `className`:
 * `BUTTON_SIZE.md` is `h-12` and Tailwind emits `.h-12` after `.h-8`, so the
 * override loses and the band grows to 76px while the source says 32. Same
 * treatment as `ghost` otherwise, written out rather than imported because the
 * variant map is private to the primitive.
 *
 * 32px is over the 24px target floor (SC 2.5.8). Nothing primary is this size.
 * Not exported: `ReloadButton` below is the only band control so far, and a
 * second one is a decision to make when it exists rather than an API to guess.
 */
function BandButton({
  onClick,
  children,
  label,
  disabled,
  className = "",
  ...rest
}: React.ComponentPropsWithRef<"button"> & { label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 border-0 bg-transparent px-2 label-type text-xs text-text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The band's Reload, which is the same three things on all five panels: the
 * glyph, the word, and an accessible name that says what is being reloaded.
 * The glyph does NOT spin while loading. There is no motion in this system,
 * and the panels already reserve their layout with hatched skeletons.
 */
export function ReloadButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <BandButton onClick={onClick} label={label}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      Reload
    </BandButton>
  );
}

/** The inset a panel body asks for when it is prose or controls, not a ledger. */
export const PANEL_BODY = "p-5";

// ── the ledger ──────────────────────────────────────────────────────────────

/**
 * A table on this look: a black header plate with white label type, and 3px
 * black rules between the rows. The same shape the Portfolio positions list
 * draws, which is what makes a console table read as this product's table
 * rather than as an admin tool bolted to the side of it.
 *
 * It scrolls inside itself. Without that the widest cell sets the page width
 * and the whole document travels sideways, which is the one layout failure
 * this repo measures for at 390px. Below `md` the panels draw stacked blocks
 * instead and this never mounts, but the wrapper stays: three of these tables
 * are still wider than a 768px column.
 */
export function Ledger({
  head,
  children,
  minWidth = "min-w-[36rem]",
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full border-collapse text-left ${minWidth}`}>
        <thead>
          <tr className="bg-text-primary">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A ledger column heading. Label type, white on the black plate. */
export function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`whitespace-nowrap px-4 py-2.5 label-type text-2xs text-white ${className}`}>
      {children}
    </th>
  );
}

/**
 * A ledger row. Every row carries the rule, including the first: under the
 * black header plate a 3px black line is invisible, and the alternative is a
 * `first` flag threaded through five call sites to save one border nobody can
 * see.
 */
export function Tr({ children }: { children: React.ReactNode }) {
  return <tr className="border-t-[3px] border-border-strong">{children}</tr>;
}

/**
 * A ledger cell. The face is the caller's: `font-mono` for a code, a date, an
 * address or a figure, `font-sans` for a word. `title` is here because two
 * cells truncate a browser string and put the whole one in the hover.
 */
export function Td({
  children,
  className = "",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td title={title} className={`px-4 py-3 text-sm ${className}`}>
      {children}
    </td>
  );
}

/** A value we do not have. Never a zero, never an empty cell (data-honesty rule). */
export function NotRecorded({ children = "not recorded" }: { children?: React.ReactNode }) {
  return <span className="font-sans text-text-muted">{children}</span>;
}

/**
 * One record as a stacked block, for the widths a ledger cannot be a ledger at.
 * The lead is the thing the row is ABOUT (an email, a code) and everything
 * else is a 12px line under it, which is the same shape `MarketTable` collapses
 * to below `md`.
 */
export function StackedRow({
  lead,
  children,
  className = "",
}: {
  lead: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 border-t-[3px] border-border-strong p-4 first:border-t-0 ${className}`}
    >
      <span className="font-sans text-sm font-bold break-words text-text-primary">{lead}</span>
      {children}
    </div>
  );
}

/** One fact on a stacked block: a caption and its value on a 12px line. */
export function StackedFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="font-sans text-xs text-text-secondary">
      <span className="text-text-muted">{label}: </span>
      {children}
    </span>
  );
}
