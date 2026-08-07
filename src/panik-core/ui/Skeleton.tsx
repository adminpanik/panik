import React from "react";

/**
 * A placeholder block, deliberately static. The usual shimmer/pulse is the
 * one animation this product cannot have: a moving element in a risk dashboard
 * reads as a value changing, and here it means the opposite — nothing has
 * arrived yet. Shape and dimming carry "pending" on their own.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-sm bg-white/[0.05] ${className}`} />;
}
