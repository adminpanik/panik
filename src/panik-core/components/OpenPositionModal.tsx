/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DEMO-ONLY position-opening flow (business-dev QA request 2026-07-03).
 * No wallet signing and no transaction ever leaves the browser - it simulates
 * the deposit-and-borrow UX end to end (configure, submit, confirm) so the
 * full "open a position from PANIK" journey can be walked in demos. Every
 * screen carries an explicit DEMO marker.
 *
 * It is `OpenFlow`'s screen, deliberately, down to the header band, the two
 * `lg` fields, the two-cell strip under them and the single full-width button.
 * The two modals are the same moment in the product reached by two routes: one
 * signs and one does not, and a reader who has met one should not have to learn
 * the other. What differs is the chip in the header and the fact that nothing
 * here leaves the browser.
 *
 * WHAT WENT with the restyle. Four deposit preset plates and a percent slider,
 * which were three controls for one number the field now takes directly. The
 * APY line, which was the market's yield restated inside a sizing dialog and
 * was the one green figure on the screen. Every explanatory sentence: "Demo
 * flow - nothing is signed and no funds move" is the chip's hover, and the
 * loan-to-value note is only rendered where there is no ceiling to state.
 *
 * The ENGINE CALLS are untouched: `assetLoanToValue` for this asset's ceiling
 * on this protocol, `estimateHealthFactor` for the projection, and
 * `liquidationOutlook` for the price drop it means. No health-factor arithmetic
 * is written in this file.
 */

import { useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import {
  assetLoanToValue,
  BAND_WORD,
  bandOfHealthFactor,
  formatCurrency,
  liquidationOutlook,
  LOAN_TO_VALUE_UNAVAILABLE_HINT,
  LOAN_TO_VALUE_UNAVAILABLE_LABEL,
  RISK_CHIP,
} from "../lib/utils";
import { estimateHealthFactor } from "../../../packages/scoring/src/prospective";
import { Button, Chip, Field, LAYER, Notice, SCRIM } from "../ui";

export interface OpenPositionTarget {
  protocol: "Aave V3" | "Moonwell" | "Morpho" | "Compound V3";
  assetPair: string;
  collateralAsset: string;
  debtAsset: string;
  baseRisk: number;
  /** Supply APY shown in the projection (live pool APY where available). */
  apy: number;
  customCollateralUsd?: number;
  customBorrowPct?: number;
}

/** The share of the deposit a market opens borrowed at when nothing says otherwise. */
const DEFAULT_BORROW_PCT = 40;

function fakeTxHash(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function OpenPositionModal(props: { target: OpenPositionTarget; onClose: () => void }) {
  const { target, onClose } = props;
  const [depositUsd, setDepositUsd] = useState(() => Math.round(target.customCollateralUsd ?? 5_000));
  const [phase, setPhase] = useState<"config" | "submitting" | "done">("config");
  const [txHash, setTxHash] = useState("");

  /**
   * The engine's parameters for THIS collateral on THIS protocol, so the
   * ceiling and the figures beside it move with the asset (issue #61). Null
   * when `MARKETS` lists no such pair, and every consumer below branches on
   * that rather than substituting a number.
   */
  const ltv = assetLoanToValue(target.protocol, target.collateralAsset);

  /**
   * The borrow is a DOLLAR amount now rather than a percentage, because the
   * field asks for one and a field that took a percent would be a second unit
   * beside a deposit in dollars. The seed still comes from the percentage the
   * Watch simulator hands over, which is the only thing that ever set it.
   */
  const [borrowUsd, setBorrowUsd] = useState(() =>
    Math.round((Math.round(target.customCollateralUsd ?? 5_000) *
      (target.customBorrowPct ?? DEFAULT_BORROW_PCT)) / 100),
  );

  /**
   * The ceiling in dollars, and the borrow actually offered against it.
   *
   * Clamped at render rather than only on input, exactly as the percentage was:
   * `customBorrowPct` arrives from the Watch simulator and can sit above the
   * ceiling of a different asset, and editing the DEPOSIT down moves the
   * ceiling under an amount that was legal when it was typed. No ceiling means
   * no borrow at all, which is the one honest answer when the engine lists no
   * limit to size one against.
   */
  const borrowCap = ltv === null ? 0 : Math.round((depositUsd * ltv.ceilingPct) / 100);
  const borrowOffered = Math.min(borrowUsd, borrowCap);
  // The engine's formula and the engine's threshold. Health factor is measured
  // against the LIQUIDATION threshold, never the borrow limit, and the drop is
  // `drawdownToLiquidation` inside `liquidationOutlook` rather than a second
  // copy of 1 - 1/HF written here.
  const estHf =
    ltv === null ? null : estimateHealthFactor(depositUsd, borrowOffered, ltv.liquidationPct / 100);
  const outlook = liquidationOutlook(estHf, target.collateralAsset);
  // `null` is "no debt", which is a measured state and not an unknown one, so
  // it takes no band and no hue. `RISK_CHIP` stays the only place a band
  // becomes pixels.
  const band = estHf === null ? null : bandOfHealthFactor(estHf);

  const submit = () => {
    setTxHash(fakeTxHash());
    setPhase("submitting");
    window.setTimeout(() => setPhase("done"), 2_200);
  };

  return (
    <div className={`fixed inset-0 ${LAYER.modal} flex items-center justify-center p-4`}>
      {/* The app's one scrim, from `ui/overlay`. Dismissing mid-submit would
          leave the simulated sequence running behind a closed dialog. */}
      <div className={`absolute inset-0 ${SCRIM}`} onClick={phase === "config" ? onClose : undefined} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto hard-edge shadow-hard bg-surface-raised">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b-[3px] border-solid border-border-strong px-6 py-5">
          {/* "OPEN <asset> ON <protocol>". `target.protocol` is already the
              display label the catalog carries, so nothing here renames a
              protocol. The TICKER is exempted from the heading's uppercase:
              this product writes cbETH and cbBTC the way their issuers do, and
              a heading that shouts CBETH has renamed the asset. */}
          <h2 className="min-w-0 truncate font-sans text-lg font-black uppercase tracking-[0.02em] text-text-primary">
            Open <span className="normal-case">{target.collateralAsset}</span> on {target.protocol}
          </h2>
          <div className="flex shrink-0 items-center gap-3.5">
            {/* What kind of money this moves, in one word, where `OpenFlow`
                says "Real funds" or "Test assets". The sentence that used to
                sit under the button is this chip's hover. */}
            <Chip title="Nothing is signed and no funds move.">Demo</Chip>
            {phase !== "submitting" && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="shrink-0 cursor-pointer text-text-secondary hover:text-text-primary"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {phase !== "done" ? (
          <>
            <div className="flex flex-col gap-4 p-6">
              <Field
                size="lg"
                mono
                label="Deposit, USD"
                type="number"
                min={0}
                step={100}
                value={depositUsd}
                onChange={(e) => setDepositUsd(Math.max(0, Number(e.target.value)))}
                disabled={phase === "submitting"}
              />
              {ltv === null ? (
                /* No listing, so no ceiling. Stating that is the only honest
                   option: sizing a borrow needs a maximum, and every maximum
                   available here would be one this build invented. */
                <Notice text={`${LOAN_TO_VALUE_UNAVAILABLE_LABEL}. ${LOAN_TO_VALUE_UNAVAILABLE_HINT}`} />
              ) : (
                <Field
                  size="lg"
                  mono
                  label={`Borrow, ${target.debtAsset}`}
                  type="number"
                  min={0}
                  /* The engine's borrow limit less its margin, in dollars. A
                     whole-dollar max rather than a stepped one: the ceiling
                     lands on 76 / 71 / 82 / 74 percent of the deposit and a
                     rounded step could not reach the figure it names. */
                  max={borrowCap}
                  value={borrowOffered}
                  onChange={(e) =>
                    setBorrowUsd(Math.min(borrowCap, Math.max(0, Number(e.target.value))))
                  }
                  disabled={phase === "submitting"}
                />
              )}
            </div>

            {/* What this sizing produces: the projected health as the one
                coloured block this modal spends, and the price drop that band
                means, straight out of `liquidationOutlook` rather than a second
                copy of the health-factor math. */}
            <div className="grid grid-cols-[200px_minmax(0,1fr)] sm:grid-cols-[240px_minmax(0,1fr)] border-y-[3px] border-solid border-border-strong">
              <div
                className={`flex flex-col justify-center gap-1 border-r-[3px] border-solid border-border-strong px-6 py-4 ${
                  band === null ? "" : RISK_CHIP[band]
                }`}
              >
                <span className="label-type text-xs">Projected health</span>
                {band === null || estHf === null ? (
                  <span className="font-sans text-lg leading-snug text-text-primary">No debt</span>
                ) : (
                  <div className="flex items-baseline gap-2.5">
                    <span className="font-mono text-stat font-bold">{estHf.toFixed(2)}</span>
                    <span className="label-type text-xs">{BAND_WORD[band]}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-col justify-center gap-1 px-6 py-4">
                <span className="label-type text-xs text-text-muted">Liquidates if</span>
                {/* The engine's own fields, never its prose re-parsed: `strip`
                    is the already-rounded percentage it computed, so the one
                    span set in mono here is a verbatim copy. The no-debt and
                    liquidatable-now cases have no percentage to lift out, so
                    they render the engine's sentence whole. */}
                {outlook.stripNote === null ? (
                  <span className="font-sans text-lg leading-snug text-text-primary">
                    {target.collateralAsset} falls{" "}
                    <span className="font-mono font-bold">{outlook.strip}</span>
                  </span>
                ) : (
                  <span className="font-sans text-lg leading-snug text-text-primary">
                    {outlook.sentence}
                  </span>
                )}
              </div>
            </div>

            <div className="p-6">
              <Button
                size="lg"
                className="w-full"
                onClick={submit}
                disabled={phase === "submitting" || depositUsd <= 0}
              >
                {phase === "submitting" ? "Simulating..." : "Open position"}
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-3">
              {/* Black, not the LOW band: an open that landed is news about a
                  transaction, and the risk ramp is what a position is in. */}
              <CheckCircle2 className="h-6 w-6 shrink-0 text-text-primary" aria-hidden="true" />
              <h3 className="font-sans text-lg font-black uppercase tracking-tight text-text-primary">
                Position opened, simulated
              </h3>
            </div>
            {/* The one sentence left, and it is the amounts the simulated legs
                carried rather than a description of the flow. */}
            <p className="font-sans text-sm leading-relaxed text-text-secondary">
              {formatCurrency(depositUsd)} of {target.collateralAsset} supplied
              {borrowOffered > 0 && (
                <>
                  {" "}
                  and {formatCurrency(borrowOffered)} {target.debtAsset} borrowed
                </>
              )}{" "}
              on {target.protocol}.
            </p>
            <div className="hard-edge bg-surface-sunken px-3 py-2 font-mono text-xs break-all select-all text-text-secondary">
              {txHash}
            </div>
            <Button variant="secondary" className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
