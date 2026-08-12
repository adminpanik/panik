# PANIK — System Architecture & Smart Contract Design (v1.1)

> Companion to [`arch`](./arch) (the Risk Scoring Engine spec). That file defines **what** we compute;
> this file defines **how the system is built**, what goes on-chain vs off-chain, and — critically —
> **why we chose each option over its alternatives.**

> **v1.1 (2026-06-12):** aligned with the Protocol Camp plan from business dev. Headline changes:
> Protocol Camp scope = **risk scoring engine + Compass/Watch/Advisor, zero new Solidity** (§3.6, §6).
> All contract work is **parked** (§5.0) — an atomic-exit MVP already exists on Base Sepolia, and the
> new "position opening" scope is analyzed (and mostly de-contracted) in §5.6.

---

## 1. The Core Architectural Judgment

**PANIK v1 deploys (almost) no smart contracts. It is a client of other people's contracts.**

This is the single most important decision in the system, so the reasoning comes first:

| Consideration | On-chain scoring | Off-chain scoring (chosen) |
| --- | --- | --- |
| Volatility / correlation math | Infeasible (no floats, no 30d price history on-chain) | Trivial (numpy/JS math on cached API data) |
| Weight tuning (`arch` says "tune during build") | Every tune = redeploy + migration | Edit a config value, restart service |
| Data sources (CoinGecko, DefiLlama) | Would need oracles for *each* feed ($$$) | Free REST calls |
| Cost per score cycle | Gas × users × 60s cycles | ~zero |
| Trust requirement | None gained — users must still trust our *formula* | Same trust profile, honest about it |

Putting the scoring engine on-chain would buy us nothing (the formula and weights are ours either
way — an on-chain copy of a subjective formula is not "trustless") and cost us everything in
iteration speed. **Reading a blockchain requires no deployment, no gas, no permission.** We deploy
contracts only where logic must be *enforced* on-chain: access gating and (later) exit execution.

---

## 2. System Design — Full Picture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            USER (browser)                                   │
│   panik-core frontend (React/Vite, isolated bundle — see src/panik-core/)   │
│   wagmi/viem wallet connect → address + SIWE signature                      │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ HTTPS (REST/WebSocket)
┌──────────────▼──────────────────────────────────────────────────────────────┐
│                       PANIK BACKEND SERVICE                                 │
│                    (Node.js + TypeScript + viem)                             │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────────────┐    │
│  │ Position Reader │  │ Scoring Engine │  │ Alert Engine (Watch/Advisor)│    │
│  │ 60s poll cycle  │─▶│ (arch formula) │─▶│ band transitions → notify   │    │
│  └───────┬────────┘  └───────┬────────┘  └─────────────────────────────┘    │
│          │                   │                                               │
└──────────┼───────────────────┼───────────────────────────────────────────────┘
           │                   │
   JSON-RPC (eth_call)     HTTPS (REST/GraphQL)
           │                   │
