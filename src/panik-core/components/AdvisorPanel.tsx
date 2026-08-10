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
 * The SEVERITY does spend one, on purpose. An EXIT leg is a critical position
 * and a dial alone was not saying so loudly enough, so those two card types
 * carry a `RiskChip` on their identity line. That is the ramp measuring a
 * position, which is what it is for, and it is the opposite of painting a verb.
 * It is rationed to them: a WATCH or HOLD leg has no urgency to signal.
 *
 * The ways out are a LEAD plus footnotes, never a comparison. Two columns of
 * prose, one of them describing a route the app cannot sign, is the shape that
 * made this block unreadable; see `routesFor`.
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
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
  LiveProtocol,
} from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import {
  ADVISOR_ACTION,
  AI_PROSE_NOTE,
  BAND_LABEL,
  formatUsd,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  RISK_CHIP,
  RISK_TEXT,
  USD_UNAVAILABLE_HINT,
  USD_UNAVAILABLE_LABEL,
} from "../lib/utils";
import { Button, Card, EmptyState, RiskChip, RiskDial } from "../ui";
import { EXIT_ENV } from "../lib/exit";
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

const PROTOCOL_LABEL: Record<LiveProtocol, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

/**
 * The action, as a chip, in NEUTRAL ink, on the cards that have no button.
 *
 * It used to be painted off the risk ramp: EXIT red, REDUCE orange, HOLD green,
 * plus a sky blue and a violet for MONITOR and REBALANCE. Two problems. An
 * action is not a risk band - HOLD in risk-low green is the ramp making a
 * safety claim about a verb - and the genuine band was already on the same
 * card, in the strip, which meant a HIGH position could show a green chip and
 * an orange band six inches apart.
 *
 * The band now has exactly one home per card: the RiskDial, borrowed from the
 * Portfolio position rows so a score means the same thing on both screens.
 *
 * The chip is now WATCH, HOLD and MOVE only. On an EXIT or a REDUCE leg it said
 * the verb the primary button says two inches below it, which is a duplicate
 * that also flattens the two: the loudest statement of a call to action should
 * not be a 11px pill in the prose column. Cards that are not a call to action
 * keep it, because there it is the only place the verdict is stated, and it
 * stays quiet because "watch this" is not something to do today.
 */
const ACTION_CHIP =
  "inline-flex shrink-0 rounded-sm border border-border-subtle bg-white/[0.06] px-2 py-0.5 text-2xs font-sans font-bold text-text-primary";

/**
 * The two costs this screen genuinely does not know, behind `Details`.
 *
 * Gas comes from the simulation the exit flow runs against the real position and
 * the price floor is read from the deployed swap config, so neither exists until
 * a wallet is connected. Naming them is the only honest option, because a
 * plausible-looking estimate here would be a number the code never had. What it
 * is not is something to read before deciding, which is why it moved off the
 * face of the card and into the disclosure with the rest of the second-order
 * explanation.
 */
const GAS_CAVEAT =
  "Gas is estimated at signing. The price floor for anything sold is shown at the same point.";

/**
 * What the card says about a collateral-funded repay it cannot yet perform.
 *
 * The sizing is true and worth reading: it tells a user with none of the debt
 * asset that a route exists and what it would cost. What the app must not do is
 * imply they can take it today, so the sentence names the gap rather than the
 * card quietly offering a dead button. It disappears on its own the moment
 * `DELEVERAGE_EXECUTABLE_PROTOCOLS` names a chain.
 */
const DELEVERAGE_NOT_LIVE = "This route is not available to sign yet.";

