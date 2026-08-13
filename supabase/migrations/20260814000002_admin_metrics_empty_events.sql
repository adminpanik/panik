-- ============================================================================
-- PANIK - admin_metrics(): distinguish "no pipeline" from "no activity" (2026-08-14)
--
-- Replaces the function from 20260814000001. Two corrections, both found by
-- running it against production: onchain.lending_events exists but has never
-- received a row, so the dashboard reported `eventsReady: true`, `txCount: 0`
-- and `txVolumeUsd: null`.
--
-- ── 1. EXISTENCE IS NOT INGESTION ─────────────────────────────────────────
-- `eventsReady` asked `to_regclass(...) is not null`, which the earlier
-- migration created and therefore always answers yes. The console read that as
-- "the pipeline is here" and rendered 0 transactions - indistinguishable from a
-- genuinely quiet month. The table is empty because the Goldsky Mirror pipeline
-- has never written to it. Readiness now means AT LEAST ONE ROW EXISTS, so an
-- un-ingested table reports itself as absent and the tiles say so.
--
-- ── 2. A KNOWN ZERO IS NOT AN UNKNOWN ─────────────────────────────────────
-- `sum()` over zero rows is null; `count()` over the same zero rows is 0. The
-- pair rendered as "Transactions 0" beside "Transaction volume $…", which
-- claims we lost a figure we actually know: nothing happened, so the volume of
-- it is zero. When the event count is 0 the volume is now 0 too.
--
-- The reverse case is untouched and still null: events that exist but carry no
-- USD amount are genuinely unpriced, and `txUnpriced` reports how many. That is
-- the case the "never render an unknown as a zero" rule exists for, and this
-- migration must not weaken it.
-- ============================================================================

create or replace function public.admin_metrics()
returns jsonb
language plpgsql
security definer
-- Empty search_path: a SECURITY DEFINER function that inherits the caller's
-- path can be aimed at a shadowing table in a schema the caller controls.
-- Every reference below is therefore schema-qualified.
set search_path = ''
as $$
declare
  v_wallets       bigint;
  v_positions     bigint;
  v_priced        bigint;
  v_collateral    numeric;
  v_as_of         timestamptz;
  v_tx_count      bigint;
  v_tx_volume     numeric;
  v_tx_unpriced   bigint;
  v_tx_count_30d  bigint;
  v_tx_volume_30d numeric;
  v_events_ready  boolean;
begin
  -- ── Wallets connected ────────────────────────────────────────────────────
  -- The watch registry is the honest answer: a row here is an address someone
  -- connected AND is being scored for. public.wallet_profiles is a scan cache
  -- (any address anyone ever looked up) and would inflate this severalfold.
  select count(*) into v_wallets
    from public.watched_wallets
   where is_active;

  -- ── Positions monitored + collateral under watch ─────────────────────────
  -- One row per (wallet, protocol) at its most recent snapshot. DISTINCT ON is
  -- the cheap form here: the index on (wallet, protocol, created_at desc)
  -- already orders it, so this is a walk and not a sort.
  --
  -- Deliberately NOT windowed to "snapshots in the last N hours". A worker
  -- outage would then empty this table, and the dashboard would report zero
  -- positions and zero collateral rather than stale ones. `asOf` carries the
  -- staleness instead, and the console shows it.
  with latest as (
    select distinct on (s.wallet, s.protocol)
           s.collateral_usd,
           s.created_at
      from public.score_snapshots s
      join public.watched_wallets w
        on w.wallet = s.wallet
       and w.is_active
     order by s.wallet, s.protocol, s.created_at desc
  )
  select count(*),
         -- count(col) skips nulls: how many of those positions we could price.
         count(collateral_usd),
         sum(collateral_usd),
         max(created_at)
    into v_positions, v_priced, v_collateral, v_as_of
    from latest;

  -- ── Transactions ─────────────────────────────────────────────────────────
  -- Two conditions, not one. The table must exist AND hold at least one row:
  -- 20260613000001 creates it whether or not the Goldsky pipeline was ever
  -- provisioned, so existence alone says nothing about ingestion. Both reads
  -- are dynamic because a static reference to a missing table fails at first
  -- execution and takes the whole dashboard down with it.
  v_events_ready := to_regclass('onchain.lending_events') is not null;

  if v_events_ready then
    -- EXISTS stops at the first row; it never counts the table.
    execute 'select exists (select 1 from onchain.lending_events)' into v_events_ready;
  end if;

  if v_events_ready then
    execute $q$
      select count(*),
             sum(e.amount_usd),
             count(*) filter (where e.amount_usd is null),
             count(*) filter (where e.block_time >= now() - interval '30 days'),
             sum(e.amount_usd) filter (where e.block_time >= now() - interval '30 days')
        from onchain.lending_events e
        join public.watched_wallets w
          on w.wallet = lower(e.user_address)
         and w.is_active
    $q$
    into v_tx_count, v_tx_volume, v_tx_unpriced, v_tx_count_30d, v_tx_volume_30d;

    -- No events for our wallets means the volume of those events is zero, and
    -- we know it. Only the empty case: with rows present, a null sum means the
    -- amounts were never priced and must stay unknown.
    if v_tx_count = 0 then v_tx_volume := 0; end if;
    if v_tx_count_30d = 0 then v_tx_volume_30d := 0; end if;
  end if;

  return jsonb_build_object(
    'walletsConnected',    v_wallets,
    'positionsMonitored',  v_positions,
    'positionsPriced',     v_priced,
    'collateralUsd',       v_collateral,
    'asOf',                v_as_of,
    'eventsReady',         v_events_ready,
    'txCount',             v_tx_count,
    'txVolumeUsd',         v_tx_volume,
    'txUnpriced',          v_tx_unpriced,
    'txCount30d',          v_tx_count_30d,
    'txVolumeUsd30d',      v_tx_volume_30d,
    'generatedAt',         now()
  );
end
$$;

-- CREATE OR REPLACE keeps the existing privileges, but restating them costs
-- nothing and means this file is correct if it is ever applied to a database
-- that never ran 20260814000001.
revoke all on function public.admin_metrics() from public;
revoke all on function public.admin_metrics() from anon;
revoke all on function public.admin_metrics() from authenticated;
grant execute on function public.admin_metrics() to service_role;
