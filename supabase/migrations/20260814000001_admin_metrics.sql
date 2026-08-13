-- ============================================================================
-- PANIK - Admin dashboard metrics (2026-08-14)
--
-- One SECURITY DEFINER function returning the whole tile set as jsonb, so the
-- dashboard is a single round trip and no row ever leaves Postgres. The
-- alternative - selecting score_snapshots over PostgREST and summing in Node -
-- ships the entire snapshot history across the wire every time an operator
-- opens the page, to produce five numbers.
--
-- ── WHY NULL AND NOT ZERO ─────────────────────────────────────────────────
-- Every figure here can legitimately be "we do not know", and in a liquidation
-- product those two states must never render the same. A position whose
-- collateral could not be priced is not a position worth nothing; an events
-- pipeline that has not been provisioned has not seen zero transactions. So an
-- absent input returns JSON null, the API passes it through, and the console
-- prints the unknown glyph. `sum()` over no rows is already null in SQL, which
-- is the behaviour we want; the only place that needed care is the events
-- table, handled below.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- Everything is scoped to ACTIVE watched wallets. Unscoped, `lending_events`
-- reports whatever the Goldsky pipeline ingested - potentially every Aave user
-- on Base - which is a number about Base, not a number about PANIK.
--
-- Read by server/metricsStore.ts via POST /rest/v1/rpc/admin_metrics.
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
  -- onchain.lending_events is populated by the Goldsky Mirror pipeline, which
  -- may not be provisioned on a given environment. A static query against a
  -- missing table fails at first execution and takes the whole dashboard with
  -- it, so the reference is dynamic and guarded: absent table -> every
  -- transaction figure stays null and the console says so.
  v_events_ready := to_regclass('onchain.lending_events') is not null;

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

-- The browser must never call this, with or without a session: the figures
-- aggregate every watched wallet, and RLS on the underlying tables is deny-all
-- precisely so a publishable key reaches none of it. A SECURITY DEFINER
-- function granted to `authenticated` would hand back in aggregate exactly what
-- those policies withhold row by row. Only the service key (server-side, behind
-- server/adminGate.ts) may execute it.
revoke all on function public.admin_metrics() from public;
revoke all on function public.admin_metrics() from anon;
revoke all on function public.admin_metrics() from authenticated;
grant execute on function public.admin_metrics() to service_role;
