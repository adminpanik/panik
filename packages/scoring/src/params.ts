/**
 * Open parameters — arch §"Open Parameters (tune during build)".
 * The week-1 calibration spot-check tunes HF_CEIL / VOL_CEIL against
 * historical liquidations (Ethereum mainnet Aave V3 via Dune); record
 * any change here with the evidence that motivated it.
 */

/** Ceiling for health-factor score interpolation. HF >= HF_CEIL scores 0. */
export const HF_CEIL = 2.0;

/** Annualised volatility treated as full risk (1.0 = 100%). */
export const VOL_CEIL = 1.0;

/** Sector TVL 7d change at which systemic stress saturates (-20%). */
export const SECTOR_FLOOR = -0.2;

/** Protocol TVL 7d change at which capital-flight saturates (-15%). */
export const PROTO_FLOOR = -0.15;

/**
 * Liquidation-proximity floors — week-1 calibration finding (2026-06-13).
 *
 * Evidence (Dune queries 7710372 / 7710392, Aave V2 Ethereum, Mar 2023 USDC depeg):
 * 49 users were liquidated on USDC-collateral positions on 2023-03-11 when USDC
 * hit $0.9405. Two days earlier their typical state was HF ≈ 1.05 in a market
 * where USDC's 30d vol, 90d drawdown and BTC correlation were all ≈ 0 — so the
 * pure weighted composite scored them ~40 (ELEVATED): position health is capped
 * at 40 of the composite and every other term was silent. No tuning of HF_CEIL /
 * VOL_CEIL can fix this (the weight structure caps the score at ~42).
 *
 * Fix: a floor on the composite when the position is close to liquidation,
 * regardless of market calm. Plain-language: "being <10% from liquidation is
 * critical even on a sunny day." Flagged for mentor sign-off (extends arch).
 * Ordered ascending by hfAtOrBelow; first match wins.
 */
export const LIQUIDATION_PROXIMITY_FLOORS = [
  { hfAtOrBelow: 1.1, minScore: 75 }, // ≤ ~9% collateral move from liquidation → CRITICAL
  { hfAtOrBelow: 1.25, minScore: 50 }, // ≤ 20% from liquidation → HIGH
] as const;

/**
 * Crash-regime escalation — backtest finding (2026-06-16).
 *
 * Evidence (docs/technical-docs/BACKTEST_RESULTS.md; 19 real Aave V2 WETH
 * positions liquidated in the Jun-2022 ETH crash, reconstructed per-wallet):
 * with only the static proximity floors, CRITICAL fired at a median HF of 1.10 —
 * i.e. almost solely from the HF ≤ 1.1 floor — giving a median 22h of CRITICAL
 * warning (the $40M whale got 17h) even though asset risk was saturated and the
 * market had been in freefall for ~2 days. HIGH fired ~57h out; the escalation
 * to "exit now" lagged 35h behind the danger the engine had already detected.
 *
 * Fix: in a saturated sell-off (S_asset_risk high) a position further from
 * liquidation than the static floor is already CRITICAL, because HF erodes in
 * hours mid-crash. Gated on BOTH high asset risk AND moderate proximity, so it
 * is silent in calm markets (asset risk low) and in stablecoin depegs (asset
 * risk ~0 — the HF floor handles those). Never lowers a score.
 *
 * Gate calibration (measured, not fitted; RE-MEASURED 2026-08-06 after the
 * drawdown term switched from the order-blind (max−min)/max to the true
 * peak-to-trough max drawdown — `scripts/backtest/diagnose-assetrisk.ts`, which
 * now feeds the engine `prices90d` like production does):
 *
 *   calm Apr 1 – May 5 2022 (WETH)   39.0–46.7  →  29.8–42.8   (margin 13.3 → 17.2pt)
 *   June crash Jun 4–19 2022         66.4–82.7  →  66.4–82.7   (UNCHANGED)
 *
 * The new metric is ≤ the old one for every input, so the shift is one-sided —
 * but it is confined to non-crash regimes. The two formulas coincide EXACTLY
 * whenever the 90-day peak precedes the 90-day trough, i.e. whenever the market
 * is in the sustained decline the gate exists to detect: over the 100-day
 * Mar–Jun 2022 fixture, ZERO days crossed the 60 gate downward, the highest
 * calm reading is still 58.08 (2022-05-19) and the lowest crash reading is
 * still 66.40 (2022-06-09). The regime gap the gate sits in is therefore
 * unchanged on the crash side and ~4pt WIDER on the calm side.
 *
 * The 60 gate is deliberately NOT retuned: retuning it to preserve an old
 * conclusion would be fitting the parameter to the doc rather than the data,
 * and the data says the separation improved.
 *
 * HF gate = 1.25 chosen by the survivor-control matrix (560 wallets, exact HF
 * via archive RPC): 1.25 gives recall 89% / false-alarm 23%, vs 1.35's 93%/33%
 * — the last 4pt of recall cost 10pt of false alarms, a poor trade. Lead time
 * holds (healthy-start median 44h vs baseline 17h).
 *
 * An acute short-horizon drawdown trigger (v2) was investigated to extend this
 * to fast/stablecoin-led crashes (UST/LUNA), then REJECTED: dense (6h) survivor
 * sampling showed the static floor already catches UST at 94% recall — the
 * apparent "UST gap" was a sampling artifact — and the drawdown trigger traded
 * +6pt recall for +17pt false alarms. Kept the vol-gated rule. See BACKTEST_RESULTS.
 */
