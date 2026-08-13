import { describe, expect, it, vi } from "vitest";
import { EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import { SCORING_CHAINS, requestScoringChainMode } from "../packages/scoring/src/chains";
import { LruCache } from "./lruCache";
import {
  buildScoringChain,
  buildScoringChains,
  chainScopedKey,
  resolveAlchemyKey,
  scoringChainWire,
  scoringRpcUrls,
} from "./scoringChain";

const BOTH_KEYS = {
  ALCHEMY_API_KEY_BASE_MAINNET: "mk",
  ALCHEMY_API_KEY_BASE_SEPOLIA: "sk",
};

const providers = {
  assetRisk: { getAssetRiskInput: vi.fn() },
  systemic: { getSystemicRiskInput: vi.fn() },
};

describe("resolveAlchemyKey", () => {
  it("wants the mainnet key by default", () => {
    const r = resolveAlchemyKey(undefined, { ALCHEMY_API_KEY_BASE_MAINNET: "mk" });
    expect(r.key).toBe("mk");
    expect(r.config.chainId).toBe(8453);
  });

  it("wants the sepolia key on testnet, and names it when it is absent", () => {
    const env = { ALCHEMY_API_KEY_BASE_MAINNET: "mk" };
    const r = resolveAlchemyKey("testnet", env);
    expect(r.key).toBeNull();
    // The failure mode this message exists for: the OTHER chain's key is set,
    // so an operator told only "missing Alchemy key" checks the wrong variable.
    expect(r).toMatchObject({ missing: "ALCHEMY_API_KEY_BASE_SEPOLIA" });
    expect(r.config.label).toBe("Base Sepolia");
  });

  it("treats a blank or whitespace key as missing", () => {
    expect(resolveAlchemyKey(undefined, { ALCHEMY_API_KEY_BASE_MAINNET: "   " }).key).toBeNull();
    expect(resolveAlchemyKey(undefined, {}).key).toBeNull();
  });
});

describe("scoringRpcUrls", () => {
  const mainnet = SCORING_CHAINS.mainnet;
  const testnet = SCORING_CHAINS.testnet;

  it("puts the keyless public node FIRST and Alchemy behind it", () => {
    // The outage this ordering fixes: one exhausted free-tier key was the whole
    // transport, so every server-side read failed at once. Public first means
    // the quota is a backstop, not the front door.
    expect(scoringRpcUrls(mainnet, "mk", {})).toEqual([
      "https://mainnet.base.org",
      "https://base-mainnet.g.alchemy.com/v2/mk",
    ]);
    expect(scoringRpcUrls(testnet, "sk", {})).toEqual([
      "https://sepolia.base.org",
      "https://base-sepolia.g.alchemy.com/v2/sk",
    ]);
  });

  it("builds a usable list with no Alchemy key at all", () => {
    // This is what lets the process boot public-only instead of exiting.
    expect(scoringRpcUrls(mainnet, null, {})).toEqual(["https://mainnet.base.org"]);
    expect(scoringRpcUrls(mainnet, "   ", {})).toEqual(["https://mainnet.base.org"]);
    expect(scoringRpcUrls(mainnet, undefined, {})).toEqual(["https://mainnet.base.org"]);
  });

  it("lets SCORING_RPC_URL_* lead, per chain", () => {
    expect(
      scoringRpcUrls(mainnet, "mk", {
        SCORING_RPC_URL_BASE_MAINNET: " https://node.example/rpc ",
        SCORING_RPC_URL_BASE_SEPOLIA: "https://wrong.example",
      }),
    ).toEqual([
      "https://node.example/rpc",
      "https://mainnet.base.org",
      "https://base-mainnet.g.alchemy.com/v2/mk",
    ]);
  });

  it("drops an override that is not an http(s) URL", () => {
    // A typo at the head of the list is a worse outage than the one this list
    // prevents, and an invisible one: reads still succeed on the next entry.
    for (const bad of ["", "   ", "not-a-url", "ws://node.example", "ftp://node.example"]) {
      expect(scoringRpcUrls(mainnet, null, { SCORING_RPC_URL_BASE_MAINNET: bad })).toEqual([
        "https://mainnet.base.org",
      ]);
    }
  });

  it("collapses an override that names the public node", () => {
    // A fallback that retries the same URL twice is a fallback in name only.
    expect(
      scoringRpcUrls(mainnet, null, { SCORING_RPC_URL_BASE_MAINNET: "https://mainnet.base.org" }),
    ).toEqual(["https://mainnet.base.org"]);
  });
});

describe("buildScoringChain", () => {
  it("defaults to Base mainnet with all four readers and live market context", () => {
    const rt = buildScoringChain({ mode: undefined, alchemyKey: "k", providers });
    expect(rt.config.chainId).toBe(8453);
    expect(rt.config.protocols).toHaveLength(4);
    expect(rt.config.marketContext).toBe("measured");
  });

  it("puts the scoring path on the chain the exit executor is deployed to", () => {
    const rt = buildScoringChain({ mode: "testnet", alchemyKey: "k", providers });
    // This equality IS the feature: score the chain the Exit button acts on.
    expect(rt.config.chainId).toBe(EXIT_CHAIN_ID);
    expect(rt.config.protocols).toEqual(["aave_v3"]);
    expect(rt.config.marketContext).toBe("unavailable");
  });

  it("never scores a protocol the testnet has no market for", async () => {
    const rt = buildScoringChain({ mode: "testnet", alchemyKey: "k", providers });
    // A wallet with no position anywhere: the single Aave reader is the only
    // thing that could have been asked, so nothing can come back from a
    // mainnet-addressed reader pointed at a testnet RPC.
    expect(rt.config.protocols).not.toContain("moonwell");
    expect(rt.config.protocols).not.toContain("compound_v3");
    expect(rt.config.protocols).not.toContain("morpho");
  });
});

describe("scoringChainWire", () => {
  it("carries a renderable chain name, never a bare mode string", () => {
    const mainnet = buildScoringChain({ mode: undefined, alchemyKey: "k", providers });
    const testnet = buildScoringChain({ mode: "testnet", alchemyKey: "k", providers });
    expect(scoringChainWire(mainnet.config)).toEqual({
      mode: "mainnet",
      chainId: 8453,
      label: "Base",
      protocols: ["aave_v3", "moonwell", "compound_v3", "morpho"],
    });
    // The coverage row is drawn from this. One protocol scanned, one claimed.
    expect(scoringChainWire(testnet.config)).toEqual({
      mode: "testnet",
      chainId: 84532,
      label: "Base Sepolia",
      protocols: ["aave_v3"],
    });
  });
});

// -- the chain as a PER-REQUEST choice (Issue #57) -------------------------

describe("requestScoringChainMode", () => {
  it("uses the deployment default when the caller names no chain", () => {
    expect(requestScoringChainMode(undefined, "testnet")).toBe("testnet");
    expect(requestScoringChainMode(null, "testnet")).toBe("testnet");
    expect(requestScoringChainMode("", "testnet")).toBe("testnet");
    expect(requestScoringChainMode("   ", "testnet")).toBe("testnet");
    // Unset default is mainnet, exactly as PANIK_SCORING_CHAIN behaves.
    expect(requestScoringChainMode(undefined, undefined)).toBe("mainnet");
  });

  it("honours a chain the registry defines", () => {
    expect(requestScoringChainMode("testnet", undefined)).toBe("testnet");
    expect(requestScoringChainMode("mainnet", "testnet")).toBe("mainnet");
    expect(requestScoringChainMode(" TESTNET ", undefined)).toBe("testnet");
  });

  it("falls back to mainnet on anything unrecognised, and never throws", () => {
    // NOT the deployment default: a typo must not inherit testnet, because
    // "the scores you are reading came from a test chain" is the one thing a
    // garbled preference must never quietly assert.
    for (const raw of ["base", "sepolia", "MAINNET_", "0", "8453", "  ?  "]) {
      expect(requestScoringChainMode(raw, "testnet")).toBe("mainnet");
    }
    // Prototype keys index a plain object truthily; they are not modes.
    expect(requestScoringChainMode("constructor", "testnet")).toBe("mainnet");
    expect(requestScoringChainMode("__proto__", "testnet")).toBe("mainnet");
    expect(requestScoringChainMode("toString", "testnet")).toBe("mainnet");
    // Non-strings arrive from Express as arrays or objects.
    expect(requestScoringChainMode(["testnet"], undefined)).toBe("mainnet");
    expect(requestScoringChainMode({}, undefined)).toBe("mainnet");
    expect(requestScoringChainMode(42, undefined)).toBe("mainnet");
  });
});

describe("buildScoringChains", () => {
  it("builds every chain whose key is configured", () => {
    const set = buildScoringChains({ defaultMode: undefined, env: BOTH_KEYS, providers });
    expect([...set.available].sort()).toEqual(["mainnet", "testnet"]);
    expect(set.defaultMode).toBe("mainnet");
    expect(set.get("testnet").config.chainId).toBe(EXIT_CHAIN_ID);
    expect(set.get("mainnet").config.chainId).toBe(8453);
  });

  it("resolves a request's chain, defaulting and never throwing", () => {
    const set = buildScoringChains({ defaultMode: "testnet", env: BOTH_KEYS, providers });
    expect(set.resolve(undefined).config.mode).toBe("testnet");
    expect(set.resolve("mainnet").config.mode).toBe("mainnet");
    expect(set.resolve("not-a-chain").config.mode).toBe("mainnet");
  });

  it("still serves a chain whose Alchemy key is absent", () => {
    // A missing key shortens that chain's fallback list to its public node; it
    // does not remove the chain. Leaving it out used to send the caller to the
    // default chain instead, which is a worse answer than a slower read.
    const set = buildScoringChains({
      defaultMode: undefined,
      env: { ALCHEMY_API_KEY_BASE_MAINNET: "mk" },
      providers,
    });
    expect([...set.available].sort()).toEqual(["mainnet", "testnet"]);
    const served = set.resolve("testnet");
    expect(served.config.mode).toBe("testnet");
    // The response still names the chain it ACTUALLY read, so a label can
    // never end up on the other chain's numbers.
    expect(scoringChainWire(served.config).label).toBe("Base Sepolia");
  });

  it("boots with no Alchemy keys at all", () => {
    // The regression this branch exists for: an exhausted free tier used to
    // throw here, so the API and the worker exited instead of reading public.
    const set = buildScoringChains({ defaultMode: "testnet", env: {}, providers });
    expect(set.defaultMode).toBe("testnet");
    expect([...set.available].sort()).toEqual(["mainnet", "testnet"]);
    expect(set.resolve(undefined).config.chainId).toBe(EXIT_CHAIN_ID);
  });
});

describe("chainScopedKey", () => {
  const wallet = "0xa48fd1407ce1d31d4b85b6f48ca3209457056894";

  it("keeps one wallet's two chains apart", () => {
    expect(chainScopedKey("testnet", wallet)).not.toBe(chainScopedKey("mainnet", wallet));
    expect(chainScopedKey("testnet", wallet)).toBe(`testnet:${wallet}`);
  });

  it("is what stops a testnet score answering a mainnet request", () => {
    // The real trap, reproduced against the real cache: one LRU, one wallet,
    // two chains. Unscoped, the second get() would return the first chain's
    // position for 60 seconds and the dashboard would print it under the other
    // chain's label.
    const cache = new LruCache<{ positions: string[] }>(10);
    cache.set(chainScopedKey("testnet", wallet), { positions: ["aave_v3 usdc/usdt"] });

    expect(cache.get(chainScopedKey("mainnet", wallet))).toBeUndefined();
    expect(cache.get(chainScopedKey("testnet", wallet))?.positions).toEqual([
      "aave_v3 usdc/usdt",
    ]);

    // An empty mainnet read must not erase the testnet entry either.
    cache.set(chainScopedKey("mainnet", wallet), { positions: [] });
    expect(cache.get(chainScopedKey("testnet", wallet))?.positions).toHaveLength(1);
    expect(cache.get(chainScopedKey("mainnet", wallet))?.positions).toHaveLength(0);
  });

  it("keeps the advisor's longer key apart per chain too", () => {
    const parts = ["0xabc", "moderate", "real"];
    expect(chainScopedKey("mainnet", ...parts)).toBe("mainnet:0xabc:moderate:real");
    expect(chainScopedKey("testnet", ...parts)).not.toBe(chainScopedKey("mainnet", ...parts));
  });
});
