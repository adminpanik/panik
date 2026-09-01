/**
 * Create-campaign idempotency. Until this fix, a double click on "New voucher
 * code" burned two campaign codes: `busy` React state does not read back as
 * true within the same frame, and `CampaignStore.createCampaign` mints a
 * fresh code on every call with no dedupe of its own. `createCampaignIdempotent`
 * is the one place both transports (scripts/api-server.ts and
 * api/admin/campaigns.ts) call, so a replayed `idempotencyKey` short-circuits
 * to the campaign that key already minted instead of validating and minting
 * again.
 *
 * `checkAdminKey` and `AdminAuthGate` are covered in adminAuth.test.ts;
 * `buildCreateInput`'s own validation rules are exercised indirectly here
 * through `createCampaignIdempotent`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLEAR_USE_REFUSAL,
  clearRedemptionUse,
  createCampaignIdempotent,
  type ClearUseDeps,
  type RawCreateBody,
} from "./adminCampaigns";
import {
  CampaignStore,
  type Campaign,
  type CreateCampaignInput,
  type TrialGrantRow,
} from "./campaignStore";

const VALID_BODY: RawCreateBody = { trialDays: 3, maxRedemptions: 20 };

function fakeCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "campaign-1",
    campaign_code: "PANIK-TRY-ABCDEFGH",
    label: null,
    max_redemptions: 20,
    redemption_count: 0,
    trial_duration_hours: 72,
    claim_window_expires_at: null,
    is_active: true,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    ...over,
  };
}

describe("createCampaignIdempotent", () => {
  it("mints once and replays the same campaign for a repeated key", async () => {
    const minted = fakeCampaign();
    const createCampaign = vi.fn(async (_input: CreateCampaignInput) => minted);
    const key = `replay-key-${Math.random()}`;

    const first = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });
    const second = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });
    const third = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });

    // Exactly one mint - a double (or triple) submit with the same key never
    // spends a second campaign code.
    expect(createCampaign).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: 201, campaign: minted });
    expect(second).toEqual({ status: 200, campaign: minted });
    expect(third).toEqual({ status: 200, campaign: minted });
  });

  it("mints independently for two different keys", async () => {
    const a = fakeCampaign({ id: "a", campaign_code: "PANIK-TRY-AAAAAAAA" });
    const b = fakeCampaign({ id: "b", campaign_code: "PANIK-TRY-BBBBBBBB" });
    const createCampaign = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const suffix = Math.random();

    const first = await createCampaignIdempotent(
      { ...VALID_BODY, idempotencyKey: `key-a-${suffix}` },
      { createCampaign },
    );
    const second = await createCampaignIdempotent(
      { ...VALID_BODY, idempotencyKey: `key-b-${suffix}` },
      { createCampaign },
    );

    expect(createCampaign).toHaveBeenCalledTimes(2);
    expect(first.campaign).toEqual(a);
    expect(second.campaign).toEqual(b);
  });

  it("mints again for two calls with no key at all (nothing to be idempotent about)", async () => {
    const createCampaign = vi.fn().mockResolvedValue(fakeCampaign());
    await createCampaignIdempotent(VALID_BODY, { createCampaign });
    await createCampaignIdempotent(VALID_BODY, { createCampaign });
    expect(createCampaign).toHaveBeenCalledTimes(2);
  });

  it("still validates the body and never mints on a validation failure", async () => {
    const createCampaign = vi.fn();
    const key = `bad-input-${Math.random()}`;
    const result = await createCampaignIdempotent(
      { trialDays: 0, maxRedemptions: 20, idempotencyKey: key },
      { createCampaign },
    );
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/trialDays/);
    expect(createCampaign).not.toHaveBeenCalled();
  });
});

// ── clearing one person's use of a code ─────────────────────────────────────

/**
 * The operator's way to give a spent voucher back. One trial code is good for
 * one account (20260901000001_one_code_one_account.sql), and deleting that
 * address's grant row is the ONLY thing that undoes a use: it frees the
 * (campaign, email) slot the unique index holds, and the next redemption falls
 * through to the ordinary mint path.
 *
 * Three levels, for three different kinds of mistake:
 *
 *   clearRedemptionUse   against fake deps - the four answers an operator can
 *                        get, and that the audit line is written on the success
 *                        path and only there.
 *   CampaignStore        against a fake PostgREST - that the address is matched
 *                        EXACTLY, and that the delete is targeted by grant id.
 *   the route table      that both transports gate the new POST the way its
 *                        siblings are gated. It hands a voucher back, so an
 *                        unauthenticated twin of it is the failure worth a test
 *                        that no mock can satisfy.
 */

const CODE = "PANIK-TRY-ABCDEFGH";
const REDEEMER = "tester@panik.fi";
const CLEARED_AT = 1_800_000_000_000;

