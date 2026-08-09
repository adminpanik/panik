-- ============================================================================
-- PANIK - Delegated exit permits (Phase 2.B, 2026-08-09)
-- One row per ExitPermit a user signed (EIP-712) authorising a relayer to run
-- PanikExecutor.atomicExitFor on their behalf. THE DELEGATION IS THE SIGNATURE:
-- PANIK custodies no per-user key, so this table stores the SIGNED permit and
-- its signature and NOTHING that can act on a wallet. The permit carries no
-- recipient - the contract always pays permit.user - so a stored row can never
-- redirect value; the worst it can do is be stale, which the live-permit query
-- (server/exitDelegations.ts) resolves against on-chain state before reporting
-- anything as live.
--
-- Verification the backend runs before an INSERT (server/exitPermit.ts): the
-- signature must recover to `user_address` on the EXECUTOR's EIP-712 domain
-- (Base Sepolia 84532 today, NOT the mainnet 8453 that SIWE uses), the scope
-- must be one the contract's _validatePermitScope would accept, and the permit
-- must be live on-chain (matching revocation epoch, unspent nonce).
--
-- uint256 fields (trigger_health_factor_wad, epoch, nonce) are TEXT so a full
-- 256-bit value round-trips exactly - a Postgres bigint would overflow. The
-- decimal-string CHECKs keep them numeric-only. `deadline` is unix seconds and
-- fits bigint.
--
-- PII: `user_address` only (a public chain address), the same class
-- public.advisor_events / telegram_links already store. No amounts in USD, no
-- position contents - the permit names caps in bps and a health-factor trigger,
-- not balances.
-- ============================================================================

create table if not exists public.exit_delegations (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  -- Lowercased 0x address of the position owner AND sole payout destination.
  user_address              text not null check (user_address ~ '^0x[0-9a-f]{40}$'),
  -- ExitTypes.ExitKind: 0 FULL_EXIT, 1 FULL_REPAY, 2 REDUCE.
  kind                      smallint not null check (kind between 0 and 2),
  -- Per-leg cap on how much LIVE debt may be repaid, bps (10000 = all).
  max_repay_fraction_bps    integer not null check (max_repay_fraction_bps between 1 and 10000),
  -- Execute only while live HF is strictly below this, 1e18 = HF 1.0; 0 = off.
  -- uint256 -> text.
  trigger_health_factor_wad text not null check (trigger_health_factor_wad ~ '^[0-9]+$'),
  -- Worst execution the signer accepts vs oracle, bps. Ceiling enforced against
  -- the executor's immutable maxPermitSlippageBps at submit time.
  max_slippage_bps          integer not null check (max_slippage_bps between 0 and 65535),
  -- Bit i set => ProtocolId(i) allowed (AAVE_V3=0 .. MORPHO_BLUE=3). uint8.
  protocols_mask            integer not null check (protocols_mask between 1 and 255),
  -- Signer's revocation epoch at signing time. uint256 -> text.
  epoch                     text not null check (epoch ~ '^[0-9]+$'),
  -- Unordered (Permit2-style) nonce, any unused 256-bit value. uint256 -> text.
  nonce                     text not null check (nonce ~ '^[0-9]+$'),
  -- Last block.timestamp at which the permit may run, unix seconds.
  deadline                  bigint not null,
  -- The EIP-712 signature. THE delegation; never a key.
  signature                 text not null check (signature ~ '^0x[0-9a-fA-F]+$'),
  -- Lifecycle. `active` is a CLAIM the on-chain reader can override; the live
  -- query recomputes the effective status every read.
  status                    text not null default 'active'
                              check (status in ('active', 'revoked', 'expired', 'consumed')),
  -- The executor domain this permit was verified against, so a redeploy or a
  -- chain flip never mixes permits across contracts.
  chain_id                  integer not null,
  executor_address          text not null check (executor_address ~ '^0x[0-9a-f]{40}$'),
  -- Optional evidence: the user's invalidateUnorderedNonces / revokeAll tx.
  revocation_tx             text
);

-- The nonce is one-shot per user on-chain (nonceBitmap is per-user, epoch does
-- not gate it), so the same nonce must never be stored twice for one wallet on
-- one deployment. Also makes a resubmit idempotent (INSERT ... ignore-duplicates).
create unique index if not exists exit_delegations_nonce_uidx
  on public.exit_delegations (chain_id, executor_address, user_address, nonce);

-- The hot read: a wallet's live delegations, newest first.
create index if not exists exit_delegations_user_active_idx
  on public.exit_delegations (user_address, chain_id, executor_address, created_at desc)
  where status = 'active';

-- Deny-all to the browser: only the service role (API server) reads/writes.
-- The publishable key must never reach this table - a permit list keyed only by
-- address would leak who has set up protection and their exact scope.
alter table public.exit_delegations enable row level security;

-- Retention: fold into the existing nightly cron. The whole body is restated
-- because cron.schedule replaces the job rather than appending - the same
-- pattern 20260809000001_advisor_narrations.sql uses. Delegations are pruned
-- only well AFTER their deadline (30d past), so an expired-but-recent one still
-- shows an honest "expired" status rather than vanishing.
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
  $$
);
