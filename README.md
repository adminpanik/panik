# PANIK

> Liquidation insurance you can read before the crash.

PANIK scores DeFi lending positions for liquidation risk and warns borrowers early enough to act. A wallet is scored across four dimensions — position health, asset volatility, protocol safety, and market regime — into one 0–100 number and a risk band, checked every 60 seconds against the live chain. When a position crosses the threshold for the borrower's stated risk profile, PANIK sends a Telegram alert with a concrete instruction: repay this much, or move this collateral here.

The engine is calibrated against real black-swan events — the June-2022 ETH crash, UST/LUNA, FTX, the USDC depeg, and August-2024 — across Aave v3, Compound v3, Moonwell, and Morpho on Ethereum and Base.

## 🧩 Problem

Liquidation is the most expensive event in DeFi borrowing, and it is almost always preventable. The information needed to avoid it exists on chain and is free to read — but it arrives in a form nobody can act on.

- **Liquidation penalties run 5–15% of the seized collateral**, charged on top of losing the position. On Aave v3 Base, a $100k position liquidated at a 7.5% bonus hands $7,500 to a bot for a transaction the borrower could have front-run with a $2,000 repayment.
- **Health factor is a terrible alarm.** It is a ratio, not a forecast. HF 1.4 sounds comfortable and is roughly 29% of a price move away from liquidation; HF 1.05 is 5% away. The number moves non-linearly with price, and borrowers read it linearly.
- **Protocol dashboards show state, not risk.** They tell you what your position is right now. They do not tell you that your collateral asset drew down 40% in the last 90 days, that your borrow is concentrated in a market with thin liquidity, or that the whole market is in a regime where correlations go to one.
- **Alerts that exist are threshold pings.** "Your HF dropped below 1.3" arrives with no instruction. The borrower still has to work out how much to repay, from which asset, on which protocol, while the price is moving.
- **The window is short and it closes fastest exactly when it matters.** In the June-2022 crash, positions went from comfortable to liquidated inside a single day. Anyone checking a dashboard daily lost.

The result is that borrowers who fully intended to manage their positions get liquidated anyway — not because the data was missing, but because nothing turned it into a decision in time.

## 🌟 Vision

Every leveraged position on chain carries a live, honest read of how close it is to liquidation and what to do about it — delivered before the window closes, in the borrower's own terms. Risk stops being something you check and becomes something that tells you. The measure of success is boring: fewer liquidations among people who were paying attention, because paying attention stopped requiring a screen.

## 🎯 Purpose

We built PANIK because the gap between "the data is public" and "the borrower acted" is where the money is lost. Protocols publish health factors. Explorers publish prices. Neither closes the loop.

Closing it requires three things that don't exist together anywhere: a score that folds asset and protocol and regime risk into the position's own health rather than reporting them separately; a threshold that is personal, because a conservative borrower and a degen do not want the same alarm; and a delivery path that reaches someone away from their desk. The scoring engine is a pure, testable package with no I/O, validated against historical crashes rather than tuned by intuition — so the number means something specific, and we can show our work when it fires.

## 👥 Target Users

- **Leveraged DeFi borrowers on Base and Ethereum** running recursive or collateralized positions on Aave, Compound, Moonwell, or Morpho, who cannot watch a dashboard continuously.
- **Risk-conscious long-term holders** borrowing stables against ETH or cbBTC to avoid a taxable sale, whose entire strategy fails if the collateral is seized.
- **Small funds and DAO treasuries** with a handful of positions across protocols and no dedicated risk desk, needing one alert path rather than four dashboards.
- **Future:** protocol teams and lending curators who want depositor-level early warning across their own markets, and wallet apps that want to embed a risk read at the position level.

## ✨ Features

Everything below runs today against live mainnet chain data. The escrow contract is deployed on Base Sepolia; the scoring engine reads Base and Ethereum mainnet.

### Risk scoring
- **Composite 0–100 score** from four weighted sub-scores — position health, asset risk, protocol safety, market regime — with weights summing to 1 and every sub-score clamped to its range.
- **Real health-factor math per protocol.** Aave v3 (`getUserAccountData`, 8-decimal USD base, bps LTV), Compound v3 (`FACTOR_SCALE` 1e18, `PRICE_SCALE` 1e8, per-comet denomination), Moonwell (`cToken × exchangeRate`), Morpho (WAD `lltv`, per-market isolation). The `uint256.max` no-debt sentinel is handled rather than rendered as infinity.
- **True max drawdown**, computed over the ordered 90-day series with a running peak — not a min/max range, which scores a monotonic rally the same as a crash.
- **Crash-regime escalation.** When asset risk crosses 60, the composite escalates; the gate is calibrated against measured historical readings, and escalation can only ever raise a score.
- **Degrade, don't delete.** When a price feed is missing or stale, the position is kept and its health factor reported exactly — HF and LTV are ratios and survive a missing USD price — with the dollar values nulled and flagged. A degraded read can never produce an "all positions within your risk profile" all-clear.

