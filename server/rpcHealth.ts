/**
 * RPC health across two independent providers (Phase 4.B).
 *
 * WHY TWO. Every fact this product acts on arrives over one RPC connection: the
 * health factor that fires a trigger, the nonce that proves a permit is live,
 * the allowance that decides whether an exit can execute. A single provider
 * that serves a STALE head is the worst failure mode available, because it is
 * indistinguishable from a quiet chain — the worker keeps ticking, every read
 * succeeds, and the position it is watching liquidates against state it never
 * saw. One provider cannot detect that about itself. Two can: they either agree
 * or they do not, and disagreement is the signal.
 *
 * THREE DISTINCT FAILURES, THREE DISTINCT ALERTS. They are not the same thing
 * and an operator acts differently on each:
 *
 *   - A provider is DOWN (transport error, non-200, malformed body). Coverage
 *     survives on the other one, so it is a warning — unless they are ALL down,
 *     which is a critical: the worker is blind and does not know it.
 *   - The head is STALE on every provider that answered. That is not an RPC
 *     problem, it is a chain problem, so it reuses 4.A's `sequencerStale`
 *     detector rather than inventing a second opinion about block age.
 *   - The providers DIVERGE by more than the tolerated lag. One of them is
 *     lying about the head and this code cannot tell which, so the alert says
 *     exactly that and names both heights.
 *
 * Plain `fetch` JSON-RPC rather than a viem client on purpose: a health check
 * must not share a transport, a retry policy or a cache with the thing it is
 * checking, or a hung connection pool takes the probe down with it.
 */

import { sequencerStale } from "./relayerPolicy";
import type { MonitorAlert } from "./monitorAlerts";

/** One configured endpoint. `label` appears in alerts; the URL never does. */
export interface RpcEndpoint {
  label: string;
  url: string;
}

/** One probe result. `ok` false means the endpoint did not answer usefully. */
export interface RpcSample {
  label: string;
  ok: boolean;
  /** Head block number, or null when the probe failed. */
  blockNumber: number | null;
  /** Head block timestamp in unix SECONDS, or null when the probe failed. */
  blockTimestampSec: number | null;
  latencyMs: number;
  /** Truncated failure reason. Never carries the URL (it holds an API key). */
  error: string | null;
}

/**
 * How far two providers may disagree about the head before it is an alert.
 *
 * Base targets 2s blocks, so a few blocks of spread is ordinary propagation.
 * Ten blocks is ~20 seconds of divergence, which is long enough that one of the
 * two is genuinely behind rather than merely unlucky.
 */
export const DEFAULT_MAX_HEAD_LAG_BLOCKS = 10;

export interface RpcHealthOptions {
  /** Seconds of block age that means the chain, not the provider, has stopped. */
  staleAfterSec: number;
  maxHeadLagBlocks?: number;
  /** Now, in unix seconds. */
  nowSec: number;
  /** Now, in epoch ms — what the alert is stamped with. */
  nowMs: number;
  /** Names the alert keys, so mainnet and the executor chain never collide. */
  chainLabel: string;
}

/**
 * Probe one endpoint with a single `eth_getBlockByNumber("latest", false)`.
 *
 * One call, not two: asking for the number and then the block is two round
 * trips that can straddle a new head, which manufactures a divergence that was
 * never there.
 */
