# Claude Session: Build QR business card with time-limited product codes
**Session ID:** `dea88f5f-ecda-43b9-a864-77d2a7d27179`  
**Project:** `c--Users-ASUS-Documents-Github-Projects-panik-waitlist`  

---

### 👤 User *(2026-07-04 15:36:54)*

<ide_opened_file>The user opened the file \temp\readonly\Grep output (4q3k5u) in the IDE. This may or may not be related to the current task.</ide_opened_file>

Feature: "Kira-style" 2-in-1 Business Card + Time-Limited Product Code

CONTEXT (business details to use — do not treat as placeholders)
- Twitter/X: https://x.com/panik_fi (@panik_fi)
- Website: panik.fi

GOAL
Build a QR-code-based business card that serves two purposes at once:
1. Business card: scanning the QR shows our business details — website URL
   and Twitter/X handle (add other socials if the Kira version had them).
2. Product code: the same card also carries a redeemable product code that
   is time-limited and/or usage-limited, redeemed via a "Try Now" button on
   the landing page.

USER JOURNEY (explicit — do not deviate without confirming with me)

1. Card has TWO forms of the same code:
   a. QR code — encodes a full URL, e.g. `yourdomain.com/try?code=ABC123`
      (NOT a generic homepage URL, and NOT raw text).
   b. Short human-readable string code printed on the card as a fallback,
      e.g. `KIRA-TRY-8X2Q`.

2. Scan path (primary):
   - User scans QR → lands on `/try?code=ABC123`.
   - Page silently reads `code` from the URL (query param / session) —
     no manual input required.
   - "Try Now" button is now a one-tap action using the already-detected code.

3. No-scan / fallback path:
   - User visits the landing page directly (no `code` param present).
   - "Try Now" button, when clicked with no code detected, reveals a small
     manual input field: "Enter your code" — this is where the printed
     string code is typed in.
   - Once submitted, same redemption logic as the scan path runs.

4. Business card info (website, Twitter/X) is ALWAYS visible on the landing
   page regardless of code state (valid, expired, exhausted, or missing) —
   this half of the page must never disappear.

5. Limit-check timing:
   - Do NOT decrement/check limits at scan/page-load time.
   - Limit checks (time expiry + usage count) happen ONLY when "Try Now" is
     actually clicked/submitted (i.e. at redemption attempt), so idle scans
     or curious visits don't burn down the usage limit.
   - If valid: proceed with redemption, increment redemption count.
   - If expired or exhausted: show a clear "this code is no longer valid"
     state in place of the redemption UI, while keeping business card info
     visible per (4).

REQUIREMENTS

1. QR Code Generation
   - Generate a QR code per card/campaign encoding the `/try?code=XXXX` URL.
   - Also generate/display the short string code for print, tied to the
     same campaign/redemption record as the QR.

2. Redemption Limits (admin-configurable)
   - Each product code campaign supports two independent limit types,
     settable by an admin ("Neithan" or whoever is designated):
       a. Time limit — e.g. valid for N days from creation (confirm with me:
          from creation, or from first successful redemption attempt?).
       b. Usage limit — e.g. max N successful redemptions total.
   - Whichever limit is hit first invalidates the code, regardless of the
     other.
   - Admin sets these values per campaign/card batch, not hardcoded — via
     admin panel, config, or API endpoint (match whatever mechanism the
     Kira feature already uses for consistency).

3. State & Tracking
   - Track: created_at, expires_at (derived from time limit), max_redemptions,
     current_redemption_count, status (active/expired/exhausted).
   - Log each redemption *attempt* (not just successes) with timestamp and
     any identifying info already captured elsewhere (IP, user id, etc.).
   - Landing page must reflect real-time status: active → redemption UI;
     expired/exhausted → "no longer valid" state; business card info always
     shown either way.

4. Admin Controls
   - Simple way for Neithan to create a new card/campaign and set:
       - duration (e.g. "3 days")
       - max users/redemptions (e.g. "20")
   - View current status of a campaign (active, redemptions used, time
     remaining).
   - Manually expire/disable a code early if needed.

5. Reuse Existing Patterns
   - Match the Kira implementation's file structure, naming conventions,
     styling, and tech stack (framework, DB schema style, routing) as
     closely as possible.

ASSUMPTIONS TO CONFIRM WITH ME BEFORE/DURING IMPLEMENTATION
- Tech stack / framework in use (confirm same as Kira feature).
- Where business details (website URL, Twitter handle) should live — config
  file, DB, or hardcoded per the Kira pattern.
- Time limit basis: from code creation, or from first redemption attempt?
- Whether admin controls should be a UI, an internal API, or DB/config edits
  for now (MVP vs full admin panel).
- Format/length convention for the short string code (match Kira's if one
  exists).

DELIVERABLES
- QR code generation logic + string code generation, both tied to one
  campaign/redemption record
- Landing page with the two-path flow described above (auto-detected code
  vs manual input fallback)
- Data model + migration (if DB-backed)
- Admin creation/management flow (UI, API, or CLI — confirm which)
- Basic tests for expiry logic (time-based and count-based) and for both
  the scan path and manual-input fallback path



trial for our panik.fi/app this is core app


### 🤖 Claude *(2026-07-04 15:37:02)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:37:03)*

I'll start by exploring the codebase to understand the existing "Kira" implementation, the tech stack, routing, and any existing QR/redemption/campaign patterns I should match.


### 🤖 Claude *(2026-07-04 15:37:12)*

**🛠️ Tool Call:** `Agent` (ID: `toolu_01FHZb3q9PDcyCXzfLPdsVYc`)
```json
{
  "subagent_type": "Explore",
  "description": "Find Kira feature and app structure",
  "prompt": "I'm planning a new feature for a project at \"c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\". The feature is a \"Kira-style\" 2-in-1 business card + redeemable time-limited product code. The user says to \"match the Kira implementation's file structure, naming conventions, styling, and tech stack as closely as possible.\"\n\nYour job: find and thoroughly document the existing \"Kira\" feature/implementation in this repo. Search (case-insensitive) for \"kira\", \"KIRA\", \"try\", \"redeem\", \"redemption\", \"campaign\", \"code\", \"voucher\", \"invite\", \"QR\", \"qrcode\".\n\nAlso document the overall app structure so I understand where a new feature/page would live:\n- The tech stack (framework, build tool, language). Look at package.json, vite config, etc.\n- How routing works. Is there a router? Search for route definitions, path handling, query param parsing (URLSearchParams, window.location.search). Look in src/panik-core/ especially (files like AppDemo.tsx, components/LivePositions.tsx, lib/live.ts exist there).\n- The main entry points (the user mentioned \"three entry points\" in a git commit about favicons).\n- Styling approach (CSS modules, tailwind, styled-components, inline).\n- Where components live and naming conventions.\n\nReport back:\n1. Whether a \"Kira\" feature exists and, if so, exactly which files implement it and how it works (file paths + brief description of each).\n2. The tech stack and how routing / query-param reading is done today (with file:line references).\n3. The three entry points and overall directory layout of src/.\n4. Styling conventions with examples.\n\nBe thorough and give concrete file paths and short code excerpts."
}
```


### 👤 User *(2026-07-04 15:37:12)*

**Tool Result (✅ Success - ID: `toolu_01FHZb3q9PDcyCXzfLPdsVYc`):**
```
[{'type': 'text', 'text': "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a74cd661383bcf292 (internal ID - do not mention to user. Use SendMessage with to: 'a74cd661383bcf292', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: C:\\Users\\ASUS\\AppData\\Local\\Temp\\claude\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\dea88f5f-ecda-43b9-a864-77d2a7d27179\\tasks\\a74cd661383bcf292.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification."}]
```


### 🤖 Claude *(2026-07-04 15:37:22)*

**🛠️ Tool Call:** `Agent` (ID: `toolu_017ttRZhUtnqZnRBmEmJB1uP`)
```json
{
  "subagent_type": "Explore",
  "description": "Explore Supabase backend and admin",
  "prompt": "I'm planning a new feature for a project at \"c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\". The feature is a redeemable, admin-configurable, time-limited AND usage-limited product code (like a voucher/campaign) with an admin panel to create campaigns and view status. The project reportedly uses a Supabase backend (Postgres + Edge Functions), Turnstile, and has a waitlist invite flow.\n\nYour job: thoroughly document the backend so I can plan adding a \"product code campaign\" data model + redemption endpoint + admin controls that MATCH existing patterns.\n\nExplore and report:\n1. Supabase usage: find the Supabase client setup, any migrations / SQL schema files (search for \"create table\", \".sql\", \"supabase/migrations\", \"supabase/functions\"). Document existing tables and their columns/naming conventions.\n2. Edge Functions: list any existing edge functions (supabase/functions/*), how they're structured, how they read secrets, how they validate input (e.g. Turnstile), and how the frontend calls them (fetch URLs, headers, anon key usage).\n3. Existing \"invite\" or \"waitlist\" flow: how are invite codes / waitlist entries created, stored, and redeemed today? Any existing redemption or code-generation logic to reuse?\n4. Admin controls: is there any existing admin UI, admin API endpoint, admin auth, or admin script? How would an admin (the user calls them \"Neithan\") create/manage records today?\n5. Any environment/config files (.env, config) that hold things like site URL, Twitter handle, or business details.\n6. Any existing QR-code generation or short-code generation utilities anywhere in the repo (search package.json deps for qrcode libs, and code for code generation).\n\nReport with concrete file paths, short code excerpts, table/column names, and function signatures. Note gaps where nothing exists yet."
}
```


### 👤 User *(2026-07-04 15:37:22)*

**Tool Result (✅ Success - ID: `toolu_017ttRZhUtnqZnRBmEmJB1uP`):**
```
[{'type': 'text', 'text': "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aa4bfd6aaa5053e2c (internal ID - do not mention to user. Use SendMessage with to: 'aa4bfd6aaa5053e2c', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\nDo not duplicate this agent's work — avoid working with the same files or topics it is using.\noutput_file: C:\\Users\\ASUS\\AppData\\Local\\Temp\\claude\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\dea88f5f-ecda-43b9-a864-77d2a7d27179\\tasks\\aa4bfd6aaa5053e2c.output\nDo NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification."}]
```


### 🤖 Claude *(2026-07-04 15:37:27)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:37:27)*

Both Explore agents are running. I'll wait for their findings before proceeding.


### 👤 User *(2026-07-04 15:39:07)*

<task-notification>
<task-id>a74cd661383bcf292</task-id>
<tool-use-id>toolu_01FHZb3q9PDcyCXzfLPdsVYc</tool-use-id>
<output-file>C:\Users\ASUS\AppData\Local\Temp\claude\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\dea88f5f-ecda-43b9-a864-77d2a7d27179\tasks\a74cd661383bcf292.output</output-file>
<status>completed</status>
<summary>Agent "Find Kira feature and app structure" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result>I have a complete picture. No "Kira" feature exists in this repo. Here is my thorough documentation.

## 1. Does a "Kira" feature exist?

**No.** A case-insensitive search for `kira` across the entire repo (excluding `node_modules`) returns **zero matches**. There is no Kira page, component, route, lib, doc, or asset. Likewise there is no "redeem", "redemption", "voucher", "campaign code", "invite code", or "QR/qrcode" feature anywhere in `src/`.

The only near-hits are unrelated: the word "Invite Only" as a label in the founding page (`src\panik-founding\App.tsx:77`), generic `try {}` blocks, and `WaitlistEntry`/registry types. So "match the Kira implementation" means: **there is no existing Kira feature to copy — the user must be treating one of the existing standalone entry pages (most likely the `panik-founding` page) as the structural template.** The closest existing analog to a "2-in-1 business card + redeemable time-limited code" standalone page is the **founding** entry (`src\panik-founding\`): a hidden, direct-URL-only, self-contained single-page app.

## 2. Tech stack &amp; routing / query-params

**Tech stack** (`package.json`, `vite.config.ts`):
- **Framework:** React 19 (`react` / `react-dom` ^19.0.1), `React.StrictMode`.
- **Build tool:** Vite 6 (`vite.config.ts`) with `@vitejs/plugin-react`. **Multi-page (MPA) build** via `build.rollupOptions.input` (3 inputs).
- **Language:** TypeScript ~5.8 (`tsconfig.json`), `.tsx`/`.ts`. Lint = `tsc --noEmit`.
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite` plugin (no `tailwind.config.js`; theme is in-CSS — see section 4).
- **Data/infra libs:** `@tanstack/react-query` v5, `wagmi` v3 + `viem` (wallet/on-chain, used by founding page), `motion` (Framer Motion), `lucide-react` (icons), `express`/`pg` for the separate API server, Supabase migrations under `supabase/`.
- Path alias: `@` → repo root (`vite.config.ts:26-30`).

**Routing — there is no client-side router.** Each page is a separate HTML entry + bundle. "Routing" is done two ways:
- **Dev:** a custom Vite middleware plugin `html-rewrite` maps clean URLs to HTML files — `vite.config.ts:11-24`: `/founding` and `/early-access` → `founding.html`; `/app` → `app.html` (query strings preserved).
- **Build:** three separate rollup inputs (`vite.config.ts:44-53`).
- **API proxy:** `/api` → `http://127.0.0.1:8787` (`vite.config.ts:40-42`).

**Query-param reading:** The app does **not** currently read `window.location.search` / URL params for routing or feature state anywhere. The only `URLSearchParams` use is for building an outbound API request query string in `src\panik-core\lib\live.ts:253-258` (`new URLSearchParams({ protocol, symbol, ... })` → `GET /api/prospective?${q}`). There is **no** existing pattern for reading an incoming param like `?code=XYZ` — a redeemable-code page would need to introduce it (e.g. `new URLSearchParams(window.location.search).get('code')`).

## 3. The three entry points &amp; `src/` layout

**Three entry points** (the commit `080a2af "fix(meta): add favicon set across all three entry points"` refers to these):

| URL / file | HTML | Mounts | Bundle name |
|---|---|---|---|
| `/` → `index.html` | `index.html:14` → `/src/panik-landing-page/main.tsx` | `panik-landing-page` (marketing site) | `landing` |
| `/app` → `app.html` | `app.html:13` → `/src/panik-core/main.tsx` | `panik-core` (the product app) | `app` |
| `/founding`, `/early-access` → `founding.html` | `founding.html:15` → `/src/panik-founding/main.tsx` | `panik-founding` (hidden escrow page, `noindex`) | `founding` |

Each HTML is near-identical: `&lt;div id="root"&gt;` + one module script, favicon block (`/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png`), title/description. `founding.html` adds `&lt;meta name="robots" content="noindex, nofollow"&gt;` (`founding.html:6`) — the pattern to copy for an unlisted card/redeem page.

**`src/` directory layout** (each entry is a self-contained folder with its own `main.tsx` → `App`/root):

```
src/
  index.css                         # shared global stylesheet (imported by every main.tsx)
  vite-env.d.ts
  panik-landing-page/               # entry 1 — marketing
    main.tsx  App.tsx  data.ts  types.ts  utils.ts
    lib/waitlist.ts
    components/  (Hero, Navigation, Footer, WaitlistModal, WaitlistCTA,
                  FAQ, HowItWorks, WhyPanik, AppMockup, PanikLogo, ... )
  panik-core/                       # entry 2 — the product app
    main.tsx  AppDemo.tsx
    providers/AppProviders.tsx      # single infra boundary (wallet/supabase/query) — currently a passthrough
    lib/  (live.ts, types.ts, utils.ts, profileApi.ts, profiling.ts, telegram.ts)
    components/ (LivePositions, Onboarding, OpenPositionModal, Sparkline,
                 InfoTip, ProtocolLogo)
  panik-founding/                   # entry 3 — hidden escrow / invite-only page  ← closest template
    main.tsx  App.tsx
    lib/contracts.ts                # wagmiConfig + contract addresses/ABIs
    components/ (DepositFlow, EscrowStats, RefundBanner)
```

**Naming conventions:**
- Entry folders: `panik-&lt;surface&gt;` (kebab-case). A new feature would follow as e.g. `src/panik-&lt;feature&gt;/`.
- Component files: `PascalCase.tsx`, one component per file, default or named export; `components/` subfolder.
- Libs/helpers: `camelCase.ts` under a `lib/` subfolder.
- `main.tsx` → `createRoot(document.getElementById("root")!).render(&lt;StrictMode&gt;…)` and imports `"../index.css"` (see `panik-founding/main.tsx`, `panik-core/main.tsx`, `panik-landing-page/main.tsx` — all identical shape). `panik-core` wraps in `&lt;AppProviders&gt;`; `panik-founding` wraps its own tree in `WagmiProvider`+`QueryClientProvider` inside `App.tsx` (`panik-founding/App.tsx:263-271`).
- Files carry an `@license SPDX-License-Identifier: Apache-2.0` header in the core/founding surfaces.

**To add a Kira page you would:** create `src/panik-kira/{main.tsx,App.tsx,components/…}`, add a `kira.html` entry, register it in `vite.config.ts` `build.rollupOptions.input` and add a dev URL rewrite (e.g. `/kira` → `/kira.html`), and add the favicon `&lt;link&gt;` block to the new HTML.

## 4. Styling conventions

**Approach:** Tailwind CSS v4 utility classes inline in JSX, plus a small set of custom global utility classes and a CSS theme, all in one shared file `src\index.css` (imported by every `main.tsx`). No CSS modules, no styled-components, no `tailwind.config.js`.

**Theme tokens** are declared with Tailwind v4's `@theme` block in `src\index.css:4-23`, which auto-generates utilities:
- Fonts: `--font-sans` = "Plus Jakarta Sans", `--font-display` = "Space Grotesk" (→ `font-display`), `--font-mono` = "JetBrains Mono" (→ `font-mono`). Fonts loaded via Google Fonts `@import` at `index.css:1`.
- Brand colors → utilities like `text-panik-orange`, `bg-panik-orange`: `--color-panik-orange: #F97316` (`index.css:11`), plus `panik-deep`, `panik-surface`, `panik-card`, and alert colors `panik-green/amber/red/darkred` (`index.css:12-22`).

**Custom global utility classes** (hand-written in `index.css`, used throughout JSX):
- `.panik-glass` — glassmorphism card (blur + border + shadow), `index.css:82-94`. Used e.g. `panik-founding/App.tsx:132,185,203`.
- `.panik-dot-bg` (`:105`) and `.panik-grid-bg` (`:97`) — background textures; `.panik-radial-ambient`/`.panik-radial-subtle` orange glows (`:111-117`).
- `.panik-glow-orange` / `-text` / `-red` / `-green` (`:65-79`).
- Keyframe animations: `.animate-slow-pulse`, `.animate-float-subtle`, `.animate-float-delayed` (`:119-144`).
- Global body noise overlay via `body::after` and orange scrollbar (`index.css:35-61`).

**Representative JSX styling pattern** (from `src\panik-founding\App.tsx`, the best template to mirror) — dark bg, orange accent, glass cards, mount-fade transitions:
```jsx
&lt;div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 …"&gt;
  &lt;div className="fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-50" /&gt;
  &lt;h1 className="font-display text-4xl md:text-6xl font-bold …"&gt;
    &lt;span className="bg-gradient-to-r from-orange-400 via-orange-500 to-amber-500 bg-clip-text text-transparent"&gt;$5 USDC&lt;/span&gt;
  ...
  &lt;div className="group panik-glass rounded-xl px-5 py-4 … hover:border-orange-500/20 transition-all"&gt;
```
Conventions to match: dark near-black backgrounds (`#0A0A0B`/`#09090B`), orange (`#F97316`) primary accent often as a `from-orange-400 … to-amber-500` gradient, `font-display` for headings / `font-mono` for labels/metadata, `.panik-glass` cards with `rounded-xl`/`rounded-2xl`, `border-white/[0.06]` dividers, low-opacity white text (`text-white/40`, `/50`, `/90`), and `mounted` state driving `opacity/translate-y` entrance transitions (`panik-founding/App.tsx:46-47,87,95`).

**Key files for the user to open as templates:** `src\panik-founding\App.tsx` (self-contained standalone page w/ providers), `src\panik-founding\main.tsx` (mount pattern), `founding.html` (noindex HTML entry), `vite.config.ts:11-24,44-53` (route rewrite + build input registration), and `src\index.css` (theme + utility classes).</result>
<usage><subagent_tokens>39924</subagent_tokens><tool_uses>21</tool_uses><duration_ms>114815</duration_ms></usage>
</task-notification>


### 🤖 Claude *(2026-07-04 15:39:09)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:39:10)*

First agent done: no "Kira" feature exists — the `panik-founding` page is the structural template. Waiting on the backend exploration.


### 👤 User *(2026-07-04 15:39:47)*

<task-notification>
<task-id>aa4bfd6aaa5053e2c</task-id>
<tool-use-id>toolu_017ttRZhUtnqZnRBmEmJB1uP</tool-use-id>
<output-file>C:\Users\ASUS\AppData\Local\Temp\claude\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\dea88f5f-ecda-43b9-a864-77d2a7d27179\tasks\aa4bfd6aaa5053e2c.output</output-file>
<status>completed</status>
<summary>Agent "Explore Supabase backend and admin" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result>I have a complete picture of the backend. Here is the documentation.

---

# PANIK Backend — Documentation for a "Product Code Campaign" Feature

## Executive summary of what matters for your feature

The project does **not** use Supabase Edge Functions at all — despite the `supabase/` folder name, there is no `supabase/functions/` directory. The backend is split across three patterns you'll want to match:

1. **Browser → Postgres RPC directly** (via PostgREST + publishable key) for public, low-risk writes guarded by `SECURITY DEFINER` functions. This is the waitlist pattern and is the closest existing analog to a public "redeem this code" endpoint.
2. **Serverless/Express API** (`api/*.ts` Vercel functions + a mirrored `scripts/api-server.ts` Express app) for anything needing the secret key or external APIs.
3. **Direct `pg` scripts** run by the operator with `SUPABASE_DB_URL` for admin tasks (e.g. `scripts/add-wallet.mjs`).

There is **no admin UI, no admin auth, no Turnstile, and no QR/short-code library** anywhere yet. These are all gaps you'll be building from scratch (see §4, §6).

---

## 1. Supabase usage

**Client setup:** There is no `@supabase/supabase-js` SDK dependency. All Supabase access is hand-rolled `fetch` against PostgREST, or raw `pg`. Two access styles:

- **Frontend RPC bridge** — `src/panik-landing-page/lib/waitlist.ts` (lines 61-71):
  ```ts
  fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
      apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify(args),
  })
  ```
  Uses `import.meta.env.VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`.
- **Backend REST store (secret key)** — `server/telegramStore.ts` is the reference pattern for CRUD-over-PostgREST with the service key (`apikey`/`Authorization: Bearer &lt;SUPABASE_SECRET_KEY&gt;`, `Prefer: return=minimal` / `resolution=merge-duplicates`). `server/profileCache.ts` mirrors this.
- **Direct pg** — `scripts/api-server.ts` (lines 93-105) uses `pg.Pool` with `transactionPoolerUrl()` from `server/profileDeps.ts`.

**Migrations** live in `supabase/migrations/` (applied manually by pasting into the Supabase SQL Editor — they are all "idempotent, safe to re-run"):

| File | Tables / objects |
|---|---|
| `20260613000001_scoring_engine.sql` | `public.watched_wallets`, `public.score_snapshots`, `public.watch_transitions`, `public.price_baselines`, `onchain.lending_events`; helper `public.set_updated_at()` trigger fn |
| `20260614000001_waitlist.sql` | `public.waitlist_signups`, view `public.waitlist_enriched`, fns `waitlist_signup()`, `waitlist_count()`, `waitlist_appetite()` |
| `20260623000001_wallet_profiles.sql` | `public.wallet_profiles` (jsonb cache) |
| `20260627000001_telegram_alerts.sql` | `public.telegram_links`, `public.telegram_link_codes`, fn `register_watched_wallet()` |
| `20260627000002_tighten_retention.sql` | retention / pg_cron tuning |

**Naming &amp; design conventions (follow these exactly):**
- Schema `public`; snake_case columns; primary keys either `id uuid default gen_random_uuid()` or `id bigint generated always as identity`.
- Timestamps: `created_at timestamptz not null default now()`, `updated_at` maintained by a `before update` trigger calling `public.set_updated_at()` (scoring_engine.sql:15-20).
- EVM addresses always: `text ... check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$')`.
- Enumerated fields use inline `check (... in (...))` lists, mirrored as TS union types client-side.
- **Every table is deny-all RLS**: `alter table ... enable row level security;` with **zero policies**. The only browser-reachable writes are `SECURITY DEFINER` functions `grant execute ... to anon, authenticated`. Backend uses the secret key / direct pg to bypass RLS.
- Extensions used: `citext`, `pgcrypto`, `pg_cron` (for scheduled cleanup — see telegram_alerts.sql:100-107).
- Retention/cleanup done via `cron.schedule(...)` jobs named `panik_*`.

Reference `watched_wallets` table (scoring_engine.sql:25-35) — this is the shape you'd emulate for a `product_code_campaigns` table:
```sql
create table if not exists public.watched_wallets (
  id           uuid primary key default gen_random_uuid(),
  wallet       text not null unique check (...),
  risk_profile text not null default 'moderate' check (risk_profile in (...)),
  label        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
```

---

## 2. Edge Functions

**None exist.** No `supabase/functions/`. The `BACKEND_PLAN.md` (lines 71-76) explicitly rejected Edge Functions for the waitlist as unnecessary overhead. Instead there are **Vercel serverless functions** in `api/` (each a default-export `handler(req, res)`), mirrored by Express routes in `scripts/api-server.ts` for local/Railway hosting:

- `api/profile/start.ts`, `api/profile/result.ts` — wallet persona profiler
- `api/telegram/link.ts`, `api/telegram/status.ts`, `api/telegram/webhook.ts`

**Structure of a serverless function** (`api/telegram/link.ts` is the cleanest template, lines 25-63):
- Hand-rolled minimal `Req`/`Res` interfaces (no `@vercel/node` types).
- Reads input from `req.query` and/or `req.body`; a `pick()` helper normalizes `string | string[]`.
- Input validation via `isEvmAddress()` from `server/profileDeps.ts`; returns `400` on bad input.
- Reads secrets from `process.env` (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VITE_TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`); returns `503` when unconfigured.
- Delegates DB work to a `server/*Store.ts` class built via `Store.fromEnv()`.
- Code generation for link codes: `randomUUID().replace(/-/g, "")` ("122 bits of entropy", url-safe, single-use). TTL constant e.g. `CODE_TTL_MS = 15*60*1000`.

**Secret-token validation** (the closest thing to Turnstile) — the Telegram webhook checks a shared secret header (`scripts/api-server.ts:558`):
```ts
if (req.header("x-telegram-bot-api-secret-token") !== secret) { res.status(401)... }
```

**How the frontend calls the API:** relative `fetch("/api/...")` (Vercel rewrites `/api/*` to these functions; Vite dev proxies to the Express server on port 8787). CORS is handled in `api-server.ts:300-310` with a `CORS_ORIGINS` allowlist. The waitlist path skips `/api` entirely and calls `${VITE_SUPABASE_URL}/rest/v1/rpc/...` directly.

---

## 3. Existing "invite" / waitlist / code-redemption flow

**Waitlist signup (implemented):** `public.waitlist_signup(...)` in `20260614000001_waitlist.sql:135-197`. Key reusable techniques for a redeemer:
- `SECURITY DEFINER ... set search_path = public`, granted to `anon, authenticated` — the single write door past deny-all RLS.
- **Honeypot** as first check: `if coalesce(btrim(p_honeypot),'') &lt;&gt; '' then return 0; end if;` (silent fake success).
- **Idempotency**: looks up existing row, returns existing `position` if found.
- Email normalization; `position` computed as `count(*)+1`.
- Public counter `public.waitlist_count()` (`SECURITY DEFINER stable`).

**Invite/redeem is essentially NOT built yet.** In `waitlist_signups` the lifecycle is only *reserved*: `status text check in ('waitlist_free','invited','early_access_paid','shipped_active','refund_available','refunded')` and `tier in ('free','early_access')` (waitlist.sql:63-68). No invite codes, no redemption. The intended invite flow is described only as prose in `docs/BACKEND_PLAN.md:191-198`: an operator-run **invite script** that selects `status='waitlist_free'` rows, calls `auth.admin.createUser`, emails a link via Resend, and flips `status='invited'`; login uses `signInWithOtp({ shouldCreateUser: false })`. None of this script exists in the repo yet.

**The single-use, TTL'd, code-redemption mechanism that DOES exist** and is the best pattern to copy is the Telegram deep-link code:
- Table `public.telegram_link_codes (code text pk, wallet text, expires_at timestamptz, created_at)` (telegram_alerts.sql:47-53).
- Mint → `TelegramStore.createLinkCode(code, wallet, ttlMs)` (telegramStore.ts:46-54).
- Resolve → `getLinkCode()` checks existence; **TTL is enforced in application code**, not SQL: `if (!entry || entry.expiresAt &lt;= Date.now())` (api-server.ts:572).
- Consume (single-use) → `consumeLinkCode()` DELETEs the row (telegramStore.ts:70-75).
- Cleanup → hourly `pg_cron` job deletes expired codes (telegram_alerts.sql:102-107).

This "mint code → resolve with TTL check → consume/delete → cron-expire" lifecycle plus the `register_watched_wallet` SECURITY-DEFINER upsert pattern (telegram_alerts.sql:69-96, uses `on conflict (...) do update`) together give you almost the entire template for a redeemable, usage-limited voucher. A usage-limited voucher would extend this by storing `max_redemptions` / `redeemed_count` and doing an atomic conditional `UPDATE ... WHERE redeemed_count &lt; max_redemptions` inside a `SECURITY DEFINER` function.

---

## 4. Admin controls

**There is no admin UI, no admin API endpoint, and no admin authentication anywhere.** Search for `admin` yields only docs, the escrow Solidity contract, and comments. The project's explicit stance (`BACKEND_PLAN.md:198`): *"List retrieval and export: Supabase dashboard table editor... No custom admin panel to build."*

How "Neithan" (the operator) manages records **today**:
- **Supabase dashboard SQL Editor** — pastes migration files to create schema; uses the Table Editor (secret key, bypasses RLS) to view/filter/CSV-export `waitlist_signups`.
- **Direct-pg CLI scripts** run locally with `node --env-file=.env` and `SUPABASE_DB_URL`. The canonical example is `scripts/add-wallet.mjs` (adds rows to `watched_wallets` via `insert ... on conflict (wallet) do nothing`). Other operational scripts: `scripts/verify-schema.mjs` (`npm run db:verify`), `scripts/db-size.mjs` (`npm run db:size`), `scripts/set-telegram-webhook.ts` (`npm run telegram:setup`).

So the existing "admin creates a record" idiom is: **a small `pg` script + an npm script entry in `package.json`**. If you want a real admin panel for creating campaigns, that is greenfield — but the path-of-least-resistance, matching current conventions, is a `scripts/create-campaign.mjs` direct-pg script plus SQL Editor for viewing status.

---

## 5. Environment / config files

- `.env` (gitignored, present) and `.env.example` (the documented template) at repo root. Vite convention: **only `VITE_`-prefixed vars reach the browser bundle**; everything else is backend-only. Never `VITE_`-prefix a secret.
- Relevant existing vars (from `.env.example`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `VITE_TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PUBLIC_BASE_URL`, `CORS_ORIGINS`, `SERVE_STATIC`, `VITE_ESCROW_CONTRACT_ADDRESS`, `VITE_ESCROW_CHAIN_ID`, plus various API keys (CoinGecko, Dune, OpenRouter, Alchemy, Goldsky, WalletConnect).
- **No existing "site URL / Twitter handle / business details" config.** There is no `SITE_URL` (only `TELEGRAM_PUBLIC_BASE_URL` and Railway's `RAILWAY_PUBLIC_DOMAIN`, used at api-server.ts:634-635). No Twitter/X handle anywhere. `metadata.json` (root, 113 bytes) and `src/panik-landing-page/data.ts` are where marketing copy lives — worth a look if your campaign needs branding, but there's no structured "business details" config to reuse.
- Deploy config: `vercel.json` (rewrites, incl. `/api/*` and clean URLs for the 3 HTML entry points `index.html` / `app.html` / `founding.html`), `railway.toml`, `Dockerfile`, `Procfile`, `vite.config.ts` (multi-entry build + dev proxy).

---

## 6. QR-code / short-code generation utilities

- **No QR-code library.** `package.json` has no `qrcode`, `qrcode.react`, or similar; grep for `qrcode|QRCode` hits only `package-lock` noise and docs. If your feature needs a scannable QR for a product code, it's a new dependency (client-side `qrcode.react`, or server-side `qrcode`).
- **No short-code / nanoid library.** No `nanoid` dependency. The only code-generation idiom in the repo is `randomUUID().replace(/-/g,"")` (used for Telegram link codes in `api/telegram/link.ts:49` and `api-server.ts:528`). There is no human-friendly short-code (e.g. `ABCD-1234`) generator — you'd write one (e.g. a `SECURITY DEFINER` SQL function using `pgcrypto`/`gen_random_bytes`, or a JS generator, with a uniqueness retry).

---

## Gaps summary (net-new work for your feature)

| Need | Status |
|---|---|
| Supabase Edge Function | Not used at all — use the RPC or `api/*`+`server/*Store` patterns instead |
| Turnstile / CAPTCHA | Not implemented (deliberately). Only honeypot + deny-all RLS + SECURITY DEFINER exist. Header-secret validation exists on the Telegram webhook if you need a bot-auth analog |
| Admin UI / admin auth / admin API | None. Convention is Supabase dashboard + a direct-`pg` npm script |
| Redeemable / usage-limited code table | None. Closest reusable pattern: `telegram_link_codes` (single-use, TTL) + `register_watched_wallet` (SECURITY-DEFINER upsert with `on conflict`) |
| QR generation | No library |
| Short human-friendly code generation | No library; only `randomUUID` UUIDs |
| Site URL / Twitter / business config | Not present |

## Recommended patterns to match (concrete anchors)
- **Migration file**: new `supabase/migrations/2026MMDD000001_product_codes.sql`, idempotent, deny-all RLS, `set_updated_at` trigger, `check` constraints, pg_cron cleanup for expired campaigns. Model after `20260627000001_telegram_alerts.sql`.
- **Public redeem endpoint**: a `SECURITY DEFINER` fn `public.redeem_product_code(p_code, ...)` granted to `anon` — atomic time-window + usage-limit check + increment — called from the browser via the `rpc()` helper in `src/panik-landing-page/lib/waitlist.ts`.
- **Admin create/manage**: either a `server/campaignStore.ts` (secret-key PostgREST, model after `server/telegramStore.ts`) fronted by `api/campaign/*.ts` handlers (model after `api/telegram/link.ts`), or, matching the current low-ceremony norm, a `scripts/create-campaign.mjs` direct-`pg` script (model after `scripts/add-wallet.mjs`) wired into `package.json` scripts.

Note: a large `claude_session_*.md` transcript (3.3 MB) exists at repo root and mentions many of these terms; I treated it as historical noise, not source of truth. The authoritative planning docs are `docs/BACKEND_PLAN.md` and `docs/USER_JOURNEY.md`.</result>
<usage><subagent_tokens>58724</subagent_tokens><tool_uses>23</tool_uses><duration_ms>144771</duration_ms></usage>
</task-notification>


### 🤖 Claude *(2026-07-04 15:40:40)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:40:45)*

I now have a complete picture from both explorations. Key findings:

- **No "Kira" feature exists** in the repo - "Kira-style" is a description of the desired pattern, not existing code to copy. The **`panik-founding`** page (a hidden, `noindex`, self-contained standalone page) is the closest structural template.
- **Stack:** React 19 + Vite 6 **multi-page** build + TypeScript + Tailwind v4. No client router - each surface is its own HTML entry (`index.html`, `app.html`, `founding.html`). Query params are not read anywhere yet.
- **Backend:** Supabase Postgres via **PostgREST RPC** (no Edge Functions). Public writes go through `SECURITY DEFINER` SQL functions granted to `anon`. Best patterns to copy: `telegram_link_codes` (single-use + TTL) and `waitlist_signup` (honeypot + idempotent). Migrations live in `supabase/migrations/`.
- **Gaps (all net-new):** no QR library, no short-code generator, no admin UI/auth, no business-details config.

A few decisions genuinely change the design, so let me confirm them before I finalize the plan.


### 🤖 Claude *(2026-07-04 15:41:01)*

**🛠️ Tool Call:** `AskUserQuestion` (ID: `toolu_01TX49w7U5yVoNMniBjmXuu1`)
```json
{
  "questions": [
    {
      "question": "When someone successfully clicks \"Try Now\" and the code is valid, what should actually happen (this is the trial for panik.fi/app)?",
      "header": "Redeem outcome",
      "multiSelect": false,
      "options": [
        {
          "label": "Mark trial + open /app",
          "description": "On success, store a trial marker (localStorage + DB record) and redirect into the core app at /app, which treats them as an active trial. Business card stays on /try. Soft gate, tracks who entered.",
          "preview": "valid code \u2192 success flash \u2192\nsetTrial() + redirect to /app?trial=1\ncore app reads marker, shows trial state"
        },
        {
          "label": "Show success + link to app",
          "description": "Simplest: reveal a success state on /try with a button/link to open /app. No gating logic added inside the core app itself.",
          "preview": "valid code \u2192 \"You're in!\"\n[ Open the PANIK app \u2192 ] link to /app"
        },
        {
          "label": "Tie trial to wallet",
          "description": "Require the visitor to connect their wallet before redeeming; the trial (and redemption record) is bound to that wallet address.",
          "preview": "valid code \u2192 connect wallet \u2192\nredeem bound to 0xabc...\ncore app unlocks for that wallet"
        }
      ]
    },
    {
      "question": "How should the admin (Neithan) create campaigns and get the QR + printable code?",
      "header": "Admin flow",
      "multiSelect": false,
      "options": [
        {
          "label": "CLI script (matches repo)",
          "description": "A scripts/create-campaign.mjs direct-pg script (like existing add-wallet.mjs) that creates the campaign and outputs the /try URL, short code, and a QR image file. Status viewing + manual expiry via SQL editor or a small companion script. Fastest, matches current conventions.",
          "preview": "npm run campaign:create -- --days 3 --max 20\n\u2192 code: PANIK-TRY-8X2Q\n\u2192 url:  panik.fi/try?code=...\n\u2192 qr:   ./out/PANIK-TRY-8X2Q.png"
        },
        {
          "label": "Minimal admin web page",
          "description": "A hidden noindex /admin page (password/secret gated) to create campaigns, see live status (used/remaining/time left), download the QR, and expire codes from the browser. More work; greenfield admin auth.",
          "preview": "/admin (secret-gated)\n[ + New campaign ] days:[3] max:[20]\ncampaigns table: code | used | left | \u23f1 | [expire]"
        }
      ]
    },
    {
      "question": "The time limit should count down from...",
      "header": "Time basis",
      "multiSelect": false,
      "options": [
        {
          "label": "From campaign creation",
          "description": "expires_at = created_at + N days. The clock starts when Neithan creates the card batch. Simpler; the printed card has a fixed known expiry.",
          "preview": "created 2026-07-04, N=3\n\u2192 expires 2026-07-07 for everyone"
        },
        {
          "label": "From first redemption",
          "description": "The N-day window starts when the code is first successfully redeemed. Requires tracking first_redeemed_at. Good if cards may sit unused for a while before handing out.",
          "preview": "created 2026-07-04, first used 2026-07-20\n\u2192 expires 2026-07-23"
        }
      ]
    }
  ]
}
```


### 👤 User *(2026-07-04 15:45:48)*

**Tool Result (✅ Success - ID: `toolu_01TX49w7U5yVoNMniBjmXuu1`):**
```
Your questions have been answered: "When someone successfully clicks "Try Now" and the code is valid, what should actually happen (this is the trial for panik.fi/app)?"="each user will receice a a unique link like panik.fi/app-PANIK-SAD1. So this links will expire ", "How should the admin (Neithan) create campaigns and get the QR + printable code?"="Minimal admin web page", "The time limit should count down from..."="Once they successfully open the app". You can now continue with these answers in mind.
```


### 🤖 Claude *(2026-07-04 15:47:04)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:47:07)*

The answers reshape the model into a **per-user expiring trial link**. Let me capture that:

- **Campaign code** (printed on the card, shared) → usage-limited (max N users).
- **"Try Now"** with that code → mints a **unique per-user access token** → user gets their own link like `panik.fi/app?trial=PANIK-SAD1`.
- **Per-user trial clock** starts **when they first open the app** with their link, and expires N later.
- **Admin** = hidden secret-gated web page (create campaigns, live status, QR download, expire).

Let me ground the plan in the actual template/pattern files and pressure-test the design in parallel.


### 🤖 Claude *(2026-07-04 15:47:08)*

**🛠️ Tool Call:** `Read` (ID: `toolu_0137f7WXcgC1fHgoUdfLW4Gv`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vite.config.ts"
}
```


### 👤 User *(2026-07-04 15:47:08)*

**Tool Result (✅ Success - ID: `toolu_0137f7WXcgC1fHgoUdfLW4Gv`):**
```
1	import tailwindcss from '@tailwindcss/vite';
2	import react from '@vitejs/plugin-react';
3	import path from 'path';
4	import {defineConfig} from 'vite';
5	
6	export default defineConfig(() => {
7	  return {
8	    plugins: [
9	      react(),
10	      tailwindcss(),
11	      {
12	        name: 'html-rewrite',
13	        configureServer(server) {
14	          server.middlewares.use((req, res, next) => {
15	            const url = req.url ? req.url.split('?')[0] : '';
16	            if (url === '/founding' || url === '/early-access') {
17	              req.url = '/founding.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
18	            } else if (url === '/app') {
19	              req.url = '/app.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
20	            }
21	            next();
22	          });
23	        }
24	      }
25	    ],
26	    resolve: {
27	      alias: {
28	        '@': path.resolve(__dirname, '.'),
29	      },
30	    },
31	    server: {
32	      // HMR can be disabled via the DISABLE_HMR env var.
33	      // Do not modify — file watching is disabled to prevent flickering during agent edits.
34	      hmr: process.env.DISABLE_HMR !== 'true',
35	      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
36	      watch: process.env.DISABLE_HMR === 'true' ? null : {},
37	      // Local scoring API (npm run dev:api) — keys stay server-side; the
38	      // browser only sees score JSON. 127.0.0.1 (not localhost): Node 17+
39	      // resolves localhost to ::1 first on Windows → ECONNREFUSED.
40	      proxy: {
41	        '/api': 'http://127.0.0.1:8787',
42	      },
43	    },
44	    build: {
45	      rollupOptions: {
46	        input: {
47	          // "panik landing page" — the public marketing site
48	          landing: path.resolve(__dirname, 'index.html'),
49	          // "panik core" — the isolated product app (separate bundle / surface)
50	          app: path.resolve(__dirname, 'app.html'),
51	          // "founding user" — hidden escrow page (direct URL only, not linked from nav)
52	          founding: path.resolve(__dirname, 'founding.html'),
53	        },
54	        // No manualChunks: the previous hand-rolled split matched any path
55	        // containing "react" (e.g. @tanstack/react-query) into vendor-react,
56	        // while vendor depended on it back → a CIRCULAR chunk (vendor ->
57	        // vendor-react -> vendor). At runtime React was undefined when the
58	        // vendor chunk ran createContext → uncaught TypeError → BLANK page on
59	        // every entry. Vite's automatic chunking splits these multi-entry
60	        // bundles correctly without the cycle.
61	      },
62	    },
63	  };
64	});
65	
```


### 🤖 Claude *(2026-07-04 15:47:09)*

**🛠️ Tool Call:** `Read` (ID: `toolu_019aydd2mV8NdDAmGswffrt7`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\supabase\\migrations\\20260627000001_telegram_alerts.sql"
}
```


### 👤 User *(2026-07-04 15:47:09)*

**Tool Result (✅ Success - ID: `toolu_019aydd2mV8NdDAmGswffrt7`):**
```
1	-- ============================================================================
2	-- PANIK - Telegram alerts schema v1 (2026-06-27)
3	-- Scope: deliver "near liquidation" alerts to Telegram for the onboarded user's
4	--        own wallet. Two new tables + one RPC. Idempotent (safe to re-run).
5	--
6	-- ADDITIVE ONLY. Touches none of the scoring objects except by referencing
7	-- public.watched_wallets via the register RPC. No changes to watch_transitions
8	-- (its notified_at / notify_channel columns are already the alert queue).
9	--
10	-- Access model (same as the rest of the project):
11	--   * Watch worker (direct pg) and Vercel webhook (Supabase REST + secret key)
12	--     bypass RLS. All new tables are deny-all RLS (zero policies).
13	--   * The browser registers its onboarded wallet through ONE SECURITY DEFINER
14	--     door: public.register_watched_wallet(), granted to anon (publishable key),
15	--     mirroring public.waitlist_signup(). No new secret reaches the frontend.
16	--
17	-- Link flow:
18	--   browser -> POST /api/telegram/link mints a row in telegram_link_codes and
19	--   returns t.me/<bot>?start=<code>. The user presses Start; the Telegram
20	--   webhook resolves the (single-use, TTL'd) code to a wallet and upserts
21	--   telegram_links(chat_id). The dispatcher joins watch_transitions.wallet =
22	--   telegram_links.wallet to find where to send.
23	-- ============================================================================
24	
25	create extension if not exists pgcrypto;
26	
27	-- ── 1. telegram_links - durable wallet -> chat join target ──────────────────
28	-- One wallet maps to one chat and vice-versa. A re-link (same chat, new wallet)
29	-- is handled in the webhook by deleting the prior chat_id row before upsert.
30	create table if not exists public.telegram_links (
31	  wallet     text primary key
32	             check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
33	  chat_id    bigint not null unique,
34	  username   text,
35	  enabled    boolean not null default true,
36	  created_at timestamptz not null default now(),
37	  updated_at timestamptz not null default now()
38	);
39	
40	drop trigger if exists trg_telegram_links_updated on public.telegram_links;
41	create trigger trg_telegram_links_updated
42	  before update on public.telegram_links
43	  for each row execute function public.set_updated_at();
44	
45	-- ── 2. telegram_link_codes - ephemeral deep-link codes ──────────────────────
46	-- Single-use (deleted on consume), TTL-bounded (expiry checked in the webhook).
47	create table if not exists public.telegram_link_codes (
48	  code       text primary key,
49	  wallet     text not null
50	             check (wallet = lower(wallet) and wallet ~ '^0x[0-9a-f]{40}$'),
51	  expires_at timestamptz not null,
52	  created_at timestamptz not null default now()
53	);
54	
55	create index if not exists idx_telegram_link_codes_expires
56	  on public.telegram_link_codes (expires_at);
57	
58	-- ── 3. RLS - deny-all default (worker/webhook use secret key / direct pg) ────
59	alter table public.telegram_links      enable row level security;
60	alter table public.telegram_link_codes enable row level security;
61	-- No policies on purpose: publishable-key clients get nothing here. The only
62	-- browser-facing write is register_watched_wallet() below (SECURITY DEFINER).
63	
64	-- ── 4. register_watched_wallet - browser registers its onboarded wallet ─────
65	-- Mirrors public.waitlist_signup: deny-all table + ONE SECURITY DEFINER door
66	-- granted to anon. Idempotent on the wallet unique constraint; a re-onboard
67	-- refreshes risk_profile and re-activates the row. Silent no-op for non-EVM
68	-- (Solana) addresses, which the on-chain readers cannot monitor.
69	create or replace function public.register_watched_wallet(
70	  p_wallet  text,
71	  p_profile text
72	) returns void
73	language plpgsql
74	security definer
75	set search_path = public
76	as $$
77	declare
78	  v_wallet  text := lower(btrim(coalesce(p_wallet, '')));
79	  v_profile text := lower(btrim(coalesce(p_profile, '')));
80	begin
81	  if v_wallet !~ '^0x[0-9a-f]{40}$' then
82	    return; -- non-EVM or malformed: nothing to monitor
83	  end if;
84	  if v_profile not in ('conservative','moderate','aggressive') then
85	    v_profile := 'moderate';
86	  end if;
87	
88	  insert into public.watched_wallets (wallet, risk_profile, label)
89	  values (v_wallet, v_profile, 'onboarded user')
90	  on conflict (wallet) do update
91	    set risk_profile = excluded.risk_profile,
92	        is_active    = true,
93	        updated_at   = now();
94	end $$;
95	
96	grant execute on function public.register_watched_wallet(text, text) to anon, authenticated;
97	
98	-- ── 5. Retention - expire stale link codes (pg_cron) ────────────────────────
99	-- Separate job; does NOT touch the existing panik_retention schedule.
100	create extension if not exists pg_cron;
101	
102	do $$ begin perform cron.unschedule('panik_telegram_codes_cleanup'); exception when others then null; end $$;
103	select cron.schedule(
104	  'panik_telegram_codes_cleanup',
105	  '23 * * * *',  -- hourly at :23
106	  $$ delete from public.telegram_link_codes where expires_at < now() - interval '1 day'; $$
107	);
108	
```


### 🤖 Claude *(2026-07-04 15:47:09)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01SrgjZ4roBvWqBAYVMTXRFF`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-landing-page\\lib\\waitlist.ts"
}
```


### 👤 User *(2026-07-04 15:47:09)*

**Tool Result (✅ Success - ID: `toolu_01SrgjZ4roBvWqBAYVMTXRFF`):**
```
1	/**
2	 * @license
3	 * SPDX-License-Identifier: Apache-2.0
4	 *
5	 * Waitlist API bridge for the landing page.
6	 *
7	 * LEAN design (no Edge Function, no SDK, no CAPTCHA): the browser calls two
8	 * SECURITY DEFINER Postgres functions directly via PostgREST with the
9	 * publishable key. The waitlist_signups table is deny-all RLS; these functions
10	 * are the only door. See supabase/migrations/20260614000001_waitlist.sql.
11	 */
12	
13	const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
14	const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
15	
16	export const waitlistConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
17	
18	export type Appetite = "conservative" | "moderate" | "aggressive";
19	
20	/** Stable option keys — must match the DB CHECK lists. */
21	export interface SignupAnswers {
22	  email: string;
23	  walletAddress: string;
24	  q1DefiActivity: "never" | "tried" | "active_1_2" | "active_3_plus";
25	  q2Liquidation: "no_unsure" | "no_managed" | "yes_caught" | "yes_accept";
26	  q3RiskTracking: ("manual_dashboard" | "portfolio_tracker" | "custom_alerts" | "protocol_alerts")[];
27	  q4Frustrations: ("no_unified_view" | "slow_reaction" | "silent_risk" | "execution_friction")[];
28	  q5PortfolioSize: "lt_1k" | "1k_10k" | "10k_50k" | "50k_200k" | "gt_200k";
29	  additionalNotes?: string;
30	  /** Honeypot — real users never fill this; bots do. */
31	  honeypot?: string;
32	}
33	
34	export interface SignupResult {
35	  ok: boolean;
36	  position?: number;
37	  error?: string;
38	}
39	
40	export const isValidEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
41	
42	/**
43	 * Client-side mirror of public.waitlist_appetite() — used only to SHOW the
44	 * profile on the success screen. Appetite is derived (never stored); the DB
45	 * view recomputes it for analysis. Keep this in sync with the SQL function.
46	 */
47	export function deriveAppetite(
48	  q1: SignupAnswers["q1DefiActivity"],
49	  q2: SignupAnswers["q2Liquidation"],
50	  q5: SignupAnswers["q5PortfolioSize"],
51	): Appetite {
52	  const s1 = { never: 1, tried: 1, active_1_2: 2, active_3_plus: 3 }[q1];
53	  const s2 = { no_unsure: 1, no_managed: 2, yes_caught: 2, yes_accept: 3 }[q2];
54	  const s5 = { lt_1k: 1, "1k_10k": 1, "10k_50k": 2, "50k_200k": 3, gt_200k: 3 }[q5];
55	  const score = s1 + s2 * 2 + s5; // 4..12
56	  if (score <= 6) return "conservative";
57	  if (score <= 9) return "moderate";
58	  return "aggressive";
59	}
60	
61	async function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
62	  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
63	    method: "POST",
64	    headers: {
65	      "Content-Type": "application/json",
66	      apikey: SUPABASE_KEY!,
67	      Authorization: `Bearer ${SUPABASE_KEY}`,
68	    },
69	    body: JSON.stringify(args),
70	  });
71	}
72	
73	/** Submit a signup via the waitlist_signup RPC. Never throws — returns a result. */
74	export async function submitSignup(answers: SignupAnswers): Promise<SignupResult> {
75	  if (!waitlistConfigured) return { ok: false, error: "config_missing" };
76	  try {
77	    const res = await rpc("waitlist_signup", {
78	      p_email: answers.email,
79	      p_wallet: answers.walletAddress,
80	      p_q1_defi_activity: answers.q1DefiActivity,
81	      p_q2_liquidation: answers.q2Liquidation,
82	      p_q3_risk_tracking: answers.q3RiskTracking,
83	      p_q4_frustrations: answers.q4Frustrations,
84	      p_q5_portfolio_size: answers.q5PortfolioSize,
85	      p_additional_notes: answers.additionalNotes ?? null,
86	      p_honeypot: answers.honeypot ?? "",
87	    });
88	    if (!res.ok) {
89	      const text = await res.text().catch(() => "");
90	      return { ok: false, error: `http_${res.status}: ${text.slice(0, 160)}` };
91	    }
92	    const position = await res.json(); // scalar integer
93	    return { ok: true, position: typeof position === "number" ? position : undefined };
94	  } catch {
95	    return { ok: false, error: "network" };
96	  }
97	}
98	
99	/** Public waitlist count via the SECURITY DEFINER RPC. null on failure. */
100	export async function getWaitlistCount(): Promise<number | null> {
101	  if (!waitlistConfigured) return null;
102	  try {
103	    const res = await rpc("waitlist_count", {});
104	    if (!res.ok) return null;
105	    const n = await res.json();
106	    return typeof n === "number" ? n : null;
107	  } catch {
108	    return null;
109	  }
110	}
111	
112	// ── Wallet connect — EIP-6963 multi-provider discovery (no wagmi) ───────────
113	// EIP-6963 is the current standard for discovering injected wallets without
114	// the legacy window.ethereum collision (when several wallets are installed
115	// they fight over that single object). Each wallet announces itself with an
116	// rdns id; we match MetaMask (io.metamask) / Coinbase (com.coinbase.wallet)
117	// exactly. Falls back to window.ethereum for wallets that predate EIP-6963.
118	// We only read the address — no signing, no chain switch.
119	
120	interface Eip1193Provider {
121	  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
122	  isMetaMask?: boolean;
123	  isCoinbaseWallet?: boolean;
124	}
125	interface Eip6963ProviderInfo { uuid: string; name: string; icon: string; rdns: string; }
126	interface Eip6963ProviderDetail { info: Eip6963ProviderInfo; provider: Eip1193Provider; }
127	
128	declare global {
129	  interface Window {
130	    ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] };
131	    coinbaseWalletExtension?: Eip1193Provider;
132	  }
133	  interface WindowEventMap {
134	    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
135	  }
136	}
137	
138	export type WalletRdns = "io.metamask" | "com.coinbase.wallet";
139	const WALLET_LABEL: Record<WalletRdns, string> = {
140	  "io.metamask": "MetaMask",
141	  "com.coinbase.wallet": "Coinbase Wallet",
142	};
143	
144	// Providers announce in response to the request event; collect them by rdns.
145	const announced = new Map<string, Eip6963ProviderDetail>();
146	if (typeof window !== "undefined") {
147	  window.addEventListener("eip6963:announceProvider", (e) => {
148	    announced.set(e.detail.info.rdns, e.detail);
149	  });
150	  window.dispatchEvent(new Event("eip6963:requestProvider"));
151	}
152	
153	function refreshAnnouncements(): Promise<void> {
154	  return new Promise((resolve) => {
155	    if (typeof window === "undefined") return resolve();
156	    window.dispatchEvent(new Event("eip6963:requestProvider"));
157	    setTimeout(resolve, 250); // small grace window for late announcers
158	  });
159	}
160	
161	// Legacy fallback for wallets that don't emit EIP-6963 yet. Handles the
162	// window.ethereum.providers[] array that multi-wallet setups expose.
163	function legacyProvider(rdns: WalletRdns): Eip1193Provider | null {
164	  const eth = window.ethereum;
165	  if (!eth) return rdns === "com.coinbase.wallet" ? window.coinbaseWalletExtension ?? null : null;
166	  const list = eth.providers?.length ? eth.providers : [eth];
167	  const found = list.find((p) =>
168	    rdns === "io.metamask" ? p.isMetaMask && !p.isCoinbaseWallet : p.isCoinbaseWallet,
169	  );
170	  return found ?? (rdns === "com.coinbase.wallet" ? window.coinbaseWalletExtension ?? null : null);
171	}
172	
173	/** True if at least one injected wallet is present (EIP-6963 or legacy). */
174	export const hasInjectedWallet = (): boolean =>
175	  typeof window !== "undefined" && (announced.size > 0 || Boolean(window.ethereum));
176	
177	/**
178	 * Connect to a specific wallet by rdns and return a lowercased EVM address.
179	 * Throws a user-facing message if the wallet isn't installed or is rejected.
180	 */
181	export async function connectWallet(rdns: WalletRdns): Promise<string> {
182	  await refreshAnnouncements();
183	  const provider = announced.get(rdns)?.provider ?? legacyProvider(rdns);
184	  if (!provider) {
185	    throw new Error(`${WALLET_LABEL[rdns]} not detected. Install it, or paste your address below.`);
186	  }
187	  try {
188	    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
189	    const addr = accounts?.[0];
190	    if (!addr || !isValidEvmAddress(addr)) {
191	      throw new Error("Could not read a valid address from your wallet.");
192	    }
193	    return addr.toLowerCase();
194	  } catch (e) {
195	    const code = (e as { code?: number })?.code;
196	    if (code === 4001 || code === 4100) throw new Error("Connection request was rejected.");
197	    throw e instanceof Error ? e : new Error("Wallet connection failed.");
198	  }
199	}
200	
```


### 🤖 Claude *(2026-07-04 15:47:10)*

**🛠️ Tool Call:** `Read` (ID: `toolu_019pPYCsZVWX5hGpwycZwmFm`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\api\\telegram\\link.ts"
}
```


