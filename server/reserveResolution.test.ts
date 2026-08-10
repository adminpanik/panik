/**
 * The relayer and the coverage sweep resolve the SAME reserve set, from chain.
 *
 * Issue #53. PR #48 fixed `ExitFlow` and left these two carrying the old
 * `[EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS]` pair. `EXIT_USDC_ADDRESS` is
 * `executor.usdc()` - the token the executor PAYS OUT in - and the Aave V3 Base
 * Sepolia market does not list it, so:
 *
 *   - the relayer's leg builder saw one usable reserve (WETH) out of six, and a
 *     position collateralised in cbETH or USDT produced legs that quietly left
 *     it in place under a "position closed" receipt;
 *   - the coverage sweep checked approvals on the payout token, found nothing
 *     wrong, and reported coverage healthy for a wallet that was not covered.
 *
 * These run against a real JSON-RPC node - an in-process stub answering the same
 * `eth_call`s Base Sepolia does, seeded with the live fixture below - so viem's
 * encoding, the ABI fragments and the adapter wiring are all exercised. The
 * pure intersection is unit-tested in src/panik-core/lib/exitReserves.test.ts;
 * the live-chain proof is scripts/proof/reserve-set-consumers.ts.
 *
 * The listener binds port 0 (ephemeral) on purpose: nothing here may collide
 * with a developer's :3000 or :8787.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionResult, toFunctionSelector } from "viem";
import {
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
  EXIT_USDC_ADDRESS,
  EXIT_WETH_ADDRESS,
} from "../src/panik-core/lib/exit.generated";
import { clearExitReserveSetCache } from "../src/panik-core/lib/exitReserves";
import { ViemRelayerChain, relayerReserveOverride } from "./relayerChain";
import { ViemCoverageChain, coverageMarketsFromEnv } from "./coverageChain";

// ── the live Base Sepolia fixture ────────────────────────────────────────────
//
// Read from the deployment on 2026-08-10; the same values the unit tests pin.

const AAVE_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as const;
const AAVE_USDT = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a" as const;
const AAVE_WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4" as const;
const AAVE_CBETH = "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B" as const;
const AAVE_LINK = "0x810D46F9a9027E28F9B01F75E2bdde839dA61115" as const;
const WETH = EXIT_WETH_ADDRESS;

/** The wallet holding the live test position. */
const WALLET = "0xa48fd1407Ce1d31d4b85b6F48cA3209457056894" as const;

const MARKET = [
  { symbol: "USDC", tokenAddress: AAVE_USDC },
  { symbol: "USDT", tokenAddress: AAVE_USDT },
  { symbol: "WBTC", tokenAddress: AAVE_WBTC },
  { symbol: "WETH", tokenAddress: WETH },
  { symbol: "cbETH", tokenAddress: AAVE_CBETH },
  { symbol: "LINK", tokenAddress: AAVE_LINK },
] as const;

/** The six reserves PLUS the payout token, exactly as the executor reports. */
const TRACKED = [EXIT_USDC_ADDRESS, WETH, AAVE_USDC, AAVE_USDT, AAVE_LINK, AAVE_CBETH, AAVE_WBTC];

const EXPECTED_RESERVES = [AAVE_USDC, AAVE_USDT, AAVE_WBTC, WETH, AAVE_CBETH, AAVE_LINK];

/** 2000 test USDC collateral, 1200 test USDT variable debt. BigInt throughout. */
const POSITION: Record<string, { aBalance: bigint; varDebt: bigint }> = {
  [AAVE_USDC.toLowerCase()]: { aBalance: 2_000_000_000n, varDebt: 0n },
  [AAVE_USDT.toLowerCase()]: { aBalance: 0n, varDebt: 1_200_000_000n },
};

const DECIMALS: Record<string, number> = {
  [AAVE_USDC.toLowerCase()]: 6,
  [AAVE_USDT.toLowerCase()]: 6,
  [AAVE_WBTC.toLowerCase()]: 8,
  [WETH.toLowerCase()]: 18,
  [AAVE_CBETH.toLowerCase()]: 18,
  [AAVE_LINK.toLowerCase()]: 18,
  [EXIT_USDC_ADDRESS.toLowerCase()]: 6,
};

const SYMBOLS: Record<string, string> = {
  [AAVE_USDC.toLowerCase()]: "USDC",
  [AAVE_USDT.toLowerCase()]: "USDT",
  [AAVE_WBTC.toLowerCase()]: "WBTC",
  [WETH.toLowerCase()]: "WETH",
  [AAVE_CBETH.toLowerCase()]: "cbETH",
  [AAVE_LINK.toLowerCase()]: "LINK",
  // The payout token reports "USDC" too. That collision is the original bug.
  [EXIT_USDC_ADDRESS.toLowerCase()]: "USDC",
};

