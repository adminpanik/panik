import React from "react";

/**
 * Two depths, matching the surface tokens: `panel` is a page-level container,
 * `raised` is a tile sitting inside one. Nothing else varies — a card never
 * tints by state, because a tinted container reads as a risk statement about
 * everything inside it.
 */
const CARD_TONE = {
  panel: "bg-white/[0.01] border-border-subtle",
  raised: "bg-surface-raised/50 border-border-subtle",
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
