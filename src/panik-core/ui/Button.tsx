import React from "react";

/**
 * One level of emphasis and two ways of being quiet, because a screen with two
 * levels of emphasis has one obvious next step and a screen with four has none.
 *
 * `primary` is a NEUTRAL high-contrast fill: near-white plate, near-black
 * label (18.1:1). It used to be brand orange, which put a saturated hue on
 * every screen and made buttons compete with the risk chips for the eye. A
 * button is the loudest thing on a page by position and weight; it does not
 * also need to be the loudest by hue. Nothing here accepts a risk band.
 *
 * `outline` is `quiet` with its edge drawn: the same ink and the same hover, for
 * a full-width row action that has to read as a control while it sits alone at
 * the bottom of a card. It exists as a variant because it was being made at a
 * call site by passing `variant="quiet"` and overriding the border in
 * `className`, which produced two `border-*` utilities on one element and left
 * which of them won to Tailwind's emit order.
 */
const BUTTON_VARIANT = {
  primary: "bg-text-primary text-surface-base border-transparent hover:opacity-90",
  quiet:
    "bg-transparent text-text-secondary border-transparent hover:text-text-primary hover:bg-white/[0.04]",
  outline:
    "bg-transparent text-text-secondary border-border-subtle hover:text-text-primary hover:bg-white/[0.04]",
} as const;

/**
 * Two sizes, and `md` is every button in the product. `lg` exists for a card
 * whose single consequential action has to read as the point of the card rather
 * than as a footer control: the Advisor's EXIT and REDUCE legs, where the thing
 * being offered is closing a position or repaying debt to avoid liquidation.
 *
 * Size and weight are the only currency available for that. `primary` is a
 * neutral fill on purpose and nothing here accepts a risk band, so emphasis
 * cannot be bought with hue.
 *
 * A prop rather than a `className` override at the call site, because overriding
 * `px-*` and `text-*` there puts two of each utility on one element and leaves
 * which of them wins to Tailwind's emit order — the same failure the `outline`
 * variant was added to fix.
 */
const BUTTON_SIZE = {
  md: "px-3.5 py-2 text-xs",
  lg: "px-4 py-2.5 text-sm",
} as const;

/**
 * `ComponentPropsWithRef`, not `ButtonHTMLAttributes`: in React 19 `ref` is an
 * ordinary prop on a function component, so it reaches the `<button>` through
 * the same spread as everything else — but only the ref-aware prop type admits
 * it. A caller that has to return focus to a button it rendered (the Portfolio
 * alert trigger) needs a handle on it, and wrapping the primitive in a plain
 * `<button>` to get one would be a second button treatment.
 */
interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
  children: React.ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border font-sans font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
