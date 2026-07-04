-- ============================================================================
-- PANIK — waitlist_check_email helper (2026-07-04)
-- Allows the landing page to detect duplicate emails at step 1 (before the
-- user completes all 5 onboarding questions). SECURITY DEFINER so it can
-- read past deny-all RLS using only the publishable key.
-- Same email normalisation logic as waitlist_signup.
-- ============================================================================

create or replace function public.waitlist_check_email(
  p_email text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  citext;
  v_local  text;
  v_domain text;
begin
  v_email  := lower(btrim(p_email));
  v_local  := split_part(v_email::text, '@', 1);
  v_domain := split_part(v_email::text, '@', 2);
  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local := replace(split_part(v_local, '+', 1), '.', '');
  else
    v_local := split_part(v_local, '+', 1);
  end if;
  v_email := (v_local || '@' || v_domain)::citext;

  return exists (
    select 1 from public.waitlist_signups where email = v_email
  );
end $$;

grant execute on function public.waitlist_check_email(text) to anon, authenticated;