function grantRow(over: Partial<TrialGrantRow> = {}): TrialGrantRow {
  return {
    id: "g1",
    email: REDEEMER,
    first_opened_at: "2026-08-28T10:00:00.000Z",
    expires_at: "2026-08-31T10:00:00.000Z",
    created_at: "2026-08-28T09:00:00.000Z",
    ...over,
  };
}

/** Deps that find the grant and delete it. Overridable. */
function clearDeps(over: Partial<ClearUseDeps> = {}): ClearUseDeps {
  return {
    findGrant: vi.fn(async () => grantRow()),
    deleteGrant: vi.fn(async () => true),
    ...over,
  };
}

describe("clearRedemptionUse", () => {
  it("deletes that address's grant and reports what it cleared", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = clearDeps();

    const result = await clearRedemptionUse(deps, {
      // Pasted out of a support thread, case and spaces and all.
      code: `  ${CODE.toLowerCase()} `,
      email: `  ${REDEEMER.toUpperCase()} `,
      actor: "ops@panik.fi",
      now: CLEARED_AT,
    });

    expect(result.outcome).toBe("cleared");
    if (result.outcome !== "cleared") throw new Error("unreachable");
    expect(result.cleared.code).toBe(CODE);
    expect(result.cleared.email).toBe(REDEEMER);
    expect(result.cleared.grantId).toBe("g1");
    expect(result.cleared.clearedAt).toBe(new Date(CLEARED_AT).toISOString());
    // Normalized before either half reaches the store.
    expect(deps.findGrant).toHaveBeenCalledWith(CODE, REDEEMER);
    expect(deps.deleteGrant).toHaveBeenCalledWith("g1");

    // One audit line, naming who did it to whom, carrying no credential.
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain(REDEEMER);
    expect(line).toContain(CODE);
    expect(line).toContain("ops@panik.fi");
    log.mockRestore();
  });

  it("names the shared-secret caller rather than inventing an operator", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await clearRedemptionUse(clearDeps(), { code: CODE, email: REDEEMER, now: CLEARED_AT });
    expect(log.mock.calls[0]![0] as string).toContain("shared-secret");
    log.mockRestore();
  });

  it("touches nothing but the grant: no count, no attempt log", () => {
    // Structural, and deliberately so. `redemption_count` is a running total
    // and never a live population, and the attempt log is the evidence the
    // 2026-08-31 incident was reconstructed from. Neither is reachable from
    // here, so neither can be edited by a later change to this decision.
    expect(Object.keys(clearDeps()).sort()).toEqual(["deleteGrant", "findGrant"]);
  });

  it("refuses a missing code or address before it looks anything up", async () => {
    for (const input of [
      { code: "", email: REDEEMER, expected: "missing_code" },
      { code: "   ", email: REDEEMER, expected: "missing_code" },
      { code: CODE, email: "", expected: "missing_email" },
      { code: CODE, email: null, expected: "missing_email" },
    ] as const) {
      const deps = clearDeps();
      const result = await clearRedemptionUse(deps, { code: input.code, email: input.email });
      expect(result.outcome).toBe(input.expected);
      expect(deps.findGrant).not.toHaveBeenCalled();
    }
  });

  it("answers no_redemption for an address that never redeemed this code", async () => {
    const deps = clearDeps({ findGrant: vi.fn(async () => null) });
    const result = await clearRedemptionUse(deps, { code: CODE, email: REDEEMER });
    expect(result.outcome).toBe("no_redemption");
    expect(deps.deleteGrant).not.toHaveBeenCalled();
  });

  it("answers no_redemption when another operator won the race to the delete", async () => {
    // The database decides, not a read this code did a moment earlier.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = clearDeps({ deleteGrant: vi.fn(async () => false) });
    expect((await clearRedemptionUse(deps, { code: CODE, email: REDEEMER })).outcome).toBe(
      "no_redemption",
    );
    // No audit line for something that did not happen.
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("has a status and a sentence for every refusal", () => {
    expect(CLEAR_USE_REFUSAL.missing_code.status).toBe(400);
    expect(CLEAR_USE_REFUSAL.missing_email.status).toBe(400);
    expect(CLEAR_USE_REFUSAL.no_redemption.status).toBe(404);
    expect(CLEAR_USE_REFUSAL.missing_code.error).not.toBe(CLEAR_USE_REFUSAL.missing_email.error);
    for (const refusal of Object.values(CLEAR_USE_REFUSAL)) {
      expect(refusal.error).not.toContain(String.fromCharCode(0x2014));
      expect(refusal.error).not.toMatch(/grant|_/);
    }
  });
});

