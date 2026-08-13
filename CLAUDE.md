# PANIK — working agreement

DeFi liquidation-risk scoring + early-warning. Vite/React SPA, Express API on Railway,
Supabase Postgres, Foundry escrow contract on Base.

## Model roles

| Role | Model | Does what |
|---|---|---|
| Orchestrator | Fable 5 | Plans, scopes PRs, delegates, reviews returned diffs, writes PR bodies, talks to the user. Does not do bulk implementation. |
| Executor | Opus | All substantive work: features, security fixes, contract changes, money math, multi-file refactors, reviews that need judgment. |
| Trivial | Sonnet / Haiku | Mechanical one-file edits, renames, copy tweaks, dependency bumps, formatting, single-fact lookups. |

Delegate by default. Escalate a tier when the work touches funds, auth, or
consensus-critical logic; never downgrade those to save tokens.

Run independent agents in ONE message so they work in parallel. Give each a
disjoint file set — overlapping scopes cause merge conflicts. Use
`isolation: "worktree"` when agents write files concurrently.

**Never let two agents edit `AppDemo.tsx` at once.** It is one ~3400-line file holding
all five tabs, so almost any UI task touches it. Sequence them.

**When delegating UI work, restate the constraints in the prompt.** Do not rely on the
agent opening `docs/DESIGN_SYSTEM.md` on its own. What made the rules hold in practice
was naming them per task, with the numbers: which surface is the reference, the current
risk-hued element count it must not exceed, and the exact verification commands with
their expected output. Tell it to report the measured numbers back.

**Verify returned work yourself.** Re-run the commands and read the diff — do not trust
the report. Across the UI rebuild, agent reports were mostly accurate but the misses
were the expensive kind: a duplicated money-math formula, a comment describing code that
had since changed, and screenshots swept into a commit by `git add -A`.

## Branch and PR rules

- Never commit to `main`. Never merge to `main` without explicit user consent —
  Vercel previews exist to verify first.
- One branch per logical change, based on `origin/main`. Name: `fix/…`, `feat/…`, `chore/…`.
- Stack only when unavoidable (shared helpers). Base the PR on its parent branch and
  say so at the top of the body; GitHub retargets on parent merge.
- Pushing branches and opening PRs: fine without asking. Merging: ask.
- PR bodies state what changed, what was verified (actual command output, not
  "should work"), and what was deliberately deferred.

## Commits

Semantic: `type(scope): description` — imperative, under 72 chars, no trailing period.
Types: feat, fix, refactor, style, perf, test, docs, chore, ci, revert.
One logical unit per commit. Never amend; add a new commit. **No `Co-Authored-By`
lines, ever.** `/simpcommit` enforces this.

## Verification before a PR goes up

- `npm run lint` (tsc --noEmit) — baseline is **0 errors**. The 3 long-standing wagmi
  `chain`/`account` errors in `src/panik-founding/{DepositFlow,RefundBanner}.tsx`
  disappeared once `@types/react` was installed (`feat/design-system`, Phase 0) — they
  were an artifact of missing type packages, not a real wagmi incompatibility.
  `strictNullChecks` is on. The CI ratchet still fails at >=4 and can now be replaced
  with a plain `npm run lint`.
- `npm test` and `npm run test:scoring` must pass with zero failures. Do not trust a
  remembered count — the suites grow with nearly every PR (667 and 445 as of
  2026-08-13). Measure the baseline on `origin/main` when you need a delta.
- Contracts: `cd contracts && forge test`. forge-std is a tracked submodule —
  `git clone --recursive` builds with no setup.
- Report failures with their output. Never claim a command ran when it didn't.
- **UI work has extra gates.** See the checklist in `docs/DESIGN_SYSTEM.md`. In short:
  measure in a real browser rather than eyeballing — `scrollWidth === innerWidth` at
  390/768/1024/1440/2000, zero console errors, count the risk-hued elements with a
  computed-style scan, and confirm no text below 11px by measuring the DOM (not by
  grepping source).

## UI and design

**Read `docs/DESIGN_SYSTEM.md` before building or redesigning any screen.** It is the
product's design contract and it was written after PRs #12-#15 rebuilt the whole app UI,
so most rules exist because their absence caused a specific, named bug.

