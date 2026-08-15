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

import type { IncomingMessage } from "node:http";
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
 * The watchlist's REAL request parser and its real limits, for the same reason
 * the band rule above is the real one: the panel's error line renders whatever
 * the API says, and a mock with its own wording would let that line be verified
 * against a sentence production never sends. Only the storage is faked.
 *
 * `parseWatchlistOps` is the pure half of `server/watchlist.ts` — no pg, no
 * network — so importing it here costs nothing at vite-serve time.
 */
import {
  parseWatchlistOps,
  WATCHLIST_LABEL_MAX,
  WATCHLIST_MAX,
  type WatchOp,
  type WatchSubscription,
} from "../server/watchlist";
/**
 * The scope union from the module that defines it. Re-declaring it here would
 * let the mock keep answering with a scope the server had stopped issuing, and
 * the whole point of this plugin is that the app cannot tell the difference.
 */
import type { SessionScope } from "../server/sessionStore";

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

// ── /api/watchlist ───────────────────────────────────────────────────────────

/**
 * A second address the fixture owner watches but does not control, so the
 * management panel and the Portfolio switcher both have something real to do
 * offline. It is a watch-only wallet by construction: `/api/positions` answers
 * only for MOCK_WALLET, so selecting this one shows an empty portfolio, which
 * is the honest answer for an address the fixture holds no positions for.
 */
const MOCK_WATCHED_WALLET = "0x9b1f4c7e2a6d8035bf4e1c9a7d2b6f3018e4a5c7";

const nowIso = () => new Date().toISOString();

/**
 * The mock's whole watchlist, keyed by owner, and MUTABLE: the panel's point is
 * that a save changes the list, so a fixture that answered the same rows after
 * a POST would demo the opposite of the feature. It lives for as long as the
 * dev server does; restarting vite resets it to the seed.
 */
const watchlists = new Map<string, WatchSubscription[]>();

function watchlistFor(owner: string): WatchSubscription[] {
  const existing = watchlists.get(owner);
  if (existing) return existing;
  // Only the fixture owner is seeded. Any other address starts empty, which is
  // the same rule /api/positions follows: a typo shows as nothing watched, not
  // as somebody else's list.
  const seeded: WatchSubscription[] =
    owner === MOCK_WALLET
      ? [
          { wallet: MOCK_WALLET, profile: "moderate", label: "Mock dev wallet", createdAt: nowIso(), updatedAt: nowIso() },
          { wallet: MOCK_WATCHED_WALLET, profile: "conservative", label: "Cold storage", createdAt: nowIso(), updatedAt: nowIso() },
        ]
      : [];
  watchlists.set(owner, seeded);
  return seeded;
}

/**
 * Apply a parsed batch in memory, in the order `applyWatchlistOps` documents:
 * every mutation, THEN the cap, then the resulting list. Checking the cap first
 * would let "remove one, add two" pass on the pre-batch count, which is the
 * arithmetic the real transaction is ordered to defeat — and a mock that
 * disagreed with it would make the panel's cap state untestable here.
 *
 * All-or-nothing, like the transaction: the working copy is only published once
 * every op has been applied and the cap still holds.
 */
