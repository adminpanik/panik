# Phase 2: AI Advisor + Atomic Exit (shipped 2026-07-20)

Two features, one interlock: the Advisor decides, the Exit/Open flows execute.

## 1. AI Advisor

**Logic: the deterministic engine decides, the LLM only narrates.** Same
contract as the wallet profiler ("LLM narrates, never classifies").

### Engine (`packages/scoring/src/advisor/`)
- `rules.ts` - severity-ordered decision table, first match wins:
  | # | Condition | Action |
  |---|---|---|
  | 1 | band CRITICAL (HF floors / crash regime from params.ts) | EXIT (critical) |
  | 2 | HF <= 1.25 AND assetRisk >= 60 (defensive catch) | EXIT (critical) |
  | 3 | band HIGH or outside profile, with debt | REDUCE (repay plan) |
  | 4 | approaching + protocol stress (safety >= 60 or TVL flight) | REBALANCE |
  | 5 | approaching / outside with no lever | MONITOR |
  | 6 | otherwise | HOLD |
- `repayMath.ts` - wallet-funded partial repay: `R = D * (1 - HF/target)`;
  targets per profile: conservative 2.0, moderate 1.75, aggressive 1.5;
  repay > 90% of debt promotes REDUCE to EXIT.
- `opportunities.ts` - OPEN scanner: prospective-scores every MARKETS entry
  sized to the profile target HF, keeps only "within profile", ranks by APY
  with a wallet-history familiarity boost, suppresses conflicts with EXIT legs.
- `insights.ts` - projects the profiler classification (Dune history) into
  the personalization view (`walletInsights`).
- `fallback.ts` - deterministic 4-section templates (POSITION / MARKET /
  RECOMMENDATION / EXECUTION). This defines the docs' "4-section format".
- `providers/advisorNarrator.ts` - OpenRouter Gemini narration (temp 0.3,
  JSON mode); any failure returns the deterministic sections.
- Tests: `packages/scoring/tests/advisor.test.ts` (33 tests). Note: this fix
  also added `packages/scoring/vitest.config.ts` - the package's tests were
  previously not picked up by any runner.

### API + data
- `GET /api/advisor?wallet=&profile=` (scripts/api-server.ts): positions
  (shared 60s cache) -> rules -> insights -> opportunities -> narration
  (4s time-box, non-HOLD legs + top opportunity) -> 5-min cache. Emits
  `changeToken` for popup diffing; appends action CHANGES to
  `public.advisor_events` (migration `20260719000001_advisor_events.sql`,
  90d retention in the nightly cron).
- `GET /api/morpho/market?symbol=` - deepest Base USDC market params for the
  in-app Morpho open (official Morpho API, 1h cache).

### UI (src/panik-core/)
- `components/AdvisorPanel.tsx` - replaces the Coming Soon tab body (which
  remains the offline/no-wallet fallback): overall banner + insights line,
  per-leg cards with the 4 sections + numbers strip, top-3 OPEN cards.
- `components/AdvisorPopup.tsx` - floating notification on any tab. Fires on
  leg-action changes, crash-regime tags, or new opportunities; 30-min
  cooldown per (protocol, action), dismissals persist until the action
  changes, critical EXIT bypasses cooldown. Click-through opens the
  ExitFlow/OpenFlow prefilled. State in `localStorage.panik_advisor_popup_v1`.
- `useAdvisor` hook in `lib/live.ts` (60s poll, offline-graceful).

## 2. Atomic Exit (executor repo: `C:\Users\ASUS\Desktop\Panik`)

### Contracts (breaking ABI, Phase 0 entrypoints removed)
`atomicExit(ExitTypes.ExitLeg[] legs, uint256[] uniswapTokenIds)` - amounts:
`0` = skip, `uint256.max` = full, else exact cap. Individual exit = one leg.
- New adapters: `MoonwellAdapter` (repayBorrowBehalf/redeem + shortfall
  assert), `CompoundV3Adapter` (supplyTo repay, withdrawFrom via
  `comet.allow`), `MorphoAdapter` (repay by shares for exact close,
  withdrawCollateral via `setAuthorization`).
- `LockChecker.getLockedLegs` - multi-protocol pre-flight (Aave frozen/
  cooldown/liquidity, Moonwell cash, Comet pauses; Morpho never locks).
