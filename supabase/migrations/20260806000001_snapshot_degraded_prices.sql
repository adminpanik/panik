-- Degraded-price marker on the score time series.
--
-- A reader that cannot establish a USD denomination (missing / stale Chainlink
-- round) now KEEPS the leg — health factor and LTV are ratios and survive a
-- missing price — and reports collateral_usd / borrow_usd as null instead of
-- dropping the position entirely. Without this column those nulls are
-- indistinguishable from "not recorded", and an operator cannot tell a
-- degraded oracle from a quiet wallet.
--
-- Also relaxes the alert dust gate: the dispatcher waives ALERT_POLICY
-- .minBorrowUsd when this is true (the gate is unevaluable, not failed).

alter table public.score_snapshots
  add column if not exists usd_values_unavailable boolean not null default false;

comment on column public.score_snapshots.usd_values_unavailable is
  'True when a price feed the USD conversion depends on was missing or stale: collateral_usd/borrow_usd are null but total/band/health_factor remain exact.';
