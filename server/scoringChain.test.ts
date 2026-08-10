import { describe, expect, it, vi } from "vitest";
import { EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";
import { buildScoringChain, resolveAlchemyKey, scoringChainWire } from "./scoringChain";

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
