# PANIK design system

Decided 2026-08-25: neo-brutalist, light mode only. Dark mode is removed.

Scope: `src/panik-core` (the product app). The landing page (`src/panik-landing-page`) is
a marketing surface with its own looser conventions and is not held to all of this.

## Purpose

PANIK scores DeFi lending positions on Base (Aave, Compound, Moonwell) and warns
borrowers on Telegram before liquidation. A borrower opening this screen is deciding
whether to act, not browsing, so the UI's one job is legibility under stress.

The rule that makes the rest of this doc enforceable: `src/index.css`'s `@theme` block is
the only place a value may be defined. Everything else resets to `initial`, so an
off-token utility (`text-red-400`, `rounded-2xl`, a stray hex) renders as nothing and gets
caught in review instead of quietly shipping. A value that is not in the theme is a
decision to raise, not a class to invent.

## Reference surface

The app Portfolio tab (`src/panik-core/AppDemo.tsx`) is the reference. Every other
screen, Watch, Compass, Advisor, Alerts, and the landing page, matches its tokens,
spacing, and component choices. When in doubt, open Portfolio and copy its shape.

## Tokens

All in `src/index.css` under `@theme`. Never hardcode a value that has a token.

**Surfaces:** page `#F4F4EF` (base), insets and table headers `#EBEBE4` (sunken), cards
and panels `#FFFFFF` (raised), modals and popovers `#FFFFFF` (overlay).

**Text:** primary `#000000`, secondary `#4A4A4A`, muted `#6B6B6B`. Each clears 4.5:1 on
both the page ground and on white. `text-muted` is for things glanced at, not read; the
money line of a position row is never muted.

**Borders and radius:** structural border is always 3px solid `#000000` (border-strong):
cards, inputs, chips, focus ring. Hairline dividers inside tables use
`rgba(0,0,0,0.12)` (border-subtle) and make no contrast claim. Radius is 0 everywhere;
`rounded-full` exists only for avatars.

**Shadows:** hard, no blur, no transition; states snap. Rest is `6px 6px 0 #000` (`3px
3px 0 #000` for chips and other small elements). Hover: shadow 3px, translate(3px,
3px). Active: shadow none, translate(6px, 6px).