┌──────────▼─────────┐  ┌──────▼──────────────────────────────────────────────┐
│  Base RPC node     │  │  Web APIs                                            │
│  (Alchemy free /   │  │  CoinGecko  → 30d price history (S_asset_risk)       │
│   Base public)     │  │  DefiLlama  → TVL series (S_systemic_risk)           │
│        │           │  │  Goldsky    → position indexing (scale phase only)   │
│  Multicall3 batch  │  │  Dune       → analytics/backfill (NOT live loop)     │
│        │           │  └──────────────────────────────────────────────────────┘
│  ┌─────▼────────────────────────────┐
│  │ EXISTING protocol contracts      │      ┌──────────────────────────────┐
│  │ (we read, never deploy these):   │      │ PANIK-DEPLOYED contracts     │
│  │  • Aave V3 Pool                  │      │ (the only Solidity we own):  │
│  │  • Moonwell Comptroller+mTokens  │      │  1. PanikAccessRegistry (v1) │
│  │  • Chainlink price feeds         │      │  2. PanikDeleverager   (v1.1)│
│  └──────────────────────────────────┘      │  3. SentinelManager    (v2)  │
└────────────────────                        └──────────────────────────────┘
```

Two communication mechanisms, total:
1. **JSON-RPC** (`eth_call` via viem) for live on-chain state — free, permissionless, no gas.
2. **HTTPS** for everything else — ordinary REST/GraphQL APIs.

---

## 3. Data Layer

### 3.1 Decision: RPC-first with Multicall3, indexers deferred

**Chosen:** poll protocol contracts directly via RPC every 60s, batching all reads for all users
into one `Multicall3.aggregate3()` call.

**Rejected (for v1): Goldsky/The Graph as the primary position source.**

Why:

- **Scale math.** 10 users × ~6 reads each = ~60 `eth_call`s per cycle → batched into **one**
  Multicall3 request per cycle = 1,440 RPC requests/day. Alchemy's free tier allows ~10–100× that.
  An indexer adds infrastructure (subgraph deploys, sync lag monitoring, failover logic) to solve a
  scale problem we will not have for months.
- **Freshness.** Direct RPC reads are head-of-chain. Subgraphs lag blocks; Dune lags **minutes**.
  For a liquidation monitor, freshness is the product.
- **One less trust/availability dependency** in the critical alert path.

When to revisit: >100 monitored wallets, or when we need *historical* position state (entry prices,
past liquidations) — that's when Goldsky earns its place, and the `arch` doc's application for the
Goldsky free tier should be timed to that milestone, not before.

### 3.2 Correction to `arch`: Dune is not a live-loop source

`arch` lists the failover order as *Goldsky → Dune → The Graph* for position data. **Dune cannot
serve a 60-second loop**: its API is asynchronous (submit → poll → fetch), credit-metered, and its
Base data lags minutes or more. Reclassify:

| Tier | Source | Role |
| --- | --- | --- |
| Primary | **RPC + Multicall3** | Live position state, 60s cycle |
| Failover | Goldsky subgraph | If RPC provider degrades (scale phase) |
| Failover 2 | The Graph | Same data, different operator |
| Analytics only | Dune | Liquidation history research, dashboards, backfill |

*(Raise with mentor — touches Q6.)*

### 3.3 External API roles (unchanged from `arch`)

- **CoinGecko** — 30d daily prices → `vol_30d`, `drawdown_90d`, `corr_btc`. Cache per-asset
  per-cycle; at 10 users the asset universe is ~5 tokens, so the 30/min free limit is comfortable.
- **DefiLlama** — sector + protocol TVL series → `S_systemic_risk`. Free, no key.
- **Chainlink (on-chain read)** — live prices via `latestRoundData()`, included in the same
  Multicall3 batch. Why Chainlink over CoinGecko for *live* price: it is the same oracle the
  protocols themselves liquidate against, so our risk math sees what the liquidator sees.

### 3.4 Protocol read map

| Protocol | Call | Returns | Gotchas |
| --- | --- | --- | --- |
| Aave V3 | `Pool.getUserAccountData(user)` | 6×uint256; `healthFactor` last (÷1e18) | **Zero-debt → HF = `type(uint256).max`**; special-case `totalDebtBase == 0` before the HF formula or `S_position_health` ingests garbage. Collateral/debt are in **8-decimal USD base units**. |
| Aave V3 | `Pool.getUserReserveData(asset, user)` (per reserve) | per-asset breakdown | Needed for `S_asset_risk` (which token is collateral). Batch via Multicall3. |
| Moonwell | `Comptroller.getAssetsIn(user)` | entered markets list | This is position *discovery* — loop only these mTokens. |
| Moonwell | per mToken: `borrowBalanceStored`, `balanceOf` × `exchangeRateStored` | balances | No native HF — derive per `arch` formula. Exchange-rate truncation: use `Stored` (view) in the read loop, accept ≤1-block staleness. |
| Chainlink | `Aggregator.latestRoundData()` | price, updatedAt | Check `updatedAt` staleness (>1h on a 24h-heartbeat feed = degrade alert, don't score on stale price). |

**Address book** (verify against official docs at integration time; Base mainnet):

```
Aave V3 Pool        0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
USDC (native)       0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Multicall3          0xcA11bde05977b3631167028862bE2a173976CA11   (same on every chain)
Moonwell Comptroller / mTokens / Chainlink feeds → pull from official docs, pin in config
```

### 3.5 Decision: backend language — Node.js + TypeScript + viem

**Rejected: Python (web3.py) for the live service.**

- The frontend is already TypeScript; sharing types for `PositionState`/score payloads end-to-end
  eliminates a whole class of serialization bugs.
- **viem** is the best-maintained EVM client library today (typed ABIs, first-class Multicall3,
  same library wagmi uses in the frontend — one mental model).
- Big-number safety: viem returns `bigint` natively; web3.py's Decimal handling is fine but the
  team would maintain two stacks.
- The `arch` doc's pseudocode is Python-flavored, but nothing in it requires Python — `std_dev`,
  `pearson_corr`, `clamp` are ten lines of TS.
- **Carve-out:** the v2 ML layer (XGBoost/LightGBM) *should* be Python — run it as a separate
  sidecar service with a narrow JSON contract when it exists. Don't let a future model choice
  dictate today's I/O service language.

### 3.6 Scoring engine service design — one pure core, two adapters (dual-mode)

The Protocol Camp plan correctly flags dual-mode scoring as a **week-1 architecture decision**
(its "Risk 2": getting this wrong forces a week-6 rebuild). The resolution: **the scoring core
never does I/O.** It is a set of pure functions over one typed input struct; *where* the inputs
came from is an adapter concern.

```
                      ┌─────────────────────────────────────────────┐
                      │  SCORING CORE — pure functions, no I/O      │
                      │  computeScore(input: ScoringInput) → Result │
                      │  clamp, std_dev, pearson_corr, 4 sub-scores │
                      └──────────────────▲──────────────────────────┘
                                         │ ScoringInput (one typed struct)
            ┌────────────────────────────┴───────────────────────────┐
            │                                                        │
  ProspectiveAdapter (Compass)                          ActiveAdapter (Watch)
  input: protocol, asset, LTV%, amount                  input: wallet address
  HF = scenario estimate:                               HF = read from chain:
    (collateral × liq_threshold) / borrow                 Aave getUserAccountData /
                                                          Moonwell derived (per arch)
            │                                                        │
            └────────────────┬───────────────────────────────────────┘
                             │ both consume the SAME cached context
              ┌──────────────▼───────────────────────────┐
              │ Context providers (refresh per 60s cycle)│
              │  AssetRiskProvider    ← CoinGecko (30d)  │
              │  ProtocolSafetyConfig ← static table     │
              │  SystemicRiskProvider ← DefiLlama TVL    │
              └──────────────────────────────────────────┘
