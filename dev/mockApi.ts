/**
 * `npm run dev:mock` — the whole scoring API, answered from dev/fixtures.ts.
 *
 * WHY: the dashboard is only interesting when it has positions in it, and
 * getting positions normally means an .env, a Supabase instance, Alchemy/Dune
 * keys, a second terminal for `npm run dev:api`, and a wallet with real Base
 * debt. That is a long walk for someone who just wants to fix a chart. This
 * plugin makes ONE terminal enough.
 *
 * SAFETY: `apply: 'serve'` — Vite never invokes this during `vite build`, so
 * nothing here can reach dist/. It is also inert unless explicitly asked for
 * (`--mode mock`), so `npm run dev` keeps proxying to :8787 exactly as before.
 *
 * ORDERING: Vite runs `configureServer` hooks BEFORE it installs its own
 * middlewares, so `server.middlewares.use(...)` here lands ahead of the
 * `/api -> 127.0.0.1:8787` proxy. Same idiom as the html-rewrite plugin in
 * vite.config.ts. Unhandled /api paths call next() and fall through to the
 * proxy untouched, so e.g. /api/health still hits a real server if one is up.
 */

import type { Plugin } from "vite";
import {
  MOCK_COMPASS,
  MOCK_POOLS,
  MOCK_POSITIONS,
  MOCK_SCORING_CHAIN,
  MOCK_WALLET,
  MOCK_WALLETS,
  mockAdvisor,
  mockChain,
  mockHistory,
  mockProspective,
} from "./fixtures";
/**
 * The real engine, not a mock of it. This plugin runs in Node during `vite
 * serve`, never in a browser bundle, so the usual deep-import discipline does
 * not apply here and the fixture can use the actual override arithmetic and the
 * actual band rule. A hand-rolled "times 0.6" here would be a second copy of
 * the thing being demonstrated, free to disagree with it.
 */
import { bandFor } from "../packages/scoring/src/computeScore";
import { LIQUIDATION_PROXIMITY_FLOORS } from "../packages/scoring/src/params";
import {
  applySimulationToReading,
  multiplierFromPct,
  scenarioByKey,
  type MarketSimulation,
} from "../packages/scoring/src/simulation";

/**
 * localStorage the dashboard reads. Seeded from the page itself rather than by
 * touching AppDemo, so no production component knows mock mode exists.
 *
 * `panik_wallet` is NOT here any more, and that is the point of this comment.
 * It used to hold the fixture address, AppDemo restored it as the dashboard's
 * wallet on the next load, and a dev who had ever run `dev:mock` then saw a
 * wallet nobody owned scored as if it were theirs — including in `npm run dev`
 * against the real API, where their own position was invisible. AppDemo no
 * longer restores a wallet from localStorage at all, so this plugin has no way
 * to assert an identity and should not want one.
 *
 * What it CAN seed is the profile that address already answered for, keyed by
 * wallet in the same store the app writes. Pasting the fixture address into the
 * first-run invitation then completes instantly instead of walking the quiz.
 */
const MOCK_PROFILE = {
  riskScore: 50,
  riskTier: "moderate",
  riskTierLabel: "Moderate",
  riskProfile3: "moderate",
  segment: "risk_optimizer",
  segmentLabel: "Risk Optimizer",
};

const SEED: Record<string, string> = {
  panik_onboarded: "true",
  panik_risk_profile: "moderate",
  panik_tour_seen: "true",
  panik_user_segment: "risk_optimizer",
  panik_risk_tier: "moderate",
  // PROFILE_STORE_KEY in AppDemo.tsx.
  panik_profiles_by_wallet: JSON.stringify({ [MOCK_WALLET]: MOCK_PROFILE }),
};

/**
 * Only fills keys that are UNSET. A dev who onboarded for real, or who is
 * mid-way through testing the tour, must not have that state stomped on every
 * reload — clear the keys in devtools to get the tour back.
 */