### Alerts (Telegram)
- **Profile-relative thresholds.** Conservative, moderate, and aggressive borrowers get different alarm points from the same score.
- **Confirmation debounce and cooldown.** A status change must hold for N ticks before it fires, with a 6-hour cooldown per wallet, so a wick doesn't page you.
- **Materiality gate.** Dust positions are filtered out — and when a leg's USD value is unavailable, the gate is *waived* rather than failed, so a degraded oracle can't silence a real alert.
- **Wallet-ownership proof required.** Linking a wallet to a Telegram chat requires an EIP-4361 (SIWE) signature over a server-issued single-use nonce. Without it, anyone could bind any wallet to their own chat and silently take over its alerts.

### AI advisor + atomic exit
- **Actionable advice, not a ping.** The advisor turns a score into REDUCE / EXIT / MONITOR with a computed repay amount, solving `R = D(1 − HF/T)` for the target health factor.
- **In-app exit and open flows.** Approve → repay → withdraw sequences are simulated before every signature, gas is taken from the simulation, and reverted receipts are treated as failures rather than success.
- **Resume, never replay.** Multi-step opens persist a plan-keyed cursor with a frozen collateral amount, so retrying after a failed borrow can never re-supply collateral that already landed.

### Founding escrow (Base Sepolia)
- **5 USDC deposit, one global refund deadline.** `PanikEscrow` holds founding deposits until the team calls `ship()` or the deadline passes, after which every depositor can `claimRefund()` forever — no sweep, no expiry.
- **The docs say what the contract does.** `ship()` is an unconditional owner action before the deadline and the explainer says so plainly, rather than claiming funds are untouchable.

### Platform + safety
- **Rate limiting on every route**, tiered by real cost — the endpoints that spend Dune credits, OpenRouter tokens, or RPC calls are strictest. Eviction can never free a live or locked entry, so flooding cannot refund a throttled caller.
- **Deny-all RLS on every table** holding emails, wallets, or Telegram links. The publishable key reaches nothing sensitive; the service key never leaves the server.
- **Timing-safe admin auth** with lockout keyed on the presented credential, so a third party cannot lock out the real operator.
- **Backtest harness** replaying real crash windows against the live engine, with the calibration evidence recorded inline in `params.ts`.

### Not yet built (roadmap)

- **Mainnet escrow.** Blocked on two hard prerequisites: rotating the deployer key out of dotenv into a keystore or hardware wallet, and moving `owner` to a multisig. The contract has no timelock, so an EOA owner is instant drain authority — unacceptable for real deposits.
- **Contract hardening.** A `ship()` timelock so depositors can exit if they disagree, a separate earlier deposit deadline (today a day-89 depositor gets ~1 day of protection), and `Ownable2Step`.
- **ERC-1271 / smart-contract wallets.** Safe and Argent users cannot currently prove ownership; they are told so rather than failing silently.
- **Ownership proofs on read endpoints.** `/api/advisor` and `/api/history` still serve any address. The proof machinery exists and should be applied.
- **Price-provider resilience.** One unresolvable token id currently aborts a whole wallet's scoring; the degrade-don't-delete treatment applied to oracles should extend to the price provider.

## 🏗️ Architecture

A Vite SPA on Vercel, an Express API and a 24/7 watch worker on Railway, Supabase Postgres for state, and a Foundry escrow on Base. The scoring engine is a pure package with no I/O — it is imported by the server and never by the browser.

```
   Browser (panik.fi)                         Telegram
  ┌──────────────────┐                    ┌──────────────┐
  │ landing · /app   │                    │  bot chat    │
  │ /founding · /try │                    └──────▲───────┘
  └────────┬─────────┘                           │ alerts
           │ same-origin /api/*                  │
           ▼                                     │
  ┌──────────────────┐   rewrite    ┌────────────┴─────────────┐
  │  Vercel (static) ├─────────────►│  Railway                 │
  └──────────────────┘              │  ┌────────────────────┐  │
                                    │  │ Express API        │  │
                                    │  │  scores · advisor  │  │
                                    │  │  SIWE · admin      │  │
                                    │  └─────────┬──────────┘  │
                                    │  ┌─────────▼──────────┐  │
                                    │  │ watch worker @60s  │  │
                                    │  │  score → debounce  │  │
                                    │  │  → dispatch @15s   │  │
                                    │  └─────────┬──────────┘  │
                                    └────────────┼─────────────┘
                                                 │
              ┌──────────────────────────────────┼───────────────┐
              ▼                                  ▼               ▼
      ┌───────────────┐                  ┌──────────────┐  ┌───────────┐
      │ packages/     │                  │  Supabase    │  │  Chain    │
      │  scoring      │                  │  Postgres    │  │  (Base +  │
      │ (pure, no I/O)│                  │  deny-all RLS│  │  Ethereum)│
      └───────┬───────┘                  └──────────────┘  └─────┬─────┘
              │ adapters                                          │
              └──────────────────────────────────────────────────┘
                   Aave v3 · Compound v3 · Moonwell · Morpho
                   Chainlink (staleness-checked) · CoinGecko

      Base Sepolia:  PanikEscrow.sol  ── 5 USDC founding deposits
```

