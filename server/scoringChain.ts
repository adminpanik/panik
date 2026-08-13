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

import { createPublicClient, fallback, http } from "viem";
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
  /**
   * Alchemy key for the RESOLVED chain — see `resolveAlchemyKey`. OPTIONAL:
   * null/undefined builds a public-only client rather than an unusable one.
   */
  alchemyKey?: string | null;
  /** Where `SCORING_RPC_URL_*` is read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
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
 * The Alchemy key the configured chain would use, or a description of what is
 * missing. Returning the variable NAME matters: the failure a mis-set
 * PANIK_SCORING_CHAIN produces is "the key for the other chain is set", and a
 * message that does not name which key was wanted sends the operator looking at
 * the one they already have.
 *
 * A null key is no longer a boot failure — `buildScoringChain` falls back to
 * the chain's public node — so callers report it and carry on.
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

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The endpoints a scoring read tries, in order.
 *
 *   1. `SCORING_RPC_URL_<CHAIN>`, when it is set and is an http(s) URL. An
 *      operator who runs a node has said so; nothing should be tried ahead of
 *      it. A blank or malformed value is DROPPED rather than trusted, because
 *      a typo at the head of the list would otherwise be an invisible outage:
 *      the reads still succeed on entry 2 and nobody notices the endpoint they
 *      paid for is never reached.
 *   2. The chain's public node. Keyless, so it is always here.
 *   3. Alchemy, ONLY when the key for this chain is configured.
 *
 * Public FIRST, Alchemy behind it, is deliberate and is the fix for the outage
 * this function exists for: a free-tier quota that ran out took every
 * server-side read down at once, because the single Alchemy URL was the whole
 * transport. The scoring path issues nothing but standard JSON-RPC — no
 * `alchemy_*` method — so the public node answers it identically, and the paid
 * endpoint becomes the backstop for when the public one rate-limits instead of
 * the single point of failure.
 *
 * Duplicates collapse: an override naming the public node is one endpoint, not
 * a fallback that retries the same URL twice.
 */
export function scoringRpcUrls(
  config: ScoringChainConfig,
  alchemyKey: string | null | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const urls: string[] = [];
  const override = env[config.rpcUrlEnv]?.trim();
  if (override && isHttpUrl(override)) urls.push(override);
  urls.push(config.publicRpcUrl);
  const key = alchemyKey?.trim();
  if (key) urls.push(`https://${config.alchemyHost}.g.alchemy.com/v2/${key}`);
  return [...new Set(urls)];
}

export function buildScoringChain(opts: BuildScoringChainOptions): ScoringChainRuntime {
  const config = scoringChainConfig(opts.mode);
  const rawClient = createPublicClient({
    chain: config.mode === "mainnet" ? base : baseSepolia,
    // Retries at the TAIL only: rotating to a different provider is cheaper
    // than re-asking one that said slow down, so retries are reserved for the
    // endpoint that has no one behind it. `retryCount: 0` on the fallback keeps
    // a genuine execution revert from being re-asked of every node in turn.
    //
    // No client-level `batch.multicall` here, unlike the browser config. The
    // readers call `client.multicall()` explicitly, and viem already caps that
    // action's calldata chunks at 1024 bytes by default — the same public-node
    // limit the browser config pins by hand. Setting it on the client would
    // additionally route bare `readContract` calls (activeMoonwell) through
    // Multicall3, which is a behaviour change rather than a transport fix.
    transport: fallback(
      scoringRpcUrls(config, opts.alchemyKey, opts.env ?? process.env).map((url, i, all) =>
        http(url, {
          timeout: 15_000,
          ...(i === all.length - 1 ? { retryCount: 2, retryDelay: 300 } : { retryCount: 0 }),
        }),
      ),
      { retryCount: 0 },
    ),
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
  /**
   * Modes a runtime exists for. Every registered mode, now that each one has a
   * keyless public endpoint: a missing Alchemy key shortens the fallback list,
   * it does not remove the chain.
   */
  available: ScoringChainMode[];
  /** The runtime for a mode, or the default one when that mode is unconfigured. */
  get(mode: ScoringChainMode): ScoringChainRuntime;
  /** A raw `?chain=` value -> a runtime that exists. Never throws, never 4xxs. */
  resolve(raw: unknown): ScoringChainRuntime;
}

export interface BuildScoringChainsOptions
  extends Omit<BuildScoringChainOptions, "mode" | "alchemyKey" | "env"> {
  /** Raw PANIK_SCORING_CHAIN value: the default when a request names none. */
  defaultMode: string | undefined;
  /** Where the per-chain keys and RPC overrides are read from (`process.env`). */
  env: Record<string, string | undefined>;
}

/**
 * Build one runtime per registered chain.
 *
 * Every mode is built, key or no key. This used to skip a chain whose Alchemy
 * key was absent, and to throw when the DEFAULT chain's key was absent — which
 * made an expired free tier a refusal to boot rather than a slower read. With
 * a keyless public endpoint in the fallback list for every chain, "no key" is
 * a shorter endpoint list, not an unreadable chain, and there is nothing left
 * for the process to exit over.
 *
 * The invariant that mattered is untouched: each mode still gets exactly one
 * runtime from exactly one registry entry, and the `chain` block served with
 * the positions still names the chain that was actually read.
 */
export function buildScoringChains(opts: BuildScoringChainsOptions): ScoringChainSet {
  const defaultMode = scoringChainMode(opts.defaultMode);
  const runtimes = new Map<ScoringChainMode, ScoringChainRuntime>();
  for (const mode of SCORING_CHAIN_MODES) {
    const resolved = resolveAlchemyKey(mode, opts.env);
    runtimes.set(
      mode,
      buildScoringChain({ ...opts, mode, alchemyKey: resolved.key, env: opts.env }),
    );
  }
  // Non-null by construction: `defaultMode` is a member of SCORING_CHAIN_MODES
  // and the loop above builds every member.
  const fallbackRuntime = runtimes.get(defaultMode) as ScoringChainRuntime;
  return {
    defaultMode,
    available: [...runtimes.keys()],
    get: (mode) => runtimes.get(mode) ?? fallbackRuntime,
    resolve(raw) {
      return runtimes.get(requestScoringChainMode(raw, opts.defaultMode)) ?? fallbackRuntime;
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
