/**
 * The reserve set the exit flow reads, and the bug it exists to prevent.
 *
 * Fixtures are the real Base Sepolia values, read from the live deployment on
 * 2026-08-10, because the bug was a mismatch between two real address lists and
 * a made-up fixture cannot reproduce it:
 *
 *   dataProvider.getAllReservesTokens() -> 6 reserves, USDC = 0xba50Cd2A…
 *   executor.getTrackedAssets()         -> those 6 PLUS 0x036CbD53… (Circle)
 *   executor.usdc()                     -> 0x036CbD53… (payout only)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearExitReserveSetCache,
  exitReserveAddresses,
  exitReserveSet,
  loadExitReserveSet,
  resolveExitReserveSet,
  type MarketReserve,
  type ReserveReadClient,
} from "./exitReserves";
import {
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
} from "./exit.generated";

// Aave V3 Base Sepolia market, in the order the data provider returns them.
const AAVE_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as const;
const AAVE_USDT = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a" as const;
const AAVE_WBTC = "0x54114591963CF60EF3aA63bEfD6eC263D98145a4" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const AAVE_CBETH = "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B" as const;
const AAVE_LINK = "0x810D46F9a9027E28F9B01F75E2bdde839dA61115" as const;

/** `executor.usdc()` - the PAYOUT token. Not a reserve in this market. */
const CIRCLE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const MARKET_RESERVES: MarketReserve[] = [
  { symbol: "USDC", tokenAddress: AAVE_USDC },
  { symbol: "USDT", tokenAddress: AAVE_USDT },
  { symbol: "WBTC", tokenAddress: AAVE_WBTC },
  { symbol: "WETH", tokenAddress: WETH },
  { symbol: "cbETH", tokenAddress: AAVE_CBETH },
  { symbol: "LINK", tokenAddress: AAVE_LINK },
];

const TRACKED_ASSETS = [
  CIRCLE_USDC,
  WETH,
  AAVE_USDC,
  AAVE_USDT,
  AAVE_LINK,
  AAVE_CBETH,
  AAVE_WBTC,
];

describe("exitReserveSet - the live Base Sepolia configuration", () => {
  it("resolves to all six market reserves", () => {
    expect(exitReserveSet(MARKET_RESERVES, TRACKED_ASSETS)).toEqual([
      { reserve: AAVE_USDC, symbol: "USDC" },
      { reserve: AAVE_USDT, symbol: "USDT" },
      { reserve: AAVE_WBTC, symbol: "WBTC" },
      { reserve: WETH, symbol: "WETH" },
      { reserve: AAVE_CBETH, symbol: "cbETH" },
      { reserve: AAVE_LINK, symbol: "LINK" },
    ]);
  });

  it("EXCLUDES the payout token, which is what the old hardcode read", () => {
    // The regression. `EXIT_USDC_ADDRESS` is tracked by the executor but is not
    // an Aave reserve, so `getUserReserveData` on it reverts for every wallet.
    const set = exitReserveSet(MARKET_RESERVES, TRACKED_ASSETS);
    expect(TRACKED_ASSETS).toContain(CIRCLE_USDC);
    expect(set.map((r) => r.reserve)).not.toContain(CIRCLE_USDC);
  });

  it("picks the Aave USDC reserve, not the payout token that shares its symbol", () => {
    const usdc = exitReserveSet(MARKET_RESERVES, TRACKED_ASSETS).filter((r) => r.symbol === "USDC");
    expect(usdc).toHaveLength(1);
    expect(usdc[0]!.reserve).toBe(AAVE_USDC);
    expect(usdc[0]!.reserve).not.toBe(CIRCLE_USDC);
  });
});

