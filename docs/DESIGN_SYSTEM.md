# PANIK design system

How the product UI is built, and why. Written after rebuilding it across PRs #12-#15, so
most of the rules below exist because their absence caused a specific problem.

**If you are about to build a new screen or redesign an existing one, read
[Working on the UI](#working-on-the-ui) at the bottom first.**

Scope: `src/panik-core` (the product app). The landing page (`src/panik-landing-page`) is
a marketing surface with its own looser conventions and is deliberately not held to all
of this.

---

## The one idea

The problem was never missing design. It was a design system that existed and got
ignored. `src/index.css` already had an `@theme` block whose comment read *"Custom Color
Overrides to make code cleaner"*, and the codebase then bypassed it **1,210 times**.

So the rules here are enforced by the token layer rather than by good intentions:
**anything not in `@theme` is reset to `initial`**, which deletes the utility. A stray
`text-red-400` or `rounded-2xl` renders as nothing and gets caught in review, instead of
quietly becoming the fifth green.

Measured, before -> after:

| | before | after |
|---|---|---|
| Distinct hardcoded hex colours in `src/` | 67 | 21 (8 in `.tsx`, all third-party brand marks) |
| Arbitrary-value utilities (`text-[9px]`, `bg-[#111318]`) | 1,210 | ~180 (4 are colours) |
| Distinct font sizes | 26 | 8 |
| Text at or below 10px | 313 | **0** |
| Pulse animations | 18 | **0** |
| `font-mono` in the app | 257 | 2 (hex addresses only) |
| Shared UI primitives | 0 | 9 |
| `npm run lint` | 3 errors | **0** |

---

## Tokens

All in `src/index.css` under `@theme`. Never hardcode a value that has a token.

### Surfaces (4)

```
--color-surface-base     #09090B   page background
--color-surface-sunken   #0C0D11   insets, wells, table headers
--color-surface-raised   #111318   cards, panels
--color-surface-overlay  #16181F   modals, popovers, dropdowns
```

Seventeen near-blacks collapsed onto these. `#0A0A0B` vs `#0A0B0F` vs `#111318` is a
distinction nobody can see, and the *inconsistency* reads as sloppiness even when the
individual value doesn't.

### Text (3)

```
--color-text-primary    #F8FAFC   content
--color-text-secondary  #94A3B8   labels, supporting prose
--color-text-muted      #7A8699   timestamps, units, hints
```

**`text-muted` is for things you glance at, not things you read.** The single biggest
readability bug was rendering the money line of a position row in muted grey at 12px:
the primary content of the row was the dimmest thing on screen. It is now
`14px/600/text-primary`, **16.94:1** instead of 6.91:1.

A muted token must clear 4.5:1 on the *lightest* surface it can land on, not just the page
background. `#475569` passed a naive check and measured **2.45:1** on a card. `#64748B`
also fails (3.90). `#7A8699` is the first value that clears everywhere.

### Borders (2 families, and this distinction matters)

```
--color-border-subtle  rgba(255,255,255,0.08)  decorative: card edges, dividers
--color-border-strong  rgba(255,255,255,0.36)  functional: inputs, focus rings, chips
```

Using one value for both is the commonest dark-UI mistake. Functional borders must hold
3:1 (WCAG 1.4.11); decorative ones are exempt. The old code used `white/[0.03]`-`[0.07]`
everywhere, measuring 1.07-1.20:1.

### Risk ramp (4 bands + unknown)

```
--color-risk-low       #10B981
--color-risk-elevated  #F59E0B
--color-risk-high      var(--color-panik-orange)
--color-risk-critical  #F87171
--color-risk-unknown   #7A8699   not a band: "we could not measure this"
```

`risk-high` **derives from** the brand token rather than repeating `#F97316`, because
several design decisions depend on them being identical and two independent literals go
out of sync silently.

`RISK_CHIP.UNKNOWN` carries **no fill**, deliberately: a 10% wash of that grey drags the
label to 4.26:1. It uses a dashed border so "not measured" is not carried by hue alone.

### Type scale (8 steps, floor 11px)

```
--text-2xs   11px / 16    micro labels
--text-xs    12px / 16    secondary labels
--text-sm    14px / 20    body, table cells (the default)
--text-base  16px / 24
--text-lg    20px / 28    card titles
--text-2xl   28px / 34    stat values
--text-4xl   40px / 44    page titles
--text-display 64px       marketing hero ONLY
```

The old floor was `text-[5.5px]`, with **313 usages at or below 9.5px**. Tiny type is the
loudest "unfinished" signal in a UI and it is also an accessibility failure. 11px is the
floor and very little should sit at it; 13-14px is right for row content.

### Radii (3 + full)

`--radius-sm` 6px (chips, inputs) · `--radius-md` 10px (cards) · `--radius-lg` 14px
(modals) · `rounded-full` for dots and avatars only.

### Spacing

**Do not spend effort here.** Only two arbitrary spacing values exist in the whole repo;
Tailwind's 4px scale is already respected. This is the one axis that was never broken.

---

## Colour discipline

This is the rule most likely to be violated, and the one the founder pushed back on
hardest. Two separate jobs, do not conflate them:

### 1. Risk colour is rationed

**A screen gets a handful of risk-hued elements, not a dozen.** Portfolio's budget is
**5**: four position dials plus the aggregate warning glyph. Watch was reduced from 14 to
2.

Concretely, do not:

- **Colour a stat value.** `57 / 100` as a giant red numeral and `4 positions` in orange
  meant nothing on the page stood out. Figures are neutral ink; a chip beside them carries
  the band.
- **Colour a whole sentence.** `Health factor 1.20, over your risk limit` in full red is
  redundant when the chip next to it already says `52 HIGH`.
- **Colour a verb.** `HOLD` rendered in `risk-low` green is the risk ramp making a safety
  claim about an action, with the position's real band inches away.
- **Colour a good number alarmingly.** `Protocol risk 16%` was drawn with
  `bg-risk-critical`. 16% is a *good* score.
- **Repaint an input based on what the user typed.**

Before this, one screen carried seven competing hues and nothing read as important.

### 2. Categorical colour is data, and deleting it is also wrong

The first attempt stripped *all* colour and the founder's reaction was *"you just made it
black and white."* Correct: distinguishing cbBTC from WETH in an allocation chart is data
encoding, not decoration.

Categorical colour uses the **cool chart palette** (`--color-chart-*`, violet / indigo /
blue / sky / cyan). It deliberately contains **no red and no green**, so a series can never
be misread as a risk state. Charts, legends, protocol tiles.

Compound's real brand green `#00D395` is substituted with cyan for exactly this reason: a
green tile beside a `CRITICAL` chip asserts two contradictory things about one row.

### Brand accent

`--color-panik-orange` appears in `src/panik-core` **only** in the logo and the
`:focus-visible` ring. Not buttons, not chips, not borders, not stat values. Primary
buttons are a neutral near-white fill (`bg-text-primary text-surface-base`, 18.1:1).

An accent rail was tried on the active nav item and removed: `--color-panik-orange` and
`--color-risk-high` are the same hue, so the shell was wearing the colour a user had just
been taught means HIGH.

---

## Typography

Two families. **Plus Jakarta Sans** for everything, **JetBrains Mono** for hexadecimal
addresses and nothing else.

`font-mono` was used **257 times** in the app for labels, buttons, headings and prose,
which is most of why the UI read as hard work. It is now 2.

**Numbers use `tabular-nums`, not mono.** Measured: Plus Jakarta Sans ships real tabular
figures (digit advance spread 36.10px -> 0). `font-variant-numeric: tabular-nums` is set
globally on `body`, so every digit aligns by default and mono was removed wholesale without
any numeric column losing alignment. `font-mono` is not a substitute for tabular figures.

**No uppercase-with-letter-spacing labels.** 89 `uppercase` and every `tracking-widest`
were removed. Small and muted is what makes a label recede; shouting in mono is what makes
it unscannable. Sentence case throughout.

---

## Primitives

In `src/panik-core/ui/`. **Use these instead of hand-rolling equivalents.**

| | |
|---|---|
| `Card` | tones: `panel` (default), `raised`, `lead`, `set-back` — see below |
| `Stat` | label + value + optional sub. Renders correctly with no sub |
| `Button` | `primary` (neutral fill) and `quiet` (ghost). No gradients, ever |
| `Chip` | a neutral marker beside a thing ("Your wallet"). No hue, no state |
| `DemoChip` | `Chip` preset: the word "Demo" where a surface is not the real thing |
| `RiskChip` | the band as a tinted pill. Wraps `RISK_CHIP` in `lib/utils.ts` |
| `RiskDial` | score as an arc + numeral. Colour on the arc only |
| `EmptyState` | **two tones, see below** |
| `Skeleton` | loading placeholder that reserves layout |
| `TabPanel` | the ARIA tabpanel wrapper |
| `Listbox` | the app's ONE dropdown. **See below** |
| `LAYER` / `SCRIM` | every z-index and every backdrop in the app, in `ui/overlay.ts` |

`Card`'s `lead` tone is `raised` with a functional edge, for the one card a screen leads
with. **At most one per screen**, or "the thing to read here" stops meaning anything.
`set-back` is the other end: `raised` on a dimmer surface, for a tile in a section the page
has deliberately put aside (the Compass "Outside your profile" grid). Both are tones rather
than utilities on the call site, because a `border-border-strong` or a `bg-surface-raised/25`
passed that way ties with the tone's own at equal specificity, and which rule Tailwind emits
last is not something a caller can see. The Compass cards hand-rolled their own three depths
until they did not, and the lead they drew was a different surface from the Advisor's.

### `Listbox` is the only dropdown, and the reason is keyboard support

It is the WAI-ARIA select-only combobox: roving `aria-activedescendant`, arrows with
Home/End and scroll pinning, Enter to commit, Escape / Tab / outside-press to dismiss, the
panel's edge measured on open, and focus that never leaves the trigger. The consumer
supplies the trigger's content and skin, each row's content and skin, and a row's
accessible name where its markers are invisible to a screen reader. The panel's own box is
not a prop, and neither is the chevron: "there is a list behind this" is the control's
fact, and the two consumers had already drawn it at two sizes.

The second dropdown in this app was a `<button>` and a `<ul>` with no key handler at all,
on the screen where a reader compares four positions before acting on one. Building a
third by hand would reproduce that.

### Overlays pick a rung, never a number

`LAYER` in `ui/overlay.ts`: chrome 30, popover 50, banner 100, scrim 200, sheet 210, modal
220, tip 300. The rule is that a surface the READER opened sits above a notice the APP
raised. Nine hand-picked z-indexes produced the opposite: at 390 the alerts-inactive banner
covered an open sheet's heading and close control, and it outranked the exit flow. If no
rung fits, that is a conversation about the ladder.

`SCRIM` is the one backdrop. Four modals hardcoded `bg-black/70` or `/80` with three
different blurs while the sheet used the surface token, so the app dimmed itself four ways
depending on which button you pressed.

`RISK_CHIP` in `lib/utils.ts` is **the single place a band becomes pixels.** Do not write
`bg-risk-*/10 text-risk-* border-risk-*/25` by hand. A hand-rolled copy shipped a chip
whose ternary had no `HIGH` branch, so scores 50-74 rendered in critical red while labelled
`HIGH`.

### `EmptyState` has two tones and the distinction is a correctness requirement

- `tone="clear"` — "we looked and there is nothing to report" (good news)
- `tone="problem"` — "we could not load this" (bad news)

These previously rendered as the same grey box. In a liquidation-risk product, "no
positions at risk" and "we could not reach the indexer" looking identical is a **safety
bug**, not a style issue.

---

## Copy

### The three-way test

Every piece of explanatory text gets one of three verdicts:

1. **Keep inline** — it changes what the user does, or disambiguates something genuinely
   unclear. Must be short.
2. **Move to `InfoTip`** — methodology, provenance, definitions. Valuable on request,
   noise on every glance.
3. **Delete** — it restates its heading, markets the product to someone already inside it,
   or is jargon with no referent.

Bias: hover over inline, delete over hover. On-screen word counts dropped 30-61% per
surface with nothing of value lost.

Founder's rule: *"I don't like putting stuff just to put stuff in, so if the text under the
cards are that, then don't add them in the first place."*

Real examples that were deleted: *"Breakdown of collateral asset distributions backing the
protected portfolio vault lines"* (restates its title; "vault lines" refers to nothing),
*"All positions undergo continuous drift analysis against current collateral price
benchmarks"*, and a four-step "How to connect alerts" list where every step restated
something else on the same screen.

**Never delete:** money-path warnings, failure states, data-handling commitments, or the
degraded-price messaging.

### No em dashes

Founder rule. Use a comma, colon, period, or parentheses. Applies to UI copy; code
comments are exempt.

### No jargon, and no internal enum values

The product's whole premise is making DeFi legible. Two hard rules:

**Never render an engine enum.** `ProfileStatus` values (`within` / `approaching` /
`outside`) were rendering as `approaching → outside`, which the founder reasonably called
*"wtf is approaching outside"*. Use `LIMIT_STATE` and `LIMIT_EVENT` in `lib/utils.ts`,
which give `under` / `nearing` / `over your risk limit` and `crossed` / `nearing` /
`back under your risk limit`.

Those words were chosen so the enum tokens do not appear as substrings, which turns "is an
enum leaking?" into a mechanical grep.

**Lead with the consequence, not the ratio.** `Health factor 1.05` is meaningless to a
normal user. Every comparable product (DefiLlama, Morpho, Otomato, Block Analitica) leads
with a price-drop buffer instead:

```
Health factor 1.20  ->  Liquidates if WETH falls 17%
Health factor 1.05  ->  Liquidates if cbBTC falls 4.8%
```

Use `liquidationOutlook()` in `lib/utils.ts`. **Keep the precise value reachable in the
hover** — translating the surface must not delete what a DeFi-native user came for.

### Never render an unknown value as a zero

A degraded price feed once made a **$120,000** debt read as **$40**, which dropped it below
a materiality gate so no alert fired. `$0`, `0%` and `Infinity%` are all forbidden as
stand-ins for "unknown" or "not applicable". Use an explicit marker, and make sure a
degraded row is distinguishable from a healthy one by **more than colour** (shape, icon,
and words).

---

## Layout

- **One content cap, centred.** `max-w-[1600px] mx-auto`. Panels previously had four
  different caps (`4xl`/`5xl`/`5xl`/`6xl`) and none was centred, so at 2000px all 720px of
  slack dumped on one side.
- **Cards must not size to their data.** A feed that grows with its content cannot hold a
  column aligned. Let it absorb slack instead: `lg:flex-1 lg:min-h-0` with an internal
  scroller, so the layout sets the height. `min-h-0` is load-bearing, without it a flex
  child refuses to shrink below its content and the scroller never engages.
- **Prefer self-correcting layout over magic numbers.** The alert card resolves to exactly
  the height that levels the columns, at any position count.
- **No nested chrome.** Bordered, tinted rows inside a bordered, tinted card is chrome
  wrapping chrome. Use `divide-y` hairlines.
- **One primary action per card.** Compass had `Open position` *and* `Audit & simulate` on
  five cards: ten calls to action on one screen.

### Breakpoints measure the window, not your column

The trap that produced five separate layout bugs: Tailwind's `md:` fires at a 768px
**window**, but the content column is window minus a 256px sidebar minus padding. So `md:`
split cards when they were only 448px wide, crushing driver bars to 62px and ellipsising
titles to two letters.

When choosing a breakpoint, do the arithmetic on the **content column** and write it in a
comment. Container queries are the deeper fix and Tailwind v4 supports them natively; that
migration is a tracked follow-up.

---

## Accessibility floor

Non-negotiable, WCAG 2.2 AA.

- **Never encode state by colour alone** (SC 1.4.1, Level A). A risk band always carries a
  number or a word. Red/green is the worst possible pair for the commonest colour
  blindness, and it is the pair a risk dashboard reaches for first.
- **Text clears 4.5:1** against the lightest surface it can appear on.
- **Functional borders and focus rings clear 3:1** (SC 1.4.11).
- **`outline-hidden`, never `outline-none`.** In Tailwind v4 `outline-none` means
  `outline-style: none`, which removes the focus ring entirely in Windows High Contrast
  mode. There is one global `:focus-visible` rule; do not override it per-component.
- **Interactive things are buttons or links**, with real roles, `aria-label` where the text
  is not self-describing, and visible focus. A clickable `div` is not acceptable.
- **Tap targets >= 24px** (SC 2.5.8); 44px+ for primary mobile nav.
- **Watch for margin-as-whitespace.** `ml-2` between two spans makes a screen reader read
  `"outsideQueued"`. Use a real space.
- **The ARIA tabs pattern is implemented by hand** in `AppDemo.tsx` (roles, `aria-selected`,
  `aria-controls`, roving tabindex, arrows + Home/End). Exactly **one tablist is mounted at
  a time** via a `matchMedia` hook, not `hidden md:flex`: two mounted tablists duplicate
  every `tab-*` id the panels reference through `aria-labelledby`, and roving focus lands on
  the `display:none` copy. A CSS-only hide looks correct and is silently broken for keyboard
  users.

---

## Animation

**No pulsing. No live indicators.** All 18 `animate-pulse` / `animate-ping` were removed,
including every pulsating status dot. Founder rule, and a dashboard that throbs reads as
anxious rather than alive.

`Skeleton` may reserve layout during loading. Ship skeletons to prevent layout shift, which
is undisputed, **not** because they feel faster: the one controlled study
([Viget, n=136](https://www.viget.com/articles/a-bone-to-pick-with-skeleton-screens/))
found skeletons measured *worse* than a blank screen.

---

## Icons

**Never hand-draw an SVG icon.** Use [Lucide](https://lucide.dev) (already installed).

This is not a style preference. The protocol logos were improvised paths with comments like
`{/* Aave Ghost Arc */}`, and the Compound one was **not the Compound logo at all** — three
stacked bars where the real mark is a stepped chevron. Hand-drawn icons read as doodles
next to real ones.

Protocol brand marks live in `components/ProtocolLogo.tsx`, taken verbatim from
protocol-controlled sources with licence status noted in-file. Simple Icons carries none of
the four (verified). Marks are scaled **uniformly** onto a square canvas and padded, never
stretched, which Aave's brand guidelines explicitly require.

---

## Data honesty

The rules that exist because a UI lied:

- **Never state a fact the code does not know.** `Guard active` was a hardcoded string that
  rendered identically whether or not any alert channel could reach the user. In a
  liquidation alerter, manufacturing that belief is the worst available failure.
- **Never invent movement.** `+24 in the last 24 hours` measured the simulator sliders, not
  time, and when the delta was genuinely 0 it substituted a hardcoded `14/9/6/-2` by band.
- **Never show the same quantity twice with different numbers.** `Aggregate risk index`
  read 57 while `Risk index history` ended at 66, because they were weighted over different
  sets.
- **Never let a chart hide the thing it exists to show.** An auto-scaled y-axis (the
  series' own min/max) makes a 2-point drift look identical to a 20-point climb. Fix the
  domain to include the user's alert threshold, then pad.
- **One name per concept.** Two charts showed the same sub-score as `Health factor 55%` and
  `Collateral health 60%`, one of them rescaled in the component, both presented as fact.
- **Reuse the engine's math, and grep before you add to it.** `packages/scoring` owns
  scoring, money math and thresholds. If the UI needs a derived number, export it from the
  engine rather than recomputing it: `1 - 1/HF` lives in `prospective.ts`, not in a
  component. This rule got broken *while being invoked* — a second copy of that formula was
  added to the package without checking, and the two disagreed on invalid input, reporting a
  200% price drop where the original correctly returned "unknown". Search for the formula
  before writing it. **Thresholds are engine math too.** Compass partitioned its catalog on
  windows written in the component (`<20` / `20-49` / `>=50` by profile) while
  `ALERT_THRESHOLD` alerts at 25 / 50 / 75, so the grid recommended markets the watcher
  would fire on. `fitsProfile` is the engine's own membership test and delegates to
  `statusFor`, so the split and the alert read one boundary.
- **One rounding rule per quantity, and it belongs with the formula.** The Advisor card once
  showed `17%` in its strip and `17.4%` in prose one click away, because the UI and the
  engine formatted the same number differently. Formatting policy for a domain value is a
  product decision, so it lives in the engine beside the value.
- **A field named `value` holds a value.** Putting a clause in it (`"0%, liquidatable now"`)
  renders clipped the moment something applies `truncate`. Prose goes in a sub-line.

---

## Working on the UI

**Read this section before building or redesigning anything.**

### Before you start

1. **Read `src/index.css`.** It is the contract. If you want a value that is not there,
   that is a decision to raise, not a class to invent.
2. **Read the closest approved surface** and copy its shape.
   `components/LivePositions.tsx` is the reference for a data row; the Compass `MarketCard`
   in `AppDemo.tsx` for a card grid; the Portfolio tab for a page.
3. **Check `src/panik-core/ui/` and `lib/utils.ts`** for a primitive or helper that already
   does it. `RISK_CHIP`, `LIMIT_STATE`, `LIMIT_EVENT`, `liquidationOutlook`, `formatUsd`.

### While you work

- **Delete before you add.** Every element must carry information the user acts on.
- **Budget your colour.** Count the risk-hued elements on the screen. If it is more than a
  handful, cut.
- **Apply the three-way copy test** to every sentence.
- **No new dependencies.** The entire redesign added zero runtime dependencies.
- **Do not reimplement scoring, money math, or thresholds.**

### Before you claim it is done

Measure, do not eyeball. Every claim below was caught at least once by measuring something
an agent had asserted:

```
npm run lint          must be 0 errors
npm test              must pass
npm run test:scoring  must pass
npm run build         must succeed
```

Then, in a real browser:

- **`document.documentElement.scrollWidth === window.innerWidth`** at 390, 768, 1024, 1440
  and 2000. Not "looks fine".
- **0 console errors** on a clean load of every tab you touched.
- **Count the risk-hued elements** with a computed-style scan, and list them.
- **Confirm no text is below 11px** by measuring computed font sizes in the DOM, not by
  grepping source.
- **Confirm no raw enum value renders**, in visible text, `title`, and `aria-label`.
- **Tab through it.** Focus visible, order sensible, arrow keys where the pattern needs
  them.
- **Screenshot mobile (390) and wide (2000)**, not just your own window.

### Things that keep going wrong

- Fixing a symptom instead of the layout: shrinking text to stop a wrap, tightening
  truncation to hide an overflow. **Raising the type floor exposed rows that had only ever
  "worked" because the text was too small to read.** Fix the structure.
- A `git add -A` that sweeps screenshots into a commit. Stage explicit paths; root-level
  images are gitignored but do not rely on it.
- **Comments that narrate deleted code.** They are worse than useless: git already holds the
  old version, and the prose drifts into being false. One pass shipped a comment stating an
  internal scroller had been removed while the next commit re-added it, and another asserted
  a guard was needed directly above proving it dead. Keep the *why-it-is-this-way* sentence;
  delete the *what-it-used-to-be* paragraph and put it in the commit body.
- **Effect dependencies on polled arrays.** `usePolled` hands back a fresh array identity
  every tick, so `[highlightKey, positions]` re-ran a `scrollIntoView` + `focus()` on every
  60-second poll, jumping the page and stealing focus mid-read. Depend on the thing that
  actually changed.
- **Duplicating an engine constant "for now".** `COMPOSITE_WEIGHTS` got hardcoded in three
  UI sites, one with a comment reading "keep in sync if the engine weights change", and one
  of them renders inside a tooltip as "40% of the score". A re-weight in the engine would
  have the UI teaching a wrong number with nothing visibly broken. Import it.
- Colour or copy drifting between the app and the two landing-page dashboard replicas
  (`AppMockup.tsx`, `DashboardScrollPreview.tsx`), which duplicate the dashboard and were
  47 days stale before this work began.
- Trusting a report. Re-run the commands and read the diff.
