/**
 * Issue #53, proved against the live Base Sepolia deployment.
 *
 * Run:  node --import tsx scripts/proof/reserve-set-consumers.ts
 *       (add --env-file=.env to use the Alchemy key; the public node also works)
 *
 * READ-ONLY. Every call below is an `eth_call`. Nothing is signed, nothing is
 * submitted, and the relayer is never armed - `RELAYER_ENABLED` is not read and
 * `runRelayerTick` is not called. The leg builder is a pure function over what
 * the chain reports, so section (b) shows exactly the legs the relayer WOULD
 * build without going anywhere near the submit path.
 *
 * Three things it proves, against the wallet holding the live test position:
 *
 *   (a) the resolved reserve set contains the assets the position actually uses
 *   (b) the relayer's leg builder produces the right repay/withdraw legs for it
 *   (c) the coverage sweep resolves the SAME set and inspects the right
 *       approvals
 */

import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_DATA_PROVIDER_ADDRESS,
  EXIT_USDC_ADDRESS,
  EXIT_WETH_ADDRESS,
} from "../../src/panik-core/lib/exit.generated";
import {
  loadExitReserveSet,
  exitReserveAddresses,
} from "../../src/panik-core/lib/exitReserves";
import { buildExitLegs, formatTokenAmount, AMOUNT_FULL } from "../../src/panik-core/lib/exitLegs";
import { ViemRelayerChain, relayerRpcUrl } from "../../server/relayerChain";
import { ViemCoverageChain, coverageMarketsFromEnv } from "../../server/coverageChain";

/** The live Base Sepolia position under test. */
const WALLET = "0xa48fd1407Ce1d31d4b85b6F48cA3209457056894" as const;

const line = (s = "") => console.log(s);
const rule = (title: string) => {
  line();
  line(`── ${title} ${"─".repeat(Math.max(0, 74 - title.length))}`);
  line();
};

/** Display only. Never fed back into a token amount. */
const amt = (v: bigint, decimals: number, symbol: string) =>
  v === AMOUNT_FULL ? "MAX (uint256 max)" : `${formatTokenAmount(v, decimals)} ${symbol}`;

