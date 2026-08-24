-- ============================================================================
-- PANIK - Alert to outcome pairing (7.3, 2026-08-23)
--
-- WHY A VIEW AND NOT A LEDGER. The pair is already persisted: the alert is a
-- `watch_deliveries` row Telegram accepted, and the outcome is the NEXT
-- transition for the same (wallet, protocol, risk_profile) in
-- `watch_transitions`. A second table holding a copy of both would need a
-- writer, a backfill and a reconciliation job, and would be wrong the first
-- time any of the three fell behind. Nothing here is computed that a row does
-- not already hold.
--
-- WHAT "FALSE ALARM" MEANS HERE, EXACTLY. `outcome = 'resolved'` is an alert
-- whose position returned under the user's limit WITHOUT ever crossing further
-- out. That is the observable definition and it is deliberately conservative:
-- the database cannot tell a false alarm from an alert the user acted on, and
-- both look like a recovery. So this view names what it measured - resolved
-- without escalating - and every surface that quotes the rate must say the same
-- thing rather than upgrade it into "we were wrong 27% of the time".
--
-- Only alerts are paired. Resolutions (to_status = 'within') are the OUTCOME of
-- an alert, never an alert with an outcome of their own, and counting them
-- would halve every rate computed from this view.
--
-- Read by server/alertOutcomes.ts.
-- ============================================================================

create or replace view public.watch_alert_outcomes
with (security_invoker = true) as
select d.id            as delivery_id,
       d.owner_wallet,
       t.id            as transition_id,
       t.wallet,
       t.protocol,
       t.risk_profile,
       t.to_status     as alert_status,
       t.created_at    as alerted_at,
       resolved.created_at  as resolved_at,
       escalated.created_at as escalated_at,
       case
         -- Escalation wins a tie only when it happened FIRST: a position that
         -- got worse and then recovered was a true alarm, in that order.
         when escalated.created_at is not null
          and (resolved.created_at is null or escalated.created_at < resolved.created_at)
           then 'escalated'
         when resolved.created_at is not null then 'resolved'
         else 'pending'
       end as outcome
  from public.watch_deliveries d
  join public.watch_transitions t
    on t.id = d.transition_id
  -- The first return to safety after this alert.
  left join lateral (
    select n.created_at
      from public.watch_transitions n
     where n.wallet = t.wallet
       and n.protocol = t.protocol
       and n.risk_profile = t.risk_profile
       and n.created_at > t.created_at
       and n.to_status = 'within'
     order by n.created_at
     limit 1
  ) resolved on true
  -- The first crossing to a WORSE state. Only an 'approaching' alert has one:
  -- 'outside' is the far side already.
  left join lateral (
    select n.created_at
      from public.watch_transitions n
     where t.to_status = 'approaching'
       and n.wallet = t.wallet
       and n.protocol = t.protocol
       and n.risk_profile = t.risk_profile
       and n.created_at > t.created_at
       and n.to_status = 'outside'
     order by n.created_at
     limit 1
  ) escalated on true
 -- 'telegram' is the ONLY channel that means a person was actually messaged.
 -- Suppressed, blocked and undeliverable rows are alerts nobody received, and
 -- an alert nobody received has no outcome to be right or wrong about.
 where d.notify_channel = 'telegram'
   and t.to_status in ('approaching', 'outside');

comment on view public.watch_alert_outcomes is
  'One row per DELIVERED alert, paired with what the position did next (7.3). outcome: ''escalated'' = crossed further out first; ''resolved'' = returned under the limit without getting worse; ''pending'' = neither yet. ''resolved'' is the observed false-alarm bucket and cannot distinguish a wrong alert from one the user acted on - say so wherever the rate is shown.';

-- The browser must never read this: it pairs every watched wallet with every
-- alert it received. RLS on the base tables is deny-all for exactly that
-- reason, and a view is how that gets accidentally undone.
revoke all on public.watch_alert_outcomes from public;
revoke all on public.watch_alert_outcomes from anon;
revoke all on public.watch_alert_outcomes from authenticated;
grant select on public.watch_alert_outcomes to service_role;

-- The pairing joins forward in time within one position; without this the
-- lateral subqueries fall back to the (wallet, protocol) index and re-sort.
create index if not exists idx_watch_transitions_position_time
  on public.watch_transitions (wallet, protocol, risk_profile, created_at);
