/**
 * Market-simulation store over the Supabase PostgREST API, plus the cache the
 * scoring processes read it through.
 *
 * Pure `fetch` with the service key, mirroring server/campaignStore.ts: no `pg`,
 * so it bundles as an ESM serverless function and runs unchanged inside the
 * Express API and the watch worker.
 *
 * WHY THIS IS PERSISTED AT ALL. An in-memory scenario would be wrong in both
 * directions across a restart. The API and the worker are separate processes
 * (Procfile: `web` and `worker`), so a scenario armed in one would never reach
 * the other, and the demo would show a crashed dashboard with a worker still
 * scoring calm prices and sending no alert. And a worker that restarts mid-demo
 * would silently drop a simulation the operator believes is running, or - if it
 * were cached without an expiry - silently resume one that should have died.
 * The row is the single fact both processes read, and it carries its own death.
 *
 * Table: supabase/migrations/20260810000003_market_simulations.sql.
 */

import {
  activeSimulation,
  isUsableMultiplier,
  SIMULATION_CACHE_TTL_MS,
  SIMULATION_MAX_MINUTES,
  SIMULATION_MIN_MINUTES,
  type MarketSimulation,
} from "../packages/scoring/src/simulation";

// Re-exported so callers that reached for it here still resolve; the definition
// lives in packages/scoring so the admin console can import it too.
export { SIMULATION_CACHE_TTL_MS };

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

/** The row as it sits in Postgres. */
export interface SimulationRow {
  id: string;
  scenario: string;
  label: string;
  multipliers: Record<string, number>;
  set_by: string;
  started_at: string;
  expires_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
}

export interface ArmSimulationInput {
  scenario: string;
  label: string;
  multipliers: Record<string, number>;
  durationMinutes: number;
  setBy: string;
}

/**
 * Row -> engine type. `Date.parse` on a timestamptz is the only conversion; the
 * engine works in epoch ms so that expiry is a comparison and not a timezone
 * argument.
 */
export function rowToSimulation(row: SimulationRow): MarketSimulation {
  return {
    id: row.id,
    scenario: row.scenario,
    label: row.label,
    multipliers: row.multipliers ?? {},
    setBy: row.set_by,
    startedAt: Date.parse(row.started_at),
    expiresAt: Date.parse(row.expires_at),
  };
}

/**
 * Validate an operator's request before it can reach the scoring path.
 *
 * Rejecting rather than clamping: an operator who asked for a 40% drop and
 * silently got a 20% one would demonstrate the wrong thing and never know. The
 * one exception is an empty multiplier set, which is refused outright because an
 * "armed" scenario that changes no number would light the marker over numbers
 * that are, in fact, real - a marker that lies about itself.
 */
export function validateArmInput(input: ArmSimulationInput): string | null {
  if (!input.scenario.trim()) return "scenario is required";
  if (!input.label.trim()) return "label is required";
  if (
    !Number.isFinite(input.durationMinutes) ||
    input.durationMinutes < SIMULATION_MIN_MINUTES ||
    input.durationMinutes > SIMULATION_MAX_MINUTES
  ) {
    return `duration must be between ${SIMULATION_MIN_MINUTES} and ${SIMULATION_MAX_MINUTES} minutes`;
  }
  const entries = Object.entries(input.multipliers ?? {});
  if (entries.length === 0) return "at least one asset must be simulated";
  for (const [symbol, multiplier] of entries) {
    if (!symbol.trim()) return "asset symbol cannot be blank";
    if (!isUsableMultiplier(multiplier)) {
      return `multiplier for ${symbol} must be a positive number`;
    }
    // A price move of more than 99% down or 10x up is not a market event this
    // product has language for, and a fat-fingered 0.001 would render every
    // position instantly liquidatable in front of an audience.
    if (multiplier < 0.01 || multiplier > 10) {
      return `multiplier for ${symbol} must be between 0.01 and 10`;
    }
  }
  if (entries.every(([, m]) => m === 1)) return "at least one asset must actually move";
  return null;
}

