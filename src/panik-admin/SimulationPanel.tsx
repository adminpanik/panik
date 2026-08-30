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
 * Colour: none of it. A selected option is an INVERTED block, black plate with
 * white ink, and the armed banner is the lavender highlight. Neither is on the
 * risk ramp - a simulation is not a risk band, and spending a risk hue on it
 * would put a fifth meaning on five colours that currently mean exactly one
 * thing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, RefreshCw, Square } from "lucide-react";

import { Button, Chip, EmptyState, Field as CoreField, Skeleton } from "../panik-core/ui";
import {
  Field,
  Ledger,
  NotRecorded,
  Panel,
  PANEL_BODY,
  ReloadButton,
  Td,
  Th,
  Tr,
} from "./ui/controls";
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
  SIMULATION_DEFAULT_MINUTES,
  SIMULATION_CACHE_TTL_MS,
  SIMULATION_MAX_MINUTES,
  multiplierFromPct,
  pctFromMultiplier,
  scenarioByKey,
} from "../../packages/scoring/src/simulation";

const PRESETS = ARMABLE_SCENARIO_KEYS.map((k) => scenarioByKey(k)!);

/** A caption over a group of options. 11px, the floor, and it is a label. */
const CAPTION = "block label-type text-2xs text-text-muted";

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
    <Panel
      title="Market event simulator"
      actions={
        <>
          {active ? <Chip className="bg-text-primary text-white">Armed</Chip> : null}
          <ReloadButton onClick={refresh} label="Reload the simulator state" />
        </>
      }
    >
      <div className={`flex flex-col gap-5 ${PANEL_BODY}`}>
        {/* Kept inline rather than hidden in a tooltip: it is the one sentence
            that stops an operator telling a room the price actually moved. */}
        <p className="max-w-[640px] font-sans text-xs leading-relaxed text-text-secondary">
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
              <Button variant="secondary" onClick={refresh}>
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
          <ArmedView simulation={active} affected={affected} now={now} busy={busy} onStop={stop} />
        ) : (
          <>
            <div>
              <span className={CAPTION}>Scenario</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <OptionBlock
                    key={p.key}
                    selected={scenario === p.key}
                    onClick={() => setScenario(p.key)}
                    title={p.label}
                    detail={`${Math.round(p.pct * 100)}%, ${p.note}`}
                  />
                ))}
                <OptionBlock
                  selected={!scenarioByKey(scenario)}
                  onClick={() => setScenario(CUSTOM_SCENARIO_KEY)}
                  title="Custom"
                  detail="set your own"
                />
              </div>
            </div>

            {!scenarioByKey(scenario) ? (
              <Field
                label="Price change, percent"
                hint="Negative is a fall, so -30 prices the asset 30% lower."
                type="number"
                mono
                value={customPct}
                onChange={(e) => setCustomPct(e.target.value)}
                wrapClassName="w-[200px]"
              />
            ) : null}

            <div>
              <span className={CAPTION}>Assets</span>
              {assets.length === 0 ? (
                <p className="mt-2 max-w-[640px] font-sans text-xs text-text-muted">
                  No watched wallet has a scored position yet, so there is nothing a scenario could
                  move. Onboard a wallet and let one watch tick run.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {assets.map((a) => (
                    <OptionBlock
                      key={a}
                      selected={selected.includes(a)}
                      onClick={() => toggleAsset(a)}
                      title={a}
                      detail={selected.includes(a) ? asPct(multipliers[a] ?? 1) : "not simulated"}
                      monoDetail={selected.includes(a)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="w-[200px] shrink-0">
                <CoreField
                  label="Run for, minutes"
                  type="number"
                  mono
                  min={1}
                  max={SIMULATION_MAX_MINUTES}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </div>
              <p className="max-w-[400px] font-sans text-xs text-text-muted">
                Up to {SIMULATION_MAX_MINUTES}. It clears itself when the time is up, whether or not
                anyone is watching.
              </p>
            </div>

            <div>
              <Button variant="primary" onClick={arm} disabled={!canArm}>
                <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                {busy ? "Arming..." : "Arm scenario"}
              </Button>
              {/* The cache the scoring path reads sits behind this TTL and the
                  refresh is fire-and-forget, so the first poll right after arming
                  can still show the old scores. Read from the constant rather
                  than typed as a number, so the sentence cannot drift from the
                  behaviour it describes. */}
              <p className="mt-2 max-w-[400px] font-sans text-xs text-text-muted">
                Arming takes up to about {SIMULATION_CACHE_TTL_MS / 1000} seconds to reach everyone
                watching.
              </p>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * A selectable option, as a BLOCK. A button with `aria-pressed`, not a styled
 * div: this is a toggle and it has to be reachable and announced as one.
 *
 * Selected is the plate INVERTED, black with white ink, plus the 3px shadow
 * every other pressable block on this look wears. That is the whole treatment:
 * no tint, no hue, and no `white/[0.06]` overlay, which on a white page ground
 * was a difference nobody could see.
 */
function OptionBlock({
  selected,
  onClick,
  title,
  detail,
  monoDetail = false,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  detail: string;
  /** The detail is a figure (an asset's price change), so it is set in mono. */
  monoDetail?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`cursor-pointer px-3 py-2 text-left hard-edge ${
        selected
          ? "bg-text-primary text-white shadow-hard-sm"
          : "bg-surface-raised text-text-primary"
      }`}
    >
      <span className="block font-sans text-sm font-bold">{title}</span>
      <span
        className={`block text-xs ${monoDetail ? "font-mono" : "font-sans"} ${
          selected ? "text-white" : "text-text-muted"
        }`}
      >
        {detail}
      </span>
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
      {/* Lavender, which is the product's highlight and is nowhere on the risk
          ramp: the loudest block on the panel can say "something unusual is on"
          without making a claim about anybody's position. */}
      <div className="hard-edge bg-highlight p-4">
        <div className="flex flex-wrap items-start gap-4">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-sans text-sm font-bold text-text-primary">
              {simulation.label} is running
            </p>
            <p className="mt-1 font-sans text-xs text-text-secondary">
              {entries.map(([symbol, m], i) => (
                <span key={symbol}>
                  {i > 0 ? ", " : ""}
                  {symbol} at <span className="font-mono">{asPct(m)}</span>
                </span>
              ))}
            </p>
            <p className="mt-1 font-sans text-xs text-text-secondary">
              Clears itself in <span className="font-mono">{remainingLabel(simulation.expiresAt, now)}</span>, at{" "}
              <span className="font-mono">{new Date(simulation.expiresAt).toLocaleTimeString()}</span>.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Button variant="secondary" onClick={onStop} disabled={busy}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              {busy ? "Stopping..." : "Stop now"}
            </Button>
            {/* Same cache TTL as the arm-form hint above. */}
            <p className="max-w-[10rem] text-right font-sans text-xs text-text-secondary">
              Stopping takes up to about {SIMULATION_CACHE_TTL_MS / 1000} seconds to reach everyone
              watching.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="label-type text-2xs text-text-muted">
          Positions this is changing: {affected.length}
        </h3>
        <p className="mt-1 max-w-[640px] font-sans text-xs text-text-muted">
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
          <div className="mt-3 hard-edge">
            <Ledger
              head={
                <>
                  <Th>Wallet</Th>
                  <Th>Protocol</Th>
                  <Th>Collateral</Th>
                  <Th>Priced at</Th>
                  <Th>Last scored</Th>
                </>
              }
            >
              {affected.map((p) => (
                <Tr key={`${p.wallet}:${p.protocol}`}>
                  <Td className="whitespace-nowrap font-mono text-text-primary">
                    {p.wallet.slice(0, 6)}...{p.wallet.slice(-4)}
                  </Td>
                  <Td className="whitespace-nowrap font-sans text-text-secondary">
                    {PROTOCOL_NAME[p.protocol] ?? p.protocol}
                  </Td>
                  <Td className="whitespace-nowrap font-sans text-text-secondary">
                    {p.collateralSymbol ?? <NotRecorded />}
                  </Td>
                  {/* Never a zero standing in for an unknown: a position whose
                      collateral asset was never recorded cannot be said to be
                      unaffected. */}
                  <Td className="whitespace-nowrap font-mono text-text-primary">
                    {p.multiplier === null ? (
                      <NotRecorded>asset unknown</NotRecorded>
                    ) : (
                      asPct(p.multiplier)
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-text-secondary">
                    {new Date(p.updatedAt).toLocaleTimeString()}
                  </Td>
                </Tr>
              ))}
            </Ledger>
          </div>
        )}
      </div>

      {/* The scenario set is fixed while one is armed. Swapping presets under a
          running demo would change what a room is looking at with no visible
          transition; stopping and re-arming makes that a deliberate act. */}
      <p className="font-sans text-xs text-text-muted">
        Stop this scenario to arm a different one. Only one runs at a time.
      </p>
    </div>
  );
}
