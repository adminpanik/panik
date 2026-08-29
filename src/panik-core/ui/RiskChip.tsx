import React from "react";
import { RISK_CHIP } from "../lib/utils";

/**
 * The only component allowed to render a risk band. It does not own any
 * colour: `RISK_CHIP` in lib/utils is still the single place a band becomes
 * pixels, so a band added there needs no change here.
 *
 * What this file owns is the BLOCK the colour goes in, and it is now FIXED
 * WIDTH as well as fixed height. Every band is the same 112px rectangle with
 * its content centred, which is what turns a column of chips into a column: a
 * reader compares four positions by hue and by a figure in the same place, not
 * by four blocks of four different lengths whose edges never line up. 112px is
 * what "ELEVATED" plus a two-digit score needs at this type, with the slack a
 * three-digit score wants; it is ONE constant here rather than a width passed
 * per call site, so a chip cannot come out a different size on the screen next
 * to this one.
 *
 * FLAT, with no shadow. A chip is a label on a row, not a control: it is not
 * pressable, so a raised edge was the one thing on the row promising a press
 * that never came, and four of them lifted off a table made the table read as a
 * stack of buttons.
 *
 * `h-7` rather than vertical padding: the chips sit in table rows beside dials
 * and buttons, and a chip whose height depends on its own line-height is a
 * different height in a row that wraps.
 *
 * No `title`: a native tooltip is invisible to keyboard and touch and cannot be
 * styled, so an explanation belongs in `InfoTip` and a name belongs in
 * `aria-label`.
 *
 * `score` is OPTIONAL and off by default. It exists for a surface that compares
 * many readings at once, where the band word alone puts six of them in two
 * buckets and the reader still has to open something to tell them apart. The
 * figure goes INSIDE the one block rather than in a column beside it: a score
 * and its band are one reading, and split across two cells they can be sorted,
 * hidden or wrapped apart from each other.
 *
 * Set in the mono face at `text-sm`, which is the same treatment every other
 * numeral in the product gets - `label-type` sets no font-size, so the parent's
 * 12px label type applies to the WORD only and the figure keeps its own step.
 */

/**
 * The block, written once: the rectangle every band shares.
 *
 * Separated from the width below because one caller legitimately cannot take
 * the width (see `fluid`), and a caller that had to restate the border, the
 * height and the type in order to opt out of a width is a caller that drifts
 * from this file the first time any of the three changes.
 */
const CHIP_BLOCK =
  "inline-flex h-7 shrink-0 items-center justify-center gap-2 whitespace-nowrap hard-edge label-type text-xs";

/**
 * The one width a band chip is. "As wide as its own word" was the rule this
 * replaces, and it produced a column where LOW was 74px and CRITICAL was 132px.
 */
const CHIP_WIDTH = "w-28";

/** Side padding, and only where the fixed width is not doing that job. */
const CHIP_PAD = "px-2.5";

export function RiskChip({
  band,
  score,
  fluid = false,
  children,
  className = "",
}: {
  band: keyof typeof RISK_CHIP;
  /**
   * The composite the band came from, or nothing. Rendered only when it is a
   * real number: a chip reading "NaN LOW" would be this product stating a
   * measurement it does not have, and an absent figure still leaves the band
   * word carrying the state on its own (SC 1.4.1).
   */
  score?: number;
  /**
   * Opt out of the fixed width, for the two UNKNOWN markers on the Advisor's
   * position cards. Those do not carry a band: they carry a sentence ("USD
   * amounts unavailable") and an `InfoTip`, and a 112px box would clip a
   * statement about what the product could not measure - which is the one
   * statement it cannot afford to render as a broken layout. Everything that
   * does wear a band takes the fixed width, and there is no prop that lets it
   * not.
   */
  fluid?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`${CHIP_BLOCK} ${fluid ? CHIP_PAD : CHIP_WIDTH} ${RISK_CHIP[band]} ${className}`}
    >
      {score !== undefined && Number.isFinite(score) && (
        <span className="font-mono text-sm font-bold tabular-nums">{Math.round(score)}</span>
      )}
      {children}
    </span>
  );
}