describe("exitReserveSet - address is the identity, symbol is a label", () => {
  it("does not admit a tracked asset that only matches by symbol", () => {
    // Circle USDC is tracked and reports symbol "USDC", exactly like the Aave
    // reserve. Matching on the symbol would let it back in.
    const marketWithoutUsdc = MARKET_RESERVES.filter((r) => r.tokenAddress !== AAVE_USDC);
    const set = exitReserveSet(marketWithoutUsdc, TRACKED_ASSETS);
    expect(set.map((r) => r.reserve)).not.toContain(CIRCLE_USDC);
    expect(set.some((r) => r.symbol === "USDC")).toBe(false);
  });

  it("keeps two distinct addresses that share a symbol, if the market lists both", () => {
    const market: MarketReserve[] = [
      { symbol: "USDC", tokenAddress: AAVE_USDC },
      { symbol: "USDC", tokenAddress: CIRCLE_USDC },
    ];
    const set = exitReserveSet(market, [AAVE_USDC, CIRCLE_USDC]);
    expect(set.map((r) => r.reserve)).toEqual([AAVE_USDC, CIRCLE_USDC]);
  });

  it("matches regardless of checksum casing on either side", () => {
    const set = exitReserveSet(
      [{ symbol: "WETH", tokenAddress: WETH.toUpperCase().replace("0X", "0x") as `0x${string}` }],
      [WETH.toLowerCase()],
    );
    expect(set).toHaveLength(1);
  });

  it("carries the market's own address through, which is what the read expects", () => {
    const set = exitReserveSet([{ symbol: "WETH", tokenAddress: WETH }], [WETH.toLowerCase()]);
    expect(set[0]!.reserve).toBe(WETH);
  });
});

describe("exitReserveSet - shape", () => {
  it("preserves the market's ordering", () => {
    const set = exitReserveSet(MARKET_RESERVES, TRACKED_ASSETS);
    expect(set.map((r) => r.symbol)).toEqual(MARKET_RESERVES.map((r) => r.symbol));
  });

  it("collapses a reserve listed twice, so one debt cannot make two legs", () => {
    const market: MarketReserve[] = [
      { symbol: "WETH", tokenAddress: WETH },
      { symbol: "WETH", tokenAddress: WETH },
    ];
    expect(exitReserveSet(market, [WETH])).toHaveLength(1);
  });

  it("drops a market reserve the executor does not track", () => {
    const set = exitReserveSet(MARKET_RESERVES, [WETH]);
    expect(set).toEqual([{ reserve: WETH, symbol: "WETH" }]);
  });

  it("returns nothing when the two lists do not overlap", () => {
    expect(exitReserveSet(MARKET_RESERVES, [CIRCLE_USDC])).toEqual([]);
  });

  it.each([
    ["no market reserves", [] as MarketReserve[], TRACKED_ASSETS],
    ["no tracked assets", MARKET_RESERVES, [] as string[]],
    ["neither", [] as MarketReserve[], [] as string[]],
  ])("returns an empty set for %s rather than throwing", (_label, market, tracked) => {
    expect(exitReserveSet(market, tracked)).toEqual([]);
  });

  it("exitReserveAddresses drops the labels and keeps the market's addresses", () => {
    expect(exitReserveAddresses(exitReserveSet(MARKET_RESERVES, TRACKED_ASSETS))).toEqual([
      AAVE_USDC,
      AAVE_USDT,
      AAVE_WBTC,
      WETH,
      AAVE_CBETH,
      AAVE_LINK,
    ]);
  });
});

// ── chain resolution ─────────────────────────────────────────────────────────

/**
 * A node that answers the two views the resolution makes, and counts the calls.
 *
 * The count is the point of most of these: the worker sweeps every watched
 * wallet every 60 seconds, and a resolution that re-read per wallet per tick
 * would be the reason someone turned it off.
 */
function stubClient(
  over: { market?: MarketReserve[]; tracked?: string[]; fail?: () => Error } = {},
) {
  const calls: string[] = [];
  const client: ReserveReadClient = {
    async readContract(params: unknown): Promise<unknown> {
      const { functionName } = params as { functionName: string };
      calls.push(functionName);
      if (over.fail) throw over.fail();
      if (functionName === "getAllReservesTokens") return over.market ?? MARKET_RESERVES;
      if (functionName === "getTrackedAssets") return over.tracked ?? TRACKED_ASSETS;
      throw new Error(`unexpected read: ${functionName}`);
    },
  };
  return { client, calls };
}

