/**
 * PANIK — live ACTIVE-mode scoring for one wallet, on the configured chain.
 * Run:  npm run score:wallet -- 0xYourWallet
 *       PANIK_SCORING_CHAIN=testnet npm run score:wallet -- 0xYourWallet
 *
 * Same construction as the API server and the worker (server/scoringChain.ts),
 * so what it prints is what /api/positions would serve. It exists to answer the
 * question "does the product actually see this position on this chain" without
 * booting the API, a database and a browser first.
 *
 * Reads only. No keys are needed beyond the RPC + CoinGecko ones already in
 * .env, and on a chain whose market context is unavailable (testnet) the
 * CoinGecko key is never used.
 */

import {
  CoinGeckoProvider,
  DefiLlamaProvider,
  statusFor,
  type RiskProfile,
} from "../packages/scoring/src/index";
import { buildScoringChain, resolveAlchemyKey } from "../server/scoringChain";

const wallet = process.argv[2]?.trim();
if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
  console.error("usage: npm run score:wallet -- 0x<40 hex>");
  process.exit(1);
}

const profile: RiskProfile =
  process.env.PANIK_RISK_PROFILE === "conservative" || process.env.PANIK_RISK_PROFILE === "aggressive"
    ? process.env.PANIK_RISK_PROFILE
    : "moderate";

const alchemy = resolveAlchemyKey(process.env.PANIK_SCORING_CHAIN, process.env);
if (alchemy.key === null) {
  console.error(`Missing env ${alchemy.missing} (scoring chain: ${alchemy.config.label})`);
  process.exit(1);
}

const scoringChain = buildScoringChain({
  mode: process.env.PANIK_SCORING_CHAIN,
  alchemyKey: alchemy.key,
  providers: {
    // Constructed either way; on a chain with `marketContext: "unavailable"`
    // the adapter never calls them (see ActiveAdapter.marketContext).
    assetRisk: new CoinGeckoProvider(process.env.COINGECKO_API_KEY ?? ""),
    systemic: new DefiLlamaProvider(),
  },
  onReaderError: (err) => console.error(`  reader failed: ${(err as Error).message.slice(0, 160)}`),
  onCompoundWarn: (m) => console.warn(`  compound reader degraded: ${m}`),
});

const { config } = scoringChain;
console.log(
  `\nPANIK active scores — wallet ${wallet}` +
    `\nchain     ${config.label} (${config.chainId})` +
    `\nprotocols ${config.protocols.join(", ")}` +
    `\ncontext   market risk ${config.marketContext}` +
    `\nblock     ${await scoringChain.telemetry.getBlockNumber()}\n` +
    "─".repeat(96),
);

const scores = await scoringChain.adapter.scoreWallet(wallet);
if (scores.length === 0) {
  console.log("no readable position for this wallet on this chain\n");
  process.exit(0);
}

/** Unknowns print as "not measured", never as 0 or $0 (DESIGN_SYSTEM.md). */
const usd = (v: number | null) => (v === null ? "not measured" : `$${v.toFixed(2)}`);
const num = (v: number | null, digits = 0) => (v === null ? "not measured" : v.toFixed(digits));

for (const s of scores) {
  console.log(
    `protocol            ${s.protocol}\n` +
      `collateral          ${usd(s.collateralValueUsd)}\n` +
      `debt                ${usd(s.borrowValueUsd)}\n` +
      `health factor       ${num(s.healthFactor, 4)}\n` +
      `scored collateral   ${s.scoredCollateralSymbol}\n` +
      `dominant borrow     ${s.dominantBorrowSymbol ?? "not measured"}\n` +
      `liq. threshold      ${num(s.weightedLiquidationThreshold, 4)}\n` +
      `sub  positionHealth ${num(s.subScores.positionHealth, 1)}\n` +
      `sub  assetRisk      ${num(s.subScores.assetRisk, 1)}\n` +
      `sub  protocolSafety ${num(s.subScores.protocolSafety, 1)}\n` +
      `sub  systemicRisk   ${num(s.subScores.systemicRisk, 1)}\n` +
      `TOTAL               ${s.total}  ${s.band}\n` +
      `profile (${profile})   ${statusFor(profile, s.total)}\n` +
      `usd unavailable     ${s.usdValuesUnavailable}\n` +
      `market ctx missing  ${s.marketContextUnavailable}\n` +
      "─".repeat(96),
  );
}
console.log();
