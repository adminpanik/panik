/**
 * Voucher redemption and wallet linking.
 *
 * REDEMPTION runs through the REAL panik-try validation. The campaign store is
 * faked at the HTTP boundary, but the code it calls is the same
 * `redeem_campaign_code` / `open_trial` pair the /try flow uses, so this is a
 * test of the account layer on top of that machinery, not of a parallel scheme.
 * The outcomes that matter are the ones a user hits: a good code, a code that
 * does not exist, and a code somebody already used up.
 *
 * LINKING is the one place in the app where two credentials are required. The
 * tests below hold each half constant and remove the other, because either
 * omission is an account takeover in a different direction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { linkAccountWallet, normalizeVoucherCode, redeemVoucher, VOUCHER_REFUSALS } from "./accounts";
import { normalizeVoucherCode as browserNormalizeVoucherCode } from "../src/panik-core/lib/account";
import { AccountConflict, type AccountStore, type Membership } from "./accountStore";
import type { CampaignStore, OpenResult, RedeemResult } from "./campaignStore";
import type { IssuedNonce, NonceStore } from "./nonceStore";
import { buildOwnershipMessage, type OwnershipAction } from "./siweProof";

const USER = "3ad213e2-d05d-404f-a0ef-ad249256d493";
const EMAIL = "beta@example.com";
const CODE = "PANIK-TRY-8X2QRT4Z";
const DOMAIN = "panik.fi";
const URI = "https://panik.fi";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const NOW = 1_800_000_000_000;

function membership(over: Partial<Membership> = {}): Membership {
  return {
    id: "m1",
    status: "trial",
    source: "voucher",
    voucherCode: CODE,
    startedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    ...over,
  };
}

/** In-memory stand-in for the campaign RPCs, with the same outcome vocabulary. */
class FakeCampaigns {
  redeemResult: RedeemResult = { outcome: "success", token: "PANIK-8X2QRT" };
  openResult: OpenResult = { outcome: "active", expiresAt: new Date(NOW + 86_400_000).toISOString() };
  redeemCalls: Array<{ code: string; email?: string | null }> = [];
  openCalls: string[] = [];

  async redeem(code: string, email?: string | null): Promise<RedeemResult> {
    this.redeemCalls.push({ code, email });
    return this.redeemResult;
  }

  async openTrial(token: string): Promise<OpenResult> {
    this.openCalls.push(token);
    return this.openResult;
  }
}

const asCampaigns = (c: FakeCampaigns) => c as unknown as CampaignStore;

function fakeStore(over: Partial<AccountStore> = {}): AccountStore {
  return {
    liveMembership: vi.fn(async () => null),
    createMembership: vi.fn(async () => membership()),
    linkWallet: vi.fn(async (_u: string, wallet: string) => ({
      wallet,
      verifiedAt: "t0",
      createdAt: "t0",
    })),
    ...over,
  } as unknown as AccountStore;
}

// ── voucher redemption ──────────────────────────────────────────────────────

