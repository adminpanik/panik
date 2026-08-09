-- ============================================================================
-- PANIK - Advisor narration audit log (Phase 1 guardrails, 2026-08-09)
-- One row per narration ATTEMPT, including the ones that were thrown away.
-- The guards in packages/scoring/src/providers/narrationGuard.ts discard any
-- narration that invents a number or hedges a critical verdict, so without this
-- table a rejected model response leaves no trace at all. Written
-- fire-and-forget by /api/advisor (server/narrationLog.ts); the route serves
-- advice whether or not the insert lands. Idempotent.
--
-- PII: `wallet` only, which public.advisor_events already stores. The prompt is
-- kept as a hash, never in full - it carries a wallet's whole position and is
-- reconstructible from score_snapshots, so storing it here would make this the
-- most sensitive table in the database for no added answer.
-- ============================================================================

create table if not exists public.advisor_narrations (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  wallet       text not null,
  -- Provider model id, e.g. 'google/gemini-2.5-flash'. Kept per row because the
  -- point of the table is comparing models against their rejection rate.
  model        text not null,
  -- The completion exactly as it arrived, truncated to 8 kB by the writer.
  -- Null where no completion exists: circuit breaker open, hostile token
  -- symbol, provider timeout.
  raw_response text,
  -- Did every numeric token in the completion trace back to the prompt?
  numeric_pass boolean not null,
  -- Did the completion keep a critical verdict unhedged? True by definition on
  -- a non-critical leg, where the check does not run.
  hedge_pass   boolean not null,
  -- Which text the user actually got.
  served       text not null check (served in ('narrated', 'fallback')),
  -- sha256 of the fenced user message; groups repeats of an unchanged position.
  payload_hash text not null
);

create index if not exists advisor_narrations_wallet_idx
  on public.advisor_narrations (wallet, created_at desc);

-- Rejections are the rows worth reading, and they are the rare ones.
create index if not exists advisor_narrations_rejected_idx
  on public.advisor_narrations (created_at desc)
  where served = 'fallback';

-- Deny-all to the browser: only the service role (API server) reads/writes.
alter table public.advisor_narrations enable row level security;

-- Retention: fold into the existing nightly cron. The whole body is restated
-- because cron.schedule replaces the job rather than appending to it - the same
-- pattern 20260719000001_advisor_events.sql uses. 90d, matching snapshots.
do $$ begin perform cron.unschedule('panik_retention'); exception when others then null; end $$;
select cron.schedule(
  'panik_retention',
  '17 3 * * *',  -- daily 03:17 UTC
  $$
    delete from public.score_snapshots     where created_at < now() - interval '90 days';
    delete from onchain.lending_events     where block_time < now() - interval '7 days';
    delete from public.advisor_events      where created_at < now() - interval '90 days';
    delete from public.advisor_narrations  where created_at < now() - interval '90 days';
  $$
);
