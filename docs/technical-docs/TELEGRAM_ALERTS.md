# Telegram Near-Liquidation Alerts

PANIK sends a Telegram message when a monitored wallet's position crosses into
the user's risk zone (a profile-relative status transition toward liquidation).
This doc covers setup, the moving parts, and the anti-spam design.

## Moving parts

| Piece | Where | Runtime | Notes |
|-------|-------|---------|-------|
| Trigger | `packages/scoring/src/profile.ts` (`statusFor`) | pure | within / approaching / outside vs the profile threshold (25 / 50 / 75) |
| Debounce | `packages/scoring/src/watch/loop.ts` (`WatchService.confirmTicks`) | worker | a status must hold N consecutive 60s ticks before it emits |
| Send gate | `packages/scoring/src/watch/alertPolicy.ts` (`decideSend`) | worker | materiality + cooldown + escalation bypass + resolution rate limit |
| Message copy | `packages/scoring/src/watch/alertMessage.ts` (`formatAlert`, `formatResolution`) | worker | Telegram HTML (`<b>`/`<code>` only), no emoji, hyphens only |
| Worker | `scripts/watch-worker.ts` (`npm run worker`) | standalone | scores, persists transitions, dispatches |
| Card | `server/alertCard.ts` (`renderAlertCard`) | worker | SVG -> PNG via `@resvg/resvg-js`; never blocks a send |
| Send | `server/telegram.ts` (`sendMessage`, `sendPhoto`) | worker + webhook | Bot API, fetch-only |
| Link store | `server/telegramStore.ts` | Railway api-server + Vercel fallbacks | Supabase REST, no pg/viem |
| Mint code | `/api/telegram/link` | Railway api-server (`scripts/api-server.ts`) | `api/telegram/link.ts` is the Vercel fallback (see below) |
| Webhook | `/api/telegram/webhook` | Railway api-server | `api/telegram/webhook.ts` is the Vercel fallback; receives `/start <code>` and `/stop` |
| Ownership proof | `server/walletAuth.ts` + `server/siweProof.ts` | both | SIWE (EIP-4361): domain + action + single-use server nonce |
| Nonce mint | `/api/auth/nonce` | Railway api-server | `api/auth/nonce.ts` is the Vercel fallback; rows in `auth_nonces` |
| Register wallet | `POST /api/wallets/register` | Railway api-server | ownership-gated; the browser can no longer call the RPC directly |
| Schema | `supabase/migrations/20260627000001_telegram_alerts.sql` (+ `20260805000001`, `20260806000001`) | Supabase | `telegram_links`, `telegram_link_codes`, `auth_nonces`, the RPC |

### Which handler actually serves production

The Railway Express server (`scripts/api-server.ts`) does — for **every**
`/api/*` route. `vercel.json` rewrites `/api/:path*` to Railway, and although
Vercel applies rewrites only after a filesystem check, `.vercelignore` excludes
`api/` from the upload, so there is no function to shadow the rewrite. Verified
against `panik.fi`: `/api/telegram/link`, `/api/telegram/status` and
`/api/wallets/register` all answer with Railway's `x-railway-request-id` /
`x-railway-edge` headers, including the two paths that DO have a file in `api/`.
The `api/` handlers are a deliberate fallback and are kept at parity (method
guard, rate limit, same ownership check) — a fallback weaker than the primary is
just a slower way to get breached.

## Data flow

1. The user onboards. Wallet-connect is **not** required to finish onboarding —
   the wallet address is pasted (`Onboarding.tsx`). On completion the browser
   calls `POST /api/wallets/register`, which requires a signed ownership proof,
   so a pasted hardware / cold / Safe / other-browser address cannot be
   registered. That failure is **surfaced** as a persistent "Alerts inactive"
   banner with a retry, because an unregistered wallet receives no alerts at
   all. Only registered wallets are scored by the worker.
2. In the Settings tab the user clicks **Connect Telegram**. The browser signs a
   SECOND proof — bound to the `telegram-link` action, so the onboarding
   signature cannot be reused here — then POSTs `/api/telegram/link`, which
   mints a single-use, 15-minute code in `telegram_link_codes` and returns
   `t.me/<bot>?start=<code>`. The browser opens it.
3. The user presses Start. Telegram POSTs the update to
   `/api/telegram/webhook` (with the secret header). The webhook resolves the
   code to the wallet, upserts `telegram_links(wallet, chat_id)`, deletes the
   code, and replies with a confirmation. `/stop` disables the link.
4. The worker scores every active wallet each 60s. On a confirmed profile-status
   transition it inserts a `watch_transitions` row (`notified_at` NULL). The
   dispatch loop (15s) joins unnotified rows to `telegram_links`, applies the
   send gate, sends, and stamps `notified_at` + `notify_channel`.

