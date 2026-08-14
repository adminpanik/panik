-- ============================================================================
-- PANIK - multi-wallet watchlists (2026-08-14)
--
-- One user watches many wallets, including wallets they do not own (a friend's
-- position, a treasury, a vault they are exposed to). Until now the product had
-- exactly one relation - watched_wallets - which conflated three different
-- facts into one row: WHO asked for monitoring, WHICH wallet is monitored, and
-- AT WHAT THRESHOLD. That is why the old register RPC could rewrite a stranger's
-- risk_profile: there was no owner to check it against.
--
-- The split:
--
--   watch_subscriptions  the INTENT. (owner, watched, profile, label). The only
--                        table a user mutates, and every mutation is behind a
--                        SIWE proof that the caller owns `owner_wallet`
--                        (server/walletAuth.ts, action urn:panik:action:
--                        watchlist-manage).
--
--   watched_wallets      the worker's REGISTRY, now DERIVED. A wallet is
--                        is_active iff at least one subscription references it.
--                        Kept, rather than replaced, because the worker, the
--                        ops console and the admin metrics all read it and none
--                        of them care who asked.
--
--   watch_deliveries     the LEDGER. One confirmed transition can now fan out to
--                        several chats, so "was this alert delivered" stopped
--                        being a property of the transition. The old
--                        watch_transitions.notified_at / notify_channel /
--                        notify_attempts columns are LEFT IN PLACE and still
--                        describe the rows written before this migration; the
--                        new dispatcher writes here instead.
--
-- SCORING COST IS SHARED. The worker scores each watched wallet ONCE per tick
-- and then evaluates the profile thresholds once per DISTINCT profile among its
-- subscribers (at most three). Ten people watching one whale is one chain read,
-- not ten.
--
-- Idempotent (create ... if not exists / create or replace). RLS is enabled with
-- ZERO policies on both new tables, exactly as watched_wallets does it: the
-- worker (direct pg) and the API (owner role) bypass RLS, and the publishable
-- key gets nothing.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 1. watch_subscriptions - the intent ─────────────────────────────────────
create table if not exists public.watch_subscriptions (
  id             uuid primary key default gen_random_uuid(),
  owner_wallet   text not null
                 check (owner_wallet = lower(owner_wallet) and owner_wallet ~ '^0x[0-9a-f]{40}$'),
  watched_wallet text not null
                 check (watched_wallet = lower(watched_wallet) and watched_wallet ~ '^0x[0-9a-f]{40}$'),
  risk_profile   text not null default 'moderate'
                 check (risk_profile in ('conservative','moderate','aggressive')),
  label          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_wallet, watched_wallet)
);

comment on table public.watch_subscriptions is
  'Who asked for which wallet to be watched, and at what threshold. The only watch table a user mutates; every write requires a SIWE proof of owner_wallet. Capped at 10 rows per owner_wallet (server/watchlist.ts WATCHLIST_MAX and public.register_watched_wallet must agree).';
comment on column public.watch_subscriptions.owner_wallet is
  'The wallet that PROVED ownership to create this row. Alerts route to this wallet''s telegram_links row, never to watched_wallet''s.';
comment on column public.watch_subscriptions.watched_wallet is
  'The wallet being monitored. May equal owner_wallet (a self-subscription, what onboarding creates) or be any address the owner merely watches.';
comment on column public.watch_subscriptions.risk_profile is
  'This subscriber''s alert threshold. Two subscribers on the same wallet with different profiles get their own transition stream: watch_transitions is keyed (wallet, protocol, risk_profile).';
comment on column public.watch_subscriptions.label is
  'The owner''s own name for the watched wallet. Never written by onboarding - the old RPC stamped ''onboarded user'' over whatever the user had chosen.';
comment on column public.watch_subscriptions.created_at is
  'When the owner started watching. The dispatcher will not deliver a transition older than this, so adding a wallet cannot replay its alert history at you.';

create index if not exists idx_watch_subscriptions_watched
  on public.watch_subscriptions (watched_wallet, risk_profile);
create index if not exists idx_watch_subscriptions_owner
  on public.watch_subscriptions (owner_wallet, created_at);

drop trigger if exists trg_watch_subscriptions_updated on public.watch_subscriptions;
create trigger trg_watch_subscriptions_updated
  before update on public.watch_subscriptions
  for each row execute function public.set_updated_at();

alter table public.watch_subscriptions enable row level security;
-- No policies on purpose (deny-all for publishable-key clients).

