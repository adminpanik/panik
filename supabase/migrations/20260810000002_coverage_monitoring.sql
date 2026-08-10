-- ============================================================================
-- PANIK - Coverage monitoring (Phase 4.B, 2026-08-10)
--
-- Everything here exists to make one sentence impossible: "the user believed
-- they were protected and were not." Four changes, each closing a specific way
-- that sentence could currently be true without anyone finding out.
--
--   1. worker_heartbeats   The worker asserts liveness; the ABSENCE of that
--                          assertion is the page. A process cannot observe its
--                          own death, so the assertion has to be durable and
--                          the check has to run somewhere else.
--   2. monitor_alerts      The durable anti-spam gate. In a process map, a
--                          crash-loop turns the gate into a spam amplifier -
--                          every restart re-fires every standing condition, the
--                          channel gets muted, and a muted monitor is itself a
--                          coverage failure.
--   3. telegram_links.*    Reachability evidence. `enabled` conflated LINKED,
--                          SUBSCRIBED and REACHABLE, so a user who blocked the
--                          bot read as fully alerted until the first alert
--                          failed - and the first alert IS the emergency.
--   4. exit_delegations.*  The EIP-7702 grant-time baseline (Issue #41). A
--                          signer can install a delegate AFTER granting, which
--                          makes the executor take its ERC-1271 branch and
--                          refuse a permit that verified fine. Detecting that
--                          transition needs a record of what the signer looked
--                          like at grant time.
--
-- ADDITIVE ONLY. Every statement is `if not exists` / `add column if not
-- exists`, so a re-run is a no-op and no existing row changes meaning: the new
-- delegation columns are NULL for rows written before them, and NULL is read as
-- "not recorded", never as false. A default of false would tell the sweep that
-- every pre-existing smart account had just installed a delegate.
--
-- PII: `wallet` / `user_address` (public chain addresses) and, in
-- monitor_alerts, a wallet column plus an operator-facing summary. No position
-- contents, no USD amounts, no Telegram handles. All three tables are deny-all
-- RLS - monitor_alerts especially, because a public read would be a live list
-- of which wallets currently have broken protection, which is a target list.
-- ============================================================================

-- ── 1. worker_heartbeats - the dead-man's switch ────────────────────────────
-- One row per loop, overwritten on every COMPLETED cycle. `expected_by` is
-- written by the WRITER rather than computed by the reader, so the alert
-- condition is `now() > expected_by` for anything that can run a SELECT: the
-- API process, an uptime check, a dashboard. No consumer needs to know a loop's
-- period, and adding a loop needs no change anywhere else.
create table if not exists public.worker_heartbeats (
  loop        text primary key check (loop ~ '^[a-z0-9_-]{1,40}$'),
  at          timestamptz not null default now(),
  interval_ms integer not null check (interval_ms > 0),
  -- at + interval_ms * (1 + HEARTBEAT_GRACE_CYCLES); see server/workerHeartbeat.ts.
  expected_by timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- The whole monitoring query: overdue loops, worst first.
create index if not exists worker_heartbeats_expected_idx
  on public.worker_heartbeats (expected_by);

alter table public.worker_heartbeats enable row level security;
-- No policies: the worker writes and the API reads, both with the service key.

-- ── 2. monitor_alerts - the durable dedupe ledger ───────────────────────────
-- `key` names the ONGOING CONDITION, not the observation, which is what makes
-- suppression possible at all: two ticks seeing the same missing allowance
-- produce the same key. The claim is an INSERT ... ignore-duplicates followed
-- by a filtered PATCH (see SupabaseAlertLedger), so Postgres decides the winner
-- under the row lock and two racing workers page once rather than twice.
create table if not exists public.monitor_alerts (
  key           text primary key,
  kind          text not null,
  severity      text not null check (severity in ('info', 'warning', 'critical')),
  summary       text,
  -- Lowercased 0x address when the alert concerns one wallet, else null.
  wallet        text check (wallet is null or wallet ~ '^0x[0-9a-f]{40}$'),
  first_seen_at timestamptz not null default now(),
  last_sent_at  timestamptz not null default now()
);

-- The claim's PATCH filters on last_sent_at; the operator view orders by it.
create index if not exists monitor_alerts_last_sent_idx
  on public.monitor_alerts (last_sent_at desc);

alter table public.monitor_alerts enable row level security;

-- ── 3. telegram_links - reachability evidence ───────────────────────────────
-- linked (a row exists) != subscribed (enabled) != reachable (the bot has
-- PROVEN it can deliver, recently). Three facts, three columns' worth of
-- evidence, so the API can report them separately and a surface can say
-- "unverified since <date>" instead of picking a side.
alter table public.telegram_links
  -- Last alert Telegram ACCEPTED. The strongest positive evidence there is.
  add column if not exists last_delivered_at timestamptz,
  -- Last sendChatAction probe and its outcome. getChat succeeds for a blocked
  -- bot and sendMessage spams the user; the typing action is the only
  -- lightweight call that runs Telegram's real delivery permission check.
  add column if not exists last_probe_at     timestamptz,
  add column if not exists last_probe_ok     boolean,
  -- Set ONLY when Telegram itself returned 403. Never a guess, never inferred
  -- from a timeout: this column is the difference between "we know we are
  -- blocked" and "we have not heard from them lately", which are different
  -- facts with different alert severities.
  add column if not exists unreachable_since timestamptz;

-- The sweep's read: links whose reachability proof is going stale.
create index if not exists telegram_links_probe_idx
  on public.telegram_links (last_probe_at)
  where enabled;

-- ── 4. exit_delegations - the EIP-7702 grant-time baseline ──────────────────
-- Recorded at submit time, when the backend has just read getCode(permit.user)
-- to decide whether to verify via ERC-1271. NULL means "not recorded" (a row
-- predating this column), which the sweep reports as UNVERIFIABLE - not as
-- false, which would claim every pre-existing smart account had just installed
-- a delegate, and not as true, which would silence the check entirely.
alter table public.exit_delegations
  add column if not exists signer_had_code  boolean,
  -- keccak256 of the deployed code. A boolean cannot tell "same smart account"
  -- from "re-delegated to an implementation that rejects this signature"; the
  -- hash can.
  add column if not exists signer_code_hash text
    check (signer_code_hash is null or signer_code_hash ~ '^0x[0-9a-f]{64}$');

-- ── 5. Retention - fold into the existing nightly cron ──────────────────────
-- The whole body is restated because cron.schedule REPLACES the job rather than
-- appending; the pattern 20260809000002 established and 20260810000001
-- continued. Resolved alerts are pruned after 30 days (long enough to review an
-- incident, short enough that the dedupe table stays small); heartbeats are
-- never pruned - there is one row per loop and its absence is the signal.
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
  $$
);
