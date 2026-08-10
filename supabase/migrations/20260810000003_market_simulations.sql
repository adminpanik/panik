-- ============================================================================
-- PANIK - Market-event simulation (Phase 4.C, 2026-08-10)
--
-- An operator control that makes positions degrade as if the market had
-- crashed, so the whole protection chain can be shown end to end: band flips,
-- the worker records a transition, the alert fires, the advisor recommends an
-- exit, and the exit the user then signs is a genuine transaction.
--
-- WHAT IS ACTUALLY SIMULATED. We do not control Aave's Base Sepolia oracle, so
-- nothing here moves an on-chain price or an on-chain health factor. The
-- simulation is a SCORING-LAYER PRICE OVERRIDE applied at one seam in
-- packages/scoring (see src/simulation.ts): the engine scores as if the asset
-- had moved by X% and everything downstream reacts for real. Only the price is
-- imagined. Nothing in this migration touches money.
--
--   1. market_simulations           The armed scenario. One at a time.
--   2. score_snapshots.simulation_* Provenance on the numbers it produced.
--   3. watch_transitions.simulation_* Provenance on the crossings it caused.
--
-- WHY THE PROVENANCE COLUMNS ARE THE POINT. A risk product whose history cannot
-- distinguish a real crossing from a demonstrated one is a risk product whose
-- history means nothing. A simulated transition IS a real transition - the
-- score genuinely crossed the user's limit and the alert genuinely went out -
-- but the price that moved it was invented, and six months later nobody can
-- tell those apart from the row alone. These columns are how the record stays
-- readable. They are also why an armed scenario must expire: a simulation left
-- on indefinitely stops being labelled in anyone's head and starts being
-- believed, and this product's entire value is that its numbers are true.
--
-- ADDITIVE ONLY. `create table if not exists`, `add column if not exists`,
-- `create index if not exists` throughout, so a re-run is a no-op. The new
-- columns are NULL on every existing row, and NULL is read as "scored from real
-- prices" - which is correct, because before this migration there was no way to
-- score from anything else. That is the one case where a NULL default is a
-- statement of fact rather than an assumption.
--
-- PII: `set_by` / `cleared_by` hold an admin email (operator identity, needed
-- for the audit trail of who armed what). No wallets, no position contents, no
-- USD amounts. Deny-all RLS: an unauthenticated reader learning that a
-- simulation is running - or worse, that one is not - would let them decide
-- which numbers on a public demo to believe.
-- ============================================================================

-- ── 1. market_simulations - the armed scenario ──────────────────────────────
-- At most one UNCLEARED row (partial unique index below). Expiry is NOT
-- enforced in SQL: `expires_at` is data, and packages/scoring's
-- `activeSimulation()` is the single place a scenario is judged live. A second
-- expiry test written in SQL is a second place for the two to disagree, and the
-- engine's is the one that has to be right because it is the one the price
-- boundary consults.
--
-- Rows are RETAINED after clearing rather than deleted: they are the lookup
-- target for the simulation_id stamped on every snapshot and transition scored
-- under them.
create table if not exists public.market_simulations (
  id           uuid primary key default gen_random_uuid(),
  -- A scenario key from packages/scoring/src/simulation.ts (stress / crash /
  -- blackswan) or 'custom' for an operator-entered per-asset set.
  scenario     text not null check (scenario ~ '^[a-z_]{1,32}$'),
  -- Human label rendered in the user-facing marker: "Crash", "Black swan".
  label        text not null check (length(label) between 1 and 40),
  -- SYMBOL -> price multiplier, e.g. {"cbBTC": 0.6} is cbBTC priced 40% lower.
  -- A multiplier, not a percentage: it is what the engine multiplies by, and
  -- storing the percentage would put the `1 + pct` conversion in two places.
  multipliers  jsonb not null check (jsonb_typeof(multipliers) = 'object'),
  -- Admin email that armed it. The audit trail for "who showed the room this".
  set_by       text not null check (length(set_by) between 1 and 320),
  started_at   timestamptz not null default now(),
  -- The death clock. Bounded window, admin-settable, auto-clearing: an expired
  -- simulation stops affecting scores with nobody doing anything, including
  -- after a process restart that reloaded this row.
  expires_at   timestamptz not null check (expires_at > started_at),
  -- Set when an operator stopped it early. NULL means "still the armed row",
  -- never "already finished" - a row past its expires_at with a NULL here is
  -- normal and simply resolves to no simulation.
  cleared_at   timestamptz,
  cleared_by   text check (cleared_by is null or length(cleared_by) between 1 and 320),
  created_at   timestamptz not null default now()
);

