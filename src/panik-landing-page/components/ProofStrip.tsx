/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Card } from "../../panik-core/ui";
/**
 * `MARKETS` deep-imported straight from the engine, not the package barrel:
 * `markets.ts` imports only `type Protocol`, so this is safe to reach a
 * browser bundle (see the barrel warning on `packages/scoring/src/index.ts`
 * and the same deep-import discipline `AppDemo.tsx` follows). Two REAL counts
 * come off this one table instead of being retyped as constants that could
 * drift from the engine that actually holds the list.
 */
import { MARKETS } from "../../../packages/scoring/src/markets";

/** One row per lending protocol the engine has a market table for. */
const PROTOCOLS_COVERED = Object.keys(MARKETS).length;
/** Every distinct collateral symbol across every protocol's table, deduped. */
const ASSETS_PRICED = new Set(Object.values(MARKETS).flatMap((market) => Object.keys(market))).size;

/**
 * The holdout recall is NOT wired to a runtime export: it lives in
 * `docs/technical-docs/BACKTEST_RESULTS.md` ("Re-measured 2026-08-25, with a
 * calibration/holdout split"), a report, not a constant the engine returns.
 * It is hardcoded here on the same terms `PROTOCOL_SAFETY` hardcodes its
 * scores in `packages/scoring/src/subscores/protocolSafety.ts` — a real,
 * cited number that has to be updated by hand when the report is.
 *
 * The pooled HOLDOUT row, not the pooled "all offline" or the superseded
 * multi-event row: 1,494 liquidated + 491 surviving positions across the USDC
 * depeg (Mar 2023) and the Aug-2024 Base unwind, both of which postdate every
 * threshold `CRASH_REGIME` (packages/scoring/src/params.ts) was calibrated on.
 * The report calls this row "the honest headline" for exactly that reason.
 */
const BACKTEST_RECALL = "92%";
const BACKTEST_FALSE_ALARM = "26% false-alarm rate, holdout split";

const FIGURES = [
  { label: "Lending markets covered on Base", value: String(PROTOCOLS_COVERED) },
  { label: "Collateral assets priced by the engine", value: String(ASSETS_PRICED) },
  { label: "Doomed positions flagged in backtesting", value: BACKTEST_RECALL, caption: BACKTEST_FALSE_ALARM },
];

export function ProofStrip() {
  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-16 md:px-16 lg:py-24">
      <div className="grid gap-6 md:grid-cols-3">
        {FIGURES.map((figure) => (
          <Card key={figure.label} tone="raised" className="flex flex-col justify-between gap-2">
            <span className="label-type text-xs text-text-secondary">{figure.label}</span>
            <span className="font-mono text-2xl font-bold tracking-tight break-words text-text-primary">
              {figure.value}
            </span>
            {figure.caption && (
              <span className="font-mono text-xs text-text-secondary">{figure.caption}</span>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