**Risk ramp**, 4 bands plus unknown, flat blocks with a 3px black border and black text,
never a gradient or tint: low `#22C55E`, elevated `#F59E0B`, high `#FF5C00`, critical
`#EF4444`, unknown white with a 45-degree black hatch (not a band: "we could not measure
this").

**Brand and chart colour:** cobalt `#2B5CFF` is the only brand accent, primary buttons
(white text), the active tab block, link underlines (3px), the focus ring. Lavender
`#D8CCFF` is the highlight: callouts, badges, hover fill on secondary buttons, black
text. The old brand orange is gone as an accent; it survives only inside
`--color-risk-high`, a coincidence worth watching, not a reason to reuse it. Chart series
use cobalt tints only, `#2B5CFF`, `#7D9BFF`, `#C2CFFF`, no red or green, so a series can
never be misread as a risk state.

## Colour

Two separate jobs. Do not conflate them.

**Risk colour is rationed.** A screen gets a handful of risk-hued elements, not a dozen;
measure the reference surface's count before adding one. Never colour a stat value, a
whole sentence, a verb, or an input based on what the user typed. A chip beside a number
carries the band; the number itself stays black.

**Categorical colour is data**, not decoration, and deleting it is also wrong.
Distinguishing cbBTC from WETH in an allocation chart uses the cobalt tint series above,
never the risk ramp.

## Type

Archivo (400/500/700/800/900) for everything. Space Mono (700, tabular) for every
numeral, percentage, money value, and address. Headlines are Archivo 900, uppercase,
tight tracking. Labels are Archivo 700, 12px, uppercase, letter-spacing 0.06em.

Scale, floor 11px: 2xs 11/16, xs 12/16, sm 14/20 (default), base 16/24, lg 20/28, 2xl
28/34, 4xl 40/44, display 64/64 (marketing only). Very little should sit at the floor.

## Spacing and radius

Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64.

Controls: buttons 48px tall (padding 0 20px), chips 28px, inputs 48px, sidebar 256px,
header 72px, table rows 56px, mark box 56px square with border and 6px shadow.

Radius is 0 everywhere, no exceptions besides avatars.

## Motion

None. No transitions, no pulsing, no live indicators. States snap between the rest,
hover, and active shadow positions above. Skeletons are hatched blocks that reserve
layout during loading; they prevent layout shift, not because they feel faster.

## Icons

Lucide only, 24 grid, stroke 2, coloured via `currentColor`. Never hand-drawn: no
improvised paths trying to depict a brush, an eye, or a lock. Protocol brand marks are
the one exception and live in `components/ProtocolLogo.tsx`, taken verbatim from
protocol-controlled sources.

## Components

In `src/panik-core/ui/`. Use these instead of hand-rolling equivalents.

| | |
|---|---|
| `Card` | bordered, shadowed panel |
| `Stat` | label + value + optional sub |
| `Button` | `primary` (cobalt fill), `secondary` (lavender hover fill), `ghost`; disabled is opacity 0.4 |
| `Chip` | neutral marker, no hue, no state |
| `RiskChip` | the band as a bordered block, wraps `RISK_CHIP` in `lib/utils.ts` |
| `RiskDial` | square bordered gauge: black needle, risk-coloured wedge |
| `EmptyState` | two tones, `clear` (nothing to report) and `problem` (could not load); never render them identically |
| `Skeleton` | hatched loading placeholder that reserves layout |
| `TabPanel` | the ARIA tabpanel wrapper |
| `Listbox` | the app's one dropdown: roving `aria-activedescendant`, arrows with Home/End, Enter to commit, Escape/Tab/outside-press to dismiss |
| `LAYER` / `SCRIM` | every z-index and backdrop, in `ui/overlay.ts` |

`RISK_CHIP` in `src/panik-core/lib/utils.ts` is the single place a band becomes pixels.
Do not write a risk border/fill combination by hand.

**Accessibility floor**, non-negotiable, WCAG 2.2 AA: never encode state by colour alone
(SC 1.4.1, a risk band always carries a word); text clears 4.5:1, functional borders and
focus rings clear 3:1 (SC 1.4.11, the 3px black structural border does this by
construction); `outline-hidden`, never `outline-none`, one global `:focus-visible` rule,
cobalt, 3px; interactive things are buttons or links with real roles and visible focus,
no clickable `div`; tap targets 24px or larger (SC 2.5.8), 44px or larger for primary
mobile nav; the ARIA tabs pattern (roles, `aria-selected`, `aria-controls`, roving
tabindex, arrows plus Home/End) is implemented by hand in `AppDemo.tsx`, and exactly one
tablist mounts at a time via a `matchMedia` hook, never `hidden md:flex`.

## Copy

Every piece of explanatory text gets one verdict: **keep inline** (it changes what the
user does), **move to `InfoTip`** (methodology, valuable on request), or **delete** (it
restates its heading, or is jargon with no referent). Bias: hover over inline, delete
over hover.

Never render an engine enum in visible text. `ProfileStatus` values go through
`LIMIT_STATE`/`LIMIT_EVENT` in `lib/utils.ts`. Health factor goes through
`liquidationOutlook()`, which leads with the price-drop buffer ("Liquidates if cbBTC
falls 4.8%") and keeps the exact ratio in the hover. Tickers keep their source casing;
never pass `cbBTC` through an uppercase transform.

**Data honesty:** never render an unknown value as a zero, `$0`, `0%`, and `Infinity%`
are forbidden stand-ins for "unknown" (a degraded feed once made a $120,000 debt read as
$40); never state a fact the code does not know, no hardcoded status strings, no
invented trends; never show the same quantity twice with different numbers; reuse the
engine's math, `packages/scoring` owns scoring, money math, and thresholds, export a
derived number from there rather than recomputing it in the UI, and grep for an existing
helper first.

## Never

No em dashes in copy. No emojis in product copy. No pulsing or live indicators. No
hardcoded colour values outside the token file; colours are tokens. No text below 11px.
No hand-drawn SVG icons; Lucide, Radix, or Simple Icons only. Never render an unknown
value as a zero. Never state a fact the code does not know. No new runtime dependencies
for UI. No colouring stat values, sentences, or verbs. No two cards showing the same
quantity with different numbers. No reimplementing scoring, money math, or thresholds
outside `packages/scoring`. No border-radius outside avatars. No blurred shadows. No
transitions.

## Verification checklist

Before claiming a screen is done:

```
npm run lint          0 errors
npm test              passes
npm run test:scoring  passes
npm run build         succeeds
```

Then, in a real browser, at 390, 768, 1024, 1440, and 2000px: confirm
`document.documentElement.scrollWidth === window.innerWidth`; zero console errors on a
clean load; count risk-hued elements with a computed-style scan and report the number
against the reference surface's count; confirm no text below 11px by measuring computed
font sizes in the DOM, not by grepping source; grep for raw enum values in visible text,
`title`, and `aria-label`; tab through the screen for visible focus, sensible order, and
arrow keys where the pattern needs them; screenshot at 390 and 2000px, and build a
before/after gallery for every touched area.