describe("resolveExitReserveSet - the two reads", () => {
  beforeEach(clearExitReserveSetCache);

  it("reads the market list and the tracked set, and intersects them", async () => {
    const { client, calls } = stubClient();
    await expect(resolveExitReserveSet(client)).resolves.toEqual([
      { reserve: AAVE_USDC, symbol: "USDC" },
      { reserve: AAVE_USDT, symbol: "USDT" },
      { reserve: AAVE_WBTC, symbol: "WBTC" },
      { reserve: WETH, symbol: "WETH" },
      { reserve: AAVE_CBETH, symbol: "cbETH" },
      { reserve: AAVE_LINK, symbol: "LINK" },
    ]);
    expect(calls.sort()).toEqual(["getAllReservesTokens", "getTrackedAssets"]);
  });

  it("never yields the payout token, which is the whole regression", async () => {
    const { client } = stubClient();
    const set = await resolveExitReserveSet(client);
    expect(exitReserveAddresses(set)).not.toContain(CIRCLE_USDC);
  });

  it("addresses the configured deployment, not a hardcoded one", async () => {
    const seen: { address: string; functionName: string }[] = [];
    const client: ReserveReadClient = {
      async readContract(params: unknown) {
        const p = params as { address: string; functionName: string };
        seen.push({ address: p.address, functionName: p.functionName });
        return p.functionName === "getAllReservesTokens" ? MARKET_RESERVES : TRACKED_ASSETS;
      },
    };
    await resolveExitReserveSet(client);
    expect(seen).toContainEqual({
      address: EXIT_DATA_PROVIDER_ADDRESS,
      functionName: "getAllReservesTokens",
    });
    expect(seen).toContainEqual({ address: EXECUTOR_ADDRESS, functionName: "getTrackedAssets" });
  });
});

describe("loadExitReserveSet - resolved once per deployment", () => {
  beforeEach(clearExitReserveSetCache);

  it("reads twice on the first call and never again", async () => {
    const { client, calls } = stubClient();
    const first = await loadExitReserveSet(client);
    const second = await loadExitReserveSet(client);
    const third = await loadExitReserveSet(client);
    expect(calls).toHaveLength(2);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("shares one in-flight read across concurrent callers", async () => {
    // The first worker tick asks for the set once per watched wallet, before any
    // of them has resolved. Without sharing, ten wallets cost twenty calls.
    const { client, calls } = stubClient();
    const all = await Promise.all(Array.from({ length: 10 }, () => loadExitReserveSet(client)));
    expect(calls).toHaveLength(2);
    expect(new Set(all).size).toBe(1);
  });

  it("does NOT pin an empty result - that is a misconfiguration to re-check", async () => {
    const { client, calls } = stubClient({ tracked: [] });
    await expect(loadExitReserveSet(client)).resolves.toEqual([]);
    await expect(loadExitReserveSet(client)).resolves.toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it("does NOT pin a failure - one bad minute must not kill the process", async () => {
    const failing = stubClient({ fail: () => new Error("connection reset") });
    await expect(loadExitReserveSet(failing.client)).rejects.toThrow("connection reset");

    const healthy = stubClient();
    await expect(loadExitReserveSet(healthy.client)).resolves.toHaveLength(6);
    expect(healthy.calls).toHaveLength(2);
  });

  it("keys the cache per deployment, so two chains cannot share one answer", async () => {
    const mainnet = stubClient({ market: [{ symbol: "WETH", tokenAddress: WETH }] });
    const sepolia = stubClient();

    const a = await loadExitReserveSet(mainnet.client, { chainId: 8453 });
    const b = await loadExitReserveSet(sepolia.client, { chainId: EXIT_CHAIN_ID });

    expect(exitReserveAddresses(a)).toEqual([WETH]);
    expect(exitReserveAddresses(b)).toHaveLength(6);
    expect(mainnet.calls).toHaveLength(2);
    expect(sepolia.calls).toHaveLength(2);
  });

  it("keys on the executor too, so a redeploy is not served the old set", async () => {
    const old = stubClient();
    const fresh = stubClient({ tracked: [WETH] });
    await loadExitReserveSet(old.client);
    const after = await loadExitReserveSet(fresh.client, {
      executor: "0x1111111111111111111111111111111111111111",
    });
    expect(exitReserveAddresses(after)).toEqual([WETH]);
  });
});
