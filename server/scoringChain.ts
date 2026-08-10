/**
 * Builds the scoring runtime for ONE chain: the RPC client, the protocol
 * readers and the ActiveAdapter, all from a single `ScoringChainConfig`.
 *
 * This exists because `scripts/api-server.ts` and `scripts/watch-worker.ts`
 * used to construct the same thing twice, each with `chain: base` and a
 * mainnet Alchemy URL written out as a literal. That is how the product ended
 * up scoring Base mainnet while the exit executor ran on Base Sepolia: there
 * was no one place to change. Now there is, and the two processes cannot
 * disagree about which chain they are on.
 *
 * PANIK_SCORING_CHAIN selects it. Unset (or anything unrecognised) is
 * `mainnet`, which reproduces the previous behaviour exactly.
 */

import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  AaveActiveReader,
  ActiveAdapter,
  CompoundActiveReader,
  MoonwellActiveReader,
  MorphoActiveReader,
  requestScoringChainMode,
  SCORING_CHAIN_MODES,
  scoringChainConfig,
  scoringChainMode,
  type ActiveReader,
  type AssetRiskProvider,
  type MarketSimulation,
  type Protocol,
  type PublicClientLike,
  type ScoringChainConfig,
  type ScoringChainMode,
  type SystemicRiskProvider,
} from "../packages/scoring/src/index";

/**
 * The two chain-telemetry reads `/api/chain` makes. Declared narrowly for the
 * same reason `server/exitChain.ts` does it: viem's full PublicClient type over
 * a `base | baseSepolia` union does not reconcile under this tsconfig (Base has
 * an extra deposit transaction variant), and the app hits the identical wall in
 * `src/panik-core/lib/exit.ts`.
 */
export interface ChainTelemetryClient {
  getBlockNumber(): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
}

export interface ScoringChainRuntime {
  config: ScoringChainConfig;
  /** Block number + gas price, for `/api/chain`. */
  telemetry: ChainTelemetryClient;
  adapter: ActiveAdapter;
}

export interface BuildScoringChainOptions {
  /** Raw PANIK_SCORING_CHAIN value. Anything but "testnet" resolves mainnet. */
  mode: string | undefined;
  /** Alchemy key for the RESOLVED chain — see `resolveAlchemyKey`. */
  alchemyKey: string;
  providers: { assetRisk: AssetRiskProvider; systemic: SystemicRiskProvider };
  onReaderError?: (error: unknown) => void;
  onCompoundWarn?: (message: string) => void;
  /**
   * Reads the armed market simulation, or null. Threaded through HERE rather
   * than at each call site for the same reason this module exists at all: the
   * API and the worker would otherwise each have to remember to install it, and
   * the one that forgot would keep scoring real prices while the demo insisted
   * the market had crashed. One adapter, one hook, both processes.
   */
  simulation?: () => MarketSimulation | null;
}

/**
 * The Alchemy key the configured chain needs, or a description of what is
 * missing. Returning the variable NAME matters: the failure a mis-set
 * PANIK_SCORING_CHAIN produces is "the key for the other chain is set", and a
 * message that does not name which key was wanted sends the operator looking at
 * the one they already have.
 */
export function resolveAlchemyKey(
  mode: string | undefined,
  env: Record<string, string | undefined>,
): { key: string; config: ScoringChainConfig } | { key: null; missing: string; config: ScoringChainConfig } {
  const config = scoringChainConfig(mode);
  const key = env[config.alchemyKeyEnv]?.trim();
  return key ? { key, config } : { key: null, missing: config.alchemyKeyEnv, config };
}

/**
 * Readers for the protocols that exist on this chain. Base Sepolia lists only
 * Aave V3 (chains.ts), so the other three are not constructed at all — running
 * a reader whose addresses are mainnet's against a testnet RPC would answer
 * "no position" for every wallet, which is indistinguishable from the truth and
 * therefore worse than not asking.
 */
function readersFor(
  config: ScoringChainConfig,
  chain: PublicClientLike,
  onCompoundWarn?: (message: string) => void,
): ActiveReader[] {
  const byProtocol: Record<Protocol, () => ActiveReader> = {
    aave_v3: () =>
      new AaveActiveReader(chain, config.aave.pool, config.aave.oracle, config.aave.reserves),
    moonwell: () => new MoonwellActiveReader(chain),
    compound_v3: () =>
      new CompoundActiveReader(chain, undefined, {
        onWarn: (m) => onCompoundWarn?.(m),
      }),
    // Official Morpho API (market discovery needs an index), not an RPC read.
    morpho: () => new MorphoActiveReader(),
  };
  return config.protocols.map((p) => byProtocol[p]());
}

