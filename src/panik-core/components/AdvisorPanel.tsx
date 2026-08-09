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
 *   - the RECOMMENDATION is the lead line, at reading size, right under the
 *     protocol it is about;
 *   - the numbers stay in the strip, where they are scannable and where the
 *     prose does not have to restate them;
 *   - POSITION, MARKET and EXECUTION move into a collapsed disclosure. A user
 *     acting on an EXIT deserves the reasoning, so nothing is deleted - it is
 *     one click, keyboard-reachable, and it is the same click for every card.
 *
 * The engine's prose is not edited here. Where it duplicates the strip that is
 * a copy problem in packages/scoring/src/advisor, out of this file's scope.
 *
 * Exit/Open CTAs are wired through optional callbacks so the panel ships
 * before the transaction flows do (undefined callback = disabled + tooltip).
 */

import React from "react";
import { AlertTriangle, ArrowRight, ChevronRight, Eye, Sparkles } from "lucide-react";
import type {
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
  LiveProtocol,
} from "../lib/live";
import { ProtocolLogo } from "./ProtocolLogo";
import { InfoTip } from "./InfoTip";
import {
  formatUsd,
  liquidationOutlook,
  MARKET_CONTEXT_MISSING_HINT,
  MARKET_CONTEXT_MISSING_LABEL,
  marketContextMissing,
  RISK_TEXT,
} from "../lib/utils";
import { Button, Card, EmptyState, RiskDial } from "../ui";
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
 * The action, as a chip, in NEUTRAL ink.
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
 */
const ACTION_CHIP =
  "shrink-0 rounded-md border border-border-subtle bg-white/[0.06] px-2.5 py-1 text-2xs font-sans font-bold text-text-primary";

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
      <div className="flex flex-col items-stretch gap-1.5">
        <span className="inline-flex items-center gap-2">
          {/* Neutral, like every other chip here. TESTNET is a statement about
              which chain you are signing on, not about how risky the position is,
              and it was spending an orange on a card whose colour budget is one
              dial. The word is the warning. */}
          {EXIT_ENV === "testnet" ? (
            <span className="rounded-sm border border-border-subtle bg-white/[0.06] px-1.5 py-0.5 text-2xs font-sans font-bold text-text-secondary">
              TESTNET
            </span>
          ) : null}
          {/* The `Button` primitive, which by design does not accept a risk band:
              these were a red fill and an orange fill, so the loudest element on
              the card was the control rather than the reading it acts on. */}
          <Button onClick={onExit ? () => onExit(prefill) : undefined} disabled={!onExit}
            title={onExit ? undefined : disabledHint}>
            {label} <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </span>
        {/* The declinable alternative. The engine still RECOMMENDS the exit, so
            the exit keeps the one primary fill on this card and this stays
            `quiet`: a second filled button would put two equal answers on a
            card whose job is to give one. It is a real control rather than a
            line of prose because the engine has a prefill for it, and the
            sentence offering it is already in the recommendation above. */}
        {rec.alternative ? (
          <Button
            variant="quiet"
            className="justify-center"
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
 * The block that holds model-phrased prose, and says so.
 *
 * The Advisor mixes two kinds of sentence on one card and they carry different
 * warranties: the numbers, the action and (on a critical leg) the verdict are
 * the engine's and are checked, while the phrasing around them came out of a
 * language model. A reader deciding whether to sign a transaction is entitled
 * to know which is which, so the AI-phrased text sits in a sunken inset under a
 * permanent label rather than reading as the same voice as the figures.
 *
 * The label is the honest part, so it is never shown over deterministic text:
 * `narrationSource` is per-leg, and a leg that fell back to engine prose gets
 * no block and no label. Saying "AI-generated summary" over a template would be
 * stating a fact the code knows to be false.
 *
 * No border, deliberately. A bordered tinted box inside a bordered tinted card
 * is chrome wrapping chrome; the surface step plus the label is the distinction.
 */
function AiBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-md bg-surface-sunken p-3">
      <p className="flex items-center gap-1 text-2xs font-sans text-text-muted">
        <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
        AI-generated summary
      </p>
      {children}
    </div>
  );
}

/** True when a leg's prose was written by the model rather than the engine. */
function isNarrated(rec: AdvisorRecommendation): boolean {
  return rec.narrationSource === "narrated";
}

