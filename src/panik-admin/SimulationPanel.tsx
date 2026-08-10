/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The market-event simulator: arm a price scenario, see what it affects, clear
 * it.
 *
 * What this actually does is override the PRICE at the scoring boundary
 * (packages/scoring/src/simulation.ts). Everything downstream then reacts for
 * real: bands flip, the watch worker records a transition, alerts dispatch with
 * a simulated marker in their text, and the advisor recommends an exit that,
 * when the user signs it, is a genuine transaction. The copy on this panel says
 * so, because an operator who thinks they are moving an on-chain price will
 * eventually tell a room that, and it is not true.
 *
 * Colour: none of it. The scenario chips and the armed banner use the neutral
 * border/text tokens, not the risk ramp - a simulation is not a risk band, and
 * spending a risk hue on it would put a fifth meaning on five colours that
 * currently mean exactly one thing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, RefreshCw, Square } from "lucide-react";

import { Button, Card, EmptyState, Skeleton } from "../panik-core/ui";
import { Field, NotRecorded, StatusPill, TableScroller, Th } from "./ui/controls";
import {
  armSimulation,
  clearSimulation,
  getSimulation,
  isSignedOut,
  type AffectedPosition,
  type Simulation,
} from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";
/**
 * A VALUE import from the engine, deep into `simulation.ts`, which has no
 * runtime imports of its own (the package barrel reaches viem and must never
 * enter a browser bundle - see src/panik-core/lib/live.ts). This is what stops
 * the console offering a "Crash" that means something other than the -40% the
 * scoring path applies.
 */
import {
  ARMABLE_SCENARIO_KEYS,
  CUSTOM_SCENARIO_KEY,
  MARKET_SCENARIOS,
  SIMULATION_DEFAULT_MINUTES,
  SIMULATION_MAX_MINUTES,
  multiplierFromPct,
  pctFromMultiplier,
  scenarioByKey,
} from "../../packages/scoring/src/simulation";

const PRESETS = ARMABLE_SCENARIO_KEYS.map((k) => scenarioByKey(k)!);

/** A multiplier as the drop an operator typed. 0.6 -> "-40%". */
function asPct(multiplier: number): string {
  const pct = pctFromMultiplier(multiplier) * 100;
  return `${pct > 0 ? "+" : ""}${Number(pct.toFixed(1))}%`;
}

