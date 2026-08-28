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
 *
 * `score` is OPTIONAL and off by default, so every chip already shipped renders
 * exactly as it did. It exists for a surface that compares many markets at once
 * (the Compass table), where the band word alone puts six markets in two
 * buckets and the reader still has to open something to tell them apart. The
 * figure goes INSIDE the one block rather than in a column beside it: a score
 * and its band are one reading, and split across two cells they can be sorted,
 * hidden or wrapped apart from each other.
 *
 * Set in the mono face at `text-sm`, which is the same treatment every other
 * numeral in the product gets - `label-type` sets no font-size, so the parent's
 * 12px label type applies to the WORD only and the figure keeps its own step.
 *
 * The block's gap went from 4px to 8px with it, and that is invisible to every
 * caller that came before: a gap sits BETWEEN children, and a chip whose only
 * child is its band word has nothing for it to separate.
 */
export function RiskChip({
  band,
  score,
  children,
  className = "",
}: {
  band: keyof typeof RISK_CHIP;
  /**
   * The composite the band came from, or nothing. Rendered only when it is a
   * real number: a chip reading "NaN LOW RISK" would be this product stating a
   * measurement it does not have, and an absent figure still leaves the band
   * word carrying the state on its own (SC 1.4.1).
   */
  score?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap hard-edge px-2.5 label-type text-xs shadow-hard-sm ${RISK_CHIP[band]} ${className}`}
    >
      {score !== undefined && Number.isFinite(score) && (
        <span className="font-mono text-sm font-bold tabular-nums">{Math.round(score)}</span>
      )}
      {children}
    </span>
  );
}