export async function sampleRpc(endpoint: RpcEndpoint, timeoutMs = 5_000): Promise<RpcSample> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = (error: string): RpcSample => ({
    label: endpoint.label,
    ok: false,
    blockNumber: null,
    blockTimestampSec: null,
    latencyMs: Date.now() - started,
    error: error.slice(0, 200),
  });

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { number?: string; timestamp?: string };
      error?: { message?: string };
    };
    if (body.error) return fail(`rpc error: ${body.error.message ?? "unknown"}`);
    const number = body.result?.number;
    const timestamp = body.result?.timestamp;
    if (typeof number !== "string" || typeof timestamp !== "string") {
      return fail("malformed block response");
    }
    return {
      label: endpoint.label,
      ok: true,
      blockNumber: Number(BigInt(number)),
      blockTimestampSec: Number(BigInt(timestamp)),
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return fail((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every endpoint in parallel. A slow provider never blocks a fast one. */
export async function sampleAll(
  endpoints: readonly RpcEndpoint[],
  timeoutMs = 5_000,
): Promise<RpcSample[]> {
  return Promise.all(endpoints.map((e) => sampleRpc(e, timeoutMs)));
}

/**
 * Turn samples into alerts. Pure: no clock, no network, fully testable.
 *
 * Note the ordering of the two chain-wide checks. Staleness is evaluated on the
 * providers that ANSWERED, because a stale head reported by the only reachable
 * node is still the chain's problem, not that node's. Divergence is evaluated
 * only when at least two answered, because one opinion cannot disagree.
 */
export function assessRpc(samples: readonly RpcSample[], opts: RpcHealthOptions): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  const at = opts.nowMs;
  const chain = opts.chainLabel;
  const healthy = samples.filter((s) => s.ok);

  if (samples.length > 0 && healthy.length === 0) {
    alerts.push({
      kind: "rpc.all_providers_down",
      severity: "critical",
      key: `rpc.all_down:${chain}`,
      summary: `every configured RPC provider for ${chain} failed to answer`,
      detail: {
        chain,
        providers: samples.map((s) => s.label).join(","),
        firstError: samples[0]?.error ?? null,
      },
      at,
    });
    // No point reporting staleness or divergence: there is nothing to compare.
    return alerts;
  }

  for (const sample of samples) {
    if (sample.ok) continue;
    alerts.push({
      kind: "rpc.provider_down",
      severity: "warning",
      key: `rpc.down:${chain}:${sample.label}`,
      summary: `RPC provider ${sample.label} on ${chain} is not answering`,
      detail: { chain, provider: sample.label, error: sample.error, latencyMs: sample.latencyMs },
      at,
    });
  }

  // Block-age staleness, using 4.A's detector rather than a second opinion.
  const freshest = healthy.reduce<number | null>(
    (best, s) => (s.blockTimestampSec !== null && (best === null || s.blockTimestampSec > best) ? s.blockTimestampSec : best),
    null,
  );
  if (freshest !== null && sequencerStale(freshest, opts.nowSec, opts.staleAfterSec)) {
    alerts.push({
      kind: "sequencer.stale",
      severity: "critical",
      key: `sequencer.stale:${chain}`,
      summary: `${chain} head block is ${opts.nowSec - freshest}s old across every reachable provider`,
      detail: {
        chain,
        ageSec: opts.nowSec - freshest,
        staleAfterSec: opts.staleAfterSec,
        providers: healthy.map((s) => s.label).join(","),
      },
      at,
    });
  }

  // Divergence. Needs two opinions to be a disagreement.
  const heights = healthy
    .map((s) => s.blockNumber)
    .filter((n): n is number => n !== null);
  if (heights.length >= 2) {
    const max = Math.max(...heights);
    const min = Math.min(...heights);
    const tolerated = opts.maxHeadLagBlocks ?? DEFAULT_MAX_HEAD_LAG_BLOCKS;
    if (max - min > tolerated) {
      const behind = healthy.find((s) => s.blockNumber === min);
      alerts.push({
        kind: "rpc.providers_diverged",
        severity: "warning",
        // Not keyed on which provider is behind: that flips between ticks and
        // would defeat the dedupe gate. The CONDITION is "they disagree".
        key: `rpc.diverged:${chain}`,
        summary:
          `RPC providers for ${chain} disagree about the head by ${max - min} blocks ` +
          `(tolerated ${tolerated}); which one is correct cannot be determined from here`,
        detail: {
          chain,
          spreadBlocks: max - min,
          tolerated,
          lowest: min,
          highest: max,
          furthestBehind: behind?.label ?? null,
        },
        at,
      });
    }
  }

  return alerts;
}

/**
 * The endpoints to probe for a chain, from env.
 *
 * Always returns the PUBLIC endpoint alongside the keyed one, because the
 * second opinion is the entire point and an operator who forgets to configure
 * one leaves the check unable to detect divergence at all. Duplicate URLs are
 * collapsed: probing the same node twice is a second opinion in name only.
 */
export function endpointsForChain(chainId: number, env: NodeJS.ProcessEnv = process.env): RpcEndpoint[] {
  const mainnet = chainId === 8453;
  const key = mainnet ? env.ALCHEMY_API_KEY_BASE_MAINNET : env.ALCHEMY_API_KEY_BASE_SEPOLIA;
  const publicUrl = mainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
  const override = mainnet ? env.RPC_HEALTH_URL_BASE_MAINNET : env.RPC_HEALTH_URL_BASE_SEPOLIA;

  const out: RpcEndpoint[] = [];
  if (key) {
    const host = mainnet ? "base-mainnet" : "base-sepolia";
    out.push({ label: "alchemy", url: `https://${host}.g.alchemy.com/v2/${key}` });
  }
  out.push({ label: "public", url: publicUrl });
  if (override && override.trim()) out.push({ label: "override", url: override.trim() });

  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}