The parts that bite hardest:

- **`src/index.css` `@theme` is the only place a value may be defined.** Everything else is
  reset to `initial`, so an off-token utility renders as nothing. If you want a value that
  is not there, that is a decision to raise, not a class to invent.
- **Use the primitives in `src/panik-core/ui/`** (`Card`, `Stat`, `Button`, `RiskChip`,
  `RiskDial`, `EmptyState`, `Skeleton`, `TabPanel`). `RISK_CHIP` in `lib/utils.ts` is the
  single place a risk band becomes pixels.
- **Colour is earned.** The risk ramp belongs to risk indicators only, a handful per screen.
  Categorical data uses the cool chart palette, which contains no red or green so a series
  can never read as a risk state. Never colour a stat value, a whole sentence, or a verb.
- **No jargon and no engine enums in UI copy.** `ProfileStatus` values go through
  `LIMIT_STATE`/`LIMIT_EVENT`; health factor goes through `liquidationOutlook`, which leads
  with the price-drop buffer ("Liquidates if cbBTC falls 4.8%") and keeps the exact ratio in
  the hover.
- **Never render an unknown value as a zero.** No `$0`, `0%` or `Infinity%` standing in for
  "unknown" or "not applicable" — a degraded feed once made a $120,000 debt read as $40.
- **Never state a fact the code does not know.** No hardcoded status strings, no invented
  trends, no two cards showing the same quantity with different numbers.
- No em dashes in UI copy. No pulsing or live indicators. No text below 11px. No
  hand-drawn SVG icons (Lucide only). No new runtime dependencies.

`packages/scoring` owns scoring, money math and thresholds. If the UI needs a derived
number, **export it from the engine** rather than recomputing it — and grep for an existing
helper first. This branch shipped a second copy of `1 - 1/HF` that disagreed with the
existing one on invalid input, which is exactly what that rule exists to prevent.

## Repo facts that bite

- Canonical remote is `panik-fi/panik_fi` (`origin`) — renamed from
  `panik-landing_page_waitlist` on 2026-08-09; GitHub redirects the old name.
  `panik-fi/forktest` (previously named `panik_fi`) was a temporary staging repo during
  the Aug-2026 audit and is kept only as the `forktest` remote — do not open PRs there.
  If `gh pr create` targets the wrong repo, run `gh repo set-default panik-fi/panik_fi`.
- `executor/` is the exit-executor contract suite (Hardhat), imported 2026-08-09 from
  the recovered executor repo; full pre-import history is archived at
  `panik-fi/panik-executor-archive`. Its source is bytecode-verified against the live
  Base Sepolia deployment (see PR #25). `packages/scoring` still owns all risk math.
- `api/` is **vercelignored on purpose** — all `/api/*` rewrite to Railway. It is a
  fallback mirror of the Express routes; keep it compiling and consistent, but it does
  not serve traffic. Shared logic lives in `server/`.
- `packages/scoring` is the risk engine. Never reimplement scoring elsewhere.
- `VITE_*` is bundled into public client JS. Nothing secret gets that prefix.
- Escrow has ONE global immutable `refundDeadline`, not per-depositor windows.
  `depositTime` is a has-deposited flag and feeds no time math. Don't let copy or docs
  drift back into promising a per-user 90 days.
- Money paths: BigInt only, decimals from the token, never `Number()` on wei.
  Verify a receipt is `status === "success"` — viem does not throw on revert.

## Toolchain

Foundry 1.7.1 (`~/.foundry/bin`), Node 24, Vercel CLI, Python 3.13 (+requests, for
`scripts/proof/`). PATH is set in the Windows user env and `~/.bashrc`; a shell started
before those edits needs `bash -lc` or an explicit `export PATH`.

## Security posture

Trust boundaries are server-side. Anything acting on a wallet needs an ownership
signature (`server/walletAuth.ts`) — address format is not authorization. Rate-limit
any endpoint that spends money (Dune, OpenRouter, Alchemy) or returns PII. Admin
comparisons are timing-safe. Client-side gating is UX, never enforcement.
