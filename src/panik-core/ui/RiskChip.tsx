import React from "react";
import { RISK_CHIP } from "../lib/utils";

/**
 * The only component allowed to render a risk band. It does not own any
 * colour: `RISK_CHIP` in lib/utils is still the single place a band becomes
 * pixels, so a band added there needs no change here.
 *
 * What this file owns is the BLOCK the colour goes in, and it is fixed: 28px
 * tall, 10px of side padding, a 3px black edge, a 3px black shadow behind it,
 * square corners, and Archivo 700 at 12px uppercase with 0.06em of tracking.
 * Every band is that same rectangle, which is what lets the hue be the only
 * variable the reader has to read.
 *
 * `h-7` rather than vertical padding: the chips sit in table rows beside dials
 * and buttons, and a chip whose height depends on its own line-height is a
 * different height in a row that wraps.
 *
 * No `title`: a native tooltip is invisible to keyboard and touch and cannot be
 * styled, so an explanation belongs in `InfoTip` and a name belongs in
 * `aria-label`.
 */
export function RiskChip({
  band,
  children,
  className = "",
}: {
  band: keyof typeof RISK_CHIP;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap hard-edge px-2.5 label-type text-xs shadow-hard-sm ${RISK_CHIP[band]} ${className}`}
    >
      {children}
    </span>
  );
}
