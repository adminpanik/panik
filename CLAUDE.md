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

- `npm run lint` (tsc --noEmit) — baseline on `main` is **3 pre-existing errors** in
  `src/panik-founding/{DepositFlow,RefundBanner}.tsx` (wagmi `chain`/`account` typing).
  Match the baseline exactly; zero new errors.
- `npm test` (26) and `npm run test:scoring` (193+) must pass.
- Contracts: `cd contracts && forge test`. forge-std is a tracked submodule —
  `git clone --recursive` builds with no setup.
- Report failures with their output. Never claim a command ran when it didn't.

## Repo facts that bite

- Canonical remote is `panik-fi/panik-landing_page_waitlist` (`origin`). `panik_fi` was a
  temporary staging repo during the Aug-2026 audit and is kept only as the `forktest`
  remote — do not open PRs there. If `gh pr create` targets the wrong repo, run
  `gh repo set-default panik-fi/panik-landing_page_waitlist`.
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
