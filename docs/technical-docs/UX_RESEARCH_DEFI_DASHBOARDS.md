# DeFi Dashboard UX Research - Making Risk Data Instantly Understandable

Compiled 2026-07-03 from published UX research, product teardowns, and tracker
comparisons. Goal: identify the patterns that make complex DeFi data easy to
understand, check PANIK against them, and produce a prioritized backlog.

## Sources reviewed

- Jon Crabb, "How to improve the UX of DeFi loans" (user-research-backed
  critique of Aave/Abracadabra/Sushi/Angle risk displays)
- "Proposed Widgets for an AI-Augmented DeFi Risk Dashboard" (nine widget
  patterns for risk legibility)
- "Simplifying Complex DeFi Interactions" (Aave E-Mode case study)
- DeFi Saver automation docs (trust framing for automated protection)
- 2026 tracker comparisons: Zerion vs DeBank vs Zapper (CleanSky, Portals,
  ChainGlance, CoinSutra)
- app.yo.xyz (reviewed earlier: preset chips, sparkline cards, dollar framing)

## The seven patterns that matter

### 1. Verbal beats numeric; dollars beat percentages
User testing (Crabb) found non-experts parse "Low / Medium / High risk" and
"price at liquidation" far faster than abstract ratios. Aave's bare health
factor ("1.0 = liquidated") consistently confused new users; "required price
drop until liquidation" tested best.

**PANIK status: largely adopted.** Bands (LOW..CRITICAL), the simulator's
dollar-framed verdict, and Telegram alert copy already do this.
**Gap:** the Watch tab's big HEALTH FACTOR number still stands alone - it
inherits Aave's abstract-ratio problem. Pair it with its translation
("a -18% move liquidates") everywhere it appears.

### 2. Scale direction must match the story
"Health 100% = death" and progress bars that fill toward danger read as
positive. Scales should run so that danger is visually down/empty/red and
the words match the motion (health falls, risk rises).

**PANIK status: safe.** Our 0-100 number is explicitly RISK (rises = worse),
so a bar filling toward red is consistent. Keep it that way: never introduce
a "health %" bar that fills toward liquidation.

### 3. Buffer is the hero metric
The single most decision-useful number for a borrower is the margin between
now and liquidation (price drop % or dollar distance), not LTV, not HF.
Alpaca's "Kill Buffer" is the cited good example.

**PANIK status: partial.** Buffer appears in the breakdown panel (dim 4) and
the scenario verdict, but it is never the headline. Candidate: make
"Buffer to liquidation" a first-class stat on Portfolio position rows and the
Watch header.

### 4. One-second check-in widgets
The Risk-O-Meter pattern: a single gauge/scorecard the user can read in one
second, with progressive disclosure (click to expand the full breakdown -
e.g. a score bar that expands to a spider chart). Zerion's "cleanest single
portfolio screen" reputation comes from ruthless summary-first hierarchy.

**PANIK status: partial.** The Aggregate Risk Index card is close; a
semi-circle gauge treatment + one-line verdict would complete the pattern.

### 5. Time series anchor the page
Every top tracker (Zerion, DeBank, Zapper, YO) leads with a value-over-time
chart - it answers "am I ok?" preattentively. Activity feeds beside charts
(Zapper's social/activity model) give the "what happened" complement.

**PANIK status: adopted this round.** Risk Index History + Alert History are
exactly this pair, adapted from net-worth to risk. Candidate addition: a
collateral-value line (we already store collateral_usd per snapshot) so users
see MONEY and RISK trends side by side.

### 6. Scatter the marketplace: yield vs risk in one plot
The Yield-vs-Risk scatter quadrant ("mispriced opportunity" top-left,
"danger zone" bottom-right) is the strongest discovery visual for a list of
opportunities, and nobody in the mainstream trackers does it well.

**PANIK status: missing, and uniquely ours to win.** We are the only ones
with a calibrated risk score per pool; plotting Compass presets as
APY (y) x PANIK score (x) would be a signature feature no tracker can copy
without a scoring engine.

### 7. Automation must feel bounded, not magical
DeFi Saver's trust framing: triggers only fire at YOUR configured ratio,
execution is verified on-chain against YOUR target, bots are "fully limited
by the user's configuration." Say what the system cannot do.

**PANIK status: relevant when the auto-repay card returns** (currently hidden
per QA). Its copy should adopt the bounded-trigger framing, plus the dual
"pre-check + outcome-check" explanation.

## Cross-cutting hygiene (from the E-Mode case study + fintech guides)

- Card = one concept; the key number of each card 2x the size of its label.
- Info icon with a plain-language tooltip on EVERY metric (we lack these on
  LTV, HF, sub-scores).
- Token symbol + icon + USD value always travel together.
- Defaults first, advanced behind a toggle (our simulator already does this).
- Color = state, never decoration; the same green/amber/red thresholds
  everywhere (we aligned these to 25/50 this round - keep enforcing).

## Prioritized backlog for PANIK

| # | Item | Pattern | Effort | Where |
|---|------|---------|--------|-------|
| 1 | Tooltips on every metric (HF, LTV, sub-scores, buffer) | 7 | S | all tabs |
| 2 | "Buffer to liquidation" as headline stat + HF always paired with its dollar/percent translation | 1+3 | S | Portfolio rows, Watch header |
| 3 | Collateral-value trend line next to Risk Index History | 5 | S | Portfolio (data already in /api/history) |
| 4 | Aggregate risk gauge (semi-circle) with one-line verdict | 4 | M | Portfolio macro card |
| 5 | Yield-vs-Risk scatter for Compass presets | 6 | M | Compass (signature feature) |
| 6 | Bounded-automation copy when auto-repay ships | 7 | S | Settings |

## Sources

- https://medium.com/@JonCrabb/how-to-improve-the-ux-of-defi-loans-2a6ddd99d321
- https://medium.com/@siarheimardovich/proposed-widgets-for-an-ai-augmented-defi-risk-dashboard-bdcef2df8357
- https://medium.com/@haajmuskid/simplifying-complex-defi-interactions-a-ux-case-study-d42d44b48950
- https://help.defisaver.com/features/automation/how-does-automation-work.md
- https://cleansky.io/compare/
- https://blog.portals.fi/defi-portfolio-tracker-comparison/
- https://chainglance.com/blog/7-best-defi-portfolio-trackers-in-2026/
- https://coinsutra.com/best-defi-dashboards/
