# Backtest Results — June-2022 ETH Crash (stETH-depeg cascade)

> 2026-06-16 · First real per-wallet backtest (the [CALIBRATION_REPORT](./CALIBRATION_REPORT.md)
> did representative reconstructions, "not a backtest"). Method per
> [BACKTEST_METHODOLOGY](./BACKTEST_METHODOLOGY.md). Reproducible:
> `npx tsx scripts/backtest/eth-crash-2022.ts`; locked in `tests/backtest.test.ts`.

## TL;DR

- Validated on **5 real crashes** (June 2022, UST, FTX, USDC depeg, Aug-2024 Base), **~6,800 wallets**, exact on-chain HFs. FTX is the only one that cannot currently be scored offline.
- **Shipped** one change (`CRASH_REGIME`): warns **~44h** before liquidation vs 17h baseline.
- **Tested + rejected 2 ideas** (acute-drawdown, peg-deviation): the static HF≤1.10 floor already catches every crash type — escalation only helps by buying *lead time* on ETH crashes.
- **Honest claim:** *"92% of doomed positions flagged, at a 26% false-alarm rate, across two crises the thresholds were never tuned on."* Measured 2026-08-25 on the holdout split (1,494 liquidated / 491 surviving). Never a bare "caught 19/19", and never the old pooled 89%, which mixed the calibration event with FTX.
- **Known limit:** the crash-regime gate never opened on either holdout event, so its measured lift comes entirely from the event it was calibrated on. See the 2026-08-25 section.
- **Scope:** WETH/stable + USDC collateral, Aave V2 Ethereum, plus the Aug-2024 Aave V3 Base cohort. Not yet alt-collateral.

## What ran

19 **real** Aave V2 Ethereum positions (WETH collateral, stablecoin debt) that were
liquidated in the Jun-2022 crash — the largest Aave borrower-liquidation event on record
($143M, ~1,970 wallets; this cohort is the WETH-collateral subset ≥ $200k debt).

**Reconstruction (exact for this position type).** Debt is a stablecoin ≈ $1, and a
position is liquidated when HF crosses 1.0, so at the first `LiquidationCall` HF ≈ 1.0.
With quantities ~constant over the short window, `HF(t) = WETH(t) / WETH(t_liq)` — needs
only the public WETH price series, no per-wallet balance accounting. Each hour is scored
through the live engine with point-in-time asset-risk inputs (30d vol, 90d drawdown, BTC
correlation from the real daily series). Systemic input is held flat (TVL unavailable
offline), which **under**-warns — the lead-time numbers are a floor, not a flattering ceiling.