export const CRASH_REGIME = {
  assetRiskAtOrAbove: 60,
  hfAtOrBelow: 1.25,
  minScore: 75,
} as const;

/** Composite weights — arch §Composite Score. Must sum to 1. */
export const COMPOSITE_WEIGHTS = {
  positionHealth: 0.4,
  assetRisk: 0.25,
  protocolSafety: 0.2,
  systemicRisk: 0.15,
} as const;

/** Position-health internal mix — arch §Sub-Scores 1. */
export const POSITION_HEALTH_WEIGHTS = { hf: 0.7, ltv: 0.3 } as const;

/** Asset-risk internal mix — arch §Sub-Scores 2. */
export const ASSET_RISK_WEIGHTS = { vol: 0.5, drawdown: 0.35, corr: 0.15 } as const;

/** Systemic-risk internal mix — arch §Sub-Scores 4. */
export const SYSTEMIC_RISK_WEIGHTS = { sector: 0.6, protocolFlight: 0.4 } as const;

/**
 * Alert-delivery policy - anti-spam / false-alarm controls (2026-06-27).
 *
 * The trigger itself (profile-relative status transitions, see profile.ts) is
 * backtest-calibrated, but the backtest documents a ~24-27% intrinsic
 * false-alarm rate, so notification VOLUME must be governed separately from the
 * score. These knobs sit at the delivery layer (Watch worker + dispatcher), not
 * the score, so tuning them never changes scoring or the backtest operating point.
 *
 *  - confirmTicks: a candidate status must hold this many CONSECUTIVE 60s ticks
 *    before WatchService commits/emits the transition. Kills single-tick spikes
 *    (flaky RPC read, momentary price wick) and threshold flapping (49/51
 *    oscillation never survives 3 ticks). 3 ticks ~= 3 min, negligible against
 *    the backtest's tens-of-hours CRITICAL lead times.
 *  - cooldownMs: the dispatcher sends at most one alert per (wallet, protocol)
 *    per window. A worsening escalation (approaching to outside) BYPASSES the
 *    cooldown (strictly worse news); same-severity re-crossings are suppressed.
 *  - minBorrowUsd: positions with no debt (HF null) or sub-dust debt can't be
 *    liquidated, so they never generate a near-liquidation alert regardless of
 *    composite score (which can rise on asset/systemic risk alone).
 */
export const ALERT_POLICY = {
  confirmTicks: 3,
  cooldownMs: 6 * 60 * 60 * 1000, // 6h
  minBorrowUsd: 50,
} as const;
