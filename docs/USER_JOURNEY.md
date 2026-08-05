# PANIK — User Journey: Waitlist + Early-Access Payment

> Status: **Design doc** — free waitlist (Journey B) in build 2026-06-14; Founding-User Escrow (Journey A) still design.
> Last updated: 2026-06-14
> Companion to [`BACKEND_PLAN.md`](./BACKEND_PLAN.md). Where the two disagree, this doc wins for journey/flow; the backend plan wins for infra/security mechanics.
> **This doc never wins over the deployed contract.** For escrow mechanics, `contracts/src/PanikEscrow.sol` and [`technical-docs/ESCROW_SYSTEM.md`](./technical-docs/ESCROW_SYSTEM.md) are authoritative — this doc describes the journey around them.
>
> **Reconciled with the business-dev doc (2026-06-14) — read before trusting any number below:**
> - Escrow amount is **$5 USDC** (every "$3" below is historical — treat as $5). The refund window is **one global 90-day deadline fixed at contract deployment**, shared by every depositor — *not* 90 days from each depositor's own timestamp. (Earlier revisions of this doc specified a per-depositor clock; the shipped contract does not implement one. `depositTime[wallet]` is recorded as an audit value only and feeds no time math.)
> - The two journeys are **NOT one modal**. The free waitlist is the public landing CTA. The Founding-User Escrow lives on a **hidden page, direct-URL only, not linked from nav** — full spec in §13.
> - The **free waitlist now requires a wallet** (connect or paste, EVM-format validated) and asks **5 qualification questions** (BACKEND_PLAN §4), not a 3-card appetite picker.
> - **No payment anywhere in the free waitlist.** Only Journey A (Founding User) moves USDC. Bot defense is custom (no Turnstile).

---

## 1. The core tension this doc resolves

Two features were designed around **two different identities**:

- The **waitlist** identifies a user by **email** (for magic-link beta access). It now *also* collects a wallet address (required, but unverified — a self-reported hint for on-chain segmentation).
- The **$5 Founding-User escrow** identifies a user by **wallet** (the address that deposited, and the address that can claim a refund). This is a separate hidden-page flow.

A founding user has **both**. The journey only works if we link them at deposit time and keep two sources of truth in sync:

| Source of truth | Owns | Never lies about |
| --------------- | ---- | ---------------- |
| **On-chain contract** (Base) | The money | Who paid, how much, the deadline, whether we shipped, who is owed a refund |
| **Supabase** | The CRM | email ↔ wallet link, onboarding answers (risk appetite, source), lifecycle status, who to email |

**Rule:** money questions are answered by reading the chain; everything else by Supabase. The browser is never the source of truth for either.

**Robustness payoff:** because refund eligibility lives on-chain and is tied to the wallet, a user can **always** reclaim their $5 by reconnecting the wallet that paid — even if we lose their email, the email bounced, or Supabase is down. Email is a *convenience reminder*, never the path to the money.

---

## 2. Two tiers, one modal

✅ **Decision 1 — RESOLVED: keep both, but they are SEPARATE surfaces (not one modal).**

| Tier | Where | Pays | Gets | Identity |
| ---- | ----- | ---- | ---- | -------- |
| **Free waitlist** | Public landing CTA | nothing | Notified; data captured (5 Qs) | Email + required (unverified) wallet |
| **Founding User** | **Hidden page, direct URL only** (§13) | **$5 USDC** into escrow | Founding benefits (§13): 12-mo 50% fee cut, earlier access, early news, direct input | Wallet (primary) + email (notices) |

The free waitlist is the public hero — it's the broad top of funnel and the analytics source. The Founding-User escrow is deliberately **unlisted**: shared by direct link with a curated audience, so the "$5 on-chain shipping promise" stays a high-signal, low-noise offer.

The Founding-User pitch:
> **Become a founding user for $5. If we don't ship Panik by the deadline — one date, 90 days after the contract was deployed, the same for everyone — you claim your money back from the contract.**

---

## 3. Entry points → which journey

```
   Public landing page                 Hidden page (direct URL only)
            │                                   │
     "Join the waitlist"               "Become a Founding User — $5"
            │                                   │
      Journey B (free)                   Journey A (escrow)
   email + wallet + 5 Qs                 $5 USDC deposit
                                                │
                                       (later, time passes)
                                                │
                                       ┌────────┴────────┐
                                   We shipped       global deadline hit
                                       │            & ship() never called
                                       ▼                 ▼
                                   Journey D         Journey C
                                   (release)         (refund claim)
```

