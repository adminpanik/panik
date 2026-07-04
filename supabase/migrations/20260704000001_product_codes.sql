-- ============================================================================
-- PANIK - Product trial codes schema v1 (2026-07-04)
-- Scope: the "2-in-1 business card" trial. A physical card carries a QR + a
--        printed short code (a CAMPAIGN). Scanning lands on /try?code=... and
--        clicking "Try Now" redeems the campaign, minting the visitor a UNIQUE,
--        per-user access token used as an expiring link into the core app
--        (/app?trial=PANIK-XXXXXX). The per-user trial clock starts when the
--        user first OPENS the app with their link (not at creation/redeem).
--
-- Idempotent (safe to re-run). ADDITIVE ONLY.
--
-- Access model (same as the rest of the project):
--   * All new tables are deny-all RLS (zero policies).
--   * The browser NEVER calls these functions directly. Redemption and app-open
--     go through the backend (/api/try/*) which holds the Supabase secret key
--     (service_role) - this lets us capture IP/User-Agent and keeps the honeypot
--     meaningful. So, unlike public.waitlist_signup (granted to anon), these
--     SECURITY DEFINER functions are locked to service_role.
--   * Admin CRUD (create/list/expire campaigns) is done by the backend over the
--     PostgREST table API with the secret key (bypasses RLS) - see
--     server/campaignStore.ts.
--
-- Depends on public.set_updated_at() (supabase/migrations/20260613000001).
-- ============================================================================

create extension if not exists pgcrypto;

-- ── 0. Short-code suffix generator ──────────────────────────────────────────
-- Crockford-style unambiguous alphabet: no 0/1/I/O (avoids read/typo errors on
-- a printed card). 32 symbols, so each byte maps cleanly via `% 32`.
create or replace function public.gen_panik_suffix(p_len int)
returns text
language plpgsql
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes  bytea := gen_random_bytes(p_len);
  v_out    text  := '';
  i        int;
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end $$;

-- ── 1. product_campaigns - one row per card / QR batch (admin-created) ───────
create table if not exists public.product_campaigns (
  id                      uuid primary key default gen_random_uuid(),
  -- Printed short code, e.g. PANIK-TRY-8X2Q. Same unambiguous alphabet.
  campaign_code           text not null unique
                          check (campaign_code ~ '^PANIK-TRY-[2-9A-HJ-NP-Z]{4,8}$'),
  label                   text,
  -- Usage limit: max number of successful redemptions (unique users).
  max_redemptions         int not null check (max_redemptions > 0),
  redemption_count        int not null default 0 check (redemption_count >= 0),
  -- Per-user trial length once the user first opens the app.
  trial_duration_hours    int not null check (trial_duration_hours > 0),
  -- Optional cutoff for CLAIMING the code (null = no claim deadline). This is
  -- the campaign-level time limit; it is independent of the per-user trial.
  claim_window_expires_at timestamptz,
  -- Manual kill switch (admin "expire early").
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

drop trigger if exists trg_product_campaigns_updated on public.product_campaigns;
create trigger trg_product_campaigns_updated
  before update on public.product_campaigns
  for each row execute function public.set_updated_at();

-- ── 2. trial_grants - one row per successful redemption (per-user link) ──────
create table if not exists public.trial_grants (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.product_campaigns(id) on delete cascade,
  -- The token embedded in /app?trial=PANIK-XXXXXX. Unique per user.
  access_token     text not null unique
                   check (access_token ~ '^PANIK-[2-9A-HJ-NP-Z]{6}$'),
  -- Null until the FIRST time the app is opened with this token. Setting it
  -- STARTS THE CLOCK (see open_trial).
  first_opened_at  timestamptz,
  -- Derived on first open = first_opened_at + trial_duration_hours.
  expires_at       timestamptz,
  claim_ip         text,
  claim_user_agent text,
  created_at       timestamptz not null default now()
);

create index if not exists idx_trial_grants_campaign on public.trial_grants (campaign_id);
create index if not exists idx_trial_grants_expires  on public.trial_grants (expires_at);

-- ── 3. redemption_attempts - log EVERY Try-Now attempt (success or fail) ─────
create table if not exists public.redemption_attempts (
  id               bigint generated always as identity primary key,
  campaign_code    text,
  outcome          text not null
                   check (outcome in ('success','not_found','disabled','expired','exhausted')),
  ip               text,
  user_agent       text,
  granted_token_id uuid references public.trial_grants(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_redemption_attempts_created on public.redemption_attempts (created_at);
create index if not exists idx_redemption_attempts_code    on public.redemption_attempts (campaign_code);

-- ── 4. RLS - deny-all (backend uses the secret key / service_role) ──────────
alter table public.product_campaigns   enable row level security;
alter table public.trial_grants        enable row level security;
alter table public.redemption_attempts enable row level security;
-- No policies on purpose: publishable-key clients get nothing here.

-- ── 5. redeem_campaign_code - atomic usage/time check + mint token ──────────
-- Returns jsonb: {"outcome":"success","token":"PANIK-XXXXXX"} on success, or
-- {"outcome":"not_found|disabled|expired|exhausted"} otherwise. Every call logs
-- exactly one redemption_attempts row. The guarded UPDATE is the concurrency
-- boundary: only one caller can take the last remaining slot.
create or replace function public.redeem_campaign_code(
  p_code text,
  p_ip   text default null,
  p_ua   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_campaign public.product_campaigns;
  v_token    text;
  v_grant_id uuid;
  attempt    int;
begin
  select * into v_campaign
    from public.product_campaigns
   where campaign_code = v_code
   limit 1;

  if not found then
    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)
    values (v_code, 'not_found', p_ip, p_ua);
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if not v_campaign.is_active then
    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)
    values (v_code, 'disabled', p_ip, p_ua);
    return jsonb_build_object('outcome', 'disabled');
  end if;

  if v_campaign.claim_window_expires_at is not null
     and now() >= v_campaign.claim_window_expires_at then
    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)
    values (v_code, 'expired', p_ip, p_ua);
    return jsonb_build_object('outcome', 'expired');
  end if;

  -- Atomic usage-limit guard. Re-checks the count under a row lock so two
  -- concurrent redemptions can't both take the final slot.
  update public.product_campaigns
     set redemption_count = redemption_count + 1
   where id = v_campaign.id
     and is_active
     and redemption_count < max_redemptions
     and (claim_window_expires_at is null or now() < claim_window_expires_at);

  if not found then
    -- Lost the race, or just hit the limit / window between the read and here.
    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)
    values (v_code, 'exhausted', p_ip, p_ua);
    return jsonb_build_object('outcome', 'exhausted');
  end if;

  -- Mint a unique per-user access token (retry on the astronomically rare clash).
  for attempt in 1 .. 5 loop
    v_token := 'PANIK-' || public.gen_panik_suffix(6);
    begin
      insert into public.trial_grants (campaign_id, access_token, claim_ip, claim_user_agent)
      values (v_campaign.id, v_token, p_ip, p_ua)
      returning id into v_grant_id;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;

  insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)
  values (v_code, 'success', p_ip, p_ua, v_grant_id);

  return jsonb_build_object('outcome', 'success', 'token', v_token);
end $$;

revoke all on function public.redeem_campaign_code(text, text, text) from public;
grant execute on function public.redeem_campaign_code(text, text, text) to service_role;

-- ── 6. open_trial - resolve a token; start the clock on first open ──────────
-- Returns jsonb: {"outcome":"active|expired|invalid","expiresAt":<ts?>}.
create or replace function public.open_trial(
  p_token text,
  p_ip    text default null,
  p_ua    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   text := upper(btrim(coalesce(p_token, '')));
  v_grant   public.trial_grants;
  v_hours   int;
  v_expires timestamptz;
begin
  select * into v_grant from public.trial_grants where access_token = v_token limit 1;
  if not found then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  -- First open: start the clock now.
  if v_grant.first_opened_at is null then
    select trial_duration_hours into v_hours
      from public.product_campaigns where id = v_grant.campaign_id;
    v_expires := now() + make_interval(hours => v_hours);
    update public.trial_grants
       set first_opened_at   = now(),
           expires_at        = v_expires,
           claim_ip          = coalesce(claim_ip, p_ip),
           claim_user_agent  = coalesce(claim_user_agent, p_ua)
     where id = v_grant.id;
    return jsonb_build_object('outcome', 'active', 'expiresAt', v_expires);
  end if;

  if now() >= v_grant.expires_at then
    return jsonb_build_object('outcome', 'expired', 'expiresAt', v_grant.expires_at);
  end if;

  return jsonb_build_object('outcome', 'active', 'expiresAt', v_grant.expires_at);
end $$;

revoke all on function public.open_trial(text, text, text) from public;
grant execute on function public.open_trial(text, text, text) to service_role;

-- ── 7. Retention - drop long-expired grants + old attempt logs (pg_cron) ────
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('panik_trial_grants_cleanup'); exception when others then null; end $$;
select cron.schedule(
  'panik_trial_grants_cleanup',
  '37 * * * *',  -- hourly at :37
  $$
    delete from public.trial_grants
      where expires_at is not null and expires_at < now() - interval '30 days';
    delete from public.redemption_attempts
      where created_at < now() - interval '90 days';
  $$
);
