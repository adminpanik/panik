import React from "react";

/**
 * Two depths, one emphasis and one demotion. `panel` is a page-level container,
 * `raised` is a tile sitting inside one, `lead` is a `raised` tile that the
 * screen it is on LEADS with (same surface, functional edge), and `set-back` is
 * a `raised` tile in a section the page has deliberately put aside.
 *
 * `lead` earns its own entry rather than being a `className` on the call site,
 * because `border-border-strong` passed that way loses to the tone's own
 * `border-border-subtle` — same specificity, and the winner is whichever rule
 * Tailwind emits last, which is not something a caller can see or rely on. It is
 * also a decision worth rationing: at most one card per screen may take it, or
 * "the one thing to read here" stops meaning anything.
 *
 * `set-back` is here for the same reason one rung up: a `bg-surface-raised/25`
 * passed through `className` ties with the tone's own `bg-surface-raised/50` at
 * equal specificity, so which depth a dimmed card actually drew was emit order.
 * It is the Compass "Outside your profile" grid, and it dims the SURFACE only —
 * the cards it holds are the ones a reader most needs to read clearly.
 *
 * Still nothing that tints by STATE. A card never says "risk" with its
 * container, because a tinted box reads as a claim about everything inside it.
 */
const CARD_TONE = {
  panel: "bg-white/[0.01] border-border-subtle",
  raised: "bg-surface-raised/50 border-border-subtle",
  lead: "bg-surface-raised/50 border-border-strong",
  "set-back": "bg-surface-raised/25 border-border-subtle",
} as const;

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: keyof typeof CARD_TONE;
  children: React.ReactNode;
}

export function Card({ tone = "panel", className = "", children, ...rest }: CardProps) {
  return (
    <div className={`border rounded-lg p-5 ${CARD_TONE[tone]} ${className}`} {...rest}>
      {children}
    </div>
  );
}
