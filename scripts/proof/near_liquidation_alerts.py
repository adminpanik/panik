#!/usr/bin/env python3
"""
PANIK - near-liquidation alert prover.

Proves the Telegram alert pipeline end to end on REAL data:
  1. Load candidate Base borrower wallets (repo CSV datasets, or a fresh Dune
     query, or a plain file).
  2. Score each wallet with the LIVE PANIK engine via GET /api/positions
     (the same scoring the product uses - no reimplementation here).
  3. Rank by PANIK risk score and take the top N most at-risk live positions
     that have real debt (materiality filter, like the product's dispatcher).
  4. Send a Telegram alert per wallet via the Bot API, and write a CSV report.

Why the script sends Telegram itself (instead of the worker): telegram_links.chat_id
is UNIQUE (one chat -> one wallet), so the production dispatcher cannot fan 50
strangers' wallets to a single chat. Scoring still uses the real engine, so this
honestly proves: (a) PANIK flags near-liquidation positions, (b) Telegram delivers.

Usage:
  python near_liquidation_alerts.py --whoami         # find your chat_id
  python near_liquidation_alerts.py --dry-run        # score + report, no send
  python near_liquidation_alerts.py                  # score + send 50 alerts

Env:
  PANIK_API_BASE        default https://panikrisk-scoring-production.up.railway.app
  TELEGRAM_BOT_TOKEN    required to send (and for --whoami)
  PANIK_ALERT_CHAT_ID   required to send (your Telegram chat id)
  DUNE_API_KEY          required for --source dune
  DUNE_BORROWERS_QUERY_ID  a saved Dune query returning recent Base borrowers
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

import requests

EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
REPO_ROOT = Path(__file__).resolve().parents[2]
DATASETS = REPO_ROOT / "scripts" / "backtest" / "datasets"
DEFAULT_API = "https://panikrisk-scoring-production.up.railway.app"
PROTOCOL_LABEL = {
    "aave_v3": "Aave V3",
    "moonwell": "Moonwell",
    "morpho": "Morpho",
    "compound_v3": "Compound V3",
}


# ----------------------------------------------------------------------------
# Candidate loading
# ----------------------------------------------------------------------------
def load_from_csv() -> list[str]:
    """Unique, valid EVM borrower addresses from the repo's backtest datasets."""
    files = [
        "liquidations_moonwell_aug2024.csv",
        "liquidations_compound_aug2024.csv",
        "liquidations_morpho_aug2024.csv",
        "positions_aave-aug24.csv",
    ]
    seen: dict[str, None] = {}
    for name in files:
        path = DATASETS / name
        if not path.exists():
            print(f"  (skip missing {name})")
            continue
        with path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                addr = (row.get("owner") or row.get("address") or "").strip().lower()
                if EVM_RE.match(addr):
                    seen.setdefault(addr, None)
    return list(seen.keys())


def load_from_file(path: str) -> list[str]:
    seen: dict[str, None] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        addr = line.strip().lower()
        if EVM_RE.match(addr):
            seen.setdefault(addr, None)
    return list(seen.keys())


def load_from_dune(limit: int) -> list[str]:
    """Run a saved Dune query that returns recent Base borrowers (column owner/address/borrower)."""
    key = os.environ.get("DUNE_API_KEY")
    qid = os.environ.get("DUNE_BORROWERS_QUERY_ID")
    if not key or not qid:
        sys.exit("DUNE source needs DUNE_API_KEY and DUNE_BORROWERS_QUERY_ID (see README).")
    h = {"X-Dune-API-Key": key}
    ex = requests.post(
        f"https://api.dune.com/api/v1/query/{qid}/execute",
        headers=h, json={"performance": "medium"}, timeout=30,
    )
    ex.raise_for_status()
    eid = ex.json()["execution_id"]
    deadline = time.time() + 180
    while time.time() < deadline:
        r = requests.get(f"https://api.dune.com/api/v1/execution/{eid}/results", headers=h, timeout=30)
        r.raise_for_status()
        body = r.json()
        state = body.get("state")
        if state == "QUERY_STATE_COMPLETED":
            rows = body.get("result", {}).get("rows", [])
            seen: dict[str, None] = {}
            for row in rows:
                addr = str(row.get("owner") or row.get("address") or row.get("borrower") or "").strip().lower()
                if EVM_RE.match(addr):
                    seen.setdefault(addr, None)
                if len(seen) >= limit:
                    break
            return list(seen.keys())
        if state in ("QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED"):
            sys.exit(f"Dune query {qid} failed: {state}")
        time.sleep(2)
    sys.exit("Dune query timed out after 180s")


