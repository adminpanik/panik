-- ============================================================================
-- PANIK - admin_metrics(): freshness as a ratio, not a worst case (2026-08-14)
--
-- Replaces the function from 20260814000003, which is four hours old. That one
-- changed the freshness cue from max(created_at) to min(created_at), because
-- "Last reading just now" described the single newest position while the total
-- beside it was built from readings up to a week old.
--
-- min() was right about max() and wrong about itself.
--
-- ── WHAT THE DATA SHOWED ──────────────────────────────────────────────────
-- Restoring the RPC took the worker from 10 positions scored per 30 minutes to
-- 20 of 21 scored every 15. The cue did not move: it still read "Oldest reading
-- 7 d old", because ONE leg - 0x9452ed6d…'s Aave position, closed on-chain -
-- keeps its final snapshot forever and pins min() to the day it closed.
--
-- So the cue now reports the same thing whether the pipeline is healthy or
-- entirely dead, which is the same failure as max() with the sign flipped. An
-- extreme of a distribution is not a summary of it. One dead leg should cost
-- one position out of twenty-one, not the entire signal.
--
-- ── WHAT REPLACES IT ──────────────────────────────────────────────────────
-- `positionsFresh` counts the positions whose latest reading is inside the
-- worker's snapshot heartbeat, so the console can say "20 of 21 read in the
-- last 15 min". A single stale leg costs one from the numerator and stays
-- visible; a real outage collapses the numerator toward zero. Both readings are
-- proportionate to what actually happened.
--
-- `freshWindowMinutes` is returned rather than hardcoded in the console,
-- because the window is a fact about the worker and the console should not hold
-- a second opinion about it.
--
-- `oldestReadingAt` is dropped rather than kept alongside. Two freshness cues on
-- one card is one cue and one distraction, and `Stat` truncates its subline to a
-- single line, so the second would arrive clipped rather than informative.
--
-- ── NOT FIXED HERE ────────────────────────────────────────────────────────
-- The closed leg is still counted in `positionsMonitored` and its $19,241 is
-- still inside `collateralUsd`. That needs the worker to write a closing
-- snapshot when a leg stops being reported, which is a change to the money path
-- and does not belong in a display function. This migration makes that position
-- VISIBLE - it is the difference between 20 and 21 - rather than hiding it.
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
  -- The worker writes a snapshot on score CHANGE or on this heartbeat, so a
  -- position read inside it is behaving and one outside it is not. Mirrors
  -- SNAPSHOT_HEARTBEAT_MS in scripts/watch-worker.ts; it is returned to the
  -- caller below so the console never states a window of its own.
  c_fresh_window constant interval := interval '15 minutes';

  v_wallets      bigint;
  v_positions    bigint;
  v_priced       bigint;
  v_fresh        bigint;
  v_collateral   numeric;
  v_tx_count     bigint;
  v_tx_volume    numeric;
  v_tx_unpriced  bigint;
  v_tx_oldest    timestamptz;
  v_events_ready boolean;
begin
  -- ── Wallets connected ────────────────────────────────────────────────────
  -- The watch registry is the honest answer: a row here is an address someone
  -- connected AND is being scored for. public.wallet_profiles is a scan cache
  -- (any address anyone ever looked up) and would inflate this severalfold.
  select count(*) into v_wallets
    from public.watched_wallets
   where is_active;

  -- ── Positions monitored + collateral under watch ─────────────────────────
  -- One row per (wallet, protocol) at its most recent REAL snapshot. DISTINCT
  -- ON is the cheap form here: the index on (wallet, protocol, created_at desc)
  -- already orders it, so this is a walk and not a sort.
  --
  -- `simulation_id is null` keeps a demonstration's imagined prices out of the
  -- operator's figures (20260814000003). A position whose only snapshots were
  -- ever taken under a simulation drops out entirely, which is right - it has
  -- never been scored at a real price.
  --
  -- Deliberately NOT windowed to recent snapshots. A worker outage would then
  -- empty this table, and the dashboard would report zero positions and zero
  -- collateral rather than stale ones. `positionsFresh` carries the staleness
  -- instead, and the console shows it as a ratio.
  --
  -- ponytail: a CLOSED position keeps its last snapshot forever (the worker
  -- writes on change or heartbeat, and a leg the adapter stops reporting simply
  -- stops producing rows), so it is counted until the 90-day retention sweep
  -- drops it. Fixing that means the worker writing a closing snapshot, which is
  -- a change to the money path and not to this function.
  with latest as (
    select distinct on (s.wallet, s.protocol)
           s.collateral_usd,
           s.created_at
      from public.score_snapshots s
      join public.watched_wallets w
        on w.wallet = s.wallet
       and w.is_active
     where s.simulation_id is null
     order by s.wallet, s.protocol, s.created_at desc
  )
  select count(*),
         -- count(col) skips nulls: how many of those positions we could price.
         count(collateral_usd),
         sum(collateral_usd),
         count(*) filter (where created_at > now() - c_fresh_window)
    into v_positions, v_priced, v_collateral, v_fresh
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
    -- No 30-day pair: retention keeps 7 days, so it could only ever restate
    -- the total. `min(block_time)` says what the total actually covers.
    execute $q$
      select count(*),
             sum(e.amount_usd),
             count(*) filter (where e.amount_usd is null),
             min(e.block_time)
        from onchain.lending_events e
        join public.watched_wallets w
          on w.wallet = lower(e.user_address)
         and w.is_active
    $q$
    into v_tx_count, v_tx_volume, v_tx_unpriced, v_tx_oldest;

    -- No events for our wallets means the volume of those events is zero, and
    -- we know it. Only the empty case: with rows present, a null sum means the
    -- amounts were never priced and must stay unknown.
    if v_tx_count = 0 then v_tx_volume := 0; end if;
  end if;

  return jsonb_build_object(
    'walletsConnected',    v_wallets,
    'positionsMonitored',  v_positions,
    'positionsPriced',     v_priced,
    'positionsFresh',      v_fresh,
    -- ::int, because `extract` yields numeric and jsonb keeps every trailing
    -- zero it is handed: the raw form serialises as 15.0000000000000000, and a
    -- window is whole minutes.
    'freshWindowMinutes',  (extract(epoch from c_fresh_window) / 60)::int,
    'collateralUsd',       v_collateral,
    'eventsReady',         v_events_ready,
    'txCount',             v_tx_count,
    'txVolumeUsd',         v_tx_volume,
    'txUnpriced',          v_tx_unpriced,
    'txOldestAt',          v_tx_oldest,
    'generatedAt',         now()
  );
end
$$;

-- CREATE OR REPLACE keeps the existing privileges, but restating them costs
-- nothing and means this file is correct if it is ever applied to a database
-- that never ran the migrations before it.
revoke all on function public.admin_metrics() from public;
revoke all on function public.admin_metrics() from anon;
revoke all on function public.admin_metrics() from authenticated;
grant execute on function public.admin_metrics() to service_role;
