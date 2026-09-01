-- ============================================================================
-- PANIK - One trial code is good for one account (2026-09-01)
-- Scope: a code redeems ONCE per address. While the access it bought is still
--        live, re-entering it stays a harmless idempotent success. Once that
--        access is over, the same code on the same address is REFUSED.
--
-- Idempotent (safe to re-run). Rewrites public.redeem_campaign_code in place
-- and widens the redemption_attempts outcome vocabulary by one value.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- 20260831000001 made redemption idempotent per (campaign, email) to stop one
-- account burning two slots of a print run. It did that by handing an address
-- that already holds a grant THAT GRANT'S TOKEN back, forever, with no notion
-- of whether the grant was still worth anything.
--
-- So the fix for a double submit became a renewal machine. A tester whose
-- three-day trial had run out, or whose membership an operator had ended,
-- could type the same card into the same account and be let straight back in,
-- and could keep doing it. The operator's rule is the plain one a printed card
-- implies: one trial code is good for one account, and the dashboard is where
-- a use gets cleared if somebody is to have another.
--
-- ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
-- The idempotent branch now looks at what the grant it found is worth before
-- answering. Two answers where there was one:
--
--   the grant is LIVE     unopened, or opened and still running. Answer
--                         'success' with its token, exactly as before: this is
--                         the double-submit protection and it must survive.
--   the grant is OVER     opened, and its clock has run out. Answer
--                         'already_used'. No token, no new row, no slot spent.
--
-- Liveness is read off the same two columns open_trial writes and the hourly
-- retention job in 20260704000001 reads. A grant with first_opened_at set and
-- no expires_at cannot be produced by open_trial (it writes both in one
-- UPDATE) and is treated as live rather than refused: an unknown clock is not
-- a finished one, and refusing on it would state a fact this function does not
-- know.
--
-- ── THE OPERATOR-ENDED CASE LIVES HERE TOO ─────────────────────────────────
-- "Over" has to include a membership an operator ended early with the End
-- trial action, or the rule would hold for a trial that ran out on its own and
-- not for one that was cut short. This function cannot see memberships and
-- should not learn to: it serves the account flow and the printed-card flow
-- alike, and only one of those has accounts.
--
-- So the ending is recorded where this function already looks.
-- `endTrialForEmail` (server/adminTrials.ts) now closes the GRANT's clock
-- alongside the membership's. That is also the honest record of what happened,
-- and it makes End trial a faithful simulation of expiry, which is the entire
-- reason that action exists.
--
-- ── GIVING A CODE BACK ─────────────────────────────────────────────────────
-- The way to let somebody redeem a code again is to DELETE their grant row,
-- which frees the (campaign_id, lower(email)) slot the unique index from
-- 20260831000001 holds. That is what the console's "Clear use" action does
-- (server/adminCampaigns.ts). Nothing here needs a flag or a tombstone: the
-- absence of the row IS the permission, and the next call falls through to the
-- ordinary mint path and takes a fresh slot.
--
-- redemption_count is NOT decremented by any of this, for the reason set out
-- at length in 20260831000001: it is a running total of successful
-- redemptions, not a live population count, and treating it as one would hand
-- a campaign capacity its operator never authorised.
--
-- Access is unchanged: deny-all RLS, SECURITY DEFINER, service_role only.
-- ============================================================================

-- ── 1. one more thing an attempt can have been ──────────────────────────────
-- 'already_used' is logged like every other refusal, because the wall of them
-- is the signal: one address retrying a spent card is a support question, and
-- an operator who cannot see the retries cannot answer it. The constraint is
-- dropped and re-added by name rather than edited, which is the only way
-- PostgreSQL offers and is safe to repeat.
alter table public.redemption_attempts
  drop constraint if exists redemption_attempts_outcome_check;
alter table public.redemption_attempts
  add constraint redemption_attempts_outcome_check
  check (outcome in ('success','not_found','disabled','expired','exhausted','already_used'));

-- ── 2. redeem_campaign_code - one redemption per address, per campaign ──────
-- Same signature and the same one-attempt-row-per-call contract. The only new
-- behaviour is the split inside the idempotent branch.
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
  v_grant      public.trial_grants;
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

  -- ── the once-per-address branch ──────────────────────────────────────────
  -- Placed BEFORE the is_active and claim-window checks on purpose, and for
  -- the reason 20260831000001 gives: what the campaign has done since is not
  -- an answer to somebody asking about the redemption they already made.
  --
  -- The lock is the same two-int pg_advisory_xact_lock, taken before the
  -- lookup so the lookup is authoritative. Without it a bare pre-check SELECT
  -- is exactly the arrangement the 2026-08-31 incident went through: two
  -- transactions both read "no grant", both proceed, both insert.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext(v_campaign.id::text), hashtext(v_email));

    select * into v_grant
      from public.trial_grants
     where campaign_id = v_campaign.id
       and lower(email) = v_email
     limit 1;

    if found then
      -- Opened, and run out: this address has had what the card was worth.
      -- Deleting the grant (the console's Clear use) is what undoes this.
      if v_grant.first_opened_at is not null
         and v_grant.expires_at is not null
         and now() >= v_grant.expires_at then
        insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)
        values (v_code, 'already_used', p_ip, p_ua);
        return jsonb_build_object('outcome', 'already_used');
      end if;

      -- Still live: unopened, or opened and running. The same answer as
      -- before, logged as a success because that is what the caller is told,
      -- and because a silent early return is what made the double redemption
      -- invisible until somebody counted the rows by hand.
      insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)
      values (v_code, 'success', p_ip, p_ua, v_grant.id);
      return jsonb_build_object('outcome', 'success', 'token', v_grant.access_token);
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
        -- The slot was already counted a few lines up and is NOT given back.
        -- The row that beat us was minted moments ago, so it is live by
        -- construction and this hands back a token rather than re-running the
        -- spent check above.
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