describe("redeemVoucher", () => {
  it("redeems a campaign code, starts the clock, and mints the membership", async () => {
    const campaigns = new FakeCampaigns();
    const store = fakeStore();
    const result = await redeemVoucher(
      { store, campaigns: asCampaigns(campaigns), ip: "1.2.3.4", userAgent: "curl" },
      { userId: USER, email: EMAIL, code: CODE },
    );

    expect(result.outcome).toBe("success");
    expect(result.membership).toMatchObject({ status: "trial", source: "voucher" });
    // The redeemer's address is the VERIFIED one from the bearer, never a body
    // field, so the campaign roster gains a real identity.
    expect(campaigns.redeemCalls).toEqual([{ code: CODE, email: EMAIL }]);
    // Redeeming on an account IS the first open: the per-user trial clock has
    // to start here, or the grant has no expiry until the user follows a link
    // they will never be shown.
    expect(campaigns.openCalls).toEqual(["PANIK-8X2QRT"]);
    expect(store.createMembership).toHaveBeenCalledWith({
      userId: USER,
      status: "trial",
      source: "voucher",
      voucherCode: CODE,
      expiresAt: campaigns.openResult.expiresAt,
    });
  });

  it("normalizes case and whitespace the way the SQL does", async () => {
    const campaigns = new FakeCampaigns();
    await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: `  ${CODE.toLowerCase()} ` },
    );
    expect(campaigns.redeemCalls[0]!.code).toBe(CODE);
  });

  it("refuses an unrecognised code without spending a redemption", async () => {
    const campaigns = new FakeCampaigns();
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: "hunter2" },
    );
    expect(result.outcome).toBe("invalid");
    expect(campaigns.redeemCalls).toEqual([]);
  });

  it("logs a rejected code's shape (length + prefix), never the code itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const campaigns = new FakeCampaigns();
    const secret = "hunter2-not-a-real-voucher";
    const normalized = secret.toUpperCase(); // what normalizeVoucherCode produces here

    await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: secret },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0]!.join(" ");
    expect(logged).not.toContain(normalized);
    expect(logged).toContain(`len=${normalized.length}`);
    expect(logged).toContain(`prefix=${normalized.slice(0, 6)}`);
    warn.mockRestore();
  });

  it("reports a code the campaign says is used up", async () => {
    const campaigns = new FakeCampaigns();
    campaigns.redeemResult = { outcome: "exhausted" };
    const store = fakeStore();
    const result = await redeemVoucher(
      { store, campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: CODE },
    );
    expect(result.outcome).toBe("exhausted");
    expect(store.createMembership).not.toHaveBeenCalled();
    expect(VOUCHER_REFUSALS.exhausted).toMatch(/used/i);
  });

  it("reports a code past its claim window", async () => {
    const campaigns = new FakeCampaigns();
    campaigns.redeemResult = { outcome: "expired" };
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: CODE },
    );
    expect(result.outcome).toBe("expired");
  });

  it("collapses not_found and disabled into one answer", async () => {
    // Telling a stranger that a code exists but is switched off is a hint they
    // can use to enumerate the print run.
    for (const outcome of ["not_found", "disabled"] as const) {
      const campaigns = new FakeCampaigns();
      campaigns.redeemResult = { outcome };
      const result = await redeemVoucher(
        { store: fakeStore(), campaigns: asCampaigns(campaigns) },
        { userId: USER, email: EMAIL, code: CODE },
      );
      expect(result.outcome).toBe("invalid");
    }
  });

  it("does not burn a second slot for an account that is already in", async () => {
    const campaigns = new FakeCampaigns();
    const live = membership();
    const result = await redeemVoucher(
      { store: fakeStore({ liveMembership: vi.fn(async () => live) }), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: CODE },
    );
    expect(result).toEqual({ outcome: "already_member", membership: live });
    expect(campaigns.redeemCalls).toEqual([]);
  });

  it("refuses a per-user trial link by name rather than honouring it", async () => {
    // open_trial is not single-use, so a forwarded /app?trial= token would mint
    // a membership on every account it reached.
    const campaigns = new FakeCampaigns();
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: "PANIK-8X2QRT" },
    );
    expect(result.outcome).toBe("trial_link");
    expect(campaigns.redeemCalls).toEqual([]);
    expect(VOUCHER_REFUSALS.trial_link).toMatch(/card/);
  });

  it("survives losing the insert race with the account's own other tab", async () => {
    const live = membership();
    const liveMembership = vi
      .fn<() => Promise<Membership | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(live);
    const result = await redeemVoucher(
      {
        store: fakeStore({
          liveMembership: liveMembership as unknown as AccountStore["liveMembership"],
          createMembership: vi.fn(async () => {
            throw new AccountConflict("dupe", "membership-exists");
          }),
        }),
        campaigns: asCampaigns(new FakeCampaigns()),
      },
      { userId: USER, email: EMAIL, code: CODE },
    );
    expect(result).toEqual({ outcome: "already_member", membership: live });
  });

  it("keeps the membership when only the clock start fails", async () => {
    // The campaign slot is already spent; refusing would leave the user with
    // neither the slot nor the membership.
    const campaigns = new FakeCampaigns();
    campaigns.openTrial = async () => {
      throw new Error("PostgREST unreachable");
    };
    const store = fakeStore();
    const result = await redeemVoucher(
      { store, campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: CODE },
    );
    expect(result.outcome).toBe("success");
    expect(store.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: null }),
    );
  });
});