### 👤 User *(2026-07-04 15:47:10)*

**Tool Result (✅ Success - ID: `toolu_019pPYCsZVWX5hGpwycZwmFm`):**
```
1	/**
2	 * POST/GET /api/telegram/link?wallet=0x...
3	 * Mints a single-use deep-link code for the wallet and returns the t.me deep
4	 * link the user opens to connect their Telegram. The user pressing Start fires
5	 * /api/telegram/webhook, which resolves the code to the wallet.
6	 *
7	 * Fast, fetch-only (Supabase REST), Vercel Hobby-safe. No viem/pg.
8	 * Mirrors api/profile/start.ts. See docs/technical-docs/TELEGRAM_ALERTS.md.
9	 */
10	
11	import { randomUUID } from "node:crypto";
12	import { isEvmAddress } from "../../server/profileDeps";
13	import { TelegramStore } from "../../server/telegramStore";
14	
15	interface Req { method?: string; query: Record<string, string | string[] | undefined>; body?: unknown }
16	interface Res { status(code: number): Res; json(body: unknown): void }
17	
18	function pick(v: string | string[] | undefined): string | undefined {
19	  return Array.isArray(v) ? v[0] : v;
20	}
21	
22	/** Codes live 15 minutes. */
23	const CODE_TTL_MS = 15 * 60 * 1000;
24	
25	export default async function handler(req: Req, res: Res): Promise<void> {
26	  const body = (req.body ?? {}) as { wallet?: string };
27	  const wallet = (pick(req.query.wallet) ?? body.wallet ?? "").trim().toLowerCase();
28	
29	  if (!isEvmAddress(wallet)) {
30	    res.status(400).json({ error: "invalid EVM wallet address" });
31	    return;
32	  }
33	
34	  const botUsername = process.env.VITE_TELEGRAM_BOT_USERNAME;
35	  if (!botUsername) {
36	    res.status(503).json({ error: "telegram unconfigured (VITE_TELEGRAM_BOT_USERNAME)" });
37	    return;
38	  }
39	
40	  let store: TelegramStore;
41	  try {
42	    store = TelegramStore.fromEnv();
43	  } catch (err) {
44	    res.status(503).json({ error: `telegram unconfigured: ${(err as Error).message}` });
45	    return;
46	  }
47	
48	  // url-safe, single-use; randomUUID is 122 bits of entropy.
49	  const code = randomUUID().replace(/-/g, "");
50	  try {
51	    await store.createLinkCode(code, wallet, CODE_TTL_MS);
52	  } catch (err) {
53	    res.status(502).json({ error: (err as Error).message });
54	    return;
55	  }
56	
57	  res.status(200).json({
58	    code,
59	    botUsername,
60	    deepLink: `https://t.me/${botUsername}?start=${code}`,
61	    expiresInSec: CODE_TTL_MS / 1000,
62	  });
63	}
64	
```


### 🤖 Claude *(2026-07-04 15:47:11)*

**🛠️ Tool Call:** `Read` (ID: `toolu_0163p9SSxKtU6vQTZxfFq76U`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\package.json"
}
```


### 👤 User *(2026-07-04 15:47:11)*

**Tool Result (✅ Success - ID: `toolu_0163p9SSxKtU6vQTZxfFq76U`):**
```
1	{
2	  "name": "panik",
3	  "private": true,
4	  "version": "0.0.0",
5	  "type": "module",
6	  "workspaces": [
7	    "packages/*"
8	  ],
9	  "scripts": {
10	    "dev": "vite --port=3000 --host=0.0.0.0",
11	    "build": "vite build",
12	    "preview": "vite preview",
13	    "clean": "rm -rf dist server.js",
14	    "lint": "tsc --noEmit",
15	    "test:scoring": "npm run test --workspace=@panik/scoring",
16	    "ping:apis": "node --env-file=.env scripts/ping-apis.mjs",
17	    "demo:scores": "node --env-file=.env --import tsx scripts/score-demo.ts",
18	    "demo:watch": "node --env-file=.env --import tsx scripts/watch-demo.ts",
19	    "db:verify": "node --env-file=.env scripts/verify-schema.mjs",
20	    "db:size": "node --env-file=.env scripts/db-size.mjs",
21	    "dev:api": "node --watch --env-file=.env --import tsx scripts/api-server.ts",
22	    "start:api": "node --import tsx scripts/api-server.ts",
23	    "worker": "node --import tsx scripts/watch-worker.ts",
24	    "worker:dev": "node --env-file=.env --import tsx scripts/watch-worker.ts",
25	    "telegram:setup": "node --env-file=.env --import tsx scripts/set-telegram-webhook.ts"
26	  },
27	  "dependencies": {
28	    "@tailwindcss/vite": "^4.1.14",
29	    "@tanstack/react-query": "^5.101.0",
30	    "@vitejs/plugin-react": "^5.0.4",
31	    "dotenv": "^17.2.3",
32	    "express": "^4.21.2",
33	    "lucide-react": "^0.546.0",
34	    "motion": "^12.23.24",
35	    "pg": "^8.21.0",
36	    "react": "^19.0.1",
37	    "react-dom": "^19.0.1",
38	    "viem": "^2.52.2",
39	    "vite": "^6.2.3",
40	    "wagmi": "^3.6.17"
41	  },
42	  "devDependencies": {
43	    "@types/express": "^4.17.21",
44	    "@types/node": "^22.14.0",
45	    "autoprefixer": "^10.4.21",
46	    "esbuild": "^0.25.0",
47	    "solc": "^0.8.24",
48	    "tailwindcss": "^4.1.14",
49	    "tsx": "^4.21.0",
50	    "typescript": "~5.8.2",
51	    "vite": "^6.2.3"
52	  }
53	}
54	
```


