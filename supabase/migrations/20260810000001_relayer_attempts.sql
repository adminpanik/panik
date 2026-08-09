-- ============================================================================
-- PANIK - Relayer submission ledger (Phase 4.A, 2026-08-10)
--
-- One row per ExitPermit the relayer has tried to submit. This table exists for
-- exactly one reason: A PERMIT MUST NEVER BE SUBMITTED TWICE.
--
-- The chain already refuses a replay (PanikExecutor spends the nonce bit inside
-- atomicExitFor), and isNonceUsed() reports it. But that read only becomes true
-- once the transaction has LANDED. In the window between broadcast and receipt
-- the chain still says "unused", so a second tick - or a worker that crashed and
-- restarted inside that window - would submit the same permit again: two
-- transactions, one wins, one reverts, and the relayer paid for both.
--
-- The unique index below closes that window. The relayer claims a row BEFORE it
-- broadcasts, so the claim is atomic and the loser gets a conflict rather than a
-- race. Because the claim is in Postgres and not in a process's memory, a
-- crash-restart finds the in_flight row and refuses to re-fire the permit.
--
-- RETRIES. A reverted atomicExitFor unwinds its own nonce spend, so a failed
-- attempt leaves the permit genuinely reusable - which is exactly how a relayer
-- burns its gas wallet on a permit that will never succeed. `attempts` bounds
-- that (RELAYER_MAX_ATTEMPTS_PER_PERMIT, default 3). Rows are never deleted on
-- failure: "tried three times and stopped" is the fact an operator needs.
--
-- WHAT IS NOT HERE: no key material, no signature, no position contents, no USD
-- amounts. The delegation itself lives in public.exit_delegations; this table
-- only records what the relayer DID about one, plus the gas it cost. PII is
-- `user_address` (a public chain address), the same class exit_delegations and
-- telegram_links already store, plus `signer_address`, which is PANIK's own
-- relayer EOA and public by definition.
-- ============================================================================

create table if not exists public.relayer_attempts (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- The executor domain this permit belongs to. Carried so a redeploy or a
  -- chain flip can never let an attempt on one deployment suppress the other.
  chain_id             integer not null,
  executor_address     text not null check (executor_address ~ '^0x[0-9a-f]{40}$'),
  -- Position owner and sole payout destination (permit.user).
  user_address         text not null check (user_address ~ '^0x[0-9a-f]{40}$'),
  -- The permit's unordered uint256 nonce -> text, so a full 256-bit value
  -- round-trips exactly (a Postgres bigint would overflow), matching
  -- public.exit_delegations.nonce.
  permit_nonce         text not null check (permit_nonce ~ '^[0-9]+$'),
  -- in_flight: claimed, not yet resolved. Never re-fired while in this state.
  status               text not null default 'in_flight'
                         check (status in ('in_flight', 'succeeded', 'failed')),
  -- How many times this permit has been claimed. Bounded by the relayer.
  attempts             integer not null default 1 check (attempts >= 0),
  -- The broadcast transaction. Null until one exists; a replacement (fee bump)
  -- overwrites it with the replacing hash, because only one of the pair can mine.
  tx_hash              text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  -- Which pool EOA paid. PANIK's own address; never a user's.
  signer_address       text check (signer_address is null or signer_address ~ '^0x[0-9a-f]{40}$'),
  -- Gas actually consumed and the price paid, from the RECEIPT (never the
  -- estimate). uint256 -> text for the same reason permit_nonce is.
  gas_used             text check (gas_used is null or gas_used ~ '^[0-9]+$'),
  effective_gas_price  text check (effective_gas_price is null or effective_gas_price ~ '^[0-9]+$'),
  fee_wei              text check (fee_wei is null or fee_wei ~ '^[0-9]+$'),
  -- Why it failed, truncated. Free text: it is a revert string or an RPC error.
  error                text
);

-- THE IDEMPOTENCY KEY. One attempt row per permit per deployment. The relayer's
-- claim is an INSERT against this index, so two workers racing the same permit
-- produce one winner and one 409 rather than two transactions.
create unique index if not exists relayer_attempts_permit_uidx
  on public.relayer_attempts (chain_id, executor_address, user_address, permit_nonce);

-- The boot read: attempts left unresolved by a crash, oldest first.
create index if not exists relayer_attempts_in_flight_idx
  on public.relayer_attempts (chain_id, executor_address, updated_at)
  where status = 'in_flight';

-- Deny-all to the browser: only the service role (worker) reads/writes. A
-- public read would leak which wallets have standing protection AND when PANIK
-- acted on it, which is a map of who was close to liquidation and exactly when.
alter table public.relayer_attempts enable row level security;

-- Retention: fold into the existing nightly cron. The whole body is restated
-- because cron.schedule REPLACES the job rather than appending - the pattern
-- 20260809000002_exit_delegations.sql established. Attempts are kept 90 days,
-- matching score_snapshots, so a post-incident review can still reconstruct a
-- quarter of relayer behaviour.
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
  $$
);
