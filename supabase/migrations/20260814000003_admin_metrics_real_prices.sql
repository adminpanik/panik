-- ============================================================================
-- PANIK - admin_metrics(): real prices, honest windows (2026-08-14)
--
-- Replaces the function from 20260814000002. Three corrections, all of the same
-- family as the two that migration fixed: a tile that states something the data
-- does not support.
--
-- ── 1. SIMULATED COLLATERAL WAS BEING REPORTED AS REAL ────────────────────
-- The `latest` CTE took the newest snapshot per (wallet, protocol) with no
-- filter on `simulation_id`. The watch worker stamps that column on every score
-- produced under an armed market simulation, and `collateral_usd` in those rows
-- has already been multiplied by the scenario's price multiplier
-- (packages/scoring/src/simulation.ts, applySimulationToReading). So arming a
-- "crash" moved "Collateral monitored" by 40% with nothing on screen saying so,
-- in a console where the simulator panel sits directly below the tiles.
--
-- 20260810000003 added `simulation_id` precisely so that no surface has to
-- guess which numbers came out of a demonstration. This one now asks.
--
-- Consequence worth stating: during a simulation the tiles fall back to the
-- newest REAL snapshot per position, which is older. That is the correct trade -
-- a stale true number beats a fresh imagined one - and the freshness cue below
-- is what makes the staleness visible.
--
-- ── 2. FRESHNESS WAS THE BEST CASE, NOT THE WORST ─────────────────────────
-- `asOf` was `max(created_at)` over the contributing rows, so "Last reading 2
-- min ago" was true of the single newest position while others could be from
-- weeks earlier. A cue whose job is to answer "can I trust this total" has to
-- report the worst contributor, so it is now `min(created_at)`, renamed
-- `oldestReadingAt` so the meaning cannot be misread by the next caller.
--
-- ── 3. THE TRANSACTION TILES NAMED A WINDOW THE TABLE CANNOT HOLD ─────────
-- onchain.lending_events is pruned to 7 DAYS by the nightly retention cron
-- (20260627000002, restated by every migration since). The tiles reported an
-- all-time figure with a "in the last 30 days" companion underneath, which
-- means: two numbers that are necessarily identical, presented as a total and a
-- recent subset of it. The 30-day pair is therefore deleted rather than
-- relabelled, and `txOldestAt` - the oldest event actually on hand - replaces
-- it. Derived from the data, so it cannot drift the day retention changes.
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
  v_wallets      bigint;
  v_positions    bigint;
  v_priced       bigint;
  v_collateral   numeric;
  v_oldest       timestamptz;
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
  -- `simulation_id is null` is the whole point of this migration: see note 1.
  -- A position whose only snapshots were ever taken under a simulation drops
  -- out entirely, which is right - it has never been scored at a real price.
  --
  -- Deliberately NOT windowed to "snapshots in the last N hours". A worker
  -- outage would then empty this table, and the dashboard would report zero
  -- positions and zero collateral rather than stale ones. `oldestReadingAt`
  -- carries the staleness instead, and the console shows it.
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
         -- The WORST contributor, not the best. See note 2.
         min(created_at)
    into v_positions, v_priced, v_collateral, v_oldest
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
    'walletsConnected',   v_wallets,
    'positionsMonitored', v_positions,
    'positionsPriced',    v_priced,
    'collateralUsd',      v_collateral,
    'oldestReadingAt',    v_oldest,
    'eventsReady',        v_events_ready,
    'txCount',            v_tx_count,
    'txVolumeUsd',        v_tx_volume,
    'txUnpriced',         v_tx_unpriced,
    'txOldestAt',         v_tx_oldest,
    'generatedAt',        now()
  );
end
$$;

-- CREATE OR REPLACE keeps the existing privileges, but restating them costs
-- nothing and means this file is correct if it is ever applied to a database
-- that never ran the two migrations before it.
revoke all on function public.admin_metrics() from public;
revoke all on function public.admin_metrics() from anon;
revoke all on function public.admin_metrics() from authenticated;
grant execute on function public.admin_metrics() to service_role;