-- ── 2. Backfill - every active registry row becomes a self-subscription ─────
-- This is what carries the existing users across: the two Telegram-linked
-- wallets and the four seed cohort wallets keep their profile AND their label,
-- and created_at is carried over so the dispatcher's "not older than the
-- subscription" rule does not drop alerts that are already queued.
insert into public.watch_subscriptions
  (owner_wallet, watched_wallet, risk_profile, label, created_at, updated_at)
select w.wallet, w.wallet, w.risk_profile, w.label, w.created_at, w.updated_at
  from public.watched_wallets w
 where w.is_active
on conflict (owner_wallet, watched_wallet) do nothing;

-- ── 3. watched_wallets is now derived ───────────────────────────────────────
comment on table public.watched_wallets is
  'The watch worker''s registry, DERIVED from watch_subscriptions since 2026-08-14: is_active iff at least one subscription references the wallet. Do not insert here directly - go through public.watchlist_sync_registry (or server/watchlist.ts), or the next mutation will undo you.';
comment on column public.watched_wallets.risk_profile is
  'Derived: the STRICTEST profile among this wallet''s subscribers (conservative < moderate < aggressive). Kept for the readers that want one number per wallet (the ops console, the coverage sweep''s at-risk flag). Alert evaluation does NOT read it - it reads every distinct subscriber profile.';
comment on column public.watched_wallets.label is
  'Derived: the self-subscription''s label if there is one, else the oldest labelled subscriber''s. Never overwritten with null.';

-- ── 4. watch_deliveries - one transition, many chats ────────────────────────
create table if not exists public.watch_deliveries (
  id              bigint generated always as identity primary key,
  transition_id   bigint not null references public.watch_transitions (id) on delete cascade,
  owner_wallet    text not null
                  check (owner_wallet = lower(owner_wallet) and owner_wallet ~ '^0x[0-9a-f]{40}$'),
  chat_id         bigint,
  notify_channel  text,
  notified_at     timestamptz,
  notify_attempts integer not null default 0 check (notify_attempts >= 0),
  created_at      timestamptz not null default now(),
  unique (transition_id, owner_wallet)
);

comment on table public.watch_deliveries is
  'Per-recipient outcome for one confirmed transition. The queue is drained per DELIVERY, not per transition: one watcher blocking the bot must not retire the alert for the other nine.';
comment on column public.watch_deliveries.owner_wallet is
  'The subscriber this row is the outcome for. Unique with transition_id, so a re-drain cannot double-send.';
comment on column public.watch_deliveries.chat_id is
  'Telegram chat the send was aimed at. Nullable because a row can be stamped by the anti-spam gate before any chat is resolved, and because the legacy rows this table supersedes never recorded one.';
comment on column public.watch_deliveries.notify_channel is
  'Outcome, not proof of delivery: ''telegram'' = Telegram accepted it; ''blocked'' = 403; ''undeliverable'' = attempts exhausted; ''suppressed_*'' / ''skipped'' = the anti-spam gate withheld it. Null with a null notified_at = still queued.';
comment on column public.watch_deliveries.notify_attempts is
  'Sends spent on THIS recipient. The dispatcher gives up at NOTIFY_MAX_ATTEMPTS (scripts/watch-worker.ts) and stamps notify_channel = ''undeliverable''.';

create index if not exists idx_watch_deliveries_pending
  on public.watch_deliveries (transition_id)
  where notified_at is null;
-- Anti-spam cooldown lookup: last messages actually SENT to one chat.
create index if not exists idx_watch_deliveries_chat_sent
  on public.watch_deliveries (chat_id, notified_at desc)
  where notify_channel = 'telegram';

alter table public.watch_deliveries enable row level security;
-- No policies on purpose.

