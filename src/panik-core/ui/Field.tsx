import React, { useId } from "react";

interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Doubles as the input's accessible label and, while it is empty and
      unfocused, the text that reads as its placeholder. There is never a
      second, separate placeholder string. */
  label: string;
  /** Space Mono, for a value that is a number or an address. */
  mono?: boolean;
  /**
   * `lg` is the open modal's two sizing fields: a value read as the point of
   * the screen rather than one field among several, at `--text-stat` (32px)
   * bold instead of the 14px every other field in the product uses. Default
   * unchanged everywhere else - it is the one caller.
   *
   * `Omit<..., "size">` above because the native `<input>` already owns a
   * `size` attribute (a character-width number, unrelated to this one), and
   * without the omission this prop's `"lg"` would collide with that type.
   */
  size?: "md" | "lg";
}

/**
 * One label, two positions, CSS only, no JS state. Default: centred inside
 * the input, standing in for a placeholder. Focused, or once a value is
 * typed: above it, in the product's usual label type. No transition: this
 * look has none, the two positions just snap.
 *
 * `placeholder=" "` (one space) is what makes `:placeholder-shown` true only
 * while the field is genuinely empty, which is what the CSS keys off. Focus
 * and "has a value" are two different conditions that both want the SAME
 * target position, so they are written as two variants pointed at identical
 * classes rather than as one variant fighting another for the same property.
 */
export function Field({
  label,
  mono = false,
  size = "md",
  id,
  className = "",
  ...rest
}: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const face = mono ? "font-mono" : "font-sans";
  const lg = size === "lg";
  const box = lg
    ? "h-20 px-4 pt-7 pb-2 text-stat font-bold"
    : "h-12 px-3 pt-4 pb-1 text-sm";
  // Same converting behaviour either size - only the target position and the
  // resting colour change. The large field's caption is a permanent muted
  // caption once it floats (it labels a value the reader owns, not a field
  // they still have to fill in), where the default field's floated label
  // turns primary to read as "this is now filled in".
  const floated = lg
    ? "peer-focus:top-3 peer-focus:translate-y-0 peer-focus:label-type peer-focus:text-xs peer-focus:text-text-muted " +
      "peer-[:not(:placeholder-shown)]:top-3 peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:label-type peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:text-text-muted"
    : "peer-focus:top-2 peer-focus:translate-y-0 peer-focus:label-type peer-focus:text-xs peer-focus:text-text-primary " +
      "peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:label-type peer-[:not(:placeholder-shown)]:text-xs peer-[:not(:placeholder-shown)]:text-text-primary";
  return (
    <div className="relative">
      <input
        id={inputId}
        placeholder=" "
        className={`peer w-full ${face} ${box} hard-edge bg-surface-raised text-text-primary disabled:opacity-40 ${className}`}
        {...rest}
      />
      <label
        htmlFor={inputId}
        className={`pointer-events-none absolute ${lg ? "left-4" : "left-3"} top-1/2 -translate-y-1/2 ${face} text-sm text-text-muted ${floated}`}
      >
        {label}
      </label>
    </div>
  );
}
