/**
 * AI Advisor tab body. Renders the /api/advisor report: overall banner, one
 * card per position leg, and the OPEN opportunity row. Deterministic engine
 * decides; sections may be LLM-narrated server-side - this component only
 * displays.
 *
 * It used to display ALL of it, all the time. Every leg rendered four labelled
 * prose paragraphs (POSITION, MARKET, RECOMMENDATION, EXECUTION) and then
 * repeated the same figures in a stat strip immediately underneath, so the one
 * screen in the product that answers "what do I do" opened as four columns of
 * essay per position and the answer was the third paragraph down.
 *
 * What changed is the ORDER and the DEFAULT, not the content:
 *   - the RECOMMENDATION leads, at reading size, right under the protocol it is
 *     about, and the ACTION is the button at the foot of the card;
 *   - the score keeps the right rail to itself, so a verdict about what to DO
 *     and a score about how BAD it is are no longer one corner of one row;
 *   - the numbers stay in the strip, where they are scannable and where the
 *     prose does not have to restate them;
 *   - POSITION, MARKET and EXECUTION move into a collapsed disclosure. A user
 *     acting on an EXIT deserves the reasoning, so nothing is deleted - it is
 *     one click, keyboard-reachable, and it is the same click for every card.
 *
 * EXIT and REDUCE are the two highest-consequence things this product offers and
 * they were reading as decoration: a small quiet chip in the prose column, then a
 * small quiet button sharing its row with the disclosure trigger and a TESTNET
 * badge. The card now spends its hierarchy on them instead - the chip is gone
 * where a button says the same verb, the button is a size step larger and alone
 * on its row above a demoted `Details`, and TESTNET is stated once for the whole
 * panel. The button spends no hue: `Button` is a neutral fill by design.
 *
 * The URGENCY is marked by SHAPE: an EXIT or REDUCE leg carries a warning glyph
 * on its identity line, in neutral ink, and a WATCH or HOLD leg carries none.
 * The glyph used to take the band's hue, which painted a measurement the dial on
 * the same card already draws; the ramp on this screen is now the four dials and
 * the one banner that speaks for the whole wallet, and nothing else.
 *
 * The BANNER is what leads. It is the verdict for the wallet, so it takes the
 * screen's only functional border and a type step above the cards, rather than
 * being the smallest thing on a page of four large ones.
 *
 * The ways out are a LEAD plus footnotes, never a comparison. Two columns of
 * prose, one of them describing a route the app cannot sign, is the shape that
 * made this block unreadable; see `routesFor`.
 *
 * The legs are ordered WORST FIRST here rather than as the report built them.
 * See `worstFirst`.
 *
 * The engine's prose is not edited here. Where it duplicates the strip that is
 * a copy problem in packages/scoring/src/advisor, out of this file's scope.
 *
 * Exit/Open CTAs are wired through optional callbacks so the panel ships
 * before the transaction flows do (undefined callback = disabled + tooltip).
 */

import React from "react";
import { AlertTriangle, ArrowRight, ChevronRight, Compass, Eye } from "lucide-react";
import type {
  AdvisorAction,
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
} from "../lib/live";
import { recommendedExitAction } from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import { CardTitle } from "./CardTitle";
import {
  ADVISOR_ACTION,
  BAND_WORD,
  AI_PROSE_NOTE,
  formatUsd,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  PROTOCOL_LABEL,
  RISK_CHIP,
  URGENCY_VERDICT,
  USD_UNAVAILABLE_HINT,
  USD_UNAVAILABLE_LABEL,
  worseScoreFirst,
} from "../lib/utils";
import { Button, Card, Chip, EmptyState, RiskChip, RiskDial } from "../ui";
import { exitAvailabilityLine, exitControlState, useChainMode } from "../lib/chainMode";
import { openControlState } from "../lib/openProtocols";
/**
 * The engine's dollar formatter, not the panel's `formatUsd`.
 *
 * They agree above $1,000 and disagree below it (`$7` against `$7.40`), and
 * these figures sit on the same card as the engine's own prose quoting the same
 * repay. One rounding rule per quantity, and the rule belongs to the layer that
 * owns the number.
 */
import { fmtBps, fmtGasUnits, fmtUsd } from "../../../packages/scoring/src/advisor/fallback";
import { isDeleverageExecutable } from "../lib/exit";
/**
 * The engine's marginal-protection rate and the engine's rounding for it.
 *
 * Both deep imports, for the same reason `fmtUsd` above is one: the slope is
 * 1/L with L the liquidation-weighted collateral, and a component computing
 * `1 / (hf * debt)` for itself is a second copy of the money math sitting next
 * to the first. `formatDrawdownPct` is the one rounding policy for a price drop
 * anywhere in the product, so the added protection and the drop it is added to
 * are printed by the same rule.
 */
import { drawdownAfterExtraRepay } from "../../../packages/scoring/src/advisor/repayMath";
import {
  drawdownToLiquidation,
  formatDrawdownPct,
} from "../../../packages/scoring/src/prospective";

/**
 * The repay step the linear relationship is quoted at.
 *
 * Post-repay protection is linear in the repay (slope 1/L, the same at every
 * size), so one step is enough for the user to scale it themselves. $1,000 is
 * the step: small enough to be a real decision, large enough that the figure
 * beside it is not "under 0.1%" on an ordinary position.
 */
const REPAY_STEP_USD = 1_000;

/**
 * The gas caveat that used to sit behind `Details` on every card is gone.
 *
 * "Gas is estimated at signing. The price floor for anything sold is shown at
 * the same point." It said, at length, that two numbers would appear later on a
 * different screen, which is a sentence about the product's plumbing rather
 * than about this position. Both facts are stated where they are true: the exit
 * flow's review step now carries the live gas reading, and the swap floor is
 * read from the deployed config in that same flow.
 */

/**
 * What the card says about a collateral-funded repay it cannot yet perform.
 *
 * The sizing is true and worth reading: it tells a user with none of the debt
 * asset that a route exists and what it would cost. What the app must not do is
 * imply they can take it today, so the sentence names the gap rather than the
 * card quietly offering a dead button. It disappears on its own the moment
 * `DELEVERAGE_EXECUTABLE_PROTOCOLS` names a chain.
 */
const DELEVERAGE_NOT_LIVE = "Not ready to sign yet.";

