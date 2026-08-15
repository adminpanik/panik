/**
 * THE RULES THIS FILE EXISTS TO ENFORCE, on the route table that actually ships:
 *
 *   1. EVERY ACCOUNT ROUTE IS BEHIND requireAccount. A route that reads
 *      res.locals.account without it would treat `undefined` as an identity.
 *
 *   2. EVERYTHING BUT THE WAY IN IS BEHIND requireMember. The closed beta is
 *      the product decision this PR implements: an account with no redeemed
 *      voucher gets nothing. Exactly two routes are exempt, and both are the
 *      door itself — GET /api/account (the SPA cannot render the screen that
 *      asks for a code if the account endpoint refuses to answer) and POST
 *      /api/account/voucher (gating redemption on membership would mean only
 *      members could become members). Anything else appearing on that list is
 *      a hole, which is why the exemption is enumerated here rather than
 *      inferred.
 *
 *   3. LINKING A WALLET NEEDS BOTH PROOFS. The bearer says which account; the
 *      SIWE signature, bound to its own action URN, says which wallet. Losing
 *      either half is an account takeover in a different direction.
 *
 *   4. THE ADMIN ROSTER STAYS BEHIND THE ADMIN GATE. It lists every account.
 *
 * Source-scanning is the honest instrument here for the same reason
 * server/sessionBoundary.test.ts gives: importing scripts/api-server.ts calls
 * app.listen and exits on missing env, and a hand-built replica would only
 * prove the replica safe.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ACTION_STATEMENT, OWNERSHIP_ACTIONS, actionResource } from "./siweProof";

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/api-server.ts", import.meta.url)),
  "utf8",
);

interface Route {
  key: string;
  body: string;
}

/** Same parser shape as server/sessionBoundary.test.ts. */
function routes(): Route[] {
  const found: Route[] = [];
  const re = /^app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm;
  const starts: Array<{ method: string; path: string; at: number }> = [];
  for (const m of SERVER_SRC.matchAll(re)) {
    starts.push({ method: m[1]!, path: m[2]!, at: m.index! });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const nextStart = i + 1 < starts.length ? starts[i + 1]!.at : SERVER_SRC.length;
    const close = SERVER_SRC.indexOf("\n});", s.at);
    const end = close >= 0 ? Math.min(nextStart, close + 4) : nextStart;
    found.push({ key: `${s.method} ${s.path}`, body: SERVER_SRC.slice(s.at, end) });
  }
  return found;
}

const ALL = routes();
const route = (key: string): Route => {
  const found = ALL.find((r) => r.key === key);
  expect(found, `${key} is missing from the route table`).toBeDefined();
  return found!;
};

const ACCOUNT_ROUTES = [
  "get /api/account",
  "post /api/account/voucher",
  "post /api/account/wallets",
  "delete /api/account/wallets/:wallet",
];

describe("the route table parsed for these assertions", () => {
  it("found the account surface it is meant to be guarding", () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true — the failure mode of every source-scanning test.
    expect(ALL.length).toBeGreaterThan(20);
    for (const key of ACCOUNT_ROUTES) expect(ALL.map((r) => r.key)).toContain(key);
    expect(ALL.map((r) => r.key)).toContain("get /api/admin/users");
  });
});