- Wallet-funded repay model (user holds the debt asset); flash-loan
  self-funding is Phase 3.
- Tests: `test/executor.spec.ts` - 23 mock tests (all protocols, partial
  semantics, guards). `test/fork/mainnet.fork.spec.ts` - **Base mainnet fork
  proof**: deployed the real stack against live Aave/Moonwell/Comet/Morpho
  and partially repaid REAL borrowers (validation-registry wallets),
  asserting HF improvement. Run:
  `BASE_MAINNET_RPC=<url> npx hardhat test test/fork`
  (public `https://mainnet.base.org` works; the Alchemy key was over its
  monthly cap on 2026-07-20 - see Ops note below).

### Deployment (Base Sepolia, 2026-07-20)
Executor `0xfaae2d3bdbAB24D645C71618eacCA7A3c81c65cf`; full addresses in
`deploy/addresses.base-sepolia.json`. Slippage floors now REAL (9500 bps;
the deploy script rejects anything < 9000 - the old `[1,...]` config is
impossible to redeploy). `deploy/onchain-config.json` feeds the frontend.

### App integration (src/panik-core/)
- `providers/AppProviders.tsx` now mounts wagmi + react-query (app bundle
  only; landing bundle verified unchanged).
- `lib/exit.generated.ts` - synced via `npm run sync:exit-config`.
- `components/ExitFlow.tsx` - connect -> switch chain -> load + LockChecker
  pre-flight -> review (wallet-funded USDC requirement surfaced) -> exact
  approvals (+2% buffer, never infinite) -> simulate -> execute -> receipt
  (decodes `ExitCompleted`). No hardcoded gas anywhere.
- **Honesty gate**: `EXIT_ENV=testnet` (default while chainId != 8453) shows
  TESTNET badges + a banner that execution targets the wallet's real Base
  Sepolia position, never a fake mirror. On testnet only Aave legs are
  executable (Moonwell/Comet/Morpho have no Sepolia demo deployments; their
  correctness proof is the fork suite). Mainnet cutover = mainnet deploy +
  `sync:exit-config` + `VITE_EXIT_ENV=mainnet`. **Audit before real funds.**

## 3. In-app position opening (Base MAINNET, live now)

Opens are plain protocol transactions signed by the user's own wallet - no
PANIK contracts in the path (same trust model as the protocol's own app).
- `lib/openProtocols.ts` - step builders for all 4 protocols; canonical
  addresses (fork-verified for Aave/Comet/Moonwell); on-chain sanity checks
  (comet.baseToken, mToken.underlying, market collateral match) run before
  any funds move; USD -> token conversion via the live Aave oracle.
- `components/OpenFlow.tsx` - editable sizing with live projected PANIK
  score (`/api/prospective`), borrow capped at the profile target HF, every
  step simulated then signed; receipt registers the wallet into Watch.
- Morpho market params resolved at runtime from `/api/morpho/market`.

## Verification status (2026-07-20)
- scoring: 169/169 tests green (incl. 33 advisor).
- executor: 23/23 mock tests; fork suite green for Aave + Moonwell real
  borrowers (Comet needs `FORK_COMET_USER` - no stable default borrower).
- `/api/advisor` + `/api/morpho/market` smoke-tested live.
- App build green; `npm run lint` red only on the 3 pre-existing
  panik-founding viem-typing errors (unchanged).
- Sepolia deploy verified on-chain (`getSwapConfig` minOutBps = 9500).

## Ops note (found during Phase 2)
The `ALCHEMY_API_KEY_BASE_MAINNET` key hit its MONTHLY capacity limit on
2026-07-20 - live scoring reads (api-server + watch worker) are failing until
the key is upgraded or rotated. This predates Phase 2 and affects production
scoring, not just tests.

## Deferred / follow-ups
- Executor audit before mainnet deploy + real-funds exits.
- Flash-loan (collateral-funded) deleverager - Phase 3; the math is already
  exported (`collateralFundedRepayToTargetHf`).
- `onlyEOA` blocks smart-contract/AA wallets - revisit pre-mainnet.
- Comet/Morpho boolean grants: post-exit revoke UX exists as guidance text;
  one-click revoke buttons on the receipt screen are a fast follow.
- Exit buttons on Portfolio/Watch position cards (Advisor + popup are the
  entry points today).
- The executor repo's own `frontend/` is deprecated (still on the Phase 0 ABI).
