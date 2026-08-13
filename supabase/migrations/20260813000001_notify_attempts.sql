-- Bounded delivery attempts on the alert queue.
--
-- THE WEDGE. The dispatcher drains `notified_at is null` ordered by created_at,
-- limit 50, and only ever stops retrying a row on an explicit Telegram 403.
-- Telegram returns 400 for "chat not found", "chat_id is empty" and a handful of
-- other permanent conditions, and a 400 took the transient branch: leave
-- notified_at null, try again in 15 seconds, forever. Fifty such rows fill the
-- batch permanently and every user's alerts queue behind them — the alerting
-- system silently stops alerting, which is the failure it exists to prevent.
--
-- THE COUNTER. `notify_attempts` records how many sends this row has been given.
-- The dispatcher increments it on every non-terminal failure and gives up at
-- NOTIFY_MAX_ATTEMPTS (scripts/watch-worker.ts), at which point the row leaves
-- the queue the same way every other resolved-but-not-delivered outcome does:
-- notified_at stamped, notify_channel naming the OUTCOME.
--
-- WHY NO NEW TERMINAL COLUMN. `notified_at` already means "the queue is done
-- with this row", not "the user got it" — `blocked`, `suppressed_cooldown` and
-- `suppressed_immaterial` are all stamped rows nobody received, and
-- notify_channel is what distinguishes them. The terminal marker here is
-- notify_channel = 'undeliverable', which /api/history returns verbatim and
-- AlertHistory renders as its own chip. A delivered alert is notify_channel =
-- 'telegram' and nothing else, so a give-up can never read as a delivery.

alter table public.watch_transitions
  add column if not exists notify_attempts integer not null default 0
    check (notify_attempts >= 0);

comment on column public.watch_transitions.notify_attempts is
  'Delivery attempts spent on this row. The dispatcher stops at NOTIFY_MAX_ATTEMPTS and stamps notify_channel = ''undeliverable''; the row was never delivered.';

comment on column public.watch_transitions.notify_channel is
  'Outcome of the queue, not proof of delivery: ''telegram'' = Telegram accepted it; ''blocked'' = 403; ''undeliverable'' = attempts exhausted; ''suppressed_*'' / ''skipped'' = the anti-spam gate withheld it. Null with a null notified_at = still queued.';
