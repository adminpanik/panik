# PANIK Waitlist — Backend Implementation Plan

> Status: **In implementation** — free waitlist (Phase 1–3) being built 2026-06-14.
> Last updated: 2026-06-14
> Scope: Waitlist signup backend, onboarding data capture, beta-tester list management, and magic-link beta access.
> Source of truth for fields/flow is the business-dev doc; this plan now mirrors it.
> The Founding-User Escrow ($5 USDC / 90-day refund) was a SEPARATE journey (see USER_JOURNEY.md); it was removed 2026-08-25 in PR #122, and was never built against this plan.

---

## 0. AI Implementation Prompt

Paste this prompt at the start of any AI-assisted session that implements or extends this plan:

```
You are a senior full-stack engineer and QA lead specializing in early-stage
SaaS launch infrastructure: Supabase (Postgres, RLS, SECURITY DEFINER RPCs,
Auth), transactional email (Resend), lean custom bot mitigation (honeypot +
deny-all RLS — NO Edge Function, NO third-party CAPTCHA), and React/TypeScript
frontends. You are implementing the backend for PANIK, a DeFi risk-intelligence
product, per docs/BACKEND_PLAN.md in this repo.

Operating principles:
1. Security by construction, not convention. The browser must never hold a
   credential that can read or write the waitlist table directly. RLS is
   deny-all on waitlist_signups; the ONLY write path is the SECURITY DEFINER
   waitlist_signup() RPC, the only read is waitlist_count().
2. Never trust client state. localStorage, form fields, and wallet
   addresses are unverified hints, never gates. The only access gate is
   Supabase Auth with shouldCreateUser: false.
3. Marketing data and product data stay structurally separated. Risk appetite
   is DERIVED on read from the raw answers (never stored on the waitlist) and
   is never read by product logic; the beta app's user_profiles table is the
   only engine-readable risk profile.
4. Fail loudly in the UI. Every network call in the signup modal needs an
   explicit error state with retry. Never show success before the RPC
   resolves successfully.
5. Idempotent, not enumeration-hardened. waitlist_signup() is idempotent on
   email (duplicate returns the existing position). Strict enumeration
   resistance was an Edge-Function-era goal; it is out of scope for the lean
   free list.
6. QA before done. For every change, run the QA checklist in section 9 of
   the plan. A feature is not complete until its failure paths are tested
   (network loss mid-submit, double-click, duplicate email casing,
   plus-addressing, RLS probes from the browser console).
7. Match the existing codebase: React 19 + TypeScript + Vite + Tailwind v4
   + motion. Follow existing component style in src/panik-landing-page/components/.

When a decision is not covered by the plan, choose the option that
minimizes attack surface and operational burden, state the decision and
why, and update docs/BACKEND_PLAN.md so the plan stays the source of truth.
```

---

## 1. Product Requirements

1. **Signup with inline onboarding.** The multi-step `WaitlistModal` captures email (**required**), a **required** EVM wallet address (connect or paste — format-validated), and **5 qualification questions** (see §4). Risk appetite is **derived** from the answers, shown to the user, and overridable.
2. **Every signup is a beta tester.** Signups are stored durably with a lifecycle status (`waitlist_free → invited → shipped_active`; escrow states reserved — §3).
3. **Retrievable tester list.** The team can view, filter (e.g. by derived appetite, portfolio size, frustration), and export the full list to send beta invites.
4. **Magic-link beta access.** Invited users log into the beta app via email magic link; uninvited users cannot log in at all.

---

## 2. Architecture Decision

**Supabase** (Postgres + RLS + RPC functions + Auth) + **Resend** (email, planned, never implemented; see §7). **No Edge Function, no third-party CAPTCHA** for the free waitlist (lean decision, 2026-06-14).

Why: one service covers storage, admin viewing/export (dashboard table editor + CSV), and magic-link auth that the beta app will reuse — so the waitlist and beta app share one user system with no migration. The site stays a static Vite deploy; zero servers to run. The browser writes through a `SECURITY DEFINER` RPC over PostgREST (publishable key) — deny-all RLS keeps the table closed; the function is the only door. No Deno deploy. Lock-in risk is negligible (one table, exportable any time).