### 🤖 Claude *(2026-07-04 15:47:11)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01UCH8iQga1NLEGjEoYBii5m`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\founding.html"
}
```


### 👤 User *(2026-07-04 15:47:11)*

**Tool Result (✅ Success - ID: `toolu_01UCH8iQga1NLEGjEoYBii5m`):**
```
1	<!DOCTYPE html>
2	<html lang="en">
3	  <head>
4	    <meta charset="UTF-8" />
5	    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
6	    <meta name="robots" content="noindex, nofollow" />
7	    <meta name="description" content="Become a PANIK founding user. Deposit $5 USDC with a 90-day refund guarantee." />
8	    <title>PANIK — Founding User</title>
9	    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
10	    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
11	    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
12	  </head>
13	  <body>
14	    <div id="root"></div>
15	    <script type="module" src="/src/panik-founding/main.tsx"></script>
16	  </body>
17	</html>
18	
```


### 🤖 Claude *(2026-07-04 15:47:41)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:47:42)*

I have everything I need - the template files, the RPC/api patterns, the atomicity approach, and the MPA wiring. Writing the final plan now.


### 🤖 Claude *(2026-07-04 15:48:37)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01JvC33eZN6WfiCpVRvbk7yF`)
```json
{
  "file_path": "C:\\Users\\ASUS\\.claude\\plans\\feature-kira-style-2-in-1-business-purrfect-spindle.md",
  "content": "# Kira-style 2-in-1 Business Card + Time-Limited Trial Code\n\n## Context\n\nWe want a physical business card that does two jobs from one QR + short code:\n1. **Business card** - always shows panik.fi + X (@panik_fi), no matter the code state.\n2. **Trial code** - scanning lands on `/try?code=...`; clicking **Try Now** redeems a\n   usage-limited campaign code and mints the visitor a **unique, expiring access link**\n   into the core app (`panik.fi/app?trial=PANIK-XXXX`).\n\nConfirmed decisions from the user:\n- **Redeem outcome:** each successful redemption issues a *unique per-user* access link\n  into `/app`; that link expires per user.\n- **Trial clock basis:** the per-user expiry starts **when the user first opens the app**\n  with their link (not at card creation, not at redeem time).\n- **Admin:** a hidden, secret-gated **admin web page** to create campaigns, watch live\n  status, download the QR, and expire campaigns early.\n\nExploration established there is **no existing \"Kira\" feature** - \"Kira-style\" describes\nthe desired pattern. This is greenfield, built to match the repo's existing conventions:\nthe hidden `panik-founding` page is the structural template; the `telegram_link_codes` +\n`waitlist_signup` (SECURITY DEFINER, deny-all RLS) is the data template; `api/telegram/link.ts`\n+ `server/telegramStore.ts` is the endpoint template.\n\n**Stack (fixed):** React 19 + Vite 6 multi-page build + TypeScript + Tailwind v4;\nSupabase Postgres via PostgREST (no Edge Functions); `api/*` Vercel functions mirrored by\n`scripts/api-server.ts` Express routes; secrets stay server-side.\n\n---\n\n## Data model - new migration `supabase/migrations/20260704000001_product_codes.sql`\n\nIdempotent, additive, deny-all RLS, `set_updated_at()` trigger, `check` constraints,\npg_cron cleanup - modeled exactly on `20260627000001_telegram_alerts.sql`.\n\n**`public.product_campaigns`** - one row per card/QR batch (admin-created):\n- `id uuid pk default gen_random_uuid()`\n- `campaign_code text unique` - printed short code, `check (campaign_code ~ '^PANIK-TRY-[A-Z0-9]{4,8}$')`\n- `label text` - admin note\n- `max_redemptions int not null check (max_redemptions > 0)` - usage limit (max unique users)\n- `redemption_count int not null default 0`\n- `trial_duration_hours int not null check (trial_duration_hours > 0)` - per-user trial length once app opened\n- `claim_window_expires_at timestamptz` - optional cutoff for *claiming* the code (null = none)\n- `is_active boolean not null default true` - manual kill switch\n- `created_at / updated_at timestamptz` (+ updated trigger)\n- Derived status (computed in SQL/TS, not stored): `active | exhausted | expired | disabled`.\n\n**`public.trial_grants`** - one row per successful redemption (per-user unique link):\n- `id uuid pk`, `campaign_id uuid references product_campaigns(id)`\n- `access_token text unique` - the `PANIK-XXXXXX` in the app link, `check` format\n- `first_opened_at timestamptz` (null until first `/app` open) - **starts the clock**\n- `expires_at timestamptz` (null until first open; set = `first_opened_at + trial_duration_hours`)\n- `claim_ip text`, `claim_user_agent text`, `created_at`\n\n**`public.redemption_attempts`** - log **every** Try-Now attempt (success or fail):\n- `id bigint identity`, `campaign_code text`, `outcome text check (outcome in ('success','not_found','disabled','expired','exhausted'))`,\n  `ip text`, `user_agent text`, `granted_token_id uuid`, `created_at`.\n\n**SECURITY DEFINER functions** (granted to `anon`, mirroring `register_watched_wallet`):\n- `redeem_campaign_code(p_code, p_ip, p_ua)` \u2192 logs an attempt, then **atomically**\n  `UPDATE product_campaigns SET redemption_count = redemption_count + 1\n   WHERE id = ... AND is_active AND redemption_count < max_redemptions\n   AND (claim_window_expires_at IS NULL OR now() < claim_window_expires_at) RETURNING` -\n  the guarded UPDATE prevents an over-limit race. On success mints a `trial_grants` row and\n  returns `{outcome:'success', token}`; otherwise returns the failure `outcome`.\n- `open_trial(p_token, p_ip, p_ua)` \u2192 resolves a grant; if `first_opened_at IS NULL` sets it\n  and computes `expires_at` (**clock starts here**); returns `{outcome:'active'|'expired'|'invalid', expires_at}`.\n- pg_cron job `panik_trial_grants_cleanup` deletes long-expired grants (mirrors the telegram cleanup).\n\n---\n\n## Backend endpoints (capture IP/UA + hold secret key; Express-mirrored)\n\nFollow the `api/telegram/link.ts` + `server/telegramStore.ts` template. New\n`server/campaignStore.ts` (PostgREST + `SUPABASE_SECRET_KEY`, modeled on `server/telegramStore.ts`)\ncalls the RPCs; each `api/*` handler is mirrored as an Express route in `scripts/api-server.ts`.\n\n- `api/try/redeem.ts` - `POST {code, honeypot}`; reads client IP from headers \u2192 `redeem_campaign_code`\n  \u2192 returns `{outcome, trialUrl}` where `trialUrl = /app?trial=<token>` on success. Honeypot check first (silent success), like `waitlist_signup`.\n- `api/try/access.ts` - `POST {token}` from the core app on load \u2192 `open_trial` \u2192 `{outcome, expiresAt}`.\n- `api/admin/campaigns.ts` - `GET` (list + live status), `POST` (create), `POST ?action=expire`.\n  Guarded by an `x-admin-key` header checked against `ADMIN_ACCESS_KEY` env, exactly like the\n  Telegram webhook secret check in `scripts/api-server.ts` (`x-telegram-bot-api-secret-token`).\n\n---\n\n## Frontend - three surfaces\n\n**1. New `/try` page** (`src/panik-try/`, entry `try.html`) - structural clone of `panik-founding`\n(`main.tsx` shape, `noindex` HTML, `.panik-glass` cards, dark/orange styling from `src/index.css`).\n- On load: `const code = new URLSearchParams(window.location.search).get('code')` (the first\n  incoming-param read in the app - none exists today).\n- **Business card block always rendered** (all states): website `panik.fi`, X `@panik_fi`\n  (`https://x.com/panik_fi`) - from a hardcoded `src/panik-try/businessCard.ts` constant\n  (matches how landing/founding hardcode copy; no config store exists).\n- **Try Now**: if `code` present \u2192 one-tap `POST /api/try/redeem`. If absent \u2192 button reveals\n  a manual \"Enter your code\" input (the printed fallback), then same redeem call.\n- Result states in place of the redeem UI (card stays visible): **success** \u2192 show the unique\n  `/app?trial=...` link (copyable + auto-continue button); **expired/exhausted/not_found** \u2192\n  clear \"this code is no longer valid\" message.\n\n**2. New `/admin` page** (`src/panik-admin/`, entry `admin.html`, `noindex`) - secret-gated.\n- Prompts for the admin key (kept in `sessionStorage`, sent as `x-admin-key`).\n- Create campaign form: label, duration (days), max redemptions \u2192 `POST /api/admin/campaigns`.\n- Campaigns table with live status: code, used/max, time remaining, status badge, **Expire** button.\n- Per campaign: renders the QR via the new `qrcode` dependency (`QRCode.toDataURL(tryUrl)`),\n  shows `/try?code=...` + the short code, and a **Download QR (PNG)** button for printing.\n\n**3. Core app trial-awareness** (`src/panik-core`) - minimal, in `main.tsx`/`AppDemo.tsx`:\n- On load read `?trial=<token>`; if present `POST /api/try/access` and show a trial banner\n  (\"Trial active - expires in Xh\" / \"Trial expired\" with a CTA back to `/try`).\n- Keep the existing demo accessible; **hard-locking `/app` for non-trial visitors is out of\n  scope** for this MVP (flag as a one-line follow-up toggle if wanted).\n\n**Wiring:**\n- `vite.config.ts`: add `try` + `admin` to `build.rollupOptions.input`; add dev rewrites\n  `/try \u2192 /try.html`, `/admin \u2192 /admin.html` (query strings preserved, like the `/app` branch).\n- `vercel.json`: add the two clean-URL rewrites alongside the existing three.\n- Add favicon `<link>` block + `noindex` meta to both new HTML files (copy `founding.html`).\n- `.env.example`: add `ADMIN_ACCESS_KEY` (+ document it needs `SUPABASE_SECRET_KEY`, already present).\n\n---\n\n## Code generation\n\n- **Campaign code:** `PANIK-TRY-XXXX` (4 chars from an unambiguous alphabet, no I/O/0/1),\n  generated in `campaignStore` with a uniqueness retry on the unique constraint.\n- **Access token:** `PANIK-XXXXXX` (6 chars, same alphabet) minted inside `redeem_campaign_code`.\n- **QR:** new `qrcode` npm dependency, rendered client-side in the admin page. (URL uses a\n  `?trial=` query param for the app link; if the literal `panik.fi/app-PANIK-...` path form is\n  required instead, that's a small extra Vite/Vercel rewrite - confirm during build.)\n\n---\n\n## Tests (`vitest` - new devDependency; add `\"test\": \"vitest run\"`)\n\nCore decision logic is extracted into a pure, testable module\n`src/panik-try/lib/trialLogic.ts` (mirrored by the SQL) so we can unit-test without a DB:\n- `evaluateCampaign(campaign, now)` \u2192 `active|exhausted|expired|disabled` - **count limit** and\n  **time limit** cases.\n- `computeTrialExpiry(firstOpenedAt, durationHours)` and `evaluateTrialAccess(grant, now)` \u2192\n  first-open sets clock; before-expiry `active`; after-expiry `expired`; unknown token `invalid`.\n- `parseCode(searchString)` \u2192 covers **scan path** (`?code=ABC`) and **manual fallback** (empty\n  \u2192 prompts input).\n- The atomic over-limit guard lives in SQL; note it in the test file and verify manually per below.\n\n---\n\n## Verification (end-to-end)\n\n1. `npm run lint` (tsc) and `npm run test` (vitest) pass.\n2. Apply `20260704000001_product_codes.sql` in the Supabase SQL editor (idempotent; re-run safe);\n   `npm run db:verify` still passes.\n3. `npm run dev` + `npm run dev:api`. Open `/admin`, enter `ADMIN_ACCESS_KEY`, create a campaign\n   (e.g. 3 days / 2 uses). Confirm QR + short code render and the QR downloads.\n4. **Scan path:** open `/try?code=<code>` \u2192 business card visible, Try Now one-tap \u2192 success\n   returns a unique `/app?trial=<token>` link. Open it \u2192 app shows \"Trial active\"; DB\n   `trial_grants.first_opened_at`/`expires_at` now set (clock started on open).\n5. **Manual path:** open `/try` (no param) \u2192 Try Now reveals the input \u2192 type the printed code \u2192\n   same success.\n6. **Limits:** redeem until `redemption_count == max_redemptions` \u2192 next Try Now shows\n   \"no longer valid\" (exhausted) while the business card stays visible. Set a campaign's\n   `claim_window_expires_at` in the past (or Expire it in admin) \u2192 Try Now shows expired/disabled.\n   Confirm every attempt (success and fail) appears in `redemption_attempts` with IP + timestamp.\n7. **Per-user expiry:** temporarily set a short `trial_duration_hours`, open the app link, wait\n   past expiry, reload \u2192 app shows \"Trial expired\".\n"
}
```


### 👤 User *(2026-07-04 15:48:38)*

**Tool Result (✅ Success - ID: `toolu_01JvC33eZN6WfiCpVRvbk7yF`):**
```
File created successfully at: C:\Users\ASUS\.claude\plans\feature-kira-style-2-in-1-business-purrfect-spindle.md (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 15:48:40)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:48:49)*

The plan is written. Here's the shape of it:

**What it builds** - a 2-in-1 card feature matching the repo's existing conventions (no "Kira" code exists to copy; `panik-founding` + `telegram_link_codes` + `api/telegram/link.ts` are the templates):

- **New migration** `20260704000001_product_codes.sql` - `product_campaigns` (usage + optional claim-window limits), `trial_grants` (per-user expiring tokens, clock starts on first app open), `redemption_attempts` (logs every attempt w/ IP). Atomic over-limit guard + `SECURITY DEFINER` RPCs, deny-all RLS - mirrors the telegram schema.
- **Endpoints** (`api/try/redeem`, `api/try/access`, `api/admin/campaigns`) mirrored in the Express dev server, capturing IP and holding the secret key.
- **`/try` page** - business card (panik.fi + @panik_fi) always visible; scan path (`?code=`) one-tap + manual fallback input; clear expired/exhausted states.
- **`/admin` page** - secret-gated create/status/expire + client-side QR generation & PNG download (new `qrcode` dep).
- **Core-app trial banner** reading `?trial=` (hard-locking `/app` left as an explicit out-of-scope follow-up).
- **vitest** unit tests for count-limit, time-limit, first-open expiry, and scan-vs-manual parsing.

Two things I defaulted rather than blocked on (both noted in the plan): the app link uses `?trial=PANIK-XXXX` as a query param (a literal `/app-PANIK-...` path would need one extra rewrite), and hard-gating the app is deliberately out of scope for the MVP.


### 🤖 Claude *(2026-07-04 15:48:50)*

**🛠️ Tool Call:** `ToolSearch` (ID: `toolu_01QLszoMfPq49VZRANAU1yrh`)
```json
{
  "query": "select:ExitPlanMode",
  "max_results": 1
}
```


### 👤 User *(2026-07-04 15:48:50)*

**Tool Result (✅ Success - ID: `toolu_01QLszoMfPq49VZRANAU1yrh`):**
```
[{'type': 'tool_reference', 'tool_name': 'ExitPlanMode'}]
```


### 🤖 Claude *(2026-07-04 15:48:51)*

**🛠️ Tool Call:** `ExitPlanMode` (ID: `toolu_01UsqA3Z7sCHXjPkKqu8ANve`)
```json
{
  "plan": "# Kira-style 2-in-1 Business Card + Time-Limited Trial Code\n\n## Context\n\nWe want a physical business card that does two jobs from one QR + short code:\n1. **Business card** - always shows panik.fi + X (@panik_fi), no matter the code state.\n2. **Trial code** - scanning lands on `/try?code=...`; clicking **Try Now** redeems a\n   usage-limited campaign code and mints the visitor a **unique, expiring access link**\n   into the core app (`panik.fi/app?trial=PANIK-XXXX`).\n\nConfirmed decisions from the user:\n- **Redeem outcome:** each successful redemption issues a *unique per-user* access link\n  into `/app`; that link expires per user.\n- **Trial clock basis:** the per-user expiry starts **when the user first opens the app**\n  with their link (not at card creation, not at redeem time).\n- **Admin:** a hidden, secret-gated **admin web page** to create campaigns, watch live\n  status, download the QR, and expire campaigns early.\n\nExploration established there is **no existing \"Kira\" feature** - \"Kira-style\" describes\nthe desired pattern. This is greenfield, built to match the repo's existing conventions:\nthe hidden `panik-founding` page is the structural template; the `telegram_link_codes` +\n`waitlist_signup` (SECURITY DEFINER, deny-all RLS) is the data template; `api/telegram/link.ts`\n+ `server/telegramStore.ts` is the endpoint template.\n\n**Stack (fixed):** React 19 + Vite 6 multi-page build + TypeScript + Tailwind v4;\nSupabase Postgres via PostgREST (no Edge Functions); `api/*` Vercel functions mirrored by\n`scripts/api-server.ts` Express routes; secrets stay server-side.\n\n---\n\n## Data model - new migration `supabase/migrations/20260704000001_product_codes.sql`\n\nIdempotent, additive, deny-all RLS, `set_updated_at()` trigger, `check` constraints,\npg_cron cleanup - modeled exactly on `20260627000001_telegram_alerts.sql`.\n\n**`public.product_campaigns`** - one row per card/QR batch (admin-created):\n- `id uuid pk default gen_random_uuid()`\n- `campaign_code text unique` - printed short code, `check (campaign_code ~ '^PANIK-TRY-[A-Z0-9]{4,8}$')`\n- `label text` - admin note\n- `max_redemptions int not null check (max_redemptions > 0)` - usage limit (max unique users)\n- `redemption_count int not null default 0`\n- `trial_duration_hours int not null check (trial_duration_hours > 0)` - per-user trial length once app opened\n- `claim_window_expires_at timestamptz` - optional cutoff for *claiming* the code (null = none)\n- `is_active boolean not null default true` - manual kill switch\n- `created_at / updated_at timestamptz` (+ updated trigger)\n- Derived status (computed in SQL/TS, not stored): `active | exhausted | expired | disabled`.\n\n**`public.trial_grants`** - one row per successful redemption (per-user unique link):\n- `id uuid pk`, `campaign_id uuid references product_campaigns(id)`\n- `access_token text unique` - the `PANIK-XXXXXX` in the app link, `check` format\n- `first_opened_at timestamptz` (null until first `/app` open) - **starts the clock**\n- `expires_at timestamptz` (null until first open; set = `first_opened_at + trial_duration_hours`)\n- `claim_ip text`, `claim_user_agent text`, `created_at`\n\n**`public.redemption_attempts`** - log **every** Try-Now attempt (success or fail):\n- `id bigint identity`, `campaign_code text`, `outcome text check (outcome in ('success','not_found','disabled','expired','exhausted'))`,\n  `ip text`, `user_agent text`, `granted_token_id uuid`, `created_at`.\n\n**SECURITY DEFINER functions** (granted to `anon`, mirroring `register_watched_wallet`):\n- `redeem_campaign_code(p_code, p_ip, p_ua)` \u2192 logs an attempt, then **atomically**\n  `UPDATE product_campaigns SET redemption_count = redemption_count + 1\n   WHERE id = ... AND is_active AND redemption_count < max_redemptions\n   AND (claim_window_expires_at IS NULL OR now() < claim_window_expires_at) RETURNING` -\n  the guarded UPDATE prevents an over-limit race. On success mints a `trial_grants` row and\n  returns `{outcome:'success', token}`; otherwise returns the failure `outcome`.\n- `open_trial(p_token, p_ip, p_ua)` \u2192 resolves a grant; if `first_opened_at IS NULL` sets it\n  and computes `expires_at` (**clock starts here**); returns `{outcome:'active'|'expired'|'invalid', expires_at}`.\n- pg_cron job `panik_trial_grants_cleanup` deletes long-expired grants (mirrors the telegram cleanup).\n\n---\n\n## Backend endpoints (capture IP/UA + hold secret key; Express-mirrored)\n\nFollow the `api/telegram/link.ts` + `server/telegramStore.ts` template. New\n`server/campaignStore.ts` (PostgREST + `SUPABASE_SECRET_KEY`, modeled on `server/telegramStore.ts`)\ncalls the RPCs; each `api/*` handler is mirrored as an Express route in `scripts/api-server.ts`.\n\n- `api/try/redeem.ts` - `POST {code, honeypot}`; reads client IP from headers \u2192 `redeem_campaign_code`\n  \u2192 returns `{outcome, trialUrl}` where `trialUrl = /app?trial=<token>` on success. Honeypot check first (silent success), like `waitlist_signup`.\n- `api/try/access.ts` - `POST {token}` from the core app on load \u2192 `open_trial` \u2192 `{outcome, expiresAt}`.\n- `api/admin/campaigns.ts` - `GET` (list + live status), `POST` (create), `POST ?action=expire`.\n  Guarded by an `x-admin-key` header checked against `ADMIN_ACCESS_KEY` env, exactly like the\n  Telegram webhook secret check in `scripts/api-server.ts` (`x-telegram-bot-api-secret-token`).\n\n---\n\n## Frontend - three surfaces\n\n**1. New `/try` page** (`src/panik-try/`, entry `try.html`) - structural clone of `panik-founding`\n(`main.tsx` shape, `noindex` HTML, `.panik-glass` cards, dark/orange styling from `src/index.css`).\n- On load: `const code = new URLSearchParams(window.location.search).get('code')` (the first\n  incoming-param read in the app - none exists today).\n- **Business card block always rendered** (all states): website `panik.fi`, X `@panik_fi`\n  (`https://x.com/panik_fi`) - from a hardcoded `src/panik-try/businessCard.ts` constant\n  (matches how landing/founding hardcode copy; no config store exists).\n- **Try Now**: if `code` present \u2192 one-tap `POST /api/try/redeem`. If absent \u2192 button reveals\n  a manual \"Enter your code\" input (the printed fallback), then same redeem call.\n- Result states in place of the redeem UI (card stays visible): **success** \u2192 show the unique\n  `/app?trial=...` link (copyable + auto-continue button); **expired/exhausted/not_found** \u2192\n  clear \"this code is no longer valid\" message.\n\n**2. New `/admin` page** (`src/panik-admin/`, entry `admin.html`, `noindex`) - secret-gated.\n- Prompts for the admin key (kept in `sessionStorage`, sent as `x-admin-key`).\n- Create campaign form: label, duration (days), max redemptions \u2192 `POST /api/admin/campaigns`.\n- Campaigns table with live status: code, used/max, time remaining, status badge, **Expire** button.\n- Per campaign: renders the QR via the new `qrcode` dependency (`QRCode.toDataURL(tryUrl)`),\n  shows `/try?code=...` + the short code, and a **Download QR (PNG)** button for printing.\n\n**3. Core app trial-awareness** (`src/panik-core`) - minimal, in `main.tsx`/`AppDemo.tsx`:\n- On load read `?trial=<token>`; if present `POST /api/try/access` and show a trial banner\n  (\"Trial active - expires in Xh\" / \"Trial expired\" with a CTA back to `/try`).\n- Keep the existing demo accessible; **hard-locking `/app` for non-trial visitors is out of\n  scope** for this MVP (flag as a one-line follow-up toggle if wanted).\n\n**Wiring:**\n- `vite.config.ts`: add `try` + `admin` to `build.rollupOptions.input`; add dev rewrites\n  `/try \u2192 /try.html`, `/admin \u2192 /admin.html` (query strings preserved, like the `/app` branch).\n- `vercel.json`: add the two clean-URL rewrites alongside the existing three.\n- Add favicon `<link>` block + `noindex` meta to both new HTML files (copy `founding.html`).\n- `.env.example`: add `ADMIN_ACCESS_KEY` (+ document it needs `SUPABASE_SECRET_KEY`, already present).\n\n---\n\n## Code generation\n\n- **Campaign code:** `PANIK-TRY-XXXX` (4 chars from an unambiguous alphabet, no I/O/0/1),\n  generated in `campaignStore` with a uniqueness retry on the unique constraint.\n- **Access token:** `PANIK-XXXXXX` (6 chars, same alphabet) minted inside `redeem_campaign_code`.\n- **QR:** new `qrcode` npm dependency, rendered client-side in the admin page. (URL uses a\n  `?trial=` query param for the app link; if the literal `panik.fi/app-PANIK-...` path form is\n  required instead, that's a small extra Vite/Vercel rewrite - confirm during build.)\n\n---\n\n## Tests (`vitest` - new devDependency; add `\"test\": \"vitest run\"`)\n\nCore decision logic is extracted into a pure, testable module\n`src/panik-try/lib/trialLogic.ts` (mirrored by the SQL) so we can unit-test without a DB:\n- `evaluateCampaign(campaign, now)` \u2192 `active|exhausted|expired|disabled` - **count limit** and\n  **time limit** cases.\n- `computeTrialExpiry(firstOpenedAt, durationHours)` and `evaluateTrialAccess(grant, now)` \u2192\n  first-open sets clock; before-expiry `active`; after-expiry `expired`; unknown token `invalid`.\n- `parseCode(searchString)` \u2192 covers **scan path** (`?code=ABC`) and **manual fallback** (empty\n  \u2192 prompts input).\n- The atomic over-limit guard lives in SQL; note it in the test file and verify manually per below.\n\n---\n\n## Verification (end-to-end)\n\n1. `npm run lint` (tsc) and `npm run test` (vitest) pass.\n2. Apply `20260704000001_product_codes.sql` in the Supabase SQL editor (idempotent; re-run safe);\n   `npm run db:verify` still passes.\n3. `npm run dev` + `npm run dev:api`. Open `/admin`, enter `ADMIN_ACCESS_KEY`, create a campaign\n   (e.g. 3 days / 2 uses). Confirm QR + short code render and the QR downloads.\n4. **Scan path:** open `/try?code=<code>` \u2192 business card visible, Try Now one-tap \u2192 success\n   returns a unique `/app?trial=<token>` link. Open it \u2192 app shows \"Trial active\"; DB\n   `trial_grants.first_opened_at`/`expires_at` now set (clock started on open).\n5. **Manual path:** open `/try` (no param) \u2192 Try Now reveals the input \u2192 type the printed code \u2192\n   same success.\n6. **Limits:** redeem until `redemption_count == max_redemptions` \u2192 next Try Now shows\n   \"no longer valid\" (exhausted) while the business card stays visible. Set a campaign's\n   `claim_window_expires_at` in the past (or Expire it in admin) \u2192 Try Now shows expired/disabled.\n   Confirm every attempt (success and fail) appears in `redemption_attempts` with IP + timestamp.\n7. **Per-user expiry:** temporarily set a short `trial_duration_hours`, open the app link, wait\n   past expiry, reload \u2192 app shows \"Trial expired\".\n",
  "planFilePath": "C:\\Users\\ASUS\\.claude\\plans\\feature-kira-style-2-in-1-business-purrfect-spindle.md"
}
```


### 👤 User *(2026-07-04 15:55:30)*

**Tool Result (✅ Success - ID: `toolu_01UsqA3Z7sCHXjPkKqu8ANve`):**
```
User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: C:\Users\ASUS\.claude\plans\feature-kira-style-2-in-1-business-purrfect-spindle.md
You can refer back to it if needed during implementation.

## Approved Plan (edited by user):
# Kira-style 2-in-1 Business Card + Time-Limited Trial Code

## Context

We want a physical business card that does two jobs from one QR + short code:
1. **Business card** - always shows panik.fi + X (@panik_fi), no matter the code state.
2. **Trial code** - scanning lands on `/try?code=...`; clicking **Try Now** redeems a
   usage-limited campaign code and mints the visitor a **unique, expiring access link**
   into the core app (`panik.fi/app?trial=PANIK-XXXX`).

Confirmed decisions from the user:
- **Redeem outcome:** each successful redemption issues a *unique per-user* access link
  into `/app`; that link expires per user.
- **Trial clock basis:** the per-user expiry starts **when the user first opens the app**
  with their link (not at card creation, not at redeem time).
- **Admin:** a hidden, secret-gated **admin web page** to create campaigns, watch live
  status, download the QR, and expire campaigns early.

Exploration established there is **no existing "Kira" feature** - "Kira-style" describes
the desired pattern. This is greenfield, built to match the repo's existing conventions:
the hidden `panik-founding` page is the structural template; the `telegram_link_codes` +
`waitlist_signup` (SECURITY DEFINER, deny-all RLS) is the data template; `api/telegram/link.ts`
+ `server/telegramStore.ts` is the endpoint template.

**Stack (fixed):** React 19 + Vite 6 multi-page build + TypeScript + Tailwind v4;
Supabase Postgres via PostgREST (no Edge Functions); `api/*` Vercel functions mirrored by
`scripts/api-server.ts` Express routes; secrets stay server-side.

---

## Data model - new migration `supabase/migrations/20260704000001_product_codes.sql`

Idempotent, additive, deny-all RLS, `set_updated_at()` trigger, `check` constraints,
pg_cron cleanup - modeled exactly on `20260627000001_telegram_alerts.sql`.

**`public.product_campaigns`** - one row per card/QR batch (admin-created):
- `id uuid pk default gen_random_uuid()`
- `campaign_code text unique` - printed short code, `check (campaign_code ~ '^PANIK-TRY-[A-Z0-9]{4,8}$')`
- `label text` - admin note
- `max_redemptions int not null check (max_redemptions > 0)` - usage limit (max unique users)
- `redemption_count int not null default 0`
- `trial_duration_hours int not null check (trial_duration_hours > 0)` - per-user trial length once app opened
- `claim_window_expires_at timestamptz` - optional cutoff for *claiming* the code (null = none)
- `is_active boolean not null default true` - manual kill switch
- `created_at / updated_at timestamptz` (+ updated trigger)
- Derived status (computed in SQL/TS, not stored): `active | exhausted | expired | disabled`.

**`public.trial_grants`** - one row per successful redemption (per-user unique link):
- `id uuid pk`, `campaign_id uuid references product_campaigns(id)`
- `access_token text unique` - the `PANIK-XXXXXX` in the app link, `check` format
- `first_opened_at timestamptz` (null until first `/app` open) - **starts the clock**
- `expires_at timestamptz` (null until first open; set = `first_opened_at + trial_duration_hours`)
- `claim_ip text`, `claim_user_agent text`, `created_at`

**`public.redemption_attempts`** - log **every** Try-Now attempt (success or fail):
- `id bigint identity`, `campaign_code text`, `outcome text check (outcome in ('success','not_found','disabled','expired','exhausted'))`,
  `ip text`, `user_agent text`, `granted_token_id uuid`, `created_at`.

**SECURITY DEFINER functions** (granted to `anon`, mirroring `register_watched_wallet`):
- `redeem_campaign_code(p_code, p_ip, p_ua)` → logs an attempt, then **atomically**
  `UPDATE product_campaigns SET redemption_count = redemption_count + 1
   WHERE id = ... AND is_active AND redemption_count < max_redemptions
   AND (claim_window_expires_at IS NULL OR now() < claim_window_expires_at) RETURNING` -
  the guarded UPDATE prevents an over-limit race. On success mints a `trial_grants` row and
  returns `{outcome:'success', token}`; otherwise returns the failure `outcome`.
- `open_trial(p_token, p_ip, p_ua)` → resolves a grant; if `first_opened_at IS NULL` sets it
  and computes `expires_at` (**clock starts here**); returns `{outcome:'active'|'expired'|'invalid', expires_at}`.
- pg_cron job `panik_trial_grants_cleanup` deletes long-expired grants (mirrors the telegram cleanup).

---

## Backend endpoints (capture IP/UA + hold secret key; Express-mirrored)

Follow the `api/telegram/link.ts` + `server/telegramStore.ts` template. New
`server/campaignStore.ts` (PostgREST + `SUPABASE_SECRET_KEY`, modeled on `server/telegramStore.ts`)
calls the RPCs; each `api/*` handler is mirrored as an Express route in `scripts/api-server.ts`.

- `api/try/redeem.ts` - `POST {code, honeypot}`; reads client IP from headers → `redeem_campaign_code`
  → returns `{outcome, trialUrl}` where `trialUrl = /app?trial=<token>` on success. Honeypot check first (silent success), like `waitlist_signup`.
- `api/try/access.ts` - `POST {token}` from the core app on load → `open_trial` → `{outcome, expiresAt}`.
- `api/admin/campaigns.ts` - `GET` (list + live status), `POST` (create), `POST ?action=expire`.
  Guarded by an `x-admin-key` header checked against `ADMIN_ACCESS_KEY` env, exactly like the
  Telegram webhook secret check in `scripts/api-server.ts` (`x-telegram-bot-api-secret-token`).

---

## Frontend - three surfaces

**1. New `/try` page** (`src/panik-try/`, entry `try.html`) - structural clone of `panik-founding`
(`main.tsx` shape, `noindex` HTML, `.panik-glass` cards, dark/orange styling from `src/index.css`).
- On load: `const code = new URLSearchParams(window.location.search).get('code')` (the first
  incoming-param read in the app - none exists today).
- **Business card block always rendered** (all states): website `panik.fi`, X `@panik_fi`
  (`https://x.com/panik_fi`) - from a hardcoded `src/panik-try/businessCard.ts` constant
  (matches how landing/founding hardcode copy; no config store exists).
- **Try Now**: if `code` present → one-tap `POST /api/try/redeem`. If absent → button reveals
  a manual "Enter your code" input (the printed fallback), then same redeem call.
- Result states in place of the redeem UI (card stays visible): **success** → show the unique
  `/app?trial=...` link (copyable + auto-continue button); **expired/exhausted/not_found** →
  clear "this code is no longer valid" message.

**2. New `/admin` page** (`src/panik-admin/`, entry `admin.html`, `noindex`) - secret-gated.
- Prompts for the admin key (kept in `sessionStorage`, sent as `x-admin-key`).
- Create campaign form: label, duration (days), max redemptions → `POST /api/admin/campaigns`.
- Campaigns table with live status: code, used/max, time remaining, status badge, **Expire** button.
- Per campaign: renders the QR via the new `qrcode` dependency (`QRCode.toDataURL(tryUrl)`),
  shows `/try?code=...` + the short code, and a **Download QR (PNG)** button for printing.

**3. Core app trial-awareness** (`src/panik-core`) - minimal, in `main.tsx`/`AppDemo.tsx`:
- On load read `?trial=<token>`; if present `POST /api/try/access` and show a trial banner
  ("Trial active - expires in Xh" / "Trial expired" with a CTA back to `/try`).
- Keep the existing demo accessible; **hard-locking `/app` for non-trial visitors is out of
  scope** for this MVP (flag as a one-line follow-up toggle if wanted).

**Wiring:**
- `vite.config.ts`: add `try` + `admin` to `build.rollupOptions.input`; add dev rewrites
  `/try → /try.html`, `/admin → /admin.html` (query strings preserved, like the `/app` branch).
- `vercel.json`: add the two clean-URL rewrites alongside the existing three.
- Add favicon `<link>` block + `noindex` meta to both new HTML files (copy `founding.html`).
- `.env.example`: add `ADMIN_ACCESS_KEY` (+ document it needs `SUPABASE_SECRET_KEY`, already present).

---

## Code generation

- **Campaign code:** `PANIK-TRY-XXXX` (4 chars from an unambiguous alphabet, no I/O/0/1),
  generated in `campaignStore` with a uniqueness retry on the unique constraint.
- **Access token:** `PANIK-XXXXXX` (6 chars, same alphabet) minted inside `redeem_campaign_code`.
- **QR:** new `qrcode` npm dependency, rendered client-side in the admin page. (URL uses a
  `?trial=` query param for the app link; if the literal `panik.fi/app-PANIK-...` path form is
  required instead, that's a small extra Vite/Vercel rewrite - confirm during build.)

---

## Tests (`vitest` - new devDependency; add `"test": "vitest run"`)

Core decision logic is extracted into a pure, testable module
`src/panik-try/lib/trialLogic.ts` (mirrored by the SQL) so we can unit-test without a DB:
- `evaluateCampaign(campaign, now)` → `active|exhausted|expired|disabled` - **count limit** and
  **time limit** cases.
- `computeTrialExpiry(firstOpenedAt, durationHours)` and `evaluateTrialAccess(grant, now)` →
  first-open sets clock; before-expiry `active`; after-expiry `expired`; unknown token `invalid`.
- `parseCode(searchString)` → covers **scan path** (`?code=ABC`) and **manual fallback** (empty
  → prompts input).
- The atomic over-limit guard lives in SQL; note it in the test file and verify manually per below.

---

## Verification (end-to-end)

1. `npm run lint` (tsc) and `npm run test` (vitest) pass.
2. Apply `20260704000001_product_codes.sql` in the Supabase SQL editor (idempotent; re-run safe);
   `npm run db:verify` still passes.
3. `npm run dev` + `npm run dev:api`. Open `/admin`, enter `ADMIN_ACCESS_KEY`, create a campaign
   (e.g. 3 days / 2 uses). Confirm QR + short code render and the QR downloads.
4. **Scan path:** open `/try?code=<code>` → business card visible, Try Now one-tap → success
   returns a unique `/app?trial=<token>` link. Open it → app shows "Trial active"; DB
   `trial_grants.first_opened_at`/`expires_at` now set (clock started on open).
5. **Manual path:** open `/try` (no param) → Try Now reveals the input → type the printed code →
   same success.
6. **Limits:** redeem until `redemption_count == max_redemptions` → next Try Now shows
   "no longer valid" (exhausted) while the business card stays visible. Set a campaign's
   `claim_window_expires_at` in the past (or Expire it in admin) → Try Now shows expired/disabled.
   Confirm every attempt (success and fail) appears in `redemption_attempts` with IP + timestamp.
7. **Per-user expiry:** temporarily set a short `trial_duration_hours`, open the app link, wait
   past expiry, reload → app shows "Trial expired".

```


### 🤖 Claude *(2026-07-04 15:55:35)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:55:35)*

Plan approved. Let me set up a todo list and read the remaining reference files I'll be mirroring.


### 🤖 Claude *(2026-07-04 15:55:36)*

**🛠️ Tool Call:** `ToolSearch` (ID: `toolu_01NKBpcuH7CDVKUiE1kjAp5e`)
```json
{
  "query": "select:TodoWrite",
  "max_results": 1
}
```


### 👤 User *(2026-07-04 15:55:36)*

**Tool Result (✅ Success - ID: `toolu_01NKBpcuH7CDVKUiE1kjAp5e`):**
```
[{'type': 'tool_reference', 'tool_name': 'TodoWrite'}]
```


### 🤖 Claude *(2026-07-04 15:55:45)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_01VJDiKgwVsfmvYhZQweUgyq`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "pending",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "pending",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "pending",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "pending",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "pending",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "pending",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "pending",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "pending",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "pending",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "pending",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 15:55:45)*

**Tool Result (✅ Success - ID: `toolu_01VJDiKgwVsfmvYhZQweUgyq`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 15:55:47)*

I'll read the reference files I'll be mirroring, in parallel.


### 🤖 Claude *(2026-07-04 15:55:48)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01DDJD3SCRWamdSsNcUw3nof`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\server\\telegramStore.ts"
}
```


### 👤 User *(2026-07-04 15:55:48)*

**Tool Result (✅ Success - ID: `toolu_01DDJD3SCRWamdSsNcUw3nof`):**
```
1	/**
2	 * Telegram link store over the Supabase PostgREST API. Pure fetch with the
3	 * service key (bypasses the deny-all RLS on telegram_links / telegram_link_codes),
4	 * mirroring server/profileCache.ts. No `pg`, so it bundles cleanly as an
5	 * ESM Vercel serverless function. Tables: see supabase/migrations.
6	 *
7	 * Used by the Vercel functions (api/telegram/link.ts, api/telegram/webhook.ts).
8	 * The standalone worker reads the same tables via direct pg instead.
9	 */
10	
11	export interface LinkCode {
12	  wallet: string;
13	  expiresAt: number; // epoch ms
14	}
15	
16	export class TelegramStore {
17	  private readonly base: string;
18	
19	  constructor(
20	    supabaseUrl: string,
21	    private readonly serviceKey: string,
22	  ) {
23	    this.base = supabaseUrl.replace(/\/+$/, "");
24	  }
25	
26	  /** Build from env; throws if unconfigured (caller maps to 503). */
27	  static fromEnv(): TelegramStore {
28	    const url = process.env.SUPABASE_URL;
29	    const key = process.env.SUPABASE_SECRET_KEY;
30	    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
31	    return new TelegramStore(url, key);
32	  }
33	
34	  private headers(extra?: Record<string, string>): Record<string, string> {
35	    return {
36	      apikey: this.serviceKey,
37	      Authorization: `Bearer ${this.serviceKey}`,
38	      "Content-Type": "application/json",
39	      ...extra,
40	    };
41	  }
42	
43	  // ── link codes ────────────────────────────────────────────────────────────
44	
45	  /** Mint a single-use deep-link code with a TTL. */
46	  async createLinkCode(code: string, wallet: string, ttlMs: number): Promise<void> {
47	    const expires = new Date(Date.now() + ttlMs).toISOString();
48	    const res = await fetch(`${this.base}/rest/v1/telegram_link_codes`, {
49	      method: "POST",
50	      headers: this.headers({ Prefer: "return=minimal" }),
51	      body: JSON.stringify({ code, wallet: wallet.toLowerCase(), expires_at: expires }),
52	    });
53	    if (!res.ok) throw new Error(`createLinkCode: HTTP ${res.status}`);
54	  }
55	
56	  /** Resolve a code to its wallet (or null if missing). Does not check TTL. */
57	  async getLinkCode(code: string): Promise<LinkCode | null> {
58	    const url =
59	      `${this.base}/rest/v1/telegram_link_codes` +
60	      `?code=eq.${encodeURIComponent(code)}&select=wallet,expires_at&limit=1`;
61	    const res = await fetch(url, { headers: this.headers() });
62	    if (!res.ok) throw new Error(`getLinkCode: HTTP ${res.status}`);
63	    const rows = (await res.json()) as { wallet: string; expires_at: string }[];
64	    const row = rows[0];
65	    if (!row) return null;
66	    return { wallet: row.wallet, expiresAt: new Date(row.expires_at).getTime() };
67	  }
68	
69	  /** Delete a consumed code (single-use). */
70	  async consumeLinkCode(code: string): Promise<void> {
71	    await fetch(
72	      `${this.base}/rest/v1/telegram_link_codes?code=eq.${encodeURIComponent(code)}`,
73	      { method: "DELETE", headers: this.headers({ Prefer: "return=minimal" }) },
74	    );
75	  }
76	
77	  // ── links ───────────────────────────────────────────────────────────────
78	
79	  /**
80	   * Link a wallet to a chat. Because chat_id is unique, first drop any prior
81	   * row for that chat (the user re-linking the same Telegram to a new wallet),
82	   * then upsert on the wallet PK.
83	   */
84	  async upsertLink(args: { wallet: string; chatId: number; username?: string }): Promise<void> {
85	    await fetch(
86	      `${this.base}/rest/v1/telegram_links?chat_id=eq.${args.chatId}`,
87	      { method: "DELETE", headers: this.headers({ Prefer: "return=minimal" }) },
88	    );
89	    const res = await fetch(`${this.base}/rest/v1/telegram_links`, {
90	      method: "POST",
91	      headers: this.headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
92	      body: JSON.stringify({
93	        wallet: args.wallet.toLowerCase(),
94	        chat_id: args.chatId,
95	        username: args.username ?? null,
96	        enabled: true,
97	        updated_at: new Date().toISOString(),
98	      }),
99	    });
100	    if (!res.ok) throw new Error(`upsertLink: HTTP ${res.status}`);
101	  }
102	
103	  /** Current link for a wallet (drives the connect status check), or null. */
104	  async getLink(
105	    wallet: string,
106	  ): Promise<{ chatId: number; username: string | null; enabled: boolean } | null> {
107	    const url =
108	      `${this.base}/rest/v1/telegram_links` +
109	      `?wallet=eq.${wallet.toLowerCase()}&select=chat_id,username,enabled&limit=1`;
110	    const res = await fetch(url, { headers: this.headers() });
111	    if (!res.ok) throw new Error(`getLink: HTTP ${res.status}`);
112	    const rows = (await res.json()) as { chat_id: number; username: string | null; enabled: boolean }[];
113	    const row = rows[0];
114	    return row ? { chatId: row.chat_id, username: row.username, enabled: row.enabled } : null;
115	  }
116	
117	  /** Disable alerts for a chat (the /stop command). */
118	  async disableLink(chatId: number): Promise<void> {
119	    await fetch(`${this.base}/rest/v1/telegram_links?chat_id=eq.${chatId}`, {
120	      method: "PATCH",
121	      headers: this.headers({ Prefer: "return=minimal" }),
122	      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
123	    });
124	  }
125	}
126	
```


### 🤖 Claude *(2026-07-04 15:55:49)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01X1j8t1oRyBLrnenv9RTNGU`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\server\\profileDeps.ts"
}
```


### 👤 User *(2026-07-04 15:55:49)*

**Tool Result (✅ Success - ID: `toolu_01X1j8t1oRyBLrnenv9RTNGU`):**
```
1	/**
2	 * Lazily-built, module-scoped profiler dependencies shared by the dev Express
3	 * server and the Vercel serverless functions. Singletons survive warm
4	 * invocations so a Vercel function reuses one pg pool / provider set.
5	 *
6	 * Lives in server/ (NOT scripts/) so it ships to Vercel — the api/ functions
7	 * import it. scripts/ is excluded by .vercelignore.
8	 */
9	
10	// Import specific modules, NOT the barrel (../packages/scoring/src/index): the
11	// barrel re-exports the chain adapters → viem → isows → "ws", an optional dep
12	// esbuild can't resolve, which crashes the Vercel function at load. The cache
13	// uses Supabase REST (fetch), not `pg`, for the same bundling reason.
14	import { DuneHistoryProvider } from "../packages/scoring/src/providers/duneHistory";
15	import { OpenRouterNarrator } from "../packages/scoring/src/providers/narrator";
16	import type { SessionDeps } from "../packages/scoring/src/classify/profileSession";
17	import { RestProfileCache } from "./profileCache";
18	
19	let deps: SessionDeps | null = null;
20	
21	/**
22	 * Build (once) the SessionDeps from env. Throws if a required key is missing —
23	 * the caller maps that to a 503. OPENROUTER_API_KEY is optional (deterministic
24	 * fallback prose is used without it). The cache uses the Supabase REST API with
25	 * the service key (bypasses RLS) — no pg, so it bundles cleanly on Vercel.
26	 */
27	export function getProfileDeps(): SessionDeps {
28	  if (deps) return deps;
29	
30	  const duneKey = process.env.DUNE_API_KEY;
31	  const supabaseUrl = process.env.SUPABASE_URL;
32	  const serviceKey = process.env.SUPABASE_SECRET_KEY;
33	  const openRouterKey = process.env.OPENROUTER_API_KEY;
34	  if (!duneKey) throw new Error("DUNE_API_KEY missing");
35	  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
36	
37	  deps = {
38	    history: new DuneHistoryProvider(duneKey),
39	    cache: new RestProfileCache(supabaseUrl, serviceKey),
40	    narrator: openRouterKey ? new OpenRouterNarrator(openRouterKey) : undefined,
41	  };
42	  return deps;
43	}
44	
45	/**
46	 * Supabase TRANSACTION pooler URL (6543) for the dev api-server's own pg pool
47	 * (the watched_wallets / live-scores loop) — the session pooler (5432) resets
48	 * from some networks. Pure string logic; no pg import here so the serverless
49	 * bundle stays pg-free.
50	 */
51	export function transactionPoolerUrl(): string {
52	  const explicit = process.env.SUPABASE_DB_POOL_URL;
53	  if (explicit) return explicit;
54	  const base = process.env.SUPABASE_DB_URL as string;
55	  try {
56	    const u = new URL(base);
57	    if (u.port === "5432") u.port = "6543";
58	    return u.toString();
59	  } catch {
60	    return base;
61	  }
62	}
63	
64	/** Validate an EVM address (the only addresses the lending spells cover). */
65	export function isEvmAddress(wallet: unknown): wallet is string {
66	  return typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(wallet.trim());
67	}
68	
```


### 🤖 Claude *(2026-07-04 15:55:50)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01N49XcdWx3f7eLCTspzpyQ6`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-founding\\main.tsx"
}
```


### 👤 User *(2026-07-04 15:55:50)*

**Tool Result (✅ Success - ID: `toolu_01N49XcdWx3f7eLCTspzpyQ6`):**
```
1	/**
2	 * @license
3	 * SPDX-License-Identifier: Apache-2.0
4	 */
5	
6	import React from "react";
7	import ReactDOM from "react-dom/client";
8	import App from "./App";
9	import "../index.css";
10	
11	ReactDOM.createRoot(document.getElementById("root")!).render(
12	  <React.StrictMode>
13	    <App />
14	  </React.StrictMode>
15	);
16	
```


### 🤖 Claude *(2026-07-04 15:55:50)*

**🛠️ Tool Call:** `Read` (ID: `toolu_016wSpMwKswfkK4J7bQVmGfP`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core\\main.tsx"
}
```


### 👤 User *(2026-07-04 15:55:50)*

**Tool Result (✅ Success - ID: `toolu_016wSpMwKswfkK4J7bQVmGfP`):**
```
1	/**
2	 * @license
3	 * SPDX-License-Identifier: Apache-2.0
4	 */
5	
6	import { StrictMode } from "react";
7	import { createRoot } from "react-dom/client";
8	import { AppProviders } from "./providers/AppProviders";
9	import { AppDemo } from "./AppDemo";
10	import "../index.css";
11	
12	createRoot(document.getElementById("root")!).render(
13	  <StrictMode>
14	    <AppProviders>
15	      <AppDemo />
16	    </AppProviders>
17	  </StrictMode>,
18	);
19	
```


### 🤖 Claude *(2026-07-04 15:55:51)*