## Wallet-ownership proof

`/api/telegram/link` **returns** a deep-link code to whoever calls it, and that
code redirects a wallet's liquidation alerts to whoever opens it. So the caller
must prove the wallet is theirs. The proof is SIWE (EIP-4361), built by
`server/siweProof.ts` (the browser and the verifier call the same function, so
they cannot drift) and checked by `server/walletAuth.ts`:

1. `GET /api/auth/nonce` mints a row in `public.auth_nonces` (5-minute TTL).
2. The wallet signs a message carrying that nonce, `Domain:`/`URI:`,
   `Chain ID: 8453`, and a `Resources:` URN naming ONE action
   (`urn:panik:action:wallet-register` or `urn:panik:action:telegram-link`).
3. The server re-derives the canonical message from the parsed fields and
   requires a byte-exact match, verifies the signature (EOA recovery — no RPC
   round-trip, so ERC-1271/Safe wallets cannot pass), then **consumes the nonce
   atomically** (`DELETE ... RETURNING`). A proof is therefore usable exactly
   once, by one endpoint, from one origin.

Each of those three bindings closes a concrete hole in the previous stateless
`PANIK wallet ownership / Wallet / Issued` format: the nonce stops a captured
proof being replayed to mint a *fresh* code for the victim's wallet; the domain
stops a hostile page soliciting the signature offline; the action stops an
onboarding signature doubling as an alert-redirect token. Note there is no
client timestamp in the protocol at all — lifetime is the nonce row's TTL, so a
skewed OS clock cannot lock a user out (and cannot extend a proof either).

Configure `SIWE_ALLOWED_DOMAINS` in production. Unset, every proof is refused
(503); it must never silently widen to "any domain".

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
`skipped` (a recovery on a position we never alerted on, so there is nothing to
resolve), `suppressed_cooldown`, `suppressed_immaterial`, `blocked` (user
blocked the bot). Honest scope: these cut nuisance volume and safe-position
noise, not the calibrated precision/recall point.

**Resolution notifications (P2 7.2).** A recovery (`to_status = 'within'`) now
sends an all-clear stating what changed, instead of being skipped silently. It
is rate-limited to **one all-clear per alert actually delivered**: the gate
requires a prior sent alert, and a second recovery with no new alert in between
is suppressed. An alert still measures its cooldown against the last sent
ALERT, so an all-clear can never reset the clock and re-open the window. A
position flapping over/under its limit inside one cooldown therefore produces
two messages (one alert, one all-clear), not four.

**Why now (P2 7.1).** Every alert carries ONE explanation line. When a named
trigger fired it reads `Why now: <sentence> Risk drivers: …`; when nothing named
fired, the reason is the dominant sub-score and the line reads `Main driver:
asset volatility (38 of 100). Position health 7, …`. Triggers are the advisor's
own (`advisor/rules.ts`); `whyNow()` in `watch/alertMessage.ts` holds the
severity order and the copy. A trigger whose value is unavailable falls through
to the next one, so the alert says less rather than inventing a number, and raw
trigger strings never reach a user.

**The message contract.** Four rules, all enforced by tests in
`packages/scoring/tests/alertMessage.test.ts`:

