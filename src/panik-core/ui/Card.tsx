import React from "react";

/**
 * Two depths, one emphasis and one demotion. `panel` is a page-level container,
 * `raised` is a tile sitting inside one, `lead` is a `raised` tile that the
 * screen it is on LEADS with, and `set-back` is a `raised` tile in a section
 * the page has deliberately put aside.
 *
 * On this look the four are separated by DEPTH and PLATE rather than by four
 * shades of grey, and every one of them keeps the same 3px black edge:
 *
 *   panel     white, flat on the page. It is the container other things sit
 *             in, and a 6px shadow under a full-width box is noise.
 *   raised    white, lifted 6px. The canonical card.
 *   lead      lavender, lifted 6px. Unmistakably the one thing to read.
 *   set-back  sunken paper, flat. Present, and clearly not the point.
 *
 * That is a bigger gap than the old 1% / 25% / 50% white fills managed, and
 * unlike them it cannot be silently undone by a `bg-*` utility passed through
 * `className`: those tied with the tone's own fill at equal specificity and
 * the winner was whichever rule Tailwind emitted last.
 *
 * `lead` is worth rationing: at most one card per screen may take it, or "the
 * one thing to read here" stops meaning anything. Lavender is safe to spend on
 * it because `highlight` is nowhere on the risk ramp: a card can be the
 * loudest box on the page without making a claim about the position inside it.
 *
 * Still nothing that tints by STATE. A card never says "risk" with its
 * container, because a tinted box reads as a claim about everything inside it.
 */
const CARD_TONE = {
  panel: "hard-edge bg-surface-raised",
  raised: "hard-edge shadow-hard bg-surface-raised",
  lead: "hard-edge shadow-hard bg-highlight",
  "set-back": "hard-edge bg-surface-sunken",
} as const;

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof CARD_TONE;
  /**
   * Whether the box pads its own content. True everywhere but a card whose
   * content is FULL BLEED: the positions table draws a black header row and 3px
   * row rules that have to meet the card's own edge, and 16px of inset around
   * them turns the table into a floating block inside a frame.
   *
   * A prop rather than `className="p-0"` at the call site, because both are
   * padding utilities and which one wins is Tailwind's emit order rather than
   * the order they were written in. The call site would look correct and render
   * with 16px of padding.
   */
  padded?: boolean;
  children: React.ReactNode;
}

export function Card({
  tone = "panel",
  padded = true,
  className = "",
  children,
  ...rest
}: CardProps) {
  return (
    <div className={`${padded ? "p-4" : ""} ${CARD_TONE[tone]} ${className}`} {...rest}>
      {children}
    </div>
  );
}