# ----------------------------------------------------------------------------
# Scoring via the live PANIK API
# ----------------------------------------------------------------------------
def score_wallet(api_base: str, wallet: str, profile: str, min_borrow: float):
    """Return the wallet's MOST at-risk position with real debt, or None."""
    url = f"{api_base}/api/positions?wallet={quote(wallet)}&profile={profile}"
    for attempt in (1, 2):
        try:
            r = requests.get(url, timeout=40)
            if r.status_code != 200:
                return None
            positions = r.json().get("positions", [])
            material = [
                p for p in positions
                if p.get("healthFactor") is not None
                and (p.get("borrowValueUsd") or 0) >= min_borrow
            ]
            if not material:
                return None
            # Most at-risk leg drives the alert (highest score, lowest HF tiebreak).
            return max(material, key=lambda p: (p.get("total", 0), -(p.get("healthFactor") or 9e9)))
        except requests.RequestException:
            if attempt == 2:
                return None
            time.sleep(1)
    return None


def scan(api_base, wallets, profile, min_borrow, concurrency, max_candidates):
    """Score candidates concurrently; return list of best-position dicts (debt only)."""
    todo = wallets[:max_candidates]
    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(score_wallet, api_base, w, profile, min_borrow): w for w in todo}
        for fut in as_completed(futs):
            done += 1
            pos = fut.result()
            if pos:
                results.append(pos)
            if done % 25 == 0 or done == len(todo):
                print(f"  scored {done}/{len(todo)}  (near-liq so far: {len(results)})")
    return results


# ----------------------------------------------------------------------------
# Telegram
# ----------------------------------------------------------------------------
def trunc(w: str) -> str:
    return f"{w[:6]}...{w[-4:]}" if len(w) > 12 else w


def usd(n) -> str:
    return f"${round(n):,}" if isinstance(n, (int, float)) else "?"


def format_alert(p: dict) -> str:
    hf = p.get("healthFactor")
    lines = [
        "PANIK proof - live near-liquidation scan",
        "",
        "Position near liquidation",
        "",
        f"Wallet {trunc(p['wallet'])}",
        f"Protocol {PROTOCOL_LABEL.get(p['protocol'], p['protocol'])}",
        f"Risk score {p.get('total')} / 100 ({p.get('band')})",
    ]
    if isinstance(hf, (int, float)):
        suffix = " - near liquidation" if hf < 1.15 else ""
        lines.append(f"Health factor {hf:.2f}{suffix}")
    lines.append(f"Position {usd(p.get('collateralValueUsd'))} collateral / {usd(p.get('borrowValueUsd'))} debt")
    lines.append("")
    lines.append("Scored live by the PANIK engine. This is a pipeline-proof alert.")
    return "\n".join(lines)


def tg_send(token: str, chat_id: str, text: str) -> bool:
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            timeout=20,
        )
        return r.ok and r.json().get("ok") is True
    except requests.RequestException:
        return False