// ── wallet linking ──────────────────────────────────────────────────────────

/** In-memory nonce store with the same single-use contract as the real one. */
class FakeNonceStore implements NonceStore {
  private live = new Map<string, number>();
  private counter = 0;

  async issue(): Promise<IssuedNonce> {
    const nonce = `nonce${String(this.counter++).padStart(20, "0")}abcdef`;
    this.live.set(nonce, Date.now() + 5 * 60_000);
    return { nonce, expiresAt: Date.now() + 5 * 60_000 };
  }

  async consume(nonce: string): Promise<boolean> {
    const at = this.live.get(nonce);
    if (at === undefined) return false;
    this.live.delete(nonce);
    return at > Date.now();
  }
}

let nonces: FakeNonceStore;

beforeEach(() => {
  vi.stubEnv("SIWE_ALLOWED_DOMAINS", DOMAIN);
  vi.stubEnv("NODE_ENV", "test");
  nonces = new FakeNonceStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A well-formed ownership proof for `action`, consuming a fresh nonce. */
async function makeProof(action: OwnershipAction = "account-wallet-link") {
  const nonce = (await nonces.issue()).nonce;
  const message = buildOwnershipMessage({
    address: alice.address,
    domain: DOMAIN,
    uri: URI,
    nonce,
    action,
  });
  return { message, signature: await alice.signMessage({ message }) };
}

describe("linkAccountWallet", () => {
  it("links the wallet the signature proves, not one the body names", async () => {
    const store = fakeStore();
    const body = { ...(await makeProof()), wallet: "0xdead" + "0".repeat(36) };
    const result = await linkAccountWallet({ store, nonces }, USER, body);
    expect(result.outcome).toBe("linked");
    expect(result.wallet!.wallet).toBe(alice.address.toLowerCase());
    expect(store.linkWallet).toHaveBeenCalledWith(USER, alice.address.toLowerCase());
  });

  it("refuses a request with an account bearer but NO signature", async () => {
    // The bearer half alone. Without the other half, any signed-in account
    // could claim a stranger's address and inherit its data in PR 4.
    const store = fakeStore();
    const result = await linkAccountWallet({ store, nonces }, USER, { wallet: alice.address });
    expect(result.outcome).toBe("bad_proof");
    expect(result.status).toBe(401);
    expect(store.linkWallet).not.toHaveBeenCalled();
  });

  it("refuses a signature minted for a DIFFERENT action", async () => {
    // The signature half, but harvested from another flow. A proof produced to
    // "register this wallet for monitoring" must not attach it to an account.
    const store = fakeStore();
    const result = await linkAccountWallet({ store, nonces }, USER, await makeProof("wallet-register"));
    expect(result.outcome).toBe("bad_proof");
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/different action/);
    expect(store.linkWallet).not.toHaveBeenCalled();
  });

  it("refuses a replay of a proof that already linked once", async () => {
    const store = fakeStore();
    const proof = await makeProof();
    expect((await linkAccountWallet({ store, nonces }, USER, proof)).outcome).toBe("linked");
    const replay = await linkAccountWallet({ store, nonces }, "someone-else", proof);
    expect(replay.outcome).toBe("bad_proof");
    expect(replay.status).toBe(401);
  });

  it("says the wallet is taken without saying by whom", async () => {
    const store = fakeStore({
      linkWallet: vi.fn(async () => {
        throw new AccountConflict("taken", "wallet-taken");
      }),
    });
    const result = await linkAccountWallet({ store, nonces }, USER, await makeProof());
    expect(result.outcome).toBe("wallet_taken");
    expect(result.status).toBe(409);
    expect(result.error).not.toMatch(/@|user|account [0-9a-f]{8}/i);
  });
});

// ── the shape a code is compared in ─────────────────────────────────────────

/**
 * Every string the two normalizations have to answer the same way: the incident
 * itself, each dash variant on its own, the whitespace cases, and two codes that
 * are simply wrong.
 */
const NORMALIZATION_CASES = [
  "PANIK-TRY-45QUHHUP",
  "panik-try-45quhhup",
  "PANIK\u2013TRY\u201345QUHHUP",
  "PANIK\u2014TRY\u201445QUHHUP",
  "PANIK\u00ADTRY\u00AD45QUHHUP",
  "PANIK-\u00ADTRY-\u00AD45QUHHUP",
  "PANIK-\u200BTRY-\u2060\uFEFF45QUHHUP",
  "PANIK\uFF0DTRY\uFF0D45QUHHUP",
  "  PANIK-TRY- 45QU HHUP\u000A",
  "PANIK-TRY-\u00A045QUHHUP",
  "PANIK-TRY-45\u200BQUHHUP",
  "hunter1",
  "",
];

describe("normalizeVoucherCode", () => {
  /**
   * The server's copy and the browser's copy are one function written twice.
   * They cannot be one function imported twice: src/panik-core/lib/account.ts
   * pulls in lib/goTrue.ts, which reads `import.meta.env` at module scope, and
   * this side runs under plain Node where that is undefined and the import
   * throws on load. This test is what stands in for the import, so a change to
   * one copy that is not made to the other fails here rather than in a user's
   * hands six weeks later.
   */
  it("agrees with its browser twin, character for character", () => {
    for (const raw of NORMALIZATION_CASES) {
      expect(normalizeVoucherCode(raw)).toBe(browserNormalizeVoucherCode(raw));
    }
  });

  it("is what turns the 2026-08-31 refusal back into a redemption", () => {
    expect(normalizeVoucherCode("PANIK\u2013TRY\u201345QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
  });
});

describe("redeemVoucher, on a code a phone rewrote", () => {
  it("redeems it, and sends SQL the clean string", async () => {
    const campaigns = new FakeCampaigns();
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: " panik\u2013try\u20138X2Q RT4Z " },
    );
    expect(result.outcome).toBe("success");
    expect(campaigns.redeemCalls).toEqual([{ code: CODE, email: EMAIL }]);
  });

  it("applies the same rule on the server, for a browser holding an old bundle", () => {
    // The browser normalises before it posts, but the browser is not a trust
    // boundary and a phone can be running yesterday's JavaScript for weeks.
    expect(normalizeVoucherCode("PANIK\u2013TRY\u20138X2QRT4Z")).toBe(CODE);
  });

  it("redeems one carrying a soft hyphen beside a real hyphen", async () => {
    // The soft hyphen is DELETED, not folded. Folding it produced
    // PANIK--TRY-8X2QRT4Z, which is the same unactionable refusal the en dash
    // produced, with one invisible character traded for another.
    const campaigns = new FakeCampaigns();
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: "PANIK-\u00ADTRY-\u00AD8X2QRT4Z" },
    );
    expect(result.outcome).toBe("success");
    expect(campaigns.redeemCalls).toEqual([{ code: CODE, email: EMAIL }]);
  });

  it("still refuses a code that is wrong rather than merely mistyped", async () => {
    const campaigns = new FakeCampaigns();
    const result = await redeemVoucher(
      { store: fakeStore(), campaigns: asCampaigns(campaigns) },
      { userId: USER, email: EMAIL, code: "PANIK\u2013TRY\u2013HUNTER1" },
    );
    // "1" is not in the printed alphabet, so this is a code nobody holds. It
    // must stay invalid: normalization repairs typography, not content.
    expect(result.outcome).toBe("invalid");
    expect(campaigns.redeemCalls).toEqual([]);
  });
});

