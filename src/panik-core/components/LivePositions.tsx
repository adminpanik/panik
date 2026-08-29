/**
 * The wallet's positions, as a TABLE.
 *
 * It was a list of cards, three lines and a rail each, and the shape was the
 * problem: four positions is four columns of the same four facts, and a reader
 * comparing "which of these is closest to liquidation" had to read four
 * paragraphs to find four percentages that never lined up. A table puts the
 * comparable things in a column, which is what a column is for, and the money
 * lines up because every figure in it is set in the one tabular face.
 *
 * WHAT MOVED, rather than went. The score dial, the limit-state clause, the
 * degraded-feed markers, the simulated-price chip and the exit control are all
 * still here; they are in the row's DISCLOSURE now instead of on its face. Six
 * facts per row across four rows is not a table anyone reads, and five of the
 * six are things a reader wants for one position at a time rather than for all
 * of them at once. The row's own button is the disclosure, and it is the
 * protocol's mark, so what opens a position is the thing that identifies where
 * it is held.
 *
 * Data arrives via props from AppDemo's live hooks (shared with the Portfolio
 * stat row) - this component only renders.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Eye } from "lucide-react";
import type { LiveWalletPosition, ScoringChainInfo } from "../lib/live";
import { CardTitle } from "./CardTitle";
import { ProtocolLogo } from "./ProtocolLogo";
import {
  BAND_WORD,
  formatUsd,
  limitStateCopy,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  PROTOCOL_LABEL,
  RISK_CHIP,
  USD_UNAVAILABLE_HINT,
  worseScoreFirst,
} from "../lib/utils";
import { Button, Card, Chip, EmptyState, Notice, RiskChip, RiskDial, SimulationChip, Skeleton } from "../ui";
import { exitControlState, useChainMode } from "../lib/chainMode";
import type { ExitPrefill } from "./ExitFlow";

/**
 * The row identity the alert feed navigates to. Same shape as the React key, and
 * exported so the caller does not hand-assemble the string it has to match.
 */
export function positionKey(p: Pick<LiveWalletPosition, "wallet" | "protocol">): string {
  return `${p.wallet}:${p.protocol}`;
}

/**
 * How the header names the chain, and what the provenance tip may claim.
 *
 * Nothing is rendered on the default chain: "Base" beside every position on
 * every mainnet install is a caption that never changes, which is the kind of
 * text DESIGN_SYSTEM's three-way copy test deletes. It is rendered the moment
 * the API reports anything else, because THEN the chain is the thing a user
 * would otherwise get wrong.
 *
 * The tip is rebuilt rather than reworded because the mainnet sentence names
 * CoinGecko and DefiLlama, and on a testnet neither is consulted at all: a
 * degraded read must not come with a caption asserting the source it did not
 * use.
 */
function chainProvenance(chain: ScoringChainInfo | null): { badge: string | null; tip: string } {
  const MAINNET_TIP =
    "Scored by the PANIK engine: live RPC reads (Aave getUserAccountData / Moonwell derived HF) + CoinGecko volatility + DefiLlama TVL. Refreshes every 60s.";
  if (chain === null || chain.mode === "mainnet") return { badge: null, tip: MAINNET_TIP };
  return {
    badge: chain.label,
    tip:
      `Scored by the PANIK engine from live RPC reads on ${chain.label} ` +
      "(Aave getUserAccountData), the same chain the exit runs on. Test assets have no " +
      "price history and no protocol TVL to read, so market risk is left unmeasured and " +
      "the score is weighted over position health and protocol safety. Refreshes every 60s.",
  };
}

/**
 * The column head and the cell, written once each.
 *
 * The header row is a BLACK PLATE with white ink, which is the one place this
 * look inverts: a table's head is the only element on the page that has to be
 * findable while carrying no state at all, and every other device available
 * here (a border, a shadow, a fill) is already spoken for by something that
 * does carry state.
 *
 * `whitespace-nowrap` on both, and Outlook is the only elastic one (`w-full`
 * below): a money column that wraps is a money column that stops lining up,
 * which is the entire reason these figures are in a table.
 */
