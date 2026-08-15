-- ============================================================================
-- PANIK - accounts: membership + wallet links (2026-08-16)
--
-- Backs GET /api/account, POST /api/account/voucher, POST/DELETE
-- /api/account/wallets and GET /api/admin/users (server/accountStore.ts,
-- server/accountAuth.ts, routes in scripts/api-server.ts).
-- ADDITIVE: no existing object is touched. Idempotent (safe to re-run).
--
-- ── WHAT AN ACCOUNT IS, AND WHAT IT IS NOT ─────────────────────────────────
-- IDENTITY IS A SUPABASE AUTH USER. auth.users is the only account table; this
-- migration adds no shadow user row, no password column and no second email
-- of record. Everything here hangs off auth.users(id).
--
-- MEMBERSHIP IS NOT IDENTITY. Signing in creates an auth user and nothing
-- else. During the closed beta an account with no live row in
-- public.memberships is not a member and every account-gated endpoint answers
-- 403 - see requireMember in server/accountAuth.ts. That is why membership is
-- its own table rather than a boolean on a profile: "who you are" is settled by
-- Supabase Auth, "may you be here yet" is settled here, and the two questions
-- lapse on completely different clocks.
--
-- A WALLET LINK IS NOT A CREDENTIAL. A row in public.account_wallets records
-- that an account PROVED it holds a wallet's key once (a single-use SIWE proof
-- bound to urn:panik:action:account-wallet-link). It is an association, not an
-- authorization: every wallet-scoped WRITE still demands its own fresh proof of
-- its own action, exactly as it did before accounts existed
-- (server/walletAuth.ts, pinned by server/sessionBoundary.test.ts). Nothing in
-- this file may ever be read as "this account may act as this wallet".
--
-- ── ACCESS MODEL ───────────────────────────────────────────────────────────
-- Deny-all RLS on both tables, matching auth_sessions / auth_nonces /
-- telegram_links. The browser never touches them: the API reads and writes over
-- PostgREST with the secret key, after resolving the caller's Supabase access
-- token against /auth/v1/user. A publishable-key client gets nothing here.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 1. memberships - "may this account be in the closed beta yet?" ──────────
--
-- One row per grant of access. Rows are kept after they lapse: "this address
-- had a trial in August and it ran out" is the answer to the support question,
-- and deleting the row would make a spent voucher look like one that was never
-- redeemed.
create table if not exists public.memberships (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  status       text not null check (status in ('trial','active','lapsed')),
  source       text not null,
  voucher_code text,
  started_at   timestamptz not null default now(),
  expires_at   timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.memberships is
  'Closed-beta membership. An auth.users row alone is NOT membership: an account with no live row here is refused by requireMember (server/accountAuth.ts) with 403 "closed beta". Lapsed rows are retained on purpose - a spent voucher must not read as an unredeemed one.';
comment on column public.memberships.user_id is
  'The Supabase Auth account this grant belongs to. Cascades on delete so removing an account in the Supabase dashboard cannot leave an orphaned grant that a re-registered address would inherit.';
comment on column public.memberships.status is
  '''trial'' = time-boxed, minted by redeeming a product_campaigns voucher; ''active'' = open-ended membership (no expiry), reserved for accounts granted access directly; ''lapsed'' = recorded history, grants nothing. TRIAL COUNTS AS MEMBERSHIP - the beta gate asks "trial or active and not past expires_at", never "paid".';
comment on column public.memberships.source is
  'How access was granted, for the admin roster: ''voucher'' (a redeemed PANIK-TRY campaign code) today. Free text rather than an enum so a future grant path is an insert, not a migration.';
comment on column public.memberships.voucher_code is
  'The product_campaigns.campaign_code that was redeemed, uppercased, or null for a grant that came from elsewhere. Deliberately NOT the per-user trial_grants.access_token: that token is a bearer credential for the trial link and a membership row is not a reason to move one (same rule as CampaignStore.listRedemptions).';
comment on column public.memberships.expires_at is
  'When this grant stops counting. Null = no expiry. Copied from the trial grant''s own clock at redemption (public.open_trial starts it), so this column is a snapshot for the gate to read cheaply - trial_grants remains the record of the trial itself.';

-- ONE LIVE MEMBERSHIP PER ACCOUNT. A partial unique index rather than a plain
-- unique (user_id): lapsed rows are history and an account may accumulate any
-- number of them, but it may never hold two grants that both open the door.
-- This is also the concurrency boundary for redemption - two voucher redeems
-- racing on one account leave exactly one row, and the loser is told it is
-- already a member instead of quietly burning a second campaign slot.
create unique index if not exists uq_memberships_live_per_user
  on public.memberships (user_id)
  where status in ('trial','active');

-- The admin roster reads by user and looks a voucher up by code.
create index if not exists idx_memberships_user_created
  on public.memberships (user_id, created_at desc);
create index if not exists idx_memberships_voucher
  on public.memberships (voucher_code)
  where voucher_code is not null;

alter table public.memberships enable row level security;
-- No policies on purpose (deny-all for publishable-key clients).

-- ── 2. account_wallets - which wallets an account has PROVEN it holds ───────
--
-- ONE ACCOUNT PER WALLET, for now. The unique index on `wallet` alone is the
-- decision: while a wallet's alerts, watchlist and Telegram link are keyed by
-- address and by nothing else, letting two accounts both claim one address
-- would make "whose subscription is this?" unanswerable. Two people sharing a
-- hardware wallet is a real case and it is deferred, not denied - lifting the
-- constraint later is a migration, whereas un-merging two accounts' data would
-- not be.
create table if not exists public.account_wallets (
  user_id     uuid not null references auth.users (id) on delete cascade,
  wallet      text not null
              check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  verified_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  primary key (user_id, wallet)
);

comment on table public.account_wallets is
  'Wallets an account has proven it holds the key to, via a single-use SIWE proof bound to urn:panik:action:account-wallet-link. AN ASSOCIATION, NEVER AN AUTHORIZATION: every wallet-scoped write still requires its own fresh action-bound proof (server/walletAuth.ts). A row here must never be read as "this account may act as this wallet".';
comment on column public.account_wallets.wallet is
  'Lowercase-checked, same normalization as watch_subscriptions / telegram_links / auth_sessions, so one address can never exist as two differently-cased identities.';
comment on column public.account_wallets.verified_at is
  'When the ownership signature was accepted. Distinct from created_at so a future re-verification (a periodic "still yours?" prompt) has somewhere to land without rewriting the row''s age.';

-- The uniqueness that the primary key does NOT give: one account per wallet.
create unique index if not exists uq_account_wallets_wallet
  on public.account_wallets (wallet);

alter table public.account_wallets enable row level security;
-- No policies on purpose (deny-all for publishable-key clients).

-- ── 3. Adoption of the existing wallet-keyed data (PR 4, NOT here) ──────────
--
-- public.watch_subscriptions (owner_wallet) and public.telegram_links (wallet)
-- predate accounts and stay keyed on the address alone. Linking a wallet
-- therefore changes NOTHING about them today: the worker's join, the dispatcher
-- and every SIWE-proofed write behave exactly as they did, and an account that
-- links a wallet with existing subscriptions simply finds them already there.
--
-- PR 4 attaches ownership by adding a NULLABLE user_id to those two tables and
-- backfilling it from this table (wallet -> user_id is unique, which is what
-- makes that backfill deterministic). It is deliberately not done here: a
-- migration that moves live alerting data belongs in the PR that also moves the
-- code reading it, and account_wallets has to exist and be populated first.
-- Until then this table is additive in the strictest sense - dropping it would
-- cost the account surface and not one alert.