describe("the closed beta is enforced on the server", () => {
  it("every account route resolves the caller with requireAccount", () => {
    for (const key of ACCOUNT_ROUTES) {
      expect(route(key).body, `${key} must run requireAccount()`).toContain("requireAccount()");
    }
  });

  it("every account route except the two doorway ones is behind requireMember", () => {
    // Enumerated, not inferred: a third exemption has to be typed here, in
    // front of this comment, rather than appearing by omission.
    const EXEMPT = new Set(["get /api/account", "post /api/account/voucher"]);
    for (const key of ACCOUNT_ROUTES) {
      if (EXEMPT.has(key)) {
        expect(route(key).body, `${key} is listed as exempt`).not.toContain("requireMember");
        continue;
      }
      expect(route(key).body, `${key} must be behind requireMember`).toContain("requireMember");
    }
    // And the exempt pair is exactly the pair, not a set that grew.
    expect([...EXEMPT].sort()).toEqual(["get /api/account", "post /api/account/voucher"]);
  });

  it("no route reads res.locals.account without establishing it first", () => {
    const offenders = ALL.filter(
      (r) => r.body.includes("res.locals.account") && !r.body.includes("requireAccount()"),
    ).map((r) => r.key);
    expect(offenders).toEqual([]);
  });

  it("the writes are strict-tiered; the read is not", () => {
    // Each write mints state and the voucher route spends a finite campaign
    // slot. The read runs on every SPA boot and would rate-limit the app's own
    // startup on a shared office IP if it were strict.
    expect(route("get /api/account").body).toContain("accountLimit");
    expect(route("get /api/account").body).not.toContain("strictLimit");
    for (const key of ACCOUNT_ROUTES.slice(1)) {
      expect(route(key).body, `${key} is not strictLimit`).toContain("strictLimit");
    }
  });
});

describe("linking a wallet demands both proofs", () => {
  it("runs the account gate AND the action-bound ownership check", () => {
    const body = route("post /api/account/wallets").body;
    expect(body).toContain("requireAccount()");
    expect(body).toContain("requireMember");
    expect(body).toContain("linkAccountWallet(");
    // The signature half lives in server/accounts.ts, one call site, bound to
    // this action alone.
    expect(SERVER_SRC).not.toContain('verifyWalletOwnership(req.body, "account-wallet-link"');
  });

  it("takes the account id from the verified identity, never from the body", () => {
    const body = route("post /api/account/wallets").body;
    expect(body).toContain("account.userId");
    expect(body).not.toMatch(/req\.body[^\n]*userId/);
  });

  it("the unlink route can only ever name the caller's own account", () => {
    const body = route("delete /api/account/wallets/:wallet").body;
    expect(body).toContain("unlinkWallet(account.userId");
  });

  it("account-wallet-link is a first-class action with its own URN and sentence", () => {
    expect(OWNERSHIP_ACTIONS).toContain("account-wallet-link");
    expect(actionResource("account-wallet-link")).toBe("urn:panik:action:account-wallet-link");
    // The statement is what the user reads in the wallet popup, so it has to
    // describe the actual power granted: attaching an address to an account.
    expect(ACTION_STATEMENT["account-wallet-link"]).toMatch(/account/i);
    // Every action's sentence stays distinct, or the action binding is theatre.
    const sentences = OWNERSHIP_ACTIONS.map((a) => ACTION_STATEMENT[a]);
    expect(new Set(sentences).size).toBe(OWNERSHIP_ACTIONS.length);
  });
});

describe("the admin roster", () => {
  it("sits behind the same admin gate as the rest of /api/admin", () => {
    const body = route("get /api/admin/users").body;
    expect(body).toContain("adminBearerGate");
    expect(body).toContain("adminLimit");
    expect(SERVER_SRC).toMatch(/async function adminUsers[\s\S]*?requireAdmin\(req, res\)/);
  });

  it("has no unauthenticated twin", () => {
    const listers = ALL.filter((r) => r.body.includes("listAccounts(")).map((r) => r.key);
    expect(listers).toEqual([]); // it is reached through the adminUsers handler only
    expect(SERVER_SRC.match(/listAccounts\(/g)).toHaveLength(1);
  });
});

describe("the voucher route", () => {
  it("redeems with the account's verified email, not a body field", () => {
    const body = route("post /api/account/voucher").body;
    expect(body).toContain("email: account.email");
    expect(body).not.toMatch(/email:\s*(req\.)?body/);
  });

  it("is reachable by a NON-member - it is how you stop being one", () => {
    expect(route("post /api/account/voucher").body).not.toContain("requireMember");
  });
});