const TH = "h-14 whitespace-nowrap px-2 label-type text-xs text-white sm:px-3";
const TD = "px-2 py-3 align-middle sm:px-3";

/**
 * WHEN each column is up, defined ONCE per column and read by both the header
 * and the cell.
 *
 * The two were retyped separately, and nothing made them agree: an edit that
 * moved the Debt header to `2xl` and left its cells at `xl` would put a column
 * of figures under the wrong label, which is the one failure a table cannot
 * survive and the one a screenshot does not obviously show.
 *
 * Protocol, Market and Risk are absent because they are never hidden: the mark,
 * the name and the band are what a 390px phone still has to carry, and
 * everything dropped below them is repeated in the row's disclosure.
 */
const COL = {
  collateral: "hidden xl:table-cell",
  debt: "hidden xl:table-cell",
  outlook: "hidden md:table-cell",
} as const;

/**
 * The MARKET, as the position's name.
 *
 * A row led with the protocol and put the asset in a column of its own, so a
 * phone read four rows of "Aave V3", "Moonwell", "Compound V3" - four venues,
 * when what tells one leg from another is what is in it. The protocol is a
 * BRAND MARK now, in the column before this one, which is how a reader
 * recognises a venue anyway; the words go to the thing they cannot recognise
 * from a glyph.
 *
 * ONE SYMBOL, not a pair, and that is the whole reason this is a function with
 * a comment on it rather than a template string. A lending leg reads as
 * "cbBTC / USDC" everywhere in DeFi, and `LiveWalletPosition` carries
 * `scoredCollateralSymbol` and no debt symbol at all - so the second half of
 * that pair would be invented here, and it would be invented on exactly the
 * screen where a reader decides which position to close.
 */
function marketName(p: LiveWalletPosition): string {
  return p.scoredCollateralSymbol;
}
/** Every figure in the table, in the one face this product sets numerals in. */
const FIGURE = "whitespace-nowrap font-mono text-sm font-bold tabular-nums text-text-primary";
/**
 * A cell whose figure could not be measured. Words, in the demoted ink, never a
 * zero: a stale price feed rendering "$0" is the failure this product is least
 * able to survive, and it reads as a real, tiny position rather than as a gap.
 */
const NOT_MEASURED = "whitespace-nowrap font-sans text-sm text-text-muted";

/**
 * One money column's cell: the figure, or the words when the price feed could
 * not be read.
 *
 * A function rather than two copies of the same ternary, because the two
 * columns differ only in which field they read and the branch they share is the
 * one that must never emit a zero.
 */
function moneyCell(usd: number | null, unpriced: boolean) {
  return unpriced ? (
    <span className={NOT_MEASURED} title={USD_UNAVAILABLE_HINT}>
      Not measured
    </span>
  ) : (
    <span className={FIGURE}>{formatUsd(usd)}</span>
  );
}

interface LivePositionsProps {
  positions: LiveWalletPosition[] | null;
  offline: boolean;
  /**
   * The chain the API says it read these positions from, or null when it did
   * not say. Null renders no claim, never a guessed chain name.
   */
  chain?: ScoringChainInfo | null;
  /** Optional: open this real position in the Watch simulator (stress-test bridge). */
  onStressTest?: (position: LiveWalletPosition) => void;
  /**
   * The action the ENGINE recommends for a protocol, keyed by protocol id, or
   * an absent key for "nothing to do here".
   *
   * Passed in rather than derived, and that is the whole point of the shape.
   * This list knows a band and a health factor; it does not know whether the
   * answer is to close the position or to repay part of it, and it cannot size
   * a repay. The Advisor does, so the row offers the Advisor's own
   * recommendation and its own prefill. A button here that assumed "critical
   * means full exit" would be this component inventing advice, and it would
   * disagree with the Advisor tab the moment the engine sized a REDUCE instead.
   */
  exitActions?: Record<string, { label: string; prefill: ExitPrefill } | undefined>;
  /** Runs the action above. Absent means no exit control is offered at all. */
  onExit?: (prefill: ExitPrefill) => void;
  /**
   * `positionKey` of the row an alert just pointed at, or null for none. The row
   * scrolls into view, takes focus and holds a neutral emphasis until the caller
   * clears it.
   */
  highlightKey: string | null;
}

