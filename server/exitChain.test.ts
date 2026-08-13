import { describe, expect, it } from "vitest";
import { PUBLIC_RPC_URLS } from "../src/panik-core/lib/exitRpc";
import { executorRpcTransport, executorRpcUrls } from "./exitChain";

const SEPOLIA = 84532;
const MAINNET = 8453;

/**
 * The keyless tier, read from the registry rather than retyped. A test that
 * hardcodes the nodes passes when someone drops one from the registry, which is
 * the only edit that could quietly shrink the ladder back to what it was.
 */
const PUBLIC_SEPOLIA = [...PUBLIC_RPC_URLS[SEPOLIA]!];
const PUBLIC_MAINNET = [...PUBLIC_RPC_URLS[MAINNET]!];

/** An env bag with nothing set. Tests opt in to exactly what they need. */
const EMPTY: NodeJS.ProcessEnv = {};

describe("executorRpcUrls", () => {
  it("is the vetted public nodes when nothing is configured", () => {
    expect(PUBLIC_SEPOLIA).toHaveLength(3);
    expect(PUBLIC_MAINNET).toHaveLength(3);
    expect(executorRpcUrls(SEPOLIA, EMPTY)).toEqual(PUBLIC_SEPOLIA);
    expect(executorRpcUrls(MAINNET, EMPTY)).toEqual(PUBLIC_MAINNET);
  });

  it("puts every public node ahead of Alchemy when the key is set", () => {
    expect(executorRpcUrls(SEPOLIA, { ALCHEMY_API_KEY_BASE_SEPOLIA: "k1" })).toEqual([
      ...PUBLIC_SEPOLIA,
      "https://base-sepolia.g.alchemy.com/v2/k1",
    ]);
    expect(executorRpcUrls(MAINNET, { ALCHEMY_API_KEY_BASE_MAINNET: "k2" })).toEqual([
      ...PUBLIC_MAINNET,
      "https://base-mainnet.g.alchemy.com/v2/k2",
    ]);
  });

  it("reads only its own chain's Alchemy key", () => {
    // The mainnet key on a Sepolia chain id would be an endpoint answering for
    // the wrong network, which is worse than having no key at all.
    expect(executorRpcUrls(SEPOLIA, { ALCHEMY_API_KEY_BASE_MAINNET: "k" })).toEqual(PUBLIC_SEPOLIA);
    expect(executorRpcUrls(MAINNET, { ALCHEMY_API_KEY_BASE_SEPOLIA: "k" })).toEqual(PUBLIC_MAINNET);
  });

  it("keeps the operator override first, and still falls back behind it", () => {
    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: "https://node.operator.example/rpc",
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual([
      "https://node.operator.example/rpc",
      ...PUBLIC_SEPOLIA,
      "https://base-sepolia.g.alchemy.com/v2/k1",
    ]);
  });

  it("trims the override and accepts plain http", () => {
    expect(
      executorRpcUrls(SEPOLIA, { EXIT_EXECUTOR_RPC_URL: "  http://127.0.0.1:8545  " }),
    ).toEqual(["http://127.0.0.1:8545", ...PUBLIC_SEPOLIA]);
  });

  it("drops a blank or malformed override instead of trying it first", () => {
    for (const override of ["", "   ", "sepolia.base.org", "wss://node.example", "not a url"]) {
      expect(executorRpcUrls(SEPOLIA, { EXIT_EXECUTOR_RPC_URL: override })).toEqual(PUBLIC_SEPOLIA);
    }
  });

  it("collapses an override that names an endpoint already in the list", () => {
    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: PUBLIC_SEPOLIA[0]!,
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual([...PUBLIC_SEPOLIA, "https://base-sepolia.g.alchemy.com/v2/k1"]);

    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: "https://base-sepolia.g.alchemy.com/v2/k1",
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual(["https://base-sepolia.g.alchemy.com/v2/k1", ...PUBLIC_SEPOLIA]);
  });
});

interface BuiltTransport {
  config: { retryCount: number };
  value?: {
    transports?: {
      config: { retryCount: number; timeout: number };
      value?: { url?: string };
    }[];
  };
}

const build = (rpcUrl?: string): BuiltTransport =>
  executorRpcTransport(rpcUrl, SEPOLIA)({}) as unknown as BuiltTransport;

/** The endpoint urls a built transport would actually try, in order. */
function urlsOf(built: BuiltTransport): string[] {
  return (built.value?.transports ?? []).map((t) => t.value?.url ?? "");
}

describe("executorRpcTransport", () => {
  it("fails over across every resolved endpoint", () => {
    // Built from process.env, so this asserts against the count the same env
    // resolves to: a developer with a key set has one more endpoint than one
    // without, and both are correct.
    const urls = urlsOf(build());
    expect(urls).toEqual(executorRpcUrls(SEPOLIA));
    expect(urls.length).toBeGreaterThanOrEqual(PUBLIC_SEPOLIA.length);
  });

  it("pins an explicit endpoint, and pins it alone", () => {
    // The fork test's anvil node. Drifting onto a public node mid-run would
    // silently score a fork against mainnet-of-record state.
    expect(urlsOf(build("http://127.0.0.1:8545"))).toEqual(["http://127.0.0.1:8545"]);
  });

  it("retries only at the tail, never on the fallback itself", () => {
    // The first endpoint is a public node: retrying it twice with backoff
    // before rotating spends the wait on the node that just said no. Only the
    // last endpoint retries, because nothing is behind it.
    const built = build();
    const transports = built.value?.transports ?? [];
    expect(built.config.retryCount).toBe(0);
    expect(transports.length).toBeGreaterThan(1);
    for (const t of transports.slice(0, -1)) expect(t.config.retryCount).toBe(0);
    expect(transports.at(-1)?.config.retryCount).toBe(2);
    for (const t of transports) expect(t.config.timeout).toBe(15_000);
  });

  it("retries the pinned endpoint, which is also the last one", () => {
    const transports = build("http://127.0.0.1:8545").value?.transports ?? [];
    expect(transports).toHaveLength(1);
    expect(transports[0]?.config.retryCount).toBe(2);
  });
});