function ActionButton({
  rec,
  onExit,
  onOpen,
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  if (rec.action === "EXIT" || rec.action === "REDUCE") {
    const prefill = rec.exitPrefill ?? { protocol: rec.protocol, kind: "full" as const };
    const label = rec.action === "EXIT" ? "Execute exit" : "Reduce position";
    const disabledHint = "Transaction flow ships with the Atomic Exit integration";
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* The `Button` primitive, which by design does not accept a risk band:
            these were a red fill and an orange fill, so the loudest element on
            the card was the control rather than the reading it acts on. The size
            step is what replaces that loudness legitimately - a 14px label on a
            near-white plate at 18.1:1, alone on the card's last row, against a
            12px `Details` beneath it. */}
        <Button
          size="lg"
          onClick={onExit ? () => onExit(prefill) : undefined}
          disabled={!onExit}
          title={onExit ? undefined : disabledHint}
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
            variant="quiet"
            onClick={
              onExit ? () => onExit({ protocol: rec.protocol, kind: "full_repay" }) : undefined
            }
            disabled={!onExit}
            title={onExit ? undefined : disabledHint}
          >
            Repay everything instead
          </Button>
        ) : null}
      </div>
    );
  }
  if (rec.action === "OPEN" && rec.openPlan) {
    const plan = rec.openPlan;
    return (
      <Button onClick={onOpen ? () => onOpen(plan) : undefined} disabled={!onOpen}
        title={onOpen ? undefined : "In-app opening ships with the position flows"}>
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
 * A native `<details>`: it is focusable, it is announced as expandable, it
 * works with no JavaScript and it costs no dependency. `list-none` plus the
 * webkit marker reset removes the browser's own triangle, so the chevron is
 * the only marker and it is the one that rotates.
 *
 * Labelled `Details`, not `Why this`. It holds the position, the market, the
 * execution notes and the gas caveat, and "why this" claimed only the first of
 * those while reading as a question the card had failed to answer above.
 */
function Reasoning({ rec, notes = [] }: { rec: AdvisorRecommendation; notes?: string[] }) {
  const rows: [string, string][] = [
    ["Position", rec.sections.position],
    ["Market", rec.sections.market],
    ["Execution", rec.sections.execution],
  ];
  const body = (
    <div className="space-y-2.5">
      {rows.map(([label, text]) => (
        <div key={label} className="flex flex-col sm:flex-row sm:gap-4">
          <span className="w-28 shrink-0 pt-0.5 text-xs font-sans text-text-muted">{label}</span>
          <p className="flex-1 text-sm font-sans leading-relaxed text-text-secondary">{text}</p>
        </div>
      ))}
    </div>
  );
  return (
    <details className="group min-w-0">
      {/* `inline-flex`, so the hit area is the width of the words rather than
          the width of the card: this is the quiet half of the last row and a
          full-bleed target reads as a second control. `min-h-6` keeps it at the
          24px floor for a tap target (WCAG 2.5.8) at 12px type. */}
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 text-xs font-sans font-semibold text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Details
      </summary>
      <div className="mt-3 space-y-2.5">
        {body}
        {notes.map((note) => (
          <p key={note} className="text-xs font-sans tabular-nums text-text-muted">
            {note}
          </p>
        ))}
      </div>
    </details>
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
   * The asset is not repeated in the value — the card names it as the subtitle
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
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
      {items.map(({ label, value, hint }) => (
        <div className="flex items-baseline gap-2" key={label}>
          <span className="flex items-center gap-1 text-xs font-sans text-text-muted">
            {label}
            {hint && <InfoTip text={hint} />}
          </span>
          <span className="whitespace-nowrap text-sm font-sans font-semibold tabular-nums text-text-primary">
            {value}
          </span>
        </div>
      ))}
      {/* Stands IN for the two money pairs rather than qualifying them, and it
          takes its treatment from `RISK_CHIP.UNKNOWN` - unfilled, dashed edge,
          icon and words - so it is the same marker, in the same shape, as the
          one the position rows already show for this state. Distinctness from a
          priced leg holds on four axes and no branch of it can emit "$0". */}
      {usdUnknown && (
        <span
          title={USD_UNAVAILABLE_HINT}
          className={`inline-flex cursor-help items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {USD_UNAVAILABLE_LABEL}
        </span>
      )}
      {/* A second, independent caveat: this one is about the SCORE on the rail,
          not the dollars. It is stated because the dial prints a real number
          either way — the composite renormalises over what was measured — and a
          reader has no way to tell a fully-measured 75 from a partly-measured
          one unless the card says so. `title`, not an InfoTip: this strip
          already wraps, and the tip's anchor cannot. */}
      {marketContextMissing(n.subScores) && (
        <span
          title={MARKET_CONTEXT_MISSING_HINT}
          className={`inline-flex cursor-help items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-sans font-semibold ${RISK_CHIP.UNKNOWN}`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {MARKET_CONTEXT_MISSING_LABEL}
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
    lead = {
      cost: `Repays ${fmtUsd(reduce.repayUsd)}${reduce.repayAssetSymbol ? ` of ${reduce.repayAssetSymbol}` : ""} from your wallet. Nothing is sold.`,
      protection: `${outlook.sentence}. Your collateral stays deposited.`,
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
      // The repay is the figure the engine sized; the collateral sold is that
      // plus the fees, which is why the line names the repay and says the
      // collateral funds it rather than quoting a sale amount nothing computed.
      line:
        `Or fund it from your collateral: repays ${fmtUsd(collateralFunded.repayUsd)}` +
        `${collateralFunded.repayAssetSymbol ? ` of ${collateralFunded.repayAssetSymbol}` : ""}` +
        ` by selling part of your ${symbol}, with nothing needed in your wallet` +
        // A second sentence rather than a clause when the protections differ:
        // `outlook.sentence` opens with a capital and carries an asset symbol,
        // so it cannot be lowercased into the middle of one.
        `${sameProtection ? ", for the same protection." : `. ${outlook.sentence}.`}` +
        // The honesty gate, on the same line as the offer rather than under it.
        // The contract that performs this is not deployed on any chain the app
        // talks to, so the card explains the option and says plainly that it
        // cannot be signed yet. It gets no button anywhere: offering a control
        // for something the code cannot do is the exact failure "never state a
        // fact the code does not know" exists to stop.
        (isDeleverageExecutable(rec.protocol) ? "" : ` ${DELEVERAGE_NOT_LIVE}`),
      // The three costs this route pays and the wallet-funded one does not.
      // Kept, because they are money the user would spend, and moved into
      // `Details` because they describe a route the card is not recommending.
      // Gas is units: a dollar figure needs a live gas price and an ETH price
      // the app does not hold here.
      costs: costs
        ? `Funding the repay from your collateral costs ${fmtBps(costs.flashFeeBps)} to borrow` +
          ` the funds, up to ${fmtBps(costs.slippageBps)} of the sale price, and about` +
          ` ${fmtGasUnits(costs.gasUnits)} gas.`
        : undefined,
    });
  }

  // Executable, and it has its own `quiet` button below, so one line describing
  // it is the same weight the control it belongs to already carries.
  if (rec.alternative) {
    const plan = rec.alternative.plan;
    alternates.push({
      key: "full_repay",
      line: `Or repay everything instead: ${fmtUsd(plan.repayUsd)}${plan.repayAssetSymbol ? ` of ${plan.repayAssetSymbol}` : ""} from your wallet, nothing sold, and your collateral stays deposited.`,
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
}: {
  rec: AdvisorRecommendation;
  onExit?: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  const routes = routesFor(rec);
  /**
   * Whether this card offers a control, which is also whether the action chip
   * would be repeating a button label. `ActionButton` renders nothing for
   * WATCH, HOLD and MOVE, and nothing for an OPEN with no plan attached.
   */
  const hasAction =
    rec.action === "EXIT" || rec.action === "REDUCE" || (rec.action === "OPEN" && !!rec.openPlan);
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
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="shrink-0 text-sm font-sans font-bold text-text-primary">
              {PROTOCOL_LABEL[rec.protocol]}
            </h4>
            <span className="truncate text-xs font-sans text-text-secondary">
              {rec.numbers.scoredCollateralSymbol}
            </span>
            {/* The severity of the POSITION, on the line that identifies the
                position. This is the ramp doing the job it exists for, and it
                is not the thing the ramp is forbidden to do: a band is a
                measurement, whereas painting `Execute exit` red would be the
                ramp making a claim about an ACTION.

                It is deliberately not fused to the button and not on the rail.
                On the identity line it reads as "this Aave V3 cbBTC position is
                critical", and the row already wraps, so at 390 the chip drops to
                its own line instead of squeezing the prose column.

                Rationed to the legs with something worth doing about them. A
                WATCH or a HOLD leg gets no chip: its dial already says the
                score, and a card whose advice is "nothing today" has no urgency
                to signal. That is +2 hued elements on this screen, 5 to 7,
                spent on the two cards where severity is the point. */}
            {urgent ? (
              <RiskChip band={rec.numbers.band}>{BAND_LABEL[rec.numbers.band]}</RiskChip>
            ) : null}
          </div>

          {/* The lead. On a card with a button the sentence is the whole lead
              and the verb is the button; on a card without one the chip is the
              only statement of the verdict, so it opens the block above the
              sentence that elaborates it. `ADVISOR_ACTION`, not `rec.action` -
              the raw union is an engine enum and this screen does not shout. */}
          <div className="space-y-1.5">
            {hasAction ? null : (
              <span className={ACTION_CHIP}>{ADVISOR_ACTION[rec.action]}</span>
            )}
            <p className="text-sm font-sans leading-relaxed text-text-primary">
              {rec.sections.recommendation}
            </p>
          </div>

          <NumbersStrip rec={rec} />
        </div>

        {/* The rail, matching a Portfolio position row: the score, and the one
            thing you can do about it, in the same place on both screens. */}
        <div className="flex shrink-0 flex-col items-center gap-2">
          <RiskDial score={rec.numbers.total} band={rec.numbers.band} subScores={rec.numbers.subScores} />
        </div>
      </div>

      {/* What each button on this card actually does, with its numbers. It sits
          between the reading and the controls because that is the order the
          decision is made in: here is the position, here is what each way out
          costs and leaves, here are the buttons. */}
      <Outcomes routes={routes} />

      {/* The action owns the card's last row, alone, and `Details` sits under it
          at 12px. They used to share a row, which made a 12px disclosure trigger
          and the one control on the card read as a pair of equal footer links.
          The action is the point of the card; the reasoning is available.

          Stacking them also retires the clipping arithmetic this row used to
          need. Side by side, the action block was `shrink-0` at about 270px, so
          at a 768px window (sidebar 256, column ~464) the disclosure got ~172px
          against a 204px min-content and every line of reasoning inside it was
          clipped. Full-width children cannot reproduce that at any width. */}
      <div className="space-y-3 border-t border-border-subtle pt-4">
        {hasAction ? <ActionButton rec={rec} onExit={onExit} onOpen={onOpen} /> : null}
        {/* The costs of a route the card demoted, and then the caveat that
            applies to whichever one is signed. Both are money facts about a
            transaction, which is why neither is deleted and why both sit behind
            the same one click rather than on the face of the card. */}
        <Reasoning
          rec={rec}
          notes={[
            ...routes.alternates.map((a) => a.costs).filter((c): c is string => !!c),
            ...(routes.lead ? [GAS_CAVEAT] : []),
          ]}
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
}: {
  rec: AdvisorRecommendation;
  onOpen?: (plan: AdvisorOpenPlan) => void;
}) {
  const plan = rec.openPlan;
  if (!plan) return null;
  return (
    <Card tone="raised" className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />
        <h4 className="min-w-0 flex-1 truncate text-sm font-sans font-bold text-text-primary">
          {plan.collateralSymbol} on {PROTOCOL_LABEL[rec.protocol]}
        </h4>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm font-sans tabular-nums text-text-secondary">
        <span className="whitespace-nowrap">
          <span className="font-semibold text-text-primary">{formatUsd(plan.collateralUsd)}</span>{" "}
          collateral
        </span>
        {plan.borrowUsd > 0 && (
          <span className="whitespace-nowrap">
            <span className="font-semibold text-text-primary">{formatUsd(plan.borrowUsd)}</span>{" "}
            borrow
          </span>
        )}
      </div>

      <p className="text-sm font-sans tabular-nums text-text-secondary">
        Projected score {plan.projectedScore}
        {plan.apy !== null ? `, ${(plan.apy * 100).toFixed(1)}% APY` : ""}
      </p>

      {/* Stacked, action first, the same shape as the position cards. These sit
          three across from `xl`, so the card itself is ~380px and a button beside
          the disclosure left it ~170px: the reasoning rows are a 112px label
          plus a paragraph, which is ~42px of prose and clipped at every window
          size. Breakpoints measure the window and this column does not, so the
          fix is the layout rather than a smaller type step. */}
      <div className="mt-auto flex flex-col gap-3 border-t border-border-subtle pt-3">
        <div>
          <ActionButton rec={rec} onOpen={onOpen} />
        </div>
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
 * `:focus-visible` rule, and a 24px+ target. The dashed edge is the idiom
 * `RISK_CHIP.UNKNOWN` already established for "this is not one of the filled
 * things beside it", on `border-strong` because this edge is functional rather
 * than decorative and has to hold 3:1.
 */
function SeeAllInCompass() {
  return (
    <button
      type="button"
      onClick={openCompassTab}
      className="flex h-full min-h-32 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong p-4 text-sm font-sans font-semibold text-text-secondary transition-colors hover:bg-white/[0.02] hover:text-text-primary"
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
}

export function AdvisorPanel({ report, onExit, onOpen }: AdvisorPanelProps) {
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

  return (
    <div className="space-y-6">
      {/* The verdict for the whole wallet. Container stays neutral - the icon
          is the one hued element, which is the treatment the Portfolio
          aggregate card already uses for exactly this job, and it is absent
          below `warning` because a glyph that is always there and only changes
          colour is a glyph people stop seeing. */}
      <Card tone="raised" className="flex items-start gap-3">
        {overall.urgency === "info" ? (
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        ) : (
          <AlertTriangle
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              overall.urgency === "critical" ? RISK_TEXT.CRITICAL : RISK_TEXT.ELEVATED
            }`}
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-sans leading-relaxed text-text-primary">
            {overall.headline}
            {insightsText && <InfoTip text={insightsText} className="ml-1.5" />}
          </p>
        </div>
      </Card>

      {/* Position legs */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-sm font-sans font-semibold text-text-primary">Your positions</h3>
            {/* Once, for the section, instead of a TESTNET pill beside every
                exit button on every card. The chain you are signing on is a
                property of the release, not of a position, and the flow the
                button opens states it again in its own header and banner before
                anything can be signed. */}
            {EXIT_ENV === "testnet" ? (
              <p className="text-xs font-sans text-text-muted">
                Exits run on Base Sepolia against a demo position.
              </p>
            ) : null}
          </div>
          {recommendations.map((rec) => (
            <RecommendationCard
              key={`${rec.protocol}-${rec.numbers.scoredCollateralSymbol}`}
              rec={rec}
              onExit={onExit}
              onOpen={onOpen}
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
          <h3 className="text-sm font-sans font-semibold text-text-primary">
            Opportunities within your profile
          </h3>
          {/* Three across only once the window can actually spare it: at `md`
              the sidebar has already taken 256px, so three of these cards got
              ~137px each and every title ellipsised to a couple of letters. */}
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {opportunities.slice(0, OPPORTUNITY_PREVIEW).map((rec) => (
              <OpportunityCard
                key={`${rec.protocol}-${rec.openPlan?.collateralSymbol}`}
                rec={rec}
                onOpen={onOpen}
              />
            ))}
            <SeeAllInCompass />
          </div>
        </div>
      ) : null}

      {/* The panel's one AI disclosure, at the foot, where a standing fact about
          how the page is written belongs. It replaces a marker under every block
          of prose on every card plus a banner line explaining that the markers
          exist: which sentences a model rephrased is not a thing the reader
          acts on, and the engine decides the recommendation either way. `narrated`
          is true as soon as any leg is model-phrased, so the line is present
          exactly when there is something to disclose. */}
      {report.narrated ? (
        <p className="text-xs font-sans text-text-muted">{AI_PROSE_NOTE}</p>
      ) : null}
    </div>
  );
}
