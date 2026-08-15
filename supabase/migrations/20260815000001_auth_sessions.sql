-- ============================================================================
-- PANIK - durable identity sessions (2026-08-15)
--
-- Backs POST/GET/DELETE /api/session and POST /api/session/exchange
-- (server/sessionStore.ts, routes in scripts/api-server.ts). ADDITIVE: no
-- existing object is touched.
--
-- ── THE ONE RULE THESE TABLES ENCODE ───────────────────────────────────────
-- SIGNATURES AUTHORIZE ACTIONS; SESSIONS ONLY RESTORE IDENTITY.
--
-- A row here answers exactly one question - "which wallet is this browser?" -
-- and nothing else. Every wallet-scoped WRITE still demands its own single-use
-- SIWE proof bound to its own action URN (server/walletAuth.ts): the watchlist
-- batch, the Telegram link, the wallet registration. None of those endpoints
-- reads a session, and server/sessionBoundary.test.ts fails the build if one
-- ever starts to.
--
-- That is the whole reason a long-lived cookie is safe to issue at all. The
-- alternative - a session that authorizes writes - would turn a stolen cookie
-- into the account takeover the SIWE nonce work (20260806000001) existed to
-- close, with a 30-day window instead of a 5-minute one.
--
-- ── WHY TWO TABLES ─────────────────────────────────────────────────────────
--   auth_sessions     the session itself. Two scopes, two different proofs of
--                     identity behind them, and therefore two lifetimes.
--
--   deep_link_tokens  a single-use, 15-minute bearer token minted by the ALERT
--                     DISPATCHER and carried in a Telegram button URL. It is
--                     not a session; it is a one-shot claim that can be traded
--                     for a readonly one. Separate table because it has
--                     different physics: single-use, minutes not weeks, and
--                     minted by a background worker rather than by a signature.
--
-- ── TOKENS ARE NEVER STORED RAW ────────────────────────────────────────────
-- Both tables hold SHA-256 hashes, never the token. A read of this database -
-- a leaked backup, an over-broad support query, a Supabase dashboard session -
-- must not yield anything that can be replayed as a credential. The token
-- itself exists only in the cookie (or the alert URL) and in the request that
-- carries it; the server hashes on arrival and compares hash to hash, in
-- constant time (server/sessionStore.ts hashesEqual).
--
-- The hashes are unsalted, and deliberately: the input is 256 bits of
-- crypto.randomBytes, so there is no dictionary to protect against and a
-- per-row salt would only defeat the primary-key lookup that makes the read
-- path one index probe.
--
-- Access model matches auth_nonces / telegram_link_codes: deny-all RLS, reached
-- only by the API over the pooled service connection. Idempotent (safe to
-- re-run).
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 1. auth_sessions - "which wallet is this browser?" ──────────────────────
create table if not exists public.auth_sessions (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique
               check (token_hash ~ '^[0-9a-f]{64}$'),
  owner_wallet text not null
               check (owner_wallet = lower(owner_wallet) and owner_wallet ~ '^0x[0-9a-f]{40}$'),
  scope        text not null
               check (scope in ('full','readonly')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);

comment on table public.auth_sessions is
  'Durable identity sessions. A row answers "which wallet is this browser?" and NOTHING else - no session authorizes a write. Every wallet-scoped mutation still requires its own single-use SIWE proof (server/walletAuth.ts); server/sessionBoundary.test.ts enforces that no mutating route consults a session.';
comment on column public.auth_sessions.token_hash is
  'SHA-256 (hex, lowercase) of the session token. The raw token is 256 bits of crypto.randomBytes and is NEVER stored - it lives only in the httpOnly cookie. Unsalted on purpose: the input has no dictionary, and the plain hash keeps the read path a single unique-index probe.';
comment on column public.auth_sessions.owner_wallet is
  'The wallet this session restores. Lowercase-checked so a cookie can never resolve to a differently-cased duplicate of an existing identity.';
comment on column public.auth_sessions.scope is
  '''full'' = minted from a SIWE proof of this wallet (urn:panik:action:session-start), 30 days. ''readonly'' = traded from a Telegram alert deep-link token, 7 days, and the reader only proved they can read the wallet''s alert chat - not that they hold its key. Neither scope authorizes a write; the distinction exists so the UI can offer a read-only visitor the sign-in it still needs.';
comment on column public.auth_sessions.expires_at is
  'Hard expiry, enforced in the WHERE clause of every read. The retention job below is storage hygiene ONLY - a stopped cron is a disk-space problem, never an auth one.';
comment on column public.auth_sessions.last_seen_at is
  'Last time this session was presented. Bumped at most hourly (server/sessionStore.ts LAST_SEEN_INTERVAL_MS), so a polling dashboard does not turn every read into a write.';
comment on column public.auth_sessions.revoked_at is
  'Set by DELETE /api/session. Server-side revocation, not just a cleared cookie: clearing the cookie alone leaves a copy that was already stolen fully valid for the rest of its 30 days.';

-- The unique constraint on token_hash already serves the read path. These two
-- serve the retention sweep and a future "sign out everywhere".
create index if not exists idx_auth_sessions_expires
  on public.auth_sessions (expires_at);
create index if not exists idx_auth_sessions_owner
  on public.auth_sessions (owner_wallet, created_at desc);

alter table public.auth_sessions enable row level security;
-- No policies on purpose (deny-all for publishable-key clients).

-- ── 2. deep_link_tokens - one alert, one single-use claim ───────────────────
-- Minted by server/watchDispatch.ts as it sends an alert, and carried to the
-- app as `&sid=` on the "Open PANIK Advisor" button. Trading it in gets a
-- READONLY session, because that is honestly all it proves: the bearer can read
-- the Telegram chat linked to this wallet. That is enough to be shown the
-- position the alert was about; it is not enough to act as the wallet.
--
-- MINTING MUST NEVER BLOCK A SEND. The dispatcher catches a failure here, logs
-- it, and sends the button WITHOUT the sid (server/watchDispatchSession.test.ts
-- pins that). A liquidation warning that did not arrive because a session table
-- was unavailable is the worst trade this product could make.
create table if not exists public.deep_link_tokens (
  token_hash    text primary key
                check (token_hash ~ '^[0-9a-f]{64}$'),
  owner_wallet  text not null
                check (owner_wallet = lower(owner_wallet) and owner_wallet ~ '^0x[0-9a-f]{40}$'),
  transition_id bigint references public.watch_transitions (id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

comment on table public.deep_link_tokens is
  'Single-use, 15-minute claims minted per delivered Telegram alert and carried as &sid= on the button URL. Traded at POST /api/session/exchange for a READONLY session. Not a session itself: single-use, minutes long, and minted by a worker rather than by a signature.';
comment on column public.deep_link_tokens.token_hash is
  'SHA-256 (hex) of the token. The raw token appears only in the Telegram button URL and in the exchange request; it is never stored.';
comment on column public.deep_link_tokens.owner_wallet is
  'The SUBSCRIBER the alert was sent to - the identity this token restores. Never the watched wallet: a watchlist alert is about someone else''s position, and trading its token must not sign the reader in as that stranger.';
comment on column public.deep_link_tokens.transition_id is
  'The alert this token rode on, for forensics. Nullable, and set null if the transition is pruned - the token''s validity never depended on it.';
comment on column public.deep_link_tokens.used_at is
  'Burn stamp. The exchange is a single UPDATE ... WHERE used_at IS NULL RETURNING, so of two concurrent redemptions of one token exactly one gets a row back and only that one gets a session.';

create index if not exists idx_deep_link_tokens_expires
  on public.deep_link_tokens (expires_at);

alter table public.deep_link_tokens enable row level security;
-- No policies on purpose.

-- ── 3. Retention ────────────────────────────────────────────────────────────
-- STORAGE HYGIENE, NOT A SECURITY CONTROL. Every read path filters on
-- `expires_at > now()` (and `revoked_at is null`, and `used_at is null`), so an
-- unswept row is already inert. If pg_cron stops, this database grows; nothing
-- becomes forgeable. Own schedule; does NOT touch panik_retention,
-- panik_telegram_codes_cleanup or panik_auth_nonces_cleanup.
--
-- Sessions are kept an extra day past expiry so an "why was I signed out?"
-- support question still has a row to look at.
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('panik_auth_sessions_cleanup'); exception when others then null; end $$;
select cron.schedule(
  'panik_auth_sessions_cleanup',
  '23 * * * *',  -- hourly at :23
  $$ delete from public.auth_sessions where expires_at < now() - interval '1 day'; $$
);

do $$ begin perform cron.unschedule('panik_deep_link_tokens_cleanup'); exception when others then null; end $$;
select cron.schedule(
  'panik_deep_link_tokens_cleanup',
  '29 * * * *',  -- hourly at :29
  $$ delete from public.deep_link_tokens where expires_at < now() - interval '1 hour'; $$
);
