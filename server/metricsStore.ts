/**
 * Admin dashboard metrics over the Supabase PostgREST API.
 *
 * Pure `fetch` with the service key, mirroring server/campaignStore.ts and
 * server/simulationStore.ts: no `pg`, so this bundles as an ESM serverless
 * function and runs unchanged inside the Express API.
 *
 * All five figures come from ONE `admin_metrics()` RPC (currently
 * supabase/migrations/20260814000003_admin_metrics_real_prices.sql — the
 * function is replaced in place, so the newest migration touching it is the
 * live definition). The aggregation is in SQL rather than here because the
 * honest alternative is fetching every score_snapshot row over HTTP to add up
 * one column.
 *
 * WHAT THIS MODULE REFUSES TO DO: invent a zero. Every numeric field is
 * `number | null`, and null survives all the way to the console, which prints
 * the unknown glyph. A degraded price feed once made a $120,000 debt read as
 * $40; the same class of bug on a dashboard tile is a screenshot in a pitch
 * deck claiming the product monitors nothing.
 */

/**
 * PostgREST error bodies quote the failing SQL and, on an auth failure, the
 * project ref. They belong in the server log, never in a thrown message.
 */
async function logErrorBody(
  scope: string,
  res: { status: number; text(): Promise<string> },
): Promise<void> {
  const body = await res.text().catch(() => "");
  console.error(`${scope}: HTTP ${res.status} ${body.slice(0, 300)}`);
}

/**
 * The tile set, exactly as the console consumes it.
 *
 * `collateralUsd` is deliberately NOT called TVL. PANIK is non-custodial and
 * locks nothing: this is the collateral it is watching, sitting in the user's
 * own Aave/Moonwell/Morpho position. Calling it TVL would claim custody the
 * product does not have, and the copy rule against stating a fact the code does
 * not know applies to labels as much as to values.
 */
export interface AdminMetrics {
  /** Active rows in the watch registry. Never null: a count is always known. */
  walletsConnected: number;
  /** Distinct (wallet, protocol) pairs under watch. */
  positionsMonitored: number;
  /** How many of those we could price. Below positionsMonitored = partial sum. */
  positionsPriced: number;
  /** Sum of latest collateral across priced positions. Null = nothing priced. */
  collateralUsd: number | null;
  /**
   * The OLDEST of the snapshots feeding the above, not the newest. The cue
   * exists to answer "can I trust this total", and one freshly scored position
   * does not make the other eighteen current. Null = no snapshots at all.
   */
  oldestReadingAt: string | null;
  /**
   * False when the Goldsky events table is missing OR has never been written
   * to. Existence alone is not readiness: the table ships in the scoring-engine
   * migration whether or not the pipeline was ever provisioned, and an empty
   * one reported as ready renders as "0 transactions", which is
   * indistinguishable from a genuinely quiet month.
   */
  eventsReady: boolean;
  /** Lending events on watched wallets. Null when no events exist at all. */
  txCount: number | null;
  /** Zero when there are no matching events; null only when they are unpriced. */
  txVolumeUsd: number | null;
  /** Events with no USD amount, so a partial volume is visibly partial. */
  txUnpriced: number | null;
  /**
   * Oldest event still on hand, which is what the two figures above actually
   * cover. Retention prunes this table to 7 days, so there is no all-time total
   * to report and no 30-day subset that would differ from it.
   */
  txOldestAt: string | null;
  generatedAt: string;
}

/** jsonb numbers arrive as JSON numbers; anything else is treated as unknown. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A count the schema guarantees. Falls back to 0 only when the RPC omits it. */
function count(value: unknown): number {
  return num(value) ?? 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** RPC payload -> the wire shape, with every unknown preserved as null. */
export function toMetrics(raw: unknown): AdminMetrics {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    walletsConnected: count(r.walletsConnected),
    positionsMonitored: count(r.positionsMonitored),
    positionsPriced: count(r.positionsPriced),
    collateralUsd: num(r.collateralUsd),
    oldestReadingAt: str(r.oldestReadingAt),
    eventsReady: r.eventsReady === true,
    txCount: num(r.txCount),
    txVolumeUsd: num(r.txVolumeUsd),
    txUnpriced: num(r.txUnpriced),
    txOldestAt: str(r.txOldestAt),
    generatedAt: str(r.generatedAt) ?? new Date().toISOString(),
  };
}

export class MetricsStore {
  private readonly base: string;

  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly doFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.base = url.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(doFetch?: typeof globalThis.fetch): MetricsStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new MetricsStore(url, key, doFetch);
  }

  async fetchMetrics(): Promise<AdminMetrics> {
    const res = await this.doFetch(`${this.base}/rest/v1/rpc/admin_metrics`, {
      method: "POST",
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      await logErrorBody("admin_metrics", res);
      throw new Error(`admin_metrics: HTTP ${res.status}`);
    }
    return toMetrics(await res.json());
  }
}
