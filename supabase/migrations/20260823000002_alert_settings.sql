-- ============================================================================
-- PANIK - Per-user alert tuning and digest mode (7.4 / 7.5, 2026-08-23)
--
-- One row per SUBSCRIBER (owner_wallet), holding what they want to be told and
-- when. Every column is nullable and null means "use the engine default"
-- (packages/scoring/src/watch/alertSettings.ts DEFAULT_ALERT_SETTINGS). That is
-- not laziness about defaults - it is the only way the shipped policy stays in
-- ONE place: a `default 50` here would be a second copy of
-- ALERT_POLICY.minBorrowUsd, free to drift the day the engine retunes it.
--
-- SERVER-SIDE, AND THAT IS THE POINT. Mute and quiet hours are enforced in the
-- dispatcher (server/watchDispatch.ts -> decideSend). A client that stops
-- rendering an alert has muted nothing; the message was already sent.
--
-- EVERY WRITE NEEDS A SIGNATURE. These values decide whether a person is warned
-- before a liquidation, so naming somebody else's address must not be enough to
-- silence them. POST /api/alerts/settings verifies a SIWE proof carrying
-- `urn:panik:action:alert-settings` - its OWN action URN, so a signature
-- collected for linking Telegram or managing a watchlist cannot mute alerts.
-- ============================================================================

create table if not exists public.alert_settings (
  owner_wallet       text primary key
                     check (owner_wallet = lower(owner_wallet) and owner_wallet ~ '^0x[0-9a-f]{40}$'),
  -- Dust floor in USD. Null = the engine's minBorrowUsd.
  min_borrow_usd     numeric check (min_borrow_usd >= 0),
  -- Null = the engine's cooldownMs. A critical alert is clamped back to the
  -- engine default in code (effectiveCooldownMs): a preference may make you
  -- better warned than the default, never worse.
  cooldown_minutes   integer check (cooldown_minutes between 0 and 10080),
  -- Minutes past midnight UTC. Both null = no quiet hours; a start greater than
  -- an end wraps past midnight (22:00 -> 07:00).
  quiet_start_minute integer check (quiet_start_minute between 0 and 1439),
  quiet_end_minute   integer check (quiet_end_minute between 0 and 1439),
  muted_protocols    text[] not null default '{}',
  -- Entries are 'wallet:protocol'. A position, not a wallet: someone watching
  -- a whale on four protocols may only care about the leveraged one.
  muted_positions    text[] not null default '{}',
  digest_frequency   text not null default 'off'
                     check (digest_frequency in ('off', 'hourly', 'daily')),
  -- When the last digest actually went out. Doubles as the "since" the digest
  -- message quotes, so the two can never disagree.
  last_digest_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Half a window silences nothing while looking on screen as if it did.
  constraint alert_settings_quiet_hours_paired
    check ((quiet_start_minute is null) = (quiet_end_minute is null))
);

comment on table public.alert_settings is
  'Per-subscriber alert tuning (7.4) and digest mode (7.5). Null column = the engine default in packages/scoring/src/watch/alertSettings.ts. Enforced server-side by the dispatcher; every write needs a SIWE proof for urn:panik:action:alert-settings.';
comment on column public.alert_settings.owner_wallet is
  'The SUBSCRIBER whose alerts these settings govern - the same address watch_subscriptions.owner_wallet carries, never the watched wallet.';
comment on column public.alert_settings.digest_frequency is
  'off / hourly / daily. Applies to non-critical alerts only: a position over the user''s own limit, or scored in the CRITICAL band, is never batched and never held for quiet hours (packages/scoring/src/watch/alertPolicy.ts).';
comment on column public.alert_settings.muted_positions is
  'wallet:protocol pairs. A mute silences the warning zone, not a liquidation: critical alerts break through it by design.';

drop trigger if exists trg_alert_settings_updated on public.alert_settings;
create trigger trg_alert_settings_updated
  before update on public.alert_settings
  for each row execute function public.set_updated_at();

alter table public.alert_settings enable row level security;
-- No policies on purpose: deny-all for publishable-key clients. The API (owner
-- role) and the worker (direct pg) bypass RLS; the browser goes through the
-- signed endpoint or it does not write at all.
