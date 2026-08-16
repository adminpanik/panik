import React from "react";
import { AlertTriangle } from "lucide-react";
import { PROBLEM_TONE_BOX } from "./EmptyState";

/**
 * A thing that did not work, in one line.
 *
 * IT IS THE SMALL `EmptyState tone="problem"`, and it is built from that tone's
 * own box rather than from a copy of its classes: dashed edge, `risk-unknown`
 * mark, no fill. "We could not do that" has one look in this product whether it
 * replaces a whole panel or answers a single button, and the two were one edit
 * away from disagreeing.
 *
 * WHY NOT THE RISK RAMP. A refused invite code is not a liquidation. The five
 * risk hues mean one thing here (docs/DESIGN_SYSTEM.md) and `risk-unknown` is
 * the only one borrowed, because its whole meaning is "we could not find out".
 *
 * `role="alert"`, not `status`: it answers a control the reader just pressed and
 * replaces the outcome they were expecting, so it is worth interrupting for.
 */
export function Notice({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs font-sans leading-relaxed text-text-secondary ${PROBLEM_TONE_BOX}`}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-risk-unknown" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </p>
  );
}
