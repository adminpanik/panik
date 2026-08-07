import React from "react";

/**
 * Exactly two variants, because a screen with two levels of emphasis has one
 * obvious next step and a screen with four has none.
 *
 * `primary` is the brand fill with a near-black label (7.10:1). Brand orange
 * is interactive-only — it never states a risk, which is why nothing here
 * accepts a risk band.
 */
const BUTTON_VARIANT = {
  primary: "bg-panik-orange text-surface-base border-transparent hover:opacity-90",
  quiet:
    "bg-transparent text-text-secondary border-transparent hover:text-text-primary hover:bg-white/[0.04]",
} as const;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT;
  children: React.ReactNode;
}

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3.5 py-2 font-mono text-xs font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