// ── one account, one slot ───────────────────────────────────────────────────

/**
 * `redeem_campaign_code` as the 2026-08-31 migration defines it, with the
 * interleaving left visible.
 *
 * The `await` between reading the grants and writing one is the window the
 * incident went through: on that day two submits from one account sixteen
 * seconds apart both read "no grant for this address", both incremented
 * redemption_count and both minted a row. `serialised` decides whether the
 * critical section is held the way `pg_advisory_xact_lock(campaign, email)`
 * holds it in SQL, so the two arrangements can be compared in one test file.
 */
class CampaignRpc {
  maxRedemptions = 50;
  redemptionCount = 0;
  /** lower(email) -> access_token, i.e. trial_grants keyed by the new index. */
  readonly grants = new Map<string, string>();
  private minted = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly serialised = true) {}

  redeem(_code: string, email?: string | null): Promise<RedeemResult> {
    const run = () => this.attempt(email);
    if (!this.serialised) return run();
    const next = this.tail.then(run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async attempt(email?: string | null): Promise<RedeemResult> {
    const key = (email ?? "").trim().toLowerCase();
    const held = key === "" ? undefined : this.grants.get(key);
    await Promise.resolve();
    if (held !== undefined) return { outcome: "success", token: held };
    if (this.redemptionCount >= this.maxRedemptions) return { outcome: "exhausted" };
    this.redemptionCount += 1;
    const token = `PANIK-8X2QR${this.minted++}`;
    if (key !== "") this.grants.set(key, token);
    return { outcome: "success", token };
  }

  async openTrial(): Promise<OpenResult> {
    return { outcome: "active", expiresAt: new Date(NOW + 86_400_000).toISOString() };
  }
}

/** CampaignRpc wears the CampaignStore shape; only redeem/openTrial are called. */
const asRpc = (c: CampaignRpc) => c as unknown as CampaignStore;

/** An account store with the memberships unique index actually enforced. */
function soleMembershipStore(): AccountStore {
  let live: Membership | null = null;
  return {
    liveMembership: vi.fn(async () => live),
    createMembership: vi.fn(async () => {
      if (live) throw new AccountConflict("dupe", "membership-exists");
      live = membership();
      return live;
    }),
  } as unknown as AccountStore;
}

describe("redeemVoucher, submitted twice by one account", () => {
  it("spends one campaign slot and mints one grant", async () => {
    const campaigns = new CampaignRpc();
    const deps = { store: soleMembershipStore(), campaigns: asRpc(campaigns) };
    const results = await Promise.all([
      redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE }),
      redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE }),
    ]);
    expect(campaigns.redemptionCount).toBe(1);
    expect(campaigns.grants.size).toBe(1);
    // Both callers are told they are in, which is true of both of them. The one
    // that lost the memberships race reads back the row the winner wrote rather
    // than being handed a 409 it cannot act on.
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_member", "success"]);
  });

  it("is idempotent on a later submit too, not only a concurrent one", async () => {
    const campaigns = new CampaignRpc();
    const deps = { store: soleMembershipStore(), campaigns: asRpc(campaigns) };
    const first = await redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE });
    const second = await redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE });
    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("already_member");
    expect(campaigns.redemptionCount).toBe(1);
  });

  it("reproduces the incident once the critical section is not held", async () => {
    // Not a test of production code: it is what makes the two tests above mean
    // something. The fake has a real window between its read and its write, so
    // an unserialised pair of submits burns two slots exactly as 45QUHHUP did.
    // A pre-check SELECT with no lock is that arrangement, which is why the
    // migration takes the lock instead of only adding the check.
    const campaigns = new CampaignRpc(false);
    const deps = { store: soleMembershipStore(), campaigns: asRpc(campaigns) };
    await Promise.all([
      redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE }),
      redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE }),
    ]);
    expect(campaigns.redemptionCount).toBe(2);
    expect(campaigns.grants.size).toBe(1);
  });

  it("does not treat two different accounts as one", async () => {
    const campaigns = new CampaignRpc();
    const results = await Promise.all([
      redeemVoucher(
        { store: soleMembershipStore(), campaigns: asRpc(campaigns) },
        { userId: USER, email: EMAIL, code: CODE },
      ),
      redeemVoucher(
        { store: soleMembershipStore(), campaigns: asRpc(campaigns) },
        { userId: "6f1c0d3a-0d7e-4a1e-9f2a-2c4b8d5e7a90", email: "other@example.com", code: CODE },
      ),
    ]);
    expect(results.every((r) => r.outcome === "success")).toBe(true);
    expect(campaigns.redemptionCount).toBe(2);
    expect(campaigns.grants.size).toBe(2);
  });

  it("keys on the address case-insensitively, the way lower(email) does", async () => {
    const campaigns = new CampaignRpc();
    const deps = { store: fakeStore(), campaigns: asRpc(campaigns) };
    await redeemVoucher(deps, { userId: USER, email: EMAIL, code: CODE });
    await redeemVoucher(deps, { userId: USER, email: EMAIL.toUpperCase(), code: CODE });
    expect(campaigns.redemptionCount).toBe(1);
  });
});