```

Why dual-mode is cheap when built this way: **three of the four sub-scores are
position-independent.** `S_asset_risk` is per-asset, `S_protocol_safety` per-protocol,
`S_systemic_risk` global — computed once per cycle, cached, shared by both modes. The *only*
mode difference is the source of `S_position_health`'s inputs: a hypothetical (Compass LTV
slider) vs a chain read (Watch). That is an adapter swap, not an engine fork.

Consequences:

- **Prospective mode needs zero chain integration** — it runs on CoinGecko + DefiLlama + the
  static config. Compass can demo before a single RPC call exists (de-risks Slice 1 entirely).
- Edge cases live in the adapters, keeping the core exhaustively unit-testable: zero-debt →
  `S_position_health = 0` (the Aave `uint256.max` gotcha, §3.4); stale Chainlink price →
  degrade, don't score; Moonwell `shortfall > 0` → HF < 1.0 clamped into Critical math.
- **Packaging:** standalone, frontend-agnostic package (`packages/scoring/` or
  `services/scoring-engine/`) — pure TS, no React imports, exporting `computeScore` +
  `ScoringInput`/`ScoreResult` types. `panik-core` consumes the types from day one so the
  mockup's `calculateDynamicPosition` is later a drop-in swap.
- **Golden tests come free from `arch`:** protocol safety must compute Aave ≈ 11 / Moonwell ≈ 46;
  HF 1.0/1.5/2.0 must land in the documented bands; `S_systemic_risk` ≈ 0 on stable TVL data.

**Calibration policy (reconciling biz-dev Risk 1 with `arch` line 236).** The mentor's "no
historical validation required" and the biz doc's "stress-test against USDC depeg/FTX/May-2021"
are reconciled as: a **timeboxed week-1 calibration spot-check** — pull ~5–10 liquidated Aave V3
positions on *Ethereum mainnet* (Base did not exist during those events) via Dune (its §3.2
analytics role), hand-feed pre-event state into the formula, confirm they score High/Critical.
Output = tuned `HF_CEIL`/`VOL_CEIL` (the parameters `arch` already says to tune) — **not** a
blocking validation gate and **not** ML.

---

## 4. Identity & Wallet Model

### 4.1 What "connect wallet" actually does

Nothing on-chain. Connection = the user disclosing their **address** to the app. No transaction,
no gas, no approval, no access to funds. All position data is public; technically we could score
any address typed into a box (this is how DeBank/Zapper work).

### 4.2 Decision: require SIWE before binding a wallet to an account

**Chosen:** Sign-In with Ethereum (EIP-4361) — a free, gasless message signature verified
server-side — before we associate `wallet ↔ email/alerts`.

**Rejected: trusting the connected address.**

Why: connection proves *possession of a browser extension*, not ownership. Without SIWE, anyone
could register a stranger's whale wallet and receive alerts about (and social engineering material
from) someone else's positions. The signature closes this for zero cost and zero gas. A message
signature **cannot** move funds — it is proof, not permission.

### 4.3 The non-custodial guarantee (architecturally enforced)

| Action | PANIK can | PANIK cannot |
| --- | --- | --- |
| Connect | learn the address | see anything private (addresses are public) |
| SIWE | verify ownership | move funds (signatures ≠ approvals) |
| Watch/score/alert | read public chain state | anything requiring permission — reads need none |
| Exit (v1.1) | *propose* a transaction | execute it — the user signs, and can reject |

The honest worst case if PANIK's backend is fully compromised: **leaked email↔wallet associations
(privacy incident), zero stolen funds** — there is no key, no approval, no custody to steal. This
is a property of the architecture, not a promise. (`arch` line 238 made the claim; this design is
what makes it true.)

---

## 5. Smart Contracts (what we actually deploy)

### 5.0 STATUS (2026-06-12): all contract work PARKED for Protocol Camp

Protocol Camp scope (per the business plan) is the scoring engine + Compass/Watch/Advisor —
**no new Solidity is required for the 12-week cohort.** Two facts update the roadmap below:

1. **An atomic-exit MVP already exists on Base Sepolia** (pre-dates this doc). The
   `PanikDeleverager` design in §5.3 is therefore a *hardening/audit target for that existing
   contract* when exit returns to scope — not a from-scratch build. Sequencing in §6 updated.
2. **"Position opening through Panik" is new candidate scope** from the business plan — analyzed
   in §5.6; conclusion: mostly achievable with **no contract at all** (direct protocol calls).

The remainder of §5 stands as the agreed design for when contract work resumes.

### 5.1 Scope discipline

Three contracts across the roadmap. Each exists because its logic **must** be enforced on-chain;
nothing else qualifies:

| Contract | Phase | Justifying requirement |
| --- | --- | --- |
| `PanikAccessRegistry` | v1 | `arch` line 239: "Allowlist (10 users) + position cap enforced at contract level, not frontend" |
| `PanikDeleverager` | v1.1 | Critical band: "exit offered" needs an execution path |
| `SentinelManager` | v2 | Auto-exit needs standing, on-chain-scoped authority |

**Rejected: a "score oracle" contract** (posting scores on-chain). It would add gas costs and a
deployment artifact while making nothing trustless — the formula and weights remain ours. If an
accelerator requires an on-chain component, the registry is the honest artifact to show.

### 5.2 `PanikAccessRegistry` (v1)

```solidity
contract PanikAccessRegistry is Ownable2Step {     // owner = team Safe
    uint256 public constant MAX_USERS = 10;
    uint256 public maxPositionUsd;                  // 8-dec USD (Chainlink convention)
    mapping(address => bool) public allowed;
    uint256 public userCount;

    function addUser(address user) external onlyOwner;   // reverts at MAX_USERS
    function removeUser(address user) external onlyOwner;
    function setPositionCap(uint256 capUsd) external onlyOwner;
}
```

- Two consumers: backend reads `allowed[wallet]` (advisory gate for Watch); the Deleverager
  enforces it in a modifier (the trustless part — the part a frontend can't fake).
- **Why a separate contract** instead of folding into the Deleverager: it lets the beta gate ship
  in v1 *before* the executor exists, and survives a Deleverager redeploy unchanged.
- ⚠️ **Open question (add to mentor list):** does "position cap" mean max position **size (USD)**
  or max position **count** per user? Speced as size; one modifier changes either way.

### 5.3 `PanikDeleverager` (v1.1) — the "exit offered" path

**Chosen pattern: stateless periphery contract** (same family as Aave's official deleverage
adapters). Holds nothing between transactions; user signs each exit at alert time with a
just-in-time approval.

**Rejected alternatives, and why:**

| Alternative | Why rejected |
| --- | --- |
| Vault model (users deposit into PANIK, we manage) | Violates non-custodial (line 238) outright; turns us into a fund; 100× audit/regulatory surface |
| Standing approvals + keeper in v1 | This *is* the v2 sentinel — standing authority over user collateral is a deliberate, opt-in trust upgrade, not a v1 default |
| No contract — frontend builds raw multicall txs | Can't atomically flashloan; can't enforce allowlist/cap on-chain (violates line 239); no on-chain slippage/HF guards |

Execution flow (single user-signed tx):

```
executeExit(ExitParams p)  [onlyAllowed, underCap]
 1. Flash-borrow p.debtAsset
      → Morpho / Balancer vault (0-fee on Base); Aave flashLoan (0.05%) fallback
 2. Repay user's debt
      Aave:     POOL.repay(p.debtAsset, p.repayAmount, 2, p.user)
      Moonwell: mToken.repayBorrowBehalf(p.user, p.repayAmount)
 3. Pull collateral via JIT approval (granted this session, this amount)
      Aave:     aToken.transferFrom(user) → POOL.withdraw()
      Moonwell: mToken.transferFrom(user) → mToken.redeem()
 4. Swap collateral → debt asset (0x/1inch calldata passed in;
      on-chain minOut check — NEVER trust router calldata for slippage)
 5. Repay flashloan; sweep ALL remainder to p.user
 6. Invariant: contract token balances == 0 after every path
