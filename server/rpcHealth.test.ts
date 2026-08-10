/**
 * RPC health across two providers (Phase 4.B).
 *
 * The failure this guards against is the quiet one: a provider that answers
 * every call from a stale head. Nothing throws, every read succeeds, the worker
 * keeps ticking, and it is scoring positions against state it never saw. One
 * provider cannot detect that about itself, which is why the assessment is
 * written around DISAGREEMENT, and why "down", "stale" and "diverged" are three
 * separate alerts rather than one health score.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_HEAD_LAG_BLOCKS,
  assessRpc,
  endpointsForChain,
  type RpcHealthOptions,
  type RpcSample,
} from "./rpcHealth";

const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1_000;

const opts = (over: Partial<RpcHealthOptions> = {}): RpcHealthOptions => ({
  staleAfterSec: 120,
  nowSec: NOW_SEC,
  nowMs: NOW_MS,
  chainLabel: "base-mainnet",
  ...over,
});

const ok = (label: string, blockNumber: number, ageSec = 2): RpcSample => ({
  label,
  ok: true,
  blockNumber,
  blockTimestampSec: NOW_SEC - ageSec,
  latencyMs: 40,
  error: null,
});

const down = (label: string, error = "HTTP 503"): RpcSample => ({
  label,
  ok: false,
  blockNumber: null,
  blockTimestampSec: null,
  latencyMs: 5_000,
  error,
});

describe("assessRpc", () => {
  it("says nothing when both providers agree on a fresh head", () => {
    expect(assessRpc([ok("alchemy", 1_000), ok("public", 1_002)], opts())).toEqual([]);
  });

  it("warns for one provider down while the other still answers", () => {
    const alerts = assessRpc([ok("alchemy", 1_000), down("public")], opts());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("rpc.provider_down");
    expect(alerts[0]!.severity).toBe("warning");
    expect(alerts[0]!.key).toBe("rpc.down:base-mainnet:public");
  });

  it("pages CRITICAL when every provider is down: the worker is blind", () => {
    const alerts = assessRpc([down("alchemy"), down("public")], opts());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("rpc.all_providers_down");
    expect(alerts[0]!.severity).toBe("critical");
  });

  it("never claims staleness or divergence when nothing answered", () => {
    // With no opinions there is nothing to compare, and inventing a verdict
    // from zero samples is exactly the dishonesty this file guards against.
    const alerts = assessRpc([down("alchemy"), down("public")], opts());
    expect(alerts.map((a) => a.kind)).toEqual(["rpc.all_providers_down"]);
  });

  it("reports a stale head as a CHAIN problem, using 4.A's threshold", () => {
    const alerts = assessRpc([ok("alchemy", 1_000, 400), ok("public", 1_000, 500)], opts());
    const stale = alerts.find((a) => a.kind === "sequencer.stale");
    expect(stale?.severity).toBe("critical");
    expect(stale?.detail?.ageSec).toBe(400); // the FRESHEST opinion, not the worst
  });

  it("does not call a head stale while it is inside the threshold", () => {
    expect(assessRpc([ok("alchemy", 1_000, 119)], opts()).map((a) => a.kind)).toEqual([]);
  });

  it("tolerates ordinary propagation spread", () => {
    const alerts = assessRpc(
      [ok("alchemy", 1_000), ok("public", 1_000 - DEFAULT_MAX_HEAD_LAG_BLOCKS)],
      opts(),
    );
    expect(alerts).toEqual([]);
  });

  it("warns when providers diverge past the tolerated lag", () => {
    const alerts = assessRpc([ok("alchemy", 1_000), ok("public", 900)], opts());
    const diverged = alerts.find((a) => a.kind === "rpc.providers_diverged");
    expect(diverged?.severity).toBe("warning");
    expect(diverged?.detail?.spreadBlocks).toBe(100);
    expect(diverged?.detail?.furthestBehind).toBe("public");
    // It cannot know WHICH one is lying, and it says so rather than guessing.
    expect(diverged?.summary).toContain("cannot be determined");
  });

  it("keys divergence on the condition, not on which provider is behind", () => {
    // The laggard flips between ticks; a key naming it would defeat the gate.
    const a = assessRpc([ok("alchemy", 1_000), ok("public", 900)], opts());
    const b = assessRpc([ok("alchemy", 900), ok("public", 1_000)], opts());
    expect(a.find((x) => x.kind === "rpc.providers_diverged")!.key).toBe(
      b.find((x) => x.kind === "rpc.providers_diverged")!.key,
    );
  });

  it("cannot report divergence from a single opinion", () => {
    expect(assessRpc([ok("alchemy", 1_000)], opts())).toEqual([]);
  });

  it("keys alerts per chain so mainnet and the executor chain never collide", () => {
    const mainnet = assessRpc([down("public")], opts({ chainLabel: "base-mainnet" }));
    const executor = assessRpc([down("public")], opts({ chainLabel: "executor-chain" }));
    expect(mainnet[0]!.key).not.toBe(executor[0]!.key);
  });
});

describe("endpointsForChain", () => {
  it("always includes the public node, so a second opinion exists", () => {
    const endpoints = endpointsForChain(8453, {} as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["public"]);
  });

  it("pairs the keyed provider with the public one", () => {
    const endpoints = endpointsForChain(8453, {
      ALCHEMY_API_KEY_BASE_MAINNET: "test-key",
    } as NodeJS.ProcessEnv);
    expect(endpoints.map((e) => e.label)).toEqual(["alchemy", "public"]);
    expect(endpoints[0]!.url).toContain("base-mainnet");
  });

  it("uses the sepolia key and node off the executor chain", () => {
    const endpoints = endpointsForChain(84532, {
      ALCHEMY_API_KEY_BASE_SEPOLIA: "test-key",
    } as NodeJS.ProcessEnv);
    expect(endpoints[0]!.url).toContain("base-sepolia");
    expect(endpoints[1]!.url).toBe("https://sepolia.base.org");
  });

  it("collapses duplicate URLs: the same node twice is not a second opinion", () => {
    const endpoints = endpointsForChain(8453, {
      RPC_HEALTH_URL_BASE_MAINNET: "https://mainnet.base.org",
    } as NodeJS.ProcessEnv);
    expect(endpoints).toHaveLength(1);
  });
});