function applyMockOps(owner: string, ops: WatchOp[]): { watching: WatchSubscription[] } | { status: number; error: string } {
  const next = watchlistFor(owner).map((s) => ({ ...s }));
  for (const op of ops) {
    const at = next.findIndex((s) => s.wallet === op.wallet);
    if (op.op === "remove") {
      if (at >= 0) next.splice(at, 1);
      continue;
    }
    const labelGiven = Object.prototype.hasOwnProperty.call(op, "label");
    const label = labelGiven ? ((op as { label?: string | null }).label ?? null) : null;
    if (op.op === "add") {
      if (at >= 0) {
        next[at] = {
          ...next[at],
          profile: op.profile,
          label: labelGiven ? label : next[at].label,
          updatedAt: nowIso(),
        };
      } else {
        next.push({ wallet: op.wallet, profile: op.profile, label, createdAt: nowIso(), updatedAt: nowIso() });
      }
      continue;
    }
    // An update to a wallet the owner does not watch is the caller believing
    // they watch something they do not, and the real endpoint says so.
    if (at < 0) return { status: 404, error: `not watching ${op.wallet}, so add it first` };
    next[at] = {
      ...next[at],
      profile: op.profile ?? next[at].profile,
      label: labelGiven ? label : next[at].label,
      updatedAt: nowIso(),
    };
  }
  if (next.length > WATCHLIST_MAX) {
    return {
      status: 409,
      error: `watchlist holds ${WATCHLIST_MAX} wallets at most, and this change would leave ${next.length}`,
    };
  }
  watchlists.set(owner, next);
  return { watching: next };
}

/**
 * PANIK_MOCK_WATCHLIST_DOWN=1 makes the read fail, so the panel's "we could not
 * load this" state can be seen without unplugging anything. Same idiom as
 * PANIK_MOCK_SIM: the degraded path is the one a UI is least likely to get
 * right and the hardest to reach by accident.
 */
const watchlistDown = () => process.env.PANIK_MOCK_WATCHLIST_DOWN === "1";

// ── /api/session ─────────────────────────────────────────────────────────────
//
// The four identity routes, in memory. Same shapes and same statuses as
// scripts/api-server.ts, including the 401 bodies, because the app renders
// those strings and a mock with its own wording would let the boot path be
// verified against a sentence production never sends.
//
// WHAT IS FAKED, AND IT MATTERS: there is no signature check on POST
// /api/session, for the same reason the watchlist has none here — mock mode has
// no nonce store and a headless browser has no wallet to sign with. Nothing in
// this file is a trust boundary; it never ships (`apply: 'serve'`).

/**
 * PANIK_MOCK_SESSION=full|readonly|none seeds the session this dev server
 * starts with, so the three boot paths (restore, read-only view, first run) can
 * each be opened and measured without a Supabase row or a wallet. Unset means
 * `none`, which is the previous behaviour exactly: every load is a signed-out
 * one.
 */
interface MockSession {
  token: string;
  wallet: string;
  scope: SessionScope;
  expiresAt: string;
}

/**
 * How long each scope lasts, in days. The real numbers live in
 * `server/sessionStore.ts` as milliseconds; what matters here is that ONE table
 * answers for the seed, the mint and the cookie, because a mock whose row said
 * 30 days and whose cookie said 7 would expire the browser out of a session the
 * server still believed in.
 */
const DAYS: Record<SessionScope, number> = { full: 30, readonly: 7 };

/** The dev server's whole session table, keyed by the token it handed out. */
const sessions = new Map<string, MockSession>();

const MOCK_SESSION_TOKEN = "mock-session-token";

/**
 * The `sid` the mock treats as a live alert link, and it BURNS like the real
 * one: the first trade succeeds and every later trade of the same value gets
 * the production 401. That is the half of the deep-link contract a UI is most
 * likely to get wrong (retrying, or exchanging twice under StrictMode), so the
 * mock refuses to be lenient about it.
 */
const MOCK_SID = "mock-alert-link-token";
const spentSids = new Set<string>();

/**
 * Mint a session and return it.
 *
 * `token` is an argument so the SEED can pin a known one: the middleware plants
 * that exact value as a cookie on the document request, which is what makes
 * "start the server signed in" one command instead of a sign-in dance. Minted
 * tokens are unique, so a re-sign leaves the old row unreachable rather than
 * overwriting it, exactly as a new row would server-side.
 */
function mintMockSession(
  wallet: string,
  scope: SessionScope,
  token = `${MOCK_SESSION_TOKEN}-${sessions.size}-${Date.now()}`,
): MockSession {
  const session: MockSession = {
    token,
    wallet,
    scope,
    expiresAt: new Date(Date.now() + DAYS[scope] * 86_400_000).toISOString(),
  };
  sessions.set(token, session);
  return session;
}