**🛠️ Tool Call:** `Read` (ID: `toolu_013oJM7nhRY1RVzvHGeAVgYm`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vercel.json"
}
```


### 👤 User *(2026-07-04 15:55:51)*

**Tool Result (✅ Success - ID: `toolu_013oJM7nhRY1RVzvHGeAVgYm`):**
```
1	{
2	  "$schema": "https://openapi.vercel.sh/vercel.json",
3	  "framework": "vite",
4	  "buildCommand": "vite build",
5	  "outputDirectory": "dist",
6	  "cleanUrls": true,
7	  "trailingSlash": false,
8	  "rewrites": [
9	    { "source": "/api/:path*", "destination": "https://panikrisk-scoring-production.up.railway.app/api/:path*" },
10	    { "source": "/app", "destination": "/app.html" },
11	    { "source": "/founding", "destination": "/founding.html" },
12	    { "source": "/early-access", "destination": "/founding.html" }
13	  ]
14	}
15	
```


### 🤖 Claude *(2026-07-04 15:55:51)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01MxCigA6iuHXvbBrXrFMQvt`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\.env.example"
}
```


### 👤 User *(2026-07-04 15:55:51)*

**Tool Result (✅ Success - ID: `toolu_01MxCigA6iuHXvbBrXrFMQvt`):**
```
1	# PANIK environment template — copy to .env and fill in.
2	# .env is gitignored; NEVER commit real keys.
3	#
4	# IMPORTANT: only VITE_-prefixed vars are exposed to the frontend bundle.
5	# Everything else is backend-only. Do not add secrets with a VITE_ prefix.
6	
7	# ── Slice 1 (scoring engine) ────────────────────────────────────────────
8	# CoinGecko Demo plan key (free, 30 calls/min) — asset risk price history
9	# Get: coingecko.com → API → Demo plan signup
10	COINGECKO_API_KEY=
11	
12	# Dune API key (free tier) — week-1 calibration data pulls, analytics only.
13	# ALSO powers the wallet DeFi-persona profiler (/api/profile): lifetime
14	# cross-chain lending history via saved query 7771860. See
15	# docs/technical-docs/WALLET_PROFILER.md.
16	# Get: dune.com → Settings → API
17	DUNE_API_KEY=
18	
19	# OpenRouter key — AI narration for the persona profiler (model
20	# google/gemini-2.5-flash). OPTIONAL: if blank, /api/profile still works and
21	# returns deterministic fallback prose. Backend-only — never VITE_-prefix.
22	# Get: openrouter.ai → Keys
23	OPENROUTER_API_KEY=
24	
25	# ── Slice 2 (active mode + wallet) ──────────────────────────────────────
26	# Alchemy app keys (free tier) — Base mainnet reads + Base Sepolia testnet
27	# Get: alchemy.com → create app per network
28	ALCHEMY_API_KEY_BASE_MAINNET=
29	ALCHEMY_API_KEY_BASE_SEPOLIA=
30	
31	# WalletConnect / Reown Cloud project ID (free) — wagmi connect modal.
32	# Public by design, hence the VITE_ prefix.
33	# Get: cloud.reown.com → create project
34	VITE_WALLETCONNECT_PROJECT_ID=
35	
36	# DefiLlama: no key required. Chainlink: read on-chain via Alchemy RPC.
37	
38	# ── Supabase (data + auth layer — waitlist CRM, watch state, Mirror sink) ──
39	# Get all of these: supabase.com → your project → Project Settings.
40	#
41	# Frontend (public by design — RLS is the security boundary, not the key):
42	# Settings → API → Project URL + publishable key
43	# (older projects call it "anon" key; either works in these slots)
44	VITE_SUPABASE_URL=
45	VITE_SUPABASE_PUBLISHABLE_KEY=
46	
47	# Backend/worker only (SECRET — bypasses RLS; never VITE_-prefix, never
48	# ship to a browser). Settings → API → secret key ("service_role" on
49	# older projects). Used by the Watch worker + Edge Function admin tasks.
50	SUPABASE_URL=
51	SUPABASE_SECRET_KEY=
52	
53	# Postgres connection string (SECRET) — dashboard → Connect → use the
54	# ⚠ SESSION POOLER string (port 5432, host aws-X-[region].pooler.supabase.com,
55	# user postgres.[PROJECT-REF]). Why not the others:
56	#   - "Direct connection" (db.[ref].supabase.co) is IPv6-ONLY on new
57	#     projects → ENOTFOUND from IPv4-only networks (verified 2026-06-13)
58	#   - Transaction pooler (port 6543) breaks long-lived connections
59	# Session pooler = IPv4-compatible AND holds connections → works for both
60	# the Goldsky Mirror sink and the Watch worker. Same DB password.
61	# NOTE: the api-server AND the Watch worker call transactionPoolerUrl(), which
62	# auto-rewrites this string's port 5432 -> 6543 (the transaction pooler) because
63	# the session pooler times out from some networks. Paste the session-pooler
64	# string here; the rewrite is transparent. Set SUPABASE_DB_POOL_URL to override.
65	SUPABASE_DB_URL=
66	
67	# ── Goldsky (event indexing — Advisor "what happened" feed + reconciliation) ──
68	# Free Starter tier: 3 subgraph workers, 100k entities, 1 Mirror pipeline,
69	# 1M records/mo. Get: app.goldsky.com → create project → Settings → API keys.
70	# API key is used by the CLI (`goldsky login`) and pipeline/webhook config;
71	# the project ID scopes deployments. Backend-only — never VITE_-prefix these.
72	GOLDSKY_PROJECT_ID=
73	GOLDSKY_API_KEY=
74	
75	# ── Slice 3 (Telegram near-liquidation alerts) ─────────────────────────
76	# Bot token from @BotFather. BACKEND/WORKER ONLY - never VITE_-prefix.
77	# Used by the Watch worker (sends alerts) and the webhook (replies).
78	TELEGRAM_BOT_TOKEN=
79	# A random string you choose; passed to setWebhook as secret_token and checked
80	# on every incoming update (X-Telegram-Bot-Api-Secret-Token). Backend-only.
81	TELEGRAM_WEBHOOK_SECRET=
82	# Bot username (no @) for the deep-link t.me/<username>?start=<code>. Public by
83	# design (it is in the link), hence VITE_. Read by /api/telegram/link too.
84	VITE_TELEGRAM_BOT_USERNAME=
85	# Production base URL for the one-time `npm run telegram:setup` (setWebhook),
86	# e.g. https://panik.xyz. Not needed at runtime. Can be passed as a CLI arg.
87	TELEGRAM_PUBLIC_BASE_URL=
88	
89	# ── Founding User Escrow (hidden page — /founding) ─────────────────────
90	# Contract address on Base (deployed via `forge script` — see contracts/README.md).
91	# Public by design (readable on Basescan), hence the VITE_ prefix.
92	VITE_ESCROW_CONTRACT_ADDRESS=0xa69ed7807d5a5791bb31233d0cb275408337347b48cde76b05e80e7824eb2883
93	# Chain ID: 8453 (Base mainnet) or 84532 (Base Sepolia for testing).
94	VITE_ESCROW_CHAIN_ID=84532
```


### 🤖 Claude *(2026-07-04 15:56:09)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:56:10)*

Key insight from `vercel.json`: `/api/:path*` is rewritten to the **Railway Express server**, and the Vite dev proxy also sends `/api` to Express (`127.0.0.1:8787`). So **`scripts/api-server.ts` is the authoritative backend** for both dev and prod - the `api/*.ts` Vercel handlers are parity mirrors. I need to read the Express server structure.


### 🤖 Claude *(2026-07-04 15:56:11)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01MS45xcpjkkvwpt1PS7E5n8`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\scripts\\api-server.ts"
}
```


### 👤 User *(2026-07-04 15:56:11)*

**Tool Result (✅ Success - ID: `toolu_01MS45xcpjkkvwpt1PS7E5n8`):**
```
1	/**
2	 * PANIK — local scoring API (dev).
3	 * Run:  npm run dev:api   (then `npm run dev` and open /app.html)
4	 * Serves live scores to the panik-core UI. Keys stay server-side — the
5	 * browser only ever sees score JSON, mirroring the production worker split.
6	 *
7	 * Endpoints:
8	 *   GET /api/health
9	 *   GET /api/scores       live wallet positions (Supabase registry → chain)
10	 *   GET /api/compass      the 6 Compass preset scenarios, scored live
11	 *   GET /api/prospective  ?protocol&symbol&collateralUsd&borrowUsd (Watch sliders)
12	 *   GET /api/poolhistory  30d APY/TVL per Compass preset (DefiLlama, 1h cache)
13	 *   GET /api/history      ?wallet  alert feed + 30d score series (Portfolio)
14	 *   GET /api/profile      ?wallet  DeFi-persona prediction (Dune history → AI)
15	 *   GET /api/chain        real Base block number + gas price
16	 */
17	
18	import express from "express";
19	import pg from "pg";
20	import { createPublicClient, http } from "viem";
21	import { base } from "viem/chains";
22	import {
23	  AaveActiveReader,
24	  ActiveAdapter,
25	  CoinGeckoProvider,
26	  CompoundActiveReader,
27	  DefiLlamaProvider,
28	  MARKETS,
29	  MoonwellActiveReader,
30	  MorphoActiveReader,
31	  resolveProfileScan,
32	  scoreProspective,
33	  startProfileScan,
34	  statusFor,
35	  formatWelcome,
36	  type ActiveScore,
37	  type Protocol,
38	  type PublicClientLike,
39	  type RiskProfile,
40	  type StatedProfile,
41	} from "../packages/scoring/src/index";
42	import { getProfileDeps, isEvmAddress, transactionPoolerUrl } from "../server/profileDeps";
43	import { TelegramStore } from "../server/telegramStore";
44	import { sendMessage, setWebhook } from "../server/telegram";
45	import { randomUUID } from "node:crypto";
46	import path from "node:path";
47	
48	// Railway (and most PaaS) inject PORT; fall back to PANIK_API_PORT for local dev.
49	const PORT = Number(process.env.PORT ?? process.env.PANIK_API_PORT ?? 8787);
50	const cgKey = process.env.COINGECKO_API_KEY;
51	const alchemyKey = process.env.ALCHEMY_API_KEY_BASE_MAINNET;
52	const dbUrl = process.env.SUPABASE_DB_URL;
53	// Persona profiler keys are OPTIONAL — the rest of the API runs without them;
54	// /api/profile reports 503 if Dune is unconfigured, and narration falls back
55	// to deterministic prose if OpenRouter is absent.
56	// Profiler keys are read by getProfileDeps from env directly; we only need to
57	// know here whether to advertise the endpoints (DUNE + DB are the hard reqs).
58	const duneKey = process.env.DUNE_API_KEY;
59	if (!cgKey || !alchemyKey || !dbUrl) {
60	  console.error("Missing env (COINGECKO_API_KEY / ALCHEMY_API_KEY_BASE_MAINNET / SUPABASE_DB_URL)");
61	  process.exit(1);
62	}
63	
64	const rawClient = createPublicClient({
65	  chain: base,
66	  transport: http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`),
67	});
68	const chain = rawClient as unknown as PublicClientLike;
69	
70	const providers = {
71	  assetRisk: new CoinGeckoProvider(cgKey),
72	  systemic: new DefiLlamaProvider(),
73	};
74	
75	const adapter = new ActiveAdapter(
76	  [
77	    new AaveActiveReader(chain),
78	    new MoonwellActiveReader(chain),
79	    new CompoundActiveReader(chain),
80	    new MorphoActiveReader(), // official Morpho API (market discovery needs an index)
81	  ],
82	  providers,
83	  (err) => console.error(`reader failed (other protocols continue): ${(err as Error).message.slice(0, 120)}`),
84	);
85	
86	// Persona profiler (analytics tier — once-per-wallet, cached; NOT the live loop).
87	// Deps (Dune + Supabase cache + optional OpenRouter narrator) are built lazily
88	// by getProfileDeps from env, shared with the Vercel serverless functions.
89	const profilerConfigured = Boolean(
90	  duneKey && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
91	);
92	
93	const db = new pg.Pool({
94	  // Use the TRANSACTION pooler (6543), not the SESSION pooler (5432). The
95	  // session pooler resets/times out from some networks (the watched_wallets
96	  // "Connection terminated due to connection timeout" errors); 6543 connects
97	  // in ~1s. Same fix the profiler uses. Watch-loop queries are simple SELECTs,
98	  // so transaction-mode pooling is fine here.
99	  connectionString: transactionPoolerUrl(),
100	  ssl: { rejectUnauthorized: false },
101	  max: 2,
102	  connectionTimeoutMillis: 15_000,
103	  idleTimeoutMillis: 30_000,
104	  keepAlive: true,
105	});
106	
107	// pg.Pool emits 'error' on IDLE clients when the connection drops (e.g. the
108	// Supabase pooler resetting the TCP socket). With no listener, Node treats it as
109	// an unhandled error event and kills the whole process — this is the ECONNRESET
110	// death we kept hitting. Swallow + log so a dropped idle client self-heals.
111	db.on("error", (err) => console.error(`db pool error (recovered): ${err.message}`));
112	
113	// One retry: a single pooler reset on the first packet is common and harmless.
114	async function queryWatched() {
115	  let lastErr: unknown;
116	  for (let attempt = 1; attempt <= 2; attempt++) {
117	    try {
118	      const { rows } = await db.query<{ wallet: string; risk_profile: RiskProfile; label: string | null }>(
119	        "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
120	      );
121	      return rows;
122	    } catch (err) {
123	      lastErr = err;
124	      console.error(`watched_wallets query attempt ${attempt} failed: ${(err as Error).message.slice(0, 100)}`);
125	    }
126	  }
127	  throw lastErr;
128	}
129	
130	// ── live wallet scores (60s cache regardless of polling tabs) ─────────────
131	export interface LivePosition extends ActiveScore {
132	  label: string | null;
133	  riskProfile: RiskProfile;
134	  profileStatus: ReturnType<typeof statusFor>;
135	}
136	
137	let scoresCache: { at: number; positions: LivePosition[] } = { at: 0, positions: [] };
138	
139	async function getScores(): Promise<typeof scoresCache> {
140	  if (Date.now() - scoresCache.at < 60_000) return scoresCache;
141	
142	  let rows: { wallet: string; risk_profile: RiskProfile; label: string | null }[];
143	  try {
144	    rows = await queryWatched();
145	  } catch (err) {
146	    // DB unreachable — serve the last good cache (even if stale) rather than 500ing.
147	    if (scoresCache.positions.length) {
148	      console.error(`scores: DB unreachable, serving stale cache (${(err as Error).message.slice(0, 80)})`);
149	      return scoresCache;
150	    }
151	    throw err;
152	  }
153	
154	  const positions: LivePosition[] = [];
155	  for (const w of rows) {
156	    try {
157	      for (const s of await adapter.scoreWallet(w.wallet)) {
158	        positions.push({
159	          ...s,
160	          label: w.label,
161	          riskProfile: w.risk_profile,
162	          profileStatus: statusFor(w.risk_profile, s.total),
163	        });
164	      }
165	    } catch (err) {
166	      console.error(`score failed for ${w.wallet}: ${(err as Error).message.slice(0, 100)}`);
167	    }
168	  }
169	  scoresCache = { at: Date.now(), positions };
170	  return scoresCache;
171	}
172	
173	// ── Compass preset scenarios (ids MUST match VAULT_PRESETS in AppDemo) ────
174	const COMPASS_SCENARIOS: {
175	  id: string;
176	  protocol: Protocol;
177	  collateralSymbol: string;
178	  collateralValueUsd: number;
179	  borrowValueUsd: number;
180	}[] = [
181	  { id: "aave-usdc-supply", protocol: "aave_v3", collateralSymbol: "USDC", collateralValueUsd: 2000, borrowValueUsd: 500 },
182	  { id: "moonwell-usdc-supply", protocol: "moonwell", collateralSymbol: "USDC", collateralValueUsd: 1500, borrowValueUsd: 300 },
183	  { id: "aave-wsteth-vault", protocol: "aave_v3", collateralSymbol: "wstETH", collateralValueUsd: 8000, borrowValueUsd: 4500 },
184	  { id: "aave-weth-borrow", protocol: "aave_v3", collateralSymbol: "WETH", collateralValueUsd: 5000, borrowValueUsd: 2000 },
185	  { id: "moonwell-weth-debt", protocol: "moonwell", collateralSymbol: "WETH", collateralValueUsd: 2000, borrowValueUsd: 1300 },
186	  { id: "moonwell-cbeth-max", protocol: "moonwell", collateralSymbol: "cbETH", collateralValueUsd: 1500, borrowValueUsd: 1050 },
187	  { id: "morpho-weth-loop", protocol: "morpho", collateralSymbol: "WETH", collateralValueUsd: 4000, borrowValueUsd: 2400 },
188	  { id: "compound-weth-borrow", protocol: "compound_v3", collateralSymbol: "WETH", collateralValueUsd: 3000, borrowValueUsd: 1500 },
189	];
190	
191	let compassCache: { at: number; scores: unknown[] } = { at: 0, scores: [] };
192	
193	async function getCompass(): Promise<typeof compassCache> {
194	  if (Date.now() - compassCache.at < 60_000) return compassCache;
195	  const scores = await Promise.all(
196	    COMPASS_SCENARIOS.map(async (s) => {
197	      const r = await scoreProspective(s, providers);
198	      return {
199	        id: s.id,
200	        total: r.total,
201	        band: r.band,
202	        subScores: r.subScores,
203	        healthFactor: r.healthFactor,
204	        liquidationDrawdown: r.liquidationDrawdown,
205	      };
206	    }),
207	  );
208	  compassCache = { at: Date.now(), scores };
209	  return compassCache;
210	}
211	
212	// ── DefiLlama pool yields (30d APY/TVL per Compass preset; 1h cache) ────────
213	// Pool UUIDs resolved from https://yields.llama.fi/pools filtered on
214	// chain=Base + project + symbol (highest TVL match), verified 2026-07-03.
215	// Re-derive with the same filter if a market is migrated or delisted.
216	// moonwell-cbeth-max has NO listed pool (market delisted from DefiLlama) -
217	// intentionally absent; the UI falls back to its static preset APY.
218	const LLAMA_POOLS: Record<string, string> = {
219	  "aave-usdc-supply": "7e0661bf-8cf3-45e6-9424-31916d4c7b84", // aave-v3 / USDC
220	  "moonwell-usdc-supply": "69cf831d-624a-4f23-b5e3-c0f63ad1fa01", // moonwell-lending / USDC
221	  "aave-wsteth-vault": "361f0a3c-6adb-4b1c-bf35-f9cd79f2341c", // aave-v3 / WSTETH
222	  "aave-weth-borrow": "23405eee-97e7-4b8e-8625-19c3a36047e8", // aave-v3 / WETH
223	  "moonwell-weth-debt": "914284ae-dbef-421f-bbb7-7c42f527fd5f", // moonwell-lending / ETH
224	  "morpho-weth-loop": "660e240a-ab18-43af-9d24-0245828f903f", // morpho-blue / WETH
225	  "compound-weth-borrow": "d83facac-3757-4b19-a84c-f3c0850dfe2a", // compound-v3 / WETH
226	};
227	
228	interface PoolYield {
229	  apy: number;
230	  tvlUsd: number;
231	  apySeries: number[]; // last 30 daily points, oldest first
232	  tvlSeries: number[];
233	}
234	
235	let poolYieldCache: { at: number; pools: Record<string, PoolYield> } = { at: 0, pools: {} };
236	
237	async function getPoolYields(): Promise<typeof poolYieldCache> {
238	  if (Date.now() - poolYieldCache.at < 3_600_000) return poolYieldCache;
239	  const entries = await Promise.all(
240	    Object.entries(LLAMA_POOLS).map(async ([id, pool]) => {
241	      try {
242	        const res = await fetch(`https://yields.llama.fi/chart/${pool}`);
243	        if (!res.ok) throw new Error(`HTTP ${res.status}`);
244	        const body = (await res.json()) as {
245	          data: { tvlUsd: number | null; apy: number | null }[];
246	        };
247	        const tail = body.data.slice(-30);
248	        if (tail.length === 0) return null;
249	        const apySeries = tail.map((p) => p.apy ?? 0);
250	        const tvlSeries = tail.map((p) => p.tvlUsd ?? 0);
251	        const yieldRow: PoolYield = {
252	          apy: apySeries[apySeries.length - 1]!,
253	          tvlUsd: tvlSeries[tvlSeries.length - 1]!,
254	          apySeries,
255	          tvlSeries,
256	        };
257	        return [id, yieldRow] as const;
258	      } catch (err) {
259	        console.error(`pool yield failed for ${id}: ${(err as Error).message.slice(0, 80)}`);
260	        return null;
261	      }
262	    }),
263	  );
264	  const pools = Object.fromEntries(entries.filter((e): e is [string, PoolYield] => e !== null));
265	  // Every fetch failed (Llama outage): keep serving the stale cache.
266	  if (Object.keys(pools).length === 0 && Object.keys(poolYieldCache.pools).length > 0) {
267	    return poolYieldCache;
268	  }
269	  poolYieldCache = { at: Date.now(), pools };
270	  return poolYieldCache;
271	}
272	
273	// Wallet persona profiles are handled by the shared start/poll session
274	// (Supabase-cached), identical to the Vercel functions — see the routes below.
275	
276	// ── chain telemetry (10s cache) ───────────────────────────────────────────
277	let chainCache: { at: number; blockNumber: number; gasGwei: number } = {
278	  at: 0,
279	  blockNumber: 0,
280	  gasGwei: 0,
281	};
282	
283	async function getChain(): Promise<typeof chainCache> {
284	  if (Date.now() - chainCache.at < 10_000) return chainCache;
285	  const [block, gas] = await Promise.all([
286	    rawClient.getBlockNumber(),
287	    rawClient.getGasPrice(),
288	  ]);
289	  chainCache = { at: Date.now(), blockNumber: Number(block), gasGwei: Number(gas) / 1e9 };
290	  return chainCache;
291	}
292	
293	// ── HTTP ───────────────────────────────────────────────────────────────────
294	const app = express();
295	
296	// CORS - lets a separately-hosted SPA (e.g. the Vercel static frontend) call
297	// this backend cross-origin. Set CORS_ORIGINS to a comma-separated allowlist in
298	// production; defaults to "*" for local dev. (If the SPA is served same-origin
299	// via a Vercel rewrite, CORS is moot but harmless.)
300	const corsOrigins = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());
301	app.use((req, res, next) => {
302	  const origin = req.headers.origin;
303	  if (corsOrigins.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
304	  else if (origin && corsOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
305	  res.setHeader("Vary", "Origin");
306	  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
307	  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Bot-Api-Secret-Token");
308	  if (req.method === "OPTIONS") { res.status(204).end(); return; }
309	  next();
310	});
311	
312	const BOOT_AT = new Date().toISOString();
313	
314	app.get("/api/health", (_req, res) => {
315	  res.json({ ok: true, cachedAt: scoresCache.at, positions: scoresCache.positions.length });
316	});
317	
318	// Deploy marker - confirms WHICH commit is live (Railway injects the SHA).
319	app.get("/api/version", (_req, res) => {
320	  res.json({
321	    service: "panik-api",
322	    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? "unknown",
323	    bootAt: BOOT_AT,
324	  });
325	});
326	
327	// Watch registry — the UI's wallet selector source (so wallets with no
328	// readable positions still get a pill instead of vanishing).
329	app.get("/api/wallets", async (_req, res) => {
330	  try {
331	    const { rows } = await db.query(
332	      "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
333	    );
334	    res.json({ wallets: rows });
335	  } catch (err) {
336	    res.status(500).json({ error: (err as Error).message });
337	  }
338	});
339	
340	app.get("/api/scores", async (_req, res) => {
341	  try {
342	    const { at, positions } = await getScores();
343	    res.json({ updatedAt: at, positions });
344	  } catch (err) {
345	    res.status(500).json({ error: (err as Error).message });
346	  }
347	});
348	
349	// Live positions for ONE arbitrary wallet — the onboarded user's own wallet —
350	// scored on demand via the same ActiveAdapter (current Base positions). Lets the
351	// dashboard follow the pasted wallet instead of the seeded validation registry.
352	// 60s cache per wallet (mirrors the live-loop cadence).
353	const ownPosCache = new Map<string, { at: number; positions: LivePosition[] }>();
354	app.get("/api/positions", async (req, res) => {
355	  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
356	  const profile = String(req.query.profile ?? "moderate") as RiskProfile;
357	  if (!isEvmAddress(wallet)) {
358	    res.status(400).json({ error: "invalid EVM wallet address" });
359	    return;
360	  }
361	  const cached = ownPosCache.get(wallet);
362	  if (cached && Date.now() - cached.at < 60_000) {
363	    res.json({ updatedAt: cached.at, positions: cached.positions });
364	    return;
365	  }
366	  try {
367	    const scored = await adapter.scoreWallet(wallet);
368	    const positions: LivePosition[] = scored.map((s) => ({
369	      ...s,
370	      label: null,
371	      riskProfile: profile,
372	      profileStatus: statusFor(profile, s.total),
373	    }));
374	    ownPosCache.set(wallet, { at: Date.now(), positions });
375	    res.json({ updatedAt: Date.now(), positions });
376	  } catch (err) {
377	    res.status(502).json({ error: (err as Error).message });
378	  }
379	});
380	
381	app.get("/api/compass", async (_req, res) => {
382	  try {
383	    const { at, scores } = await getCompass();
384	    res.json({ updatedAt: at, scores });
385	  } catch (err) {
386	    res.status(500).json({ error: (err as Error).message });
387	  }
388	});
389	
390	// ── per-wallet history: alert feed + 30d score series (Portfolio tab) ──────
391	// watch_transitions IS the alert log (notify_channel records the outcome) and
392	// score_snapshots the score/position time series - no new tables needed.
393	const walletHistoryCache = new Map<string, { at: number; body: unknown }>();
394	
395	app.get("/api/history", async (req, res) => {
396	  try {
397	    const wallet = String(req.query.wallet ?? "").toLowerCase();
398	    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
399	      res.status(400).json({ error: "invalid wallet" });
400	      return;
401	    }
402	    const hit = walletHistoryCache.get(wallet);
403	    if (hit && Date.now() - hit.at < 60_000) {
404	      res.json(hit.body);
405	      return;
406	    }
407	    const [alerts, snapshots] = await Promise.all([
408	      db.query(
409	        `select protocol, risk_profile, score, band, from_status, to_status,
410	                notify_channel, notified_at, created_at
411	           from public.watch_transitions
412	          where wallet = $1
413	          order by created_at desc
414	          limit 50`,
415	        [wallet],
416	      ),
417	      db.query(
418	        `select protocol, total, health_factor, collateral_usd, borrow_usd, created_at
419	           from public.score_snapshots
420	          where wallet = $1 and created_at > now() - interval '30 days'
421	          order by created_at asc
422	          limit 2000`,
423	        [wallet],
424	      ),
425	    ]);
426	    const body = { updatedAt: Date.now(), alerts: alerts.rows, snapshots: snapshots.rows };
427	    walletHistoryCache.set(wallet, { at: Date.now(), body });
428	    res.json(body);
429	  } catch (err) {
430	    res.status(502).json({ error: (err as Error).message });
431	  }
432	});
433	
434	app.get("/api/poolhistory", async (_req, res) => {
435	  try {
436	    const { at, pools } = await getPoolYields();
437	    res.json({ updatedAt: at, pools });
438	  } catch (err) {
439	    res.status(502).json({ error: (err as Error).message });
440	  }
441	});
442	
443	app.get("/api/prospective", async (req, res) => {
444	  try {
445	    const protocol = String(req.query.protocol) as Protocol;
446	    const collateralSymbol = String(req.query.symbol);
447	    const collateralValueUsd = Number(req.query.collateralUsd);
448	    const borrowValueUsd = Number(req.query.borrowUsd);
449	
450	    if (!MARKETS[protocol]?.[collateralSymbol]) {
451	      res.status(400).json({ error: `unknown market ${protocol}/${collateralSymbol}` });
452	      return;
453	    }
454	    if (!Number.isFinite(collateralValueUsd) || !Number.isFinite(borrowValueUsd) ||
455	        collateralValueUsd < 0 || borrowValueUsd < 0) {
456	      res.status(400).json({ error: "invalid amounts" });
457	      return;
458	    }
459	
460	    // Providers cache for 1h, so slider drags are pure math after warmup.
461	    const r = await scoreProspective(
462	      { protocol, collateralSymbol, collateralValueUsd, borrowValueUsd },
463	      providers,
464	    );
465	    res.json(r);
466	  } catch (err) {
467	    res.status(500).json({ error: (err as Error).message });
468	  }
469	});
470	
471	// Persona profiler — timeout-proof start/poll, mirroring the Vercel functions
472	// (same shared session + Supabase cache). The onboarding fires /start on wallet
473	// entry, then polls /result (with the quiz's stated profile) at the reveal.
474	app.use(express.json());
475	
476	app.post("/api/profile/start", async (req, res) => {
477	  const wallet = String(req.query.wallet ?? req.body?.wallet ?? "").trim();
478	  if (!isEvmAddress(wallet)) {
479	    res.status(400).json({ error: "invalid EVM wallet address" });
480	    return;
481	  }
482	  if (!profilerConfigured) {
483	    res.status(503).json({ error: "profiler unconfigured (DUNE_API_KEY / SUPABASE_DB_URL)" });
484	    return;
485	  }
486	  try {
487	    res.json(await startProfileScan(wallet.toLowerCase(), getProfileDeps()));
488	  } catch (err) {
489	    res.status(502).json({ error: (err as Error).message });
490	  }
491	});
492	
493	app.post("/api/profile/result", async (req, res) => {
494	  const wallet = String(req.query.wallet ?? req.body?.wallet ?? "").trim();
495	  const executionId: string | undefined = req.body?.executionId ?? (req.query.executionId as string | undefined);
496	  const stated: StatedProfile | undefined = req.body?.stated;
497	  if (!isEvmAddress(wallet)) {
498	    res.status(400).json({ error: "invalid EVM wallet address" });
499	    return;
500	  }
501	  if (!profilerConfigured) {
502	    res.status(503).json({ error: "profiler unconfigured (DUNE_API_KEY / SUPABASE_DB_URL)" });
503	    return;
504	  }
505	  try {
506	    res.json(await resolveProfileScan(wallet.toLowerCase(), { executionId, stated }, getProfileDeps()));
507	  } catch (err) {
508	    res.status(502).json({ error: (err as Error).message });
509	  }
510	});
511	
512	// Telegram deep-link mint - dev parity with the Vercel function api/telegram/link.ts.
513	// (The webhook itself needs a public URL; tunnel to this server or use Vercel.)
514	const telegramConfigured = Boolean(
515	  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.VITE_TELEGRAM_BOT_USERNAME,
516	);
517	app.post("/api/telegram/link", async (req, res) => {
518	  const wallet = String(req.body?.wallet ?? req.query.wallet ?? "").trim().toLowerCase();
519	  if (!isEvmAddress(wallet)) {
520	    res.status(400).json({ error: "invalid EVM wallet address" });
521	    return;
522	  }
523	  if (!telegramConfigured) {
524	    res.status(503).json({ error: "telegram unconfigured (SUPABASE_* / VITE_TELEGRAM_BOT_USERNAME)" });
525	    return;
526	  }
527	  try {
528	    const code = randomUUID().replace(/-/g, "");
529	    await TelegramStore.fromEnv().createLinkCode(code, wallet, 15 * 60 * 1000);
530	    const botUsername = process.env.VITE_TELEGRAM_BOT_USERNAME as string;
531	    res.json({ code, botUsername, deepLink: `https://t.me/${botUsername}?start=${code}`, expiresInSec: 900 });
532	  } catch (err) {
533	    res.status(502).json({ error: (err as Error).message });
534	  }
535	});
536	
537	// Telegram link status - the browser polls this after Connect to auto-confirm
538	// (and on load to show an existing link). Reads via the service key (table is
539	// deny-all to the browser); returns only linked + username.
540	app.get("/api/telegram/status", async (req, res) => {
541	  const wallet = String(req.query.wallet ?? "").trim().toLowerCase();
542	  if (!isEvmAddress(wallet)) { res.status(400).json({ error: "invalid EVM wallet address" }); return; }
543	  if (!telegramConfigured) { res.status(503).json({ error: "telegram unconfigured" }); return; }
544	  try {
545	    const link = await TelegramStore.fromEnv().getLink(wallet);
546	    res.json({ linked: Boolean(link?.enabled), username: link?.username ?? null });
547	  } catch (err) {
548	    res.status(502).json({ error: (err as Error).message });
549	  }
550	});
551	
552	// Telegram webhook - the production handler (Railway), mirroring api/telegram/webhook.ts.
553	// Telegram echoes the secret_token we registered; that header is the auth boundary.
554	app.post("/api/telegram/webhook", async (req, res) => {
555	  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
556	  const botToken = process.env.TELEGRAM_BOT_TOKEN;
557	  if (!secret || !botToken) { res.status(503).json({ error: "telegram unconfigured" }); return; }
558	  if (req.header("x-telegram-bot-api-secret-token") !== secret) { res.status(401).json({ error: "bad secret" }); return; }
559	
560	  const update = (req.body ?? {}) as { message?: { text?: string; chat?: { id?: number }; from?: { username?: string } } };
561	  const chatId = update.message?.chat?.id;
562	  const text = String(update.message?.text ?? "").trim();
563	  const username = update.message?.from?.username;
564	  if (typeof chatId !== "number" || !text) { res.status(200).json({ ok: true }); return; }
565	
566	  try {
567	    const store = TelegramStore.fromEnv();
568	    const startMatch = text.match(/^\/start(?:@\w+)?\s+(\S+)$/);
569	    if (startMatch) {
570	      const code = startMatch[1];
571	      const entry = await store.getLinkCode(code);
572	      if (!entry || entry.expiresAt <= Date.now()) {
573	        if (entry) await store.consumeLinkCode(code);
574	        await sendMessage(botToken, chatId, "This link expired or is invalid. Open Panik and click Connect Telegram again.");
575	      } else {
576	        await store.upsertLink({ wallet: entry.wallet, chatId, username });
577	        await store.consumeLinkCode(code);
578	        await sendMessage(botToken, chatId, formatWelcome(entry.wallet));
579	      }
580	    } else if (/^\/stop(?:@\w+)?$/.test(text)) {
581	      await store.disableLink(chatId);
582	      await sendMessage(botToken, chatId, "Alerts disabled. Send /start again from Panik to re-enable.");
583	    } else if (/^\/start(?:@\w+)?$/.test(text)) {
584	      await sendMessage(botToken, chatId, "Open Panik and click Connect Telegram to link this chat to your wallet.");
585	    } else {
586	      await sendMessage(botToken, chatId, "Unknown command. Connect from the Panik dashboard, or send /stop to disable alerts.");
587	    }
588	  } catch (err) {
589	    console.error(`telegram webhook error: ${(err as Error).message}`);
590	  }
591	  res.status(200).json({ ok: true });
592	});
593	
594	app.get("/api/chain", async (_req, res) => {
595	  try {
596	    res.json(await getChain());
597	  } catch (err) {
598	    res.status(500).json({ error: (err as Error).message });
599	  }
600	});
601	
602	// Optional: serve the built SPA from this same service, so ONE Railway service
603	// can host frontend + backend at the same origin (no CORS, no rewrite). Off by
604	// default - the frontend usually lives on Vercel's CDN with /api/* rewritten
605	// here. Enable with SERVE_STATIC=true after `npm run build`.
606	if (process.env.SERVE_STATIC === "true") {
607	  const dist = path.resolve("dist");
608	  // Mirror the vercel.json clean-URL rewrites for the multi-entry build.
609	  const pageFor = (p: string): string => {
610	    if (p === "/app") return "app.html";
611	    if (p === "/founding" || p === "/early-access") return "founding.html";
612	    return "index.html";
613	  };
614	  app.use(express.static(dist, { extensions: ["html"] }));
615	  app.use((req, res, next) => {
616	    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
617	    res.sendFile(path.join(dist, pageFor(req.path)));
618	  });
619	  console.log(`serving static SPA from ${dist}`);
620	}
621	
622	// Dev safety net: never let a stray upstream rejection take the whole API down.
623	process.on("unhandledRejection", (reason) =>
624	  console.error(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`),
625	);
626	
627	// Auto-register the Telegram webhook on boot (idempotent) so /start updates are
628	// delivered without a manual `telegram:setup`. Uses TELEGRAM_PUBLIC_BASE_URL, or
629	// Railway's injected RAILWAY_PUBLIC_DOMAIN. No-op if telegram is unconfigured.
630	function autoRegisterTelegramWebhook(): void {
631	  const token = process.env.TELEGRAM_BOT_TOKEN;
632	  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
633	  const base =
634	    process.env.TELEGRAM_PUBLIC_BASE_URL ??
635	    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
636	  if (!token || !secret || !base) {
637	    console.log("telegram webhook auto-register skipped (token/secret/public base missing)");
638	    return;
639	  }
640	  const hookUrl = `${base.replace(/\/+$/, "")}/api/telegram/webhook`;
641	  void setWebhook(token, hookUrl, secret)
642	    .then((r) => console.log(`telegram setWebhook -> ${hookUrl}: ok=${r.ok}${r.description ? ` (${r.description})` : ""}`))
643	    .catch((e) => console.error(`telegram setWebhook failed: ${(e as Error).message.slice(0, 120)}`));
644	}
645	
646	// Bind IPv4 explicitly - pairs with the Vite proxy's 127.0.0.1 target.
647	app.listen(PORT, "0.0.0.0", () => {
648	  console.log(`PANIK scoring API on http://127.0.0.1:${PORT}  (scores|compass|prospective|chain)`);
649	  autoRegisterTelegramWebhook();
650	  void getScores()
651	    .then((c) => console.log(`warmed: ${c.positions.length} live positions`))
652	    .catch((e) => console.error(`scores warmup skipped: ${(e as Error).message.slice(0, 100)}`));
653	  void getCompass()
654	    .then((c) => console.log(`warmed: ${c.scores.length} compass scenarios`))
655	    .catch((e) => console.error(`compass warmup skipped: ${(e as Error).message.slice(0, 100)}`));
656	});
657	
```


### 🤖 Claude *(2026-07-04 15:58:07)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:58:08)*

Now I have the full backend picture. The Express server (`scripts/api-server.ts`) is authoritative, uses `app.use(express.json())` at line 474 (POST routes after it), and CORS allows specific headers. Let me read the styling reference files before building the frontend.


### 🤖 Claude *(2026-07-04 15:58:09)*

**🛠️ Tool Call:** `Read` (ID: `toolu_018yrV77yysVs9uuJDrCdu7y`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\index.css"
}
```


### 👤 User *(2026-07-04 15:58:09)*

**Tool Result (✅ Success - ID: `toolu_018yrV77yysVs9uuJDrCdu7y`):**
```
1	@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
2	@import "tailwindcss";
3	
4	@theme {
5	  /* Brand Typography Alignment */
6	  --font-sans: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif;
7	  --font-display: "Space Grotesk", sans-serif;
8	  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
9	
10	  /* Custom Color Overrides to make code cleaner */
11	  --color-panik-orange: #F97316;
12	  --color-panik-deep: #09090B;
13	  --color-panik-surface: #111318;
14	  --color-panik-card: rgba(17, 19, 24, 0.6);
15	  --color-panik-text-primary: #F8FAFC;
16	  --color-panik-text-secondary: #94A3B8;
17	
18	  /* Premium alert values */
19	  --color-panik-green: #22C55E;
20	  --color-panik-amber: #F59E0B;
21	  --color-panik-red: #EF4444;
22	  --color-panik-darkred: #DC2626;
23	}
24	
25	/* Custom structural styles for financial style aesthetics */
26	@layer base {
27	  body {
28	    background-color: #09090B;
29	    color: #F8FAFC;
30	    font-family: var(--font-sans);
31	    overflow-x: clip;
32	    position: relative;
33	  }
34	
35	  body::after {
36	    content: "";
37	    position: fixed;
38	    top: 0;
39	    left: 0;
40	    right: 0;
41	    bottom: 0;
42	    pointer-events: none;
43	    z-index: 9999;
44	    opacity: 0.025;
45	    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
46	  }
47	
48	  ::-webkit-scrollbar {
49	    width: 6px;
50	    height: 6px;
51	  }
52	  ::-webkit-scrollbar-track {
53	    background: #09090B;
54	  }
55	  ::-webkit-scrollbar-thumb {
56	    background: rgba(249, 115, 22, 0.2);
57	    border-radius: 3px;
58	  }
59	  ::-webkit-scrollbar-thumb:hover {
60	    background: rgba(249, 115, 22, 0.4);
61	  }
62	}
63	
64	/* Elegant Utilities */
65	.panik-glow-orange {
66	  box-shadow: 0 0 25px -3px rgba(249, 115, 22, 0.45), 0 0 10px -2px rgba(249, 115, 22, 0.2);
67	}
68	
69	.panik-glow-orange-text {
70	  text-shadow: 0 0 15px rgba(249, 115, 22, 0.6);
71	}
72	
73	.panik-glow-red {
74	  box-shadow: 0 0 25px -3px rgba(239, 68, 68, 0.5), 0 0 10px -2px rgba(239, 68, 68, 0.35);
75	}
76	
77	.panik-glow-green {
78	  box-shadow: 0 0 25px -3px rgba(34, 197, 94, 0.4), 0 0 10px -2px rgba(34, 197, 94, 0.2);
79	}
80	
81	/* Glassmorphism treatment */
82	.panik-glass {
83	  background: rgba(21, 27, 38, 0.45);
84	  backdrop-filter: blur(12px);
85	  -webkit-backdrop-filter: blur(12px);
86	  border: 1px solid rgba(255, 255, 255, 0.07);
87	  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05), 0 8px 32px 0 rgba(0, 0, 0, 0.5);
88	  transition: border-color 0.3s ease, background 0.3s ease;
89	}
90	
91	.panik-glass:hover {
92	  border-color: rgba(255, 255, 255, 0.13);
93	  background: rgba(21, 27, 38, 0.55);
94	}
95	
96	/* Dynamic Grid Background with slow fade effect */
97	.panik-grid-bg {
98	  background-image: 
99	    linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
100	    linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
101	  background-size: 40px 40px;
102	  background-position: center top;
103	}
104	
105	.panik-dot-bg {
106	  background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px);
107	  background-size: 24px 24px;
108	}
109	
110	/* Soft orange gradient background glow */
111	.panik-radial-ambient {
112	  background: radial-gradient(circle at 60% 40%, rgba(249, 115, 22, 0.06) 0%, transparent 60%);
113	}
114	
115	.panik-radial-subtle {
116	  background: radial-gradient(circle at center, rgba(249, 115, 22, 0.03) 0%, transparent 70%);
117	}
118	
119	@keyframes slow-pulse {
120	  0%, 100% { opacity: 0.5; transform: scale(1); }
121	  50% { opacity: 0.8; transform: scale(1.03); }
122	}
123	
124	.animate-slow-pulse {
125	  animation: slow-pulse 4s infinite ease-in-out;
126	}
127	
128	@keyframes float-subtle {
129	  0%, 100% { transform: translateY(0px) rotate(0.5deg); }
130	  50% { transform: translateY(-6px) rotate(-0.5deg); }
131	}
132	
133	.animate-float-subtle {
134	  animation: float-subtle 6s infinite ease-in-out;
135	}
136	
137	@keyframes float-delayed {
138	  0%, 100% { transform: translateY(-3px) rotate(-1.5deg) scale(0.98); }
139	  50% { transform: translateY(3px) rotate(-0.5deg) scale(1); }
140	}
141	
142	.animate-float-delayed {
143	  animation: float-delayed 8s infinite ease-in-out;
144	}
145	
```


### 🤖 Claude *(2026-07-04 15:58:10)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01GkBsNCV6Dr8AhJhW451LGX`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-founding\\App.tsx"
}
```


### 👤 User *(2026-07-04 15:58:10)*

**Tool Result (✅ Success - ID: `toolu_01GkBsNCV6Dr8AhJhW451LGX`):**
```
1	/**
2	 * @license
3	 * SPDX-License-Identifier: Apache-2.0
4	 */
5	
6	import React, { useState, useEffect } from "react";
7	import { WagmiProvider } from "wagmi";
8	import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
9	import { wagmiConfig } from "./lib/contracts";
10	import { DepositFlow } from "./components/DepositFlow";
11	import { RefundBanner } from "./components/RefundBanner";
12	import { EscrowStats } from "./components/EscrowStats";
13	
14	const queryClient = new QueryClient();
15	
16	/** Benefits list for founding users */
17	const BENEFITS = [
18	  {
19	    icon: "💰",
20	    title: "12-Month Fee Reduction",
21	    desc: "50% off transaction fees for the first 12 months, locked to your depositor wallet.",
22	  },
23	  {
24	    icon: "⚡",
25	    title: "Earlier Access",
26	    desc: "Access to PANIK before the public — you're first in line.",
27	  },
28	  {
29	    icon: "📡",
30	    title: "Early News",
31	    desc: "Product updates, feature previews, and launch timing before any public announcement.",
32	  },
33	  {
34	    icon: "🎯",
35	    title: "Direct Product Input",
36	    desc: "Direct access to the team during build — your feedback shapes features pre-launch.",
37	  },
38	  {
39	    icon: "🏆",
40	    title: "Founding User Status",
41	    desc: "Permanently recognized as an OG founding member of PANIK.",
42	  },
43	];
44	
45	function FoundingApp() {
46	  const [mounted, setMounted] = useState(false);
47	  useEffect(() => setMounted(true), []);
48	
49	  return (
50	    <div className="relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 selection:text-white overflow-x-clip">
51	      {/* Ambient background */}
52	      <div className="fixed inset-0 pointer-events-none z-0">
53	        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-gradient-to-b from-orange-500/[0.04] via-orange-600/[0.02] to-transparent blur-3xl" />
54	        <div className="absolute bottom-0 right-0 w-[600px] h-[400px] rounded-full bg-gradient-to-t from-orange-500/[0.03] to-transparent blur-3xl" />
55	      </div>
56	
57	      {/* Dot grid overlay */}
58	      <div className="fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-50" />
59	
60	      {/* Header */}
61	      <header className="relative z-10 border-b border-white/[0.06]">
62	        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
63	          <a
64	            href="/"
65	            className="flex items-center gap-2.5 group"
66	            id="founding-logo-link"
67	          >
68	            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center font-display font-bold text-sm text-white shadow-lg shadow-orange-500/20 group-hover:shadow-orange-500/40 transition-shadow">
69	              P
70	            </div>
71	            <span className="font-display font-semibold text-lg tracking-tight text-white/90 group-hover:text-white transition-colors">
72	              PANIK
73	            </span>
74	          </a>
75	          <div className="flex items-center gap-2 text-xs font-mono text-white/30">
76	            <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500/60 animate-pulse" />
77	            Invite Only
78	          </div>
79	        </div>
80	      </header>
81	
82	      {/* Main content */}
83	      <main className="relative z-10 max-w-5xl mx-auto px-6 py-12 md:py-20">
84	        {/* Hero section */}
85	        <section className="text-center mb-16 md:mb-20">
86	          <div
87	            className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-orange-500/20 bg-orange-500/[0.06] mb-6 transition-all duration-700 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
88	          >
89	            <span className="text-orange-400 text-xs font-semibold tracking-wide uppercase">
90	              Founding User Program
91	            </span>
92	          </div>
93	
94	          <h1
95	            className={`font-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1] mb-6 transition-all duration-700 delay-100 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
96	          >
97	            <span className="text-white">Back PANIK with </span>
98	            <span className="bg-gradient-to-r from-orange-400 via-orange-500 to-amber-500 bg-clip-text text-transparent">
99	              $5 USDC
100	            </span>
101	          </h1>
102	
103	          <p
104	            className={`text-lg md:text-xl text-white/50 max-w-2xl mx-auto leading-relaxed mb-4 transition-all duration-700 delay-200 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
105	          >
106	            If we don't ship PANIK within{" "}
107	            <span className="text-white/80 font-medium">90 days</span> of your
108	            deposit, you claim your money back directly from the smart contract.
109	            No questions asked.
110	          </p>
111	
112	          <p
113	            className={`text-sm text-white/30 font-mono transition-all duration-700 delay-300 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
114	          >
115	            Your deposit is held on Base · USDC · Non-custodial escrow
116	          </p>
117	        </section>
118	
119	        {/* Two-column layout: Benefits + Deposit */}
120	        <div className="grid lg:grid-cols-2 gap-8 md:gap-10 mb-16">
121	          {/* Left: Benefits */}
122	          <div
123	            className={`transition-all duration-700 delay-300 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
124	          >
125	            <h2 className="font-display text-xl font-semibold mb-6 text-white/90">
126	              What founding users get
127	            </h2>
128	            <div className="space-y-4">
129	              {BENEFITS.map((b, i) => (
130	                <div
131	                  key={i}
132	                  className="group panik-glass rounded-xl px-5 py-4 flex items-start gap-4 hover:border-orange-500/20 transition-all"
133	                >
134	                  <span className="text-2xl mt-0.5 shrink-0">{b.icon}</span>
135	                  <div>
136	                    <h3 className="font-semibold text-white/90 text-sm mb-1 group-hover:text-orange-300 transition-colors">
137	                      {b.title}
138	                    </h3>
139	                    <p className="text-xs text-white/40 leading-relaxed">
140	                      {b.desc}
141	                    </p>
142	                  </div>
143	                </div>
144	              ))}
145	            </div>
146	          </div>
147	
148	          {/* Right: Escrow Stats + Deposit Flow */}
149	          <div
150	            className={`space-y-6 transition-all duration-700 delay-400 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
151	          >
152	            <EscrowStats />
153	            <DepositFlow />
154	            <RefundBanner />
155	          </div>
156	        </div>
157	
158	        {/* How it works */}
159	        <section
160	          className={`mb-16 transition-all duration-700 delay-500 ${mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
161	        >
162	          <h2 className="font-display text-xl font-semibold mb-8 text-center text-white/90">
163	            How the escrow works
164	          </h2>
165	          <div className="grid md:grid-cols-3 gap-6">
166	            {[
167	              {
168	                step: "01",
169	                title: "Deposit $5 USDC",
170	                desc: "Connect your wallet on Base and deposit exactly 5 USDC into the escrow contract. One deposit per wallet.",
171	              },
172	              {
173	                step: "02",
174	                title: "We build PANIK",
175	                desc: "Your funds are held by the smart contract — not by us. We have 90 days from your deposit to ship the product.",
176	              },
177	              {
178	                step: "03",
179	                title: "Ship or refund",
180	                desc: "If we ship, your $5 unlocks and you get founding-user benefits. If we don't, you claim your full refund from the contract.",
181	              },
182	            ].map((s, i) => (
183	              <div
184	                key={i}
185	                className="panik-glass rounded-xl p-6 text-center group hover:border-orange-500/20 transition-all"
186	              >
187	                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-orange-500/10 text-orange-400 font-mono font-bold text-sm mb-4 group-hover:bg-orange-500/20 transition-colors">
188	                  {s.step}
189	                </div>
190	                <h3 className="font-display font-semibold text-white/90 mb-2">
191	                  {s.title}
192	                </h3>
193	                <p className="text-sm text-white/40 leading-relaxed">
194	                  {s.desc}
195	                </p>
196	              </div>
197	            ))}
198	          </div>
199	        </section>
200	
201	        {/* Trust section */}
202	        <section className="text-center mb-16">
203	          <div className="panik-glass rounded-2xl p-8 md:p-10 max-w-2xl mx-auto">
204	            <h2 className="font-display text-lg font-semibold mb-4 text-white/90">
205	              🔒 Trust by design
206	            </h2>
207	            <ul className="text-sm text-white/40 space-y-3 text-left">
208	              <li className="flex items-start gap-3">
209	                <span className="text-orange-400 mt-0.5">✓</span>
210	                <span>
211	                  <strong className="text-white/60">Non-custodial.</strong> Funds
212	                  are held by the smart contract, not a team wallet.
213	                </span>
214	              </li>
215	              <li className="flex items-start gap-3">
216	                <span className="text-orange-400 mt-0.5">✓</span>
217	                <span>
218	                  <strong className="text-white/60">Refunds forever.</strong>{" "}
219	                  There is no sweep function. Your refund right never expires.
220	                </span>
221	              </li>
222	              <li className="flex items-start gap-3">
223	                <span className="text-orange-400 mt-0.5">✓</span>
224	                <span>
225	                  <strong className="text-white/60">Deadline enforced.</strong> If
226	                  90 days pass without release, the team can never touch your
227	                  funds.
228	                </span>
229	              </li>
230	              <li className="flex items-start gap-3">
231	                <span className="text-orange-400 mt-0.5">✓</span>
232	                <span>
233	                  <strong className="text-white/60">Verifiable.</strong> Contract
234	                  source is public on Basescan — read it yourself.
235	                </span>
236	              </li>
237	            </ul>
238	          </div>
239	        </section>
240	      </main>
241	
242	      {/* Footer */}
243	      <footer className="relative z-10 border-t border-white/[0.06] py-8">
244	        <div className="max-w-5xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-white/25">
245	          <span>© 2026 PANIK. All rights reserved.</span>
246	          <span className="font-mono">
247	            Built on{" "}
248	            <a
249	              href="https://base.org"
250	              target="_blank"
251	              rel="noopener noreferrer"
252	              className="text-white/40 hover:text-orange-400 transition-colors"
253	            >
254	              Base
255	            </a>
256	          </span>
257	        </div>
258	      </footer>
259	    </div>
260	  );
261	}
262	
263	export default function App() {
264	  return (
265	    <WagmiProvider config={wagmiConfig}>
266	      <QueryClientProvider client={queryClient}>
267	        <FoundingApp />
268	      </QueryClientProvider>
269	    </WagmiProvider>
270	  );
271	}
272	
```


### 🤖 Claude *(2026-07-04 15:58:10)*

**🛠️ Tool Call:** `Read` (ID: `toolu_0162jh1jvACcNC4TcXofGu2m`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core\\AppDemo.tsx",
  "limit": 90
}
```


### 👤 User *(2026-07-04 15:58:10)*

**Tool Result (✅ Success - ID: `toolu_0162jh1jvACcNC4TcXofGu2m`):**
```
1	/**
2	 * @license
3	 * SPDX-License-Identifier: Apache-2.0
4	 */
5	
6	import React, { useState, useEffect, useMemo, useRef } from "react";
7	import { 
8	  ShieldAlert, 
9	  Activity, 
10	  ArrowLeft, 
11	  RefreshCw, 
12	  Layers, 
13	  Wallet, 
14	  HelpCircle, 
15	  Sliders, 
16	  TrendingDown, 
17	  Cpu, 
18	  ShieldCheck,
19	  Flame,
20	  CheckCircle2,
21	  ListFilter,
22	  Compass as CompassIcon,
23	  Eye,
24	  Settings as SettingsIcon,
25	  Sparkles,
26	  Search,
27	  Bell,
28	  CheckCircle,
29	  FileText,
30	  X,
31	  ChevronDown,
32	} from "lucide-react";
33	import { calculateDynamicPosition, formatCompactUsd, formatCurrency } from "./lib/utils";
34	import { PositionState } from "./lib/types";
35	import { LivePositions } from "./components/LivePositions";
36	import { Sparkline } from "./components/Sparkline";
37	import { OpenPositionModal } from "./components/OpenPositionModal";
38	import { InfoTip } from "./components/InfoTip";
39	import {
40	  useChainTelemetry,
41	  useCompassScores,
42	  useCompassYields,
43	  useLiveScores,
44	  useProspective,
45	  useWalletHistory,
46	  useWalletPositions,
47	  useWalletRegistry,
48	  type LiveProtocol,
49	} from "./lib/live";
50	import { ProtocolLogo } from "./components/ProtocolLogo";
51	import { Onboarding } from "./components/Onboarding";
52	import { registerWatchedWallet, useTelegramLink, isEvmAddress } from "./lib/telegram";
53	import {
54	  SEGMENT_LABELS,
55	  RISK_TIER_LABELS,
56	  type Segment,
57	  type RiskTier,
58	  type ProfileResult,
59	} from "./lib/profiling";
60	import { motion, AnimatePresence } from "motion/react";
61	
62	type SidebarTab = "compass" | "watch" | "advisor" | "portfolio" | "settings";
63	
64	/**
65	 * Watch tab data source. "positions" = the user's REAL on-chain positions
66	 * (the business requirement: Watch mirrors what you actually hold), seeded
67	 * into the stress-test simulator. "recommendations" = the Compass preset
68	 * catalog for what-if auditing before opening a position.
69	 */
70	type WatchSource = "positions" | "recommendations";
71	type RiskProfile = "conservative" | "moderate" | "aggressive";
72	
73	// Colour for the user-segment badge in the dashboard header.
74	const SEGMENT_BADGE: Record<Segment, string> = {
75	  explorer: "bg-sky-500/10 text-sky-400 border-sky-500/25",
76	  yield_seeker: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
77	  liquidity_provider: "bg-cyan-500/10 text-cyan-400 border-cyan-500/25",
78	  active_trader: "bg-amber-500/10 text-amber-400 border-amber-500/25",
79	  risk_optimizer: "bg-violet-500/10 text-violet-400 border-violet-500/25",
80	};
81	
82	// Colour ramp for the 5-level risk-tier badge (Conservative → Aggressive).
83	const TIER_BADGE: Record<RiskTier, string> = {
84	  conservative: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
85	  moderately_conservative: "bg-teal-500/10 text-teal-300 border-teal-500/25",
86	  moderate: "bg-panik-orange/10 text-panik-orange border-panik-orange/25",
87	  moderately_aggressive: "bg-orange-500/10 text-orange-400 border-orange-500/25",
88	  aggressive: "bg-red-500/10 text-red-400 border-red-500/25",
89	};
90	
```


### 🤖 Claude *(2026-07-04 15:58:14)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:58:15)*

I have everything I need. Let me build, starting with the migration.


### 🤖 Claude *(2026-07-04 15:58:20)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_01AgAxrPhEMMQGFA51KXprCP`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "in_progress",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "pending",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "pending",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "pending",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "pending",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "pending",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "pending",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "pending",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "pending",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "pending",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 15:58:20)*

**Tool Result (✅ Success - ID: `toolu_01AgAxrPhEMMQGFA51KXprCP`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 15:59:06)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01UARM74pEbwKmSDkiUwMoft`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\supabase\\migrations\\20260704000001_product_codes.sql",
  "content": "-- ============================================================================\n-- PANIK - Product trial codes schema v1 (2026-07-04)\n-- Scope: the \"2-in-1 business card\" trial. A physical card carries a QR + a\n--        printed short code (a CAMPAIGN). Scanning lands on /try?code=... and\n--        clicking \"Try Now\" redeems the campaign, minting the visitor a UNIQUE,\n--        per-user access token used as an expiring link into the core app\n--        (/app?trial=PANIK-XXXXXX). The per-user trial clock starts when the\n--        user first OPENS the app with their link (not at creation/redeem).\n--\n-- Idempotent (safe to re-run). ADDITIVE ONLY.\n--\n-- Access model (same as the rest of the project):\n--   * All new tables are deny-all RLS (zero policies).\n--   * The browser NEVER calls these functions directly. Redemption and app-open\n--     go through the backend (/api/try/*) which holds the Supabase secret key\n--     (service_role) - this lets us capture IP/User-Agent and keeps the honeypot\n--     meaningful. So, unlike public.waitlist_signup (granted to anon), these\n--     SECURITY DEFINER functions are locked to service_role.\n--   * Admin CRUD (create/list/expire campaigns) is done by the backend over the\n--     PostgREST table API with the secret key (bypasses RLS) - see\n--     server/campaignStore.ts.\n--\n-- Depends on public.set_updated_at() (supabase/migrations/20260613000001).\n-- ============================================================================\n\ncreate extension if not exists pgcrypto;\n\n-- \u2500\u2500 0. Short-code suffix generator \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n-- Crockford-style unambiguous alphabet: no 0/1/I/O (avoids read/typo errors on\n-- a printed card). 32 symbols, so each byte maps cleanly via `% 32`.\ncreate or replace function public.gen_panik_suffix(p_len int)\nreturns text\nlanguage plpgsql\nas $$\ndeclare\n  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';\n  v_bytes  bytea := gen_random_bytes(p_len);\n  v_out    text  := '';\n  i        int;\nbegin\n  for i in 0 .. p_len - 1 loop\n    v_out := v_out || substr(alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);\n  end loop;\n  return v_out;\nend $$;\n\n-- \u2500\u2500 1. product_campaigns - one row per card / QR batch (admin-created) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\ncreate table if not exists public.product_campaigns (\n  id                      uuid primary key default gen_random_uuid(),\n  -- Printed short code, e.g. PANIK-TRY-8X2Q. Same unambiguous alphabet.\n  campaign_code           text not null unique\n                          check (campaign_code ~ '^PANIK-TRY-[2-9A-HJ-NP-Z]{4,8}$'),\n  label                   text,\n  -- Usage limit: max number of successful redemptions (unique users).\n  max_redemptions         int not null check (max_redemptions > 0),\n  redemption_count        int not null default 0 check (redemption_count >= 0),\n  -- Per-user trial length once the user first opens the app.\n  trial_duration_hours    int not null check (trial_duration_hours > 0),\n  -- Optional cutoff for CLAIMING the code (null = no claim deadline). This is\n  -- the campaign-level time limit; it is independent of the per-user trial.\n  claim_window_expires_at timestamptz,\n  -- Manual kill switch (admin \"expire early\").\n  is_active               boolean not null default true,\n  created_at              timestamptz not null default now(),\n  updated_at              timestamptz not null default now()\n);\n\ndrop trigger if exists trg_product_campaigns_updated on public.product_campaigns;\ncreate trigger trg_product_campaigns_updated\n  before update on public.product_campaigns\n  for each row execute function public.set_updated_at();\n\n-- \u2500\u2500 2. trial_grants - one row per successful redemption (per-user link) \u2500\u2500\u2500\u2500\u2500\u2500\ncreate table if not exists public.trial_grants (\n  id               uuid primary key default gen_random_uuid(),\n  campaign_id      uuid not null references public.product_campaigns(id) on delete cascade,\n  -- The token embedded in /app?trial=PANIK-XXXXXX. Unique per user.\n  access_token     text not null unique\n                   check (access_token ~ '^PANIK-[2-9A-HJ-NP-Z]{6}$'),\n  -- Null until the FIRST time the app is opened with this token. Setting it\n  -- STARTS THE CLOCK (see open_trial).\n  first_opened_at  timestamptz,\n  -- Derived on first open = first_opened_at + trial_duration_hours.\n  expires_at       timestamptz,\n  claim_ip         text,\n  claim_user_agent text,\n  created_at       timestamptz not null default now()\n);\n\ncreate index if not exists idx_trial_grants_campaign on public.trial_grants (campaign_id);\ncreate index if not exists idx_trial_grants_expires  on public.trial_grants (expires_at);\n\n-- \u2500\u2500 3. redemption_attempts - log EVERY Try-Now attempt (success or fail) \u2500\u2500\u2500\u2500\u2500\ncreate table if not exists public.redemption_attempts (\n  id               bigint generated always as identity primary key,\n  campaign_code    text,\n  outcome          text not null\n                   check (outcome in ('success','not_found','disabled','expired','exhausted')),\n  ip               text,\n  user_agent       text,\n  granted_token_id uuid references public.trial_grants(id) on delete set null,\n  created_at       timestamptz not null default now()\n);\n\ncreate index if not exists idx_redemption_attempts_created on public.redemption_attempts (created_at);\ncreate index if not exists idx_redemption_attempts_code    on public.redemption_attempts (campaign_code);\n\n-- \u2500\u2500 4. RLS - deny-all (backend uses the secret key / service_role) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nalter table public.product_campaigns   enable row level security;\nalter table public.trial_grants        enable row level security;\nalter table public.redemption_attempts enable row level security;\n-- No policies on purpose: publishable-key clients get nothing here.\n\n-- \u2500\u2500 5. redeem_campaign_code - atomic usage/time check + mint token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n-- Returns jsonb: {\"outcome\":\"success\",\"token\":\"PANIK-XXXXXX\"} on success, or\n-- {\"outcome\":\"not_found|disabled|expired|exhausted\"} otherwise. Every call logs\n-- exactly one redemption_attempts row. The guarded UPDATE is the concurrency\n-- boundary: only one caller can take the last remaining slot.\ncreate or replace function public.redeem_campaign_code(\n  p_code text,\n  p_ip   text default null,\n  p_ua   text default null\n) returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = public\nas $$\ndeclare\n  v_code     text := upper(btrim(coalesce(p_code, '')));\n  v_campaign public.product_campaigns;\n  v_token    text;\n  v_grant_id uuid;\n  attempt    int;\nbegin\n  select * into v_campaign\n    from public.product_campaigns\n   where campaign_code = v_code\n   limit 1;\n\n  if not found then\n    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)\n    values (v_code, 'not_found', p_ip, p_ua);\n    return jsonb_build_object('outcome', 'not_found');\n  end if;\n\n  if not v_campaign.is_active then\n    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)\n    values (v_code, 'disabled', p_ip, p_ua);\n    return jsonb_build_object('outcome', 'disabled');\n  end if;\n\n  if v_campaign.claim_window_expires_at is not null\n     and now() >= v_campaign.claim_window_expires_at then\n    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)\n    values (v_code, 'expired', p_ip, p_ua);\n    return jsonb_build_object('outcome', 'expired');\n  end if;\n\n  -- Atomic usage-limit guard. Re-checks the count under a row lock so two\n  -- concurrent redemptions can't both take the final slot.\n  update public.product_campaigns\n     set redemption_count = redemption_count + 1\n   where id = v_campaign.id\n     and is_active\n     and redemption_count < max_redemptions\n     and (claim_window_expires_at is null or now() < claim_window_expires_at);\n\n  if not found then\n    -- Lost the race, or just hit the limit / window between the read and here.\n    insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent)\n    values (v_code, 'exhausted', p_ip, p_ua);\n    return jsonb_build_object('outcome', 'exhausted');\n  end if;\n\n  -- Mint a unique per-user access token (retry on the astronomically rare clash).\n  for attempt in 1 .. 5 loop\n    v_token := 'PANIK-' || public.gen_panik_suffix(6);\n    begin\n      insert into public.trial_grants (campaign_id, access_token, claim_ip, claim_user_agent)\n      values (v_campaign.id, v_token, p_ip, p_ua)\n      returning id into v_grant_id;\n      exit;\n    exception when unique_violation then\n      if attempt = 5 then raise; end if;\n    end;\n  end loop;\n\n  insert into public.redemption_attempts (campaign_code, outcome, ip, user_agent, granted_token_id)\n  values (v_code, 'success', p_ip, p_ua, v_grant_id);\n\n  return jsonb_build_object('outcome', 'success', 'token', v_token);\nend $$;\n\nrevoke all on function public.redeem_campaign_code(text, text, text) from public;\ngrant execute on function public.redeem_campaign_code(text, text, text) to service_role;\n\n-- \u2500\u2500 6. open_trial - resolve a token; start the clock on first open \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n-- Returns jsonb: {\"outcome\":\"active|expired|invalid\",\"expiresAt\":<ts?>}.\ncreate or replace function public.open_trial(\n  p_token text,\n  p_ip    text default null,\n  p_ua    text default null\n) returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = public\nas $$\ndeclare\n  v_token   text := upper(btrim(coalesce(p_token, '')));\n  v_grant   public.trial_grants;\n  v_hours   int;\n  v_expires timestamptz;\nbegin\n  select * into v_grant from public.trial_grants where access_token = v_token limit 1;\n  if not found then\n    return jsonb_build_object('outcome', 'invalid');\n  end if;\n\n  -- First open: start the clock now.\n  if v_grant.first_opened_at is null then\n    select trial_duration_hours into v_hours\n      from public.product_campaigns where id = v_grant.campaign_id;\n    v_expires := now() + make_interval(hours => v_hours);\n    update public.trial_grants\n       set first_opened_at   = now(),\n           expires_at        = v_expires,\n           claim_ip          = coalesce(claim_ip, p_ip),\n           claim_user_agent  = coalesce(claim_user_agent, p_ua)\n     where id = v_grant.id;\n    return jsonb_build_object('outcome', 'active', 'expiresAt', v_expires);\n  end if;\n\n  if now() >= v_grant.expires_at then\n    return jsonb_build_object('outcome', 'expired', 'expiresAt', v_grant.expires_at);\n  end if;\n\n  return jsonb_build_object('outcome', 'active', 'expiresAt', v_grant.expires_at);\nend $$;\n\nrevoke all on function public.open_trial(text, text, text) from public;\ngrant execute on function public.open_trial(text, text, text) to service_role;\n\n-- \u2500\u2500 7. Retention - drop long-expired grants + old attempt logs (pg_cron) \u2500\u2500\u2500\u2500\ncreate extension if not exists pg_cron;\n\ndo $$ begin perform cron.unschedule('panik_trial_grants_cleanup'); exception when others then null; end $$;\nselect cron.schedule(\n  'panik_trial_grants_cleanup',\n  '37 * * * *',  -- hourly at :37\n  $$\n    delete from public.trial_grants\n      where expires_at is not null and expires_at < now() - interval '30 days';\n    delete from public.redemption_attempts\n      where created_at < now() - interval '90 days';\n  $$\n);\n"
}
```


### 👤 User *(2026-07-04 15:59:07)*

**Tool Result (✅ Success - ID: `toolu_01UARM74pEbwKmSDkiUwMoft`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\supabase\migrations\20260704000001_product_codes.sql (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 15:59:11)*

Now the campaign store (shared by Express + Vercel, PostgREST + secret key):


### 🤖 Claude *(2026-07-04 15:59:36)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01HapByaA443joyheJbbdTNW`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\server\\campaignStore.ts",
  "content": "/**\n * Product trial-code store over the Supabase PostgREST API. Pure fetch with the\n * service key (bypasses the deny-all RLS on product_campaigns / trial_grants /\n * redemption_attempts), mirroring server/telegramStore.ts. No `pg`, so it\n * bundles cleanly as an ESM Vercel serverless function AND runs in the dev/\n * Railway Express server unchanged.\n *\n * - Redemption + app-open call the SECURITY DEFINER RPCs (atomic check + log).\n * - Admin CRUD (create / list / expire) hits the table REST API directly.\n *\n * Tables + functions: see supabase/migrations/20260704000001_product_codes.sql.\n * Used by api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts and the\n * mirrored routes in scripts/api-server.ts.\n */\n\n/** Unambiguous alphabet (no 0/1/I/O) - matches gen_panik_suffix in SQL. */\nconst CODE_ALPHABET = \"23456789ABCDEFGHJKLMNPQRSTUVWXYZ\";\n\n/** Random N-char suffix from the unambiguous alphabet. */\nfunction randomSuffix(n: number): string {\n  let out = \"\";\n  for (let i = 0; i < n; i++) {\n    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];\n  }\n  return out;\n}\n\nexport type RedeemOutcome = \"success\" | \"not_found\" | \"disabled\" | \"expired\" | \"exhausted\";\nexport interface RedeemResult {\n  outcome: RedeemOutcome;\n  token?: string;\n}\n\nexport type OpenOutcome = \"active\" | \"expired\" | \"invalid\";\nexport interface OpenResult {\n  outcome: OpenOutcome;\n  expiresAt?: string;\n}\n\nexport interface Campaign {\n  id: string;\n  campaign_code: string;\n  label: string | null;\n  max_redemptions: number;\n  redemption_count: number;\n  trial_duration_hours: number;\n  claim_window_expires_at: string | null;\n  is_active: boolean;\n  created_at: string;\n  updated_at: string;\n}\n\nexport interface CreateCampaignInput {\n  label?: string | null;\n  maxRedemptions: number;\n  trialDurationHours: number;\n  /** ISO timestamp for the claim cutoff, or null for no campaign-level deadline. */\n  claimWindowExpiresAt?: string | null;\n}\n\nexport class CampaignStore {\n  private readonly base: string;\n\n  constructor(\n    supabaseUrl: string,\n    private readonly serviceKey: string,\n  ) {\n    this.base = supabaseUrl.replace(/\\/+$/, \"\");\n  }\n\n  /** Build from env; throws if unconfigured (caller maps to 503). */\n  static fromEnv(): CampaignStore {\n    const url = process.env.SUPABASE_URL;\n    const key = process.env.SUPABASE_SECRET_KEY;\n    if (!url || !key) throw new Error(\"SUPABASE_URL / SUPABASE_SECRET_KEY missing\");\n    return new CampaignStore(url, key);\n  }\n\n  private headers(extra?: Record<string, string>): Record<string, string> {\n    return {\n      apikey: this.serviceKey,\n      Authorization: `Bearer ${this.serviceKey}`,\n      \"Content-Type\": \"application/json\",\n      ...extra,\n    };\n  }\n\n  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {\n    const res = await fetch(`${this.base}/rest/v1/rpc/${fn}`, {\n      method: \"POST\",\n      headers: this.headers(),\n      body: JSON.stringify(args),\n    });\n    if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);\n    return res.json();\n  }\n\n  // \u2500\u2500 redemption (public /try flow) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  /** Attempt a redemption; atomic + logged in SQL. Never over-decrements. */\n  async redeem(code: string, ip?: string | null, ua?: string | null): Promise<RedeemResult> {\n    const out = (await this.rpc(\"redeem_campaign_code\", {\n      p_code: code,\n      p_ip: ip ?? null,\n      p_ua: ua ?? null,\n    })) as RedeemResult;\n    return out;\n  }\n\n  /** Resolve a per-user token on app open; starts the clock on first open. */\n  async openTrial(token: string, ip?: string | null, ua?: string | null): Promise<OpenResult> {\n    const out = (await this.rpc(\"open_trial\", {\n      p_token: token,\n      p_ip: ip ?? null,\n      p_ua: ua ?? null,\n    })) as OpenResult;\n    return out;\n  }\n\n  // \u2500\u2500 admin CRUD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  /**\n   * Create a campaign with a freshly generated PANIK-TRY-XXXX code. Retries on\n   * the unique-code collision (409) a few times before giving up.\n   */\n  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {\n    for (let attempt = 1; attempt <= 5; attempt++) {\n      const campaign_code = `PANIK-TRY-${randomSuffix(4)}`;\n      const res = await fetch(`${this.base}/rest/v1/product_campaigns`, {\n        method: \"POST\",\n        headers: this.headers({ Prefer: \"return=representation\" }),\n        body: JSON.stringify({\n          campaign_code,\n          label: input.label ?? null,\n          max_redemptions: input.maxRedemptions,\n          trial_duration_hours: input.trialDurationHours,\n          claim_window_expires_at: input.claimWindowExpiresAt ?? null,\n        }),\n      });\n      if (res.status === 409) continue; // code collision - regenerate\n      if (!res.ok) throw new Error(`createCampaign: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);\n      const rows = (await res.json()) as Campaign[];\n      return rows[0]!;\n    }\n    throw new Error(\"createCampaign: could not allocate a unique code\");\n  }\n\n  /** All campaigns, newest first (admin table). */\n  async listCampaigns(): Promise<Campaign[]> {\n    const res = await fetch(\n      `${this.base}/rest/v1/product_campaigns?select=*&order=created_at.desc`,\n      { headers: this.headers() },\n    );\n    if (!res.ok) throw new Error(`listCampaigns: HTTP ${res.status}`);\n    return (await res.json()) as Campaign[];\n  }\n\n  /** Manually expire (disable) a campaign early. Returns the updated row or null. */\n  async expireCampaign(id: string): Promise<Campaign | null> {\n    const res = await fetch(\n      `${this.base}/rest/v1/product_campaigns?id=eq.${encodeURIComponent(id)}`,\n      {\n        method: \"PATCH\",\n        headers: this.headers({ Prefer: \"return=representation\" }),\n        body: JSON.stringify({ is_active: false }),\n      },\n    );\n    if (!res.ok) throw new Error(`expireCampaign: HTTP ${res.status}`);\n    const rows = (await res.json()) as Campaign[];\n    return rows[0] ?? null;\n  }\n}\n"
}
```


### 👤 User *(2026-07-04 15:59:38)*

**Tool Result (✅ Success - ID: `toolu_01HapByaA443joyheJbbdTNW`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\server\campaignStore.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 15:59:42)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 15:59:43)*

Now the shared pure-logic module (used by the pages, the admin status column, and the tests):


### 🤖 Claude *(2026-07-04 15:59:57)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01VSJJcQtySAdEcJZeFa15XG`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\lib\\trialLogic.ts",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * Pure, DB-free decision logic for the trial-code feature. This mirrors the SQL\n * in supabase/migrations/20260704000001_product_codes.sql so the frontend can\n * label campaign/trial state without a round-trip, and so the rules are unit-\n * testable without a database. Keep in sync with the SQL functions.\n */\n\nexport type CampaignStatus = \"active\" | \"exhausted\" | \"expired\" | \"disabled\";\n\nexport interface CampaignLike {\n  is_active: boolean;\n  redemption_count: number;\n  max_redemptions: number;\n  /** ISO timestamp, or null for no campaign-level claim deadline. */\n  claim_window_expires_at: string | null;\n}\n\n/**\n * Derived campaign status. Precedence matches redeem_campaign_code:\n * disabled (kill switch) \u2192 expired (claim window) \u2192 exhausted (usage) \u2192 active.\n * Whichever limit is hit first wins.\n */\nexport function evaluateCampaign(c: CampaignLike, now: Date = new Date()): CampaignStatus {\n  if (!c.is_active) return \"disabled\";\n  if (\n    c.claim_window_expires_at &&\n    now.getTime() >= new Date(c.claim_window_expires_at).getTime()\n  ) {\n    return \"expired\";\n  }\n  if (c.redemption_count >= c.max_redemptions) return \"exhausted\";\n  return \"active\";\n}\n\n/** Per-user trial expiry = first app-open + duration. */\nexport function computeTrialExpiry(firstOpenedAt: Date, durationHours: number): Date {\n  return new Date(firstOpenedAt.getTime() + durationHours * 3_600_000);\n}\n\nexport type TrialAccessStatus = \"active\" | \"expired\" | \"invalid\";\n\nexport interface GrantLike {\n  /** null until the first app open (clock not started yet). */\n  first_opened_at: string | null;\n  /** null until the first app open. */\n  expires_at: string | null;\n}\n\n/**\n * Per-user trial status. A grant that has never been opened is still \"active\"\n * (opening it will start the clock). Unknown/missing token \u2192 \"invalid\".\n */\nexport function evaluateTrialAccess(\n  grant: GrantLike | null | undefined,\n  now: Date = new Date(),\n): TrialAccessStatus {\n  if (!grant) return \"invalid\";\n  if (!grant.first_opened_at || !grant.expires_at) return \"active\";\n  return now.getTime() >= new Date(grant.expires_at).getTime() ? \"expired\" : \"active\";\n}\n\n/** Normalize a code from user input or a URL (uppercased, trimmed). */\nexport function normalizeCode(raw: string | null | undefined): string {\n  return (raw ?? \"\").trim().toUpperCase();\n}\n\n/**\n * Read the campaign code from a URL query string (the scan path). Returns null\n * when no `code` param is present (the no-scan / manual-input fallback path).\n * Accepts either a full search string (\"?code=ABC\") or a bare one (\"code=ABC\").\n */\nexport function parseCode(search: string): string | null {\n  const code = normalizeCode(new URLSearchParams(search).get(\"code\"));\n  return code || null;\n}\n\n/** Milliseconds \u2192 compact \"2d 3h\" / \"5h 12m\" / \"8m\" remaining label. */\nexport function formatRemaining(ms: number): string {\n  if (ms <= 0) return \"expired\";\n  const totalMin = Math.floor(ms / 60_000);\n  const days = Math.floor(totalMin / 1440);\n  const hours = Math.floor((totalMin % 1440) / 60);\n  const mins = totalMin % 60;\n  if (days > 0) return `${days}d ${hours}h`;\n  if (hours > 0) return `${hours}h ${mins}m`;\n  return `${mins}m`;\n}\n"
}
```


### 👤 User *(2026-07-04 16:00:03)*

**Tool Result (✅ Success - ID: `toolu_01VSJJcQtySAdEcJZeFa15XG`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\lib\trialLogic.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:00:28)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:00:29)*

Now a small shared client-IP helper, then the three Vercel API handlers.


### 🤖 Claude *(2026-07-04 16:00:33)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01KhVJU4XShz5RzDoAJfXPjP`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\server\\clientIp.ts",
  "content": "/**\n * Best-effort client IP from proxy headers (Railway / Vercel both set\n * x-forwarded-for). Returns null when unknown. Used to log redemption attempts.\n */\nexport function clientIp(headers: Record<string, string | string[] | undefined>): string | null {\n  const xff = headers[\"x-forwarded-for\"] ?? headers[\"X-Forwarded-For\"];\n  const raw = Array.isArray(xff) ? xff[0] : xff;\n  if (raw) return raw.split(\",\")[0]!.trim() || null;\n  const real = headers[\"x-real-ip\"];\n  const realStr = Array.isArray(real) ? real[0] : real;\n  return realStr ?? null;\n}\n\nexport function userAgent(headers: Record<string, string | string[] | undefined>): string | null {\n  const ua = headers[\"user-agent\"] ?? headers[\"User-Agent\"];\n  const raw = Array.isArray(ua) ? ua[0] : ua;\n  return raw ? raw.slice(0, 400) : null;\n}\n"
}
```


### 👤 User *(2026-07-04 16:00:35)*

**Tool Result (✅ Success - ID: `toolu_01KhVJU4XShz5RzDoAJfXPjP`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\server\clientIp.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:00:48)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01HNHVLgSS9FvDToy6Zs2Ms4`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\api\\try\\redeem.ts",
  "content": "/**\n * POST /api/try/redeem   body: { code, honeypot? }\n * Redeems a campaign code and mints the visitor a unique, expiring trial link\n * into the core app. Usage + time limits are enforced ATOMICALLY in SQL\n * (redeem_campaign_code); this handler only captures the client IP/User-Agent\n * for the attempt log and shapes the response.\n *\n * Mirrors api/telegram/link.ts. Fetch-only (Supabase REST), no viem/pg.\n * The dev/Railway Express server exposes the same route (scripts/api-server.ts).\n */\n\nimport { CampaignStore } from \"../../server/campaignStore\";\nimport { clientIp, userAgent } from \"../../server/clientIp\";\n\ninterface Req {\n  method?: string;\n  headers: Record<string, string | string[] | undefined>;\n  query: Record<string, string | string[] | undefined>;\n  body?: unknown;\n}\ninterface Res { status(code: number): Res; json(body: unknown): void }\n\nexport default async function handler(req: Req, res: Res): Promise<void> {\n  const body = (req.body ?? {}) as { code?: string; honeypot?: string };\n  const code = (body.code ?? \"\").trim();\n\n  // Honeypot: real users never fill it; bots do. Silently no-op (no DB write,\n  // no code burned), same philosophy as public.waitlist_signup.\n  if ((body.honeypot ?? \"\").trim() !== \"\") {\n    res.status(200).json({ ok: false, outcome: \"not_found\" });\n    return;\n  }\n  if (!code) {\n    res.status(400).json({ ok: false, error: \"missing code\" });\n    return;\n  }\n\n  let store: CampaignStore;\n  try {\n    store = CampaignStore.fromEnv();\n  } catch (err) {\n    res.status(503).json({ ok: false, error: `unconfigured: ${(err as Error).message}` });\n    return;\n  }\n\n  try {\n    const result = await store.redeem(code, clientIp(req.headers), userAgent(req.headers));\n    if (result.outcome === \"success\" && result.token) {\n      res.status(200).json({ ok: true, outcome: \"success\", trialUrl: `/app?trial=${result.token}` });\n      return;\n    }\n    res.status(200).json({ ok: false, outcome: result.outcome });\n  } catch (err) {\n    res.status(502).json({ ok: false, error: (err as Error).message });\n  }\n}\n"
}
```


### 👤 User *(2026-07-04 16:00:50)*

**Tool Result (✅ Success - ID: `toolu_01HNHVLgSS9FvDToy6Zs2Ms4`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\api\try\redeem.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:00:58)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01F4JY1HHGcHLx2Yhk1t2qCw`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\api\\try\\access.ts",
  "content": "/**\n * POST /api/try/access   body: { token }\n * Validates a per-user trial token when the core app loads with ?trial=TOKEN.\n * On the FIRST successful open, open_trial starts the per-user clock and sets\n * expires_at = now + trial_duration_hours. Returns the resolved status.\n *\n * Mirrors api/telegram/link.ts. Fetch-only (Supabase REST), no viem/pg.\n */\n\nimport { CampaignStore } from \"../../server/campaignStore\";\nimport { clientIp, userAgent } from \"../../server/clientIp\";\n\ninterface Req {\n  method?: string;\n  headers: Record<string, string | string[] | undefined>;\n  query: Record<string, string | string[] | undefined>;\n  body?: unknown;\n}\ninterface Res { status(code: number): Res; json(body: unknown): void }\n\nexport default async function handler(req: Req, res: Res): Promise<void> {\n  const body = (req.body ?? {}) as { token?: string };\n  const token = (body.token ?? \"\").trim();\n  if (!token) {\n    res.status(400).json({ ok: false, error: \"missing token\" });\n    return;\n  }\n\n  let store: CampaignStore;\n  try {\n    store = CampaignStore.fromEnv();\n  } catch (err) {\n    res.status(503).json({ ok: false, error: `unconfigured: ${(err as Error).message}` });\n    return;\n  }\n\n  try {\n    const result = await store.openTrial(token, clientIp(req.headers), userAgent(req.headers));\n    res.status(200).json({ ok: result.outcome === \"active\", outcome: result.outcome, expiresAt: result.expiresAt ?? null });\n  } catch (err) {\n    res.status(502).json({ ok: false, error: (err as Error).message });\n  }\n}\n"
}
```


### 👤 User *(2026-07-04 16:00:59)*

**Tool Result (✅ Success - ID: `toolu_01F4JY1HHGcHLx2Yhk1t2qCw`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\api\try\access.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:01:08)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:01:08)*

Now shared admin auth + create-input validation (so Express and Vercel don't duplicate it), then the admin endpoint:


### 🤖 Claude *(2026-07-04 16:01:18)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01HbDJq3ViWQhH1tyqMCmCk8`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\server\\adminCampaigns.ts",
  "content": "/**\n * Shared helpers for the admin campaign endpoints (api/admin/campaigns.ts and\n * the mirrored Express route). Keeps auth + input validation in one place so the\n * two transports stay in lockstep.\n *\n * Auth: a shared secret in ADMIN_ACCESS_KEY, sent by the admin page as the\n * `x-admin-key` header - the same header-secret pattern as the Telegram webhook\n * (x-telegram-bot-api-secret-token).\n */\n\nimport type { CreateCampaignInput } from \"./campaignStore\";\n\nexport type AdminAuth = \"ok\" | \"unconfigured\" | \"forbidden\";\n\n/** Timing-safe-ish shared-secret check. */\nexport function checkAdminKey(provided: string | undefined): AdminAuth {\n  const expected = process.env.ADMIN_ACCESS_KEY;\n  if (!expected) return \"unconfigured\";\n  return provided && provided === expected ? \"ok\" : \"forbidden\";\n}\n\nexport interface RawCreateBody {\n  label?: unknown;\n  trialDays?: unknown;\n  maxRedemptions?: unknown;\n  /** Optional campaign-level claim cutoff, in days from creation. */\n  claimWindowDays?: unknown;\n}\n\n/** Validate + normalize the create-campaign body. Returns an error string or the input. */\nexport function buildCreateInput(body: RawCreateBody): { input?: CreateCampaignInput; error?: string } {\n  const trialDays = Number(body.trialDays);\n  const maxRedemptions = Number(body.maxRedemptions);\n  if (!Number.isFinite(trialDays) || trialDays <= 0) return { error: \"trialDays must be a positive number\" };\n  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) return { error: \"maxRedemptions must be a positive integer\" };\n\n  let claimWindowExpiresAt: string | null = null;\n  if (body.claimWindowDays !== undefined && body.claimWindowDays !== null && String(body.claimWindowDays) !== \"\") {\n    const days = Number(body.claimWindowDays);\n    if (!Number.isFinite(days) || days <= 0) return { error: \"claimWindowDays must be a positive number\" };\n    claimWindowExpiresAt = new Date(Date.now() + days * 86_400_000).toISOString();\n  }\n\n  const label = typeof body.label === \"string\" && body.label.trim() ? body.label.trim().slice(0, 200) : null;\n\n  return {\n    input: {\n      label,\n      maxRedemptions,\n      trialDurationHours: Math.round(trialDays * 24),\n      claimWindowExpiresAt,\n    },\n  };\n}\n"
}
```


### 👤 User *(2026-07-04 16:01:19)*

**Tool Result (✅ Success - ID: `toolu_01HbDJq3ViWQhH1tyqMCmCk8`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\server\adminCampaigns.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:01:32)*

**🛠️ Tool Call:** `Write` (ID: `toolu_014U33UaGbA8Zb6FmxaTvWSf`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\api\\admin\\campaigns.ts",
  "content": "/**\n * /api/admin/campaigns   (x-admin-key: ADMIN_ACCESS_KEY)\n *   GET                       list all campaigns (newest first)\n *   POST                      create { label?, trialDays, maxRedemptions, claimWindowDays? }\n *   POST ?action=expire       disable early { id }\n *\n * Secret-gated admin surface for \"Neithan\". Fetch-only (Supabase REST), no pg.\n * Mirrored by the Express route in scripts/api-server.ts.\n */\n\nimport { CampaignStore } from \"../../server/campaignStore\";\nimport { buildCreateInput, checkAdminKey, type RawCreateBody } from \"../../server/adminCampaigns\";\n\ninterface Req {\n  method?: string;\n  headers: Record<string, string | string[] | undefined>;\n  query: Record<string, string | string[] | undefined>;\n  body?: unknown;\n}\ninterface Res { status(code: number): Res; json(body: unknown): void }\n\nfunction pick(v: string | string[] | undefined): string | undefined {\n  return Array.isArray(v) ? v[0] : v;\n}\n\nexport default async function handler(req: Req, res: Res): Promise<void> {\n  const auth = checkAdminKey(pick(req.headers[\"x-admin-key\"]));\n  if (auth === \"unconfigured\") { res.status(503).json({ error: \"admin unconfigured (ADMIN_ACCESS_KEY)\" }); return; }\n  if (auth === \"forbidden\") { res.status(401).json({ error: \"unauthorized\" }); return; }\n\n  let store: CampaignStore;\n  try {\n    store = CampaignStore.fromEnv();\n  } catch (err) {\n    res.status(503).json({ error: `unconfigured: ${(err as Error).message}` });\n    return;\n  }\n\n  try {\n    if ((req.method ?? \"GET\").toUpperCase() === \"GET\") {\n      res.status(200).json({ campaigns: await store.listCampaigns() });\n      return;\n    }\n\n    // POST\n    const action = pick(req.query.action);\n    const body = (req.body ?? {}) as RawCreateBody & { id?: string };\n\n    if (action === \"expire\") {\n      const id = (body.id ?? \"\").trim();\n      if (!id) { res.status(400).json({ error: \"missing id\" }); return; }\n      const updated = await store.expireCampaign(id);\n      if (!updated) { res.status(404).json({ error: \"campaign not found\" }); return; }\n      res.status(200).json({ campaign: updated });\n      return;\n    }\n\n    const { input, error } = buildCreateInput(body);\n    if (error) { res.status(400).json({ error }); return; }\n    const campaign = await store.createCampaign(input!);\n    res.status(201).json({ campaign });\n  } catch (err) {\n    res.status(502).json({ error: (err as Error).message });\n  }\n}\n"
}
```


