import React, { useId } from "react";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Doubles as the input's accessible label and, while it is empty and
      unfocused, the text that reads as its placeholder. There is never a
      second, separate placeholder string. */
  label: string;
  /** Space Mono, for a value that is a number or an address. */
  mono?: boolean;
}

/**
 * One label, two positions, CSS only, no JS state. Default: centred inside
 * the input, standing in for a placeholder. Focused, or once a value is
 * typed: above it, in the product's usual label type. No transition — this
 * look has none — the two positions just snap.
 *
 * `placeholder=" "` (one space) is what makes `:placeholder-shown` true only
 * while the field is genuinely empty, which is what the CSS keys off. Focus
 * and "has a value" are two different conditions that both want the SAME
 * target position, so they are written as two variants pointed at identical
 * classes rather than as one variant fighting another for the same property.
 */
export function Field({ label, mono = false, id, className = "", ...rest }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const face = mono ? "font-mono" : "font-sans";
  const floated =
    "peer-focus:top-2 peer-focus:translate-y-0 peer-focus:label-type peer-focus:text-xs peer-focus:text-text-primary " +
    "peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:label-type peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:text-text-primary";
  return (
    <div className="relative">
      <input
        id={inputId}
        placeholder=" "
        className={`peer w-full ${face} h-12 hard-edge bg-surface-raised px-3 pt-4 pb-1 text-sm text-text-primary disabled:opacity-40 ${className}`}
        {...rest}
      />
      <label
        htmlFor={inputId}
        className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${face} text-sm text-text-muted ${floated}`}
      >
        {label}
      </label>
    </div>
  );
}