- **No emoji**, in any message, and no em dashes. Plain professional wording.
- **Telegram HTML, two tags.** Alerts and all-clears are sent with
  `parse_mode: "HTML"` and emit only `<b>` and `<code>`: the subject line bold
  with the address in monospace, the score line's three numbers bold, the drill
  marker and the closing instruction bold, and nothing else. Line breaks stay
  `\n` (`<br>` is not in Telegram's whitelist and would 400). Every interpolated
  value goes through `escapeHtml` - the wallet label is user-typed, the symbols
  and protocol names are read off a chain, the scenario label is operator-typed,
  and an unescaped `<` is not a styling bug but a rejected send. No other sender
  sets a parse mode, so the webhook replies, the operator pages and the welcome
  are all still unparsed plain text.
- **Say whose position it is.** The first line is the subscriber's own label for
  the wallet plus the truncated address plus the protocol
  (`Simulation target (0x12a5...2305) on Aave V3 is nearing your conservative
  limit.`). The label comes from `watch_subscriptions.label`, selected by the
  drain and passed as `AlertExtras.label`.
- **Never contradict yourself.** On an `approaching` transition the score line
  names the warn boundary (`Risk score 15 of 100. Your conservative limit is 25,
  and alerts warn from 15.`). The number is `warnFrom(profile)` in
  `packages/scoring/src/profile.ts`, the same function `statusFor` decides with.
- **Round for humans, and never fall below the floor.** Scores and drivers are
  integers, health factor two decimals, dollars whole. The subject and the score
  line are built only from `watch_transitions` columns, so no combination of
  missing snapshot facts can produce a message that is all advice and no facts.

**Open PANIK Advisor.** Alerts and all-clears carry a single inline-keyboard URL
button pointing at `PANIK_APP_URL` (default `https://www.panik.fi/app`) with
`?view=<watched wallet>&tab=advisor` - the Advisor, because the message ends in
an instruction and the Advisor is the screen that sizes it. `AppDemo` honours
both halves once the watchlist has loaded, applying the wallet before the tab,
and only for a wallet the reader actually watches and a tab this build has. A
`PANIK_APP_URL` that is not an absolute http(s) URL costs the button, never the
send.

**Watch-only.** When the subscriber is not the watched wallet's owner, the alert
adds one plain line under the instruction saying PANIK cannot act on it for them.
The dispatcher decides it (`owner_wallet` vs `t.wallet`, case-insensitive); it is
the chat's version of the app withholding every acting control on a watched
address. All-clears do not carry it, because they advise nothing.

**The card.** Every alert and all-clear also carries a PNG rendered in-process by
`server/alertCard.ts` (`@resvg/resvg-js`, no browser and no third party): the
score dial exactly as `src/panik-core/ui/RiskDial.tsx` draws it, the brand mark,
the severity headline, one identity line and the address, plus a `SIMULATED
DRILL` chip when the transition carries a simulation. Fonts are vendored under
`server/assets/fonts` (see the README there) because the container has none.

**Exactly two large elements: the dial's number and the event headline.** The
identity line under them carries the reader's own name for the wallet IN QUOTES,
then the protocol, then the chain (`"Simulation target" · Aave V3 · Base`, or
`Aave V3 · Base` when they never named it). It is bright but not big - primary
ink at medium weight, at the same 22px as the address, because the SIZE gap is
what holds the hierarchy. The chain label is threaded through from the worker's
own `ScoringChainConfig.label` rather than assumed, so a testnet worker says
"Base Sepolia"; a caller that names no chain gets the segment dropped, never
defaulted. Set large and bold on its own line, as it was first built, a nickname
somebody typed into a text field reads as PANIK vocabulary for a kind of position
rather than as this reader's word for this wallet; quotes say "your word, not
ours" in a way no font size can. The limit sentence
("conservative limit 25, and alerts warn from 15") is NOT on the card at all - it
lives in the message body, where it has room to be the sentence that stops a LOW
score with an alert attached from reading as a contradiction.

**Two colour channels on the card, and they answer different questions.** The
ARC is coloured by the score's BAND, exactly as the app's dial colours it - that
is the engine's claim about the number and the card must not restate it. The
HEADLINE is coloured by what the EVENT means for this reader: "nearing" is always
elevated amber, "over" is always high orange, "back under" is always low green.
Collapsing the two shipped a green "Nearing your risk limit" - a warning in the
colour of reassurance - for the ordinary case of a conservative reader warned at
15, where 15 genuinely is LOW. The single exception only ever escalates: a
CRITICAL band under "over your limit" keeps critical red.

Delivery is one `sendPhoto` with the whole body as the caption. Telegram caps a
caption at 1024 characters *after entity parsing* (`captionLength` measures what
it counts); the widest shape the current copy can produce shows 986, so the split
path - card captioned with `formatHeadline`, full body as an immediate follow-up
message - is a live safety net rather than the normal case.

**Nothing about the card can stop an alert.** `renderAlertCard` never throws and
returns null on any failure; a refused or throwing upload logs and falls through
to the existing text-only `sendMessage`. Deps without a `sendPhoto` get text, as
every caller did before the card existed. `server/watchDispatch.test.ts` covers
all three fallbacks.

## Setup

1. Apply the migrations in the Supabase SQL Editor, **in order**:
   `20260627000001_telegram_alerts.sql`, then
   `20260805000001_revoke_anon_wallet_register.sql` (revokes the anon grant the
   first one hands out), then `20260806000001_auth_nonces.sql` (`auth_nonces`).
   Re-running the first one alone reopens the anon hole.
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
   API env (Railway — this is what serves `/api/*`): `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, `VITE_TELEGRAM_BOT_USERNAME`, `SUPABASE_URL` /
   `SUPABASE_SECRET_KEY` (now also required for nonces, i.e. for wallet
   registration), and **`SIWE_ALLOWED_DOMAINS`** — without it every ownership
   proof is refused with a 503.

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
