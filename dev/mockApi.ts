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
  MOCK_WALLET,
  MOCK_WALLETS,
  mockAdvisor,
  mockChain,
  mockHistory,
  mockProspective,
} from "./fixtures";

/**
 * localStorage the dashboard reads before it will show anything (AppDemo.tsx
 * ~:347-372). Seeded from the page itself rather than by touching AppDemo, so
 * no production component knows mock mode exists.
 *
 * `panik_wallet` is the load-bearing one: it flips AppDemo into boundMode,
 * which is what fires the per-wallet /api/positions, /api/history and
 * /api/advisor requests this plugin answers.
 */
const SEED: Record<string, string> = {
  panik_onboarded: "true",
  panik_wallet: MOCK_WALLET,
  panik_risk_profile: "moderate",
  panik_tour_seen: "true",
  panik_user_segment: "risk_optimizer",
  panik_risk_tier: "moderate",
};

/**
 * Only fills keys that are UNSET. A dev who onboarded for real, or who is
 * mid-way through testing the tour, must not have that state stomped on every
 * reload — clear the keys in devtools to get the tour back.
 */
const seedScript = `(function(){var s=${JSON.stringify(SEED)};try{for(var k in s){if(localStorage.getItem(k)===null)localStorage.setItem(k,s[k]);}}catch(e){}})();`;

/** Route table: pathname -> body. Returning undefined means "not mine". */
function handle(url: URL): unknown {
  const profile = url.searchParams.get("profile") ?? "moderate";
  const updatedAt = Date.now();

  switch (url.pathname) {
    case "/api/scores":
      return { updatedAt, positions: MOCK_POSITIONS };
    case "/api/positions": {
      // The real endpoint is per-wallet; answer only for the seeded wallet so a
      // typo in the query shows up as an empty dashboard, not as fake data.
      const wallet = url.searchParams.get("wallet") ?? "";
      const mine = wallet.toLowerCase() === MOCK_WALLET;
      return { updatedAt, positions: mine ? MOCK_POSITIONS : [] };
    }
    case "/api/history":
      return mockHistory();
    case "/api/wallets":
      return { wallets: MOCK_WALLETS };
    case "/api/chain":
      return mockChain();
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
          `\n  \x1b[33m➜\x1b[0m  MOCK API: /api/* served from dev/fixtures.ts — wallet ${MOCK_WALLET}\n`,
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
