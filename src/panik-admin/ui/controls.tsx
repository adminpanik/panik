/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two things this internal console needs that src/panik-core/ui does not
 * have: a labelled text input and a state pill. Everything else (Card, Button,
 * Stat, EmptyState, Skeleton) is imported from the product's primitives rather
 * than reimplemented, so the admin surface cannot drift into looking like a
 * different product.
 *
 * No `focus:` classes here on purpose. src/index.css carries one global
 * `:focus-visible` rule, which is what stops a control shipping without a ring.
 */

import React from "react";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Shown under the input. For a constraint, not for restating the label. */
  hint?: string;
}

export function Field({ label, hint, className = "", id, ...rest }: FieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="block text-xs font-sans text-text-secondary">
        {label}
      </label>
      <input
        id={inputId}
        className="mt-1.5 block w-full rounded-sm border border-border-strong bg-surface-sunken px-3 py-2 text-sm font-sans text-text-primary placeholder:text-text-muted"
        {...rest}
      />
      {hint ? <p className="mt-1.5 text-2xs font-sans text-text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * A state as a word in a neutral pill. Deliberately NOT on the risk ramp: those
 * five hues mean liquidation risk everywhere else in the product, and an
 * exhausted voucher batch is an inventory fact, not a risk band. Emphasis
 * separates the live state from the finished ones, and the word carries the
 * meaning on its own (WCAG 1.4.1).
 */
const PILL_TONE = {
  live: "border-border-strong text-text-primary",
  done: "border-border-subtle text-text-muted",
} as const;

export function StatusPill({
  tone,
  children,
}: {
  tone: keyof typeof PILL_TONE;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-2xs font-sans font-medium ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A table that scrolls inside itself. Without the wrapper the widest cell sets
 * the page width and the whole document scrolls sideways on a phone, which is
 * the one layout failure this repo measures for at 390px.
 */
export function TableScroller({ children }: { children: React.ReactNode }) {
  return <div className="-mx-1 overflow-x-auto px-1">{children}</div>;
}

/** Column heading. Small and quiet, sentence case, never uppercase-tracked. */
export function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap pb-2 pr-4 text-left text-2xs font-sans font-medium text-text-muted ${className}`}
    >
      {children}
    </th>
  );
}

/** A value we do not have. Never a zero, never an empty cell (data-honesty rule). */
export function NotRecorded({ children = "not recorded" }: { children?: React.ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}
