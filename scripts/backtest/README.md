# Backtest scripts

Two kinds of data live here:

- **`datasets/`** — curated CSVs, tracked in git. These back the published numbers in
  `docs/technical-docs/BACKTEST_RESULTS.md`.
- **`data/`** — a fetch cache of Dune/RPC pulls, **gitignored and regenerable**. It is
  not in a fresh clone.

The scoring test suite (`npm run test:scoring`) uses inline fixtures and reads neither
directory, so a fresh clone tests clean. But the research scripts below read `data/`
directly and will fail with `ENOENT` if you run them before regenerating it.

## Regenerating `data/`

Needs `DUNE_API_KEY` (and `ALCHEMY_API_KEY_BASE_MAINNET` for the survivor fetches):

```bash
node --env-file=.env scripts/backtest/pull-cohort.mjs        # → *-candidates.json
node --env-file=.env scripts/backtest/fetch-survivors-multi.mjs  # → *-hf.json
```

`pull-cohort-base.mjs` / `pull-cohort-usdc.mjs` and `fetch-survivors-base.mjs` /
`fetch-survivors-eth.ts` cover the other chains; `run-dune.mjs` is the raw query helper.

## Consumers that need `data/` present

`price-walk.ts`, `survivor-matrix-multi.mjs`, `survivor-matrix-real.ts` read it with no
existence check. `export-csv.mjs` guards and skips missing inputs.

## Scripts that run on a fresh clone (no key, no network)

Both read only `datasets/` and the price fixtures in `packages/scoring/tests/fixtures/`,
and both carry their measured output in the file docblock so the result travels with the
method:

```bash
node --import tsx scripts/backtest/holdout-recall.ts   # recall by calibration/holdout split
node --import tsx scripts/backtest/crash-drawdown.ts   # crash-conditional drawdown + repay futility
```

`holdout-recall.ts` is the offline twin of `survivor-matrix-real.ts`: it reproduces the
published per-event recall exactly from the exported CSVs, then labels each event by
whether the shipped thresholds were chosen on it. FTX is absent from both because no
price series for Nov 2022 is committed here.