-- ── 5. watchlist_sync_registry - the ONE place watched_wallets is written ────
-- Called inside the same transaction as every subscription mutation, so the
-- registry can never disagree with the intent. A wallet nobody subscribes to is
-- deactivated rather than deleted: score_snapshots and watch_transitions still
-- reference it and the history surface still has to render.
create or replace function public.watchlist_sync_registry(p_wallet text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet  text := lower(btrim(coalesce(p_wallet, '')));
  v_count   integer;
  v_rank    integer;
  v_profile text;
  v_label   text;
begin
  if v_wallet !~ '^0x[0-9a-f]{40}$' then
    return;
  end if;

  select count(*),
         -- Strictest wins: conservative alerts at 25, aggressive at 75, so the
         -- registry's single number must be the TIGHTEST anyone asked for. The
         -- alternative (last writer wins) would let one relaxed watcher raise
         -- the at-risk bar for a wallet somebody else is watching closely.
         min(case s.risk_profile
               when 'conservative' then 1
               when 'moderate'     then 2
               else 3
             end)
    into v_count, v_rank
    from public.watch_subscriptions s
   where s.watched_wallet = v_wallet;

  if v_count = 0 then
    update public.watched_wallets
       set is_active = false, updated_at = now()
     where wallet = v_wallet;
    return;
  end if;

  v_profile := case v_rank
                 when 1 then 'conservative'
                 when 2 then 'moderate'
                 else        'aggressive'
               end;

  -- The owner's own name for their wallet beats a stranger's nickname for it.
  select s.label
    into v_label
    from public.watch_subscriptions s
   where s.watched_wallet = v_wallet and s.label is not null
   order by (s.owner_wallet = v_wallet) desc, s.created_at
   limit 1;

  insert into public.watched_wallets (wallet, risk_profile, label, is_active)
  values (v_wallet, v_profile, v_label, true)
  on conflict (wallet) do update
     set risk_profile = excluded.risk_profile,
         -- coalesce, never assign: clearing every label must not blank a name
         -- the registry already had.
         label        = coalesce(excluded.label, public.watched_wallets.label),
         is_active    = true,
         updated_at   = now();
end $$;

comment on function public.watchlist_sync_registry(text) is
  'Recompute one wallet''s watched_wallets row from watch_subscriptions. Must run in the same transaction as the mutation that changed them.';

revoke execute on function public.watchlist_sync_registry(text) from public;
revoke execute on function public.watchlist_sync_registry(text) from anon;
revoke execute on function public.watchlist_sync_registry(text) from authenticated;

-- ── 6. register_watched_wallet - superseded, footguns removed ────────────────
-- SUPERSEDES the body defined in 20260627000001_telegram_alerts.sql (lines
-- 83-110). That version had two bugs the watchlist model makes unacceptable:
--
--   1. RESURRECTION. `is_active = true` on conflict re-activated ANY wallet by
--      name, so re-onboarding put back a wallet the user had removed - and,
--      before 20260805000001 revoked the anon grant, put back anyone's.
--      It now creates exactly one thing, the caller's own self-subscription,
--      and lets watchlist_sync_registry decide what that implies for is_active.
--
--   2. LABEL CLOBBER. It stamped label = 'onboarded user' over whatever the
--      user had chosen. The label now lives on the subscription and this
--      function never touches it.
--
-- POST /api/wallets/register no longer calls this - it goes through
-- server/watchlist.ts, the same core the batch endpoint uses. The function is
-- kept, corrected, so a rollback of the API without a rollback of the schema
-- still onboards correctly. Grants stay revoked (20260805000001).
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
  v_count   integer;
begin
  if v_wallet !~ '^0x[0-9a-f]{40}$' then
    return; -- non-EVM or malformed: nothing to monitor
  end if;
  if v_profile not in ('conservative','moderate','aggressive') then
    v_profile := 'moderate';
  end if;

  -- Same lock key server/watchlist.ts takes, so the cap holds across the two
  -- doors: two concurrent writers cannot each read 9 and each insert one.
  perform pg_advisory_xact_lock(hashtext('panik:watchlist:' || v_wallet));

  select count(*) into v_count
    from public.watch_subscriptions where owner_wallet = v_wallet;

  -- 10 = server/watchlist.ts WATCHLIST_MAX. A REFRESH of an existing
  -- self-subscription is always allowed; only a new row can be over the cap.
  if v_count >= 10 and not exists (
    select 1 from public.watch_subscriptions
     where owner_wallet = v_wallet and watched_wallet = v_wallet
  ) then
    raise exception 'watchlist limit reached for % (% subscriptions)', v_wallet, v_count
      using errcode = 'check_violation';
  end if;

  insert into public.watch_subscriptions (owner_wallet, watched_wallet, risk_profile)
  values (v_wallet, v_wallet, v_profile)
  on conflict (owner_wallet, watched_wallet) do update
     set risk_profile = excluded.risk_profile,
         updated_at   = now();  -- label deliberately untouched

  perform public.watchlist_sync_registry(v_wallet);
end $$;

comment on function public.register_watched_wallet(text, text) is
  'Create or refresh the caller''s OWN self-subscription and resync the registry. Superseded door: POST /api/wallets/register uses server/watchlist.ts. Grants remain revoked from anon/authenticated/public (20260805000001).';

revoke execute on function public.register_watched_wallet(text, text) from public;
revoke execute on function public.register_watched_wallet(text, text) from anon;
revoke execute on function public.register_watched_wallet(text, text) from authenticated;