export function buildScoringChain(opts: BuildScoringChainOptions): ScoringChainRuntime {
  const config = scoringChainConfig(opts.mode);
  const rawClient = createPublicClient({
    chain: config.mode === "mainnet" ? base : baseSepolia,
    transport: http(`https://${config.alchemyHost}.g.alchemy.com/v2/${opts.alchemyKey}`),
  });
  const chain = rawClient as unknown as PublicClientLike;

  return {
    config,
    telemetry: rawClient as ChainTelemetryClient,
    adapter: new ActiveAdapter(
      readersFor(config, chain, opts.onCompoundWarn),
      opts.providers,
      opts.onReaderError,
      { marketContext: config.marketContext, simulation: opts.simulation },
    ),
  };
}

/**
 * Every chain this process can actually read, and the one it falls back to.
 *
 * The chain used to be a process-wide constant, so a switch meant a redeploy.
 * It is now a per-REQUEST choice, which puts two chains' scores inside one
 * process at the same time. Nothing else about the scoring path changes: each
 * mode still gets exactly one runtime, built from exactly one registry entry.
 */
export interface ScoringChainSet {
  /** Used when the caller names no chain, or names one this process cannot read. */
  defaultMode: ScoringChainMode;
  /** Modes with a configured Alchemy key, so a runtime exists. */
  available: ScoringChainMode[];
  /** The runtime for a mode, or the default one when that mode is unconfigured. */
  get(mode: ScoringChainMode): ScoringChainRuntime;
  /** A raw `?chain=` value -> a runtime that exists. Never throws, never 4xxs. */
  resolve(raw: unknown): ScoringChainRuntime;
}

export interface BuildScoringChainsOptions
  extends Omit<BuildScoringChainOptions, "mode" | "alchemyKey"> {
  /** Raw PANIK_SCORING_CHAIN value: the default when a request names none. */
  defaultMode: string | undefined;
  /** Where the per-chain Alchemy keys are read from (usually `process.env`). */
  env: Record<string, string | undefined>;
}

/**
 * Build one runtime per chain whose Alchemy key is configured.
 *
 * A mode with no key is left OUT rather than built against an empty key: a
 * client that then asks for it gets the default chain, and the `chain` block
 * served with the positions names the chain it actually got. That is the only
 * arrangement in which the label can never disagree with the numbers.
 *
 * Throws when the DEFAULT mode has no key, which is the boot failure the API
 * server and the worker already exit on.
 */
export function buildScoringChains(opts: BuildScoringChainsOptions): ScoringChainSet {
  const defaultMode = scoringChainMode(opts.defaultMode);
  const runtimes = new Map<ScoringChainMode, ScoringChainRuntime>();
  for (const mode of SCORING_CHAIN_MODES) {
    const resolved = resolveAlchemyKey(mode, opts.env);
    if (resolved.key === null) continue;
    runtimes.set(mode, buildScoringChain({ ...opts, mode, alchemyKey: resolved.key }));
  }
  const fallback = runtimes.get(defaultMode);
  if (!fallback) {
    throw new Error(
      `no Alchemy key for the default scoring chain (${scoringChainConfig(defaultMode).alchemyKeyEnv})`,
    );
  }
  return {
    defaultMode,
    available: [...runtimes.keys()],
    get: (mode) => runtimes.get(mode) ?? fallback,
    resolve(raw) {
      return runtimes.get(requestScoringChainMode(raw, opts.defaultMode)) ?? fallback;
    },
  };
}

/**
 * A cache key scoped to the chain its value was computed on.
 *
 * THE trap in making the chain per-request: every warm cache in the API is
 * keyed on a wallet, and one wallet has a different position on each chain. An
 * unscoped key lets a Base Sepolia score answer a Base mainnet request for 60
 * seconds, which is the exact screenshot this feature exists to make
 * impossible: a testnet health factor under a "Base" label, or an empty mainnet
 * read erasing a testnet position the user is looking at.
 *
 * The mode goes FIRST so the key is unambiguous however the later parts are
 * shaped, and it is not omitted for mainnet: a default that leaves the segment
 * out is a default that collides with any future mode named "".
 */
export function chainScopedKey(mode: ScoringChainMode, ...parts: string[]): string {
  return [mode, ...parts].join(":");
}

/**
 * What the browser is told about the chain its positions came from.
 *
 * Served with the positions rather than derived from a VITE_ var, so the label
 * cannot disagree with the read: a client env that says mainnet while the API
 * scored Sepolia would put a wrong chain name on real numbers, which is the
 * same class of bug this whole change is fixing.
 */
export interface ScoringChainWire {
  mode: string;
  chainId: number;
  label: string;
  /**
   * The protocols this chain was actually scanned for. The dashboard draws a
   * coverage row from it: hardcoded to four, that row told a Base Sepolia user
   * that Moonwell, Morpho and Compound were "covered, no position" when nothing
   * had looked at them and nothing could.
   */
  protocols: Protocol[];
}

export function scoringChainWire(config: ScoringChainConfig): ScoringChainWire {
  return {
    mode: config.mode,
    chainId: config.chainId,
    label: config.label,
    protocols: [...config.protocols],
  };
}
