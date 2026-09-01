/**
 * The Compass catalog, as a TABLE.
 *
 * It was eight cards in a three-across grid, and the shape was the problem for
 * the same reason the Portfolio's was: eight markets is eight copies of the
 * same six facts, and a reader asking "which of these scores lowest for the
 * yield it pays" had to read eight paragraphs to find eight pairs of numbers
 * that never lined up. A column is what lines figures up, and the figures are
 * all set in the one tabular face, so the comparison is the thing the screen is
 * for rather than something the reader assembles.
 *
 * WHAT WENT, and why it is not a loss. The risk DIAL is gone from the row: an
 * arc is a proportion of a fixed range drawn once, and eight of them are eight
 * gauges the eye has to sweep rather than a column it can scan. The score it
 * carried is still on every row, inside the band chip, which is the one place
 * this product turns a band into pixels. The 30-day APY SENTENCE is gone too
 * ("Up from 7.4% 30 days ago", once per card, in eight different tail
 * numbers); the move it described is now the column it always was, in
 * percentage points, with the direction as a glyph.
 *
 * Deliberately built on `LivePositions`'s markup rather than beside it: the
 * black header plate, the 3px row rules, the `TH`/`TD` pair and the
 * hidden-below-a-breakpoint column map are all the same decisions, and two
 * hand-typed tables in one product is how a header ends up over the wrong
 * column on one screen and not the other.
 *
 * Everything this renders arrives as props. It scores nothing, sizes nothing
 * and routes nothing: the lead, the profile partition and the open predicate
 * are all the caller's, so this table and the click it fires cannot disagree.
 */

import { ArrowDownRight, ArrowUpRight, Eye, Minus } from "lucide-react";
import type { Band, LiveProtocol, PoolYield } from "../lib/live";
import { BAND_WORD, formatCompactUsd, PROTOCOL_LABEL } from "../lib/utils";
import { Button, Card, DemoChip, EmptyState, RiskChip } from "../ui";
import { ProtocolLogo } from "./ProtocolLogo";

/**
 * The column head and the cell, written once each, and the same two strings
 * `LivePositions` sets its table with. The header row is a BLACK PLATE with
 * white ink for the reason given there: a table's head has to be findable while
 * carrying no state, and every other device on this look (a border, a shadow, a
 * fill) already means something that does.
 */
/**
 * Three padding steps rather than one, and they are measured rather than
 * chosen: the widest thing on a row is a band chip carrying a two-digit score
 * and the words "ELEVATED RISK", which is 157px that cannot be made narrower
 * without dropping either the figure or the word. `md` (768px) is now the
 * narrowest width this table itself ever renders at - everything below it is
 * the stacked block layout further down - and 12px of cell padding is what
 * keeps the surviving columns inside the card there. The full 24px is back
 * from `xl`, which is the first width with room for all seven.
 */
const TH = "h-14 whitespace-nowrap px-1 sm:px-2 xl:px-3 label-type text-xs text-white";
const TD = "px-1 sm:px-2 xl:px-3 py-3 align-middle";

/**
 * WHEN each column is up, defined ONCE and read by the header and the cell
 * together, so an edit cannot move a heading to a breakpoint its figures do not
 * share.
 *
 * This table mounts at `md` (768px) and up ONLY. Below that, the stacked
 * block layout further down (`blockRow`) draws the same rows as cards - the shape a market's six
 * facts take on a 390px phone is a card with three lines, not a table missing
 * four of its seven columns. So `sm` (640px), inside `COL.apy` below, is
 * always satisfied once the table itself is even mounted: it is left in
 * rather than simplified away, because the map still names the column's OWN
 * threshold, and a table someone widens the sidebar past `md` for should not
 * have to be re-derived from this file's other half to find out APY is always
 * up in it.
 *
 * Risk, APY, Market and the actions are up from `md`, the table's own base.
 * The rest come up in the order a reader would ask for them, at MEASURED
 * widths rather than at whichever breakpoint reads tidiest in source. The
 * numbers are the table's own `scrollWidth` against its card's `clientWidth` at
 * that viewport, and they are equal at every one of them, so this table never
 * travels sideways:
 *
 *   md   768px    Risk, APY, Market, Open.       434 in 434
 *   lg   1024px   + Protocol, and the             690 in 690
 *                 stress-test control.
 *   xl   1280px   + TVL and the 30-day move.      955 in 955
 *
 * See `blockRow` below for the base-to-`md` shape: one card per market,
 * three lines, no TVL.
 */