---

## 4. Journey A — Paid early access (the hero path)

**Shared onboarding (same as free), then branch to payment.**

```
Step 1  Email                     → client regex precheck
Step 2  Risk appetite             → Conservative / Moderate / Aggressive (3 cards)
Step 3  Acquisition source        → existing searchable dropdown
Step 4  Review                    → confirm answers
        │
        ├─ POST /signup  ──────────► row created in Supabase
        │                            status = waitlist_free, position assigned,
        │                            honeypot+rate-limit checked, email+onboarding saved
        │   (We persist the lead HERE, before payment, so a drop-off at the
        │    pay step is still captured as a free-tier lead.)
        ▼
Step 5  Pay $5
        5a  Connect wallet                  → wallet address known
        5b  Wrong network? → prompt switch to Base
        5c  No USDC? → inline help + onramp/bridge link
        5d  Approve + Pay  → ideally one tx via USDC permit (EIP-2612 gasless approve)
                              fallback: approve tx, then pay tx
        5e  Tx pending      → clear pending state; submit disabled (contract hasPaid also guards)
        5f  Tx confirmed    → client sends tx_hash to backend
        │
        ├─ POST /confirm-payment ──► Edge Function VERIFIES on-chain (reads receipt
        │                            / contract.hasPaid[wallet]) — never trusts the
        │                            client's word — then updates the row:
        │                            wallet_address, tx_hash, status = early_access_paid
        ▼
Step 6  Success
        - "You're in. Position #N."
        - "Your $5 is held in escrow. Refundable after <deadline date> if we don't ship."
        - Show contract address (Basescan link) + tx hash receipt.
        ▼
        Receipt email (Resend) — receipt + tx hash + deadline + "how refunds work"
```