/** Route a request by "METHOD url" to a canned reply, as adminTrials.test.ts does. */
function routedFetch(routes: Array<[RegExp, { status?: number; body?: unknown }]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    for (const [pattern, reply] of routes) {
      if (!pattern.test(`${method} ${url}`)) continue;
      const { status = 200, body = [] } = reply;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }
    throw new Error(`unrouted request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", impl as unknown as typeof globalThis.fetch);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CampaignStore.findGrant", () => {
  const store = () => new CampaignStore("https://proj.supabase.co", "sk_test");

  it("filters by campaign in SQL and matches the address exactly", async () => {
    const calls = routedFetch([
      [
        /^GET .*\/trial_grants/,
        { body: [{ ...grantRow({ id: "other", email: "someone@else.test" }) }, grantRow()] },
      ],
    ]);

    const hit = await store().findGrant(CODE, `  ${REDEEMER.toUpperCase()} `);

    expect(hit?.id).toBe("g1");
    expect(calls[0]!.url).toContain(`product_campaigns.campaign_code=eq.${encodeURIComponent(CODE)}`);
  });

  it("does not let an underscore in an address match somebody else's", async () => {
    // The reason the match is not a PostgREST `ilike`: `_` is a single-character
    // wildcard there, so first_last@example.com would resolve to firstXlast@.
    routedFetch([[/^GET .*\/trial_grants/, { body: [grantRow({ email: "firstXlast@example.com" })] }]]);
    expect(await store().findGrant(CODE, "first_last@example.com")).toBeNull();
  });

  it("is null for a blank address rather than matching the first row", async () => {
    expect(await store().findGrant(CODE, "   ")).toBeNull();
  });

  it("throws rather than reporting a phantom miss on an upstream failure", async () => {
    routedFetch([[/^GET .*\/trial_grants/, { status: 503, body: { message: "boom" } }]]);
    await expect(store().findGrant(CODE, REDEEMER)).rejects.toThrow("HTTP 503");
  });
});

describe("CampaignStore.deleteGrant", () => {
  const store = () => new CampaignStore("https://proj.supabase.co", "sk_test");

  it("deletes exactly one row, by id", async () => {
    const calls = routedFetch([[/^DELETE .*\/trial_grants/, { body: [{ id: "g1" }] }]]);
    expect(await store().deleteGrant("g1")).toBe(true);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("id=eq.g1");
    // Nothing else is touched: no campaign row, no attempt row.
    expect(calls).toHaveLength(1);
  });

  it("is false when the row was already gone", async () => {
    routedFetch([[/^DELETE .*\/trial_grants/, { body: [] }]]);
    expect(await store().deleteGrant("g1")).toBe(false);
  });
});

/**
 * The gate, on the route table that actually ships.
 *
 * Source-scanning for the reason server/adminTrials.test.ts gives: importing
 * scripts/api-server.ts calls app.listen and exits on missing env, and a
 * hand-built replica would only prove the replica safe.
 */
const SERVER_SRC = readFileSync(
  fileURLToPath(new URL("../scripts/api-server.ts", import.meta.url)),
  "utf8",
);
const API_MIRROR_SRC = readFileSync(
  fileURLToPath(new URL("../api/admin/redemptions.ts", import.meta.url)),
  "utf8",
);

describe("the clear-use route is admin-gated on both transports", () => {
  it("registers GET and POST behind adminBearerGate and adminLimit", () => {
    for (const method of ["get", "post"]) {
      expect(SERVER_SRC).toContain(
        `app.${method}("/api/admin/redemptions", adminLimit, adminBearerGate, adminRedemptions);`,
      );
    }
  });

  it("runs requireAdmin before it touches the store", () => {
    const handler = SERVER_SRC.slice(
      SERVER_SRC.indexOf("async function adminRedemptions("),
      SERVER_SRC.indexOf("async function adminSimulation("),
    );
    expect(handler.length).toBeGreaterThan(200);
    expect(handler.indexOf("requireAdmin(req, res)")).toBeGreaterThan(-1);
    expect(handler.indexOf("requireAdmin(req, res)")).toBeLessThan(
      handler.indexOf("CampaignStore.fromEnv()"),
    );
  });

  it("has no unauthenticated twin: the decision is reached through that handler only", () => {
    expect(SERVER_SRC.match(/clearRedemptionUse\(/g)).toHaveLength(1);
  });

  it("names the signed-in operator as the actor, never a body field", () => {
    expect(SERVER_SRC).toContain('actor: typeof res.locals.adminEmail === "string"');
    expect(SERVER_SRC).not.toMatch(/actor:\s*(req\.)?body/);
  });

  it("gates the serverless mirror the same way, before it reads the body", () => {
    expect(API_MIRROR_SRC).toContain("authorizeAdminRequest(req.headers)");
    expect(API_MIRROR_SRC.indexOf("authorizeAdminRequest(req.headers)")).toBeLessThan(
      API_MIRROR_SRC.indexOf("clearRedemptionUse("),
    );
    expect(API_MIRROR_SRC).not.toMatch(/actor:\s*(req\.)?body/);
  });
});
