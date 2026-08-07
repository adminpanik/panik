import React from "react";

/**
 * Exactly two variants, because a screen with two levels of emphasis has one
 * obvious next step and a screen with four has none.
 *
 * `primary` is a NEUTRAL high-contrast fill: near-white plate, near-black
 * label (18.1:1). It used to be brand orange, which put a saturated hue on
 * every screen and made buttons compete with the risk chips for the eye. A
 * button is the loudest thing on a page by position and weight; it does not
 * also need to be the loudest by hue. Nothing here accepts a risk band.
 */
const BUTTON_VARIANT = {
  primary: "bg-text-primary text-surface-base border-transparent hover:opacity-90",
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
