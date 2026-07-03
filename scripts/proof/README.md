# PANIK near-liquidation alert prover

A standalone Python script that proves the Telegram alert pipeline works on REAL
data: it finds the most at-risk live Base lending positions, scores them with the
real PANIK engine, and sends a Telegram alert for each.

## What it does

1. Loads candidate Base borrower wallets (the repo's backtest datasets by default,
   or a fresh Dune query, or a file).
2. Scores each wallet with the LIVE PANIK engine via `GET /api/positions` - the same
   scoring the product uses (no reimplementation).
3. Ranks by PANIK risk score and keeps the top N positions that have real debt
   (materiality floor, same as the product's dispatcher - dust positions are skipped).
4. Sends a Telegram alert per wallet via the Bot API, and writes a CSV report.

It sends Telegram itself (rather than via the worker) because `telegram_links.chat_id`
is unique - one chat can only link to one wallet - so the production dispatcher cannot
fan 50 strangers' wallets to a single chat. Scoring still uses the real engine, so this
honestly proves: (a) PANIK flags near-liquidation, and (b) Telegram delivery works.

## Setup

```
cd scripts/proof
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

```
# Required to actually send (skip for --dry-run):
export TELEGRAM_BOT_TOKEN=123456:ABC...        # your @PanikDeFi_Bot token
export PANIK_ALERT_CHAT_ID=123456789           # your chat id (see --whoami)

# Optional:
export PANIK_API_BASE=https://panikrisk-scoring-production.up.railway.app   # default
# For --source dune:
export DUNE_API_KEY=...
export DUNE_BORROWERS_QUERY_ID=...             # a saved Dune query (SQL below)
```

Find your chat id: open `@PanikDeFi_Bot` in Telegram, press Start / send any message, then:

```
python near_liquidation_alerts.py --whoami
```

## Run

```
# 1. Dry run first - score + report, send nothing:
python near_liquidation_alerts.py --dry-run

# 2. For real - find the 50 riskiest live positions and alert each:
python near_liquidation_alerts.py

# Fresh currently-active borrowers via Dune instead of the repo datasets:
python near_liquidation_alerts.py --source dune

# Strict "on the edge" only (may find fewer than 50 in a calm market):
python near_liquidation_alerts.py --strict-hf 1.1
```

Output: a console table + `near_liquidation_report.csv` (wallet, protocol, score, band,
health factor, collateral/borrow USD, status). When sending, your Telegram receives one
alert per position plus a final summary.

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--source` | `csv` | `csv` (repo datasets), `dune` (fresh borrowers), `file` |
| `--file` | - | wallet list (one 0x address per line) for `--source file` |
| `--count` | `50` | how many alerts to send |
| `--profile` | `conservative` | risk profile to score against (conservative = most sensitive) |
| `--min-borrow` | `50` | materiality floor: skip positions with less USD debt |
| `--strict-hf` | off | only keep positions with health factor <= this |
| `--max-candidates` | `900` | cap how many wallets to scan |
| `--concurrency` | `6` | parallel scoring requests |
| `--dry-run` | off | score + report, do not send Telegram |
| `--whoami` | off | print chat ids that messaged the bot, then exit |

## Dune source (optional)

The `dune` source runs a saved Dune query that returns recent Base borrowers. Create a
query on dune.com, save it, and put its id in `DUNE_BORROWERS_QUERY_ID`. Suggested SQL
(adjust column names to the current spellbook if needed):

```sql
select distinct borrower as owner
from lending.borrow
where blockchain = 'base'
  and block_time > now() - interval '30' day
limit 2000
```

The script reads the `owner` (or `address` / `borrower`) column.

## Notes

- Read-only: the script only reads the live API and sends Telegram. It does not write to
  Supabase or touch `watched_wallets`.
- Honest framing: in a calm market few wallets sit at HF <= 1.1, so the default selects
  the 50 highest-risk live positions ("most at-risk right now"). Use `--strict-hf` for a
  hard liquidation-edge cut.
- Scanning ~900 wallets at concurrency 6 takes a few minutes (each is a live on-chain read).
