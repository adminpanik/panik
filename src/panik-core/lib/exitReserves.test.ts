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

import { describe, expect, it } from "vitest";
import { exitReserveSet, type MarketReserve } from "./exitReserves";

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
});