def whoami(token: str) -> None:
    r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=20)
    seen = {}
    for u in r.json().get("result", []):
        chat = (u.get("message") or {}).get("chat") or {}
        if chat.get("id"):
            seen[chat["id"]] = chat.get("username") or chat.get("first_name") or "?"
    if not seen:
        print("No recent chats. Open the bot in Telegram, press Start / send any message, then retry.")
    for cid, name in seen.items():
        print(f"  chat_id={cid}  ({name})")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="PANIK near-liquidation alert prover")
    ap.add_argument("--source", choices=["csv", "dune", "file"], default="csv")
    ap.add_argument("--file", help="path to a newline-delimited wallet list (for --source file)")
    ap.add_argument("--count", type=int, default=50, help="how many alerts to send")
    ap.add_argument("--profile", choices=["conservative", "moderate", "aggressive"], default="conservative")
    ap.add_argument("--min-borrow", type=float, default=50.0, help="materiality floor (USD debt)")
    ap.add_argument("--strict-hf", type=float, default=None, help="only keep positions with HF <= this")
    ap.add_argument("--max-candidates", type=int, default=900, help="cap how many wallets to scan")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--api-base", default=os.environ.get("PANIK_API_BASE", DEFAULT_API))
    ap.add_argument("--report", default=str(Path(__file__).with_name("near_liquidation_report.csv")))
    ap.add_argument("--dry-run", action="store_true", help="score + report, do NOT send Telegram")
    ap.add_argument("--whoami", action="store_true", help="print chat ids that messaged the bot, then exit")
    args = ap.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("PANIK_ALERT_CHAT_ID")

    if args.whoami:
        if not token:
            sys.exit("TELEGRAM_BOT_TOKEN required for --whoami")
        whoami(token)
        return

    # Sanity-check the live API first.
    try:
        h = requests.get(f"{args.api_base}/api/health", timeout=20)
        if not h.ok or h.json().get("ok") is not True:
            sys.exit(f"API health check failed at {args.api_base} (got {h.status_code}).")
    except requests.RequestException as e:
        sys.exit(f"Cannot reach API at {args.api_base}: {e}")

    if not args.dry_run and (not token or not chat_id):
        sys.exit("Sending needs TELEGRAM_BOT_TOKEN and PANIK_ALERT_CHAT_ID (or use --dry-run).")

    print(f"Loading candidates (source={args.source})...")
    if args.source == "csv":
        candidates = load_from_csv()
    elif args.source == "file":
        if not args.file:
            sys.exit("--source file needs --file PATH")
        candidates = load_from_file(args.file)
    else:
        candidates = load_from_dune(args.max_candidates)
    print(f"  {len(candidates)} unique candidate wallets")
    if not candidates:
        sys.exit("No candidates loaded.")

    print(f"Scoring via {args.api_base}/api/positions (profile={args.profile})...")
    scored = scan(args.api_base, candidates, args.profile, args.min_borrow,
                  args.concurrency, args.max_candidates)

    if args.strict_hf is not None:
        scored = [p for p in scored if (p.get("healthFactor") or 9e9) <= args.strict_hf]

    # Top-N most at-risk: highest score first, lowest HF as tiebreak.
    scored.sort(key=lambda p: (p.get("total", 0), -(p.get("healthFactor") or 9e9)), reverse=True)
    selected = scored[: args.count]
    print(f"\nFound {len(scored)} near-liquidation positions; selected top {len(selected)}.")

    sent = 0
    results_for_csv = []
    for i, p in enumerate(selected, 1):
        ok = False
        if args.dry_run:
            status = "DRY-RUN"
        else:
            ok = tg_send(token, chat_id, format_alert(p))
            sent += 1 if ok else 0
            status = "sent" if ok else "FAILED"
            time.sleep(1.0)  # be gentle with the Bot API
        hf = p.get("healthFactor")
        print(f"  [{i:>2}/{len(selected)}] {trunc(p['wallet'])} {p['protocol']:<11} "
              f"score={p.get('total'):>3} {p.get('band'):<8} HF={hf:.3f} "
              f"debt={usd(p.get('borrowValueUsd'))}  -> {status}")
        results_for_csv.append([
            p["wallet"], p["protocol"], p.get("total"), p.get("band"),
            f"{hf:.4f}" if isinstance(hf, (int, float)) else "",
            round(p.get("collateralValueUsd") or 0, 2), round(p.get("borrowValueUsd") or 0, 2),
            p.get("profileStatus"), status,
        ])

    with open(args.report, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["wallet", "protocol", "score", "band", "health_factor",
                    "collateral_usd", "borrow_usd", "profile_status", "alert_sent"])
        w.writerows(results_for_csv)

    print(f"\nReport: {args.report}")
    if args.dry_run:
        print(f"DRY-RUN complete. {len(selected)} near-liquidation positions found (no alerts sent).")
    else:
        print(f"Done. Sent {sent}/{len(selected)} Telegram alerts to chat {chat_id}.")
        if sent and token and chat_id:
            tg_send(token, chat_id,
                    f"PANIK proof complete: {sent} live near-liquidation positions detected and alerted.")


if __name__ == "__main__":
    main()