const seedScript = `(function(){var s=${JSON.stringify(SEED)};try{for(var k in s){if(localStorage.getItem(k)===null)localStorage.setItem(k,s[k]);}}catch(e){}})();`;

/**
 * PANIK_MOCK_SIM arms a market simulation in mock mode, so the user-facing
 * marker can be built and measured without a Supabase row, an admin session and
 * a wallet with real testnet debt.
 *
 * Value is a scenario key (`stress` / `crash` / `blackswan`) or a signed
 * percentage (`-30`). Unset means no simulation, which is the default and the
 * previous behaviour exactly.
 */
function mockSimulation(): MarketSimulation | null {
  const raw = process.env.PANIK_MOCK_SIM?.trim();
  if (!raw) return null;
  const preset = scenarioByKey(raw);
  const pct = preset ? preset.pct : Number(raw) / 100;
  if (!Number.isFinite(pct) || pct === 0) return null;
  const multiplier = multiplierFromPct(pct);
  // Every collateral asset the fixture holds, so the marker appears on rows
  // rather than on none of them.
  const multipliers: Record<string, number> = {};
  for (const p of MOCK_POSITIONS) multipliers[p.scoredCollateralSymbol] = multiplier;
  const startedAt = Date.now();
  return {
    id: "mock-simulation",
    scenario: preset ? preset.key : "custom",
    label: preset ? preset.label : `Custom ${Number(raw)}%`,
    multipliers,
    setBy: "dev",
    startedAt,
    expiresAt: startedAt + 60 * 60_000,
  };
}

/**
 * Apply a mock scenario to the fixture positions, through the engine's own
 * override and the engine's own band rule.
 *
 * WHAT THIS DOES NOT DO: re-derive the composite's market-context terms. Asset
 * risk and systemic risk come from CoinGecko and DefiLlama, and mock mode has
 * neither, so the fixture's own sub-scores stand. What IS applied is the
 * liquidation-proximity floor, which is the rule that actually escalates a band
 * during a crash (params.ts: HF at or below 1.25 floors the score at 50, at or
 * below 1.1 at 75). So the numbers here move for the same reason and by the
 * same rule as the real path, and the one term that would need a live provider
 * is left alone rather than invented.
 */
function simulatedPositions(sim: MarketSimulation): typeof MOCK_POSITIONS {
  return MOCK_POSITIONS.map((p) => {
    const { reading, stamp } = applySimulationToReading(
      {
        protocol: p.protocol,
        positionHealth: {
          healthFactor: p.healthFactor,
          currentLtv:
            p.collateralValueUsd && p.borrowValueUsd ? p.borrowValueUsd / p.collateralValueUsd : 0,
          maxLtv: 0.8,
        },
        collateralValueUsd: p.collateralValueUsd,
        borrowValueUsd: p.borrowValueUsd,
        weightedLiquidationThreshold: null,
        dominantCollateralSymbol: p.scoredCollateralSymbol,
        dominantBorrowSymbol: null,
      },
      sim,
      Date.now(),
    );
    if (!stamp) return p;
    const hf = reading.positionHealth.healthFactor;
    const floor =
      hf === null ? 0 : (LIQUIDATION_PROXIMITY_FLOORS.find((f) => hf <= f.hfAtOrBelow)?.minScore ?? 0);
    const total = Math.max(p.total, floor);
    return {
      ...p,
      total,
      band: bandFor(total),
      healthFactor: hf,
      collateralValueUsd: reading.collateralValueUsd,
      borrowValueUsd: reading.borrowValueUsd,
      simulation: stamp,
    };
  });
}