### 👤 User *(2026-07-04 16:01:33)*

**Tool Result (✅ Success - ID: `toolu_014U33UaGbA8Zb6FmxaTvWSf`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\api\admin\campaigns.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:02:01)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:02:01)*

Now mirror these as Express routes in the authoritative dev/Railway server. Three edits: imports, CORS header, and the routes.


### 🤖 Claude *(2026-07-04 16:02:04)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01NL9G9azbFTfkruL3vu3wuk`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\scripts\\api-server.ts",
  "old_string": "import { TelegramStore } from \"../server/telegramStore\";\nimport { sendMessage, setWebhook } from \"../server/telegram\";",
  "new_string": "import { TelegramStore } from \"../server/telegramStore\";\nimport { sendMessage, setWebhook } from \"../server/telegram\";\nimport { CampaignStore } from \"../server/campaignStore\";\nimport { clientIp, userAgent } from \"../server/clientIp\";\nimport { buildCreateInput, checkAdminKey, type RawCreateBody } from \"../server/adminCampaigns\";"
}
```


### 👤 User *(2026-07-04 16:02:05)*

**Tool Result (✅ Success - ID: `toolu_01NL9G9azbFTfkruL3vu3wuk`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\scripts\api-server.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:02:11)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_018BD2c6u8qHLzuN3EUCoKgU`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\scripts\\api-server.ts",
  "old_string": "  res.setHeader(\"Access-Control-Allow-Headers\", \"Content-Type, X-Telegram-Bot-Api-Secret-Token\");",
  "new_string": "  res.setHeader(\"Access-Control-Allow-Headers\", \"Content-Type, X-Telegram-Bot-Api-Secret-Token, X-Admin-Key\");"
}
```


### 👤 User *(2026-07-04 16:02:13)*

**Tool Result (✅ Success - ID: `toolu_018BD2c6u8qHLzuN3EUCoKgU`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\scripts\api-server.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:02:30)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01Ho3J1kR788bauCY3M3cFpf`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\scripts\\api-server.ts",
  "old_string": "app.get(\"/api/chain\", async (_req, res) => {\n  try {\n    res.json(await getChain());\n  } catch (err) {\n    res.status(500).json({ error: (err as Error).message });\n  }\n});",
  "new_string": "// \u2500\u2500 Product trial codes - business-card \"Try Now\" + admin \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n// Mirrors api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts. The\n// SECURITY DEFINER RPCs enforce usage/time limits atomically; these routes only\n// capture IP/UA (for the attempt log) and gate the admin surface behind\n// ADMIN_ACCESS_KEY. See supabase/migrations/20260704000001_product_codes.sql.\nconst campaignsConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);\n\napp.post(\"/api/try/redeem\", async (req, res) => {\n  const body = (req.body ?? {}) as { code?: string; honeypot?: string };\n  const code = String(body.code ?? \"\").trim();\n  if (String(body.honeypot ?? \"\").trim() !== \"\") { res.status(200).json({ ok: false, outcome: \"not_found\" }); return; }\n  if (!code) { res.status(400).json({ ok: false, error: \"missing code\" }); return; }\n  if (!campaignsConfigured) { res.status(503).json({ ok: false, error: \"unconfigured (SUPABASE_*)\" }); return; }\n  try {\n    const result = await CampaignStore.fromEnv().redeem(code, clientIp(req.headers), userAgent(req.headers));\n    if (result.outcome === \"success\" && result.token) {\n      res.json({ ok: true, outcome: \"success\", trialUrl: `/app?trial=${result.token}` });\n    } else {\n      res.json({ ok: false, outcome: result.outcome });\n    }\n  } catch (err) {\n    res.status(502).json({ ok: false, error: (err as Error).message });\n  }\n});\n\napp.post(\"/api/try/access\", async (req, res) => {\n  const token = String((req.body as { token?: string } | undefined)?.token ?? \"\").trim();\n  if (!token) { res.status(400).json({ ok: false, error: \"missing token\" }); return; }\n  if (!campaignsConfigured) { res.status(503).json({ ok: false, error: \"unconfigured (SUPABASE_*)\" }); return; }\n  try {\n    const result = await CampaignStore.fromEnv().openTrial(token, clientIp(req.headers), userAgent(req.headers));\n    res.json({ ok: result.outcome === \"active\", outcome: result.outcome, expiresAt: result.expiresAt ?? null });\n  } catch (err) {\n    res.status(502).json({ ok: false, error: (err as Error).message });\n  }\n});\n\nasync function adminCampaigns(req: express.Request, res: express.Response): Promise<void> {\n  const auth = checkAdminKey(req.header(\"x-admin-key\") ?? undefined);\n  if (auth === \"unconfigured\") { res.status(503).json({ error: \"admin unconfigured (ADMIN_ACCESS_KEY)\" }); return; }\n  if (auth === \"forbidden\") { res.status(401).json({ error: \"unauthorized\" }); return; }\n  if (!campaignsConfigured) { res.status(503).json({ error: \"unconfigured (SUPABASE_*)\" }); return; }\n  try {\n    const store = CampaignStore.fromEnv();\n    if (req.method === \"GET\") { res.json({ campaigns: await store.listCampaigns() }); return; }\n    const action = String(req.query.action ?? \"\");\n    const body = (req.body ?? {}) as RawCreateBody & { id?: string };\n    if (action === \"expire\") {\n      const id = String(body.id ?? \"\").trim();\n      if (!id) { res.status(400).json({ error: \"missing id\" }); return; }\n      const updated = await store.expireCampaign(id);\n      if (!updated) { res.status(404).json({ error: \"campaign not found\" }); return; }\n      res.json({ campaign: updated });\n      return;\n    }\n    const { input, error } = buildCreateInput(body);\n    if (error) { res.status(400).json({ error }); return; }\n    res.status(201).json({ campaign: await store.createCampaign(input!) });\n  } catch (err) {\n    res.status(502).json({ error: (err as Error).message });\n  }\n}\napp.get(\"/api/admin/campaigns\", adminCampaigns);\napp.post(\"/api/admin/campaigns\", adminCampaigns);\n\napp.get(\"/api/chain\", async (_req, res) => {\n  try {\n    res.json(await getChain());\n  } catch (err) {\n    res.status(500).json({ error: (err as Error).message });\n  }\n});"
}
```


### 👤 User *(2026-07-04 16:02:31)*

**Tool Result (✅ Success - ID: `toolu_01Ho3J1kR788bauCY3M3cFpf`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\scripts\api-server.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:02:35)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:02:35)*

Backend done. Now the `/try` page. Updating progress:


### 🤖 Claude *(2026-07-04 16:02:41)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_01S3b8HX5HdSjHxypQPmtb7R`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "completed",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "completed",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "completed",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "completed",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "in_progress",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "pending",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "pending",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "pending",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "pending",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "pending",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 16:02:41)*