**Why the split.** Vercel serves only the built SPA; every `/api/*` call is rewritten to Railway, so the scoring core, RPC keys, and the service key never enter the bundle or the edge. The worker is a separate Railway service because a 60-second scoring loop is a poor fit for serverless, and it restarts independently of the API.

## 🛠️ Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind, wagmi + viem |
| API | Express on Node 24, Fluid-style long-lived process on Railway |
| Scoring | `@panik/scoring` — pure TS workspace package, 212 tests |
| Data | Supabase Postgres (deny-all RLS, `pg_cron` retention) |
| Chain reads | viem multicall against Base + Ethereum, Chainlink price feeds |
| Contracts | Solidity 0.8.24, Foundry, deployed to Base Sepolia |
| Alerts | Telegram Bot API with webhook secret validation |
| Auth | EIP-4361 (SIWE) via `viem/siwe`, server-issued single-use nonces |

## 🌐 Deployment

### Production (current)

| Piece | Where |
|---|---|
| Frontend | Vercel → `panik.fi` |
| API + worker | Railway, two services from one repo |
| Database | Supabase Postgres |
| Escrow | Base Sepolia |

`/api/*` is rewritten from Vercel to Railway (`vercel.json`), so the browser only ever talks to one origin. Both Railway services deploy from `main` on push.

Required environment variables are documented in `.env.example`. Two will refuse to boot or return 503 if unset in production, by design: `CORS_ORIGINS` and `SIWE_ALLOWED_DOMAINS`.

### Escrow (Base Sepolia)

Deployed via `forge script`; the deploy script resolves the USDC address from the chain id rather than an env var, so a stale testnet value cannot hardwire a mainnet contract to the wrong token. See [`docs/technical-docs/ESCROW_SYSTEM.md`](docs/technical-docs/ESCROW_SYSTEM.md).

## 🚀 How to Run Locally

**Prerequisites:** Node.js 24+, and [Foundry](https://book.getfoundry.sh/getting-started/installation) if you're touching contracts.

```bash
git clone --recursive https://github.com/panik-fi/panik-landing_page_waitlist
cd panik-landing_page_waitlist
npm install --legacy-peer-deps
cp .env.example .env    # fill in the keys you need; only VITE_* reach the browser
```

`--recursive` matters: `forge-std` is a submodule. If you already cloned, run `git submodule update --init`.

```bash
# Frontend (Vite on :3000 — landing at /, app at /app.html)
npm run dev

# Scoring API (:8787) — optional, needed for live scores
npm run dev:api

# Watch worker — optional, sends real Telegram alerts
npm run worker:dev
```

### Just want to see the dashboard?

```bash
npm run dev:mock    # then open http://localhost:3000/app.html
```

One terminal, no `.env`, no Supabase, no API keys, no wallet. A dev-only Vite
plugin (`dev/mockApi.ts`, `apply: 'serve'`) answers `/api/*` from typed fixtures
and seeds the onboarding keys in `localStorage`, so you land straight on a
populated dashboard: four positions — one per protocol, which is the most the
engine can emit for a wallet — covering every risk band, 30 days of history,
alerts, and an advisor report. It only fills
`localStorage` keys that are unset, so a real onboarding you are testing is left
alone (clear them in devtools to replay the tour).

The fixtures are static — the numbers are engine-*consistent*, not
engine-*computed*, and the Watch USD sliders will not move the score. Run
`npm run dev:api` when you need the real scoring engine. Anything the mock does
not implement (e.g. `/api/health`) still falls through to the `:8787` proxy, and
`npm run dev` is completely unaffected.

```bash
# Tests
npm test              # API + app
npm run test:scoring  # scoring engine + backtests
npm run lint          # typecheck (baseline: 3 known wagmi errors)

# Contracts (from repo root)
cd contracts && forge test
```

## 🎥 Demo

The public landing page is at [panik.fi](https://panik.fi); the product app is at `/app`. Founding-user escrow is at `/founding`.

## 📚 Docs

- [System architecture](docs/technical-docs/SYSTEM_ARCHITECTURE.md)
- [Backtest overview](docs/technical-docs/BACKTEST_OVERVIEW.md) · [methodology](docs/technical-docs/BACKTEST_METHODOLOGY.md) · [results](docs/technical-docs/BACKTEST_RESULTS.md)
- [Escrow system](docs/technical-docs/ESCROW_SYSTEM.md) · [plain-English explainer](docs/ESCROW_EXPLAINER.md)
- [Telegram alerts](docs/technical-docs/TELEGRAM_ALERTS.md)
- [Deployment](docs/DEPLOY.md)
- [Contributing conventions](CLAUDE.md) — branch, commit, and verification rules

## 📜 License

Unlicensed / all rights reserved. Not open source at this time.
