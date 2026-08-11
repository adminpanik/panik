import React from "react";

/**
 * The badge on an "Open position" control whose click lands in the DEMO
 * simulator rather than a real transaction flow.
 *
 * One component because the claim must be one claim: three surfaces offer the
 * same open (Compass card, Watch header, risk-breakdown modal), each renders
 * this beside its button, and each is driven by the same `canOpenInApp`
 * predicate the click routes on. Three hand-typed copies of the span held
 * together by comments asking readers to keep them equal is how the wording
 * drifts; this is the `SimulationChip` precedent applied to the open flow.
 *
 * Distinct from `SimulationChip` on purpose: that one means "this FIGURE came
 * from a simulated price"; this one means "this BUTTON will not sign".
 */
export function DemoChip() {
  return (
    <span
      title="Opens the demo simulator; nothing is signed and no funds move."
      className="text-2xs font-sans text-text-muted bg-white/[0.04] px-2.5 py-0.5 rounded-sm border border-border-subtle flex items-center font-bold"
    >
      Demo
    </span>
  );
}
