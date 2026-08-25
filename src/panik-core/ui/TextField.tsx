import React, { useId } from "react";

/**
 * The product's ONE text input, and the box treatment on its own for the
 * surfaces that cannot use the component.
 *
 * `FIELD_BOX` carries no width and no type face, which is deliberate: the
 * address field on the Wallets panel is `w-full font-mono`, the name beside it
 * is `min-w-40 flex-1 font-sans`, and a constant that decided either would have
 * been copied around it rather than used. Everything that makes the control
 * look like this product's control - the 48px height, the hard black edge, the
 * white plate, the placeholder colour, the disabled dimming - is here, so the
 * four hand-typed copies of that string cannot drift apart again. Same
 * arrangement as `CLEAR_TONE_BOX` in EmptyState.
 *
 * A WHITE plate, where this used to be the sunken one. An input on the previous
 * dark look was found by being darker than the card around it; here it is found
 * by its 3px black edge, and a grey fill would be the only recessed thing on a
 * page of white plates.
 *
 * 48px tall, and it is the same 48px as `BUTTON_SIZE.md` in ui/Button: the two
 * sit side by side in every form in the product, and a 40px field beside a 48px
 * button is the kind of 8px nobody can name and everybody can see. Change one
 * and change the other; the reasoning for keeping it two literals rather than a
 * token is on `BUTTON_SIZE`.
 *
 * No `focus:` classes. src/index.css carries one global `:focus-visible` rule,
 * which is what stops a control shipping without a ring.
 */
export const FIELD_BOX =
  "h-12 hard-edge bg-surface-raised px-3 text-sm text-text-primary placeholder:text-text-muted disabled:opacity-40";

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
      <label
        htmlFor={inputId}
        className="block label-type text-xs text-text-primary"
      >
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
