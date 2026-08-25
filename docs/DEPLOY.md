# Deploying PANIK

Two hosts: Vercel serves the static frontend, Railway runs the Express API and the
watch worker. Supabase Postgres is separate and is not covered here. For the full
system design (data flow, contracts, external APIs) see
[`docs/technical-docs/SYSTEM_ARCHITECTURE.md`](./technical-docs/SYSTEM_ARCHITECTURE.md).

## Frontend (Vercel)

`vercel.json` builds with `vite build` into `dist/` (framework: vite). Vite has four
entry points (`vite.config.ts` `build.rollupOptions.input`), each its own HTML file and
bundle:

| Route | Entry | What it is |
| --- | --- | --- |
| `/` | `index.html` | public landing/marketing page |
| `/app` | `app.html` | the product app (panik-core) |
| `/try` | `try.html` | business-card scan landing, account gate |
| `/admin` and `/admin-neithan` | `admin.html` | campaign admin console (both paths serve the same bundle) |

`vercel.json` rewrites handle the extensionless routes (`/app` -> `/app.html`, etc.) and
`/api/:path*` -> `https://panikrisk-scoring-production.up.railway.app/api/:path*`, so the
SPA calls `/api/*` same-origin and Vercel forwards it to Railway.

`api/` in this repo is **not** deployed: `.vercelignore` excludes it on purpose, since
Vercel's own filesystem routing for `api/` would shadow the rewrite above. It stays in
the repo as a fallback mirror of the Express routes; keep it compiling, but it never
serves production traffic. Shared server logic lives in `server/`.

## Backend (Railway)

`railway.toml` defines one Dockerfile-built image (`Dockerfile`, `node:22-slim`) run as
two separate Railway services from the same repo:

| Service | Start command | Does what |
| --- | --- | --- |
| `panikrisk-scoring` (web) | `npm run start:api` (Dockerfile default `CMD`) | Express API: scores, positions, compass, prospective, chain reads, wallet profiler, Telegram link + webhook. Needs a public Railway domain. |
| `panik-watch-worker` (worker) | `npm run worker` (set in Railway service settings) | 24/7 scoring + Telegram alert dispatch loop. No public domain needed. |

The Dockerfile also builds the SPA so the web service can optionally serve it via
`SERVE_STATIC=true` (`scripts/api-server.ts`); this is a single-service fallback, not
the production path (Vercel serves the SPA). Postgres is Supabase, not Railway; only
the two Node services above run on Railway.

## What triggers a deploy

Vercel and Railway each watch this repo's git history independently (their own
GitHub/git integration, configured in each platform's dashboard, not in this repo). A
push to the watched branch triggers that platform's own build and deploy. **CI does
not gate either deploy**: a failing `.github/workflows/ci.yml` run does not block or
delay a Vercel or Railway deploy. Treat a green CI run as a pre-merge check, not a
deploy gate.

## CI (`.github/workflows/ci.yml`)

Runs on every pull request and every push to `main`, plus a weekly Monday 06:00 UTC
schedule for one job only:

- **node**: `npm ci --legacy-peer-deps`, `npm run lint` (tsc --noEmit), `npm test`,
  `npm run test:scoring`, `npm run build`.
- **contracts**: Foundry `forge build` and `forge test -vvv` in `contracts/`
  (submodules checked out recursively for `forge-std`).
- **executor**: Hardhat install, compile, and the mock test suite
  (`executor/test/executor.spec.ts`). The fork suite needs a mainnet RPC and does not
  run in CI.
- **secrets**: installs the `gitleaks` binary and runs
  `gitleaks detect --source . --redact` against full history.
- **exit-config-drift**: runs on the weekly schedule always, or on a PR touching
  `src/panik-core/lib/exit.generated.ts`, `scripts/*exit-config*`, or
  `executor/deploy/onchain-config.json`. Runs `npm run verify:exit-config` against the
  live chain to catch drift between the generated config and the deployed executor.

