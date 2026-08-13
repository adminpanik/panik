/**
 * The executor side's endpoint ladder.
 *
 * This is the resolution every client that touches the exit executor is built
 * on: the delegation reader, the relayer's own reads, the coverage sweep, and
 * the signer that broadcasts. It used to return ONE url and to prefer Alchemy
 * whenever a key was set, so a rate limit there ended every read and every
 * submission with the public node sitting unused. The assertions below are that
 * regression, one per rule:
 *
 *   - the public node is ALWAYS in the list, key or no key
 *   - Alchemy is last, not first
 *   - the operator's override still wins when it is set, and is dropped rather
 *     than trusted when it is blank or malformed
 *   - a URL never appears twice, because a fallback that retries the same
 *     endpoint is a fallback in name only
 *
 * No network: `executorRpcUrls` is a pure function of an env bag, and the
 * transport is only inspected, never called.
 */

import { describe, expect, it } from "vitest";
import { executorRpcTransport, executorRpcUrls } from "./exitChain";

const SEPOLIA = 84532;
const MAINNET = 8453;

const PUBLIC_SEPOLIA = "https://sepolia.base.org";
const PUBLIC_MAINNET = "https://mainnet.base.org";

/** An env bag with nothing set. Tests opt in to exactly what they need. */
const EMPTY: NodeJS.ProcessEnv = {};

describe("executorRpcUrls", () => {
  it("is the public node alone when nothing is configured", () => {
    expect(executorRpcUrls(SEPOLIA, EMPTY)).toEqual([PUBLIC_SEPOLIA]);
    expect(executorRpcUrls(MAINNET, EMPTY)).toEqual([PUBLIC_MAINNET]);
  });

  it("puts the public node ahead of Alchemy when the key is set", () => {
    expect(executorRpcUrls(SEPOLIA, { ALCHEMY_API_KEY_BASE_SEPOLIA: "k1" })).toEqual([
      PUBLIC_SEPOLIA,
      "https://base-sepolia.g.alchemy.com/v2/k1",
    ]);
    expect(executorRpcUrls(MAINNET, { ALCHEMY_API_KEY_BASE_MAINNET: "k2" })).toEqual([
      PUBLIC_MAINNET,
      "https://base-mainnet.g.alchemy.com/v2/k2",
    ]);
  });

  it("reads only its own chain's Alchemy key", () => {
    // The mainnet key on a Sepolia chain id would be an endpoint answering for
    // the wrong network, which is worse than having no key at all.
    expect(executorRpcUrls(SEPOLIA, { ALCHEMY_API_KEY_BASE_MAINNET: "k" })).toEqual([
      PUBLIC_SEPOLIA,
    ]);
    expect(executorRpcUrls(MAINNET, { ALCHEMY_API_KEY_BASE_SEPOLIA: "k" })).toEqual([
      PUBLIC_MAINNET,
    ]);
  });

  it("keeps the operator override first, and still falls back behind it", () => {
    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: "https://node.operator.example/rpc",
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual([
      "https://node.operator.example/rpc",
      PUBLIC_SEPOLIA,
      "https://base-sepolia.g.alchemy.com/v2/k1",
    ]);
  });

  it("trims the override and accepts plain http", () => {
    expect(
      executorRpcUrls(SEPOLIA, { EXIT_EXECUTOR_RPC_URL: "  http://127.0.0.1:8545  " }),
    ).toEqual(["http://127.0.0.1:8545", PUBLIC_SEPOLIA]);
  });

  it("drops a blank or malformed override instead of trying it first", () => {
    for (const override of ["", "   ", "sepolia.base.org", "wss://node.example", "not a url"]) {
      expect(executorRpcUrls(SEPOLIA, { EXIT_EXECUTOR_RPC_URL: override })).toEqual([
        PUBLIC_SEPOLIA,
      ]);
    }
  });

  it("collapses an override that names an endpoint already in the list", () => {
    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: PUBLIC_SEPOLIA,
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual([PUBLIC_SEPOLIA, "https://base-sepolia.g.alchemy.com/v2/k1"]);

    expect(
      executorRpcUrls(SEPOLIA, {
        EXIT_EXECUTOR_RPC_URL: "https://base-sepolia.g.alchemy.com/v2/k1",
        ALCHEMY_API_KEY_BASE_SEPOLIA: "k1",
      }),
    ).toEqual(["https://base-sepolia.g.alchemy.com/v2/k1", PUBLIC_SEPOLIA]);
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
    expect(urlsOf(build())).toEqual(executorRpcUrls(SEPOLIA));
  });

  it("pins an explicit endpoint, and pins it alone", () => {
    // The fork test's anvil node. Drifting onto a public node mid-run would
    // silently score a fork against mainnet-of-record state.
    expect(urlsOf(build("http://127.0.0.1:8545"))).toEqual(["http://127.0.0.1:8545"]);
  });

  it("retries inside each endpoint, not across the fallback", () => {
    // A second retry layer would only multiply the wait before the next
    // endpoint is tried at all.
    const built = build(PUBLIC_SEPOLIA);
    expect(built.config.retryCount).toBe(0);
    expect(built.value?.transports?.[0]?.config.retryCount).toBe(2);
    expect(built.value?.transports?.[0]?.config.timeout).toBe(15_000);
  });
});