export class SimulationStore {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
  ) {
    this.base = supabaseUrl.replace(/\/+$/, "");
  }

  /** Build from env; throws if unconfigured (caller maps to 503). */
  static fromEnv(): SimulationStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return new SimulationStore(url, key);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * The uncleared row, if any. EXPIRY IS NOT FILTERED HERE, on purpose: the
   * engine's `activeSimulation()` is the single place a scenario is judged live,
   * and a second expiry test written in PostgREST syntax is a second place for
   * the two to disagree. The caller passes what it finds to `activeSimulation`
   * and gets null if the window has closed.
   *
   * Uncleared rows are unique (partial index in the migration), so this is at
   * most one row.
   */
  async currentRow(): Promise<SimulationRow | null> {
    const res = await fetch(
      `${this.base}/rest/v1/market_simulations?cleared_at=is.null&order=started_at.desc&limit=1`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      await logErrorBody("simulation current", res);
      throw new Error(`simulation current: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as SimulationRow[];
    return rows[0] ?? null;
  }

  /**
   * Arm a scenario, replacing whatever was running. Exactly ONE scenario is
   * active at a time and this is where that is enforced: a second concurrent
   * scenario would mean two answers to "why did this number move", and the
   * marker on screen could name only one of them.
   *
   * Clear-then-insert, in that order. If the insert fails the operator is left
   * with nothing armed rather than with the previous scenario silently still
   * running under a console that has moved on.
   */
  async arm(input: ArmSimulationInput): Promise<SimulationRow> {
    await this.clear(input.setBy);

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + input.durationMinutes * 60_000);
    const res = await fetch(`${this.base}/rest/v1/market_simulations`, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        scenario: input.scenario,
        label: input.label,
        multipliers: input.multipliers,
        set_by: input.setBy,
        started_at: startedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      }),
    });
    if (!res.ok) {
      await logErrorBody("simulation arm", res);
      throw new Error(`simulation arm: HTTP ${res.status}`);
    }
    const rows = (await res.json()) as SimulationRow[];
    const row = rows[0];
    if (!row) throw new Error("simulation arm: no row returned");
    return row;
  }

  /**
   * Clear every uncleared row. Idempotent, and a no-op when nothing is armed:
   * "stop the simulation" must always be safe to press twice, including by a
   * second operator who cannot see what the first one did.
   *
   * Rows are retained rather than deleted. They are the provenance record that
   * lets a snapshot or transition taken under a scenario be read honestly later.
   */
  async clear(clearedBy: string): Promise<void> {
    const res = await fetch(
      `${this.base}/rest/v1/market_simulations?cleared_at=is.null`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({
          cleared_at: new Date().toISOString(),
          cleared_by: clearedBy,
        }),
      },
    );
    if (!res.ok) {
      await logErrorBody("simulation clear", res);
      throw new Error(`simulation clear: HTTP ${res.status}`);
    }
  }
}

/**
 * The read path for the scoring processes: a tiny TTL cache in front of the
 * store, exposing a SYNCHRONOUS getter because that is what `ActiveAdapter`
 * needs at the price boundary.
 *
 * The refresh is fired off the getter and never awaited, so scoring is never
 * blocked on the database and a database outage cannot stall a watch tick. What
 * the getter returns is always run through `activeSimulation()` against the
 * CURRENT clock, which is what makes expiry work without any refresh at all: a
 * stale cached row whose window has closed resolves to null on the next read,
 * even if the store has been unreachable for an hour.
 *
 * The failure direction is deliberate. A refresh that throws leaves the previous
 * value in place, and the previous value still expires. So the worst a database
 * outage can do is run a scenario to its natural end, or delay one starting - it
 * can never extend one past its window, and it can never invent one.
 */
export class SimulationCache {
  private cached: MarketSimulation | null = null;
  private fetchedAt = 0;
  private inFlight = false;

  constructor(
    private readonly store: Pick<SimulationStore, "currentRow">,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SIMULATION_CACHE_TTL_MS,
    private readonly onError: (err: unknown) => void = (err) =>
      console.error(`simulation refresh failed: ${(err as Error).message.slice(0, 200)}`),
  ) {}

  /** The armed scenario, or null. Never throws, never blocks. */
  current(): MarketSimulation | null {
    const now = this.now();
    if (now - this.fetchedAt >= this.ttlMs) void this.refresh();
    return activeSimulation(this.cached, now);
  }

  /** Force a read. Awaited by the routes that just changed the row. */
  async refresh(): Promise<MarketSimulation | null> {
    if (this.inFlight) return activeSimulation(this.cached, this.now());
    this.inFlight = true;
    try {
      const row = await this.store.currentRow();
      this.cached = row ? rowToSimulation(row) : null;
      this.fetchedAt = this.now();
    } catch (err) {
      // Leave the previous value alone. It still expires; see the class note.
      this.fetchedAt = this.now();
      this.onError(err);
    } finally {
      this.inFlight = false;
    }
    return activeSimulation(this.cached, this.now());
  }

  /** Adopt a row the caller just wrote, so the next score does not wait a TTL. */
  set(sim: MarketSimulation | null): void {
    this.cached = sim;
    this.fetchedAt = this.now();
  }
}

/**
 * What the browser is told about an armed simulation.
 *
 * Sent WITH the positions, for the same reason the chain label is: the marker
 * has to describe the response it arrived with. A separately-polled marker could
 * light up over the previous poll's real numbers, or - much worse - go dark over
 * numbers that are still simulated, which is the exact screenshot this feature
 * must make impossible.
 */
export interface SimulationWire {
  id: string;
  scenario: string;
  label: string;
  multipliers: Record<string, number>;
  /** Epoch ms. The client renders remaining time from it and stops at 0. */
  expiresAt: number;
  startedAt: number;
}

export function simulationWire(sim: MarketSimulation): SimulationWire {
  return {
    id: sim.id,
    scenario: sim.scenario,
    label: sim.label,
    multipliers: sim.multipliers,
    expiresAt: sim.expiresAt,
    startedAt: sim.startedAt,
  };
}
