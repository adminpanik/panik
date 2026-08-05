-- ============================================================================
-- PANIK - server-issued single-use auth nonces (2026-08-06)
--
-- Backs GET /api/auth/nonce and the SIWE (EIP-4361) wallet-ownership proof in
-- server/walletAuth.ts. ADDITIVE: no existing object is touched.
--
-- Why this table exists (the hole it closes):
--   The previous ownership proof was a STATELESS signature over
--   "PANIK wallet ownership\nWallet: <w>\nIssued: <ts>". Two consequences:
--     (a) it replayed forever inside its window - and a replay against
--         POST /api/telegram/link mints a BRAND-NEW deep-link code for the
--         victim's wallet and hands it to the replayer, who opens it in THEIR
--         Telegram and takes over the victim's liquidation alerts; and
--     (b) it contained no server-issued value, so any site could prompt
--         personal_sign over that exact string offline and POST the result
--         here. The victim never had to visit PANIK.
--   A nonce this table issues fixes both: the message cannot be produced
--   offline, and consumption is a single atomic DELETE.
--
-- Single-use is enforced by DELETE ... RETURNING (see server/nonceStore.ts):
-- Postgres row-locks the tuple, so of two concurrent consumers exactly one
-- gets a row back. There is deliberately no "used" flag to update - a delete
-- is the cheapest primitive that is atomic without an explicit transaction
-- (PostgREST has no multi-statement transactions).
--
-- Access model matches telegram_link_codes: deny-all RLS, reached only by the
-- API over the Supabase service key. Idempotent (safe to re-run).
-- ============================================================================

create table if not exists public.auth_nonces (
  nonce      text primary key
             check (nonce ~ '^[a-zA-Z0-9]{16,128}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Consumption filters on expires_at; the sweep below scans it too.
create index if not exists idx_auth_nonces_expires
  on public.auth_nonces (expires_at);

-- Deny-all: no policies on purpose. The publishable key gets nothing here; a
-- nonce is only ever handed out by GET /api/auth/nonce over the service key.
alter table public.auth_nonces enable row level security;

-- ── Retention ──────────────────────────────────────────────────────────────
-- Nonces live ~5 minutes (AUTH_NONCE_TTL_MS). Consumption deletes them, so
-- this only reaps the ones nobody ever redeemed. Own schedule; does NOT touch
-- panik_retention or panik_telegram_codes_cleanup.
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('panik_auth_nonces_cleanup'); exception when others then null; end $$;
select cron.schedule(
  'panik_auth_nonces_cleanup',
  '17 * * * *',  -- hourly at :17
  $$ delete from public.auth_nonces where expires_at < now() - interval '1 hour'; $$
);