export function LivePositions({
  positions,
  offline,
  chain = null,
  onStressTest,
  exitActions,
  onExit,
  highlightKey,
}: LivePositionsProps) {
  /**
   * Whether an exit could be signed from here at all.
   *
   * The same predicate the Advisor card reads, so the two surfaces cannot
   * disagree about whether the action is available. What differs is what they
   * do with the answer, and deliberately: the Advisor is a page of advice, so
   * an unavailable action stays on screen with its reason on hover. A position
   * row is a scanning surface, and a control that cannot fire is withheld here,
   * so its presence is the whole statement that pressing it works.
   */
  const { enabled: exitEnabled } = exitControlState(onExit, useChainMode());
  const provenance = chainProvenance(chain);
  /**
   * Which row's disclosure is open. ONE at a time, and it is a key rather than
   * a set: two open rows push the table's other rows off the fold, and the
   * disclosure exists so a reader can look at one position closely.
   */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const detailIds = useId();
  /**
   * One ref, attached to the highlighted row only. Refs are set during commit,
   * before effects run, so the row this points at is always the one the current
   * `highlightKey` names.
   */
  const highlightedRow = useRef<HTMLTableRowElement | null>(null);

  /**
   * Scrolling is not enough on its own. A sighted mouse user sees the row move
   * under them; a keyboard or screen-reader user pressing Enter on an alert
   * gets nothing at all unless focus follows, and would then Tab on from the
   * alert feed rather than from the thing they just navigated to. `tabIndex=-1`
   * on the row makes it focusable as a DESTINATION without adding a tab stop.
   *
   * Keyed on the KEY alone. `positions` gets a fresh array identity on every 60s
   * poll, so depending on it meant a poll landing inside the highlight window
   * re-ran this and stole focus back mid-scroll.
   */
  useEffect(() => {
    const row = highlightedRow.current;
    if (!highlightKey || !row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.focus({ preventScroll: true });
  }, [highlightKey]);

  /**
   * The rows, worst first. Memoised on the array identity: `positions` is a
   * fresh array only when a poll lands, and this component re-renders whenever
   * anything in the shell changes - a tab switch, a modal, a chain-telemetry
   * poll - so an unmemoised copy-and-sort ran on every one of them.
   *
   * `worseScoreFirst` is the Advisor's ordering rule, from lib/utils, so an
   * unscorable position lands at the top of both lists rather than wherever a
   * NaN subtraction leaves it here.
   *
   * ABOVE the offline return, because a hook after a conditional return is a
   * hook that is not always called.
   */
  const rows = React.useMemo(
    () =>
      positions === null
        ? null
        : [...positions].sort((a, b) => worseScoreFirst(a.total, b.total)),
    [positions],
  );

  /*
   * `offline` alone used to be the whole check here, so a poll that failed
   * AFTER a previous one had already landed rows collapsed this card straight
   * to "positions are unknown right now" - discarding the very rows that made
   * that sentence false, and disagreeing with the stat cards above, which keep
   * showing the last successful read plus how old it is. The unknown case is
   * real (a wallet that has never been read at all, `rows === null`), and it
   * still gets the hatched EmptyState below. A wallet with rows on file gets
   * to keep them, with a banner rather than a blank.
   */
  if (offline && rows === null) {
    return (
      <EmptyState
        tone="problem"
        title="Live feed unavailable"
        hint="We could not reach the scoring feed, so this wallet's positions are unknown right now. That is not the same as having none."
      />
    );
  }

  return (
    <Card tone="raised" padded={false} className="flex min-w-0 flex-col">
      {/* The card's name and its count, on one 56px band over the black head.
          The count lives HERE, on the list it describes, rather than in a
          subline on a card three columns away that read the same array through
          different props and could therefore disagree with it. The provenance
          is on the title's tip: an answer to a question asked once, not a
          caption needed on every glance.

          Only rendered once the array has arrived: "0 open" while the first
          fetch is still in flight is a claim we cannot make yet, and it is the
          exact claim this product must never make by accident. */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b-[3px] border-solid border-border-strong px-4">
        <CardTitle as="h3" size="lg" hint={provenance.tip}>
          Positions
        </CardTitle>
        {rows !== null && (
          <span className="shrink-0 whitespace-nowrap font-mono text-sm font-bold tabular-nums text-text-secondary">
            {rows.length} open
          </span>
        )}
      </div>

      {/* The STALE banner: a previous read stands (`rows` is not null) but the
          feed that would refresh it is currently down. Deliberately not the
          hatched EmptyState above - these rows are real, just not current,
          and a reader who just saw the stat cards state a real number must
          not then be told this table knows nothing. `Notice` rather than a
          hand-rolled strip: it is already "a thing that did not work, in one
          line" everywhere else in this product (AccountGate, ExitApprovals),
          and a second, differently-bordered version of that exact statement
          is the kind of drift its own docstring warns about. */}
      {offline && (
        <div className="px-4 pt-3">
          <Notice text="Showing the last successful read. The feed is unavailable, so these rows are not being rescored." />
        </div>
      )}

      {rows === null ? (
        <div className="space-y-3 p-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-7 w-24 shrink-0" />
            </div>
          ))}
          <p className="font-sans text-xs text-text-secondary">Reading positions from chain...</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            tone="clear"
            title="No open positions"
            hint="New positions are picked up within a minute of opening."
          />
        </div>
      ) : (
        /* The one horizontal scroller in the product, and it is the honest
           answer for a table: six columns of names and figures have a width
           below which they stop being a table, and the PAGE must never be the
           thing that scrolls sideways. Below `xl` the two money columns drop
           into the row's own disclosure instead, so this only engages in the
           narrow band where all six are up and the column is tight. */
        <div className="min-w-0 grow overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-text-primary">
              {/* The protocol's column, and it carries no word: what is in it is
                  a brand MARK, which a header reading "Protocol" would be
                  labelling for a reader who has already recognised it. 44px is
                  the chevron and the 28px tile beside it. */}
              <th scope="col" className={`${TH} w-11`}>
                <span className="sr-only">Protocol</span>
              </th>
              {/* The row's NAME, and the widest text column at every width the
                  money columns are down.

                  Sized to its content rather than given the table's slack, and
                  that is measured rather than preferred: a ticker's max-content
                  is 60-110px, so `w-full` here hands Market 210px it cannot
                  fill and leaves Outlook 90px it needs 200 for - "Liquidates if
                  cbBTC falls 4.8%" over three lines, an 85px row, at 1024. The
                  slack belongs to the only column holding a sentence. */}
              <th scope="col" className={TH}>
                Market
              </th>
              <th scope="col" className={`${TH} ${COL.collateral}`}>
                Collateral
              </th>
              <th scope="col" className={`${TH} ${COL.debt}`}>
                Debt
              </th>
              <th scope="col" className={`${TH} w-full ${COL.outlook}`}>
                Outlook
              </th>
              {/* `w-px` is the "size me to my content" trick, and with the chip
                  now a fixed 112px block it is exactly that: the column is the
                  chip's own width and every pixel after it belongs to Market.
                  Never hidden - the band and the name are the two facts a 390px
                  phone still has to carry, and everything dropped below them is
                  repeated in the row's disclosure. */}
              <th scope="col" className={`${TH} w-px text-center`}>
                Risk
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const key = positionKey(p);
              const open = openKey === key;
              const detailId = `${detailIds}-${i}`;
              const highlighted = key === highlightKey;
              const outlook = liquidationOutlook(p.healthFactor, p.scoredCollateralSymbol);
              const unpriced = p.usdValuesUnavailable === true;
              // Both terms, resolved once: the engine has to have named an
              // action AND it has to be pressable. A row that satisfies only
              // the first offers no exit control rather than a dead one.
              const exitAction = exitEnabled ? exitActions?.[p.protocol] : undefined;
              const Chevron = open ? ChevronDown : ChevronRight;
              return (
                <React.Fragment key={key}>
                  <tr
                    ref={highlighted ? highlightedRow : undefined}
                    tabIndex={-1}
                    /* Emphasis, not a risk statement. The alert feed points
                       here, so the row has to be findable the moment it scrolls
                       into view - but the risk ramp is spoken for on this
                       screen by the chip at the end of the row, and a row
                       painted because it was NAVIGATED to would be the ramp
                       asserting something about danger that the score does not
                       support. Lavender is nowhere on the ramp. */
                    className={`${i > 0 ? "border-t-[3px] border-solid border-border-strong" : ""} ${
                      highlighted ? "bg-highlight" : ""
                    }`}
                  >
                    <td className={`${TD} w-11`}>
                      {/* The PROTOCOL is the disclosure control: its mark plus
                          the chevron that says the row opens, and nothing else
                          in the cell. A real button, so there is no clickable
                          `div` (no role, no focus, no keyboard) and no second
                          column of chevrons; `aria-expanded` is what tells a
                          screen reader it does something, and the tile's own
                          `label` is what names it, so the control still
                          announces as the protocol it opens.

                          `min-h-11` is 44px, the touch target this row is on a
                          phone, and it steps back to 32px from `md` where the
                          pointer is a mouse and the row is 56px by design. */}
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailId}
                        onClick={() => setOpenKey(open ? null : key)}
                        className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 md:min-h-8"
                      >
                        <Chevron className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <ProtocolLogo
                          protocol={p.protocol}
                          size="w-7 h-7"
                          label={PROTOCOL_LABEL[p.protocol]}
                        />
                      </button>
                    </td>
                    <td className={TD}>
                      {/* The row's name, in the weight a name gets. Not the mono
                          face: a ticker is what the position IS, not a quantity
                          measured about it, and the money columns beside it are
                          what mono is reserved for. */}
                      <span className="block truncate font-sans text-sm font-bold text-text-primary">
                        {marketName(p)}
                      </span>
                    </td>
                    <td className={`${TD} ${COL.collateral}`}>
                      {moneyCell(p.collateralValueUsd, unpriced)}
                    </td>
                    <td className={`${TD} ${COL.debt}`}>
                      {moneyCell(p.borrowValueUsd, unpriced)}
                    </td>
                    <td className={`${TD} ${COL.outlook}`}>
                      {/* The health factor as the price move it means, worded
                          and rounded by the engine (`liquidationOutlook`),
                          never by this file. The exact ratio opens the hover,
                          which is where every other surface keeps it. */}
                      {/* One line from `lg`, wrapping below it, and both halves
                          are measured rather than preferred.

                          Market takes the table's slack now (`w-full`), which
                          leaves this column its min-content width, so at 1440
                          "Liquidates if cbBTC falls 4.8%" came back as three
                          lines and took a 56px row to 96px - the wrap undoes
                          the scanning the table exists for at exactly the width
                          where there was room to spare. Held to one line at
                          every width instead, the column claims its max-content
                          (~200px) and the 434px card at 768 needs 577, so the
                          table starts scrolling sideways in the one band where
                          the money columns are still down.

                          `lg` is where the card is 500px and both are true at
                          once. */}
                      <span
                        className="cursor-help font-sans text-sm text-text-secondary"
                        title={outlook.hover}
                      >
                        {outlook.sentence}
                      </span>
                    </td>
                    <td className={`${TD} w-px`}>
                      <RiskChip band={p.band}>{BAND_WORD[p.band]}</RiskChip>
                    </td>
                  </tr>

                  {open && (
                    <tr id={detailId} className="border-t border-border-subtle">
                      <td colSpan={6} className="px-4 pt-3 pb-4">
                        <div className="flex flex-wrap items-start gap-4">
                          <RiskDial
                            score={p.total}
                            band={p.band}
                            subScores={p.subScores}
                          />
                          <div className="min-w-0 flex-1 space-y-2">
                            {/* The columns this width could not show, so the
                                disclosure is a complete reading of the position
                                at every viewport rather than a phone-shaped
                                subset of one. */}
                            <p className="font-sans text-sm text-text-secondary md:hidden">
                              <span className="cursor-help" title={outlook.hover}>
                                {outlook.sentence}
                              </span>
                            </p>
                            <p className="font-sans text-sm text-text-secondary xl:hidden">
                              {unpriced ? (
                                <span title={USD_UNAVAILABLE_HINT}>
                                  Collateral and debt not measured
                                </span>
                              ) : (
                                <>
                                  <span className={FIGURE}>
                                    {formatUsd(p.collateralValueUsd)}
                                  </span>{" "}
                                  collateral,{" "}
                                  <span className={FIGURE}>{formatUsd(p.borrowValueUsd)}</span>{" "}
                                  debt
                                </>
                              )}
                            </p>

                            {/* Where this position stands against the limit the
                                READER set, which is a different fact from the
                                band beside it: the band is how exposed the
                                position is in the absolute, this is whether
                                that reading has crossed the level they asked to
                                be told about. The engine sets it; no threshold
                                is invented here. */}
                            <p className="font-sans text-sm text-text-secondary">
                              {limitStateCopy(p.profileStatus)}
                            </p>

                            {/* A market-context term the engine could not read.
                                Separate from the unpriced cells above and never
                                merged with them: the two failures are
                                independent (a leg can be priced exactly and
                                still lose its asset-risk lookup), and they
                                withhold different things - that one withholds
                                the dollars, this one withholds part of the
                                score. The grey is `risk-unknown`, which is NOT
                                a band, so it spends none of the screen's risk
                                budget. */}
                            {marketContextMissing(p.subScores) && (
                              <span
                                title={MARKET_CONTEXT_MISSING_HINT}
                                className={`inline-flex cursor-help items-center gap-1.5 hard-edge px-2 py-0.5 font-sans text-xs font-semibold ${RISK_CHIP.UNKNOWN}`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {MARKET_CONTEXT_MISSING_LABEL}
                              </span>
                            )}

                            {/* A row whose figures came from a simulated price.
                                PER ROW, not per screen: a scenario names
                                assets, so one position can be simulated while
                                the one under it is real. Deliberately NOT
                                merged with the marker above: that one says "we
                                could not measure this", this one says "we
                                measured this against a price we invented", and
                                a simulated figure is exact arithmetic on a
                                stated price. */}
                            {p.simulation && <SimulationChip />}

                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              {/* The way out, offered ONLY where it can fire.
                                  Three facts hold and none of them is this
                                  component's to decide: the engine named an
                                  action for this protocol, the caller passed a
                                  handler for a wallet a connected key can sign
                                  for, and the selected chain can settle it.
                                  When they do not hold there is no button, not
                                  a greyed one. */}
                              {exitAction && (
                                <Button onClick={() => onExit?.(exitAction.prefill)}>
                                  {exitAction.label}
                                  <ArrowRight className="h-4 w-4" />
                                </Button>
                              )}
                              {onStressTest && (
                                <Button variant="secondary" onClick={() => onStressTest(p)}>
                                  <Eye className="h-4 w-4" />
                                  Stress-test
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      {/* The table's footer line. The sort order is the one thing about this
          list a reader cannot see by looking at it, and the chain badge is here
          rather than beside the heading because which network was read is a
          property of the whole table. Neutral, never the risk ramp: a chain is
          not a band. */}
      {rows !== null && rows.length > 0 && (
        <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-t-[3px] border-solid border-border-strong px-4">
          <span className="label-type text-xs text-text-muted">Sorted by risk, worst first</span>
          {provenance.badge && <Chip>{provenance.badge}</Chip>}
        </div>
      )}
    </Card>
  );
}