// ── ABI fragments, matching what the adapters encode ─────────────────────────

const RESERVE_LIST_ABI = [
  {
    type: "function",
    name: "getAllReservesTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "symbol", type: "string" },
          { name: "tokenAddress", type: "address" },
        ],
      },
    ],
  },
] as const;

const TRACKED_ABI = [
  {
    type: "function",
    name: "getTrackedAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

const USER_RESERVE_ABI = [
  {
    type: "function",
    name: "getUserReserveData",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "currentATokenBalance", type: "uint256" },
      { name: "currentStableDebt", type: "uint256" },
      { name: "currentVariableDebt", type: "uint256" },
      { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const SEL = {
  reserveList: toFunctionSelector("getAllReservesTokens()"),
  tracked: toFunctionSelector("getTrackedAssets()"),
  userReserve: toFunctionSelector("getUserReserveData(address,address)"),
  decimals: toFunctionSelector("decimals()"),
  symbol: toFunctionSelector("symbol()"),
};

// ── the stub node ────────────────────────────────────────────────────────────

/** Every `getUserReserveData` asset argument the adapters asked about. */
let assetsRead: string[] = [];
/** How many times the reserve set itself was resolved. */
let resolutionReads = 0;

let server: Server;
let rpcUrl: string;

function handleCall(to: string, data: string): string {
  const selector = data.slice(0, 10);
  const target = to.toLowerCase();

  if (selector === SEL.reserveList && target === EXIT_DATA_PROVIDER_ADDRESS.toLowerCase()) {
    resolutionReads += 1;
    return encodeFunctionResult({
      abi: RESERVE_LIST_ABI,
      functionName: "getAllReservesTokens",
      result: MARKET.map((r) => ({ symbol: r.symbol, tokenAddress: r.tokenAddress })),
    });
  }

  if (selector === SEL.tracked && target === EXECUTOR_ADDRESS.toLowerCase()) {
    resolutionReads += 1;
    return encodeFunctionResult({
      abi: TRACKED_ABI,
      functionName: "getTrackedAssets",
      result: TRACKED,
    });
  }

  if (selector === SEL.userReserve) {
    // Args are two 32-byte words after the selector; the asset is the first.
    const asset = `0x${data.slice(10 + 24, 10 + 64)}`.toLowerCase();
    assetsRead.push(asset);
    // The payout token is NOT a listed reserve. A real node reverts here, and a
    // stub that answered zeros would hide exactly the bug under test.
    if (asset === EXIT_USDC_ADDRESS.toLowerCase()) {
      throw new Error("execution reverted: asset is not a listed reserve");
    }
    const pos = POSITION[asset] ?? { aBalance: 0n, varDebt: 0n };
    return encodeFunctionResult({
      abi: USER_RESERVE_ABI,
      functionName: "getUserReserveData",
      result: [pos.aBalance, 0n, pos.varDebt, 0n, 0n, 0n, 0n, 0, pos.aBalance > 0n],
    });
  }

  if (selector === SEL.decimals) {
    return encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "decimals",
      result: DECIMALS[target] ?? 18,
    });
  }

  if (selector === SEL.symbol) {
    return encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "symbol",
      result: SYMBOLS[target] ?? "???",
    });
  }

  throw new Error(`stub node: unhandled call ${selector} to ${to}`);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...payload }));
      };
      try {
        if (rpc.method === "eth_chainId") return reply({ result: `0x${EXIT_CHAIN_ID.toString(16)}` });
        if (rpc.method === "eth_call") {
          const { to, data } = rpc.params[0] as { to: string; data: string };
          return reply({ result: handleCall(to, data) });
        }
        return reply({ error: { code: -32601, message: `unsupported: ${rpc.method}` } });
      } catch (err) {
        return reply({ error: { code: 3, message: (err as Error).message } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearExitReserveSetCache();
  assetsRead = [];
  resolutionReads = 0;
});

const relayer = () => new ViemRelayerChain({ rpcUrl, chainId: EXIT_CHAIN_ID });
const coverage = () => new ViemCoverageChain({ rpcUrl, chainId: EXIT_CHAIN_ID });

describe("the relayer's reserve set (scripts/watch-worker.ts)", () => {
  it("resolves the market's six reserves, not the hardcoded pair", async () => {
    await expect(relayer().reserves()).resolves.toEqual(EXPECTED_RESERVES);
  });

  it("excludes the payout token, so no read can revert on it", async () => {
    const reserves = await relayer().reserves();
    expect(reserves).not.toContain(EXIT_USDC_ADDRESS);
    expect(reserves).toContain(WETH);
  });

  it("builds the live position's legs: 2000 USDC collateral, 1200 USDT debt", async () => {
    const states = await relayer().reserveStates(WALLET);
    expect(states).toEqual([
      { reserve: AAVE_USDC, symbol: "USDC", decimals: 6, aBalance: 2_000_000_000n, debt: 0n },
      { reserve: AAVE_USDT, symbol: "USDT", decimals: 6, aBalance: 0n, debt: 1_200_000_000n },
    ]);
  });

  it("would have MISSED the USDT debt under the old hardcoded pair", async () => {
    // The regression, stated as the thing it cost. The old list named the payout
    // token and WETH; neither carries this position, so the leg builder saw an
    // empty position and the user would have been told there was nothing to do.
    const old = new ViemRelayerChain({
      rpcUrl,
      chainId: EXIT_CHAIN_ID,
      reserves: [EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS],
    });
    await expect(old.reserveStates(WALLET)).rejects.toThrow();

    const states = await relayer().reserveStates(WALLET);
    expect(states.filter((s) => s.debt > 0n).map((s) => s.symbol)).toEqual(["USDT"]);
  });

  it("reads every reserve the market lists and never the payout token", async () => {
    await relayer().reserveStates(WALLET);
    expect(assetsRead).toEqual(EXPECTED_RESERVES.map((r) => r.toLowerCase()));
    expect(assetsRead).not.toContain(EXIT_USDC_ADDRESS.toLowerCase());
  });

  it("resolves once, not once per wallet per tick", async () => {
    const chain = relayer();
    await chain.reserveStates(WALLET);
    await chain.reserveStates("0x1111111111111111111111111111111111111111");
    await chain.reserveStates("0x2222222222222222222222222222222222222222");
    expect(resolutionReads).toBe(2);
  });

  it("still honours an explicit RELAYER_RESERVES override", async () => {
    const pinned = new ViemRelayerChain({ rpcUrl, chainId: EXIT_CHAIN_ID, reserves: [AAVE_USDT] });
    await expect(pinned.reserves()).resolves.toEqual([AAVE_USDT]);
    expect(resolutionReads).toBe(0);
  });
});

describe("the coverage sweep's reserve set (server/coverageChain.ts)", () => {
  it("resolves the market's six reserves, not the hardcoded pair", async () => {
    await expect(coverage().aaveReserves()).resolves.toEqual(EXPECTED_RESERVES);
  });

  it("inspects the assets the position actually holds", async () => {
    const states = await coverage().reserveStates(WALLET);
    expect(states.map((s) => s.symbol)).toEqual(["USDC", "USDT"]);
    expect(states.map((s) => s.reserve)).toEqual([AAVE_USDC, AAVE_USDT]);
  });

  it("hands the sweep the resolved set, with no hardcoded fallback left", async () => {
    const markets = coverageMarketsFromEnv(await coverage().aaveReserves(), {});
    expect(markets.aaveReserves).toEqual(EXPECTED_RESERVES);
    expect(markets.aaveReserves).not.toContain(EXIT_USDC_ADDRESS);
  });

  it("reports an EMPTY set rather than a guessed one, so the sweep says unverifiable", () => {
    // `sweepCoverage` turns an empty `aaveReserves` into a `coverage.unverifiable`
    // alert. That is the honest answer; the old fallback made it report healthy.
    expect(coverageMarketsFromEnv([], {}).aaveReserves).toEqual([]);
  });
});

describe("the relayer and the sweep agree", () => {
  it("resolve the identical set, sharing one resolution", async () => {
    const fromRelayer = await relayer().reserves();
    const fromSweep = await coverage().aaveReserves();
    expect(fromSweep).toEqual(fromRelayer);
    // Two adapters, two clients, one cached resolution for the deployment.
    expect(resolutionReads).toBe(2);
  });
});

describe("relayerReserveOverride - the one RELAYER_RESERVES parser", () => {
  it("is empty when unset, which means resolve from chain", () => {
    expect(relayerReserveOverride({})).toEqual([]);
  });

  it("parses a comma-separated list, lowercased", () => {
    expect(relayerReserveOverride({ RELAYER_RESERVES: ` ${AAVE_USDC} , ${AAVE_USDT} ` })).toEqual([
      AAVE_USDC.toLowerCase(),
      AAVE_USDT.toLowerCase(),
    ]);
  });

  it("drops malformed entries rather than guessing at them", () => {
    expect(relayerReserveOverride({ RELAYER_RESERVES: `0xnope,${WETH},,junk` })).toEqual([
      WETH.toLowerCase(),
    ]);
  });
});