const COL = {
  apy: "hidden sm:table-cell",
  protocol: "hidden lg:table-cell",
  tvl: "hidden xl:table-cell",
  trend: "hidden xl:table-cell",
} as const;

/** Every figure in the table, in the one face this product sets numerals in. */
const FIGURE = "whitespace-nowrap font-mono text-sm font-bold tabular-nums text-text-primary";

/**
 * The protocol mark's tile size, one place, for both surfaces that draw a row:
 * the table's own Protocol column and the stacked block below `md`. `w-7 h-7`
 * (28px) is a real step on the spacing scale rather than the design's own
 * arbitrary 30px, and it is the exact size the mobile block already asks for.
 */
const PROTOCOL_MARK_SIZE = "w-7 h-7";

/** Header, separator and footer all span the full row. One number, one place. */
const COLUMN_COUNT = 7;

/**
 * The smallest 30-day move that survives one-decimal rounding, so a market
 * whose APY has not really changed cannot be drawn with an arrow. The same
 * threshold the sentence this column replaces used.
 */
const TREND_FLAT_POINTS = 0.1;

/**
 * The 30-day APY move, in percentage points, or nothing at all.
 *
 * NOTHING is the honest rendering when the history is absent: DefiLlama has no
 * series for every pool, and a dash or a zero in this column would read as "it
 * did not move", which is a measurement we do not have. The cell is simply
 * empty, and the market's own APY beside it is unaffected.
 *
 * Measured against the APY the row is SHOWING rather than the end of the
 * series. The two are the same number in production but need not be (the
 * headline is a separate field on the API row), and a row reading "2.5%" over a
 * move computed from 2.6% would be a row arguing with itself.
 */
function apyTrend30d(
  apy: number,
  apySeries: number[],
): { Icon: typeof ArrowUpRight; tone: string; figure: string; points: string } | null {
  const first = apySeries[0];
  if (first === undefined || !Number.isFinite(first) || !Number.isFinite(apy)) return null;
  const delta = apy - first;
  const BLACK = "text-text-primary";
  const MUTED = "text-text-muted";
  // Flat is a MEASURED state, not an unknown one, so it gets a figure. It is
  // written as the literal "0.0" rather than `delta.toFixed(1)` because a
  // delta of 0.07 rounds to "0.1" and would then sit beside the flat glyph.
  if (Math.abs(delta) < TREND_FLAT_POINTS) {
    return { Icon: Minus, tone: MUTED, figure: MUTED, points: "0.0" };
  }
  // Cobalt on the rising arrow only. It is the brand accent and is nowhere on
  // the risk ramp, so a market paying more than it did cannot be misread as a
  // market that got safer.
  if (delta > 0) {
    return { Icon: ArrowUpRight, tone: "text-brand", figure: BLACK, points: `+${delta.toFixed(1)}` };
  }
  // `toFixed` already carries the sign on a negative.
  return { Icon: ArrowDownRight, tone: BLACK, figure: BLACK, points: delta.toFixed(1) };
}

/**
 * The shape a row needs, and nothing more.
 *
 * Structural rather than an import of `VaultPreset`: the caller holds the full
 * preset (sizing defaults, engine ids, the collateral leg) and hands it
 * straight back through the three handlers, so this file would gain a
 * dependency on fields it never reads. The component is generic over `T` so the
 * object that comes BACK out of `onOpen` is the caller's own type, not this
 * subset of it.
 */
export interface MarketRow {
  id: string;
  /** The engine's id. `PROTOCOL_LABEL` is what turns it into a name. */
  engineProtocol: LiveProtocol;
  /** The leg, already worded by the catalog. Tickers keep their source casing. */
  assetPair: string;
  /** Static fallback APY; the live pool figure wins where there is one. */
  apy: number;
  /** The composite, live where the engine answered and listed where it did not. */
  baseRisk: number;
  riskStatus: Band;
}

