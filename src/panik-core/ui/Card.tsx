import React from "react";

/**
 * Two depths and one emphasis. `panel` is a page-level container, `raised` is a
 * tile sitting inside one, and `lead` is a `raised` tile that the screen it is
 * on LEADS with: same surface, functional edge.
 *
 * `lead` earns its own entry rather than being a `className` on the call site,
 * because `border-border-strong` passed that way loses to the tone's own
 * `border-border-subtle` — same specificity, and the winner is whichever rule
 * Tailwind emits last, which is not something a caller can see or rely on. It is
 * also a decision worth rationing: at most one card per screen may take it, or
 * "the one thing to read here" stops meaning anything.
 *
 * Still nothing that tints by STATE. A card never says "risk" with its
 * container, because a tinted box reads as a claim about everything inside it.
 */
const CARD_TONE = {
  panel: "bg-white/[0.01] border-border-subtle",
  raised: "bg-surface-raised/50 border-border-subtle",
  lead: "bg-surface-raised/50 border-border-strong",
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
