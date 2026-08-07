/**
 * Dune history provider — builds a wallet's lifetime cross-chain lending
 * feature vector by executing the parameterized PANIK feature query.
 * This is the ANALYTICS tier (SYSTEM_ARCHITECTURE §3.2): once-per-login,
 * cacheable — NOT the 60s live loop. See WALLET_PROFILER.md §2.
 *
 * Keys stay server-side. The browser never calls Dune directly.
 */

import type { WalletFeatures } from "../classify/types";
import type { FetchFn } from "./types";

/** Saved Dune query: "PANIK — wallet persona features (param)". */
export const PANIK_FEATURES_QUERY_ID = 7771860;

export interface DuneHistoryOptions {
  baseUrl?: string;
  queryId?: number;
  /** "free" keeps cost ~0.3 credits/run; this dataset rejects medium/large. */
  performance?: "free" | "medium" | "large";
  /** Max seconds to poll for execution completion. */
  timeoutSec?: number;
  /** Poll interval, ms. */
  pollMs?: number;
  fetchFn?: FetchFn;
}

interface DuneRow {
  lending_tx_count: number;
  chains_active: number;
  protocols_used: number;
  protocols: string[] | null;
  lending_age_days: number;
  days_since_last_activity: number;
  deposited_usd: number;
  withdrawn_usd: number;
  borrowed_usd: number;
  repaid_usd: number;
  borrow_events: number;
  liquidations: number;
  borrow_to_deposit_ratio: number;
  top_protocol: string | null;
  top_chain: string | null;
  top_collateral_symbol: string | null;
  top_borrow_symbol: string | null;
  stable_borrow_pct: number;
}

/** A wallet with zero lending history — a valid, low-risk classification input. */
export const EMPTY_FEATURES: WalletFeatures = {
  lendingTxCount: 0,
  chainsActive: 0,
  protocolsUsed: 0,
  protocols: [],
  lendingAgeDays: 0,
  daysSinceLastActivity: 0,
  depositedUsd: 0,
  withdrawnUsd: 0,
  borrowedUsd: 0,
  repaidUsd: 0,
  borrowEvents: 0,
  liquidations: 0,
  borrowToDepositRatio: 0,
  topProtocol: null,
  topChain: null,
  topCollateralSymbol: null,
  topBorrowSymbol: null,
  stableBorrowPct: 0,
};

export class DuneHistoryProvider {
  private readonly baseUrl: string;
  private readonly queryId: number;
  private readonly performance: "free" | "medium" | "large";
  private readonly timeoutSec: number;
  private readonly pollMs: number;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly apiKey: string,
    opts: DuneHistoryOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://api.dune.com/api/v1";
    this.queryId = opts.queryId ?? PANIK_FEATURES_QUERY_ID;
    this.performance = opts.performance ?? "free";
    this.timeoutSec = opts.timeoutSec ?? 120;
    this.pollMs = opts.pollMs ?? 2_000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "X-Dune-API-Key": this.apiKey, "Content-Type": "application/json" };
  }

  /**
   * Lifetime cross-chain lending features for one wallet — blocking execute +
   * poll loop. Used by the local dev API; the serverless start/poll path uses
   * startExecution + pollFeatures instead (timeout-proof).
   */
  async getFeatures(wallet: string): Promise<WalletFeatures> {
    const executionId = await this.startExecution(wallet);
    const deadline = Date.now() + this.timeoutSec * 1000;
    for (;;) {
      const r = await this.pollFeatures(executionId);
      if (r.status === "done") return r.features;
      if (Date.now() > deadline) throw new Error("Dune execution timed out");
      await new Promise((res) => setTimeout(res, this.pollMs));
    }
  }

  /**
   * Kick off the Dune execution and return its id immediately (~1s). The
   * serverless "start scan" step calls this on wallet entry; the result is
   * polled later via pollFeatures so no single request runs long.
   */
  async startExecution(wallet: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/query/${this.queryId}/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        performance: this.performance,
        query_parameters: { wallet: wallet.toLowerCase() },
      }),
    });
    if (!res.ok) throw new Error(`Dune execute: HTTP ${res.status}`);
    const body = (await res.json()) as { execution_id?: string };
    if (!body.execution_id) throw new Error("Dune execute: no execution_id");
    return body.execution_id;
  }

  /**
   * One non-blocking status check for an execution. Returns the features when
   * complete, or {status:"pending"} while still running. Throws on a failed/
   * cancelled/expired execution. This is the serverless-friendly primitive:
   * each call is a single fast HTTP request, never a long poll.
   */
  async pollFeatures(
    executionId: string,
  ): Promise<{ status: "pending" } | { status: "done"; features: WalletFeatures }> {
    // Encoded even though the API layer validates the id — this is the last
    // point before the URL is built, so a future caller can't inject a path.
    const res = await this.fetchFn(`${this.baseUrl}/execution/${encodeURIComponent(executionId)}/results`, {
      headers: this.headers(),
    });
    // Transient — rate-limited (429) or a Dune hiccup (5xx). Don't fail the
    // whole reveal; report pending so the client keeps polling (with backoff).
    if (res.status === 429 || res.status >= 500) return { status: "pending" };
    if (!res.ok) throw new Error(`Dune results: HTTP ${res.status}`);
    const body = (await res.json()) as { state: string; result?: { rows: DuneRow[] } };

    if (body.state === "QUERY_STATE_COMPLETED") {
      const row = body.result?.rows?.[0];
      return { status: "done", features: row ? this.toFeatures(row) : EMPTY_FEATURES };
    }
    if (
      body.state === "QUERY_STATE_FAILED" ||
      body.state === "QUERY_STATE_CANCELLED" ||
      body.state === "QUERY_STATE_EXPIRED"
    ) {
      throw new Error(`Dune execution ${body.state}`);
    }
    return { status: "pending" };
  }

  private toFeatures(r: DuneRow): WalletFeatures {
    return {
      lendingTxCount: Number(r.lending_tx_count) || 0,
      chainsActive: Number(r.chains_active) || 0,
      protocolsUsed: Number(r.protocols_used) || 0,
      protocols: r.protocols ?? [],
      lendingAgeDays: Number(r.lending_age_days) || 0,
      daysSinceLastActivity: Number(r.days_since_last_activity) || 0,
      depositedUsd: Number(r.deposited_usd) || 0,
      withdrawnUsd: Number(r.withdrawn_usd) || 0,
      borrowedUsd: Number(r.borrowed_usd) || 0,
      repaidUsd: Number(r.repaid_usd) || 0,
      borrowEvents: Number(r.borrow_events) || 0,
      liquidations: Number(r.liquidations) || 0,
      borrowToDepositRatio: Number(r.borrow_to_deposit_ratio) || 0,
      topProtocol: r.top_protocol ?? null,
      topChain: r.top_chain ?? null,
      topCollateralSymbol: r.top_collateral_symbol ?? null,
      topBorrowSymbol: r.top_borrow_symbol ?? null,
      stableBorrowPct: Number(r.stable_borrow_pct) || 0,
    };
  }
}