/** mm:ss, refreshed each second. An operator running a demo needs the seconds. */
function remainingLabel(expiresAt: number, now: number): string {
  const ms = Math.max(0, expiresAt - now);
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const PROTOCOL_NAME: Record<string, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

export function SimulationPanel({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [active, setActive] = useState<Simulation | null>(null);
  const [affected, setAffected] = useState<AffectedPosition[]>([]);
  const [assets, setAssets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [scenario, setScenario] = useState<string>("crash");
  const [selected, setSelected] = useState<string[]>([]);
  const [customPct, setCustomPct] = useState("-30");
  const [minutes, setMinutes] = useState(String(SIMULATION_DEFAULT_MINUTES));
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback(
    (data: { simulation: Simulation | null; affected: AffectedPosition[]; assets?: string[] }) => {
      setActive(data.simulation);
      setAffected(data.affected);
      if (data.assets) {
        setAssets(data.assets);
        // Preselect everything the watched wallets actually hold, but only
        // while the operator has not made a choice of their own.
        setSelected((prev) => (prev.length === 0 ? data.assets! : prev));
      }
      setError("");
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await getSimulation(session);
    setLoading(false);
    if (res.ok && res.data) apply(res.data);
    else if (isSignedOut(res.status)) onSignedOut();
    else setError(res.error ?? "Could not load the simulator.");
  }, [session, onSignedOut, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The countdown, and only while something is armed. An interval that runs
  // against an empty panel is a re-render a second for no reason.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  // A scenario that reaches its expiry with this panel open should stop
  // claiming to be armed without waiting for a poll. The server has already
  // stopped applying it; this only keeps the console honest about that.
  useEffect(() => {
    if (active && now >= active.expiresAt) void refresh();
  }, [active, now, refresh]);

  const multipliers = useMemo(() => {
    const preset = scenarioByKey(scenario);
    const pct = preset ? preset.pct : Number(customPct) / 100;
    if (!Number.isFinite(pct)) return {};
    const out: Record<string, number> = {};
    for (const symbol of selected) out[symbol] = multiplierFromPct(pct);
    return out;
  }, [scenario, customPct, selected]);

  const armLabel =
    scenarioByKey(scenario)?.label ??
    `Custom ${Number.isFinite(Number(customPct)) ? `${Number(customPct)}%` : ""}`.trim();

  async function arm() {
    setBusy(true);
    const res = await armSimulation(session, {
      scenario: scenarioByKey(scenario) ? scenario : CUSTOM_SCENARIO_KEY,
      label: armLabel,
      multipliers,
      durationMinutes: Number(minutes),
    });
    setBusy(false);
    if (res.ok && res.data) apply(res.data);
    else if (isSignedOut(res.status)) onSignedOut();
    else setError(res.error ?? "Could not arm the scenario.");
  }

  async function stop() {
    setBusy(true);
    const res = await clearSimulation(session);
    setBusy(false);
    if (res.ok && res.data) apply(res.data);
    else if (isSignedOut(res.status)) onSignedOut();
    else setError(res.error ?? "Could not clear the scenario.");
  }

  function toggleAsset(symbol: string) {
    setSelected((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol],
    );
  }

  const canArm =
    !busy &&
    selected.length > 0 &&
    Object.keys(multipliers).length > 0 &&
    Number(minutes) >= 1 &&
    Number(minutes) <= SIMULATION_MAX_MINUTES;

  return (
    <Card tone="panel" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-sans font-bold text-text-primary">Market event simulator</h2>
        {active ? <StatusPill tone="live">Armed</StatusPill> : null}
        <Button
          variant="quiet"
          className="ml-auto"
          onClick={refresh}
          aria-label="Reload the simulator state"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Reload
        </Button>
      </div>

      {/* Kept inline rather than hidden in a tooltip: it is the one sentence
          that stops an operator telling a room the price actually moved. */}
      <p className="mb-4 max-w-3xl text-xs font-sans leading-relaxed text-text-secondary">
        Arming a scenario makes the engine score every watched position as if the chosen assets had
        moved by that much. Scores, bands, alerts and advice all follow for real. No on-chain price
        changes, and the exit a user signs afterwards is a real transaction. Everyone in the app
        sees a marker while this is on.
      </p>

      {error ? (
        <EmptyState
          tone="problem"
          title="The simulator did not respond"
          hint={error}
          action={
            <Button variant="outline" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          }
        />
      ) : loading && !active && assets.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : active ? (
        <ArmedView
          simulation={active}
          affected={affected}
          now={now}
          busy={busy}
          onStop={stop}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <span className="block text-xs font-sans text-text-secondary">Scenario</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <ScenarioChip
                  key={p.key}
                  selected={scenario === p.key}
                  onClick={() => setScenario(p.key)}
                  title={p.label}
                  detail={`${Math.round(p.pct * 100)}%, ${p.note}`}
                />
              ))}
              <ScenarioChip
                selected={!scenarioByKey(scenario)}
                onClick={() => setScenario(CUSTOM_SCENARIO_KEY)}
                title="Custom"
                detail="set your own"
              />
            </div>
          </div>

          {!scenarioByKey(scenario) ? (
            <Field
              label="Price change"
              hint="A percentage. Negative is a fall, so -30 prices the asset 30% lower."
              type="number"
              value={customPct}
              onChange={(e) => setCustomPct(e.target.value)}
              className="max-w-xs"
            />
          ) : null}

          <div>
            <span className="block text-xs font-sans text-text-secondary">Assets</span>
            {assets.length === 0 ? (
              <p className="mt-2 text-xs font-sans text-text-muted">
                No watched wallet has a scored position yet, so there is nothing a scenario could
                move. Onboard a wallet and let one watch tick run.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {assets.map((a) => (
                  <ScenarioChip
                    key={a}
                    selected={selected.includes(a)}
                    onClick={() => toggleAsset(a)}
                    title={a}
                    detail={selected.includes(a) ? asPct(multipliers[a] ?? 1) : "not simulated"}
                  />
                ))}
              </div>
            )}
          </div>

          <Field
            label="Run for"
            hint={`Minutes, up to ${SIMULATION_MAX_MINUTES}. It clears itself when the time is up, whether or not anyone is watching.`}
            type="number"
            min={1}
            max={SIMULATION_MAX_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="max-w-xs"
          />

          <div>
            <Button variant="primary" onClick={arm} disabled={!canArm}>
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              {busy ? "Arming..." : "Arm scenario"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * A selectable option. A button with `aria-pressed`, not a styled div: this is
 * a toggle and it has to be reachable and announced as one.
 */
function ScenarioChip({
  selected,
  onClick,
  title,
  detail,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`cursor-pointer rounded-sm border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-border-strong bg-white/[0.06] text-text-primary"
          : "border-border-subtle text-text-secondary hover:bg-white/[0.03]"
      }`}
    >
      <span className="block text-xs font-sans font-bold">{title}</span>
      <span className="block text-2xs font-sans text-text-muted">{detail}</span>
    </button>
  );
}

function ArmedView({
  simulation,
  affected,
  now,
  busy,
  onStop,
}: {
  simulation: Simulation;
  affected: AffectedPosition[];
  now: number;
  busy: boolean;
  onStop: () => void;
}) {
  const entries = Object.entries(simulation.multipliers);
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-md border border-border-strong bg-surface-sunken p-4">
        <div className="flex flex-wrap items-start gap-4">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-sans font-bold text-text-primary">
              {simulation.label} is running
            </p>
            <p className="mt-1 text-xs font-sans text-text-secondary">
              {entries.map(([symbol, m], i) => (
                <span key={symbol}>
                  {i > 0 ? ", " : ""}
                  {symbol} at {asPct(m)}
                </span>
              ))}
            </p>
            <p className="mt-1 text-2xs font-sans text-text-muted">
              Clears itself in {remainingLabel(simulation.expiresAt, now)}, at{" "}
              {new Date(simulation.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
          <Button variant="outline" onClick={onStop} disabled={busy}>
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {busy ? "Stopping..." : "Stop now"}
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-sans font-bold text-text-primary">
          Positions this is changing: {affected.length}
        </h3>
        <p className="mt-1 text-2xs font-sans text-text-muted">
          As of each position's last watch tick. A position not listed here holds none of the
          simulated assets and is scoring from real prices.
        </p>
        {affected.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              tone="clear"
              title="Nothing is affected"
              hint="No watched position holds any of the simulated assets, so nobody's screen will change."
            />
          </div>
        ) : (
          <TableScroller>
            <table className="mt-3 w-full min-w-[36rem] text-left text-sm font-sans">
              <thead>
                <tr>
                  <Th>Wallet</Th>
                  <Th>Protocol</Th>
                  <Th>Collateral</Th>
                  <Th>Priced at</Th>
                  <Th>Last scored</Th>
                </tr>
              </thead>
              <tbody>
                {affected.map((p) => (
                  <tr key={`${p.wallet}:${p.protocol}`} className="border-t border-border-subtle">
                    <td className="py-2 pr-4 font-mono text-xs text-text-primary">
                      {p.wallet.slice(0, 6)}...{p.wallet.slice(-4)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {PROTOCOL_NAME[p.protocol] ?? p.protocol}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {p.collateralSymbol ?? <NotRecorded />}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-primary">
                      {/* Never a zero standing in for an unknown: a position
                          whose collateral asset was never recorded cannot be
                          said to be unaffected. */}
                      {p.multiplier === null ? (
                        <NotRecorded>asset unknown</NotRecorded>
                      ) : (
                        asPct(p.multiplier)
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {new Date(p.updatedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </div>

      {/* The scenario set is fixed while one is armed. Swapping presets under a
          running demo would change what a room is looking at with no visible
          transition; stopping and re-arming makes that a deliberate act. */}
      <p className="text-2xs font-sans text-text-muted">
        Stop this scenario to arm a different one. Only one runs at a time.
      </p>
    </div>
  );
}
