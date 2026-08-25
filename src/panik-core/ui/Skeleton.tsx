import React from "react";

/**
 * A placeholder block, deliberately static. The usual shimmer/pulse is the
 * one animation this product cannot have: a moving element in a risk dashboard
 * reads as a value changing, and here it means the opposite — nothing has
 * arrived yet. Shape and texture carry "pending" on their own.
 *
 * The texture is the shared 45-degree hatch, the same one the UNKNOWN risk chip
 * and `EmptyState tone="problem"` wear. All three are one statement at three
 * sizes — there is nothing here, and that is not a verdict — so a reader who
 * has learned the hatch once has learned all three. A flat grey block would
 * instead be indistinguishable from a real empty surface on a light ground.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`hard-edge hatch ${className}`} />;
}

/**
 * The whole page, while the app is still finding out who is in front of it.
 *
 * DELIBERATELY WORDLESS. Every sentence available here ("Signing you in",
 * "Checking your session") would be a claim about an answer that has not
 * arrived, and both waits it covers - the wallet session and the account -
 * usually resolve in one same-origin round trip. Shape reserves the space the
 * shell will occupy instead of letting it jump into place.
 *
 * `min-h-screen`, not `h-screen`: a short viewport scrolls rather than clipping.
 * The two copies of this block differed on exactly that.
 */
export function BootSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-screen w-full items-center justify-center bg-surface-base p-6"
    >
      <div className="w-full max-w-sm space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
