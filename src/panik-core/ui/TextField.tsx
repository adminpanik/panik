import React, { useId } from "react";

/**
 * The product's ONE text input, and the box treatment on its own for the
 * surfaces that cannot use the component.
 *
 * `FIELD_BOX` carries no width and no type face, which is deliberate: the
 * address field on the Wallets panel is `w-full font-mono`, the name beside it
 * is `min-w-40 flex-1 font-sans`, and a constant that decided either would have
 * been copied around it rather than used. Everything that makes the control
 * look like this product's control - the height, the radius, the edge, the sunk
 * surface, the placeholder colour, the disabled dimming - is here, so the four
 * hand-typed copies of that string cannot drift apart again. Same arrangement
 * as `CLEAR_TONE_BOX` in EmptyState.
 *
 * No `focus:` classes. src/index.css carries one global `:focus-visible` rule,
 * which is what stops a control shipping without a ring.
 */
export const FIELD_BOX =
  "h-10 rounded-md border border-border-strong bg-surface-sunken px-3 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50";

interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Always visible. A placeholder is a hint, never a label (SC 3.3.2). */
  label: string;
  /** Render the value in the mono face: an address, a code, a hash. */
  mono?: boolean;
}

/**
 * A labelled input. The label is a real `<label htmlFor>` rather than an
 * `aria-label`, so a pointer user gets the larger hit area and a screen reader
 * and a sighted reader are told the same word.
 */
export function TextField({ label, mono = false, id, className = "", ...rest }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-xs font-sans font-bold text-text-primary">
        {label}
      </label>
      <input
        id={inputId}
        className={`w-full ${mono ? "font-mono" : "font-sans"} ${FIELD_BOX} ${className}`}
        {...rest}
      />
    </div>
  );
}