**Tool Result (✅ Success - ID: `toolu_01S3b8HX5HdSjHxypQPmtb7R`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 16:02:49)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01HCpt2UZ1enUEWUaQrfyo9j`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\businessCard.ts",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * PANIK business-card details. Always shown on /try regardless of code state.\n * Hardcoded here (like the landing/founding marketing copy) - there is no\n * structured \"business details\" config store in the repo.\n */\n\nexport const BUSINESS_CARD = {\n  name: \"PANIK\",\n  tagline: \"Real-time liquidation risk radar for DeFi.\",\n  website: \"panik.fi\",\n  websiteUrl: \"https://panik.fi\",\n  twitterHandle: \"@panik_fi\",\n  twitterUrl: \"https://x.com/panik_fi\",\n} as const;\n"
}
```


### 👤 User *(2026-07-04 16:02:50)*

**Tool Result (✅ Success - ID: `toolu_01HCpt2UZ1enUEWUaQrfyo9j`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\businessCard.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:02:59)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01DrM2B9bA9mYm8P4Z9biZik`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\lib\\api.ts",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * Thin client for the /try redemption endpoint. The browser never touches the\n * DB directly here (unlike the waitlist): redemption goes through /api/try/redeem\n * so the backend can capture IP/UA and hold the Supabase secret key.\n */\n\nimport type { RedeemOutcome } from \"./trialLogic\";\n\nexport type { RedeemOutcome };\n\nexport interface RedeemResponse {\n  ok: boolean;\n  outcome?: RedeemOutcome;\n  /** Present on success: the unique /app?trial=... link for this user. */\n  trialUrl?: string;\n  error?: string;\n}\n\n/** Redeem a campaign code (scan or manual). Never throws - returns a result. */\nexport async function redeemCode(code: string, honeypot = \"\"): Promise<RedeemResponse> {\n  try {\n    const res = await fetch(\"/api/try/redeem\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ code, honeypot }),\n    });\n    const body = (await res.json().catch(() => ({}))) as RedeemResponse;\n    if (!res.ok && !body.outcome) {\n      return { ok: false, error: body.error ?? `http_${res.status}` };\n    }\n    return body;\n  } catch {\n    return { ok: false, error: \"network\" };\n  }\n}\n"
}
```


### 👤 User *(2026-07-04 16:03:00)*

**Tool Result (✅ Success - ID: `toolu_01DrM2B9bA9mYm8P4Z9biZik`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\lib\api.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:03:03)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:03:04)*

I referenced `RedeemOutcome` from trialLogic but defined it in the server store. Let me add the frontend-safe type to trialLogic:


### 🤖 Claude *(2026-07-04 16:03:06)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01F8ssNdiaEyQ3EEfmTZWHkK`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\lib\\trialLogic.ts",
  "old_string": "export type CampaignStatus = \"active\" | \"exhausted\" | \"expired\" | \"disabled\";",
  "new_string": "/** Outcomes of a redemption attempt (mirrors redeem_campaign_code in SQL). */\nexport type RedeemOutcome = \"success\" | \"not_found\" | \"disabled\" | \"expired\" | \"exhausted\";\n\nexport type CampaignStatus = \"active\" | \"exhausted\" | \"expired\" | \"disabled\";"
}
```


### 👤 User *(2026-07-04 16:03:07)*

**Tool Result (✅ Success - ID: `toolu_01F8ssNdiaEyQ3EEfmTZWHkK`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\lib\trialLogic.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:03:29)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:03:30)*

Now the main `/try` page - business card always visible, scan + manual paths, all redemption states:


### 🤖 Claude *(2026-07-04 16:04:20)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01XPc8GEn5wqXZBehaNZFB44`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\App.tsx",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * /try - the 2-in-1 business card. One QR + short code does two jobs:\n *   1. Business card: PANIK website + X, ALWAYS visible (every code state).\n *   2. Trial code: \"Try Now\" redeems a campaign code and mints the visitor a\n *      unique, expiring link into the core app (/app?trial=PANIK-XXXXXX).\n *\n * Two paths (see redeem_campaign_code): the SCAN path auto-detects ?code= from\n * the QR URL for a one-tap redemption; the NO-SCAN fallback reveals a manual\n * \"Enter your code\" input for the printed short code. Limit checks happen only\n * on the redemption attempt - idle scans never burn the usage count.\n */\n\nimport { useEffect, useRef, useState } from \"react\";\nimport { Globe, ArrowRight, Copy, Check, Loader2, Ticket, AlertCircle } from \"lucide-react\";\nimport { BUSINESS_CARD } from \"./businessCard\";\nimport { parseCode, normalizeCode, type RedeemOutcome } from \"./lib/trialLogic\";\nimport { redeemCode } from \"./lib/api\";\n\ntype Phase = \"idle\" | \"manual\" | \"submitting\" | \"success\" | \"invalid\" | \"error\";\n\nconst INVALID_COPY: Record<Exclude<RedeemOutcome, \"success\">, { title: string; sub: string }> = {\n  not_found: { title: \"Code not found\", sub: \"Double-check the code on your card and try again.\" },\n  disabled: { title: \"This code is turned off\", sub: \"The campaign behind this code is no longer active.\" },\n  expired: { title: \"This code has expired\", sub: \"Its time window has closed. Reach out for a fresh one.\" },\n  exhausted: { title: \"This code is used up\", sub: \"It reached its redemption limit. Reach out for a fresh one.\" },\n};\n\nexport default function App() {\n  const [mounted, setMounted] = useState(false);\n  const [detectedCode] = useState<string | null>(() =>\n    typeof window !== \"undefined\" ? parseCode(window.location.search) : null,\n  );\n  const [phase, setPhase] = useState<Phase>(\"idle\");\n  const [manualCode, setManualCode] = useState(\"\");\n  const [trialUrl, setTrialUrl] = useState<string | null>(null);\n  const [invalidOutcome, setInvalidOutcome] = useState<Exclude<RedeemOutcome, \"success\">>(\"not_found\");\n  const [errorMsg, setErrorMsg] = useState<string>(\"\");\n  const [copied, setCopied] = useState(false);\n  const honeypotRef = useRef<HTMLInputElement>(null);\n  const manualInputRef = useRef<HTMLInputElement>(null);\n\n  useEffect(() => setMounted(true), []);\n\n  const absoluteTrialUrl = trialUrl\n    ? `${typeof window !== \"undefined\" ? window.location.origin : \"\"}${trialUrl}`\n    : \"\";\n\n  async function submit(code: string): Promise<void> {\n    const clean = normalizeCode(code);\n    if (!clean) {\n      manualInputRef.current?.focus();\n      return;\n    }\n    setPhase(\"submitting\");\n    const res = await redeemCode(clean, honeypotRef.current?.value ?? \"\");\n    if (res.ok && res.trialUrl) {\n      setTrialUrl(res.trialUrl);\n      setPhase(\"success\");\n      return;\n    }\n    if (res.outcome && res.outcome !== \"success\") {\n      setInvalidOutcome(res.outcome);\n      setPhase(\"invalid\");\n      return;\n    }\n    setErrorMsg(res.error === \"network\" ? \"Network error - check your connection and retry.\" : \"Something went wrong. Please retry.\");\n    setPhase(\"error\");\n  }\n\n  function onTryNow(): void {\n    if (detectedCode) return void submit(detectedCode);\n    if (phase !== \"manual\") {\n      setPhase(\"manual\");\n      setTimeout(() => manualInputRef.current?.focus(), 50);\n      return;\n    }\n    void submit(manualCode);\n  }\n\n  async function copyLink(): Promise<void> {\n    try {\n      await navigator.clipboard.writeText(absoluteTrialUrl);\n      setCopied(true);\n      setTimeout(() => setCopied(false), 1800);\n    } catch {\n      /* clipboard blocked - user can still tap the button link */\n    }\n  }\n\n  function resetToIdle(): void {\n    setPhase(detectedCode ? \"idle\" : \"manual\");\n    setErrorMsg(\"\");\n  }\n\n  const fade = (delay: string) =>\n    `transition-all duration-700 ${delay} ${mounted ? \"opacity-100 translate-y-0\" : \"opacity-0 translate-y-4\"}`;\n\n  return (\n    <div className=\"relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] selection:bg-panik-orange/30 selection:text-white overflow-x-clip\">\n      {/* Ambient background */}\n      <div className=\"fixed inset-0 pointer-events-none z-0\">\n        <div className=\"absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-gradient-to-b from-orange-500/[0.05] via-orange-600/[0.02] to-transparent blur-3xl\" />\n      </div>\n      <div className=\"fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-50\" />\n\n      <main className=\"relative z-10 max-w-md mx-auto px-6 py-14 md:py-20 flex flex-col gap-6\">\n        {/* Brand mark */}\n        <div className={`flex items-center gap-2.5 justify-center ${fade(\"delay-0\")}`}>\n          <div className=\"w-9 h-9 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center font-display font-bold text-white shadow-lg shadow-orange-500/20\">\n            P\n          </div>\n          <span className=\"font-display font-semibold text-xl tracking-tight text-white/90\">PANIK</span>\n        </div>\n\n        {/* \u2500\u2500 Redemption panel (the interactive half) \u2500\u2500 */}\n        <section className={`panik-glass rounded-2xl p-6 md:p-7 ${fade(\"delay-100\")}`}>\n          {/* Honeypot - real users never see or fill this. */}\n          <input\n            ref={honeypotRef}\n            type=\"text\"\n            name=\"company_website\"\n            tabIndex={-1}\n            autoComplete=\"off\"\n            aria-hidden=\"true\"\n            className=\"hidden\"\n          />\n\n          {phase === \"success\" ? (\n            <div className=\"text-center\">\n              <div className=\"mx-auto w-12 h-12 rounded-full bg-orange-500/15 flex items-center justify-center mb-4\">\n                <Check className=\"w-6 h-6 text-orange-400\" />\n              </div>\n              <h1 className=\"font-display text-xl font-bold text-white mb-1.5\">You're in.</h1>\n              <p className=\"text-sm text-white/50 leading-relaxed mb-5\">\n                Here's your personal access link. It's unique to you and the trial\n                clock starts the moment you open the app.\n              </p>\n              <div className=\"flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 mb-4\">\n                <span className=\"font-mono text-xs text-white/60 truncate flex-1 text-left\">{absoluteTrialUrl}</span>\n                <button\n                  onClick={copyLink}\n                  className=\"shrink-0 text-white/40 hover:text-orange-400 transition-colors\"\n                  aria-label=\"Copy link\"\n                >\n                  {copied ? <Check className=\"w-4 h-4 text-orange-400\" /> : <Copy className=\"w-4 h-4\" />}\n                </button>\n              </div>\n              <a\n                href={trialUrl ?? \"/app\"}\n                className=\"group flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all\"\n              >\n                Open the PANIK app\n                <ArrowRight className=\"w-4 h-4 group-hover:translate-x-0.5 transition-transform\" />\n              </a>\n            </div>\n          ) : phase === \"invalid\" ? (\n            <div className=\"text-center\">\n              <div className=\"mx-auto w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center mb-4\">\n                <AlertCircle className=\"w-6 h-6 text-red-400\" />\n              </div>\n              <h1 className=\"font-display text-xl font-bold text-white mb-1.5\">{INVALID_COPY[invalidOutcome].title}</h1>\n              <p className=\"text-sm text-white/50 leading-relaxed mb-5\">{INVALID_COPY[invalidOutcome].sub}</p>\n              <button\n                onClick={resetToIdle}\n                className=\"w-full rounded-xl border border-white/12 bg-white/[0.03] px-5 py-3 font-medium text-white/80 hover:bg-white/[0.06] transition-colors\"\n              >\n                Enter a different code\n              </button>\n            </div>\n          ) : (\n            <div>\n              <div className=\"flex items-center gap-2 mb-1.5\">\n                <Ticket className=\"w-4 h-4 text-orange-400\" />\n                <h1 className=\"font-display text-lg font-bold text-white\">Try PANIK free</h1>\n              </div>\n              <p className=\"text-sm text-white/45 leading-relaxed mb-5\">\n                {detectedCode\n                  ? \"Your card's code is ready. One tap starts your trial.\"\n                  : \"Tap below and enter the code printed on your card to start your trial.\"}\n              </p>\n\n              {detectedCode && (\n                <div className=\"flex items-center gap-2 rounded-lg border border-orange-500/20 bg-orange-500/[0.06] px-3 py-2.5 mb-4\">\n                  <span className=\"text-xs font-mono uppercase tracking-wide text-orange-300/80\">Code detected</span>\n                  <span className=\"font-mono text-sm text-white/90 ml-auto\">{detectedCode}</span>\n                </div>\n              )}\n\n              {phase === \"manual\" && !detectedCode && (\n                <input\n                  ref={manualInputRef}\n                  value={manualCode}\n                  onChange={(e) => setManualCode(e.target.value.toUpperCase())}\n                  onKeyDown={(e) => e.key === \"Enter\" && submit(manualCode)}\n                  placeholder=\"PANIK-TRY-XXXX\"\n                  spellCheck={false}\n                  autoCapitalize=\"characters\"\n                  className=\"w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2.5 mb-4 font-mono text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors\"\n                />\n              )}\n\n              {phase === \"error\" && (\n                <p className=\"text-xs text-red-400/90 mb-3 text-center\">{errorMsg}</p>\n              )}\n\n              <button\n                onClick={onTryNow}\n                disabled={phase === \"submitting\"}\n                className=\"group flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed\"\n              >\n                {phase === \"submitting\" ? (\n                  <>\n                    <Loader2 className=\"w-4 h-4 animate-spin\" /> Checking\u2026\n                  </>\n                ) : (\n                  <>\n                    Try Now\n                    <ArrowRight className=\"w-4 h-4 group-hover:translate-x-0.5 transition-transform\" />\n                  </>\n                )}\n              </button>\n            </div>\n          )}\n        </section>\n\n        {/* \u2500\u2500 Business card (ALWAYS visible, every code state) \u2500\u2500 */}\n        <section className={`panik-glass rounded-2xl p-6 ${fade(\"delay-200\")}`}>\n          <p className=\"text-[11px] font-mono uppercase tracking-widest text-white/30 mb-3\">Business card</p>\n          <h2 className=\"font-display text-lg font-semibold text-white/90\">{BUSINESS_CARD.name}</h2>\n          <p className=\"text-sm text-white/45 mb-4\">{BUSINESS_CARD.tagline}</p>\n          <div className=\"flex flex-col gap-2.5\">\n            <a\n              href={BUSINESS_CARD.websiteUrl}\n              target=\"_blank\"\n              rel=\"noopener noreferrer\"\n              className=\"group flex items-center gap-3 text-sm text-white/70 hover:text-orange-300 transition-colors\"\n            >\n              <Globe className=\"w-4 h-4 text-white/40 group-hover:text-orange-400 transition-colors\" />\n              {BUSINESS_CARD.website}\n            </a>\n            <a\n              href={BUSINESS_CARD.twitterUrl}\n              target=\"_blank\"\n              rel=\"noopener noreferrer\"\n              className=\"group flex items-center gap-3 text-sm text-white/70 hover:text-orange-300 transition-colors\"\n            >\n              <svg className=\"w-4 h-4 text-white/40 group-hover:text-orange-400 transition-colors\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\">\n                <path d=\"M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z\" />\n              </svg>\n              {BUSINESS_CARD.twitterHandle}\n            </a>\n          </div>\n        </section>\n\n        <p className={`text-center text-[11px] text-white/25 ${fade(\"delay-300\")}`}>\u00a9 2026 PANIK</p>\n      </main>\n    </div>\n  );\n}\n"
}
```


### 👤 User *(2026-07-04 16:04:21)*

**Tool Result (✅ Success - ID: `toolu_01XPc8GEn5wqXZBehaNZFB44`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\App.tsx (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:04:24)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01RgsfifPGVZHWM6e5vGPQMH`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\main.tsx",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n */\n\nimport { StrictMode } from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport App from \"./App\";\nimport \"../index.css\";\n\ncreateRoot(document.getElementById(\"root\")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n"
}
```


### 👤 User *(2026-07-04 16:04:26)*

**Tool Result (✅ Success - ID: `toolu_01RgsfifPGVZHWM6e5vGPQMH`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\main.tsx (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:04:33)*

**🛠️ Tool Call:** `Write` (ID: `toolu_015SdrYsXAr8TwBk6HgS7rAP`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\try.html",
  "content": "<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <meta name=\"robots\" content=\"noindex, nofollow\" />\n    <meta name=\"description\" content=\"Redeem your PANIK trial code and start your free access.\" />\n    <title>PANIK \u2014 Try Now</title>\n    <link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\" />\n    <link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"/favicon-32.png\" />\n    <link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/apple-touch-icon.png\" />\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/panik-try/main.tsx\"></script>\n  </body>\n</html>\n"
}
```


### 👤 User *(2026-07-04 16:04:33)*

**Tool Result (❌ Error - ID: `toolu_015SdrYsXAr8TwBk6HgS7rAP`):**
```
WiBiz house style (hard rule): em dashes and en dashes are banned. Replace the long dash with a hyphen (-) and retry. If the dash is genuinely required (for example when documenting this rule), wrap it in inline-code backticks.
```


### 🤖 Claude *(2026-07-04 16:04:39)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:04:39)*

House-style hook caught the em dash in the title. Fixing:


### 🤖 Claude *(2026-07-04 16:04:42)*

**🛠️ Tool Call:** `Write` (ID: `toolu_0131pAa5QP44qhcnpqztKGWy`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\try.html",
  "content": "<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <meta name=\"robots\" content=\"noindex, nofollow\" />\n    <meta name=\"description\" content=\"Redeem your PANIK trial code and start your free access.\" />\n    <title>PANIK - Try Now</title>\n    <link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\" />\n    <link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"/favicon-32.png\" />\n    <link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/apple-touch-icon.png\" />\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/panik-try/main.tsx\"></script>\n  </body>\n</html>\n"
}
```


### 👤 User *(2026-07-04 16:04:43)*

**Tool Result (✅ Success - ID: `toolu_0131pAa5QP44qhcnpqztKGWy`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\try.html (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:05:06)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:05:06)*

Now the admin page. First the admin API client:


### 🤖 Claude *(2026-07-04 16:05:16)*

**🛠️ Tool Call:** `Write` (ID: `toolu_0187Ur8FPfaMcfonbRxVFci7`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\lib\\adminApi.ts",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * Admin client for /api/admin/campaigns. The admin secret (ADMIN_ACCESS_KEY) is\n * held in sessionStorage and sent as the X-Admin-Key header on every call - the\n * same header-secret gate the backend checks (server/adminCampaigns.ts).\n */\n\n/** Frontend copy of the campaign row shape (server type lives in campaignStore). */\nexport interface Campaign {\n  id: string;\n  campaign_code: string;\n  label: string | null;\n  max_redemptions: number;\n  redemption_count: number;\n  trial_duration_hours: number;\n  claim_window_expires_at: string | null;\n  is_active: boolean;\n  created_at: string;\n  updated_at: string;\n}\n\nexport interface CreateInput {\n  label?: string;\n  trialDays: number;\n  maxRedemptions: number;\n  claimWindowDays?: number;\n}\n\nconst KEY_STORAGE = \"panik_admin_key\";\n\nexport const getStoredKey = (): string => sessionStorage.getItem(KEY_STORAGE) ?? \"\";\nexport const setStoredKey = (k: string): void => sessionStorage.setItem(KEY_STORAGE, k);\nexport const clearStoredKey = (): void => sessionStorage.removeItem(KEY_STORAGE);\n\nexport interface ApiResult<T> {\n  ok: boolean;\n  status: number;\n  data?: T;\n  error?: string;\n}\n\nasync function call<T>(path: string, key: string, init?: RequestInit): Promise<ApiResult<T>> {\n  try {\n    const res = await fetch(path, {\n      ...init,\n      headers: { \"Content-Type\": \"application/json\", \"X-Admin-Key\": key, ...(init?.headers ?? {}) },\n    });\n    const body = (await res.json().catch(() => ({}))) as T & { error?: string };\n    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `http_${res.status}` };\n    return { ok: true, status: res.status, data: body };\n  } catch {\n    return { ok: false, status: 0, error: \"network\" };\n  }\n}\n\nexport const listCampaigns = (key: string) =>\n  call<{ campaigns: Campaign[] }>(\"/api/admin/campaigns\", key);\n\nexport const createCampaign = (key: string, input: CreateInput) =>\n  call<{ campaign: Campaign }>(\"/api/admin/campaigns\", key, {\n    method: \"POST\",\n    body: JSON.stringify(input),\n  });\n\nexport const expireCampaign = (key: string, id: string) =>\n  call<{ campaign: Campaign }>(\"/api/admin/campaigns?action=expire\", key, {\n    method: \"POST\",\n    body: JSON.stringify({ id }),\n  });\n"
}
```


### 👤 User *(2026-07-04 16:05:21)*

**Tool Result (✅ Success - ID: `toolu_0187Ur8FPfaMcfonbRxVFci7`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-admin\lib\adminApi.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:05:32)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:05:32)*

Now the admin dashboard page (QR generation, live status, create/expire):