/**
 * The per-card provenance correction is gone: "Wording on this one is the risk
 * engine's, not AI."
 *
 * It existed because `AI_PROSE_NOTE` at the foot says summaries are worded by
 * AI while `report.narrated` is true as soon as ONE leg is model-phrased, so on
 * a mixed report the footer over-claimed on the fallback legs. The correction
 * was accurate and it was still a line of type on every such card about a
 * distinction the reader cannot act on: the action, the numbers and the score
 * are the engine's on every leg either way. Provenance per block had already
 * been tried and deleted once for exactly that (see `AI_PROSE_NOTE`), and this
 * was it growing back one card at a time.
 *
 * The over-claim is closed at the footer instead, where the disclosure lives:
 * `AI_PROSE_NOTE` now says summaries MAY be worded by AI, which is true of
 * every report it appears on.
 */

/**
 * The verdict card's two lines, from the same recommendation data the
 * engine's `overallHeadline` sentence already reads (protocol, action, repay
 * plan, per-leg `usdValuesUnavailable`) rather than a data-blind split of that
 * sentence, which would have tied this component to the engine's exact
 * phrasing. The wording still says the same thing `overallHeadline` says for
 * the same inputs; it is punctuated with a period rather than the engine's
 * " - " because this card's copy may not use a hyphen as a dash. Known
 * duplication: if `packages/scoring` ever gains a structured
 * `{ title, detail }` return for the wallet verdict, this switch should be
 * retired in favour of it rather than kept in sync by hand.
 *
 * `detail` is the secondary line; when it is missing (no degraded leg, no
 * repay amount) the card shows a title alone rather than an empty line.
 */
function verdictLines(
  action: AdvisorAction,
  recs: AdvisorRecommendation[],
): { title: string; detail?: string } {
  const degradedLegs = recs
    .filter((r) => r.numbers.usdValuesUnavailable)
    .map((r) => PROTOCOL_LABEL[r.protocol] ?? r.protocol);
  const degradedNote =
    degradedLegs.length > 0
      ? `Prices degraded on ${degradedLegs.join(", ")}. Position sizes unverified.`
      : undefined;

  switch (action) {
    case "EXIT": {
      const legs = recs.filter((r) => r.action === "EXIT").map((r) => PROTOCOL_LABEL[r.protocol] ?? r.protocol);
      return { title: `Exit recommended on ${legs.join(", ")}`, detail: degradedNote };
    }
    case "REDUCE": {
      const r = recs.find((x) => x.action === "REDUCE");
      const where = r ? (PROTOCOL_LABEL[r.protocol] ?? r.protocol) : "your position";
      const amt = r?.repayPlan
        ? `Repay ~${fmtUsd(r.repayPlan.repayUsd)} to bring it back in range.`
        : undefined;
      return { title: `Reduce your ${where} exposure`, detail: degradedNote ?? amt };
    }
    case "REBALANCE":
      return { title: "Rebalance to a safer protocol", detail: degradedNote };
    case "MONITOR":
      return { title: "Positions approaching your risk threshold", detail: degradedNote };
    default:
      return { title: "All positions within your risk profile", detail: degradedNote };
  }
}

/**
 * Worst first.
 *
 * The legs arrived in whatever order the report was built in, so a panel could
 * open on a HOLD and put the EXIT third, on the one screen that exists to say
 * what to do next.
 *
 * A leg the engine could not score sorts FIRST, not last: an unmeasured risk is
 * not a low one, and a missing score read as 0 would file it under every healthy
 * position. Equal scores keep the report's own order (`sort` is stable per spec).
 */
function worstFirst(a: AdvisorRecommendation, b: AdvisorRecommendation): number {
  return worseScoreFirst(a.numbers.total, b.numbers.total);
}