Data (Dune, free tier, ~0.5 credits total): liquidations [7731514](https://dune.com/queries/7731514),
WETH hourly [7731537](https://dune.com/queries/7731537), WETH/WBTC daily [7731553](https://dune.com/queries/7731553).

## The gap the backtest exposed

With only the static liquidation-proximity floors, **CRITICAL fired at a median HF of 1.09** —
i.e. almost entirely from the `HF ≤ 1.1` floor — giving a median **22h** of CRITICAL warning.
The **$40M whale got 17h**. Yet the engine's own asset-risk term was already saturated and
HIGH had fired ~57h out: the "exit now" escalation lagged ~35h behind danger the engine had
*already detected*. In a freefall, HF erodes in hours — 17h is too late to act calmly.

## The fix — crash-regime escalation

`CRASH_REGIME` in [params.ts](../../packages/scoring/src/params.ts): when **S_asset_risk ≥ 60**
(a confirmed sell-off) **and HF ≤ 1.25**, escalate to CRITICAL. Gated on both, so it never
fires in calm markets or stablecoin depegs (where asset risk stays ~0 and the HF floor
already handles things). Never lowers a score.

**Both gates are measured, not fitted.** The asset-risk gate: S_asset_risk on WETH sits well
below 60 in the calm Apr/early-May market and at ~66–83 once the June crash began — a clean
regime gap, so 60 sits in the middle (`scripts/backtest/diagnose-assetrisk.ts`). The HF gate
(1.25) was chosen by the survivor matrix below, not picked.

### Re-measured 2026-08-06 — true max drawdown

The drawdown term (35% of `S_asset_risk`) changed from the order-blind `(max − min) / max` to a
true peak-to-trough max drawdown over the ordered 90-day series. The new metric is ≤ the old one
for **every** input, so every composite score is monotonically non-increasing — a systematic
desensitisation that had to be re-measured rather than assumed harmless. All five backtest
scripts were still passing `maxPrice90d`/`minPrice90d`, which routes to the deprecated fallback
that is byte-identical to the old formula, so re-running them would have "confirmed" a
calibration the engine no longer uses. They now pass `prices90d`, like the production provider.

Measured on the repo's own `ethCrash2022` fixture (WETH daily, Mar 12 – Jun 19 2022):

| Window | Old (extremes) | New (ordered series) |
| --- | --- | --- |
| Calm Apr 1 – May 5 2022 | 39.0–46.7 | **29.8–42.8** |
| UST/LUNA window May 8–16 | 46.4–57.7 | 46.0–57.7 |
| June crash Jun 4–19 | 66.4–82.7 | **66.4–82.7** (unchanged) |
| Highest pre-crash reading | 58.08 (May 19) | 58.08 (unchanged) |
| Lowest crash reading | 66.40 (Jun 9) | 66.40 (unchanged) |
| Days crossing the 60 gate downward | — | **0 of 100** |

**Effect on the 60 gate: none, and the margin improved.** The two formulas coincide *exactly*
whenever the 90-day peak precedes the 90-day trough — i.e. whenever the market is in the
sustained decline the gate exists to detect (verified day-by-day across the fixture; the only
divergence from that rule is a single boundary tie). The shift is therefore confined to calm and
mixed regimes: the calm-side margin to the gate widens from 13.3pt to 17.2pt while the crash side
is bit-identical. **The gate was NOT retuned** — retuning it to preserve the old prose would be
fitting the parameter to the doc rather than to the data.

Aug-2024 price-walk recall and lead times are **bit-identical** before and after on all three
local cohorts (Compound 117/117, median lead 18h; Moonwell 564/564, 33h; Morpho 192/192, 12h) —
that window is a decline from an early peak, so the two drawdowns agree.

**Not verifiable offline:** the FTX (Nov 2022) and UST (May 2022) rows of the multi-event table
below are driven by the Dune daily WETH/WBTC series (query 7739633), which needs `DUNE_API_KEY`;
`survivor-matrix-real.ts`, `survivor-matrix-base.ts` and `verify-assetrisk-multi.ts` were
migrated to `prices90d` but **could not be re-run here**. The FTX window is a decline from a
mid-August peak to a 9–10 November trough, so by the rule above its readings should be unchanged
— but that is a mechanism argument, not a measurement. **Re-run those three scripts with a Dune
key before treating the 54–65 FTX band and the pooled 89% recall as re-confirmed.**

## Before → after (same 19 positions)

| Metric | Baseline (static floors) | Improved (crash-regime, HF≤1.25) |
| --- | --- | --- |
| Caught CRITICAL before liquidation | 19/19 | 19/19 |
| **Median CRITICAL lead — healthy-start** (HF@start > 1.25, n=10) | **17h** | **44h** |
| $40M whale CRITICAL lead | 17h | 44h |
| Median HF when CRITICAL fired | 1.09 | 1.22 |
| Positions with *reduced* lead time | — | 0 (only-raises) |

"Healthy-start" is the honest, uncensored headline: ~half the cohort was already inside the
static floor 4 days out (doomed for days; the 96h replay window right-censors them), so the
all-cohort median (22h → 57h) overstates. The healthy-start cohort — positions that began
with room to act — is where the change does real work: **~2.6× more warning**.

## Survivor controls / false-positive analysis (DONE)

The catch rate (19/19) is meaningless without a false-positive rate: a detector that screams
CRITICAL at everything also scores 19/19. So we measured survivors — borrowers who rode the crash
and were *not* liquidated — and how many of them each threshold would have flagged.

**Method.** Flow-reconstruction of survivor positions proved unreliable (query 7734090 inflates
size via aggregator/proxy contracts and `onBehalfOf`≠`user`; aToken/debt-token balances rebase,
so transfer-sums miss interest). The correct source is the protocol itself:
**`LendingPool.getUserAccountData(user)` read at historical blocks via archive RPC** returns the
exact health factor (all collateral + debt + accrued interest, on Aave's oracle). We sampled 560
candidates (400 liquidated + a 160 random survivor sample of 1,674) at 4 blocks spanning the crash
legs (Jun 8/13/14/18, including the trough). During the crash S_asset_risk ≥ 60 holds at every
block, so the crash-regime flag reduces to **HF ≤ threshold**.

Reproduce:
```
node --env-file=.env --import tsx scripts/backtest/build-candidates.ts
node --env-file=.env --import tsx scripts/backtest/fetch-survivors-eth.ts
npx tsx scripts/backtest/survivor-matrix.ts
```

**Results (confusion matrix over 560 wallets, exact HF):**

| Flag threshold | Recall (caught) | False-alarm rate | Precision* | Pop-adj precision** |
| --- | --- | --- | --- | --- |
| Baseline HF ≤ 1.10 | 49% | 10% | 94% | 61% |
| **HF ≤ 1.25 (chosen)** | **89%** | **23%** | 93% | **55%** |
| HF ≤ 1.35 | 93% | 33% | 90% | 47% |

\* Precision in the sampled set. \*\* Re-weighted to the true base rate (≈400 liquidated : 1,674
survivors); the transferable, base-rate-free metrics are **recall** and **false-alarm rate**.

**Why HF ≤ 1.25.** Moving the gate 1.25 → 1.35 buys only +4pt recall (89→93) for +10pt false
alarms (23→33) and −8pt population precision — a bad trade. 1.25 nearly doubles recall over the
baseline (49 → 89%) while keeping ~half of all crash-time flags genuinely doom-bound and holding
the lead-time win (healthy-start median 44h vs 17h).

**The honest read for users.** In a ~50% crash, an HF-based early warning *will* flag a meaningful
share of positions that ultimately survive (false-alarm 23%; roughly half of all flags are
survivors at the true base rate). That is intrinsic, not a defect — those survivors were genuinely
within 25% of liquidation during a 50% crash, and many only survived by acting or by luck. The
defensible user-facing claim is therefore **recall + false-alarm together**, never a bare
"caught 19/19".

### Caveats on these numbers
- **4-block sampling under-measures recall** (HF dips between blocks are missed); PANIK's real 60s
  loop would catch more, so 89% is a floor.
- **Precision is base-rate-dependent** — only recall and false-alarm rate transfer to production.

## Multi-event validation (June + UST/LUNA + FTX + USDC depeg) — real engine, no proxy

To check the crash-regime isn't overfit to June, we ran the **actual `computeScore` engine** (not
the HF-only proxy) over three crashes at **full borrower population — no survivor sampling**: 5,052
reconstructed positions (704 liquidated + 4,348 survivors with debt), exact HF via archive RPC, real
per-block S_asset_risk. UST is sampled **densely (6h, 20 blocks)**; June/FTX use 4 daily blocks
(recall there is a floor — see the sampling note). A position is "flagged" if it ever reached
CRITICAL before exit. Precision below is **exact** (full population, not extrapolated). Run:
`node --env-file=.env --import ./scripts/backtest/dnsfix.mjs --import tsx scripts/backtest/survivor-matrix-real.ts`

| Event | S_asset_risk in window | Baseline recall | Shipped recall | Shipped false-alarm |
| --- | --- | --- | --- | --- |
| June 2022 (ETH/stETH) | 67–82 (gate fires) | 49% | **88%** | 34% |
| FTX (Nov 2022) | 54–65 (partial) | 41% | **53%** | 27% |
| UST/LUNA (May 2022) | 46–57 (**gate never fires**) | 94% | **94%** (no change) | 20% |
| **Pooled (full pop, exact)** | — | 65% | **89%** | 27% (precision 35%) |

> ⚠️ **These figures predate the true-max-drawdown change.** Superseded for every event that can
> be scored offline: see "Re-measured 2026-08-25, with a calibration/holdout split" below, which
> reproduces the June, UST and USDC rows exactly. **FTX is the one row still unverified** — no
> Nov-2022 price series is committed, so it cannot be scored without `DUNE_API_KEY`, and the
> 54–65 band remains at risk of turning "partial" into "never fires". The pooled 89% is superseded
> and should not be quoted: it mixes the calibration event with FTX.

## Re-measured 2026-08-25, with a calibration/holdout split (roadmap 5.4)

Offline, from the committed CSVs and price series (no Dune, no RPC, no key):
`node --import tsx scripts/backtest/holdout-recall.ts`

| Event | Split | Liq | Surv | Baseline recall | Shipped recall | Shipped false-alarm |
| --- | --- | --- | --- | --- | --- | --- |
| June 2022 (ETH/stETH) | CALIBRATION | 408 | 1257 | 49% | **88%** | 34% |
| UST/LUNA (May 2022) | PARTIAL | 262 | 1454 | 94% | **94%** | 20% |
| USDC depeg (Mar 2023) | HOLDOUT | 29 | 202 | 97% | **97%** | 30% |
| Aug 2024 unwind (Base) | HOLDOUT | 1465 | 289 | 92% | **92%** | 24% |
| **Pooled HOLDOUT** | — | **1494** | **491** | 92% | **92%** | **26%** |
| Pooled all offline (no FTX) | — | 2164 | 3202 | 84% | 91% | 26% |

**Why the split falls where it does.** June 2022 is calibration twice over: the asset-risk gate of
60 was placed in the June-vs-calm gap, and the 1.25 HF gate was chosen on a 560-wallet June
survivor matrix. UST is *partially* in-sample — no parameter was fitted on it, but the v2
acute-drawdown variant was rejected on it, which is model selection. USDC 2023 and Aug-2024 Base
are clean holdout: both postdate the gates, and no parameter or threshold was touched for either.

**The honest headline is the holdout row: 92% recall at 26% false-alarm, over 1,494 liquidated and
491 surviving borrowers, across two crises no threshold was tuned on.**

**And the caveat that matters more than the headline:** on BOTH holdout events, baseline and
shipped are identical. The crash-regime gate never opened there (peak `S_asset_risk` 50 and 53,
against a gate of 60), so the entire +39pt lift the gate is credited with is measured on the event
it was calibrated on. **The gate is unvalidated out of sample.** That is not evidence it is wrong —
no holdout event reached a June-2022-scale sell-off — but it is not evidence it is right either.

**Finding 1 — the crash-regime helps on ETH-led crashes and never hurts.** It fires when
`S_asset_risk ≥ 60`, which held for June (fully) and FTX (partly), lifting recall 49→89% and
41→53%. On UST it doesn't fire (asset-risk stayed ~46–57; a *stablecoin* collapse where ETH's
30d-vol never saturated), so it's neutral there. Recall ≥ baseline and false-alarm ≈ baseline on
every event — strictly a gain or a no-op.

**Finding 2 — the apparent "UST gap" was a sampling artifact, not a scoring hole.** With 4 daily
blocks UST recall looked like 38%; re-sampled at **6h (Dune 7740207, 20 blocks)** it is **94%** —
the static `HF ≤ 1.10` floor catches the fast May-11/12 crash fine once you actually observe the
intraday dip. PANIK's real 60s loop samples far denser than 6h, so 94% is itself a floor. (June's
continuous hourly replay likewise caught 19/19 vs 89% on its 4-block sample.)