async function main() {
  const rpcUrl = relayerRpcUrl();
  line(`network      : Base Sepolia (chainId ${EXIT_CHAIN_ID})`);
  line(`rpc          : ${rpcUrl.replace(/\/v2\/.*/, "/v2/<redacted>")}`);
  line(`executor     : ${EXECUTOR_ADDRESS}`);
  line(`dataProvider : ${EXIT_DATA_PROVIDER_ADDRESS}`);
  line(`wallet       : ${WALLET}`);
  line(`payout token : ${EXIT_USDC_ADDRESS}  <- executor.usdc(), NOT a reserve`);

  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  }) as unknown as { readContract(p: unknown): Promise<unknown> };

  // ── (a) the resolved reserve set ──────────────────────────────────────────
  rule("(a) resolved reserve set: market reserves INTERSECT executor tracked assets");

  const set = await loadExitReserveSet(client);
  for (const r of set) line(`  ${r.symbol.padEnd(6)} ${r.reserve}`);

  const addrs = exitReserveAddresses(set).map((a) => a.toLowerCase());
  const hasPayout = addrs.includes(EXIT_USDC_ADDRESS.toLowerCase());
  line();
  line(`  resolved ${set.length} reserves`);
  line(`  payout token present in the set : ${hasPayout} ${hasPayout ? "<- BUG" : "(correct)"}`);

  // The pair the two consumers used to hardcode.
  line();
  line(`  old hardcoded pair was:`);
  line(`    ${EXIT_USDC_ADDRESS}  (payout token - Aave does not list it)`);
  line(`    ${EXIT_WETH_ADDRESS}  (WETH - a real reserve)`);

  // What the old pair cost: prove the payout token is genuinely unreadable.
  try {
    await client.readContract({
      address: EXIT_DATA_PROVIDER_ADDRESS,
      abi: [
        {
          type: "function",
          name: "getUserReserveData",
          stateMutability: "view",
          inputs: [
            { name: "asset", type: "address" },
            { name: "user", type: "address" },
          ],
          outputs: Array.from({ length: 7 }, (_, i) => ({ name: `o${i}`, type: "uint256" })).concat([
            { name: "o7", type: "uint40" } as never,
            { name: "o8", type: "bool" } as never,
          ]),
        },
      ],
      functionName: "getUserReserveData",
      args: [EXIT_USDC_ADDRESS, WALLET],
    });
    line(`  getUserReserveData(payout token) : SUCCEEDED  <- unexpected`);
  } catch (err) {
    line(`  getUserReserveData(payout token) : REVERTS  (${(err as Error).message.split("\n")[0]})`);
  }

  // ── (b) the relayer's leg builder ─────────────────────────────────────────
  rule("(b) relayer leg builder over the live position (READ-ONLY, relayer disarmed)");

  const relayerChain = new ViemRelayerChain({ rpcUrl, chainId: EXIT_CHAIN_ID });
  line(`  relayer resolves : [${(await relayerChain.reserves()).join(", ")}]`);
  line();

  const states = await relayerChain.reserveStates(WALLET);
  line(`  position as the relayer reads it:`);
  for (const s of states) {
    line(
      `    ${s.symbol.padEnd(6)} decimals=${String(s.decimals).padEnd(2)} ` +
        `collateral=${formatTokenAmount(s.aBalance, s.decimals)} ` +
        `debt=${formatTokenAmount(s.debt, s.decimals)}`,
    );
  }

  for (const kind of ["full", "full_repay"] as const) {
    const { legs, views } = buildExitLegs(states, { protocol: "aave_v3", kind });
    line();
    line(`  kind="${kind}" -> ${legs.length} leg(s)`);
    for (const v of views) {
      line(
        `    ${v.symbol.padEnd(6)} repay=${amt(v.repay, v.decimals, v.symbol).padEnd(22)} ` +
          `withdraw=${amt(v.withdraw, v.decimals, v.symbol).padEnd(22)} ` +
          `fundingNeeded=${formatTokenAmount(v.repayFunding, v.decimals)} ${v.symbol}`,
      );
    }
  }

  // The counterfactual: what the OLD hardcoded pair would have produced.
  line();
  const oldPairStates = states.filter((s) =>
    [EXIT_USDC_ADDRESS.toLowerCase(), EXIT_WETH_ADDRESS.toLowerCase()].includes(
      s.reserve.toLowerCase(),
    ),
  );
  const oldLegs = buildExitLegs(oldPairStates, { protocol: "aave_v3", kind: "full" });
  line(`  counterfactual - legs the OLD hardcoded pair could reach: ${oldLegs.legs.length}`);
  line(`  (and the read against the payout token reverts first, so the tick died)`);

  // ── (c) the coverage sweep ────────────────────────────────────────────────
  rule("(c) coverage sweep: same set, and the approvals it inspects");

  const coverageChain = new ViemCoverageChain({ rpcUrl, chainId: EXIT_CHAIN_ID });
  const sweepReserves = await coverageChain.aaveReserves();
  const markets = coverageMarketsFromEnv(sweepReserves);
  line(`  sweep resolves   : [${sweepReserves.join(", ")}]`);
  line(
    `  identical to relayer: ${
      JSON.stringify(sweepReserves) === JSON.stringify(await relayerChain.reserves())
    }`,
  );
  line(`  markets.aaveReserves length: ${markets.aaveReserves.length}`);
  line();

  const sweepStates = await coverageChain.reserveStates(WALLET);
  line(`  approvals the sweep inspects for this wallet:`);
  for (const s of sweepStates) {
    if (s.debt > 0n) {
      const allowance = await coverageChain.allowance(s.reserve, WALLET, EXECUTOR_ADDRESS);
      line(
        `    repay   ${s.symbol.padEnd(6)} token=${s.reserve} ` +
          `allowance=${formatTokenAmount(allowance, s.decimals)} ` +
          `needed(full)=${formatTokenAmount(s.debt, s.decimals)}` +
          `${allowance < s.debt ? "  <- GAP" : "  (covered)"}`,
      );
    }
    if (s.aBalance > 0n) {
      const aToken = await coverageChain.aTokenFor(s.reserve);
      if (!aToken) {
        line(`    collat  a${s.symbol.padEnd(5)} aToken unresolved -> reported UNVERIFIABLE`);
        continue;
      }
      const allowance = await coverageChain.allowance(aToken, WALLET, EXECUTOR_ADDRESS);
      line(
        `    collat  a${s.symbol.padEnd(5)} aToken=${aToken} ` +
          `allowance=${formatTokenAmount(allowance, s.decimals)} ` +
          `needed=${formatTokenAmount(s.aBalance, s.decimals)}` +
          `${allowance < s.aBalance ? "  <- GAP" : "  (covered)"}`,
      );
    }
  }

  line();
  line(`  under the OLD fallback the sweep would have inspected:`);
  line(`    ${EXIT_USDC_ADDRESS} (payout token - no position holds it)`);
  line(`    ${EXIT_WETH_ADDRESS} (WETH - this wallet has no WETH position)`);
  line(`  ...found nothing to flag, and reported coverage healthy.`);

  rule("done - nothing was signed or submitted");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
