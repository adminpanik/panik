# Telegram Near-Liquidation Alerts

PANIK sends a Telegram message when a monitored wallet's position crosses into
the user's risk zone (a profile-relative status transition toward liquidation).
This doc covers setup, the moving parts, and the anti-spam design.

## Moving parts

| Piece | Where | Runtime | Notes |
|-------|-------|---------|-------|
| Trigger | `packages/scoring/src/profile.ts` (`statusFor`) | pure | within / approaching / outside vs the profile threshold (25 / 50 / 75) |
| Debounce | `packages/scoring/src/watch/loop.ts` (`WatchService.confirmTicks`) | worker | a status must hold N consecutive 60s ticks before it emits |
| Send gate | `packages/scoring/src/watch/alertPolicy.ts` (`decideSend`) | worker | materiality + cooldown + escalation bypass |
| Message copy | `packages/scoring/src/watch/alertMessage.ts` (`formatAlert`) | worker | plain text + emoji pictograms, hyphens only |
| Worker | `scripts/watch-worker.ts` (`npm run worker`) | standalone | scores, persists transitions, dispatches |
| Send | `server/telegram.ts` (`sendMessage`) | worker + webhook | Bot API, fetch-only |
| Link store | `server/telegramStore.ts` | Vercel functions | Supabase REST, no pg/viem |
| Mint code | `/api/telegram/link` | Railway api-server (`scripts/api-server.ts`) | `api/telegram/link.ts` is the Vercel fallback |
| Webhook | `/api/telegram/webhook` | Railway api-server | `api/telegram/webhook.ts` is the Vercel fallback; receives `/start <code>` and `/stop` |
| Register wallet | `register_watched_wallet` RPC | browser (publishable key) | called from onboarding |
| Schema | `supabase/migrations/20260627000001_telegram_alerts.sql` | Supabase | `telegram_links`, `telegram_link_codes`, the RPC |

## Data flow

1. The user onboards (wallet-connect is mandatory). On completion the browser
   calls `register_watched_wallet(wallet, profile)`, upserting a row into
   `public.watched_wallets`. The worker now scores that wallet.
2. In the Settings tab the user clicks **Connect Telegram**. The browser POSTs
   `/api/telegram/link`, which mints a single-use, 15-minute code in
   `telegram_link_codes` and returns `t.me/<bot>?start=<code>`. The browser
   opens it.
3. The user presses Start. Telegram POSTs the update to
   `/api/telegram/webhook` (with the secret header). The webhook resolves the
   code to the wallet, upserts `telegram_links(wallet, chat_id)`, deletes the
   code, and replies with a confirmation. `/stop` disables the link.
4. The worker scores every active wallet each 60s. On a confirmed profile-status
   transition it inserts a `watch_transitions` row (`notified_at` NULL). The
   dispatch loop (15s) joins unnotified rows to `telegram_links`, applies the
   send gate, sends, and stamps `notified_at` + `notify_channel`.

## Anti-spam / false-alarm controls

The backtest (`BACKTEST_METHODOLOGY.md`) documents a ~24-27% intrinsic
false-alarm rate, so notification volume is governed at the delivery layer.
Knobs live in `ALERT_POLICY` (`packages/scoring/src/params.ts`):

- **confirmTicks (3)** - a candidate status must hold 3 consecutive 60s ticks
  before it emits. Kills single-tick spikes (flaky RPC, price wick) and
  threshold flapping. ~3 min vs the backtest's tens-of-hours lead times.
- **cooldownMs (6h)** - at most one alert per (wallet, protocol) per window. An
  escalation (approaching to outside) bypasses the cooldown.
- **minBorrowUsd ($50)** - positions with no debt (HF null) or sub-dust borrow
  never alert; they cannot be liquidated regardless of composite score.

`notify_channel` records the outcome for every transition: `telegram` (sent),
`skipped` (recovery), `suppressed_cooldown`, `suppressed_immaterial`, `blocked`
(user blocked the bot). Honest scope: these cut nuisance volume and
safe-position noise, not the calibrated precision/recall point.

## Setup

1. Apply the migration in the Supabase SQL Editor (idempotent).
2. Create a bot via **@BotFather**; copy the token. Choose a random
   `TELEGRAM_WEBHOOK_SECRET`. Set the bot username.
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_WEBHOOK_SECRET=<random>
   VITE_TELEGRAM_BOT_USERNAME=YourPanikBot
   TELEGRAM_PUBLIC_BASE_URL=https://your-railway-web-domain
   ```
3. Register the webhook once per environment:
   ```
   npm run telegram:setup            # uses TELEGRAM_PUBLIC_BASE_URL
   npm run telegram:setup -- <url>   # or pass a tunnel URL for local testing
   ```
4. Deploy the worker (host-agnostic via `Dockerfile` / `Procfile`):
   - **Fly.io** (cheapest always-on): a single shared-cpu-1x 256MB machine with
     `min_machines_running = 1`, ~cents/month.
   - **Railway** (easiest): deploy from repo, the `Procfile` runs `npm run worker`,
     ~$5/mo hobby.
   - Avoid Render's free tier (background workers sleep).
   Worker env: `TELEGRAM_BOT_TOKEN`, `SUPABASE_DB_URL`,
   `ALCHEMY_API_KEY_BASE_MAINNET`, `COINGECKO_API_KEY`.
   Vercel env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `VITE_TELEGRAM_BOT_USERNAME`, plus the existing `SUPABASE_URL` /
   `SUPABASE_SECRET_KEY`.

## Local end-to-end test

1. `npm run dev:api` and `npm run dev`. The dev api-server mirrors
   `/api/telegram/link`, so **Connect Telegram** works locally.
2. Expose the dev server (or `vercel dev`) via a tunnel (`cloudflared`/`ngrok`)
   and run `npm run telegram:setup -- <tunnel-url>` so the webhook is reachable.
3. The seed wallet `0x76f88702325c92c83efad341a932fb326957056f`
   ("validation: Moonwell HF~1.2 (alerts)") is a good low-HF target. To force a
   transition fast, temporarily set its `risk_profile='conservative'`.
4. `npm run worker:dev`. Watch the logs: it seeds prior statuses, scores the
   cohort, writes a `score_snapshots` row, and inserts a `watch_transitions` row.
5. Onboard with that wallet, click Connect Telegram, press Start, then watch the
   dispatcher send the alert and stamp `notified_at`. Send `/stop` to disable.