```

Design decisions inside the flow:

- **`repayAmount` is a parameter, not "everything."** The Advisor already computes partial repay
  targets ("repay $X → HF 1.75"); the contract must execute exactly that. Full exit is the
  degenerate case, not the only case.
- **Flashloan source: Morpho/Balancer first** — 0-fee on Base vs Aave's 0.05%. On a $5k exit
  that's $2.50 of pure user savings per exit; fallback to Aave keeps liveness.
- **Why an external flashloan at all:** Moonwell (Compound V2 fork) has **no native flashloans**;
  one external liquidity source gives both protocols a uniform code path (one core, two adapters).
- **On-chain HF guard:** revert if post-exit HF would be *worse* than pre-exit. Protects users
  from malformed calldata (including our own bugs). Reuses the `arch` Moonwell HF derivation.
- **JIT approval cost:** exit = 2 signatures (approve + execute), or 1 with `permit` where the
  aToken supports it. Acceptable for a manual emergency action; removing this friction is
  precisely v2's job.

### 5.4 `SentinelManager` (v2 — design ahead, do not build)

Auto-exit ("flash-repay at HF < 1.25", as the app mockup simulates) requires exactly three new
things, each a trust-surface expansion:

1. **Standing authority** — persistent, scoped approvals/credit delegation to the executor.
2. **A keeper** — Chainlink Automation / Gelato to fire the trigger (liveness obligations).
3. **On-chain trigger config** — per-user `autoExitHF` thresholds.

Why not pre-build hooks in v1: speculative generality in the one contract that touches user
collateral is how audits get expensive and exploits get subtle. The v1→v2 seam is clean: the
Deleverager's execution core is reused; `SentinelManager` becomes a new *caller* holding
delegations. Note the keeper never needs the PANIK score on-chain — the trigger condition (HF
threshold) is already protocol-native data. Scoring stays off-chain forever.

### 5.5 Contract engineering standards

- **Foundry**, Solidity `^0.8.24`, OpenZeppelin 5.x.
- **No proxies, no upgradeability.** For a trust-product, immutability *is* the feature; an
  admin-upgradeable deleverager is a rug vector and reviewers will say so.
- **Fork tests against Base mainnet** (`vm.createSelectFork`) hitting real Aave/Moonwell/Morpho —
  non-negotiable. Mocks lie about mToken exchange-rate accrual and Aave interest modes.
- Test priorities: statelessness invariant (zero balances after every path), fuzzed partial exits
  across HF ranges, Compound V2 `redeem` rounding edges, slippage-revert paths, allowlist/cap
  bypass attempts.
- **Audit budget goes to the Deleverager** — it is the only contract that can lose user money.
  The registry is ~40 lines of Ownable; community review suffices.
- Rollout: Base Sepolia → Basescan verification + published source → mainnet behind the
  Critical-band button.

### 5.6 Position opening (new biz-dev scope) — mostly NOT a contract

The business plan adds "user opens a position through Panik; Panik's contract executes on the
protocol directly." Mechanics analysis before anyone writes Solidity:

| Action | Routable via a Panik contract? |
| --- | --- |
| Aave supply | ✅ Easy — `supply(..., onBehalfOf=user)`, aTokens land in user's wallet |
| Aave borrow | ⚠️ Needs credit delegation (`approveDelegation`) — an extra user signature |
| Moonwell supply | ⚠️ Awkward — Compound V2 has no `mintBehalf`; router mints, then transfers mTokens |
| Moonwell borrow position | ❌ **Not routable** — `enterMarkets` and `borrow` must be called by the user's own address; no on-behalf mechanism exists |

**Chosen approach: direct protocol calls.** The frontend (wagmi/viem) builds the calldata; the
user signs a transaction **straight to the protocol**. Same one-click UX, position lands in the
user's wallet, works identically on both protocols, zero new Solidity, zero audit surface.

**Rejected (for now): an opening router contract.** Only justified for multi-step *atomic* opens
(supply+borrow in one tx) — feasible on Aave only, impossible for Moonwell borrows regardless.
If atomic leveraged opens become a requirement, scope an Aave-only router then.

This finding amplifies the business plan's own "Risk 3" (Moonwell underestimated): the week-1
Moonwell assessment must cover the **write path** (opening), not just reads — reads are
well-bounded (§3.4).

---

## 6. Build Order (v1.1 — aligned to Protocol Camp slices)

Protocol Camp (12 weeks, no new Solidity):

```
Slice 1 (wk 1–3)   Scoring core + golden tests (arch steps 1–6) — pure TS, no chain reads
                   ├─ Week-1 calibration spot-check (§3.6) → tune HF_CEIL / VOL_CEIL
                   ├─ Week-1 dual-mode architecture locked (§3.6) — biz Risk 2 closed
                   └─ ProspectiveAdapter → Compass recommendations (no RPC needed)
