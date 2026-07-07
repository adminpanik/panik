-- ============================================================================
-- PANIK - Trial email capture (2026-07-07)
-- Scope: require an email on the /try "Try Now" flow so we can see HOW MANY
--        users redeemed a card and WHO they are. The email is stored on the
--        per-user grant (one row per successful redemption = one user), so the
--        count of trial_grants with an email = the number of users, and the
--        email column is the contact list.
--
-- Idempotent (safe to re-run). ADDITIVE ONLY.
--
-- Builds on supabase/migrations/20260704000001_product_codes.sql. The RPC there
-- (redeem_campaign_code) is redefined here to accept + persist p_email. Access
-- stays identical: deny-all RLS, SECURITY DEFINER, service_role only.
-- ============================================================================

-- ── 1. email column on the per-user grant ──────────────────────────────────
-- Nullable: existing grants (pre-email) stay valid, and the DB stays tolerant
-- even though the API + frontend now REQUIRE an email. Same lower(btrim(...))
-- normalization the waitlist uses, so emails collate consistently across tables.
alter table public.trial_grants add column if not exists email text;

-- Light format guard (mirrors the client-side isValidEmail check). NOT VALID so
-- it never trips on any legacy rows; it applies to every new insert.
do $$ begin
  alter table public.trial_grants
    add constraint trial_grants_email_format
    check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    not valid;
exception when duplicate_object then null; end $$;

-- Fast lookups / dedupe when reading the contact list.
create index if not exists idx_trial_grants_email on public.trial_grants (email);

-- ── 2. redeem_campaign_code - now captures the redeemer's email ─────────────
-- Same atomic usage/time check + single attempt-log as before; the only change
-- is the new p_email param, normalized and stored on the minted grant. Dropping
-- the old 3-arg signature first avoids an overload ambiguity in PostgREST (it
-- resolves RPCs by the set of named args, and only one function may match).
drop function if exists public.redeem_campaign_code(text, text, text);

create or replace function public.redeem_campaign_code(
  p_code  text,
  p_ip    text default null,
  p_ua    text default null,
  p_email text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_email    text := nullif(lower(btrim(coalesce(p_email, ''))), '');
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
      insert into public.trial_grants (campaign_id, access_token, email, claim_ip, claim_user_agent)
      values (v_campaign.id, v_token, v_email, p_ip, p_ua)
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

revoke all on function public.redeem_campaign_code(text, text, text, text) from public;
grant execute on function public.redeem_campaign_code(text, text, text, text) to service_role;
