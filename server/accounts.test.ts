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

import { linkAccountWallet, redeemVoucher, VOUCHER_REFUSALS } from "./accounts";
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