/**
 * The three sections that are not the recommendation, behind one disclosure.
 *
 * A native `<details>`: it is focusable, it is announced as expandable, it
 * works with no JavaScript and it costs no dependency. `list-none` plus the
 * webkit marker reset removes the browser's own triangle, so the chevron is
 * the only marker and it is the one that rotates.
 */
function Reasoning({ rec }: { rec: AdvisorRecommendation }) {
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
    <details className="group min-w-0 flex-1">
      {/* `min-h-8.5` matches the button beside it (33.6px), so the summary text
          and the button label sit on one line whether the card is open or
          closed. Without it the summary is 16px tall and the row reads as two
          controls at two different heights. */}
      <summary className="flex min-h-8.5 cursor-pointer list-none items-center gap-1 text-xs font-sans font-semibold text-text-secondary hover:text-text-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Why this
      </summary>
      <div className="mt-3">
        {/* These three are always the model's when the leg was narrated - the
            critical-verdict template slot only protects the recommendation
            above, which is why the label belongs here and not on the card. */}
        {isNarrated(rec) ? <AiBlock>{body}</AiBlock> : body}
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
  const items: { label: string; value: string; hint?: string }[] = [
    {
      label: "Drop to liquidation",
      // This strip has no sub-line to hang `stripNote` on — it is one flex row
      // of label/value pairs — so the clause joins the value inline. It wraps
      // rather than truncating here, which is why the tile on Watch reads the
      // two fields separately and this one does not.
      value: outlook.stripNote ? `${outlook.strip}, ${outlook.stripNote}` : outlook.strip,
      hint: outlook.hover,
    },
    { label: "Collateral", value: formatUsd(n.collateralValueUsd) },
    { label: "Debt", value: formatUsd(n.borrowValueUsd) },
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      {items.map(({ label, value, hint }) => (
        <div className="flex items-baseline gap-2" key={label}>
          <span className="flex items-center gap-1 text-xs font-sans text-text-muted">
            {label}
            {hint && <InfoTip text={hint} />}
          </span>
          <span className="text-sm font-sans font-semibold tabular-nums text-text-primary">
            {value}
          </span>
        </div>
      ))}
      {/* The degraded caveat is a statement about the two dollar figures beside
          it, so it sits with them rather than as a fourth pseudo-metric. */}
      {n.usdValuesUnavailable && (
        <span className="inline-flex items-center gap-1.5 text-xs font-sans text-risk-unknown">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          USD amounts unavailable
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
          className="inline-flex cursor-help items-center gap-1.5 text-xs font-sans text-risk-unknown"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {MARKET_CONTEXT_MISSING_LABEL}
        </span>
      )}
    </div>
  );
}

/**
 * One thing the card lets the user do, priced.
 *
 * `cost` is what leaves the wallet or gets sold; `protection` is what the user
 * is left holding, led by the consequence rather than the ratio. Nothing here
 * is computed: every figure is an engine field, and the health factor becomes a
 * price drop through `liquidationOutlook`, the same helper the strip above uses.
 */
interface Outcome {
  key: string;
  title: string;
  cost: string;
  protection: string;
  /** The exact health factor, on request. */
  hint?: string;
  /**
   * A third line, for a caveat about the outcome ITSELF rather than about its
   * price or its result. Today one thing needs it: an option the app can
   * describe truthfully but cannot yet execute.
   */
  note?: string;
}

/**
 * The outcomes a card offers, in the order it offers them.
 *
 * The Advisor used to name a second action and price neither: an EXIT card
 * carried "Execute exit" and "Repay everything instead" side by side, and the
 * only way to learn what either cost was to open the modal and read a
 * simulation. Two buttons and no numbers is not a choice, it is a guess.
 *
 * A card with one action gets one entry, which is not a comparison but is still
 * the only place the card says what the action moves. A card with two gets both,
 * recommended first, matching the button order underneath.
 */
