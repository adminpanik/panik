-- ============================================================================
-- PANIK - revoke anon watch-registration (2026-08-05)
-- Security fix on top of 20260627000001_telegram_alerts.sql. ADDITIVE: that
-- migration is left untouched (history stays replayable); this one closes the
-- door it opened.
--
-- The hole: register_watched_wallet() is SECURITY DEFINER and was granted to
-- `anon`, i.e. to the publishable key that ships inside the browser bundle.
-- Anyone holding it could
--   (a) upsert ANY wallet's row and rewrite risk_profile — moving a victim from
--       conservative to aggressive lifts their ALERT_THRESHOLD from 25 to 75,
--       silently suppressing the liquidation warnings they signed up for; and
--   (b) insert unlimited wallets, each of which the watch worker then polls
--       every 60s forever (unbounded RPC spend, no way to opt out).
--
-- The fix: registration moves behind POST /api/wallets/register, which requires
-- a personal_sign proof that the caller owns the wallet (server/walletAuth.ts)
-- and is per-IP rate-limited. That endpoint reaches the function over the
-- service connection, which is not subject to these grants. The function body
-- is unchanged — only who may call it.
-- ============================================================================

revoke execute on function public.register_watched_wallet(text, text) from anon;

-- `authenticated` goes too: this project has no Supabase Auth users, so the
-- role is unreachable in practice, and leaving the grant would just be a second
-- door to re-audit later. The API server connects as the owner role.
revoke execute on function public.register_watched_wallet(text, text) from authenticated;

-- Belt-and-braces: PUBLIC gets EXECUTE on new functions by default in Postgres,
-- so anon could still reach it through PUBLIC even after the revoke above.
revoke execute on function public.register_watched_wallet(text, text) from public;