**Finding 3 — an acute-drawdown trigger (crash-gate-v2) was built, tested, and REJECTED.** To try
to escalate fast/stablecoin crashes regardless of 30d vol, we added a second trigger: an acute
≥10% collateral drawdown over the last 3 daily returns (computed from the existing `dailyReturns30d`
tail — no new input). On the dense UST set it lifted recall only 94→100% while pushing false-alarm
28→**45%** — the same poor trade as the rejected HF≤1.35 gate (+6pt recall for +17pt false alarms),
and it wouldn't even fire on a ~6% USDC depeg. **Not shipped.** The mechanism, the 3-mode matrix
(`survivor-matrix-real.ts`), and this negative result are kept on record; the static floor already
covers fast crashes under realistic monitoring.

**Finding 4 — USDC depeg (Mar 2023, 4th event) + the peg-deviation term: also REJECTED.** We pulled
the full USDC-collateral / non-USDC-stable-debt population (292 positions: 29 liquidated + 263
survivors), exact HF at 20 dense 6h blocks through the depeg, with per-block peg deviation from real
USDC hourly price (0% → **8.4%** peak Mar-11 → recovering). A peg-break escalation (HF ≤ 1.25 AND USDC ≥2%
below $1) was implemented and tested:

| USDC-depeg (full population: 29 liq + 203 survivors with debt) | Recall | False-alarm | Precision |
| --- | --- | --- | --- |
| Baseline (static floor) | 97% | 30% | 31% |
| Peg-regime ON | **97% (no gain)** | **41%** | 25% |

