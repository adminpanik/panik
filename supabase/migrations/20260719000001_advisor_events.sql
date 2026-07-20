-- ============================================================================
-- PANIK - Advisor events log (Phase 2, 2026-07-19)
-- Append-only history of Advisor action CHANGES per wallet leg (HOLD -> REDUCE,
-- REDUCE -> EXIT, ...). Written fire-and-forget by /api/advisor; the route
-- works even if an insert fails. Powers a future "advice log" UI and offline
-- evaluation of the rules against realized outcomes. Idempotent.
-- ============================================================================

create table if not exists public.advisor_events (
  id         bigint generated always as identity primary key,
  wallet     text not null,
  protocol   text not null,
  action     text not null,
  urgency    text not null,
  -- Full AdvisorRecommendation snapshot at the moment of the change.
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists advisor_events_wallet_idx
  on public.advisor_events (wallet, created_at desc);

-- Deny-all to the browser: only the service role (API server) reads/writes.
alter table public.advisor_events enable row level security;

-- Retention: fold into the existing nightly cron (90d, matching snapshots).
do $$ begin perform cron.unschedule('panik_retention'); exception when others then null; end $$;
select cron.schedule(
  'panik_retention',
  '17 3 * * *',  -- daily 03:17 UTC
  $$
    delete from public.score_snapshots  where created_at < now() - interval '90 days';
    delete from onchain.lending_events  where block_time < now() - interval '7 days';
    delete from public.advisor_events   where created_at < now() - interval '90 days';
  $$
);