**Why the lead is saved before payment, and why this is still secure:** the BACKEND_PLAN invariant is "no writes from the *browser*." Both writes here go through Edge Functions (service-role, server-side). The browser still has zero table access. `/confirm-payment` is the only thing that can flip a row to `early_access_paid`, and it does so only after independently confirming the payment on-chain. (This refines BACKEND_PLAN §4's "single insert at end" → "two server-side writes: lead, then verified payment.")

---

## 5. Journey B — Free waitlist

**This is the journey being built now (2026-06-14).** Public landing CTA → `WaitlistModal`:

```
Step 1  Email                 → client regex precheck
Step 2  Wallet                → REQUIRED: connect injected wallet OR paste; EVM-format validated
Step 3  Qualification quiz    → 5 questions (BACKEND_PLAN §4); 2 are multi-select
Step 4  Review                → shows DERIVED risk appetite + lets user override
Step 5  SUBMIT → POST /signup → honeypot + rate-limit + validation server-side;
                                row created: status = waitlist_free, tier = free,
                                position assigned (advisory-locked, idempotent on email)
Step 6  Success               → "You're on the list, position #N." + derived profile
        Confirmation email (deliverability check — Phase 4).
```

No payment, no Turnstile. The wallet is collected as an unverified hint (it only becomes on-chain-verified if the same person later deposits via the Founding-User page, §13). A free user can later become a founding user by visiting the hidden escrow page with the same email/wallet.

---

## 6. Journey C — Refund claim (we missed the deadline)

The novel, highest-trust, and easiest-to-get-wrong path. **$5 is small, so people will forget to claim** — the system must actively bring them back. The 90-day clock is **a single global deadline**, fixed when the contract was deployed and identical for every depositor. A wallet that deposits on day 85 has 5 days left, not 90 — reminder timing must key off the contract's `refundDeadline()`, never off `depositTime[wallet]`.

```
deadline-5d   Reminder email to EVERY depositor (status = early_access_paid):
              "We didn't ship in time. Your $5 is claimable. [Claim refund]"
              (This is the #1 reason we collect email for founding users.)
              Same send date for everyone — it is one deadline, not N clocks.

deadline      refundDeadline() reached (deploy time + 90 days) and ship() was
              never called → refunds become claimable for ALL depositors at once.
              Hidden page / app show a "Claim your refund" banner for the connected wallet.

User          Return → Connect wallet → app reads contract:
              isRefundable(wallet) — i.e. block.timestamp >= refundDeadline()
              && !shipped && depositTime[wallet] != 0 && !refunded[wallet]
              → show "Claim $5" → claimRefund() tx → $5 returned → status = refunded
```

⚠️ **Decision 2 — unclaimed refunds after a long grace period?** Recommended: **claimable forever, no sweep.** A function that lets the team sweep unclaimed refunds would gut the trust mechanic. Leaving funds permanently claimable costs nothing and is maximally credible. (If a sweep is ever added, it should only be allowed years out and announced up front.)

**Hard-commitment property:** if the team misses the deadline, refunds open and the team can *never* release the funds afterward. Missing the deadline = forfeiting **all** escrow. That is the entire point — it makes the 90-day promise real. Do not add a grace extension.

---

## 7. Journey D — We shipped (release)

```
Before T+90d   Team calls release() from the multisig.
               ⚠️ Decision 3: 48h timelock on release() so the community can see it
               coming and challenge before funds move. Recommended: yes.
               → escrow funds go to the team treasury.

Notify         Email all paid users: "We shipped. Here's your access."
Access         Beta app: user connects wallet → Sign-In-With-Ethereum →
               app checks contract.hasPaid[wallet] == true → granted.
               status = shipped_active.
```

⚠️ **Decision 4 — beta auth method.** Recommended: **SIWE (wallet) primary for paid users**, since their paying wallet already *is* their identity and it's a DeFi app; **email magic link** for free-tier users and as a fallback. This avoids forcing paid users through a second, email-based identity.

⚠️ **Decision 5 — what "shipped" means + who holds the multisig.** The contract can only enforce *time*; "shipped" is a social judgement. Before launch, publicly define the shipped bar (e.g. "beta app live, paid users can log in and audit a real position") and publish the 2-of-3 Gnosis Safe signers. This is the trust backbone — needs your input, can't be defaulted.

---

## 8. User state machine

On-chain state is per-wallet (`hasPaid`, `refunded`) plus global (`shipped`, `deadline`). The user-facing status in Supabase is **derived** from combining chain + CRM:

```
visitor ──(email+onboarding)──► waitlist_free ──(deposit $5, verified)──► early_access_paid
                                     │                                      │
                                     │                          ┌───────────┴───────────┐
                                     │                    release() called          deadline passed
                                     │                          │                  & not shipped
                                     │                          ▼                       ▼
                                     │                   shipped_active          refund_available
                                     │                          │                       │
                                     │                    (wallet login)          claimRefund()
                                     │                          │                       ▼
                                     └──(notify later)──────────┘                   refunded
```

| Status | In Supabase | On-chain truth | What the user sees |
| ------ | ----------- | -------------- | ------------------ |
| `waitlist_free` | row exists, no wallet | — | "On the list, #N" |
| `early_access_paid` | wallet + tx linked | `hasPaid = true` | "You're in, escrow held, refundable after <date>" |
| `shipped_active` | — | `shipped = true` | full beta access |
| `refund_available` | — | deadline passed, `!shipped`, `hasPaid`, `!refunded` | "Claim your $5" |
| `refunded` | — | `refunded = true` | "Refunded" |

---

## 9. UX safeguards & edge cases

| Risk | Handling |
| ---- | -------- |
| User has no USDC on Base | Inline "Need USDC on Base?" with bridge/onramp link; don't dead-end |
| User on wrong network | Detect chainId, prompt switch to Base before enabling Pay |
| No ETH for gas | Note tiny gas need (~cents); permit flow removes the approve gas |
| Two-tx approve+pay confusion | Prefer USDC **permit** (EIP-2612) → single pay tx, gasless approval |
| Double payment | `hasPaid[wallet]` reverts a second pay; UI disables Pay while pending |
| Tx rejected / failed | Clear error + retry; lead row already saved so nothing is lost |
| Email typo on a paid user | Refund still claimable via wallet — money path never depends on email; flag bounced receipts for follow-up |
| User pays from wallet A, signs up with email X | Link captured at `/confirm-payment` time (both present in session); store both |
| User forgets to claim refund | T+85 reminder email + persistent app banner; funds claimable forever |
| Team marks "shipped" but community disputes | 48h timelock + public shipped-definition + multisig; no on-chain veto in v1 (documented limitation) |
| Browser claims "I paid" without paying | `/confirm-payment` verifies on-chain; client claim alone never flips status |
| Indexing gap (we miss a payment event) | Periodic reconciliation job re-reads contract events → backfills Supabase |

---

## 10. Data model deltas (vs BACKEND_PLAN §3)

**Already in the implemented free-tier table** (migration `20260614000001_waitlist.sql`) as reserved, nullable columns — so the escrow journey needs **no destructive migration**:

| Column | Type | Notes |
| ------ | ---- | ----- |
| `tier` | text `free \| early_access` | which journey they completed (defaults `free`) |
| `tx_hash` | text nullable | deposit tx; set only by `/confirm-payment` after on-chain verify |
| `paid_at` | timestamptz nullable | |
| `refund_reminded_at` | timestamptz nullable | so the deposit+85d mailer doesn't double-send |

`wallet_address` is **required but unverified** for free signups; it becomes **on-chain-verified** for founding users (the address that actually sent the deposit). `status` already carries the full state machine in §8.

**New Edge Function (escrow journey, not built yet):** `POST /confirm-payment` — input `{ email, wallet, tx_hash }` (no Turnstile; custom bot defense); verifies the tx on a Base RPC against the known contract + $5 amount, links wallet↔email, sets `tier = early_access`, `status = early_access_paid`. Idempotent on `tx_hash`.

---

## 11. Frontend deltas (vs BACKEND_PLAN §6)

- **Free waitlist (built now):** landing CTA → `WaitlistModal` with email → required wallet (minimal injected connect via `window.ethereum`, **no wagmi** for the free tier) → 5-question quiz → review/override → submit. Count from `waitlist_count()`.
- **Founding-User page (not built):** separate **hidden** route, direct URL only. Adds the **real** deposit step (wagmi/viem + the escrow contract). Shows contract address (Basescan), spot counter, benefits (§13), escrow status, per-deposit deadline + tx links.
- New **Refund banner** component (hidden page + app) that appears when a connected wallet is in `refund_available`.
- Beta app login: SIWE for founding users, magic link for free (per Decision 4).

---

## 12. Open decisions

**Resolved (business-dev doc, 2026-06-14):**
1. ✅ **Free tier + escrow?** — both, as **separate surfaces** (public waitlist + hidden escrow page). (§2)
6. ✅ **Chain + token + amount?** — **Base + USDC, $5** per founding user. (§13)
7. ✅ **Free vs founding benefits** — founding users get the §13 benefits; free users get notified + earlier-than-public. (§2, §13)
- ✅ **Bot defense** — custom (honeypot + IP rate-limit + RLS), **no Turnstile**. (BACKEND_PLAN §5)
- ✅ **Refund window** — **one global 90-day deadline from contract deployment**, shared by all depositors; refund is depositor-initiated `claimRefund`. (§6, §13)

**Still open (escrow journey, before that build):**
2. ⚠️ **Unclaimed refunds: claimable forever vs eventual sweep?** — recommend forever. (§6)
3. ⚠️ **48h timelock on `release()`?** — recommend yes. (§7)
4. ⚠️ **Beta auth: SIWE vs magic link vs both?** — recommend SIWE for founding users, magic link for free. (§7)
5. ⚠️ **Definition of "shipped" + who triggers/holds release** — the doc names "Elfritz" as the release trigger; the multisig/signer setup still needs sign-off. (§7, §13)

---

## 13. Founding User Role (Escrow) — spec from business-dev doc

> **Not built yet.** Hidden page, **direct-URL only, not linked from main nav.** Accessible only to people given the link.

**Page content:** what founding users get (below) · plain-language "how the escrow works" · contract address (links to Basescan) · spot counter ("X founding users so far" — manual or contract-enforced) · CTA: connect wallet + deposit **$5 USDC**.

**Founding-user benefits:**
- **12-month fee reduction** — 50% off transaction fees for the first 12 months, locked to the depositor wallet, counted from mainnet launch date.
- **Earlier access** — access to Panik before the public.
- **Early news** — product updates, feature previews, launch timing before any public announcement.
- **Direct product input** — direct access to the team during build; feedback shapes features pre-launch.
- **Founding user status.**

**Smart-contract requirements (Base):**
- *Deposit:* accepts **exactly 5 USDC** per wallet; records depositor wallet + block timestamp; **one deposit per wallet** (rejects duplicates).
- *Escrow:* funds held in contract; once Panik is live the owner calls `ship()` **once**, sweeping the whole balance to Panik's treasury wallet. (The business-dev doc asked for per-wallet release; the shipped contract deliberately does not have one — there is no `release(address)`.)
- *Refund:* a **single global 90-day window** starts when the contract is deployed and ends at `refundDeadline()` for everyone at the same instant; if that deadline passes without `ship()`, every depositor can call **`claimRefund`** directly to get their 5 USDC back, with no expiry on that right.
