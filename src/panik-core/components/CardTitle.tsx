import React from "react";
import { InfoTip } from "./InfoTip";

/**
 * The name of a card or of a section inside one.
 *
 * `Card` draws a box and never a heading, which is why this is a separate
 * component rather than a prop: a card may carry no title, one title, or a
 * title over a run of sub-sections, and a `title` prop can only express the
 * middle one. It was deferred out of the primitives PR for the honest reason
 * that an export nothing calls is dead code; it has call sites now.
 *
 * ARCHIVO 900, UPPERCASE, TIGHT. That is the system's one headline treatment,
 * and what it had drifted into was five different answers to "what does a title
 * look like": `text-lg font-extrabold tracking-wide` on the Watch market
 * picker, `text-sm font-semibold` on the Advisor's two section headings,
 * `text-xs font-semibold text-text-muted` on the two Watch control cards and on
 * `BreakdownSection`, and `EmptyState`'s own 900 uppercase. Four of those five
 * read as body copy in bold rather than as a heading, and on a screen of
 * stacked white boxes the heading is the only thing telling a reader where one
 * box's subject ends.
 *
 * Four of the five are this component now. `EmptyState` still hand-types the
 * same utilities, and folding it in means editing `src/panik-core/ui/`, which
 * this branch does not touch; it is listed as deferred rather than quietly
 * left, because a sixth copy is how the drift starts again.
 *
 * It also belongs in `ui/` beside the other primitives, for the same reason and
 * with the same deferral. Nothing about it is Advisor- or Watch-specific.
 *
 * The tone is a DEMOTION, not a hue. Colour on this system is either a risk
 * band or a brand accent and a heading is neither, so `muted` changes the ink
 * to `text-muted` and nothing else, for the title of a control group, which
 * names what a reader is about to adjust rather than what they should read.
 */
/**
 * Two steps, and there is deliberately no third. `sm` is a section inside a
 * card or a card the screen does not lead with; `lg` is a card the screen does
 * lead with. A `base` step sat between them for one draft and no call site
 * reached for it, which is the shape a scale acquires a rank nobody can explain.
 */
const TITLE_SIZE = {
  sm: "text-sm",
  lg: "text-lg",
} as const;

export function CardTitle({
  children,
  as: Tag = "h3",
  size,
  muted = false,
  caseSensitive = false,
  hint,
  className = "",
}: {
  children: React.ReactNode;
  /**
   * The heading element, so the document outline is the caller's to get right:
   * this component knows what a title LOOKS like and cannot know what depth it
   * sits at. A card inside a section is an `h4` where the section is an `h3`,
   * and a wrong level is invisible on screen and wrong in every screen reader.
   */
  as?: "h2" | "h3" | "h4";
  /** Required: a title with no stated rank is a decision nobody made. */
  size: keyof typeof TITLE_SIZE;
  muted?: boolean;
  /**
   * Keep the source casing, for a title that names an ASSET.
   *
   * Tickers keep the casing their protocol gives them everywhere in this
   * product, and a heading is not an exception: `cbBTC / USDC` through an
   * uppercase transform is `CBBTC / USDC`, which is not the name of anything.
   * The weight and the tracking still apply, so such a title still reads as a
   * heading; it is only the transform that is dropped.
   *
   * A flag rather than a rule this component could infer, because it cannot:
   * `children` is a node, the ticker may be one interpolation inside a longer
   * phrase, and a heuristic over the rendered string would eventually decide
   * some protocol's name looked like a symbol.
   */
  caseSensitive?: boolean;
  /** Methodology or provenance, on request. Never inline. */
  hint?: string;
  className?: string;
}) {
  return (
    <Tag
      className={`flex items-center gap-1 font-sans font-black tracking-tight ${
        caseSensitive ? "" : "uppercase"
      } ${TITLE_SIZE[size]} ${muted ? "text-text-muted" : "text-text-primary"} ${className}`}
    >
      {children}
      {hint !== undefined && <InfoTip text={hint} />}
    </Tag>
  );
}