function outcomesFor(rec: AdvisorRecommendation): Outcome[] {
  const n = rec.numbers;
  const symbol = n.scoredCollateralSymbol;
  // A degraded leg has real ratios and unknown magnitudes. It names the asset
  // instead of printing the engine's "$—" into the middle of a sentence; what
  // it never does is substitute a zero.
  const debtPhrase =
    n.borrowValueUsd === null ? "your debt" : `${fmtUsd(n.borrowValueUsd)} of debt`;
  const collateralPhrase =
    n.collateralValueUsd === null
      ? `your ${symbol} collateral`
      : `${fmtUsd(n.collateralValueUsd)} of ${symbol}`;

  const out: Outcome[] = [];

  if (rec.action === "EXIT") {
    out.push({
      key: "exit",
      title: "Exit the position",
      // Both halves, because the exit is wallet-funded on the repay side too:
      // a user reading only "sells your collateral" would arrive at the modal
      // and find they also need the debt asset in hand.
      cost: `Repays ${debtPhrase} from your wallet, then sells ${collateralPhrase} for USDC.`,
      protection: "Nothing left to liquidate, and the position is closed.",
    });
  }

  const reduce = rec.action === "REDUCE" ? rec.repayPlan : undefined;
  if (reduce) {
    const outlook = liquidationOutlook(reduce.projectedHf, symbol);
    out.push({
      key: "reduce",
      title: "Repay part of the debt",
      cost: `Repays ${fmtUsd(reduce.repayUsd)}${reduce.repayAssetSymbol ? ` of ${reduce.repayAssetSymbol}` : ""} from your wallet. Nothing is sold.`,
      protection: `${outlook.sentence}. Your collateral stays deposited.`,
      hint: outlook.hover,
    });
  }

  // The same protection as the sized repay above, funded the other way. It is
  // a separate outcome and not a variant of one, because it asks the user for
  // something different: nothing. The engine emits both plans because it cannot
  // see a wallet balance, so this card's job is to name what each one needs.
  const collateralFunded = rec.collateralFundedAlternative;
  if (collateralFunded) {
    const outlook = liquidationOutlook(collateralFunded.projectedHf, symbol);
    const costs = collateralFunded.costs;
    out.push({
      key: "collateral_funded",
      title: "Repay from your collateral",
      // The repay is the figure the engine sized; the collateral sold is that
      // plus the fees below it, which is why the sentence names the repay and
      // says the collateral funds it rather than quoting a sale amount the
      // engine never computed.
      cost:
        `Repays ${fmtUsd(collateralFunded.repayUsd)}` +
        `${collateralFunded.repayAssetSymbol ? ` of ${collateralFunded.repayAssetSymbol}` : ""} ` +
        `by selling part of your ${symbol}. You need nothing in your wallet.`,
      protection: `${outlook.sentence}. The rest of your collateral stays deposited.`,
      hint: outlook.hover,
      // The three costs this route pays and the wallet-funded one does not,
      // stated before anything is signed. Gas is units, because a dollar figure
      // needs a live gas price and ETH price the app does not hold here, and the
      // block already tells the user where gas is priced.
      note: [
        costs
          ? `Costs ${fmtBps(costs.flashFeeBps)} to borrow the funds, up to ${fmtBps(costs.slippageBps)} of the sale price, and about ${fmtGasUnits(costs.gasUnits)} gas.`
          : null,
        // The honesty gate. The contract that performs this is not deployed on
        // any chain the app talks to, so the card explains the option and says
        // plainly that it cannot be signed yet. It gets no button anywhere:
        // offering a control for something the code cannot do is the exact
        // failure "never state a fact the code does not know" exists to stop.
        isDeleverageExecutable(rec.protocol) ? null : DELEVERAGE_NOT_LIVE,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  if (rec.alternative) {
    out.push({
      key: "full_repay",
      title: "Repay everything",
      cost: `Repays ${fmtUsd(rec.alternative.plan.repayUsd)}${rec.alternative.plan.repayAssetSymbol ? ` of ${rec.alternative.plan.repayAssetSymbol}` : ""} from your wallet. Nothing is sold.`,
      protection: "Nothing left to liquidate, and your collateral stays deposited.",
    });
  }

  return out;
}

/**
 * Both answers, priced, before anything is signed.
 *
 * Two columns only from `lg`. The arithmetic the design system asks for: at a
 * 1024px window the sidebar takes 256px and the page padding another ~48, so
 * this block sits in ~700px and each column gets ~330. At `md` (768px window)
 * the same block is ~450px wide and two columns would be 210 each, which is
 * where a sentence starts breaking one word per line.
 */
function Outcomes({ rec }: { rec: AdvisorRecommendation }) {
  const outcomes = outcomesFor(rec);
  if (outcomes.length === 0) return null;
  return (
    <div
      className={`grid gap-x-8 gap-y-4 border-t border-border-subtle pt-3 ${
        outcomes.length > 1 ? "lg:grid-cols-2" : ""
      }`}
    >
      {outcomes.map((o) => (
        <div key={o.key} className="min-w-0 space-y-1">
          <p className="text-xs font-sans font-semibold text-text-primary">{o.title}</p>
          <p className="text-sm font-sans leading-relaxed tabular-nums text-text-secondary">
            {o.cost}
          </p>
          <p className="text-sm font-sans leading-relaxed tabular-nums text-text-secondary">
            {o.protection}
            {o.hint ? <InfoTip text={o.hint} className="ml-1" /> : null}
          </p>
          {/* Muted and one step down, because it qualifies the outcome rather
              than describing it: the reader has already had the answer in the
              two lines above. Same size as the block's own gas footnote. */}
          {o.note ? <p className="text-xs font-sans text-text-muted">{o.note}</p> : null}
        </div>
      ))}
      {/* The two costs this screen genuinely does not know. Gas comes from the
          simulation the exit flow runs against the real position, and the price
          floor for anything sold is read from the deployed swap config, so
          neither exists until a wallet is connected. Naming them is the only
          honest option: a plausible-looking estimate here would be a number the
          code never had. */}
      <p className={`text-xs font-sans text-text-muted ${outcomes.length > 1 ? "lg:col-span-2" : ""}`}>
        Gas is estimated at signing. The price floor for anything sold is shown at the same
        point.
      </p>
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
  const action = <ActionButton rec={rec} onExit={onExit} onOpen={onOpen} />;
  const aiLead = isNarrated(rec) && rec.urgency !== "critical";
  return (
    /* `Card`, so the container does not tint by state. The border used to turn
       risk-critical on an EXIT leg, which is a whole box painted with a band -
       exactly what the primitive exists to prevent, and it doubled the red the
       dial inside it was already spending. */
    <Card tone="raised" className="space-y-4">
      <div className="flex items-start gap-3">
        <ProtocolLogo protocol={PROTOCOL_LABEL[rec.protocol]} size="w-8 h-8" />

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="shrink-0 text-sm font-sans font-bold text-text-primary">
              {PROTOCOL_LABEL[rec.protocol]}
            </h4>
            <span className="truncate text-xs font-sans text-text-secondary">
              {rec.numbers.scoredCollateralSymbol}
            </span>
            <span className={`ml-auto ${ACTION_CHIP}`}>{rec.action}</span>
          </div>

          {/* The lead. This is the answer the page exists to give, so it is the
              first thing under the name of the thing it is about, at reading
              size, in primary ink. It was the third of four paragraphs.

              It only enters the AI block when a model actually wrote it. On a
              critical leg the server serves the ENGINE's verdict sentence even
              when the rest of the leg is narrated (the template slot in
              AdvisorNarrator), so the loudest instruction on the screen keeps
              normal styling and carries no AI label. */}
          {aiLead ? (
            <AiBlock>
              <p className="text-sm font-sans leading-relaxed text-text-primary">
                {rec.sections.recommendation}
              </p>
            </AiBlock>
          ) : (
            <p className="text-sm font-sans leading-relaxed text-text-primary">
              {rec.sections.recommendation}
            </p>
          )}

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
      <Outcomes rec={rec} />

      {/* The disclosure and the action share one row, so a collapsed card ends
          in a single line rather than a summary, a gap and a button. Open, the
          reasoning grows underneath and the button stays where it was. */}
      <div className="flex items-start justify-between gap-4 border-t border-border-subtle pt-3">
        <Reasoning rec={rec} />
        {action && <div className="shrink-0">{action}</div>}
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

      <div className="mt-auto flex items-start justify-between gap-4 border-t border-border-subtle pt-3">
        <Reasoning rec={rec} />
        <div className="shrink-0">
          <ActionButton rec={rec} onOpen={onOpen} />
        </div>
      </div>
    </Card>
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
          {/* Stays on screen: this one is a disclosure about who wrote the
              sentences, not a metric. */}
          {report.narrated ? (
            <p className="mt-1 flex items-center gap-1 text-2xs font-sans text-text-muted">
              <Sparkles className="h-3 w-3" aria-hidden="true" /> AI-narrated, engine-decided
            </p>
          ) : null}
        </div>
      </Card>

      {/* Position legs */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          <h3 className="text-sm font-sans font-semibold text-text-primary">Your positions</h3>
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
            {opportunities.map((rec) => (
              <OpportunityCard
                key={`${rec.protocol}-${rec.openPlan?.collateralSymbol}`}
                rec={rec}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