interface MarketTableProps<T extends MarketRow> {
  /** In-profile markets. Sorted here, lowest score first. */
  recommended: T[];
  /** Out-of-profile markets, under their own separator. Sorted the same way. */
  outside: T[];
  /** The profile the partition was made against, for the separator's words. */
  profile: string;
  /** The one row the page leads with, if it has one. See `compassLead`. */
  leadId?: string;
  /** What that row CLAIMS, in the words of the thing that measured it. */
  leadNote: string;
  /** Whether an empty group is STATED rather than dropped. See its caller. */
  statesEmpty: boolean;
  recommendedEmptyTitle: string;
  recommendedEmptyHint?: string;
  outsideEmptyTitle: string;
  poolYields: Record<string, PoolYield> | null;
  /**
   * `NoInfer` on every callback, and it is load-bearing: without it TypeScript
   * weighs the handlers' parameter positions against `recommended`'s element
   * type and settles on the CONSTRAINT (`MarketRow`), so a caller handing back
   * its own full preset gets told the subset is not assignable to it. The rows
   * decide what `T` is; the handlers only receive it.
   */
  /** The predicate the open click routes on, so row and click agree. */
  opensReal: (market: NoInfer<T>) => boolean;
  /** Whether this row's score is the listed constant rather than an engine read. */
  scoreFromFallback: (market: NoInfer<T>) => boolean;
  /** Why a fallback score wears a marker, worded by the caller. */
  fallbackScoreNote: string;
  onBreakdown: (market: NoInfer<T>) => void;
  onSimulate: (market: NoInfer<T>) => void;
  onOpen: (market: NoInfer<T>) => void;
}

/** Lowest score first, which is the order the footer line states. */
function byScoreAscending<T extends MarketRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.baseRisk - b.baseRisk);
}

