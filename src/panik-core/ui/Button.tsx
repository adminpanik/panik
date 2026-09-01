import React from "react";

/**
 * One level of emphasis and two ways of being quiet, because a screen with two
 * levels of emphasis has one obvious next step and a screen with four has none.
 *
 * `primary` is the brand cobalt with white text (5.03:1). It used to be a
 * neutral near-white plate, because the accent then shared a hue with the HIGH
 * risk band and a saturated button competed with the chips. Cobalt is nowhere
 * on the risk ramp, so the loudest control on a screen can be coloured again
 * without ever being mistaken for a warning. Nothing here accepts a risk band.
 *
 * `secondary` is the white plate with black ink and the same hard edge: the
 * second action in a pair, and the full-width row action a card ends on. Its
 * hover fills with `highlight` rather than moving to a different grey, which
 * is the one place lavender appears on a control.
 *
 * `ghost` is the only variant with no edge and no shadow, for a control that
 * has to sit inside dense text without drawing a box around itself. It
 * underlines on hover, because with the box gone the underline is the whole
 * affordance.
 *
 * The old `quiet` and `outline` names are gone. `outline` existed only because
 * a caller was building it out of `quiet` plus a border override in
 * `className`, and on this look every non-ghost button carries the same 3px
 * edge, so the distinction it encoded no longer exists: `outline` became
 * `secondary` and `quiet` became `ghost`.
 */
const BUTTON_VARIANT = {
  primary: "hard-edge shadow-hard-sm bg-brand text-white",
  secondary: "hard-edge shadow-hard-sm bg-surface-raised text-text-primary hover:bg-highlight",
  ghost: "border-0 bg-transparent text-text-primary hover:underline",
} as const;

/**
 * Which variants MOVE. A pressable block on this look reports a press by
 * sliding into its own shadow: 3px on hover (the shadow is still there, just
 * shorter), 6px on active (the shadow is gone and the block has landed on it).
 * `ghost` has no shadow to travel into, so it is not in this map, and a
 * disabled button is excluded at the call below: a control that moves under
 * the pointer while refusing the click is the worst of both.
 *
 * Written as translate rather than as a transition: there is no motion in this
 * system, only two static positions the block can be in.
 */
const BUTTON_PRESS =
  "hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-hard-sm active:translate-x-[6px] active:translate-y-[6px] active:shadow-none";

/**
 * Two sizes, and `md` is every button in the product. `lg` exists for a card
 * whose single consequential action has to read as the point of the card rather
 * than as a footer control: the Advisor's EXIT and REDUCE legs, where the thing
 * being offered is closing a position or repaying debt to avoid liquidation.
 *
 * Size and weight are the only currency available for that; nothing here
 * accepts a risk band, so emphasis cannot be bought with hue.
 *
 * A prop rather than a `className` override at the call site, because
 * overriding `px-*` and `text-*` there puts two of each utility on one element
 * and leaves which of them wins to Tailwind's emit order.
 */
const BUTTON_SIZE = {
  /**
   * `h-12` is 48px, and it is the same 48px as `FIELD_BOX` in ui/TextField.
   * THE TWO TRAVEL TOGETHER: they sit side by side in every form in the
   * product, and a 40px field beside a 48px button is the kind of 8px nobody
   * can name and everybody can see. Change one and change the other.
   *
   * Two literals rather than a token, unlike `--border-width-hard`: that one is
   * read at forty call sites and a drifted copy is invisible, whereas this is
   * two places that already point at each other in prose and disagree the
   * moment anyone opens a form.
   */
  md: "h-12 px-5 text-sm",
  lg: "h-14 px-6 text-base",
  /**
   * A square for ONE glyph and no word, at the same 28px every chip in this
   * system is. For a control that dismisses the thing it sits on: it has no
   * label to set a width from, and at `md` it was a 48px block in the corner of
   * a 69px card, which is a quarter of the card given to the way out of it.
   *
   * A size rather than `className="h-7 w-7 px-0"` at the call site, for the
   * reason above the map: three utilities overriding three others on one
   * element leaves which of each pair wins to Tailwind's emit order.
   *
   * Still over the 24px target floor (SC 2.5.8). Nothing primary is this size.
   */
  icon: "h-7 w-7 text-sm",
} as const;

/**
 * `ComponentPropsWithRef`, not `ButtonHTMLAttributes`: in React 19 `ref` is an
 * ordinary prop on a function component, so it reaches the `<button>` through
 * the same spread as everything else, but only the ref-aware prop type admits
 * it. A caller that has to return focus to a button it rendered (the Portfolio
 * alert trigger) needs a handle on it, and wrapping the primitive in a plain
 * `<button>` to get one would be a second button treatment.
 */
interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
  children: React.ReactNode;
}

/**
 * `whitespace-nowrap` on every variant: a button that wraps its own label
 * reads as broken, not responsive. A caller that is out of room should
 * shorten its copy or widen the footer, not let the label fold onto a
 * second line inside the control.
 */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const press = variant === "ghost" || disabled ? "" : BUTTON_PRESS;
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-sans font-bold uppercase tracking-[0.02em] disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${press} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