## Mirror workflow (`.github/workflows/mirror.yml`)

On every push to `main`, force-pushes `main` to `adminpanik/panik` (`main:main`) using
the `MIRROR_TOKEN` repo secret. One-way mirror to a separate GitHub account; deploys
nothing itself.

## Environment variables

Names only, grouped by which service reads them. See `.env.example` for the full
explanation of each and never commit real values.

**Vercel** (frontend build, `VITE_`-prefixed only; these end up in public client JS): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_WALLETCONNECT_PROJECT_ID`, `VITE_SCORING_CHAIN`, `VITE_BASE_RPC_URL`, `VITE_BASE_SEPOLIA_RPC_URL`, `VITE_TELEGRAM_BOT_USERNAME`, `VITE_ADMIN_EMAIL`.

**Railway `panikrisk-scoring`** (web service): `CORS_ORIGINS`, `TRUSTED_PROXY_HOPS`, `TRUSTED_CLIENT_IP_HEADER`, `COINGECKO_API_KEY`, `DUNE_API_KEY`, `OPENROUTER_API_KEY`, `ALCHEMY_API_KEY_BASE_MAINNET`, `ALCHEMY_API_KEY_BASE_SEPOLIA`, `SCORING_RPC_URL_BASE_MAINNET`, `SCORING_RPC_URL_BASE_SEPOLIA`, `PANIK_SCORING_CHAIN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `GOLDSKY_PROJECT_ID`, `GOLDSKY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PUBLIC_BASE_URL`, `PANIK_APP_URL`, `SIWE_ALLOWED_DOMAINS`, `ADMIN_ACCESS_KEY`, `ADMIN_ALLOWED_EMAIL`, `EXIT_EXECUTOR_RPC_URL`, `RELAYER_FORK_RPC`, `PANIK_RATE_LIMIT_X`, optionally `SERVE_STATIC`.

**Railway `panik-watch-worker`** (worker service): `TELEGRAM_BOT_TOKEN`, `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ALCHEMY_API_KEY_BASE_MAINNET`, `COINGECKO_API_KEY`, `WATCH_TICK_MS`, `EXIT_EXECUTOR_RPC_URL`, `RELAYER_ENABLED`, `RELAYER_SIGNER_KIND`, `RELAYER_PRIVATE_KEYS`, `RELAYER_KMS_KEY_IDS`, `RELAYER_MAX_SUBMISSIONS_PER_TICK`, `RELAYER_MAX_SUBMISSIONS_PER_HOUR`, `RELAYER_MAX_GAS_PER_TX`, `RELAYER_MIN_BALANCE_WEI`, `RELAYER_MAX_ATTEMPTS_PER_PERMIT`, `RELAYER_STUCK_AFTER_MS`, `RELAYER_SEQUENCER_STALE_SEC`, `RELAYER_RESERVES`.

`SUPABASE_URL` and `SUPABASE_SECRET_KEY` on the worker are required, not optional:
without them the worker writes no heartbeats and `/api/health/worker` reports it dead
(see the comment in `railway.toml` for the 2026-08 incident this caused).

`mirror.yml` needs the `MIRROR_TOKEN` repository secret, set in GitHub, not on either host.

## Manual verification after a deploy

Curl the four frontend routes and confirm each returns 200 and the expected entry
bundle, then check the API and worker health:

```
for p in / /app /try /admin; do curl -sI "https://<vercel-domain>$p" | head -1; done
curl -s https://<vercel-domain>/api/health
curl -s https://<vercel-domain>/api/health/worker
```

`/api/health` and `/api/health/worker` are defined in `scripts/api-server.ts`; read that
file for the current response shape before assuming what "healthy" means. Then check
Railway logs for both services for boot errors or a missing-env-var crash loop, since
a bad `CORS_ORIGINS` or `SIWE_ALLOWED_DOMAINS` value fails closed rather than falling
back.