**Why it failed — and the unifying lesson.** A depeg **reprices the collateral through Aave's oracle**,
so the position's HF already drops; the static `HF ≤ 1.10` floor catches it (97% recall, 1 miss).
The peg term is redundant with the HF drop it would trigger on, so it only added false alarms. This is
the *same* root cause as the rejected v2 drawdown trigger: **every crash — fast ETH (UST), broad
(June/FTX), or stablecoin depeg (USDC) — ultimately shows up as the oracle-priced HF falling, and the
floor already catches it under realistic dense monitoring.** Escalation only pays off when it buys
*lead time* against a slow-saturating signal — which is exactly and only the vol-gated crash-regime on
ETH crashes (17h→44h). Drawdown/peg signals fire ~simultaneously with the HF drop, so they buy no lead
time and just cost false alarms. (Reproduce: `survivor-matrix-usdc.ts`.)

Data: `scripts/backtest/data/{june,ust,ftx,usdc}-{candidates,hf}.json`; cohorts via Dune 7739767 +
7740622, blocks via 7739626 + 7740207 + 7740575, prices via 7739633 + 7740508.

## Other limitations (for the mentor / lead)
1. **WETH-collateral / stable-debt only.** The exact `HF = Pc/Pd` shortcut relies on stable
   debt. Volatile-debt and multi-collateral positions need full reconstruction.
2. **Censoring at 96h** (fixture window) — true lead times for the already-stressed cohort are
   longer than reported. Conservative.
3. **Aave V2 Ethereum** stands in for V3/Base (didn't exist in 2022); HF/LTV mechanics are
   identical for the formula.

## Action items

- [x] Phase 2: survivor cohort → false-positive rate (recall 89% / false-alarm 23% at HF≤1.25).
- [x] Multi-event validation (June + UST + FTX), dense-sampled real engine — pooled recall 66%→89%, never harmful.
- [x] Crash-gate-v2 acute-drawdown trigger — built, tested, **rejected** (poor recall/false-alarm trade; UST gap was sampling).
- [x] Peg-deviation term + USDC-depeg event (4th) — built, tested, **rejected** (depeg reprices HF via oracle → floor already catches it; +0 recall, +11pt false-alarm).
- [ ] Mentor sign-off on `CRASH_REGIME` (recall 89% / false-alarm 23% on June; neutral elsewhere). The two rejected experiments are evidence the current rule is near a local optimum for this position type.
- [ ] Mentor sign-off on `CRASH_REGIME` (extends the formula, like the proximity floors).
- [ ] Extend to the other events (UST/LUNA, FTX, USDC depeg) using the same harness.
