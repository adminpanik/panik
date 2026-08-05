-- ============================================================================
-- !! SUPERSEDED: see 20260805000001_revoke_anon_wallet_register.sql !!
--
-- DO NOT RE-RUN THIS FILE ON ITS OWN. Its final statement,
--     grant execute on function public.register_watched_wallet(...) to anon
-- hands the browser's publishable key the power to upsert ANY wallet's
-- watched_wallets row — rewriting a victim's risk_profile to "aggressive"
-- lifts their alert threshold from 25 to 75 and silently mutes the liquidation
-- warnings they signed up for. 20260805000001 revokes exactly that grant, so
-- replaying this migration afterwards REOPENS the hole. The "idempotent (safe
-- to re-run)" note below predates that fix and is no longer true in isolation:
-- if you replay this file, replay 20260805000001 immediately after.
-- ============================================================================

-- ============================================================================
-- PANIK - Telegram alerts schema v1 (2026-06-27)
-- Scope: deliver "near liquidation" alerts to Telegram for the onboarded user's
--        own wallet. Two new tables + one RPC. Idempotent (safe to re-run).
--
-- ADDITIVE ONLY. Touches none of the scoring objects except by referencing
-- public.watched_wallets via the register RPC. No changes to watch_transitions
-- (its notified_at / notify_channel columns are already the alert queue).
--
-- Access model (same as the rest of the project):
--   * Watch worker (direct pg) and Vercel webhook (Supabase REST + secret key)
--     bypass RLS. All new tables are deny-all RLS (zero policies).
--   * The browser registers its onboarded wallet through ONE SECURITY DEFINER
--     door: public.register_watched_wallet(), granted to anon (publishable key),
--     mirroring public.waitlist_signup(). No new secret reaches the frontend.
--
-- Link flow:
--   browser -> POST /api/telegram/link mints a row in telegram_link_codes and
--   returns t.me/<bot>?start=<code>. The user presses Start; the Telegram
--   webhook resolves the (single-use, TTL'd) code to a wallet and upserts
--   telegram_links(chat_id). The dispatcher joins watch_transitions.wallet =
--   telegram_links.wallet to find where to send.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 1. telegram_links - durable wallet -> chat join target ──────────────────
-- One wallet maps to one chat and vice-versa. A re-link (same chat, new wallet)
-- is handled in the webhook by deleting the prior chat_id row before upsert.
create table if not exists public.telegram_links (
  wallet     text primary key
             check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  chat_id    bigint not null unique,
  username   text,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_telegram_links_updated on public.telegram_links;
create trigger trg_telegram_links_updated
  before update on public.telegram_links
  for each row execute function public.set_updated_at();

-- ── 2. telegram_link_codes - ephemeral deep-link codes ──────────────────────
-- Single-use (deleted on consume), TTL-bounded (expiry checked in the webhook).
create table if not exists public.telegram_link_codes (
  code       text primary key,
  wallet     text not null
             check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_telegram_link_codes_expires
  on public.telegram_link_codes (expires_at);

-- ── 3. RLS - deny-all default (worker/webhook use secret key / direct pg) ────
alter table public.telegram_links      enable row level security;
alter table public.telegram_link_codes enable row level security;
-- No policies on purpose: publishable-key clients get nothing here. The only
-- browser-facing write is register_watched_wallet() below (SECURITY DEFINER).

-- ── 4. register_watched_wallet - browser registers its onboarded wallet ─────
-- Mirrors public.waitlist_signup: deny-all table + ONE SECURITY DEFINER door
-- granted to anon. Idempotent on the wallet unique constraint; a re-onboard
-- refreshes risk_profile and re-activates the row. Silent no-op for non-EVM
-- (Solana) addresses, which the on-chain readers cannot monitor.
create or replace function public.register_watched_wallet(
  p_wallet  text,
  p_profile text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet  text := lower(btrim(coalesce(p_wallet, '')));
  v_profile text := lower(btrim(coalesce(p_profile, '')));
begin
  if v_wallet !~ '^0x[0-9a-f]{40}$' then
    return; -- non-EVM or malformed: nothing to monitor
  end if;
  if v_profile not in ('conservative','moderate','aggressive') then
    v_profile := 'moderate';
  end if;

  insert into public.watched_wallets (wallet, risk_profile, label)
  values (v_wallet, v_profile, 'onboarded user')
  on conflict (wallet) do update
    set risk_profile = excluded.risk_profile,
        is_active    = true,
        updated_at   = now();
end $$;

grant execute on function public.register_watched_wallet(text, text) to anon, authenticated;

-- ── 5. Retention - expire stale link codes (pg_cron) ────────────────────────
-- Separate job; does NOT touch the existing panik_retention schedule.
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('panik_telegram_codes_cleanup'); exception when others then null; end $$;
select cron.schedule(
  'panik_telegram_codes_cleanup',
  '23 * * * *',  -- hourly at :23
  $$ delete from public.telegram_link_codes where expires_at < now() - interval '1 day'; $$
);
