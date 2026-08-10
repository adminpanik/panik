import React from "react";
import { RISK_CHIP } from "../lib/utils";

/**
 * The only component allowed to render a risk band. It does not own any
 * colour: `RISK_CHIP` in lib/utils is still the single place a band becomes
 * pixels, so a band added there needs no change here.
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
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-0.5 text-2xs font-sans font-bold tabular-nums ${RISK_CHIP[band]} ${className}`}
    >
      {children}
    </span>
  );
}