Slice 2 (wk 4–6)   ActiveAdapter: viem + Multicall3 (Aave first, then Moonwell reads)
                   ├─ SIWE auth + wallet binding in panik-core
                   ├─ Position opening via DIRECT protocol calls (§5.6 — no contract)
                   └─ Watch loop live: 60s cycle → profile bands → alerts
Slice 3 (wk 7–10)  Advisor recommendation engine (4-section format; new data: Aave
                   governance feed, utilization trends)
Slice 4 (wk 10–12) Polish, 10 external users, demo
```

### Backend hosting: Railway, not Vercel serverless

The Node backend runs as long-lived services on **Railway**, not Vercel functions.
Vercel serverless is a poor fit for the scoring backend: it needs viem + Multicall3
RPC (which fights esbuild bundling), is capped at 30s, and cannot hold the warm
score/compass caches. Two Railway services run from this repo (Postgres stays on
Supabase):

- **panikrisk-scoring (web)** - `scripts/api-server.ts` via `npm run start:api`.
  The Express server exposes ALL `/api` routes (scores, positions, compass,
  prospective, chain, profiler start/result, telegram link + webhook). It reads
  `PORT` from Railway, supports CORS (`CORS_ORIGINS`) for a cross-origin SPA, and
  can optionally serve the built SPA itself (`SERVE_STATIC=true`).
- **panik-watch-worker (worker)** - `scripts/watch-worker.ts` via `npm run worker`,
  the 24/7 scoring + Telegram dispatch loop.

The frontend stays a static build (Vercel CDN) with `/api/*` rewritten to the
panikrisk-scoring public domain, or is served directly by the web service with
`SERVE_STATIC=true`. The `api/*.ts` Vercel functions remain in the repo as a
fallback but are superseded by the Express routes. Build/run config:
`Dockerfile`, `railway.toml`, `Procfile`.

### Watch delivery split (Slice 2/3): standalone worker + serverless webhook

The 60s Watch loop runs as a **standalone Node worker** (`scripts/watch-worker.ts`,
`npm run worker`), NOT on Vercel: scoring needs viem + Multicall3 RPC, which we
deliberately keep out of the serverless bundle (that bundle is fetch-only by
design - see the profiler functions). The worker scores via the same
`ActiveAdapter` the dev api-server uses, persists `score_snapshots` (on change +
15-min heartbeat) and `watch_transitions`, then a second in-process loop drains
the unnotified queue and sends Telegram.

Delivery is **persist-then-dispatch**: `onTransition` only writes a
`watch_transitions` row (`notified_at` NULL); a separate poller sends and stamps
`notified_at`/`notify_channel`, so a crash between scoring and sending never
drops an alert (the row is re-picked on restart). Restart dedupe is handled by
seeding `WatchService.lastStatus` from the persisted transition tail. Anti-spam
(confirmTicks debounce, per-position cooldown, materiality filter) lives at the
delivery layer in `ALERT_POLICY`, never touching the score. The Telegram link
flow (deep-link mint + `/start` webhook) runs as fetch-only Vercel functions
under `api/telegram/`. Full design: `docs/technical-docs/TELEGRAM_ALERTS.md`.

Recovery rows (`to_status = 'within'`) travel the same path: they are persisted
by `onTransition` like any other transition and dispatched by the same poller,
which sends the all-clear (P2 7.2) when `decideSend` allows it and stamps
`skipped` when there is no alert to resolve. The rate limit is one more layer in
`decideSend`, not a second policy.

The one piece of an alert that is NOT persist-then-dispatch is the "why now"
line (P2 7.1): its triggers are derived at send time from the worker's in-memory
`ActiveScore` for that leg, so after a restart a queued row still sends, minus
that line. Deliberate - the enrichment is best-effort and omitting it costs a
sentence, while persisting it would cost a schema column for something the next
tick regenerates in 60s.

Post-camp (contract work resumes, in order):

```
P1.  PanikAccessRegistry — if line-239 enforcement is still required (open question Q11)
P2.  Existing exit MVP → §5.3 hardening: fork tests, partial-repay support, HF guard,
     0-fee flashloan source, audit → mainnet ("exit offered" at Critical goes live)
P3.  (v2) SentinelManager + keeper; ML sidecar
P4.  Vault architecture — ⚠️ see Q13 before treating this as committed roadmap
```

---

## 7. Decision Log (summary)

| # | Decision | Chosen | Rejected | One-line why |
| --- | --- | --- | --- | --- |
| 1 | Scoring location | Off-chain service | On-chain oracle | Floats/history/tuning infeasible on-chain; zero trust gained |
| 2 | v1 position data | RPC + Multicall3 | Goldsky/Dune primary | 1 batched call per cycle at 10 users; freshest data; less infra |
| 3 | Dune's role | Analytics/backfill only | Live failover (per `arch`) | Async API, minutes of lag — can't serve a 60s loop |
| 4 | Backend stack | Node + TS + viem | Python/web3.py | Shared types with frontend; viem/wagmi one mental model; ML stays a v2 Python sidecar |
| 5 | Live price | Chainlink (on-chain read) | CoinGecko live | Score against the same oracle the liquidator uses |
| 6 | Wallet binding | SIWE signature | Trust the connection | Connection ≠ ownership; signature is free and can't move funds |
| 7 | Custody model | Stateless periphery, JIT approvals | Vault / standing approvals | Non-custodial is the product promise; worst-case = privacy leak, not fund loss |
| 8 | Flashloan source | Morpho/Balancer (0-fee), Aave fallback | Aave only | Free money for users; uniform path covers flashloan-less Moonwell |
| 9 | Upgradeability | None (immutable) | Proxies | Admin-upgradeable executor = rug vector; immutability is the trust feature |
| 10 | v1 automation | Manual user-signed exit | Keeper auto-exit | Standing authority is an opt-in v2 trust upgrade, not a default |
| 11 | Dual-mode scoring | Pure core + 2 adapters | Mode-aware engine | 3 of 4 sub-scores are position-independent; mode = adapter swap (§3.6) |
| 12 | Position opening | Direct protocol calls (frontend-built) | Opening router contract | Moonwell borrows aren't routable at all; direct calls = same UX, zero Solidity (§5.6) |
| 13 | Historical calibration | Timeboxed wk-1 spot-check (tune params) | Blocking validation gate / ML | Honors mentor's "no validation required" while closing biz Risk 1 (§3.6) |

---

## 8. Open Questions (additions to `arch` mentor list)

- **Q8:** "Position cap" (line 239) — max position **USD size** or **count** per user? (§5.2)
- **Q9:** Confirm Dune reclassification to analytics-only; live failover becomes RPC → Goldsky →
  The Graph. (§3.2, touches Q6)
- **Q10:** Does Protocol Camp require a deployed on-chain artifact for v1? If yes, the
  AccessRegistry is the honest one to present — not a score oracle. (§5.1)
- **Q11:** Is `arch` line 239 ("allowlist + position cap enforced at contract level") still a
  requirement? The Protocol Camp plan never mentions it. If dropped, the AccessRegistry may not
  ship at all. (§5.2, §6 P1)
- **Q12 (biz dev):** "Position opening through Panik's contract" is not technically possible for
  Moonwell borrow positions (§5.6). Confirm direct-call opening satisfies the product intent, and
  that demo copy doesn't promise contract-routed opens.
- **Q13 (biz dev / strategic):** The post-camp "vault architecture" contradicts the non-custodial
  trust story this doc enforces (§4.3, §5.3 rejected-alternatives). "Panik never holds funds" is
  the differentiator; a vault is a different company. Price that before it calcifies into roadmap.