**Why no Edge Function:** for a *free* list it bought little — its only real edge over a direct RPC was server-side IP rate-limiting, which a rotating-IP spammer defeats anyway, at the cost of a whole Deno deploy surface. Bot defense is honeypot + deny-all RLS + the RPC being the sole writer. The Edge Function is a ~1-file add-back if real spam appears.

**Rejected alternatives:**
- Custom Express + SQLite — requires a server host, hand-rolled magic links, hand-rolled admin view. `express` is already in `package.json` but unused; it stays that way.
- Firebase — no SQL, weaker fit for the later beta app's relational needs.
- Google Sheets — no auth story.

---

## 3. Data Model

> **Note (2026-08-25, PR #122):** the Founding-User escrow deposit flow (`/founding`, `src/panik-founding/`) referenced below (the `early_access`/`early_access_paid`/`refund_available`/`refunded` values and the "reserved for the escrow journey" columns) was removed from the codebase. The columns and CHECK values below are unchanged in the live schema, but nothing in this repo writes them anymore. Kept for history only.

### `waitlist_signups` (created in Phase 1 — migration `20260614000001_waitlist.sql`)

Implemented with `text` + `CHECK` constraints (matching the scoring-engine migration's idiom), **not** Postgres `enum` types — easier to extend, same data guarantees.

| Column                  | Type                          | Notes                                                                                       |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `id`                    | `uuid` PK                     | `gen_random_uuid()`                                                                         |
| `email`                 | `citext` **unique**           | Normalized server-side before insert (see §5)                                               |
| `wallet_address`        | `text` **NOT NULL**           | `CHECK ^0x[0-9a-f]{40}$`, stored lowercase. **Required** but **unverified** for free tier (becomes on-chain-verified only via the escrow journey). |
| `q1_defi_activity`      | `text`                        | single: `never \| tried \| active_1_2 \| active_3_plus`                                     |
| `q2_liquidation`        | `text`                        | single: `no_unsure \| no_managed \| yes_caught \| yes_accept`                               |
| `q3_risk_tracking`      | `text[]`                      | multi ("select all"): `manual_dashboard \| portfolio_tracker \| custom_alerts \| protocol_alerts` |
| `q4_frustrations`       | `text[]`                      | multi ("pick up to 2", CHECK `array_length <= 2`): `no_unified_view \| slow_reaction \| silent_risk \| execution_friction` |
| `q5_portfolio_size`     | `text`                        | single: `lt_1k \| 1k_10k \| 10k_50k \| 50k_200k \| gt_200k`                                 |
| `additional_notes`      | `text` nullable               | Optional free text                                                                          |
| `tier`                  | `text` default `free`         | `free \| early_access` — **reserved** for the escrow journey                                |
| `status`                | `text` default `waitlist_free`| `waitlist_free \| invited \| early_access_paid \| shipped_active \| refund_available \| refunded` |
| `position`              | `int`                         | Assigned as `COUNT(*) + 1` inside `waitlist_signup()` — **not** a sequence                  |
| `created_at`            | `timestamptz`                 | `now()`                                                                                     |

**Risk appetite is NOT a column — it is DERIVED on read.** `public.waitlist_appetite(q1,q2,q5)` (IMMUTABLE) + the `public.waitlist_enriched` view expose `risk_appetite` for analysis/export. Rationale: raw answers are the asset; a derived label throws away information and freezes a formula. Deriving on read means the formula can be tuned anytime with zero migration, and there is no signup override (the user confirms their real appetite in-app later). See §4.

**Dropped vs. an earlier draft (lean design, 2026-06-14):** no `ip_hash` / `user_agent` (no Edge Function = no server-side IP), no `tx_hash` / `paid_at` / `refund_reminded_at` (added when the escrow journey is built — YAGNI), no stored `risk_appetite_*`.

**RLS: deny-all (enabled, zero table policies).** The browser cannot read or write the table directly. The only write path is `public.waitlist_signup()` (SECURITY DEFINER, granted to `anon`/`authenticated`) which the browser calls via PostgREST RPC; the only browser-readable thing is `public.waitlist_count()` (SECURITY DEFINER). The team reads/exports rows via the dashboard table editor (secret key, bypasses RLS).

### `user_profiles` (created in Phase 5, with the beta app)

| Column          | Type                     | Notes                                                                 |
| --------------- | ------------------------ | --------------------------------------------------------------------- |
| `auth_user_id`  | `uuid` PK → `auth.users` |                                                                       |
| `risk_appetite` | enum                     | Set **only** via in-app onboarding confirmation — never from waitlist |
| `onboarded_at`  | `timestamptz`            |                                                                       |

The Panik scoring engine reads risk appetite **exclusively** from `user_profiles`. In-app onboarding may pre-fill the risk question from the **derived** waitlist appetite (`waitlist_appetite()` / `waitlist_enriched.risk_appetite`) for one-tap confirmation, but it requires an explicit confirmation before `user_profiles.risk_appetite` exists. A user who skips onboarding has no engine-readable risk profile — there is no fallback path to the derived hint. This makes "the waitlist answer is only a hint" a constraint of the data model, not a convention.

---

## 4. Signup Flow

```
WaitlistModal steps:
  1. Email                     (client regex pre-check only)
  2. Wallet                    (REQUIRED — connect injected wallet OR paste; EVM-format validated)
  3. Qualification quiz        (5 questions on one scrollable step — see below)
  4. Review & confirm          (shows DERIVED appetite, read-only)
  5. SUBMIT → waitlist_signup() RPC → success screen or error + retry
```

**The 5 questions** (verbatim from business-dev doc; stored as the keyed values in §3):
1. *How actively do you use DeFi lending/borrowing right now?* — single (`never`/`tried`/`active_1_2`/`active_3_plus`)
2. *Have you ever been liquidated or come close?* — single (`no_unsure`/`no_managed`/`yes_caught`/`yes_accept`)
3. *How do you currently track risk?* — **multi, select all** (`manual_dashboard`/`portfolio_tracker`/`custom_alerts`/`protocol_alerts`)
4. *Biggest frustration today?* — **multi, pick up to 2** (`no_unified_view`/`slow_reaction`/`silent_risk`/`execution_friction`)
5. *How much in active positions?* — single (`lt_1k`/`1k_10k`/`10k_50k`/`50k_200k`/`gt_200k`)
   + optional free-text "anything else…" note.

**Derived appetite (read-only):** `conservative|moderate|aggressive` from Q1/Q2/Q5 (Q2 weighted 2×; score 4–12 → ≤6 conservative, ≤9 moderate, else aggressive). Shown on the review/success screens for delight, but **not stored and not overridable** — it's recomputed on read (§3). The client mirrors the formula in `deriveAppetite()` for display only.

**Single insert at the very end of the flow** (after review), not earlier. Wallet is captured during the flow (step 2), so it's present in the single insert.

---

## 5. `waitlist_signup()` RPC (the write path)

The only write path to `waitlist_signups`: a `SECURITY DEFINER` Postgres function granted to `anon`/`authenticated`, called by the browser via PostgREST (`POST /rest/v1/rpc/waitlist_signup`) with the **publishable** key. The table is deny-all RLS; the function inserts past it. **No Edge Function, no service key in the loop, no third-party CAPTCHA.** Bot defense = honeypot + deny-all RLS + the function being the sole writer. Processing order (inside the function):

1. **Honeypot check** — the `p_honeypot` arg must be empty; if filled, return `0` (silent success — don't tip off the bot). The modal's hidden `company` field feeds this.
2. **Email normalization** — trim, lowercase, collapse Gmail plus-addressing + dots (`user+tag@gmail.com` → `user@gmail.com`) before the unique check.
3. **Idempotent on email** — if the normalized email already exists, return its existing `position` (no new row). The modal shows "you're on the list, #N" either way.
4. **Insert** — `position = COUNT(*) + 1`. Answer values are enforced by the table's `CHECK` constraints (bad input raises); the wallet `CHECK` enforces `^0x[0-9a-f]{40}$` lowercase. Returns the integer position.

`waitlist_count()` (SECURITY DEFINER, granted to `anon`) returns **only the total count** for the landing number. The public "recent signups" social-proof feed stays **fully seeded/fake** — real emails are never exposed to the browser.

**Accepted trade vs. the Edge-Function draft:** no server-side IP rate-limit (the browser/PostgREST path has no trustworthy client IP) and no enumeration-proof uniform error shape. Both are low-value for a free list; both return if the Edge Function is ever added back in front.

---

## 6. Frontend Changes

Files touched: [`src/panik-landing-page/components/WaitlistModal.tsx`](../src/panik-landing-page/components/WaitlistModal.tsx), [`src/panik-landing-page/App.tsx`](../src/panik-landing-page/App.tsx), [`src/panik-landing-page/lib/waitlist.ts`](../src/panik-landing-page/lib/waitlist.ts) (new), [`.env.example`](../.env.example).

- **Quiz step** — the 5 questions from §4 (two of them multi-select). Replaces the old single acquisition-source step.
- **Required wallet step** — minimal injected connect (`window.ethereum` → `eth_requestAccounts`, covers MetaMask/Coinbase/Rabby) **or** paste; validated against `^0x…{40}$`. No wagmi dependency for the free tier.
- **Honeypot** hidden `company` field. **No Turnstile widget** (custom-only bot defense).
- **Single submit at flow end** — all collected data posted in one request via plain `fetch` to the `waitlist_signup` RPC (`src/panik-landing-page/lib/waitlist.ts`). No SDK added to the landing bundle. No intermediate inserts.
- **Explicit error state with retry** — never advance to the success screen before the RPC resolves successfully. Disable the submit button while in-flight (prevents double-submit; idempotent-on-email also guarantees one row).
- **Subscriber count** comes from `waitlist_count()`, falling back to the seeded list length when the backend env isn't set. The visible social-proof feed remains seeded; the real email is **never** added to the feed.
- **`localStorage`** keeps only the cosmetic `panik_has_subscribed` flag (suppresses re-showing the CTA). It gates nothing.
- **Env vars** (both already exist in `.env.example`; nothing new needed):
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`

---

## 7. Email (Resend)

> **Not implemented (checked 2026-08-25).** `server/`, `src/`, `scripts/`, and `package.json` have no Resend dependency, no SMTP client, and no code path that sends an email. **No transactional email is sent today.** The plan below is the original design and is kept as the reference for whoever builds it; treat every bullet as still to do, not as done.

- Configured as Supabase's **custom SMTP provider**. Supabase's built-in mailer is rate-limited to a few emails/hour, unusable for batch invites.
- **Requires a verified sending domain** with SPF and DKIM DNS records. A Gmail address cannot be the sender. **Do this in week one**: DNS propagation has lead time and it blocks everything downstream.
- **Signup confirmation email is required, not optional.** It is the deliverability check. The modal's client-side regex accepts typos (`name@gmial.com`); without a confirmation send, bad addresses surface on beta launch day. Include the waitlist position in the email for delight and reduce churn.

---

## 8. Beta Invites and Magic-Link Access

**Do not pre-generate magic links in batch.** Two known failure modes:
- Links expire (default 1 h, configurable max 24 h) — by the time people open a batch invite email, most links are dead.
- Corporate email scanners (Outlook SafeLinks, Proofpoint, etc.) prefetch URLs and consume one-time-use links before the human ever clicks.

**Correct flow:**

1. Invite script selects rows with `status = 'waitlist_free'`, **pre-creates Supabase Auth users** for them via `auth.admin.createUser`, sends a plain invite email (via Resend, not implemented; see §7) with a normal link to the beta app's login page, and flips `status` to `'invited'`.
2. The beta app's login page collects the email and calls `signInWithOtp({ shouldCreateUser: false })` — a **fresh** magic link, generated on demand, only when the user is actually at the keyboard.
3. `shouldCreateUser: false` means **only pre-created (invited) emails can log in at all**. Uninvited visitors — including anyone with the beta URL or a spoofed client flag — get "no account found." The gate is the auth system itself; no client-side state is involved.
4. On first login, join the auth identity back to `waitlist_signups` by email, flip `status` to `'shipped_active'`, and begin in-app onboarding (pre-fills risk appetite from the derived `waitlist_enriched.risk_appetite`, writes the confirmed answer to `user_profiles.risk_appetite`).

**List retrieval and export:** Supabase dashboard table editor — filter (e.g. all `aggressive` signups before a date), one-click CSV export. No custom admin panel to build.

---

## 9. QA Checklist

Run this before calling any phase complete. A feature is not done until its failure paths pass.

- [ ] Duplicate email, different casing → one row; response identical to a fresh signup.
- [ ] `user+tag@gmail.com` and `user@gmail.com` → treated as the same address (normalization).
- [ ] Double-click the submit button → exactly one row inserted.
- [ ] Kill the network mid-submit → modal shows error + retry; **no success screen**; no `localStorage` flag set.
- [ ] RLS probe from the browser console with the publishable key: SELECT returns zero rows; INSERT / UPDATE / DELETE all fail.
- [ ] Invalid / missing wallet address → rejected (`invalid_wallet`); valid `0x…{40}` accepted and stored lowercase.
- [ ] Q4 with 3+ selections → rejected (by both the modal cap and the table CHECK); any out-of-set answer value → CHECK rejects it.
- [ ] Honeypot (`p_honeypot`) filled → returns `0`, **no row created** (silent).
- [ ] Modal closed and reopened mid-flow → all state resets, including quiz answers + wallet.
- [ ] Duplicate normalized email → returns the existing position, no second row.
- [ ] End-to-end invite test with a real **Outlook or corporate** address — that is where link-prefetch bugs surface, not Gmail.
- [ ] Uninvited email on the beta login page → cannot receive a magic link.
- [ ] Derived `risk_appetite` in the `waitlist_enriched` view matches the client `deriveAppetite()` for the same answers (formula parity).

---

## 10. Build Phases

| Phase | Work                                                                                        | Estimate       | Blockers                              |
| ----- | ------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| 1     | Supabase: apply migration `20260614000001_waitlist.sql` (table + deny-all RLS + `waitlist_signup`/`waitlist_count`/`waitlist_appetite` + `waitlist_enriched` view) | ~1 h | Supabase project |
| 2     | Frontend: `lib/waitlist.ts` (RPC + wallet connect), 5-question quiz, required wallet step, honeypot, submit-at-end, error/retry UI, real count | ~½ day | Phase 1; set `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` |
| (opt) | Add-back Edge Function in front of the RPC for IP rate-limit, only if real spam appears | — | only if needed |
| 4     | Resend domain verification (SPF/DKIM) + signup confirmation email                          | small + DNS lead time | **Start week one** — propagation delay |
| 5     | Invite script + `shouldCreateUser: false` login gate + `user_profiles` table                | —              | Beta app exists (redirect URL needed) |

---

## 11. Resolved Design Gaps

These were identified in review and are fixed by construction above. Do not regress them.

| # | Gap | Fix |
| - | --- | --- |
| 1 | Spam inserts via publishable key | No direct browser table access (deny-all RLS). Writes only through `waitlist_signup()` (honeypot + CHECK-validated + idempotent on email). Accepted: no IP rate-limit in the lean design. §3, §5 |
| 2 | Risk-appetite drift | Appetite is derived-on-read from raw answers (`waitlist_appetite()`), never stored on the waitlist; the product engine reads appetite only from `user_profiles`. No fabricated frozen label, no fallback path. §3, §4 |
| 3 | Spoofable `localStorage` | Server (the table via the RPC) is source of truth. Beta access gated by Auth `shouldCreateUser: false`, never client state. §5, §8 |
| 4 | Batch magic-link expiry / scanner prefetch | Invite email carries a plain link. Magic link generated on demand at the login page. §8 |
| 5 | Wallet captured after insert vs. INSERT-only RLS | Single insert at end of flow. No UPDATE path exists. §4 |
| 6 | Masked public feed privacy risk | Feed stays fully seeded/fake. Only the count is real. §5 |
| 7 | Email typos burning invites | Signup confirmation email is mandatory. §7 |