-- EXACTLY ONE ACTIVE SCENARIO. Two concurrent scenarios would mean two answers
-- to "why did this number move", and the marker on screen can name only one.
-- Enforced in the database rather than only in the store because the API and
-- the worker are separate processes and two operators are one race apart.
create unique index if not exists market_simulations_one_active_idx
  on public.market_simulations ((true))
  where cleared_at is null;

-- The boot read and the 10s cache refresh: the uncleared row, newest first.
create index if not exists market_simulations_active_idx
  on public.market_simulations (started_at desc)
  where cleared_at is null;

alter table public.market_simulations enable row level security;
-- No policies: the admin API writes and the scoring processes read, both with
-- the service key. See the PII note in the header for why this is not public.

-- ── 2. score_snapshots - provenance on simulated numbers ────────────────────
-- NULL = scored from real prices. See the header on why that default is a fact
-- rather than an assumption.
alter table public.score_snapshots
  -- The market_simulations row this score was produced under.
  add column if not exists simulation_id uuid references public.market_simulations(id) on delete set null,
  -- The net multiplier applied to THIS leg's health factor
  -- (collateral multiplier / borrow multiplier). Stored alongside the id
  -- because it is the number that explains the row: the scenario may name three
  -- assets and this leg may hold one of them, and a same-asset market lands on
  -- 1.0 because its distance to liquidation genuinely did not move. The id
  -- alone cannot answer "how much of this row is imagined".
  add column if not exists simulation_hf_multiplier double precision;

-- The honest-history read: which snapshots came out of a demonstration.
create index if not exists score_snapshots_simulation_idx
  on public.score_snapshots (simulation_id)
  where simulation_id is not null;

-- ── 3. watch_transitions - provenance on simulated crossings ────────────────
-- The transition is real; the price behind it was not. Both facts are recorded,
-- and the dispatcher reads this column to decide whether the alert body must
-- carry its simulated marker (packages/scoring/src/watch/alertMessage.ts).
alter table public.watch_transitions
  add column if not exists simulation_id uuid references public.market_simulations(id) on delete set null,
  -- Denormalised from market_simulations.label so an alert can be marked
  -- without a join, and so the record survives the scenario row being pruned by
  -- a future retention pass. An alert whose marker depends on a join is an
  -- alert that goes out unmarked the day the join fails.
  add column if not exists simulation_label text;

create index if not exists watch_transitions_simulation_idx
  on public.watch_transitions (simulation_id)
  where simulation_id is not null;

-- ── 4. Retention - fold into the existing nightly cron ──────────────────────
-- The whole body is restated because cron.schedule REPLACES the job rather than
-- appending; the pattern 20260809000002 established and 20260810000002
-- continued. market_simulations is pruned at 180 days - longer than the 90-day
-- snapshot window it explains, so a retained snapshot can never outlive the
-- scenario row that says why it looks the way it does.
do $$ begin perform cron.unschedule('panik_retention'); exception when others then null; end $$;
select cron.schedule(
  'panik_retention',
  '17 3 * * *',  -- daily 03:17 UTC
  $$
    delete from public.score_snapshots     where created_at < now() - interval '90 days';
    delete from onchain.lending_events     where block_time < now() - interval '7 days';
    delete from public.advisor_events      where created_at < now() - interval '90 days';
    delete from public.advisor_narrations  where created_at < now() - interval '90 days';
    delete from public.exit_delegations
      where to_timestamp(deadline) < now() - interval '30 days';
    delete from public.relayer_attempts    where created_at < now() - interval '90 days';
    delete from public.monitor_alerts      where last_sent_at < now() - interval '30 days';
    delete from public.market_simulations  where created_at < now() - interval '180 days';
  $$
);
