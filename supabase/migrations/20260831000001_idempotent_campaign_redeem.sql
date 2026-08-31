-- ============================================================================
-- PANIK - Idempotent campaign redemption, per (campaign, email) (2026-08-31)
-- Scope: stop one account spending more than one slot of a campaign.
--
-- Idempotent (safe to re-run). Rewrites public.redeem_campaign_code in place
-- and deletes duplicate grants that the missing guard already created.
--
-- ── THE INCIDENT ───────────────────────────────────────────────────────────
-- On 2026-08-31 a tester submitted PANIK-TRY-45QUHHUP twice in sixteen seconds
-- from one signed-in account. Both calls reached redeem_campaign_code, both
-- passed the usage-limit UPDATE, and both minted a grant: two rows in
-- trial_grants carrying the same email, two increments of redemption_count, and
-- one membership (the account layer's own unique index caught that half).
--
-- The function had no notion of who was redeeming. Its only concurrency guard
-- was the campaign-wide count, which is a guard on "how many slots are left",
-- not on "has this person already taken one". So N racing submits burn N slots
-- and a print run of 50 can be drained by one impatient reader on a slow phone.
--
-- ── WHAT CLOSES IT ─────────────────────────────────────────────────────────
-- Two things, because either alone is not enough:
--
--   1. A per-(campaign, email) advisory lock taken INSIDE the function, before
--      the existing-grant lookup. This is what makes the lookup authoritative.
--      A bare pre-check SELECT is exactly what a reasonable reading of the old
--      code would have added, and it is exactly what would have failed again:
--      two transactions both read "no grant", both proceed, both insert.
--
--   2. A unique index on (campaign_id, lower(email)). The lock serialises the
--      callers that take it; the index is the guarantee that does not depend on
--      a future caller remembering to. The function handles its violation by
--      handing back the grant the winner made, so a lost race is still a
--      success for the user rather than a 500.
--
-- An already-granted address gets its OWN grant back, without a new row and
-- without touching redemption_count. It is the same trial they already hold.
--
-- Builds on supabase/migrations/20260704000001_product_codes.sql (tables,
-- gen_panik_suffix, open_trial) and 20260707000001_trial_email.sql (the p_email
-- parameter and the email column this keys on). Access is unchanged: deny-all
-- RLS, SECURITY DEFINER, service_role only.
-- ============================================================================

-- ── 1. dedupe the grants the missing guard already created ──────────────────
-- Keeps the EARLIEST grant per (campaign, lower(email)) and deletes the later
-- ones. Earliest, because that is the row the account's membership was minted
-- against and the one whose access_token may already be in a URL somewhere.
--
-- WHY redemption_count IS NOT DECREMENTED. It is a running total of successful
-- redemptions, not a live count of surviving rows: the hourly retention job in
-- 20260704000001 deletes grants 30 days past expiry and has never given a slot
-- back, and max_redemptions is read as "how many times may this card be
-- claimed", not "how many claimants may exist at once". Adjusting it here would
-- make this migration the first thing in the system to treat the number as a
-- population, and it would silently hand a campaign extra capacity that its
-- operator never authorised. The overcount stays; it is a true statement about
-- what happened.
--
-- redemption_attempts is likewise not edited: the log is what the incident was
-- reconstructed from, and rewriting it would be rewriting the evidence. Note
-- that deleting a grant DOES null the granted_token_id of the attempt that
-- minted it, through the existing ON DELETE SET NULL on that FK. The attempt
-- row, its outcome and its timestamp all survive; only the pointer to the row
-- that no longer exists is cleared, which is what that FK was declared to do.
with ranked as (
  select id,
         row_number() over (
           partition by campaign_id, lower(email)
           order by created_at, id
         ) as rn
    from public.trial_grants
   where email is not null
)
delete from public.trial_grants g
 using ranked r
 where g.id = r.id
   and r.rn > 1;

-- ── 2. one grant per address per campaign, enforced ─────────────────────────
-- Partial, because email is nullable: every grant minted before
-- 20260707000001 has none, and those are not claims by anybody in particular.
-- lower(), because the function normalises to lower case on the way in but the
-- legacy rows were never guaranteed to.
create unique index if not exists trial_grants_campaign_email_uniq
  on public.trial_grants (campaign_id, lower(email))
  where email is not null;

-- ── 3. redeem_campaign_code - idempotent per (campaign, email) ─────────────
-- Same signature, same outcome vocabulary, same one-attempt-row-per-call
-- contract. The only new behaviour is the early return for an address that
-- already holds a grant on this campaign.
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
  v_code       text := upper(btrim(coalesce(p_code, '')));
  v_email      text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_campaign   public.product_campaigns;
  v_token      text;
  v_grant_id   uuid;
  v_constraint text;
  attempt      int;
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

  -- ── the idempotent path ──────────────────────────────────────────────────
  -- Placed BEFORE the is_active and claim-window checks on purpose. Somebody
  -- who already redeemed this card owns their trial whatever the campaign has
  -- done since: open_trial has never consulted is_active, so the kill switch
  -- has always meant "no NEW redemptions" rather than "revoke the issued ones".
  -- Answering "expired" to a holder asking for the token they already have
  -- would be a refusal they cannot act on and a fact the data contradicts.
  --
  -- The lock is two-int pg_advisory_xact_lock, released when this statement's
  -- transaction ends (PostgREST gives each RPC call its own). It serialises
  -- only the callers redeeming THIS campaign as THIS address, so it costs
  -- nothing to unrelated redemptions and does not touch the campaign row that
  -- the usage-limit UPDATE below locks.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext(v_campaign.id::text), hashtext(v_email));

    select id, access_token
      into v_grant_id, v_token
      from public.trial_grants
     where campaign_id = v_campaign.id
       and lower(email) = v_email
     limit 1;

    if found then
      -- Logged as a success because that is what the caller is told, and
      -- because a silent early return is what made the double redemption
      -- invisible until somebody counted the rows by hand.
      insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)
      values (v_code, 'success', p_ip, p_ua, v_grant_id);
      return jsonb_build_object('outcome', 'success', 'token', v_token);
    end if;
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
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'trial_grants_campaign_email_uniq' then
        -- Unreachable while every caller comes through the lock above; kept
        -- because "unreachable" is a claim about today's callers and this is
        -- the branch that decides whether a future one gets a 500 or a trial.
        -- The slot was already counted a few lines up and is NOT given back,
        -- for the reason set out in section 1.
        select id, access_token
          into v_grant_id, v_token
          from public.trial_grants
         where campaign_id = v_campaign.id
           and lower(email) = v_email
         limit 1;
        insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)
        values (v_code, 'success', p_ip, p_ua, v_grant_id);
        return jsonb_build_object('outcome', 'success', 'token', v_token);
      end if;
      -- Otherwise it was the access_token collision the loop exists for.
      if attempt = 5 then raise; end if;
    end;
  end loop;

  insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)
  values (v_code, 'success', p_ip, p_ua, v_grant_id);

  return jsonb_build_object('outcome', 'success', 'token', v_token);
end $$;

revoke all on function public.redeem_campaign_code(text, text, text, text) from public;
grant execute on function public.redeem_campaign_code(text, text, text, text) to service_role;