export function MarketTable<T extends MarketRow>({
  recommended,
  outside,
  profile,
  leadId,
  leadNote,
  statesEmpty,
  recommendedEmptyTitle,
  recommendedEmptyHint,
  outsideEmptyTitle,
  poolYields,
  opensReal,
  scoreFromFallback,
  fallbackScoreNote,
  onBreakdown,
  onSimulate,
  onOpen,
}: MarketTableProps<T>) {
  const recommendedRows = byScoreAscending(recommended);
  const outsideRows = byScoreAscending(outside);
  /**
   * Whether `leadId` actually names a row on screen, rather than an id the
   * caller passed that this partition does not currently hold. The footer's
   * legend explains a highlight that has to be findable, so it is only worth
   * drawing when one row is actually wearing it.
   */
  const hasLead =
    leadId !== undefined &&
    (recommendedRows.some((m) => m.id === leadId) || outsideRows.some((m) => m.id === leadId));

  /**
   * The seven facts a market's row states, derived once and read by both
   * shapes it is drawn in: the table's `<tr>` from `md` up, and the stacked
   * block below it. Two callers deriving `pool` / `trend` / `fallback`
   * separately is how one of them ends up reading a different pool record for
   * the same market id; this is the one place either can drift from.
   */
  const deriveRow = (market: T) => {
    const lead = market.id === leadId;
    const pool = poolYields?.[market.id] ?? null;
    const apy = pool?.apy ?? market.apy;
    const trend = pool ? apyTrend30d(apy, pool.apySeries) : null;
    const fallback = scoreFromFallback(market);
    const opensDemo = !opensReal(market);
    const name = PROTOCOL_LABEL[market.engineProtocol];
    return { lead, pool, apy, trend, fallback, opensDemo, name };
  };

  /**
   * One row, drawn identically wherever it sits. The section a market is in is
   * said by the separator above it and by nothing on the row itself: the old
   * grid dimmed the out-of-profile cards, which put a CRITICAL market's band at
   * 60% opacity, so the one market most worth reading clearly was the faintest.
   */
  const row = (market: T, first: boolean) => {
    const { lead, pool, apy, trend, fallback, opensDemo, name } = deriveRow(market);
    return (
      <tr
        key={market.id}
        /* Lavender, and it is the same lavender the Portfolio's navigated-to
           row wears: `highlight` is nowhere on the risk ramp, so the page can
           point at one market without the ramp making a claim about it. */
        className={`${first ? "" : "border-t-[3px] border-solid border-border-strong"} ${
          lead ? "bg-highlight" : ""
        }`}
      >
        <td className={TD}>
          <div className="flex items-center gap-2">
            {/* The one risk-hued element on the row, carrying the band word.
                `RISK_CHIP` is still the single place a band becomes pixels. No
                score here: this table sits beside the risk-breakdown panel
                that states the same market's composite as "N / 100", and a
                second copy of that figure in the chip, uncentred against the
                panel's own layout, restated a number a tap away rather than
                telling the reader something new. */}
            <RiskChip band={market.riskStatus}>
              {BAND_WORD[market.riskStatus]}
            </RiskChip>
            {/* Beside the figure it is about: a provenance mark reachable only
                by opening the panel behind this row leaves every glance at the
                table reading a listed constant as a measurement. Live is the
                default and wears nothing. */}
            {fallback && <DemoChip title={fallbackScoreNote} />}
          </div>
        </td>
        <td className={`${TD} ${COL.apy}`}>
          <span className={FIGURE}>{apy.toFixed(1)}%</span>
        </td>
        <td className={`${TD} w-full`}>
          {/* The name and, where this row opens the demo simulator rather than
              a real position, the marker for that: beside the name rather than
              beside the Open button, so the Actions cell is the same eye-button-
              then-Open-button shape on every row and the column stops ragging.
              `flex-wrap` is what sends the chip under the name at 390 instead of
              off the edge of the card. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* The market's NAME is the control that opens its risk breakdown,
                so the row itself is not clickable: a `tr` with an onClick has no
                role, no focus and no keyboard, and it would swallow presses
                meant for the two buttons at the end of the row. */}
            <button
              type="button"
              onClick={() => onBreakdown(market)}
              aria-label={
                `Open the ${name} ${market.assetPair} risk breakdown.` +
                (fallback ? ` ${fallbackScoreNote}` : "")
              }
              title={`Open the ${name} risk breakdown`}
              className="min-h-8 cursor-pointer text-left font-sans text-sm font-bold text-text-primary"
            >
              {market.assetPair}
            </button>
            {opensDemo && <DemoChip />}
          </div>
          {/* The yield, where its own column is not up. Read from the SAME
              `apy` the column reads one cell over, so the two can never state
              different numbers, and only one of them is ever on screen. */}
          <span className="block font-sans text-sm text-text-secondary sm:hidden">
            <span className={FIGURE}>{apy.toFixed(1)}%</span> APY
          </span>
        </td>
        <td className={`${TD} ${COL.protocol}`}>
          {/* The mark stands for the word: a reader who scans the same four
              logos on Watch and Portfolio does not need the protocol's name
              typeset a third time. `label` is what keeps it announced - the
              tile is the only place this row says which protocol it is. */}
          <div className="flex items-center justify-center">
            <ProtocolLogo protocol={name} size={PROTOCOL_MARK_SIZE} label={name} />
          </div>
        </td>
        <td className={`${TD} ${COL.tvl}`}>
          {/* Omitted, never a zero: a pool whose TVL we could not read is not a
              pool holding nothing. */}
          {pool && <span className={FIGURE}>{formatCompactUsd(pool.tvlUsd)}</span>}
        </td>
        <td className={`${TD} ${COL.trend}`}>
          {trend && (
            /* The GLYPH carries the direction's colour and the figure does not:
               a number tinted by which way it moved is a stat value coloured by
               its own content, which is the one thing colour is not for here.
               Flat is the exception and it is not a tint but a demotion: the
               whole cell drops to the muted ink, because "it did not move" is
               the reading a reader can skip. */
            <span className="inline-flex items-center gap-1.5">
              <trend.Icon className={`h-4 w-4 shrink-0 ${trend.tone}`} aria-hidden="true" />
              <span
                className={`whitespace-nowrap font-mono text-sm font-bold tabular-nums ${trend.figure}`}
              >
                {trend.points}
              </span>
            </span>
          )}
        </td>
        <td className={TD}>
          {/* The eye button and Open, and nothing else: the demo marker now
              sits beside the market's name in its own cell, so this cell is the
              same two controls on every row instead of ragging left on the rows
              that open the simulator. */}
          <div className="flex flex-col items-end justify-end gap-2 lg:flex-row lg:items-center">
            {/* Icon-only, so the row's primary action is the only labelled
                button on it. The name lives in `aria-label` and `title`; the
                ghost variant's own padding takes the target past the 24px
                floor.

                Withheld below `lg`, and it is the last thing this row gives up:
                a 442px column cannot carry the band, the yield, the market's
                name and two controls, and the alternative was a table that
                scrolls the Open button off the side of the card. The simulator
                is a whole tab of this product, so the route survives; the
                shortcut to it does not. The wrapper carries the visibility
                rather than the button, because a `hidden` passed through the
                primitive's `className` would tie with its own `inline-flex` on
                Tailwind's emit order. */}
            <span className="hidden lg:inline-flex">
              <Button
                variant="ghost"
                onClick={() => onSimulate(market)}
                aria-label="Stress-test this market in the simulator"
                title="Stress-test this market in the simulator"
              >
                <Eye className="h-4 w-4" aria-hidden="true" />
              </Button>
            </span>
            {/* Primary on the lead row only. Eight cobalt plates down one
                column is a page with no answer on it; one is the answer. */}
            <Button variant={lead ? "primary" : "secondary"} onClick={() => onOpen(market)}>
              Open
            </Button>
          </div>
        </td>
      </tr>
    );
  };

  /** An empty group, stated in place of its rows rather than as a gap. */
  const emptyRow = (title: string, hint?: string) => (
    <tr className="border-t-[3px] border-solid border-border-strong">
      <td colSpan={COLUMN_COUNT} className="p-4">
        <EmptyState tone="clear" title={title} hint={hint} />
      </td>
    </tr>
  );

  /**
   * One market, as a CARD, below `md`. Same seven facts as `row`, off the
   * same `deriveRow`, in three lines instead of seven columns: a 390px phone
   * does not have a column's width to spend on a heading, so the facts a
   * reader would scan top-to-bottom are stacked instead of tabulated. TVL is
   * the one figure dropped rather than reflowed - a market's size is the fact
   * this width has the least room to spare for, and it is still one tap away
   * behind the name.
   */
  const blockRow = (market: T, first: boolean) => {
    const { lead, apy, trend, fallback, opensDemo, name } = deriveRow(market);
    return (
      <div
        key={market.id}
        className={`flex flex-col gap-3 px-4 py-4 ${
          first ? "" : "border-t-[3px] border-solid border-border-strong"
        } ${lead ? "bg-highlight" : ""}`}
      >
        {/* Line 1: the band, and what it pays. `flex-wrap` is the same
            overflow guard the desktop Market cell uses - a CRITICAL chip
            carrying a fallback marker beside an APY figure is the one
            combination wide enough to ask for it. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <RiskChip band={market.riskStatus}>
              {BAND_WORD[market.riskStatus]}
            </RiskChip>
            {fallback && <DemoChip title={fallbackScoreNote} />}
          </span>
          <span className="flex shrink-0 items-baseline whitespace-nowrap">
            <span className="font-mono text-lg font-bold tabular-nums text-text-primary">
              {apy.toFixed(1)}%
            </span>
            <span className="ml-1 label-type text-2xs text-text-muted">APY</span>
          </span>
        </div>
        {/* Line 2: which protocol, which market, the name's own click target. */}
        <div className="flex flex-wrap items-center gap-2.5">
          <ProtocolLogo protocol={name} size={PROTOCOL_MARK_SIZE} />
          <button
            type="button"
            onClick={() => onBreakdown(market)}
            aria-label={
              `Open the ${name} ${market.assetPair} risk breakdown.` +
              (fallback ? ` ${fallbackScoreNote}` : "")
            }
            title={`Open the ${name} risk breakdown`}
            className="min-h-8 cursor-pointer text-left font-sans text-base font-bold text-text-primary"
          >
            {market.assetPair}
          </button>
          {opensDemo && <DemoChip />}
        </div>
        {/* Line 3: the move, and the way in. No `lg:hidden` on the eye button
            here - the table withholds it below `lg` because a 442px column
            has nowhere to put a third control, and a card has the width for
            both from the base. */}
        <div className="flex items-center justify-between gap-2">
          <span>
            {trend && (
              <span className="inline-flex items-center gap-1.5">
                <trend.Icon className={`h-4 w-4 shrink-0 ${trend.tone}`} aria-hidden="true" />
                <span
                  className={`whitespace-nowrap font-mono text-sm font-bold tabular-nums ${trend.figure}`}
                >
                  {trend.points}
                </span>
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => onSimulate(market)}
              aria-label="Stress-test this market in the simulator"
              title="Stress-test this market in the simulator"
            >
              <Eye className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button variant={lead ? "primary" : "secondary"} onClick={() => onOpen(market)}>
              Open
            </Button>
          </span>
        </div>
      </div>
    );
  };

  /** An empty group, in the block layout's own shape rather than a `<tr>`. */
  const blockEmpty = (title: string, hint: string | undefined, first: boolean) => (
    <div className={`p-4 ${first ? "" : "border-t-[3px] border-solid border-border-strong"}`}>
      <EmptyState tone="clear" title={title} hint={hint} />
    </div>
  );

  return (
    <Card tone="raised" padded={false} className="flex min-w-0 flex-col">
      {/* The black column-header row is the top of the card now: no title band
          above it. "Markets" named the card and the count restated a number the
          page states elsewhere, and neither survives asking what a reader loses
          without it. The card's own 3px top edge is what the header row now
          meets, and `hard-edge` carries no radius, so the two lines meet flush
          at every width. */}

      {/* The table, `md` and up. Seven columns of names and figures have a
          width below which they stop being a table - a 358px column short two
          controls' worth of Actions cell before a single other column even
          opens - and the stacked block layout below is what that width draws instead.
          `overflow-x-auto` is still the honest answer inside the range this
          DOES mount at: three columns still drop between `md` and `xl`, and
          the PAGE must never be the thing that scrolls sideways for them. */}
      <div className="hidden min-w-0 grow overflow-x-auto md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-text-primary">
              <th scope="col" className={TH}>
                Risk
              </th>
              <th scope="col" className={`${TH} ${COL.apy}`}>
                APY
              </th>
              {/* The one elastic column: everything else is a name or a figure
                  of known width, and the slack belongs to the market. */}
              <th scope="col" className={`${TH} w-full`}>
                Market
              </th>
              <th scope="col" className={`${TH} ${COL.protocol}`}>
                Protocol
              </th>
              <th scope="col" className={`${TH} ${COL.tvl}`}>
                TVL
              </th>
              <th scope="col" className={`${TH} ${COL.trend}`}>
                30d
              </th>
              {/* No heading over the actions: "Actions" is a word that names the
                  column type rather than the thing in it, and the two controls
                  under it already say what they do. */}
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {recommendedRows.length === 0
              ? statesEmpty && emptyRow(recommendedEmptyTitle, recommendedEmptyHint)
              : recommendedRows.map((m, i) => row(m, i === 0))}

            {/* Where the profile's limit falls, said ONCE, across the whole
                table, instead of once per card. The rows under it are drawn at
                full strength: this line is the "not recommended", and dimming
                them as well would put the emphasis on the warning rather than
                on the markets. */}
            {(outsideRows.length > 0 || statesEmpty) && (
              <tr className="border-t-[3px] border-solid border-border-strong bg-surface-sunken">
                <td colSpan={COLUMN_COUNT} className="px-4 py-2 label-type text-xs text-text-primary">
                  Outside your {profile} limit
                </td>
              </tr>
            )}
            {outsideRows.length === 0
              ? statesEmpty && emptyRow(outsideEmptyTitle)
              : outsideRows.map((m) => row(m, false))}
          </tbody>
        </table>
      </div>

      {/* The stacked cards, below `md`. Same partition, same separator, same
          footer as the table - only the row's own shape changes, in
          `blockRow` above. */}
      <div className="md:hidden">
        {recommendedRows.length === 0
          ? statesEmpty && blockEmpty(recommendedEmptyTitle, recommendedEmptyHint, true)
          : recommendedRows.map((m, i) => blockRow(m, i === 0))}

        {(outsideRows.length > 0 || statesEmpty) && (
          <div className="border-t-[3px] border-solid border-border-strong bg-surface-sunken px-4 py-2 label-type text-xs text-text-primary">
            Outside your {profile} limit
          </div>
        )}
        {outsideRows.length === 0
          ? statesEmpty && blockEmpty(outsideEmptyTitle, undefined, false)
          : outsideRows.map((m) => blockRow(m, false))}
      </div>

      {/* The sort order is the one thing about this list a reader cannot see by
          looking at it. Nothing else goes on this line: a refresh interval the
          code does not know would be a fact invented for a footer.

          The lead row's own claim used to repeat as a sub-line under its name;
          it is explained HERE instead, once, as a legend for the highlight
          every row shares the same swatch of - a sentence that sat on one row
          read as being about that market specifically, when what it was
          actually naming was the colour. Rendered only when a row is actually
          wearing `bg-highlight` (`hasLead`), so the swatch never claims a
          highlight this table did not draw.

          Two lines below `sm`, one from it: the fixed 48px band that fit one
          sentence does not fit two, and letting them wrap inside it silently
          would crop the second line rather than grow the footer to hold it. */}
      <div className="flex min-h-12 shrink-0 flex-col items-start justify-center gap-1 border-t-[3px] border-solid border-border-strong px-4 py-3 sm:h-12 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-0">
        <span className="label-type text-xs text-text-muted">Sorted by risk, lowest first</span>
        {hasLead && (
          <span className="flex shrink-0 items-center gap-2 label-type text-xs text-text-muted">
            <span
              className="h-3 w-3 shrink-0 border-2 border-solid border-border-strong bg-highlight"
              aria-hidden="true"
            />
            {leadNote}
          </span>
        )}
      </div>
    </Card>
  );
}