### 🤖 Claude *(2026-07-04 16:06:28)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01QcETJ3qpochUZvhzPiHgKU`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\App.tsx",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * /admin - hidden, secret-gated console for campaign trial cards (\"Neithan\").\n * Create a campaign (duration + max users), watch live status, download the QR\n * for printing, and expire a code early. All calls carry the X-Admin-Key header;\n * the secret never leaves sessionStorage. See server/adminCampaigns.ts.\n */\n\nimport { useCallback, useEffect, useState } from \"react\";\nimport QRCode from \"qrcode\";\nimport { Loader2, Plus, RefreshCw, Ban, Download, Copy, Check, QrCode, Lock } from \"lucide-react\";\nimport {\n  clearStoredKey,\n  createCampaign,\n  expireCampaign,\n  getStoredKey,\n  listCampaigns,\n  setStoredKey,\n  type Campaign,\n  type CreateInput,\n} from \"./lib/adminApi\";\nimport { evaluateCampaign, formatRemaining, type CampaignStatus } from \"../panik-try/lib/trialLogic\";\n\nconst STATUS_BADGE: Record<CampaignStatus, string> = {\n  active: \"bg-emerald-500/10 text-emerald-400 border-emerald-500/25\",\n  exhausted: \"bg-amber-500/10 text-amber-400 border-amber-500/25\",\n  expired: \"bg-red-500/10 text-red-400 border-red-500/25\",\n  disabled: \"bg-white/10 text-white/40 border-white/20\",\n};\n\nfunction tryUrl(code: string): string {\n  return `${window.location.origin}/try?code=${code}`;\n}\n\n// \u2500\u2500 Key gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction KeyGate({ onUnlock }: { onUnlock: (key: string) => void }) {\n  const [key, setKey] = useState(\"\");\n  const [error, setError] = useState(\"\");\n  const [busy, setBusy] = useState(false);\n\n  async function submit() {\n    if (!key.trim()) return;\n    setBusy(true);\n    setError(\"\");\n    const res = await listCampaigns(key.trim());\n    setBusy(false);\n    if (res.ok) {\n      setStoredKey(key.trim());\n      onUnlock(key.trim());\n    } else if (res.status === 401) {\n      setError(\"That key was rejected.\");\n    } else if (res.status === 503) {\n      setError(\"Admin is not configured on the server (ADMIN_ACCESS_KEY).\");\n    } else {\n      setError(res.error ?? \"Could not reach the server.\");\n    }\n  }\n\n  return (\n    <div className=\"min-h-screen flex items-center justify-center px-6\">\n      <div className=\"panik-glass rounded-2xl p-7 w-full max-w-sm\">\n        <div className=\"flex items-center gap-2 mb-5\">\n          <Lock className=\"w-4 h-4 text-orange-400\" />\n          <h1 className=\"font-display text-lg font-bold text-white\">PANIK admin</h1>\n        </div>\n        <input\n          type=\"password\"\n          value={key}\n          onChange={(e) => setKey(e.target.value)}\n          onKeyDown={(e) => e.key === \"Enter\" && submit()}\n          placeholder=\"Admin access key\"\n          className=\"w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2.5 mb-3 font-mono text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors\"\n        />\n        {error && <p className=\"text-xs text-red-400/90 mb-3\">{error}</p>}\n        <button\n          onClick={submit}\n          disabled={busy}\n          className=\"flex items-center justify-center gap-2 w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-3 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-60\"\n        >\n          {busy ? <Loader2 className=\"w-4 h-4 animate-spin\" /> : \"Unlock\"}\n        </button>\n      </div>\n    </div>\n  );\n}\n\n// \u2500\u2500 QR block (generated client-side, printable) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction QrBlock({ code }: { code: string }) {\n  const [dataUrl, setDataUrl] = useState<string>(\"\");\n  const [copied, setCopied] = useState(false);\n  const url = tryUrl(code);\n\n  useEffect(() => {\n    QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: \"#0A0A0B\", light: \"#FFFFFF\" } })\n      .then(setDataUrl)\n      .catch(() => setDataUrl(\"\"));\n  }, [url]);\n\n  async function copy() {\n    try {\n      await navigator.clipboard.writeText(url);\n      setCopied(true);\n      setTimeout(() => setCopied(false), 1500);\n    } catch { /* ignore */ }\n  }\n\n  return (\n    <div className=\"mt-3 rounded-xl border border-white/10 bg-black/20 p-4 flex flex-col sm:flex-row items-center gap-4\">\n      {dataUrl ? (\n        <img src={dataUrl} alt={`QR for ${code}`} className=\"w-32 h-32 rounded-lg bg-white p-1 shrink-0\" />\n      ) : (\n        <div className=\"w-32 h-32 rounded-lg bg-white/5 flex items-center justify-center shrink-0\">\n          <Loader2 className=\"w-5 h-5 animate-spin text-white/30\" />\n        </div>\n      )}\n      <div className=\"flex-1 min-w-0 w-full\">\n        <p className=\"text-[11px] font-mono uppercase tracking-widest text-white/30 mb-1\">Print URL</p>\n        <p className=\"font-mono text-xs text-white/70 break-all mb-3\">{url}</p>\n        <div className=\"flex flex-wrap gap-2\">\n          <a\n            href={dataUrl || \"#\"}\n            download={`${code}.png`}\n            className={`flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors ${dataUrl ? \"\" : \"pointer-events-none opacity-50\"}`}\n          >\n            <Download className=\"w-3.5 h-3.5\" /> QR PNG\n          </a>\n          <button\n            onClick={copy}\n            className=\"flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors\"\n          >\n            {copied ? <Check className=\"w-3.5 h-3.5 text-orange-400\" /> : <Copy className=\"w-3.5 h-3.5\" />} URL\n          </button>\n        </div>\n      </div>\n    </div>\n  );\n}\n\n// \u2500\u2500 Create form \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction CreateForm({ apiKey, onCreated }: { apiKey: string; onCreated: (c: Campaign) => void }) {\n  const [label, setLabel] = useState(\"\");\n  const [trialDays, setTrialDays] = useState(\"3\");\n  const [maxRedemptions, setMaxRedemptions] = useState(\"20\");\n  const [claimWindowDays, setClaimWindowDays] = useState(\"\");\n  const [busy, setBusy] = useState(false);\n  const [error, setError] = useState(\"\");\n\n  async function submit() {\n    setBusy(true);\n    setError(\"\");\n    const input: CreateInput = {\n      label: label.trim() || undefined,\n      trialDays: Number(trialDays),\n      maxRedemptions: Number(maxRedemptions),\n      claimWindowDays: claimWindowDays.trim() ? Number(claimWindowDays) : undefined,\n    };\n    const res = await createCampaign(apiKey, input);\n    setBusy(false);\n    if (res.ok && res.data) {\n      onCreated(res.data.campaign);\n      setLabel(\"\");\n    } else {\n      setError(res.error ?? \"Create failed.\");\n    }\n  }\n\n  const field = \"w-full rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25 outline-none focus:border-orange-500/40 transition-colors\";\n\n  return (\n    <div className=\"panik-glass rounded-2xl p-6 mb-8\">\n      <h2 className=\"font-display text-base font-semibold text-white/90 mb-4 flex items-center gap-2\">\n        <Plus className=\"w-4 h-4 text-orange-400\" /> New campaign\n      </h2>\n      <div className=\"grid sm:grid-cols-2 gap-3 mb-4\">\n        <div className=\"sm:col-span-2\">\n          <label className=\"block text-xs text-white/40 mb-1\">Label (internal note)</label>\n          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder=\"e.g. ETHDenver booth cards\" className={field} />\n        </div>\n        <div>\n          <label className=\"block text-xs text-white/40 mb-1\">Trial duration (days per user)</label>\n          <input value={trialDays} onChange={(e) => setTrialDays(e.target.value)} type=\"number\" min=\"1\" className={field} />\n        </div>\n        <div>\n          <label className=\"block text-xs text-white/40 mb-1\">Max redemptions (users)</label>\n          <input value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} type=\"number\" min=\"1\" className={field} />\n        </div>\n        <div className=\"sm:col-span-2\">\n          <label className=\"block text-xs text-white/40 mb-1\">Claim window (days, optional - deadline to redeem the card)</label>\n          <input value={claimWindowDays} onChange={(e) => setClaimWindowDays(e.target.value)} type=\"number\" min=\"1\" placeholder=\"Leave blank for no deadline\" className={field} />\n        </div>\n      </div>\n      {error && <p className=\"text-xs text-red-400/90 mb-3\">{error}</p>}\n      <button\n        onClick={submit}\n        disabled={busy}\n        className=\"flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-2.5 font-semibold text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 transition-all disabled:opacity-60\"\n      >\n        {busy ? <Loader2 className=\"w-4 h-4 animate-spin\" /> : \"Create campaign\"}\n      </button>\n    </div>\n  );\n}\n\n// \u2500\u2500 Campaign row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction CampaignRow({ c, apiKey, onChange }: { c: Campaign; apiKey: string; onChange: (c: Campaign) => void }) {\n  const [showQr, setShowQr] = useState(false);\n  const [busy, setBusy] = useState(false);\n  const status = evaluateCampaign(c);\n  const claimRemaining = c.claim_window_expires_at\n    ? formatRemaining(new Date(c.claim_window_expires_at).getTime() - Date.now())\n    : \"no deadline\";\n\n  async function expire() {\n    if (!confirm(`Expire ${c.campaign_code} now? Existing trials keep working; no new redemptions.`)) return;\n    setBusy(true);\n    const res = await expireCampaign(apiKey, c.id);\n    setBusy(false);\n    if (res.ok && res.data) onChange(res.data.campaign);\n  }\n\n  return (\n    <div className=\"panik-glass rounded-xl p-4 mb-3\">\n      <div className=\"flex flex-wrap items-center gap-3\">\n        <span className=\"font-mono text-sm text-white/90\">{c.campaign_code}</span>\n        <span className={`text-[11px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_BADGE[status]}`}>\n          {status}\n        </span>\n        {c.label && <span className=\"text-xs text-white/40 truncate\">{c.label}</span>}\n        <div className=\"ml-auto flex items-center gap-2\">\n          <button\n            onClick={() => setShowQr((v) => !v)}\n            className=\"flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/[0.06] transition-colors\"\n          >\n            <QrCode className=\"w-3.5 h-3.5\" /> QR\n          </button>\n          {c.is_active && (\n            <button\n              onClick={expire}\n              disabled={busy}\n              className=\"flex items-center gap-1.5 rounded-lg border border-red-500/25 text-red-400/90 px-2.5 py-1.5 text-xs hover:bg-red-500/10 transition-colors disabled:opacity-50\"\n            >\n              {busy ? <Loader2 className=\"w-3.5 h-3.5 animate-spin\" /> : <Ban className=\"w-3.5 h-3.5\" />} Expire\n            </button>\n          )}\n        </div>\n      </div>\n      <div className=\"mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-white/45\">\n        <span>Used <span className=\"text-white/80 font-mono\">{c.redemption_count}/{c.max_redemptions}</span></span>\n        <span>Trial <span className=\"text-white/80 font-mono\">{c.trial_duration_hours}h</span></span>\n        <span>Claim window <span className=\"text-white/80 font-mono\">{claimRemaining}</span></span>\n        <span>Created <span className=\"text-white/80 font-mono\">{new Date(c.created_at).toLocaleDateString()}</span></span>\n      </div>\n      {showQr && <QrBlock code={c.campaign_code} />}\n    </div>\n  );\n}\n\n// \u2500\u2500 Dashboard \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction Dashboard({ apiKey, onLock }: { apiKey: string; onLock: () => void }) {\n  const [campaigns, setCampaigns] = useState<Campaign[]>([]);\n  const [loading, setLoading] = useState(true);\n  const [error, setError] = useState(\"\");\n\n  const refresh = useCallback(async () => {\n    setLoading(true);\n    const res = await listCampaigns(apiKey);\n    setLoading(false);\n    if (res.ok && res.data) {\n      setCampaigns(res.data.campaigns);\n      setError(\"\");\n    } else if (res.status === 401) {\n      onLock();\n    } else {\n      setError(res.error ?? \"Could not load campaigns.\");\n    }\n  }, [apiKey, onLock]);\n\n  useEffect(() => {\n    void refresh();\n  }, [refresh]);\n\n  function upsert(c: Campaign) {\n    setCampaigns((prev) => {\n      const i = prev.findIndex((x) => x.id === c.id);\n      if (i === -1) return [c, ...prev];\n      const next = [...prev];\n      next[i] = c;\n      return next;\n    });\n  }\n\n  return (\n    <main className=\"relative z-10 max-w-3xl mx-auto px-6 py-12\">\n      <div className=\"flex items-center justify-between mb-8\">\n        <div className=\"flex items-center gap-2.5\">\n          <div className=\"w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center font-display font-bold text-sm text-white\">P</div>\n          <span className=\"font-display font-semibold text-lg text-white/90\">Admin</span>\n        </div>\n        <div className=\"flex items-center gap-2\">\n          <button onClick={refresh} className=\"flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] transition-colors\">\n            <RefreshCw className={`w-3.5 h-3.5 ${loading ? \"animate-spin\" : \"\"}`} /> Refresh\n          </button>\n          <button onClick={onLock} className=\"rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/50 hover:bg-white/[0.06] transition-colors\">\n            Lock\n          </button>\n        </div>\n      </div>\n\n      <CreateForm apiKey={apiKey} onCreated={upsert} />\n\n      <h2 className=\"font-display text-base font-semibold text-white/90 mb-4\">Campaigns</h2>\n      {error && <p className=\"text-sm text-red-400/90 mb-4\">{error}</p>}\n      {loading && campaigns.length === 0 ? (\n        <div className=\"flex items-center gap-2 text-white/40 text-sm\"><Loader2 className=\"w-4 h-4 animate-spin\" /> Loading\u2026</div>\n      ) : campaigns.length === 0 ? (\n        <p className=\"text-sm text-white/40\">No campaigns yet. Create one above.</p>\n      ) : (\n        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)\n      )}\n    </main>\n  );\n}\n\nexport default function App() {\n  const [apiKey, setApiKey] = useState<string>(() => getStoredKey());\n\n  function lock() {\n    clearStoredKey();\n    setApiKey(\"\");\n  }\n\n  return (\n    <div className=\"relative min-h-screen bg-[#0A0A0B] text-[#F0F4FF] overflow-x-clip\">\n      <div className=\"fixed inset-0 panik-dot-bg pointer-events-none z-0 opacity-40\" />\n      {apiKey ? <Dashboard apiKey={apiKey} onLock={lock} /> : <KeyGate onUnlock={setApiKey} />}\n    </div>\n  );\n}\n"
}
```


### 👤 User *(2026-07-04 16:06:30)*

**Tool Result (✅ Success - ID: `toolu_01QcETJ3qpochUZvhzPiHgKU`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-admin\App.tsx (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:06:36)*

**🛠️ Tool Call:** `Write` (ID: `toolu_019SrJd4gv4CKpirYmLEHrXK`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\main.tsx",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n */\n\nimport { StrictMode } from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport App from \"./App\";\nimport \"../index.css\";\n\ncreateRoot(document.getElementById(\"root\")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n"
}
```


### 👤 User *(2026-07-04 16:06:37)*

**Tool Result (✅ Success - ID: `toolu_019SrJd4gv4CKpirYmLEHrXK`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-admin\main.tsx (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:06:42)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01QixxPGtrX9vBYbi2hGsmsW`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\admin.html",
  "content": "<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    <meta name=\"robots\" content=\"noindex, nofollow\" />\n    <meta name=\"description\" content=\"PANIK internal admin.\" />\n    <title>PANIK - Admin</title>\n    <link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\" />\n    <link rel=\"icon\" type=\"image/png\" sizes=\"32x32\" href=\"/favicon-32.png\" />\n    <link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/apple-touch-icon.png\" />\n  </head>\n  <body>\n    <div id=\"root\"></div>\n    <script type=\"module\" src=\"/src/panik-admin/main.tsx\"></script>\n  </body>\n</html>\n"
}
```


### 👤 User *(2026-07-04 16:06:43)*

**Tool Result (✅ Success - ID: `toolu_01QixxPGtrX9vBYbi2hGsmsW`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\admin.html (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:06:54)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:06:54)*

Now the core-app trial-awareness banner. Creating the component:


### 🤖 Claude *(2026-07-04 16:07:11)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01DzkcWBhLTUnFdpqZtmKBuH`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core\\components\\TrialBanner.tsx",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * Trial-awareness pill for the core app. When /app is opened with a per-user\n * link (/app?trial=PANIK-XXXXXX), this validates the token via /api/try/access\n * - which STARTS the per-user clock on the first open - and shows the remaining\n * time (or an expired/invalid state with a path back to /try).\n *\n * Non-blocking by design: the demo app stays usable; this only surfaces trial\n * status. (Hard-locking /app for non-trial visitors is a deliberate follow-up.)\n */\n\nimport { useEffect, useState } from \"react\";\nimport { Clock, AlertCircle, X } from \"lucide-react\";\nimport { formatRemaining, parseCode } from \"../../panik-try/lib/trialLogic\";\n\ntype State =\n  | { kind: \"none\" }\n  | { kind: \"loading\" }\n  | { kind: \"active\"; expiresAt: string | null }\n  | { kind: \"expired\" }\n  | { kind: \"invalid\" };\n\nfunction tokenFromUrl(): string | null {\n  if (typeof window === \"undefined\") return null;\n  // Reuse the same query parser; the param here is `trial`, not `code`.\n  const raw = new URLSearchParams(window.location.search).get(\"trial\");\n  return parseCode(raw ? `code=${raw}` : \"\");\n}\n\nexport function TrialBanner() {\n  const [state, setState] = useState<State>({ kind: \"none\" });\n  const [dismissed, setDismissed] = useState(false);\n  const [, tick] = useState(0);\n\n  useEffect(() => {\n    const token = tokenFromUrl();\n    if (!token) return;\n    setState({ kind: \"loading\" });\n    let cancelled = false;\n    void (async () => {\n      try {\n        const res = await fetch(\"/api/try/access\", {\n          method: \"POST\",\n          headers: { \"Content-Type\": \"application/json\" },\n          body: JSON.stringify({ token }),\n        });\n        const body = (await res.json().catch(() => ({}))) as { outcome?: string; expiresAt?: string | null };\n        if (cancelled) return;\n        if (body.outcome === \"active\") setState({ kind: \"active\", expiresAt: body.expiresAt ?? null });\n        else if (body.outcome === \"expired\") setState({ kind: \"expired\" });\n        else setState({ kind: \"invalid\" });\n      } catch {\n        if (!cancelled) setState({ kind: \"invalid\" });\n      }\n    })();\n    return () => { cancelled = true; };\n  }, []);\n\n  // Re-render every 30s so the countdown label stays fresh.\n  useEffect(() => {\n    if (state.kind !== \"active\") return;\n    const id = setInterval(() => tick((n) => n + 1), 30_000);\n    return () => clearInterval(id);\n  }, [state.kind]);\n\n  if (dismissed || state.kind === \"none\" || state.kind === \"loading\") return null;\n\n  if (state.kind === \"active\") {\n    const remainingMs = state.expiresAt ? new Date(state.expiresAt).getTime() - Date.now() : 0;\n    // If the clock ran out while the tab was open, flip to expired.\n    if (state.expiresAt && remainingMs <= 0) { setState({ kind: \"expired\" }); return null; }\n    return (\n      <div className=\"fixed bottom-4 left-1/2 -translate-x-1/2 z-[9998] panik-glass rounded-full pl-4 pr-3 py-2 flex items-center gap-2.5 shadow-lg\">\n        <Clock className=\"w-4 h-4 text-orange-400\" />\n        <span className=\"text-xs text-white/70\">\n          Trial active\n          {state.expiresAt && <span className=\"text-white/90 font-mono\"> \u00b7 {formatRemaining(remainingMs)} left</span>}\n        </span>\n        <button onClick={() => setDismissed(true)} className=\"text-white/30 hover:text-white/60 transition-colors\" aria-label=\"Dismiss\">\n          <X className=\"w-3.5 h-3.5\" />\n        </button>\n      </div>\n    );\n  }\n\n  // expired | invalid\n  return (\n    <div className=\"fixed bottom-4 left-1/2 -translate-x-1/2 z-[9998] panik-glass rounded-full pl-4 pr-3 py-2 flex items-center gap-2.5 shadow-lg\">\n      <AlertCircle className=\"w-4 h-4 text-red-400\" />\n      <span className=\"text-xs text-white/70\">\n        {state.kind === \"expired\" ? \"Your trial has expired.\" : \"Trial link isn't valid.\"}\n      </span>\n      <a href=\"/try\" className=\"text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors\">Get access</a>\n      <button onClick={() => setDismissed(true)} className=\"text-white/30 hover:text-white/60 transition-colors\" aria-label=\"Dismiss\">\n        <X className=\"w-3.5 h-3.5\" />\n      </button>\n    </div>\n  );\n}\n"
}
```


### 👤 User *(2026-07-04 16:07:12)*

**Tool Result (✅ Success - ID: `toolu_01DzkcWBhLTUnFdpqZtmKBuH`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-core\components\TrialBanner.tsx (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:07:19)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:07:19)*

Let me fix the setState-during-render in TrialBanner - move the expiry flip into the interval effect:


### 🤖 Claude *(2026-07-04 16:07:25)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01AFGK3FVJFHrGkzyYVoXhHH`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core\\components\\TrialBanner.tsx",
  "old_string": "  // Re-render every 30s so the countdown label stays fresh.\n  useEffect(() => {\n    if (state.kind !== \"active\") return;\n    const id = setInterval(() => tick((n) => n + 1), 30_000);\n    return () => clearInterval(id);\n  }, [state.kind]);\n\n  if (dismissed || state.kind === \"none\" || state.kind === \"loading\") return null;\n\n  if (state.kind === \"active\") {\n    const remainingMs = state.expiresAt ? new Date(state.expiresAt).getTime() - Date.now() : 0;\n    // If the clock ran out while the tab was open, flip to expired.\n    if (state.expiresAt && remainingMs <= 0) { setState({ kind: \"expired\" }); return null; }\n    return (",
  "new_string": "  // Re-render every 30s so the countdown stays fresh; flip to expired when the\n  // clock runs out while the tab is open.\n  useEffect(() => {\n    if (state.kind !== \"active\") return;\n    const id = setInterval(() => {\n      if (state.expiresAt && new Date(state.expiresAt).getTime() - Date.now() <= 0) {\n        setState({ kind: \"expired\" });\n      } else {\n        tick((n) => n + 1);\n      }\n    }, 30_000);\n    return () => clearInterval(id);\n  }, [state]);\n\n  if (dismissed || state.kind === \"none\" || state.kind === \"loading\") return null;\n\n  if (state.kind === \"active\") {\n    const remainingMs = state.expiresAt ? new Date(state.expiresAt).getTime() - Date.now() : 0;\n    return ("
}
```


### 👤 User *(2026-07-04 16:07:26)*

**Tool Result (✅ Success - ID: `toolu_01AFGK3FVJFHrGkzyYVoXhHH`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-core\components\TrialBanner.tsx has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:07:28)*

Now wire the banner into the core app's main.tsx:


### 🤖 Claude *(2026-07-04 16:07:31)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_011jjupr4YKMJjuY5rFSpZ3D`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core\\main.tsx",
  "old_string": "import { AppProviders } from \"./providers/AppProviders\";\nimport { AppDemo } from \"./AppDemo\";\nimport \"../index.css\";\n\ncreateRoot(document.getElementById(\"root\")!).render(\n  <StrictMode>\n    <AppProviders>\n      <AppDemo />\n    </AppProviders>\n  </StrictMode>,\n);",
  "new_string": "import { AppProviders } from \"./providers/AppProviders\";\nimport { AppDemo } from \"./AppDemo\";\nimport { TrialBanner } from \"./components/TrialBanner\";\nimport \"../index.css\";\n\ncreateRoot(document.getElementById(\"root\")!).render(\n  <StrictMode>\n    <AppProviders>\n      <AppDemo />\n      <TrialBanner />\n    </AppProviders>\n  </StrictMode>,\n);"
}
```


### 👤 User *(2026-07-04 16:07:32)*

**Tool Result (✅ Success - ID: `toolu_011jjupr4YKMJjuY5rFSpZ3D`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-core\main.tsx has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:07:36)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:07:36)*

Now the build wiring. Updating todos and editing config files:


### 🤖 Claude *(2026-07-04 16:07:41)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_014R41cY9Jp7JGFPTEWyjM11`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "completed",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "completed",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "completed",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "completed",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "completed",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "completed",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "completed",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "in_progress",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "pending",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "pending",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 16:07:41)*

**Tool Result (✅ Success - ID: `toolu_014R41cY9Jp7JGFPTEWyjM11`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 16:07:47)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_019kg9bsskdfn2ZFwgXZcnxu`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vite.config.ts",
  "old_string": "            if (url === '/founding' || url === '/early-access') {\n              req.url = '/founding.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            } else if (url === '/app') {\n              req.url = '/app.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            }",
  "new_string": "            if (url === '/founding' || url === '/early-access') {\n              req.url = '/founding.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            } else if (url === '/app') {\n              req.url = '/app.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            } else if (url === '/try') {\n              req.url = '/try.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            } else if (url === '/admin') {\n              req.url = '/admin.html' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');\n            }"
}
```


### 👤 User *(2026-07-04 16:07:49)*

**Tool Result (✅ Success - ID: `toolu_019kg9bsskdfn2ZFwgXZcnxu`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\vite.config.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:07:53)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01E8AgLkPAE5WgV14wwgHzNS`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vite.config.ts",
  "old_string": "          // \"founding user\" \u2014 hidden escrow page (direct URL only, not linked from nav)\n          founding: path.resolve(__dirname, 'founding.html'),\n        },",
  "new_string": "          // \"founding user\" \u2014 hidden escrow page (direct URL only, not linked from nav)\n          founding: path.resolve(__dirname, 'founding.html'),\n          // \"try\" \u2014 2-in-1 business card + trial-code redemption (direct URL / QR)\n          try: path.resolve(__dirname, 'try.html'),\n          // \"admin\" \u2014 hidden, secret-gated campaign console (direct URL only)\n          admin: path.resolve(__dirname, 'admin.html'),\n        },"
}
```


### 👤 User *(2026-07-04 16:07:54)*

**Tool Result (❌ Error - ID: `toolu_01E8AgLkPAE5WgV14wwgHzNS`):**
```
WiBiz house style (hard rule): em dashes and en dashes are banned. Replace the long dash with a hyphen (-) and retry. If the dash is genuinely required (for example when documenting this rule), wrap it in inline-code backticks.
```


### 🤖 Claude *(2026-07-04 16:07:57)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:08:00)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01TCLvEPfsvmcwuYLvCDJMoS`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vite.config.ts",
  "old_string": "          // \"founding user\" \u2014 hidden escrow page (direct URL only, not linked from nav)\n          founding: path.resolve(__dirname, 'founding.html'),\n        },",
  "new_string": "          // \"founding user\" \u2014 hidden escrow page (direct URL only, not linked from nav)\n          founding: path.resolve(__dirname, 'founding.html'),\n          // \"try\" - 2-in-1 business card + trial-code redemption (direct URL / QR)\n          try: path.resolve(__dirname, 'try.html'),\n          // \"admin\" - hidden, secret-gated campaign console (direct URL only)\n          admin: path.resolve(__dirname, 'admin.html'),\n        },"
}
```


### 👤 User *(2026-07-04 16:08:00)*

**Tool Result (❌ Error - ID: `toolu_01TCLvEPfsvmcwuYLvCDJMoS`):**
```
WiBiz house style (hard rule): em dashes and en dashes are banned. Replace the long dash with a hyphen (-) and retry. If the dash is genuinely required (for example when documenting this rule), wrap it in inline-code backticks.
```


### 🤖 Claude *(2026-07-04 16:08:07)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:08:07)*

The hook rejects because the retained existing line has an em dash. Anchoring on a dash-free region:


### 🤖 Claude *(2026-07-04 16:08:10)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01GA1Ya21FpV1q69NgrJEGtK`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vite.config.ts",
  "old_string": "          founding: path.resolve(__dirname, 'founding.html'),\n        },",
  "new_string": "          founding: path.resolve(__dirname, 'founding.html'),\n          // \"try\" - 2-in-1 business card + trial-code redemption (direct URL / QR)\n          try: path.resolve(__dirname, 'try.html'),\n          // \"admin\" - hidden, secret-gated campaign console (direct URL only)\n          admin: path.resolve(__dirname, 'admin.html'),\n        },"
}
```


### 👤 User *(2026-07-04 16:08:11)*

**Tool Result (✅ Success - ID: `toolu_01GA1Ya21FpV1q69NgrJEGtK`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\vite.config.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:16)*

Now `vercel.json` rewrites (production clean URLs):


### 🤖 Claude *(2026-07-04 16:08:18)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01JBjjyD64skGxAkubeDTgEh`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vercel.json",
  "old_string": "    { \"source\": \"/app\", \"destination\": \"/app.html\" },\n    { \"source\": \"/founding\", \"destination\": \"/founding.html\" },\n    { \"source\": \"/early-access\", \"destination\": \"/founding.html\" }",
  "new_string": "    { \"source\": \"/app\", \"destination\": \"/app.html\" },\n    { \"source\": \"/founding\", \"destination\": \"/founding.html\" },\n    { \"source\": \"/early-access\", \"destination\": \"/founding.html\" },\n    { \"source\": \"/try\", \"destination\": \"/try.html\" },\n    { \"source\": \"/admin\", \"destination\": \"/admin.html\" }"
}
```


### 👤 User *(2026-07-04 16:08:19)*

**Tool Result (✅ Success - ID: `toolu_01JBjjyD64skGxAkubeDTgEh`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\vercel.json has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:24)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:08:24)*

The Express `SERVE_STATIC` mode has its own clean-URL map - add `/try` and `/admin` there too:


### 🤖 Claude *(2026-07-04 16:08:27)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01PfVnseYYBrYnrpvqtv8qTM`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\scripts\\api-server.ts",
  "old_string": "  const pageFor = (p: string): string => {\n    if (p === \"/app\") return \"app.html\";\n    if (p === \"/founding\" || p === \"/early-access\") return \"founding.html\";\n    return \"index.html\";\n  };",
  "new_string": "  const pageFor = (p: string): string => {\n    if (p === \"/app\") return \"app.html\";\n    if (p === \"/founding\" || p === \"/early-access\") return \"founding.html\";\n    if (p === \"/try\") return \"try.html\";\n    if (p === \"/admin\") return \"admin.html\";\n    return \"index.html\";\n  };"
}
```


### 👤 User *(2026-07-04 16:08:28)*

**Tool Result (✅ Success - ID: `toolu_01PfVnseYYBrYnrpvqtv8qTM`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\scripts\api-server.ts has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:30)*

Now `.env.example` - add `ADMIN_ACCESS_KEY`:


### 🤖 Claude *(2026-07-04 16:08:35)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01Q7aPQXNd3wmpod3pG75bZt`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\.env.example",
  "old_string": "# Chain ID: 8453 (Base mainnet) or 84532 (Base Sepolia for testing).\nVITE_ESCROW_CHAIN_ID=84532",
  "new_string": "# Chain ID: 8453 (Base mainnet) or 84532 (Base Sepolia for testing).\nVITE_ESCROW_CHAIN_ID=84532\n\n# \u2500\u2500 Product trial codes (2-in-1 business card - /try + /admin) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# Shared secret gating the campaign admin console (/admin). Sent by the admin\n# page as the X-Admin-Key header and checked by /api/admin/campaigns. Choose a\n# long random string. BACKEND-ONLY - never VITE_-prefix. Redemption + app-open\n# (/api/try/*) reuse the existing SUPABASE_URL / SUPABASE_SECRET_KEY above.\nADMIN_ACCESS_KEY="
}
```


### 👤 User *(2026-07-04 16:08:36)*

**Tool Result (✅ Success - ID: `toolu_01Q7aPQXNd3wmpod3pG75bZt`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\.env.example has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:41)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:08:42)*

Now `package.json` - add `qrcode`, `@types/qrcode`, `vitest`, and a `test` script:


### 🤖 Claude *(2026-07-04 16:08:43)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01QKyWJFvcygwd3UA6tuuwc5`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\package.json",
  "old_string": "    \"lint\": \"tsc --noEmit\",\n    \"test:scoring\": \"npm run test --workspace=@panik/scoring\",",
  "new_string": "    \"lint\": \"tsc --noEmit\",\n    \"test\": \"vitest run\",\n    \"test:scoring\": \"npm run test --workspace=@panik/scoring\","
}
```


### 👤 User *(2026-07-04 16:08:45)*

**Tool Result (✅ Success - ID: `toolu_01QKyWJFvcygwd3UA6tuuwc5`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\package.json has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:50)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01SfPsy6fnBzryZ9h81sFcKL`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\package.json",
  "old_string": "    \"pg\": \"^8.21.0\",\n    \"react\": \"^19.0.1\",",
  "new_string": "    \"pg\": \"^8.21.0\",\n    \"qrcode\": \"^1.5.4\",\n    \"react\": \"^19.0.1\","
}
```


### 👤 User *(2026-07-04 16:08:51)*

**Tool Result (✅ Success - ID: `toolu_01SfPsy6fnBzryZ9h81sFcKL`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\package.json has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:08:57)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01XXStekajaSFqCBL2DFGcAo`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\package.json",
  "old_string": "    \"@types/express\": \"^4.17.21\",\n    \"@types/node\": \"^22.14.0\",\n    \"autoprefixer\": \"^10.4.21\",",
  "new_string": "    \"@types/express\": \"^4.17.21\",\n    \"@types/node\": \"^22.14.0\",\n    \"@types/qrcode\": \"^1.5.5\",\n    \"autoprefixer\": \"^10.4.21\","
}
```


### 👤 User *(2026-07-04 16:08:58)*

**Tool Result (✅ Success - ID: `toolu_01XXStekajaSFqCBL2DFGcAo`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\package.json has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:09:03)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01ActiX5FzJFsqcFPnf2TSkq`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\package.json",
  "old_string": "    \"typescript\": \"~5.8.2\",\n    \"vite\": \"^6.2.3\"\n  }",
  "new_string": "    \"typescript\": \"~5.8.2\",\n    \"vite\": \"^6.2.3\",\n    \"vitest\": \"^2.1.9\"\n  }"
}
```


### 👤 User *(2026-07-04 16:09:04)*

**Tool Result (✅ Success - ID: `toolu_01ActiX5FzJFsqcFPnf2TSkq`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\package.json has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:09:10)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:09:10)*

Now the isolated vitest config and the test suite:


### 🤖 Claude *(2026-07-04 16:09:12)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01NbrzfCAn8oL3tBZgBCfBpx`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\vitest.config.ts",
  "content": "import { defineConfig } from \"vitest/config\";\n\n// Standalone from vite.config.ts on purpose: these are pure-logic unit tests, so\n// we skip the app's html-rewrite / tailwind / react plugins entirely.\nexport default defineConfig({\n  test: {\n    environment: \"node\",\n    include: [\"src/**/*.test.ts\"],\n  },\n});\n"
}
```


### 👤 User *(2026-07-04 16:09:14)*

**Tool Result (✅ Success - ID: `toolu_01NbrzfCAn8oL3tBZgBCfBpx`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\vitest.config.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:09:40)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01Aw2AU5F7NCnuw8pcvt9Xin`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\lib\\trialLogic.test.ts",
  "content": "/**\n * @license\n * SPDX-License-Identifier: Apache-2.0\n *\n * Unit tests for the trial-code decision logic. These mirror the SQL rules in\n * supabase/migrations/20260704000001_product_codes.sql: campaign status\n * (time + count limits), per-user expiry (clock starts on first open), and code\n * parsing for the scan vs manual-input paths.\n *\n * NOTE: the atomic over-limit guard itself lives in SQL (redeem_campaign_code's\n * guarded UPDATE) and is exercised by the end-to-end verification steps, not\n * here - this file covers the pure, DB-free logic the SQL mirrors.\n */\n\nimport { describe, it, expect } from \"vitest\";\nimport {\n  evaluateCampaign,\n  computeTrialExpiry,\n  evaluateTrialAccess,\n  normalizeCode,\n  parseCode,\n  formatRemaining,\n  type CampaignLike,\n} from \"./trialLogic\";\n\nconst NOW = new Date(\"2026-07-05T12:00:00.000Z\");\nconst base: CampaignLike = {\n  is_active: true,\n  redemption_count: 0,\n  max_redemptions: 20,\n  claim_window_expires_at: null,\n};\n\ndescribe(\"evaluateCampaign - usage (count) limit\", () => {\n  it(\"is active below the limit\", () => {\n    expect(evaluateCampaign({ ...base, redemption_count: 5 }, NOW)).toBe(\"active\");\n  });\n  it(\"is exhausted when count reaches max\", () => {\n    expect(evaluateCampaign({ ...base, redemption_count: 20 }, NOW)).toBe(\"exhausted\");\n  });\n  it(\"is exhausted when count exceeds max\", () => {\n    expect(evaluateCampaign({ ...base, redemption_count: 21 }, NOW)).toBe(\"exhausted\");\n  });\n});\n\ndescribe(\"evaluateCampaign - time (claim window) limit\", () => {\n  it(\"is active before the claim window closes\", () => {\n    expect(\n      evaluateCampaign({ ...base, claim_window_expires_at: \"2026-07-06T12:00:00.000Z\" }, NOW),\n    ).toBe(\"active\");\n  });\n  it(\"is expired once the claim window has passed\", () => {\n    expect(\n      evaluateCampaign({ ...base, claim_window_expires_at: \"2026-07-04T12:00:00.000Z\" }, NOW),\n    ).toBe(\"expired\");\n  });\n  it(\"is expired exactly at the boundary\", () => {\n    expect(\n      evaluateCampaign({ ...base, claim_window_expires_at: NOW.toISOString() }, NOW),\n    ).toBe(\"expired\");\n  });\n});\n\ndescribe(\"evaluateCampaign - precedence (whichever limit is hit first wins)\", () => {\n  it(\"disabled beats everything\", () => {\n    expect(evaluateCampaign({ ...base, is_active: false, redemption_count: 99 }, NOW)).toBe(\"disabled\");\n  });\n  it(\"expired (time) beats exhausted (count)\", () => {\n    expect(\n      evaluateCampaign(\n        { ...base, redemption_count: 20, claim_window_expires_at: \"2026-07-04T12:00:00.000Z\" },\n        NOW,\n      ),\n    ).toBe(\"expired\");\n  });\n});\n\ndescribe(\"computeTrialExpiry\", () => {\n  it(\"adds the duration in hours to the first-open time\", () => {\n    const opened = new Date(\"2026-07-05T12:00:00.000Z\");\n    expect(computeTrialExpiry(opened, 72).toISOString()).toBe(\"2026-07-08T12:00:00.000Z\");\n  });\n});\n\ndescribe(\"evaluateTrialAccess - per-user expiry (clock starts on first open)\", () => {\n  it(\"is invalid for a missing/unknown token\", () => {\n    expect(evaluateTrialAccess(null, NOW)).toBe(\"invalid\");\n  });\n  it(\"is active when never opened (clock not started yet)\", () => {\n    expect(evaluateTrialAccess({ first_opened_at: null, expires_at: null }, NOW)).toBe(\"active\");\n  });\n  it(\"is active before expiry\", () => {\n    expect(\n      evaluateTrialAccess(\n        { first_opened_at: \"2026-07-05T11:00:00.000Z\", expires_at: \"2026-07-05T13:00:00.000Z\" },\n        NOW,\n      ),\n    ).toBe(\"active\");\n  });\n  it(\"is expired after expiry\", () => {\n    expect(\n      evaluateTrialAccess(\n        { first_opened_at: \"2026-07-01T12:00:00.000Z\", expires_at: \"2026-07-04T12:00:00.000Z\" },\n        NOW,\n      ),\n    ).toBe(\"expired\");\n  });\n});\n\ndescribe(\"parseCode - scan path vs manual fallback\", () => {\n  it(\"reads the code param (scan path)\", () => {\n    expect(parseCode(\"?code=PANIK-TRY-8X2Q\")).toBe(\"PANIK-TRY-8X2Q\");\n  });\n  it(\"normalizes case and whitespace\", () => {\n    expect(parseCode(\"?code=panik-try-8x2q\")).toBe(\"PANIK-TRY-8X2Q\");\n  });\n  it(\"returns null with no code param (manual fallback path)\", () => {\n    expect(parseCode(\"\")).toBeNull();\n    expect(parseCode(\"?foo=bar\")).toBeNull();\n  });\n});\n\ndescribe(\"normalizeCode\", () => {\n  it(\"uppercases and trims\", () => {\n    expect(normalizeCode(\"  panik-try-abcd \")).toBe(\"PANIK-TRY-ABCD\");\n  });\n  it(\"handles null/undefined\", () => {\n    expect(normalizeCode(null)).toBe(\"\");\n    expect(normalizeCode(undefined)).toBe(\"\");\n  });\n});\n\ndescribe(\"formatRemaining\", () => {\n  it(\"labels days and hours\", () => {\n    expect(formatRemaining(2 * 86_400_000 + 3 * 3_600_000)).toBe(\"2d 3h\");\n  });\n  it(\"labels hours and minutes\", () => {\n    expect(formatRemaining(5 * 3_600_000 + 12 * 60_000)).toBe(\"5h 12m\");\n  });\n  it(\"labels minutes only\", () => {\n    expect(formatRemaining(8 * 60_000)).toBe(\"8m\");\n  });\n  it(\"says expired at or below zero\", () => {\n    expect(formatRemaining(0)).toBe(\"expired\");\n    expect(formatRemaining(-1000)).toBe(\"expired\");\n  });\n});\n"
}
```


### 👤 User *(2026-07-04 16:09:41)*

**Tool Result (✅ Success - ID: `toolu_01Aw2AU5F7NCnuw8pcvt9Xin`):**
```
File created successfully at: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\lib\trialLogic.test.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:09:52)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:09:52)*

Now install the new deps and run lint + tests:


### 🤖 Claude *(2026-07-04 16:09:53)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01PUKjkfwNLr9n5cdPkZJqnf`)
```json
{
  "command": "npm install 2>&1 | Select-Object -Last 20",
  "description": "Install new dependencies (qrcode, vitest)",
  "timeout": 300000
}
```


### 👤 User *(2026-07-04 16:22:03)*

**Tool Result (✅ Success - ID: `toolu_01PUKjkfwNLr9n5cdPkZJqnf`):**
```
added 92 packages, changed 12 packages, and audited 445 packages in 14s

79 packages are looking for funding
  run `npm fund` for details

8 vulnerabilities (1 low, 2 moderate, 4 high, 1 critical)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```


### 🤖 Claude *(2026-07-04 16:22:14)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_01192y8eZTj9K4v4hoiwr53h`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "completed",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "completed",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "completed",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "completed",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "completed",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "completed",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "completed",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "completed",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "completed",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "in_progress",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 16:22:14)*