function ActionButton({
  rec,
  onExit,
  onOpen,
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  const chainMode = useChainMode();
  const recommended = recommendedExitAction(rec);
  if (recommended) {
    const { prefill, label } = recommended;
    // Two reasons the control can be dead and the hover has to name the right
    // one: the flow may not be wired in on this surface, or the chain the user
    // is reading cannot execute an exit at all. Shared with the Portfolio row,
    // which offers the same action.
    const { enabled, hint: disabledHint } = exitControlState(onExit, chainMode);
    return (
      // A fragment, not a wrapper: the card's action row is the one flex-wrap
      // context, so the primary, the alternative and `Details` wrap as three
      // independent items instead of the buttons wrapping inside a box that
      // then wraps as a whole.
      <>
        {/* The `Button` primitive, which by design does not accept a risk band:
            these were a red fill and an orange fill, so the loudest element on
            the card was the control rather than the reading it acts on. The size
            step is what replaces that loudness legitimately: a 14px label on a
            near-white plate at 18.1:1, opening the row, against a 12px `Details`
            in plain text at the other end of it. */}
        <Button
          size="lg"
          onClick={enabled ? () => onExit?.(prefill) : undefined}
          disabled={!enabled}
          title={enabled ? undefined : disabledHint}
        >
          {label} <ArrowRight className="h-4 w-4" />
        </Button>
        {/* The declinable alternative. The engine still RECOMMENDS the exit, so
            the exit keeps the one primary fill and the larger step on this card
            and this stays `quiet` at the default size: a second equal button
            would put two equal answers on a card whose job is to give one. It is
            a real control rather than a line of prose because the engine has a
            prefill for it, and the sentence offering it is already in the
            recommendation above. */}
        {rec.alternative ? (
          <Button
            variant="ghost"
            onClick={
              enabled ? () => onExit?.({ protocol: rec.protocol, kind: "full_repay" }) : undefined
            }
            disabled={!enabled}
            title={enabled ? undefined : disabledHint}
          >
            Repay everything instead
          </Button>
        ) : null}
      </>
    );
  }
  if (rec.action === "OPEN" && rec.openPlan) {
    const plan = rec.openPlan;
    // Mirrors the exit gating above; the policy and its reasons live in
    // `openControlState`, shared with the popup.
    const { enabled, hint } = openControlState(
      onOpen,
      chainMode,
      rec.protocol,
      plan.collateralSymbol,
    );
    return (
      <Button onClick={enabled ? () => onOpen?.(plan) : undefined} disabled={!enabled}
        title={enabled ? undefined : hint}>
        Open position <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return null;
}

/**
 * The three sections that are not the recommendation, behind one disclosure,
 * plus whatever caveat the card owes a reader who is about to act.
 *
 * Labelled `Details`, not `Why this`. It holds the position, the market, the
 * execution notes and the gas caveat, and "why this" claimed only the first of
 * those while reading as a question the card had failed to answer above.
 *
 * The WAI-ARIA disclosure pattern rather than a native `<details>`, and the
 * trade is deliberate. `Details` belongs on the action row, to the right of the
 * button, and a `<details>` element cannot put its trigger in a flex row while
 * its body opens full width underneath: summary and body are siblings INSIDE the
 * element, so the body inherits whatever narrow track the trigger got. That is
 * the exact geometry that clipped every line of reasoning at 390 and 768 two
 * passes ago. The alternatives were `display: contents`, whose behaviour on
 * `<details>` is not something to bet a money screen on, or leaving the trigger
 * on its own line against an explicit review note.
 *
 * Nothing accessible is lost: a real `<button>` with `aria-expanded` and
 * `aria-controls` is announced as expandable and toggles on Enter and Space
 * exactly as a summary does, and the one global `:focus-visible` rule still
 * draws its ring. The body is always in the DOM and toggled with the `hidden`
 * attribute, so `aria-controls` always resolves to something.
 *
 * Returns a FRAGMENT, so the trigger and the body are both direct children of
 * the card's flex row: the trigger sits beside the button and the body carries
 * `w-full`, which makes it wrap to its own full-width line.
 */
function Reasoning({ rec, notes = [] }: { rec: AdvisorRecommendation; notes?: string[] }) {
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();
  const rows: [string, string][] = [
    ["Position", rec.sections.position],
    ["Market", rec.sections.market],
    ["Execution", rec.sections.execution],
  ];
  return (
    <>
      {/* `min-h-6` keeps a 12px label at the 24px tap-target floor (WCAG 2.5.8),
          and the hit area is the width of the words: this is the quiet half of
          the row and a full-bleed target would read as a second control. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        /* No transition on either the ink or the chevron: the disclosure is
           open or it is shut, and there is no motion in this system. The
           chevron's rotation is still the state marker, it just arrives there. */
        /* 44px and centred under the action on a phone, 24px and sized to
           its own words from `md` up. The controls row stacks below `md`, so a
           12px label with a 24px box under a full-width button is a target the
           thumb misses; from `md` the row is horizontal again and a full-bleed
           target there would read as a second call to action. */
        className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-1 label-type text-xs text-text-secondary hover:text-text-primary hover:underline md:min-h-6 md:shrink-0 md:justify-start"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        Details
      </button>
      <div id={bodyId} hidden={!open} className="w-full space-y-2.5">
        {rows.map(([label, text]) => (
          <div key={label} className="flex flex-col sm:flex-row sm:gap-4">
            <span className="w-28 shrink-0 pt-0.5 label-type text-xs text-text-muted">{label}</span>
            <p className="flex-1 text-sm font-sans leading-relaxed text-text-secondary">{text}</p>
          </div>
        ))}
        {notes.map((note) => (
          <p key={note} className="text-xs font-sans tabular-nums text-text-muted">
            {note}
          </p>
        ))}
      </div>
    </>
  );
}

/**
 * The evidence, on one line.
 *
 * Score and Asset left the strip because they are now stated once each,
 * elsewhere on the same card: the score is the dial on the rail, the asset is
 * the subtitle under the protocol. Five items became three, and the strip fits
 * a phone without wrapping into a block.
 */
function NumbersStrip({ rec }: { rec: AdvisorRecommendation }) {
  const n = rec.numbers;
  /**
   * The price drop the health factor MEANS, from the same engine helper the
   * position rows use: Collateral and Debt are dollars, and a bare ratio on an
   * unstated scale was the one item here a non-expert could not read.
   *
   * The asset is not repeated in the value: the card names it as the subtitle
   * under the protocol, and this strip has to fit a phone unwrapped. The exact
   * health factor is in the label's InfoTip, where every other "what is this
   * number" answer on this screen lives.
   */
  const outlook = liquidationOutlook(n.healthFactor, n.scoredCollateralSymbol);
  /**
   * A degraded leg has no dollars to state, so it states that instead of
   * printing `formatUsd`'s unknown glyph into two labelled slots. "Collateral
   * $…" is indistinguishable from a clipped string, which is how a deliberate
   * honesty state got read as a broken layout - the same reason the position
   * rows REPLACE their money line rather than dimming it.
   *
   * Driven off the values as well as the flag: a null magnitude is unknown
   * whether or not the leg was flagged, and there is no reading of "$…" in a
   * labelled slot that is better than saying so in words.
   */
  const usdUnknown =
    n.usdValuesUnavailable === true ||
    n.collateralValueUsd === null ||
    n.borrowValueUsd === null;
  /**
   * The fourth cell of the phone's grid, and it is the one thing the three
   * figures do not say: what this card is telling you to DO. At `md` and up the
   * button already says it and `Outcomes` prices it, so this cell is `md:hidden`
   * rather than a new column on the desktop strip.
   *
   * The repay is the engine's `repayPlan.repayUsd`, never a figure read back out
   * of the sentence that quotes it, and only on the leg that has one. Every
   * other action falls back to `ADVISOR_ACTION`, which is the verb this product
   * prints for the engine's enum.
   */
  const repay = rec.action === "REDUCE" ? rec.repayPlan : undefined;
  const items: { label: string; value: string; hint?: string }[] = [
    // `statLabel`/`statValue`, not `strip` + `stripNote`: this strip is one flex
    // row of label/value pairs with no sub-line, and joining the two halves back
    // together put a clause where a value goes ("none, no debt", "0%,
    // liquidatable now"). A debt-free leg has no drop to state, so it answers a
    // different label rather than a qualified number.
    { label: outlook.statLabel, value: outlook.statValue, hint: outlook.hover },
  ];
  if (!usdUnknown) {
    items.push({ label: "Collateral", value: formatUsd(n.collateralValueUsd) });
    items.push({ label: "Debt", value: formatUsd(n.borrowValueUsd) });
  }
  return (
    /* A 2 BY 2 GRID ON A PHONE, the flex row it always was from `md` up.
       Wrapped, the row put "Drop to liquidation 4.8%" and "Collateral $128,500"
       on one 358px line and "Debt" alone on the next, so three readings of one
       position landed on two ragged lines that could not be compared down a
       column. The grid gives each one a caption over its figure and a fixed
       cell, which is the shape the Portfolio dashboard states the same
       quantities in. */
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:flex md:flex-wrap md:items-baseline md:gap-x-6 md:gap-y-1.5">
      {items.map(({ label, value, hint }) => (
        <div
          className="flex min-w-0 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2"
          key={label}
        >
          <span className="flex min-h-8 min-w-0 content-end flex-wrap items-center gap-1 label-type text-xs text-text-muted md:min-h-0">
            {label}
            {hint && <InfoTip text={hint} />}
          </span>
          {/* Mono, like every figure in the product. Two of the three values
              here are dollar amounts and the third is a percentage or the short
              phrase the engine prints in place of one, so the whole strip is
              readings and it lines up across the three cards under it. */}
          <span className="truncate whitespace-nowrap font-mono text-sm font-bold tabular-nums text-text-primary">
            {value}
          </span>
        </div>
      ))}
      {/* The action cell, phone only. Words, so it is set in Archivo: mono is
          for readings, and "Reduce" is not one. */}
      <div className="flex min-w-0 flex-col gap-0.5 md:hidden">
        <span className="label-type text-xs text-text-muted">
          {repay ? "Repay" : "Action"}
        </span>
        {repay ? (
          <span className="truncate whitespace-nowrap font-mono text-sm font-bold tabular-nums text-text-primary">
            {formatUsd(repay.repayUsd)}
          </span>
        ) : (
          <span className="truncate font-sans text-sm font-bold text-text-primary">
            {ADVISOR_ACTION[rec.action]}
          </span>
        )}
      </div>
      {/* Stands IN for the two money pairs rather than qualifying them, and it
          is the UNKNOWN band as `RiskChip` draws it: white under the shared
          45-degree hatch, which is the one texture in this system meaning
          "there is nothing here, and that is not a verdict". It hand-built that
          block from `RISK_CHIP.UNKNOWN` plus a rounded box and a hairline
          border, which is the exact drift the primitive exists to stop - and
          the band's own recipe has since dropped the dashed edge the comment
          here still described. Distinctness from a priced leg holds on four
          axes and no branch of it can emit "$0".

          The explanation is an `InfoTip` INSIDE the chip rather than a `title`
          on it. A native tooltip is invisible to a keyboard and to a touch
          screen, and the reason this strip reached for one - that a tip's
          anchor cannot wrap - does not apply when the anchor sits inside a
          `whitespace-nowrap` chip that wraps as one piece. */}
      {/* `hidden md:contents` on a WRAPPER, not `hidden` on the chip: the chip
          carries `inline-flex` of its own and a `hidden` passed through
          `className` is the same property, so which one wins is Tailwind's emit
          order rather than the order they were written. The wrapper also keeps
          the marker out of the phone's 2-by-2 grid, where `shrink-0` buys
          nothing and three words were squeezed into a 146px cell. */}
      {usdUnknown && (
        <span className="hidden md:contents">
        <RiskChip band="UNKNOWN" fluid>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {USD_UNAVAILABLE_LABEL}
          <InfoTip text={USD_UNAVAILABLE_HINT} />
        </RiskChip>
        </span>
      )}
      {/* A second, independent caveat: this one is about the SCORE on the rail,
          not the dollars. It is stated because the dial prints a real number
          either way, the composite renormalises over what was measured, and a
          reader has no way to tell a fully-measured 75 from a partly-measured
          one unless the card says so. Same block and same tip placement as the
          marker above it, for the same reasons. */}
      {marketContextMissing(n.subScores) && (
        <span className="hidden md:contents">
        <RiskChip band="UNKNOWN" fluid>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {MARKET_CONTEXT_MISSING_LABEL}
          <InfoTip text={MARKET_CONTEXT_MISSING_HINT} />
        </RiskChip>
        </span>
      )}
    </div>
  );
}

/**
 * What the card's primary button does, priced.
 *
 * `cost` is what leaves the wallet or gets sold; `protection` is what the user
 * is left holding, led by the consequence rather than the ratio. Nothing here
 * is computed: every figure is an engine field, and the health factor becomes a
 * price drop through `liquidationOutlook`, the same helper the strip above uses.
 */
interface Lead {
  cost: string;
  protection: string;
  /** The exact health factor, on request. */
  hint?: string;
}

/**
 * A route the card NAMES but does not lead with.
 *
 * Every alternate is a different way of funding the same repay, so the funding
 * source is the label: it is the only thing that actually differs between them.
 */
interface Alternate {
  key: string;
  /** One line, opening with the funding source. */
  line: string;
  /** What this route costs that the recommended one does not. Lives in `Details`. */
  costs?: string;
}

interface Routes {
  lead?: Lead;
  alternates: Alternate[];
}

/**
 * What a card says about the ways out, and how much weight each one gets.
 *
 * This used to be a flat list rendered as equal columns, and it was the second
 * thing the founder could not read: "i have no idea wtf this means, why are
 * there 2 columns?". On a REDUCE leg the two columns were the SAME repay funded
 * two different ways, with nothing on screen saying so, at the same type and the
 * same width, and the right-hand one ended in "not available to sign yet". An
 * option the code cannot perform was given the visual weight of the one the
 * button takes.
 *
 * So the shape is a lead and its footnotes, not a comparison. The route the
 * primary button takes is stated in full, in reading type; every other route is
 * one muted line that opens with its funding source, because that is the only
 * real difference between them and a reader scanning for "what do I need to have
 * to do this" is scanning for exactly that word.
 *
 * Nothing is deleted. The collateral-funded option is still named, still sized,
 * still says plainly that it cannot be signed yet, and its extra costs are one
 * click away in `Details` rather than on the face of the card.
 */
function routesFor(rec: AdvisorRecommendation): Routes {
  const n = rec.numbers;
  const symbol = n.scoredCollateralSymbol;
  const alternates: Alternate[] = [];
  let lead: Lead | undefined;

  if (rec.action === "EXIT") {
    lead = {
      // Both halves, because the exit is wallet-funded on the repay side too:
      // a user reading only "sells your collateral" would arrive at the modal
      // and find they also need the debt asset in hand.
      //
      // Neither half quotes a figure. The two it would quote ARE the strip's
      // `Debt` and `Collateral`, the same engine fields, two lines above: an
      // exit moves the whole position by definition. The sentence is about what
      // moves and where, the strip is about how much, and printing the numbers
      // twice was the clearest instance of the card repeating itself.
      cost: `Repays your debt from your wallet, then sells your ${symbol} collateral for USDC.`,
      protection: "Nothing left to liquidate, and the position is closed.",
    };
  }

  const reduce = rec.action === "REDUCE" ? rec.repayPlan : undefined;
  if (reduce) {
    const outlook = liquidationOutlook(reduce.projectedHf, symbol);
    // What the NEXT $1,000 buys, so the sized repay reads as one point on a
    // line the user can move along rather than a figure to take or leave.
    //
    // Stated as where the drop lands, not as the size of the step: "adds 1.8%"
    // to a 43% figure can be read as 44.8% or as 43.8%, and one of those is a
    // liquidation the user did not plan for. The rate itself is the engine's
    // (slope 1/L, constant at every repay size), so the two readings agree.
    //
    // Every null here is a silence, never a zero: an unpriced leg has no rate,
    // a debt too small to fund another step has no next step (the engine's
    // guard - past that the line runs through 100%), and a position large
    // enough that $1,000 does not move the printed percentage gets no sentence
    // rather than one claiming the drop is unchanged.
    const after = drawdownToLiquidation(reduce.projectedHf);
    const stepped = drawdownAfterExtraRepay(
      after,
      rec.numbers.borrowValueUsd,
      rec.numbers.healthFactor,
      reduce.repayUsd,
      REPAY_STEP_USD,
    );
    let linear = "";
    if (after !== null && stepped !== null) {
      const steppedPct = formatDrawdownPct(stepped);
      if (steppedPct !== formatDrawdownPct(after)) {
        linear = ` Each further ${fmtUsd(REPAY_STEP_USD)} repaid takes that to ${steppedPct}.`;
      }
    }
    lead = {
      cost: `Repays ${fmtUsd(reduce.repayUsd)}${reduce.repayAssetSymbol ? ` of ${reduce.repayAssetSymbol}` : ""} from your wallet. Nothing is sold.`,
      protection: `${outlook.sentence}. Your collateral stays deposited.${linear}`,
      hint: outlook.hover,
    };
  }

  // The same repay, funded the other way. The engine emits both plans because it
  // cannot see a wallet balance and so cannot pick; `collateralFundedPlan` is
  // handed the SAME `targetHf` as the wallet-funded plan, which is why the two
  // deliver the same protection and why the amounts differ (selling collateral
  // to repay shrinks both sides of the ratio, so it takes a larger repay).
  const collateralFunded = rec.collateralFundedAlternative;
  if (collateralFunded) {
    const costs = collateralFunded.costs;
    // Read from the two plans rather than assumed. They agree unless the
    // collateral-funded repay clears the whole debt, in which case the engine
    // returns a null projected health factor and "the same protection" would be
    // a claim about a position that no longer has one.
    const sameProtection =
      reduce !== undefined && collateralFunded.projectedHf === reduce.projectedHf;
    const outlook = liquidationOutlook(collateralFunded.projectedHf, symbol);
    alternates.push({
      key: "collateral_funded",
      // Thirty words for an option nobody can take, cut to seventeen. What
      // survives is what distinguishes it: where the money comes from, that the
      // wallet needs nothing, and that it cannot be signed. The DOLLAR FIGURE
      // went with the rest. It is not why this line exists, it is a second
      // amount sitting beside the recommended one where the two are deliberately
      // different, and it is one click away in `Details` for anyone who wants
      // to size the route rather than learn that it is there.
      line:
        // A second sentence rather than a clause when the protections differ:
        // `outlook.sentence` opens with a capital and carries an asset symbol,
        // so it cannot be folded into the middle of one.
        `${sameProtection ? "The same protection, funded" : "Funded"} from your collateral` +
        ` with nothing in your wallet.${sameProtection ? "" : ` ${outlook.sentence}.`}` +
        // The honesty gate, on the same line as the offer rather than under it.
        // The contract that performs this is not deployed on any chain the app
        // talks to, so the card explains the option and says plainly that it
        // cannot be signed yet. It gets no button anywhere: offering a control
        // for something the code cannot do is the exact failure "never state a
        // fact the code does not know" exists to stop.
        (isDeleverageExecutable(rec.protocol) ? "" : ` ${DELEVERAGE_NOT_LIVE}`),
      // What the route costs AND what it is sized at, both in `Details`. The
      // repay is the figure the engine sized; the collateral sold is that plus
      // the fees, which is why this names the repay and says the collateral
      // funds it rather than quoting a sale amount nothing computed. Gas is
      // units: a dollar figure needs a live gas price and an ETH price the app
      // does not hold here.
      costs:
        `Funding the repay from your collateral repays ${fmtUsd(collateralFunded.repayUsd)}` +
        `${collateralFunded.repayAssetSymbol ? ` of ${collateralFunded.repayAssetSymbol}` : ""}` +
        ` by selling part of your ${symbol}.` +
        (costs
          ? ` It costs ${fmtBps(costs.flashFeeBps)} to borrow the funds, up to` +
            ` ${fmtBps(costs.slippageBps)} of the sale price, and about` +
            ` ${fmtGasUnits(costs.gasUnits)} gas.`
          : ""),
    });
  }

  // Executable, and it has its own `quiet` button on the row below, so one short
  // line is the same weight the control it belongs to already carries. The
  // button says the verb, so this says only what the button cannot: where the
  // money comes from and what survives. The amount is gone for the same reason
  // it is gone from the EXIT lead - a full repay IS the strip's `Debt`, which is
  // `Math.round(borrowUsd)` in the engine and sits four lines above.
  if (rec.alternative) {
    alternates.push({
      key: "full_repay",
      line: "Repaying everything instead comes from your wallet, and keeps your collateral deposited.",
    });
  }

  return { lead, alternates };
}

/**
 * The ways out, one column at every width.
 *
 * There is deliberately no grid here any more. Two columns of prose is what
 * made this block unreadable, and at 390 it could only ever have been one
 * column anyway; a lead plus muted one-liners says which route is the answer
 * without needing the reader to infer it from column order.
 */
function Outcomes({ routes }: { routes: Routes }) {
  const { lead, alternates } = routes;
  if (!lead && alternates.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-border-subtle pt-3">
      {lead ? (
        <div className="space-y-1">
          <p className="text-sm font-sans leading-relaxed tabular-nums text-text-secondary">
            {lead.cost}
          </p>
          <p className="text-sm font-sans leading-relaxed tabular-nums text-text-secondary">
            {lead.protection}
            {lead.hint ? <InfoTip text={lead.hint} className="ml-1" /> : null}
          </p>
        </div>
      ) : null}
      {alternates.map((a) => (
        // Muted and one type step down, which is the whole point: these are
        // routes the card is not recommending, and one of them cannot be taken
        // at all. `text-xs` is 12px, a step above the 11px floor.
        <p key={a.key} className="text-xs font-sans leading-relaxed tabular-nums text-text-muted">
          {a.line}
        </p>
      ))}
    </div>
  );
}

function RecommendationCard({
  rec,
  onExit,
  onOpen,
  readOnly = false,
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
  /** This report is about a wallet the reader watches but cannot act on. */
  readOnly?: boolean;
}) {
  const routes = routesFor(rec);
  /**
   * Whether this card offers a control, which is also whether the action chip
   * would be repeating a button label. `ActionButton` renders nothing for
   * WATCH, HOLD and MOVE, and nothing for an OPEN with no plan attached.
   *
   * `readOnly` folds in HERE rather than at the button, and that is the whole
   * reason it is one flag: with no button, the verb becomes the only statement
   * of the verdict on the card, so the chip has to come back. Suppressing the
   * button alone would leave an EXIT leg reading as prose with nothing naming
   * the recommendation.
   */
  const hasAction =
    !readOnly &&
    (rec.action === "EXIT" || rec.action === "REDUCE" || (rec.action === "OPEN" && !!rec.openPlan));
  /**
   * Whether this leg is one the user should act on today, which is the only
   * kind of card that earns a band chip. See the chip itself, below.
   */
  const urgent = rec.action === "EXIT" || rec.action === "REDUCE";
  return (
    /* `Card`, so the container does not tint by state. The border used to turn
       risk-critical on an EXIT leg, which is a whole box painted with a band -
       exactly what the primitive exists to prevent, and it doubled the red the
       dial inside it was already spending. */
    <Card tone="raised" className="space-y-4">
      <div className="flex items-start gap-3">
        {/* The mark is the desktop card's left rail. On a phone the header is
            the protocol, the ticker and the band, and a 32px logo beside three
            things that already name the position is 40px of a 358px line spent
            on decoration. */}
        <div className="hidden md:block">
          <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <CardTitle as="h4" size="sm" className="shrink-0">
              {PROTOCOL_LABEL[rec.protocol]}
            </CardTitle>
            {/* The ticker keeps its source casing, which is why it is a sibling
                of the title rather than part of it. */}
            <span className="truncate font-mono text-xs font-bold text-text-secondary">
              {rec.numbers.scoredCollateralSymbol}
            </span>
            {/* This leg is one to act on TODAY, marked by shape on the line
                that identifies it. Rationed to EXIT and REDUCE: a WATCH or a
                HOLD leg gets nothing, because a card whose advice is "nothing
                today" has no urgency to signal.

                NEUTRAL INK, and that is the whole point of it. It used to take
                `RISK_TEXT[band]`, which painted the band a second time on a card
                whose `RiskDial` sits four inches away drawing the same quantity
                as an arc and a numeral - the identical duplicate the Portfolio
                row triangles were fixed for. What this glyph carries is the
                ACTION, not the band, and hue is not the channel for it: shape is
                findability, and the ramp on this screen belongs to the dials and
                to the one banner that speaks for the whole wallet.

                Nothing is lost to a colour-blind reader or to a screen reader.
                The dial announces the band, the button says the verb, and the
                drop-to-liquidation figure states the distance in words.

                A GLYPH, not a chip. "Critical risk" in a tinted pill was a
                second reading of one measurement carrying a fill and a border of
                its own. */}
            {urgent ? (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 self-center text-text-secondary"
                aria-hidden="true"
              />
            ) : null}
            {/* The band, on the line that identifies the position, and ONLY
                where the dial is not drawing it: the two never mount together,
                so this spends no risk hue the card was not already spending.
                `score` is the dial's own numeral, in the one block, because a
                score and its band are one reading. */}
            <RiskChip
              band={rec.numbers.band}
              score={rec.numbers.total}
              className="ml-auto md:hidden"
            >
              {BAND_WORD[rec.numbers.band]}
            </RiskChip>
          </div>

          {/* The lead. On a card with a button the sentence is the whole lead
              and the verb is the button; on a card without one the chip is the
              only statement of the verdict, so it opens the block above the
              sentence that elaborates it. `ADVISOR_ACTION`, not `rec.action` -
              the raw union is an engine enum and this screen does not shout. */}
          <div className="space-y-1.5">
            {/* The `Chip` primitive, which is exactly this: a neutral marker
                beside a thing, white plate, no hue, no state. It was a local
                eleven-utility string with a `rounded-sm` box, a hairline border
                and a `bg-white/[0.06]` fill, i.e. a radius this system does not
                have and a translucent white plate that renders as nothing on a
                white card. `ADVISOR_ACTION`, not `rec.action`, so the engine's
                union never reaches the screen. */}
            {hasAction ? null : <Chip>{ADVISOR_ACTION[rec.action]}</Chip>}
            {/* The prose is the desktop card. On a phone the header, the grid
                and the button carry the whole decision, and the paragraphs that
                elaborate it are one press away in `Details` rather than four
                cards' worth of scroll between a reader and the control. */}
            <p className="hidden text-sm font-sans leading-relaxed text-text-primary md:block">
              {rec.sections.recommendation}
            </p>
          </div>

          <NumbersStrip rec={rec} />
        </div>

        {/* The rail, matching a Portfolio position row: the score, and the one
            thing you can do about it, in the same place on both screens. */}
        <div className="hidden shrink-0 flex-col items-center gap-2 md:flex">
          <RiskDial score={rec.numbers.total} band={rec.numbers.band} subScores={rec.numbers.subScores} />
        </div>
      </div>

      {/* What each button on this card actually does, with its numbers. It sits
          between the reading and the controls because that is the order the
          decision is made in: here is the position, here is what each way out
          costs and leaves, here are the buttons. */}
      <div className="hidden md:block">
        <Outcomes routes={routes} />
      </div>

      {/* One row: the action, then `Details` as the secondary affordance beside
          it. They are not two calls to action - a 42px filled plate against 12px
          plain text is the whole hierarchy, and it is the same hierarchy whether
          the row holds one button or three items.

          The clipping this row used to cause is structural now rather than
          arithmetic. `Reasoning` returns a fragment whose body carries `w-full`,
          so the body is a flex item that cannot share a line: it wraps to its
          own full-width row under the controls at every width, which is the one
          geometry a native `<details>` could not give (see `Reasoning`). No
          child of this row is ever narrower than the card. */}
      <div className="flex flex-col items-stretch gap-3 border-t border-border-subtle pt-4 md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:gap-y-3">
        {hasAction ? <ActionButton rec={rec} onExit={onExit} onOpen={onOpen} /> : null}
        {/* The costs of a route the card demoted. Money facts about a
            transaction, which is why they are not deleted and why they sit
            behind one click rather than on the face of the card. */}
        <Reasoning
          rec={rec}
          notes={routes.alternates.map((a) => a.costs).filter((c): c is string => !!c)}
        />
      </div>

    </Card>
  );
}

/**
 * An opportunity, shaped like a position row read forwards: what it would be,
 * what it would cost, what it would score.
 *
 * The prose paragraph that used to sit in the middle of this card said
 * "Deposit ~$25,000 USDC on Aave V3 (no borrow). Projected PANIK score 10,
 * ~8.1% net APY" - every figure of which is on the card already, in the two
 * lines above and below it. It is in the disclosure with the rest of the
 * reasoning now rather than printed twice.
 */
function OpportunityCard({
  rec,
  onOpen,
  readOnly = false,
}: {
  rec: AdvisorRecommendation;
  onOpen?: (plan: AdvisorOpenPlan) => void;
  readOnly?: boolean;
}) {
  const plan = rec.openPlan;
  if (!plan) return null;
  return (
    <Card tone="raised" className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />
        {/* `caseSensitive`: the title opens with a ticker. */}
        <CardTitle as="h4" size="sm" caseSensitive className="min-w-0 flex-1 truncate">
          {plan.collateralSymbol} on {PROTOCOL_LABEL[rec.protocol]}
        </CardTitle>
      </div>

      {/* The figures in mono and the words that qualify them in Archivo, rather
          than one `tabular-nums` span over both: "$25,000" is a reading and
          "collateral" is a word, and the mono face is what tells the two apart
          at a glance in a card only ~380px wide. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-sans text-sm text-text-secondary">
        <span className="whitespace-nowrap">
          <span className="font-mono font-bold tabular-nums text-text-primary">
            {formatUsd(plan.collateralUsd)}
          </span>{" "}
          collateral
        </span>
        {plan.borrowUsd > 0 && (
          <span className="whitespace-nowrap">
            <span className="font-mono font-bold tabular-nums text-text-primary">
              {formatUsd(plan.borrowUsd)}
            </span>{" "}
            borrow
          </span>
        )}
      </div>

      <p className="font-sans text-sm text-text-secondary">
        Projected score{" "}
        <span className="font-mono font-bold tabular-nums text-text-primary">
          {plan.projectedScore}
        </span>
        {plan.apy !== null ? (
          <>
            , <span className="font-mono font-bold tabular-nums text-text-primary">{`${(plan.apy * 100).toFixed(1)}%`}</span> APY
          </>
        ) : null}
      </p>

      {/* The same action row as the position cards: control, then `Details`.
          These sit three across from `xl`, so the card is only ~380px and the
          old side-by-side layout left the disclosure ~170px against reasoning
          rows that are a 112px label plus a paragraph. That is why the body is a
          `w-full` flex item now rather than a column beside the button: it
          cannot be given a narrow track, at 380px or at any other width. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border-subtle pt-3">
        {/* An opportunity sized from somebody else's portfolio, opened with the
            reader's own money, is two wallets in one plan. The figures still
            say what the Advisor found; only the button that would act on them
            is withheld. */}
        {readOnly ? null : <ActionButton rec={rec} onOpen={onOpen} />}
        <Reasoning rec={rec} />
      </div>
    </Card>
  );
}

/**
 * How many opportunities the Advisor shows before handing off to Compass.
 *
 * This section is a PREVIEW, not an index. Compass is the screen that exists to
 * list and compare every market the engine scores; the Advisor's job here is to
 * say "there is something for you over there", which two cards do as well as
 * five and without turning the answer to "what do I do about my positions" into
 * a shopping page.
 */
const OPPORTUNITY_PREVIEW = 2;

/**
 * Activate the Compass tab.
 *
 * `setActiveTab` lives in AppDemo and this panel is not handed it. What the app
 * DOES publish is its ARIA tablist contract: exactly one tablist is mounted at a
 * time (a `matchMedia` hook, not a CSS hide, precisely so the ids are unique)
 * and each tab button carries a stable `tab-<id>` that every panel already
 * depends on through `aria-labelledby`. Driving that button is the same thing a
 * user clicking the rail does, focus move included, rather than a second private
 * channel into the shell. Threading a real `onNavigate` prop is the cleaner
 * shape and is a follow-up: it needs an edit in AppDemo.
 */
function openCompassTab() {
  const tab = document.getElementById("tab-compass");
  tab?.focus();
  tab?.click();
}

/**
 * The handoff, as the last card in the preview grid.
 *
 * A real `<button>`, so it has a role, a focus ring from the one global
 * `:focus-visible` rule, and a 24px+ target.
 *
 * It is the SAME BLOCK as the opportunity cards it sits beside: white plate,
 * 3px edge, 6px shadow. The dashed edge it had was borrowed from
 * `RISK_CHIP.UNKNOWN` back when that band was a dashed outline, to say "not one
 * of the filled things beside it" - but the band stopped being dashed, every
 * edge in this system is now 3px solid black, and a dashed one reads as a
 * rendering fault rather than as a distinction. This is not an absence anyway;
 * it is a control, and what marks it as one is the press travel, which is the
 * same two static positions every other pressable block uses.
 */
function SeeAllInCompass() {
  return (
    <button
      type="button"
      onClick={openCompassTab}
      className="flex h-full min-h-32 w-full cursor-pointer flex-col items-center justify-center gap-2 hard-edge bg-surface-raised p-4 label-type text-sm text-text-primary shadow-hard hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-hard-sm active:translate-x-[6px] active:translate-y-[6px] active:shadow-none"
    >
      <Compass className="h-5 w-5 shrink-0" aria-hidden="true" />
      See all in Compass
    </button>
  );
}

export interface AdvisorPanelProps {
  report: AdvisorReport;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
  /**
   * Set when this report is about a wallet the reader only WATCHES, and the
   * sentence saying so.
   *
   * The note and the suppression are one prop rather than two, because they are
   * one decision: a caller could otherwise hide the buttons without explaining
   * the gap, or explain a gap that is not there. The reading half of the card
   * is unchanged - the whole point of watching an address is being told what is
   * happening to it.
   *
   * Not `onExit === undefined`. That already means something else here
   * ("the transaction flow is not wired in on this surface", per
   * `exitControlState`), and it renders a DISABLED button whose hover would
   * then name the wrong reason.
   */
  watchOnlyNote?: string;
}

export function AdvisorPanel({ report, onExit, onOpen, watchOnlyNote }: AdvisorPanelProps) {
  const chainMode = useChainMode();
  /**
   * The chain caveat, or null on the chain the exit works on.
   *
   * Read ONCE and held: it was called twice in the JSX below, as its own guard
   * and again as its own value, which is one string derived twice per render of
   * a panel that re-renders on every 60s advisor poll.
   */
  const chainNote = exitAvailabilityLine(chainMode);
  const { overall, recommendations, opportunities, walletInsights } = report;

  /* Provenance, on hover. "Based on your history: Levered ETH borrower · 17mo
     lending tenure · mostly moonwell · no liquidations" is how the engine
     reached its verdict, not a thing to do about it, and it was a permanent
     second line under the one sentence on this page that must be read. */
  const insightsText = walletInsights
    ? `Read from this wallet's history: ${walletInsights.archetype}. ` +
      (walletInsights.lendingAgeDays > 0
        ? `About ${Math.round(walletInsights.lendingAgeDays / 30)} months of lending activity. `
        : "") +
      (walletInsights.topProtocol ? `Mostly on ${walletInsights.topProtocol}. ` : "") +
      (walletInsights.liquidations > 0
        ? `${walletInsights.liquidations} past liquidation${walletInsights.liquidations > 1 ? "s" : ""}.`
        : "No past liquidations.")
    : null;

  const readOnly = watchOnlyNote !== undefined;

  /** Null on an `info` report, which is the branch that gets no chip at all. */
  const walletVerdict = URGENCY_VERDICT[overall.urgency];

  /** The verdict card's title and (optional) secondary line; see `verdictLines`. */
  const verdict = verdictLines(overall.action, recommendations);

  /* A COPY, sorted: `sort` mutates, and the array here is the caller's report
     object, which other surfaces read from. See `worstFirst`. */
  const legs = React.useMemo(() => [...recommendations].sort(worstFirst), [recommendations]);

  return (
    <div className="space-y-6">
      {/* Whose wallet this report is about, and what the reader may do with it,
          before the first verdict rather than as a gap they notice later. The
          reading half of the panel is unchanged: being told what is happening to
          an address is the whole point of watching it. */}
      {watchOnlyNote && (
        <Card className="flex items-start gap-3">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm font-sans leading-relaxed text-text-secondary">
            {watchOnlyNote}
          </p>
        </Card>
      )}

      {/* The verdict for the whole wallet, and the ONE thing on this screen
          that leads.

          It did not before. It was a 14px sentence on the same surface, with the
          same edge, as four cards two to three times its height, so the answer to
          "what is happening to my wallet" was the quietest element on the page
          that exists to answer it. It now takes the one functional border on the
          screen and a type step (16px against the cards' 14px); the cards below
          stay where they were, which is a step down from this rather than a
          demotion of themselves.

          The card is a plain white surface, same as every other card on the
          screen - not the lavender fill it used to carry. A tint behind the
          whole block was a second, softer copy of the severity the chip already
          states, and on `info` there was no severity to state at all, so the
          calm branch of this card wore the same coloured wash as the alarming
          one.

          The ramp appears here as ONE block: the `RiskChip`, at 4.5:1 by
          construction on every band. It used to also live in a "Act now" /
          "Act soon" word inside that chip and in a neutral warning triangle
          beside it - a coloured verb and a decoration both saying the thing the
          chip's hue already says. The chip alone carries the state; the icon is
          gone on every severity, and the chip's word now names the SEVERITY
          ("Critical risk") rather than an instruction, because what to do is the
          headline's job, not the chip's. */}
      <Card tone="raised" className="flex items-start gap-3">
        {overall.urgency === "info" ? (
          <>
            <Eye className="mt-0.5 h-5 w-5 shrink-0 text-text-primary" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-base font-sans leading-relaxed text-text-primary">
              {overall.headline}
              {insightsText && <InfoTip text={insightsText} className="ml-1.5" />}
            </p>
          </>
        ) : (
          <>
            {walletVerdict && <RiskChip band={walletVerdict.band}>{walletVerdict.word}</RiskChip>}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-sans text-base font-bold text-text-primary">{verdict.title}</p>
              {(verdict.detail || insightsText) && (
                <p className="text-sm font-sans leading-relaxed text-text-secondary">
                  {verdict.detail}
                  {insightsText && (
                    <InfoTip text={insightsText} className={verdict.detail ? "ml-1.5" : undefined} />
                  )}
                </p>
              )}
            </div>
          </>
        )}
      </Card>

      {/* Position legs */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <CardTitle as="h3" size="sm">
              {readOnly ? "Positions on this wallet" : "Your positions"}
            </CardTitle>
            {/* Once, for the section, instead of a pill beside every exit
                button on every card. The chain you are signing on is a property
                of the selected network, not of a position, and the flow the
                button opens states it again in its own header and banner before
                anything can be signed.

                On the mode where exits DO work it says nothing at all now. The
                sentence there ("Exits can be signed and settled on Base
                Sepolia, against whatever this wallet holds there") restated the
                button beside it, which is the copy rule's delete case; the one
                a reader needs is the one saying the button will not work. */}
            {chainNote && <p className="text-xs font-sans text-text-muted">{chainNote}</p>}
          </div>
          {legs.map((rec) => (
            <RecommendationCard
              key={`${rec.protocol}-${rec.numbers.scoredCollateralSymbol}`}
              rec={rec}
              onExit={onExit}
              onOpen={onOpen}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          tone="clear"
          title="No open lending positions on Base"
          hint="The opportunities below are sized to your risk profile."
        />
      )}

      {/* Opportunities */}
      {opportunities.length > 0 ? (
        <div className="space-y-4">
          <CardTitle as="h3" size="sm">
            Opportunities within your profile
          </CardTitle>
          {/* Three across only once the window can actually spare it: at `md`
              the sidebar has already taken 256px, so three of these cards got
              ~137px each and every title ellipsised to a couple of letters. */}
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {opportunities.slice(0, OPPORTUNITY_PREVIEW).map((rec) => (
              <OpportunityCard
                key={`${rec.protocol}-${rec.openPlan?.collateralSymbol}`}
                rec={rec}
                onOpen={onOpen}
                readOnly={readOnly}
              />
            ))}
            <SeeAllInCompass />
          </div>
        </div>
      ) : null}

      {/* The panel's scope line. It replaced a marker under every BLOCK of prose
          on every card plus a banner explaining that the markers exist: which
          sentences a model rephrased is not a thing the reader acts on, and the
          engine decides the recommendation either way.

          It is the whole disclosure for the panel, and it is worded to survive
          a MIXED report: `narrated` is true as soon as any one leg is
          model-phrased, so a line claiming every summary was would over-claim on
          the legs that fell back to the engine. Present only when there is
          something to disclose. */}
      {report.narrated ? (
        <p className="text-xs font-sans text-text-muted">{AI_PROSE_NOTE}</p>
      ) : null}
    </div>
  );
}