/** Route table: pathname -> body. Returning undefined means "not mine". */
function handle(url: URL): unknown {
  const profile = url.searchParams.get("profile") ?? "moderate";
  const updatedAt = Date.now();
  const sim = mockSimulation();

  switch (url.pathname) {
    case "/api/scores":
      return { updatedAt, positions: MOCK_POSITIONS, chain: MOCK_SCORING_CHAIN };
    case "/api/positions": {
      // The real endpoint is per-wallet; answer only for the seeded wallet so a
      // typo in the query shows up as an empty dashboard, not as fake data.
      const wallet = url.searchParams.get("wallet") ?? "";
      const mine = wallet.toLowerCase() === MOCK_WALLET;
      const positions = mine ? (sim ? simulatedPositions(sim) : MOCK_POSITIONS) : [];
      return {
        updatedAt,
        positions,
        chain: MOCK_SCORING_CHAIN,
        // Mirrors the real route: the marker travels WITH the payload it
        // describes, never on a separate poll.
        simulation: sim
          ? {
              id: sim.id,
              scenario: sim.scenario,
              label: sim.label,
              multipliers: sim.multipliers,
              startedAt: sim.startedAt,
              expiresAt: sim.expiresAt,
            }
          : null,
      };
    }
    case "/api/history":
      return mockHistory();
    case "/api/wallets":
      return { wallets: MOCK_WALLETS };
    case "/api/chain":
      return { ...mockChain(), chain: MOCK_SCORING_CHAIN };
    case "/api/compass":
      return { updatedAt, scores: MOCK_COMPASS };
    case "/api/poolhistory":
      return { updatedAt, pools: MOCK_POOLS };
    case "/api/advisor":
      return mockAdvisor(profile);
    case "/api/telegram/status":
      // Shape mirrors the real endpoint exactly: `{ linked }` and nothing else.
      // It deliberately does NOT return the @username — that was a
      // deanonymisation fix (scripts/api-server.ts ~:1040). Without this case
      // the alerts card falls through to the dead :8787 proxy and throws a 500
      // into the console on every load; false is the honest answer, since mock
      // mode has no Telegram bot to link against.
      return { linked: false };
    case "/api/prospective":
      return mockProspective(
        url.searchParams.get("protocol") ?? "",
        url.searchParams.get("symbol") ?? "",
      );
    case "/api/exit/delegations":
      // The live-permit query (Phase 2.C). Mock mode has no executor to read a
      // signed permit from, so the honest answer is an empty list — same reason
      // as /api/telegram/status above: without this case the standing-permission
      // card falls through to the dead :8787 proxy and throws a 500 on load.
      return { wallet: (url.searchParams.get("wallet") ?? "").toLowerCase(), delegations: [] };
    default:
      return undefined;
  }
}

/**
 * Active for `vite --mode mock` (what `npm run dev:mock` runs) or PANIK_MOCK=1.
 * The mode flag is the primary switch because `PANIK_MOCK=1 vite` is bash
 * syntax and npm scripts run through cmd.exe on Windows.
 */
export function mockApi(mode: string): Plugin[] {
  if (mode !== "mock" && process.env.PANIK_MOCK !== "1") return [];

  return [
    {
      name: "panik-mock-api",
      apply: "serve",
      configureServer(server) {
        server.config.logger.info(
          `\n  \x1b[33m➜\x1b[0m  MOCK API: /api/* served from dev/fixtures.ts` +
            `\n     Paste this into "Add your wallet" to populate the dashboard:` +
            `\n     ${MOCK_WALLET}\n`,
        );
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/api/") || req.method !== "GET") return next();
          const body = handle(new URL(req.url, "http://localhost"));
          if (body === undefined) return next(); // e.g. /api/health -> real proxy
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        });
      },
      transformIndexHtml: {
        order: "pre",
        handler(_html, ctx) {
          // app.html only — the landing / founding / try / admin entries have no
          // dashboard to unlock and should behave normally.
          if (!ctx.path.startsWith("/app.html")) return;
          return [{ tag: "script", children: seedScript, injectTo: "head-prepend" as const }];
        },
      },
    },
  ];
}