**Tool Result (✅ Success - ID: `toolu_01192y8eZTj9K4v4hoiwr53h`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 16:22:18)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_019skbYBjZ6APNszbVQddvdf`)
```json
{
  "command": "npm run lint 2>&1 | Select-Object -Last 40; Write-Output \"EXITCODE=$LASTEXITCODE\"",
  "description": "Run TypeScript typecheck (lint)",
  "timeout": 180000
}
```


### 👤 User *(2026-07-04 16:29:33)*

**Tool Result (❌ Error - ID: `toolu_019skbYBjZ6APNszbVQddvdf`):**
```
Exit code 2
> panik@0.0.0 lint
> tsc --noEmit

src/panik-admin/App.tsx(320,43): error TS2322: Type '{ key: any; c: any; apiKey: string; onChange: (c: Campaign) => void; }' is not assignable to type '{ c: Campaign; apiKey: string; onChange: (c: Campaign) => void; }'.
  Property 'key' does not exist on type '{ c: Campaign; apiKey: string; onChange: (c: Campaign) => void; }'.
src/panik-founding/components/DepositFlow.tsx(256,18): error TS2345: Argument of type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "approve"; readonly inputs: readonly [{ readonly name: "spender"; readonly type: "address"; }, { readonly name: "amount"; readonly type: "uint256"; }]; readonly outputs: readonly [...]; readonly stateMutability: "nonpayable"; }, { ....' is not assignable to parameter of type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "approve"; readonly inputs: readonly [{ readonly name: "spender"; readonly type: "address"; }, { readonly name: "amount"; readonly type: "uint256"; }]; readonly outputs: readonly [...]; readonly stateMu...'.
  Type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "approve"; readonly inputs: readonly [{ readonly name: "spender"; readonly type: "address"; }, { readonly name: "amount"; readonly type: "uint256"; }]; readonly outputs: readonly [...]; readonly stateMutability: "nonpayable"; }, { ....' is missing the following properties from type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "approve"; readonly inputs: readonly [{ readonly name: "spender"; readonly type: "address"; }, { readonly name: "amount"; readonly type: "uint256"; }]; readonly outputs: readonly [...]; readonly stateMu...': chain, account
src/panik-founding/components/DepositFlow.tsx(267,18): error TS2345: Argument of type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; functionName: "deposit"; chainId: number...' is not assignable to parameter of type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...'.
  Type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; functionName: "deposit"; chainId: number...' is missing the following properties from type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...': chain, account
src/panik-founding/components/RefundBanner.tsx(80,16): error TS2345: Argument of type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; functionName: "claimRefund"; chainId: nu...' is not assignable to parameter of type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...'.
  Type '{ address: `0x${string}`; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; functionName: "claimRefund"; chainId: nu...' is missing the following properties from type '{ [x: string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...': chain, account
EXITCODE=2
```


### 🤖 Claude *(2026-07-04 16:30:19)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:30:20)*

My `key` error is mine; the `panik-founding` wagmi errors may be pre-existing or from the install bumping viem/wagmi. Let me check both.


### 🤖 Claude *(2026-07-04 16:30:22)*

**🛠️ Tool Call:** `Read` (ID: `toolu_01WDAed3KcpRahQHRVjfasku`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\App.tsx",
  "offset": 308,
  "limit": 20
}
```


### 🤖 Claude *(2026-07-04 16:30:23)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01TYaLQYWa8fAYofFkU6bvr6`)
```json
{
  "command": "git stash list; Write-Output \"---VIEM/WAGMI IN LOCK (working) ---\"; git diff --stat -- package-lock.json; Write-Output \"--- installed versions ---\"; npm ls viem wagmi @tanstack/react-query 2>&1 | Select-Object -First 12",
  "description": "Check if package-lock changed viem/wagmi versions"
}
```


### 👤 User *(2026-07-04 16:30:25)*

**Tool Result (✅ Success - ID: `toolu_01WDAed3KcpRahQHRVjfasku`):**
```
308	        </div>
309	      </div>
310	
311	      <CreateForm apiKey={apiKey} onCreated={upsert} />
312	
313	      <h2 className="font-display text-base font-semibold text-white/90 mb-4">Campaigns</h2>
314	      {error && <p className="text-sm text-red-400/90 mb-4">{error}</p>}
315	      {loading && campaigns.length === 0 ? (
316	        <div className="flex items-center gap-2 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
317	      ) : campaigns.length === 0 ? (
318	        <p className="text-sm text-white/40">No campaigns yet. Create one above.</p>
319	      ) : (
320	        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)
321	      )}
322	    </main>
323	  );
324	}
325	
326	export default function App() {
327	  const [apiKey, setApiKey] = useState<string>(() => getStoredKey());
```


### 👤 User *(2026-07-04 16:31:16)*

**Tool Result (❌ Error - ID: `toolu_01TYaLQYWa8fAYofFkU6bvr6`):**
```
Exit code 255
---VIEM/WAGMI IN LOCK (working) ---
 package-lock.json | 1743 +++++++++++++++++++++++++++++++++++++++++++++++++----
 1 file changed, 1635 insertions(+), 108 deletions(-)
--- installed versions ---
panik@0.0.0 C:\Users\ASUS\Documents\Github Projects\panik_waitlist
+-- @panik/scoring@0.1.0 -> .\packages\scoring
| `-- viem@2.52.2 deduped
+-- @tanstack/react-query@5.101.0
+-- viem@2.52.2
`-- wagmi@3.6.17
  +-- @tanstack/react-query@5.101.0 deduped
  +-- @wagmi/connectors@8.0.16
  | `-- viem@2.52.2 deduped
  +-- @wagmi/core@3.5.1
  | `-- viem@2.52.2 deduped
  `-- viem@2.52.2 deduped
```


### 🤖 Claude *(2026-07-04 16:32:06)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:32:08)*

`c` typed as `any` in that error is the tell - and viem/wagmi are unchanged (2.52.2/3.6.17), so the founding errors are pre-existing, not from my install. Let me confirm founding is pre-existing and inspect the `key` issue's root cause.


### 🤖 Claude *(2026-07-04 16:32:11)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01XS5Nw46t4Eu9Rz1SxMxJZx`)
```json
{
  "command": "Write-Output \"--- @types/react version ---\"; npm ls @types/react 2>&1 | Select-Object -First 6; Write-Output \"--- stash + lint pristine HEAD to check founding ---\"; git stash push -u -m tmp-lintcheck 2>&1 | Select-Object -Last 2; npx tsc --noEmit 2>&1 | Select-String \"panik-founding\" | Select-Object -First 3; Write-Output \"EXIT=$LASTEXITCODE\"; git stash pop 2>&1 | Select-Object -Last 2",
  "description": "Check react types and whether founding errors pre-exist at HEAD",
  "timeout": 180000
}
```


### 👤 User *(2026-07-04 16:34:18)*

**Tool Result (✅ Success - ID: `toolu_01XS5Nw46t4Eu9Rz1SxMxJZx`):**
```
--- @types/react version ---
panik@0.0.0 C:\Users\ASUS\Documents\Github Projects\panik_waitlist
`-- (empty)

--- stash + lint pristine HEAD to check founding ---
warning: in the working copy of 'vercel.json', LF will be replaced by CRLF the next time Git touches it
Saved working directory and index state On main: tmp-lintcheck

src/panik-founding/components/DepositFlow.tsx(256,18): error TS2345: Argument of type '{ address: `0x${string}`; abi: 
readonly [{ readonly type: "function"; readonly name: "approve"; readonly inputs: readonly [{ readonly name: 
"spender"; readonly type: "address"; }, { readonly name: "amount"; readonly type: "uint256"; }]; readonly outputs: 
readonly [...]; readonly stateMutability: "nonpayable"; }, { ....' is not assignable to parameter of type '{ [x: 
string]: any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: 
"approve"; readonly inputs: readonly [{ readonly name: "spender"; readonly type: "address"; }, { readonly name: 
"amount"; readonly type: "uint256"; }]; readonly outputs: readonly [...]; readonly stateMu...'.
src/panik-founding/components/DepositFlow.tsx(267,18): error TS2345: Argument of type '{ address: `0x${string}`; abi: 
readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly 
outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more 
..., { ...; }]; functionName: "deposit"; chainId: number...' is not assignable to parameter of type '{ [x: string]: 
any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; 
readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly 
stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...'.
src/panik-founding/components/RefundBanner.tsx(80,16): error TS2345: Argument of type '{ address: `0x${string}`; abi: 
readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; readonly inputs: readonly []; readonly 
outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly stateMutability: "view"; }, ... 13 more 
..., { ...; }]; functionName: "claimRefund"; chainId: nu...' is not assignable to parameter of type '{ [x: string]: 
any; [x: number]: any; [x: symbol]: any; abi: readonly [{ readonly type: "function"; readonly name: "DEPOSIT_AMOUNT"; 
readonly inputs: readonly []; readonly outputs: readonly [{ readonly name: ""; readonly type: "uint256"; }]; readonly 
stateMutability: "view"; }, ... 13 more ..., { ...; }]; ... 8 more...'.
EXIT=-1
no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (26d29e45e5643e08c47c49f43ab6f7866e9fbd21)
```


### 🤖 Claude *(2026-07-04 16:35:00)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:35:01)*

Confirmed: the `panik-founding` wagmi errors are **pre-existing at HEAD** (they appear with all my changes stashed) - not my regression, and I won't touch the escrow code. Now let me pin down my `key` error - I'll check how existing code keys lists of custom components.


### 🤖 Claude *(2026-07-04 16:35:04)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01DsQt3uXN1Z6ZfNiDaA4A1M`)
```json
{
  "command": "Write-Output \"--- @types/react on disk ---\"; if (Test-Path node_modules/@types/react/package.json) { (Get-Content node_modules/@types/react/package.json | ConvertFrom-Json).version } else { \"NOT PRESENT\" }; Write-Output \"--- @types/react-dom ---\"; if (Test-Path node_modules/@types/react-dom/package.json) { (Get-Content node_modules/@types/react-dom/package.json | ConvertFrom-Json).version } else { \"NOT PRESENT\" }",
  "description": "Check installed React type versions"
}
```


### 🤖 Claude *(2026-07-04 16:35:06)*

**🛠️ Tool Call:** `Grep` (ID: `toolu_01DWpx57LoKt3Z6XNpwQdVSx`)
```json
{
  "pattern": "\\.map\\(\\([a-zA-Z0-9_, ]*\\) => \\(?\\s*<[A-Z]\\w+ [^>]*key=",
  "path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-core",
  "output_mode": "content",
  "-n": true,
  "head_limit": 10
}
```


### 👤 User *(2026-07-04 16:35:28)*

**Tool Result (✅ Success - ID: `toolu_01DsQt3uXN1Z6ZfNiDaA4A1M`):**
```
--- @types/react on disk ---
NOT PRESENT
--- @types/react-dom ---
NOT PRESENT
```


### 👤 User *(2026-07-04 16:35:29)*

**Tool Result (✅ Success - ID: `toolu_01DWpx57LoKt3Z6XNpwQdVSx`):**
```
No matches found
```


### 🤖 Claude *(2026-07-04 16:36:20)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:36:25)*

Root cause found: **`@types/react` is not installed at all** in this repo - so there's no `JSX.IntrinsicAttributes`, and `key` is rejected on custom components (intrinsic `<div key>` slips through as `any`, which is why existing code never tripped it). The proper fix is to add the missing React type packages, but that risks surfacing latent errors repo-wide. Let me test empirically before committing to it.


### 🤖 Claude *(2026-07-04 16:36:25)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_017mvU2knhiVyBuHxeS8iQeD`)
```json
{
  "command": "npm install -D \"@types/react@^19\" \"@types/react-dom@^19\" 2>&1 | Select-Object -Last 3; Write-Output \"--- tsc error count now ---\"; $out = npx tsc --noEmit 2>&1; $out | Select-String \"error TS\" | Measure-Object | Select-Object -ExpandProperty Count; Write-Output \"--- non-founding errors ---\"; $out | Select-String \"error TS\" | Where-Object { $_ -notmatch \"panik-founding\" }",
  "description": "Install React types and recount tsc errors",
  "timeout": 180000
}
```


### 👤 User *(2026-07-04 16:37:44)*

**Tool Result (❌ Error - ID: `toolu_017mvU2knhiVyBuHxeS8iQeD`):**
```
Exit code 2
  npm audit fix --force

Run `npm audit` for details.
--- tsc error count now ---
5
--- non-founding errors ---

src/panik-core/AppDemo.tsx(742,9): error TS2322: Type '{ protocol: "Aave V3" | "Moonwell" | "Morpho" | "Compound V3"; 
assetPair: string; riskScore: number; status: Band; collateralValue: number; borrowValue: number; healthFactor: 
number; liquidationPrice: number; currentPrice: number; recommendation: string; breakdown: { ...; }; }' is not 
assignable to type 'PositionState'.
src/panik-landing-page/components/DashboardScrollPreview.tsx(1096,20): error TS2367: This comparison appears to be 
unintentional because the types '"compass" | "portfolio" | "advisor" | "watch"' and '"settings"' have no overlap.
```


### 🤖 Claude *(2026-07-04 16:38:28)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:38:31)*

Adding `@types/react` fixes my error but surfaces **2 additional pre-existing latent bugs** in files I didn't write (`AppDemo.tsx`, `DashboardScrollPreview.tsx`) - it changes the whole team's type baseline as a side effect of my feature. The repo deliberately builds without React types (esbuild strips them), and lint is already red on founding regardless. The surgical choice: revert the types dependency and make my code lint-clean under the **same** conditions as the rest of the repo (key on an intrinsic wrapper, which the rest of the codebase relies on). Let me verify no other spots in my code use `key` on a custom component first.


### 🤖 Claude *(2026-07-04 16:38:32)*

**🛠️ Tool Call:** `Grep` (ID: `toolu_01NBYTxHkmLf71pwvDNin4AG`)
```json
{
  "pattern": "key=",
  "path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-try\\src\\panik-admin",
  "output_mode": "content",
  "-n": true
}
```


### 👤 User *(2026-07-04 16:38:32)*

**Tool Result (❌ Error - ID: `toolu_01NBYTxHkmLf71pwvDNin4AG`):**
```
<tool_use_error>Path does not exist: c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-try\src\panik-admin. Note: your current working directory is C:\Users\ASUS\Documents\Github Projects\panik_waitlist.</tool_use_error>
```


### 🤖 Claude *(2026-07-04 16:38:33)*

**🛠️ Tool Call:** `Grep` (ID: `toolu_0171LWcLdPh1xjX6NGdLuoMA`)
```json
{
  "pattern": "key=\\{",
  "path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src",
  "glob": "**/panik-{try,admin}/**/*.tsx",
  "output_mode": "content",
  "-n": true
}
```


### 👤 User *(2026-07-04 16:38:34)*

**Tool Result (✅ Success - ID: `toolu_0171LWcLdPh1xjX6NGdLuoMA`):**
```
src\panik-admin\App.tsx:320:        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)
```


### 🤖 Claude *(2026-07-04 16:38:36)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:38:37)*

Only one spot. Reverting the React types and fixing that line with an intrinsic keyed wrapper:


### 🤖 Claude *(2026-07-04 16:38:37)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01QUP5ijikojtD93t7tnPWax`)
```json
{
  "command": "npm uninstall @types/react @types/react-dom 2>&1 | Select-Object -Last 2",
  "description": "Revert React types dependency",
  "timeout": 120000
}
```


### 👤 User *(2026-07-04 16:39:41)*

**Tool Result (✅ Success - ID: `toolu_01QUP5ijikojtD93t7tnPWax`):**
```
Run `npm audit` for details.
```


### 🤖 Claude *(2026-07-04 16:39:48)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01HXQ8gZxKxCTRcrnVrCoW1d`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\App.tsx",
  "old_string": "        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)",
  "new_string": "        // key on an intrinsic wrapper: this repo has no @types/react, so\n        // JSX.IntrinsicAttributes (which carries `key`) is absent for custom\n        // components. Intrinsic elements type as any, so keys ride on them.\n        campaigns.map((c) => (\n          <div key={c.id}>\n            <CampaignRow c={c} apiKey={apiKey} onChange={upsert} />\n          </div>\n        ))"
}
```


### 👤 User *(2026-07-04 16:39:48)*

**Tool Result (❌ Error - ID: `toolu_01HXQ8gZxKxCTRcrnVrCoW1d`):**
```
<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>
```


### 🤖 Claude *(2026-07-04 16:39:52)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:39:52)*

**🛠️ Tool Call:** `Read` (ID: `toolu_013oY44pwJ2PYy4FhGbkU4NP`)
```json
{
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\App.tsx",
  "offset": 314,
  "limit": 10
}
```


### 👤 User *(2026-07-04 16:39:52)*

**Tool Result (✅ Success - ID: `toolu_013oY44pwJ2PYy4FhGbkU4NP`):**
```
314	      {error && <p className="text-sm text-red-400/90 mb-4">{error}</p>}
315	      {loading && campaigns.length === 0 ? (
316	        <div className="flex items-center gap-2 text-white/40 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
317	      ) : campaigns.length === 0 ? (
318	        <p className="text-sm text-white/40">No campaigns yet. Create one above.</p>
319	      ) : (
320	        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)
321	      )}
322	    </main>
323	  );
```


### 🤖 Claude *(2026-07-04 16:39:59)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01SkPGDzsXbgs2caSx5d3Pjf`)
```json
{
  "replace_all": false,
  "file_path": "c:\\Users\\ASUS\\Documents\\Github Projects\\panik_waitlist\\src\\panik-admin\\App.tsx",
  "old_string": "        campaigns.map((c) => <CampaignRow key={c.id} c={c} apiKey={apiKey} onChange={upsert} />)",
  "new_string": "        // key on an intrinsic wrapper: this repo ships no @types/react, so\n        // JSX.IntrinsicAttributes (which carries `key`) is absent for custom\n        // components; intrinsic elements type as any, so keys ride on them.\n        campaigns.map((c) => (\n          <div key={c.id}>\n            <CampaignRow c={c} apiKey={apiKey} onChange={upsert} />\n          </div>\n        ))"
}
```


### 👤 User *(2026-07-04 16:40:00)*

**Tool Result (✅ Success - ID: `toolu_01SkPGDzsXbgs2caSx5d3Pjf`):**
```
The file c:\Users\ASUS\Documents\Github Projects\panik_waitlist\src\panik-admin\App.tsx has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:40:03)*

Now re-run lint (expect only the 3 pre-existing founding errors) and the test suite:


### 🤖 Claude *(2026-07-04 16:40:05)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01JrQ8HPqE42nMrsnnCnZ8rd`)
```json
{
  "command": "Write-Output \"=== LINT ===\"; $out = npx tsc --noEmit 2>&1; $errs = $out | Select-String \"error TS\"; Write-Output \"total errors: $($errs.Count)\"; Write-Output \"non-founding errors:\"; $errs | Where-Object { $_ -notmatch \"panik-founding\" }; Write-Output \"=== TEST ===\"; npm run test 2>&1 | Select-Object -Last 25",
  "description": "Run typecheck and vitest suite",
  "timeout": 180000
}
```


### 👤 User *(2026-07-04 16:41:43)*

**Tool Result (✅ Success - ID: `toolu_01JrQ8HPqE42nMrsnnCnZ8rd`):**
```
=== LINT ===
total errors: 3
non-founding errors:
=== TEST ===

> panik@0.0.0 test
> vitest run


[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90mC:/Users/ASUS/Documents/Github Projects/panik_waitlist[39m

 [32m✓[39m src/panik-try/lib/trialLogic.test.ts [2m([22m[2m22 tests[22m[2m)[22m[90m 10[2mms[22m[39m

[2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
[2m      Tests [22m [1m[32m22 passed[39m[22m[90m (22)[39m
[2m   Start at [22m 00:41:43
[2m   Duration [22m 647ms[2m (transform 71ms, setup 0ms, collect 65ms, tests 10ms, environment 0ms, prepare 189ms)[22m
```


### 🤖 Claude *(2026-07-04 16:41:50)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:41:51)*

Lint is back to the **3 pre-existing founding errors only** - my code adds zero. All 22 tests pass. Now the real end-to-end check: a production build to confirm the two new HTML entries bundle correctly (cross-folder imports, the `qrcode` browser build, esbuild type-stripping).


### 🤖 Claude *(2026-07-04 16:41:53)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_01VGuf1PP5DQf9mGupdFyk7f`)
```json
{
  "command": "npm run build 2>&1 | Select-String -Pattern \"try|admin|founding|app\\.html|index\\.html|error|Error|built in|dist/\" | Select-Object -First 40; Write-Output \"BUILD_EXIT=$LASTEXITCODE\"",
  "description": "Production build to verify new entries bundle",
  "timeout": 300000
}
```


### 👤 User *(2026-07-04 16:42:43)*

**Tool Result (✅ Success - ID: `toolu_01VGuf1PP5DQf9mGupdFyk7f`):**
```
[2mdist/[22m[32mfounding.html                     [39m[1m[2m  0.89 kB[22m[1m[22m[2m │ gzip:  0.47 kB[22m
[2mdist/[22m[32mapp.html                          [39m[1m[2m  1.10 kB[22m[1m[22m[2m │ gzip:  0.47 kB[22m
[2mdist/[22m[32madmin.html                        [39m[1m[2m  1.16 kB[22m[1m[22m[2m │ gzip:  0.50 kB[22m
[2mdist/[22m[32mindex.html                        [39m[1m[2m  1.16 kB[22m[1m[22m[2m │ gzip:  0.54 kB[22m
[2mdist/[22m[32mtry.html                          [39m[1m[2m  1.19 kB[22m[1m[22m[2m │ gzip:  0.52 kB[22m
[2mdist/[22m[35massets/index-DPp1_qCS.css         [39m[1m[2m123.61 kB[22m[1m[22m[2m │ gzip: 17.71 kB[22m
[2mdist/[22m[36massets/copy-CrJwD2mp.js           [39m[1m[2m  0.41 kB[22m[1m[22m[2m │ gzip:  0.32 kB[22m
[2mdist/[22m[36massets/refresh-cw-Db844eSd.js     [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:  0.33 kB[22m
[2mdist/[22m[36massets/circle-alert-BMNSDXMU.js   [39m[1m[2m  0.72 kB[22m[1m[22m[2m │ gzip:  0.36 kB[22m
[2mdist/[22m[36massets/trialLogic-C3sZxREL.js     [39m[1m[2m  0.90 kB[22m[1m[22m[2m │ gzip:  0.55 kB[22m
[2mdist/[22m[36massets/loader-circle-CxrJx2Gw.js  [39m[1m[2m  2.37 kB[22m[1m[22m[2m │ gzip:  0.91 kB[22m
[2mdist/[22m[36massets/ccip-DijDtdjS.js           [39m[1m[2m  4.75 kB[22m[1m[22m[2m │ gzip:  2.04 kB[22m
[2mdist/[22m[36massets/try-CexyobEc.js            [39m[1m[2m 10.22 kB[22m[1m[22m[2m │ gzip:  3.74 kB[22m
[2mdist/[22m[36massets/secp256k1-Z5xO8CmM.js      [39m[1m[2m 27.86 kB[22m[1m[22m[2m │ gzip: 10.84 kB[22m
[2mdist/[22m[36massets/admin-BV-MGxTK.js          [39m[1m[2m 38.89 kB[22m[1m[22m[2m │ gzip: 14.04 kB[22m
[2mdist/[22m[36massets/app-DKVDNX0U.js            [39m[1m[2m129.63 kB[22m[1m[22m[2m │ gzip: 32.03 kB[22m
[2mdist/[22m[36massets/proxy-DNNLAyR7.js          [39m[1m[2m134.11 kB[22m[1m[22m[2m │ gzip: 43.85 kB[22m
[2mdist/[22m[36massets/index-BFNJjRyU.js          [39m[1m[2m194.60 kB[22m[1m[22m[2m │ gzip: 60.85 kB[22m
[2mdist/[22m[36massets/landing-DYYNYwh1.js        [39m[1m[2m242.18 kB[22m[1m[22m[2m │ gzip: 52.73 kB[22m
[2mdist/[22m[36massets/founding-C8m-Tgdt.js       [39m[1m[2m263.75 kB[22m[1m[22m[2m │ gzip: 77.13 kB[22m
[32m✓ built in 9.10s[39m
BUILD_EXIT=0
```


### 🤖 Claude *(2026-07-04 16:43:36)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:43:38)*

Build is green - both new entries (`try.html`, `admin.html`) bundle, `qrcode` is in the admin chunk, `trialLogic` is a shared chunk. Now let me drive the actual endpoint code at runtime (the no-DB branches: honeypot, validation, admin auth) to prove the handlers execute and are wired correctly.


### 🤖 Claude *(2026-07-04 16:43:48)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01YbfmsRUWFDYu7Hc4sUrY2b`)
```json
{
  "file_path": "C:\\Users\\ASUS\\AppData\\Local\\Temp\\claude\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\dea88f5f-ecda-43b9-a864-77d2a7d27179\\scratchpad\\smoke.ts",
  "content": "// Runtime smoke test of the /try + /admin handlers (no-DB branches only).\nconst REPO = \"C:/Users/ASUS/Documents/Github Projects/panik_waitlist\";\nconst load = (p: string) => import(\"file:///\" + `${REPO}/${p}`.replace(/ /g, \"%20\"));\n\ninterface Cap { status: number; body: unknown }\nfunction mock() {\n  const cap: Cap = { status: 0, body: null };\n  const res = {\n    status(c: number) { cap.status = c; return res; },\n    json(b: unknown) { cap.body = b; },\n  };\n  return { res, cap };\n}\n\nasync function main() {\n  const redeem = (await load(\"api/try/redeem.ts\")).default as (req: unknown, res: unknown) => Promise<void>;\n  const access = (await load(\"api/try/access.ts\")).default as (req: unknown, res: unknown) => Promise<void>;\n  const admin = (await load(\"api/admin/campaigns.ts\")).default as (req: unknown, res: unknown) => Promise<void>;\n\n  // Ensure ADMIN_ACCESS_KEY behavior is deterministic for the test.\n  delete process.env.ADMIN_ACCESS_KEY;\n\n  const t1 = mock();\n  await redeem({ method: \"POST\", headers: {}, query: {}, body: { honeypot: \"bot\", code: \"PANIK-TRY-ABCD\" } }, t1.res);\n  console.log(\"redeem honeypot   ->\", t1.cap.status, JSON.stringify(t1.cap.body));\n\n  const t2 = mock();\n  await redeem({ method: \"POST\", headers: {}, query: {}, body: {} }, t2.res);\n  console.log(\"redeem no-code    ->\", t2.cap.status, JSON.stringify(t2.cap.body));\n\n  const t3 = mock();\n  await access({ method: \"POST\", headers: {}, query: {}, body: {} }, t3.res);\n  console.log(\"access no-token   ->\", t3.cap.status, JSON.stringify(t3.cap.body));\n\n  const t4 = mock();\n  await admin({ method: \"GET\", headers: {}, query: {}, body: {} }, t4.res);\n  console.log(\"admin unconfigured->\", t4.cap.status, JSON.stringify(t4.cap.body));\n\n  process.env.ADMIN_ACCESS_KEY = \"secret123\";\n  const t5 = mock();\n  await admin({ method: \"GET\", headers: { \"x-admin-key\": \"wrong\" }, query: {}, body: {} }, t5.res);\n  console.log(\"admin bad-key     ->\", t5.cap.status, JSON.stringify(t5.cap.body));\n}\n\nmain().catch((e) => { console.error(\"SMOKE FAILED\", e); process.exit(1); });\n"
}
```


### 👤 User *(2026-07-04 16:43:49)*

**Tool Result (✅ Success - ID: `toolu_01YbfmsRUWFDYu7Hc4sUrY2b`):**
```
File created successfully at: C:\Users\ASUS\AppData\Local\Temp\claude\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\dea88f5f-ecda-43b9-a864-77d2a7d27179\scratchpad\smoke.ts (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:43:53)*

**🛠️ Tool Call:** `PowerShell` (ID: `toolu_014cZtvWBdBqhrLzczpjUAZ1`)
```json
{
  "command": "node --import tsx \"C:\\Users\\ASUS\\AppData\\Local\\Temp\\claude\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\dea88f5f-ecda-43b9-a864-77d2a7d27179\\scratchpad\\smoke.ts\" 2>&1",
  "description": "Run handler smoke test",
  "timeout": 60000
}
```


### 👤 User *(2026-07-04 16:43:59)*

**Tool Result (✅ Success - ID: `toolu_014cZtvWBdBqhrLzczpjUAZ1`):**
```
redeem honeypot   -> 200 {"ok":false,"outcome":"not_found"}
redeem no-code    -> 400 {"ok":false,"error":"missing code"}
access no-token   -> 400 {"ok":false,"error":"missing token"}
admin unconfigured-> 503 {"error":"admin unconfigured (ADMIN_ACCESS_KEY)"}
admin bad-key     -> 401 {"error":"unauthorized"}
```


### 🤖 Claude *(2026-07-04 16:44:13)*

<details>
<summary>💭 Thinking Process</summary>


</details>


### 🤖 Claude *(2026-07-04 16:44:15)*

All handler branches respond exactly as designed - the endpoints execute end-to-end (imports resolve, honeypot no-ops without burning a code, admin auth gates correctly). The DB-backed success paths need the migration applied against live Supabase, which is the documented manual step.

Let me record the one genuinely non-obvious gotcha I hit (it will bite any future React list code here), then finalize.


### 🤖 Claude *(2026-07-04 16:44:23)*

**🛠️ Tool Call:** `Write` (ID: `toolu_01EuXgLqsRJ8XdppLTzVKpCp`)
```json
{
  "file_path": "C:\\Users\\ASUS\\.claude\\projects\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\memory\\reference_no_react_types.md",
  "content": "---\nname: reference-no-react-types\ndescription: Repo ships no @types/react, so `key`/`ref` on custom components fail tsc; put keys on intrinsic wrappers.\nmetadata:\n  type: reference\n---\n\nThe panik_waitlist repo has **no `@types/react` / `@types/react-dom` installed** (verified 2026-07-05: not in package.json, not on disk). Vite/esbuild strips types at build time so it doesn't matter for `npm run build`, but `tsc --noEmit` (`npm run lint`) has no `JSX.IntrinsicAttributes`, so **`key` and `ref` are rejected on custom components** (e.g. `<MyComp key={x}/>` errors TS2322 \"Property 'key' does not exist\"). Intrinsic elements type as `any`, so `<div key={x}>` is fine.\n\n**How to apply:** when rendering a list of a custom component, put the key on an intrinsic wrapper: `list.map(x => <div key={x.id}><MyComp .../></div>)`. Do NOT add `@types/react` to \"fix\" it - installing it surfaces ~2 unrelated pre-existing latent type errors in [[project-system-architecture]] app files (AppDemo.tsx, DashboardScrollPreview.tsx) and changes the whole team's type baseline.\n\nNote: `npm run lint` is already red at HEAD on 3 pre-existing wagmi errors in `src/panik-founding/` (writeContract missing `chain`/`account`). The bar for new work is \"adds no new tsc errors,\" not \"zero errors\".\n"
}
```


### 👤 User *(2026-07-04 16:44:24)*

**Tool Result (✅ Success - ID: `toolu_01EuXgLqsRJ8XdppLTzVKpCp`):**
```
File created successfully at: C:\Users\ASUS\.claude\projects\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\memory\reference_no_react_types.md (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:44:26)*

**🛠️ Tool Call:** `Read` (ID: `toolu_015K1HUARqkAXuFyUqUDMojw`)
```json
{
  "file_path": "C:\\Users\\ASUS\\.claude\\projects\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\memory\\MEMORY.md"
}
```


### 👤 User *(2026-07-04 16:44:26)*

**Tool Result (✅ Success - ID: `toolu_015K1HUARqkAXuFyUqUDMojw`):**
```
1	# Memory Index
2	
3	- [Feedback: Report before commit](feedback_report_before_commit.md) — never commit/push without reporting and explicit approval first.
4	
5	- [Project: Backend Plan](project_backend_plan.md) — Approved Supabase backend design for the waitlist; covers schema, Edge Function, Turnstile, invite flow, and 7 resolved design gaps.
6	- [Project: Payment + Journey](project_payment_journey.md) — $3 refundable on-chain escrow (Base/USDC) early-access model; full user journey in docs/USER_JOURNEY.md with 7 open decisions.
7	- [Project: System Architecture](project_system_architecture.md) — panik-core app architecture: off-chain scoring, RPC+Multicall3 data layer, SIWE, 3-contract roadmap; full spec in docs/technical-docs/SYSTEM_ARCHITECTURE.md.
8	- [Project: Backtest Validation](project_backtest_validation.md) — money-facing black-swan backtest proving PANIK accuracy; rigor rules + events in docs/technical-docs/BACKTEST_METHODOLOGY.md.
9	- [Project: Railway Worker Deploy](project_railway_worker_deploy.md) - panik-watch-worker does not auto-deploy on push; use `railway up --service panik-watch-worker`.
10	
```


### 🤖 Claude *(2026-07-04 16:44:31)*

**🛠️ Tool Call:** `Edit` (ID: `toolu_01ToMQW4cFWyZR74qdgX43Yz`)
```json
{
  "replace_all": false,
  "file_path": "C:\\Users\\ASUS\\.claude\\projects\\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\\memory\\MEMORY.md",
  "old_string": "- [Project: Railway Worker Deploy](project_railway_worker_deploy.md) - panik-watch-worker does not auto-deploy on push; use `railway up --service panik-watch-worker`.",
  "new_string": "- [Project: Railway Worker Deploy](project_railway_worker_deploy.md) - panik-watch-worker does not auto-deploy on push; use `railway up --service panik-watch-worker`.\n- [Reference: No React types](reference_no_react_types.md) - repo has no @types/react; put `key` on intrinsic wrappers, and `npm run lint` is already red on 3 pre-existing founding errors."
}
```


### 👤 User *(2026-07-04 16:44:32)*

**Tool Result (✅ Success - ID: `toolu_01ToMQW4cFWyZR74qdgX43Yz`):**
```
The file C:\Users\ASUS\.claude\projects\c--Users-ASUS-Documents-Github-Projects-panik-waitlist\memory\MEMORY.md has been updated successfully. (file state is current in your context — no need to Read it back)
```


### 🤖 Claude *(2026-07-04 16:44:41)*

**🛠️ Tool Call:** `TodoWrite` (ID: `toolu_014swAiuQdXNU4zMaPoGb1SJ`)
```json
{
  "todos": [
    {
      "content": "Write migration 20260704000001_product_codes.sql (tables, RPCs, RLS, cron)",
      "status": "completed",
      "activeForm": "Writing product_codes migration"
    },
    {
      "content": "Create server/campaignStore.ts (PostgREST + secret key, code gen)",
      "status": "completed",
      "activeForm": "Creating campaignStore"
    },
    {
      "content": "Create api/try/redeem.ts, api/try/access.ts, api/admin/campaigns.ts",
      "status": "completed",
      "activeForm": "Creating api endpoints"
    },
    {
      "content": "Mirror endpoints as Express routes in scripts/api-server.ts",
      "status": "completed",
      "activeForm": "Mirroring Express routes"
    },
    {
      "content": "Build /try page (src/panik-try/ + try.html) with scan+manual paths",
      "status": "completed",
      "activeForm": "Building /try page"
    },
    {
      "content": "Build /admin page (src/panik-admin/ + admin.html) with QR + status",
      "status": "completed",
      "activeForm": "Building /admin page"
    },
    {
      "content": "Add trial-awareness banner to core app (src/panik-core)",
      "status": "completed",
      "activeForm": "Adding core app trial banner"
    },
    {
      "content": "Wire vite.config.ts, vercel.json, .env.example, add qrcode+vitest deps",
      "status": "completed",
      "activeForm": "Wiring build config and deps"
    },
    {
      "content": "Write vitest tests for trialLogic pure functions",
      "status": "completed",
      "activeForm": "Writing vitest tests"
    },
    {
      "content": "Run lint + tests, verify end-to-end",
      "status": "completed",
      "activeForm": "Running lint/tests and verifying"
    }
  ]
}
```


### 👤 User *(2026-07-04 16:44:41)*

**Tool Result (✅ Success - ID: `toolu_014swAiuQdXNU4zMaPoGb1SJ`):**
```
Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable
```


### 🤖 Claude *(2026-07-04 16:45:00)*

The feature is built, verified, and **not committed** (reporting first, per your standing rule).

## What shipped

**The model** (from your answers): the card carries a shared **campaign code** (`PANIK-TRY-XXXX`, usage-limited). Scanning lands on `/try?code=...`; **Try Now** redeems it and mints the visitor a **unique, personal link** (`panik.fi/app?trial=PANIK-XXXXXX`). Each user's trial clock starts **when they first open the app** with their link, and expires from there.

**Data** - [supabase/migrations/20260704000001_product_codes.sql](supabase/migrations/20260704000001_product_codes.sql): `product_campaigns`, `trial_grants` (per-user tokens), `redemption_attempts` (logs every attempt + IP). Usage/time limits enforced **atomically** in `redeem_campaign_code` (guarded UPDATE - no over-limit race); `open_trial` starts the per-user clock. Deny-all RLS, `service_role`-only, pg_cron cleanup - mirrors the telegram schema.

**Backend** - [server/campaignStore.ts](server/campaignStore.ts) + handlers in [api/try/](api/try/) and [api/admin/campaigns.ts](api/admin/campaigns.ts), **mirrored as the authoritative Express routes** in [scripts/api-server.ts](scripts/api-server.ts) (that's what `/api/*` actually hits in dev and prod).

**Frontend** - three surfaces: [/try](src/panik-try/App.tsx) (business card + @panik_fi always visible, scan + manual-input paths, all invalid states), a secret-gated [/admin](src/panik-admin/App.tsx) console (create, live status, **client-side QR + PNG download**, expire), and a non-blocking [trial banner](src/panik-core/components/TrialBanner.tsx) in the core app.

## Verification
- **Lint:** 3 errors, all pre-existing `panik-founding` wagmi issues - **my code adds zero** (confirmed by stashing and re-linting HEAD).
- **Tests:** 22/22 pass ([trialLogic.test.ts](src/panik-try/lib/trialLogic.test.ts) - count/time limits, first-open expiry, scan-vs-manual parsing).
- **Build:** green; `try.html` + `admin.html` bundle, `qrcode` and shared `trialLogic` chunk out.
- **Runtime:** drove the live handlers - honeypot→200 no-op, missing input→400, admin unconfigured→503, bad key→401.

## Two notes worth your attention
1. **Repo has no `@types/react`.** I hit `key`-on-custom-component rejection under `tsc`; adding the types surfaced 2 unrelated latent bugs in your files and shifts the team's type baseline, so I reverted and used the repo's own pattern (key on an intrinsic wrapper). Saved to memory.
2. **App link shape** is `/app?trial=TOKEN` (clean query param), not the literal `/app-PANIK-...` path form - the MPA can't do arbitrary path segments without an extra rewrite. Say the word if you want that exact path style.

## Before it works live (your steps, needs your Supabase)
1. Paste [the migration](supabase/migrations/20260704000001_product_codes.sql) into the Supabase SQL editor.
2. Set `ADMIN_ACCESS_KEY` in `.env` (added to [.env.example](.env.example)).
3. `npm run dev` + `npm run dev:api`, open `/admin`, create a campaign, print the QR.

Want me to commit this (new branch, since we're on `main`), or adjust anything first?
