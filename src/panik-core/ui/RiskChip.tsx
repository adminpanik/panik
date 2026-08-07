import React from "react";
import { RISK_CHIP } from "../lib/utils";

/**
 * The only component allowed to render a risk band. It does not own any
 * colour: `RISK_CHIP` in lib/utils is still the single place a band becomes
 * pixels, so a band added there needs no change here.
 */
export function RiskChip({
  band,
  children,
  title,
  className = "",
}: {
  band: keyof typeof RISK_CHIP;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-2 py-0.5 text-2xs font-sans font-bold tabular-nums ${RISK_CHIP[band]} ${className}`}
    >
      {children}
    </span>
  );
}
