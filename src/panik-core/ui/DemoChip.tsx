import React from "react";
import { Chip } from "./Chip";

/**
 * The word "Demo", where a surface is showing something that is not the real
 * thing.
 *
 * Its default and commonest job is the badge on an "Open position" control
 * whose click lands in the DEMO simulator rather than a real transaction flow.
 * Three surfaces offer that open (Compass card, Watch header, risk-breakdown
 * modal), each renders this beside its button, and each is driven by the same
 * `canOpenInApp` predicate the click routes on. Three hand-typed copies of the
 * span held together by comments asking readers to keep them equal is how the
 * wording drifts; this is the `SimulationChip` precedent applied to the open
 * flow.
 *
 * `title` is what makes the chip reusable without the badge becoming vague:
 * the risk-breakdown panel's header wears one for a score that came from the
 * offline fallback, which is a different claim from "this button will not
 * sign", and the hover is where that difference is stated. The visible word is
 * shared because the reader's question ("is this the real thing?") is the same
 * one; the answer to "which part of it is not" belongs on the hover.
 *
 * Distinct from `SimulationChip` on purpose: that one means "this figure came
 * from a simulated PRICE", a claim about the market rather than about what the
 * product is doing.
 *
 * A preset over `Chip`: the word and the default hover are the product
 * decision here, the eleven utilities that draw a neutral marker are not.
 */
export function DemoChip({
  title = "Opens the demo simulator; nothing is signed and no funds move.",
}: {
  title?: string;
} = {}) {
  return <Chip title={title}>Demo</Chip>;
}