/** The session this dev server starts with, or null for a signed-out boot. */
function seedSession(): SessionScope | null {
  const scope = process.env.PANIK_MOCK_SESSION?.trim().toLowerCase();
  if (scope !== "full" && scope !== "readonly") return null;
  mintMockSession(MOCK_WALLET, scope, MOCK_SESSION_TOKEN);
  return scope;
}

/** The session cookie this request presents, if the browser kept one. */
function presentedSession(cookieHeader: string | undefined): MockSession | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== "panik_session") continue;
    return sessions.get(part.slice(eq + 1).trim()) ?? null;
  }
  return null;
}

/**
 * The Set-Cookie the mock sets. Production's attributes minus `Secure`
 * (server/sessionStore.ts keeps it, and browsers exempt http://localhost from
 * it) — dropped here so the cookie also survives when the dev server is reached
 * over http on a LAN address, which `--host 0.0.0.0` invites and which is not a
 * localhost exemption.
 */
function mockSessionCookie(session: MockSession): string {
  return `panik_session=${session.token}; Max-Age=${DAYS[session.scope] * 86_400}; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Read a request body and hand it over as JSON, or answer 400 in the API's own
 * shape.
 *
 * One copy for the two POST routes. There were two, byte for byte, and the
 * second was written by copying the first: the way that goes wrong is not that
 * the parse drifts but that one of them grows a size cap or an encoding fix and
 * the other does not.
 */
function withJsonBody(
  req: IncomingMessage,
  send: (status: number, body: unknown) => void,
  use: (body: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      use(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
    } catch {
      send(400, { error: "body is not JSON" });
    }
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
        const seededScope = seedSession();
        if (seededScope) {
          server.config.logger.info(
            `  \x1b[33m➜\x1b[0m  MOCK SESSION: this browser boots with a ${seededScope} session` +
              `\n     Alert-link token for ?sid= (single use): ${MOCK_SID}\n`,
          );
        }

        server.middlewares.use((req, res, next) => {
          /* Hand the seeded session to the browser on the APP DOCUMENT request,
             so the cookie is there before any script runs and stays HttpOnly. A
             seed script could not do this: production's cookie is HttpOnly by
             design, and a mock that made it readable would be exercising a
             different mechanism than the one that ships.

             Scoped to /app.html for the same reason the html transform below
             is: the landing, founding, try and admin entries have no dashboard
             to unlock. Only while the row is still there, so a sign-out is not
             undone by the next reload. */
          const seeded = sessions.get(MOCK_SESSION_TOKEN);
          if (
            seeded &&
            req.url?.startsWith("/app.html") &&
            !presentedSession(req.headers.cookie)
          ) {
            res.setHeader("Set-Cookie", mockSessionCookie(seeded));
          }
          if (!req.url?.startsWith("/api/")) return next();
          const url = new URL(req.url, "http://localhost");

          const send = (status: number, body: unknown) => {
            res.statusCode = status;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(body));
          };

          /* The four session routes. Cookies are real here: the dev server is
             the same origin as the app, so the browser stores and returns this
             exactly as it does in production, and the boot path is exercised
             end to end rather than stubbed. */
          if (url.pathname === "/api/session" || url.pathname === "/api/session/exchange") {
            const live = presentedSession(req.headers.cookie);

            if (url.pathname === "/api/session" && req.method === "GET") {
              if (!live) return send(401, { error: "not signed in" });
              return send(200, { wallet: live.wallet, scope: live.scope, expiresAt: live.expiresAt });
            }

            if (url.pathname === "/api/session" && req.method === "DELETE") {
              // Revoke server-side AND clear the cookie, in that order of
              // importance, exactly as the real route does.
              if (live) sessions.delete(live.token);
              res.setHeader("Set-Cookie", "panik_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
              return send(200, { ok: true });
            }

            if (req.method !== "POST") return send(405, { error: "method not allowed" });

            return withJsonBody(req, send, (body) => {
              if (url.pathname === "/api/session/exchange") {
                const token = (body as { token?: unknown } | null)?.token;
                if (typeof token !== "string" || token !== MOCK_SID || spentSids.has(token)) {
                  // One string for unknown / expired / already used, because
                  // the real endpoint genuinely cannot tell them apart.
                  return send(401, {
                    error: "alert link is no longer valid — open PANIK from a fresh alert",
                  });
                }
                spentSids.add(token);
                // Mirrors the real route: a browser already holding a FULL
                // session for this wallet keeps it. The token is burned either
                // way, but handing back a 7-day readonly cookie would downgrade
                // the signed-in user who tapped their own alert.
                if (live && live.scope === "full" && live.wallet === MOCK_WALLET) {
                  return send(200, {
                    wallet: live.wallet,
                    scope: live.scope,
                    expiresAt: live.expiresAt,
                  });
                }
                const minted = mintMockSession(MOCK_WALLET, "readonly");
                res.setHeader("Set-Cookie", mockSessionCookie(minted));
                return send(200, {
                  wallet: minted.wallet,
                  scope: minted.scope,
                  expiresAt: minted.expiresAt,
                });
              }
              /* POST /api/session. The proof is accepted UNREAD (see the note
                 above this route table). The wallet is lifted out of the SIWE
                 message the client built, which is the one part of the proof
                 that is readable without a verifier, so signing in as a
                 non-fixture address in mock mode still shows that address. */
              const message = (body as { message?: unknown } | null)?.message;
              const named = typeof message === "string" ? /0x[0-9a-fA-F]{40}/.exec(message) : null;
              const minted = mintMockSession((named?.[0] ?? MOCK_WALLET).toLowerCase(), "full");
              res.setHeader("Set-Cookie", mockSessionCookie(minted));
              return send(200, {
                wallet: minted.wallet,
                scope: minted.scope,
                expiresAt: minted.expiresAt,
              });
            });
          }

          /* The watchlist is the one route with a WRITE and with per-request
             statuses, so it is handled here rather than in `handle`, which is a
             pathname -> 200 body table by design. */
          if (url.pathname === "/api/watchlist") {
            if (watchlistDown()) return send(502, { error: "mock watchlist is switched off" });
            if (req.method === "GET") {
              const owner = (url.searchParams.get("owner") ?? "").trim().toLowerCase();
              if (!/^0x[0-9a-f]{40}$/.test(owner)) {
                return send(400, { error: "invalid EVM wallet address" });
              }
              return send(200, {
                updatedAt: Date.now(),
                watching: watchlistFor(owner),
                max: WATCHLIST_MAX,
                labelMax: WATCHLIST_LABEL_MAX,
              });
            }
            if (req.method === "POST") {
              return withJsonBody(req, send, (body) => {
                /* NO SIGNATURE CHECK, and it has to be said out loud: mock mode
                   has no nonce store and a headless browser has no wallet to
                   sign with, so the proof is accepted unread. The OWNER
                   therefore comes off the body here, which is precisely what the
                   real endpoint refuses to do — there, the proof's signer is the
                   owner and the body cannot name one. Nothing in this file is a
                   trust boundary; it never ships (`apply: 'serve'`). */
                const owner = String(
                  (body as { owner?: unknown } | null)?.owner ?? MOCK_WALLET,
                )
                  .trim()
                  .toLowerCase();
                const parsed = parseWatchlistOps(body);
                if ("error" in parsed) return send(400, { error: parsed.error });
                const applied = applyMockOps(owner, parsed.ops);
                if ("error" in applied) return send(applied.status, { error: applied.error });
                return send(200, { ok: true, watching: applied.watching });
              });
            }
            return send(405, { error: "method not allowed" });
          }

          if (req.method !== "GET") return next();
          const body = handle(url);
          if (body === undefined) return next(); // e.g. /api/health -> real proxy
          send(200, body);
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
