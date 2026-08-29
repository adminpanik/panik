/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Card } from "../../panik-core/ui";
/**
 * The brand-mark tile, from `panik-core` rather than a landing-only copy.
 * Safe to reach this bundle: the component imports only React, so unlike the
 * scoring package's barrel (which pulls viem) there is nothing here that
 * cannot ship to a browser. `Card` above is the same cross-import already.
 */
import { ProtocolLogo } from "../../panik-core/components/ProtocolLogo";
/**
 * `MARKETS` deep-imported straight from the engine, not the package barrel:
 * `markets.ts` imports only `type Protocol`, so this is safe to reach a
 * browser bundle (see the barrel warning on `packages/scoring/src/index.ts`
 * and the same deep-import discipline `AppDemo.tsx` follows). Both rows below
 * are read off this one table rather than retyped as a list that could drift
 * from the engine that actually holds it.
 */
import { MARKETS } from "../../../packages/scoring/src/markets";
/**
 * Display names for the same four keys, from the engine on the same deep-
 * import terms: `fallback.ts` imports only `prospective.ts` (no imports of
 * its own) and a type-only file, so it carries nothing unsafe either.
 */
import { PROTOCOL_LABEL } from "../../../packages/scoring/src/advisor/fallback";

/** One key per lending protocol the engine has a market table for. */
const PROTOCOL_KEYS = Object.keys(MARKETS);
/** Every distinct collateral symbol across every protocol's table, deduped. */
const ASSET_SYMBOLS = [...new Set(Object.values(MARKETS).flatMap((market) => Object.keys(market)))];

/**
 * The holdout recall is NOT wired to a runtime export: it lives in
 * `docs/technical-docs/BACKTEST_RESULTS.md` ("Re-measured 2026-08-25, with a
 * calibration/holdout split"), a report, not a constant the engine returns.
 * It is hardcoded here on the same terms `PROTOCOL_SAFETY` hardcodes its
 * scores in `packages/scoring/src/subscores/protocolSafety.ts`, a real,
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

const CARD = "flex flex-col justify-between gap-2";
const LABEL = "label-type text-xs text-text-secondary";

export function ProofStrip() {
  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-16 md:px-16 lg:py-24">
      <div className="grid gap-6 md:grid-cols-3">
        <Card tone="raised" className={CARD}>
          <span className={LABEL}>Lending markets covered on Base</span>
          <div className="flex flex-wrap gap-2">
            {PROTOCOL_KEYS.map((key) => {
              // The engine's own key ("aave_v3") is never what a reader sees:
              // ProtocolLogo matches a mark by substring either way, so the
              // display name works for BOTH the match and the accessible
              // name, and the mark's native title tooltip says "Aave V3"
              // rather than the raw enum.
              const name = PROTOCOL_LABEL[key] ?? key;
              return <ProtocolLogo key={key} protocol={name} label={name} size="w-9 h-9" />;
            })}
          </div>
        </Card>

        <Card tone="raised" className={CARD}>
          <span className={LABEL}>Collateral assets priced by the engine</span>
          <div className="flex flex-wrap gap-2">
            {ASSET_SYMBOLS.map((symbol) => (
              <span
                key={symbol}
                className="hard-edge inline-flex items-center px-2 py-0.75 font-mono text-xs font-bold text-text-primary"
              >
                {symbol}
              </span>
            ))}
          </div>
        </Card>

        <Card tone="raised" className={CARD}>
          <span className={LABEL}>Doomed positions flagged in backtesting</span>
          <span className="font-mono text-2xl font-bold tracking-tight text-text-primary">
            {BACKTEST_RECALL}
          </span>
          <span className="font-mono text-xs text-text-secondary">{BACKTEST_FALSE_ALARM}</span>
        </Card>
      </div>
    </section>
  );
}
