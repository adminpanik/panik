/**
 * verifyWalletOwnership — the auth boundary that decides who may register a
 * wallet for monitoring and, more dangerously, who may mint a Telegram
 * deep-link code that redirects that wallet's liquidation alerts.
 *
 * The properties under test are the ones whose absence was exploitable:
 * single-use nonces (replay), domain binding (offline solicitation), action
 * binding (a registration signature doubling as an alert-redirect token), and
 * a garbage signature producing a 401 rather than a 500.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSignature, serializeSignature, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { IssuedNonce, NonceStore } from "./nonceStore";
import { buildOwnershipMessage, SIWE_CHAIN_ID, type OwnershipAction } from "./siweProof";
import { verifyWalletOwnership } from "./walletAuth";

const DOMAIN = "panik.fi";
const URI = "https://panik.fi";

const alice = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mallory = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

/** In-memory stand-in for the Supabase-backed store; same atomicity contract. */
class FakeNonceStore implements NonceStore {
  private live = new Map<string, number>();
  private counter = 0;
  /** Set by a test to simulate a transport failure. */
  throwOnConsume = false;

  async issue(): Promise<IssuedNonce> {
    const nonce = `nonce${String(this.counter++).padStart(20, "0")}abcdef`;
    const expiresAt = Date.now() + 5 * 60_000;
    this.live.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** Mint a nonce that is already past its TTL. */
  issueExpired(): string {
    const nonce = `expired${String(this.counter++).padStart(20, "0")}ab`;
    this.live.set(nonce, Date.now() - 1);
    return nonce;
  }

  async consume(nonce: string): Promise<boolean> {
    if (this.throwOnConsume) throw new Error("PostgREST unreachable");
    const expiresAt = this.live.get(nonce);
    if (expiresAt === undefined) return false;
    this.live.delete(nonce); // delete-on-read: exactly one caller wins
    if (expiresAt <= Date.now()) return false;
    return true;
  }

  has(nonce: string): boolean {
    return this.live.has(nonce);
  }
}

let store: FakeNonceStore;

beforeEach(() => {
  vi.stubEnv("SIWE_ALLOWED_DOMAINS", DOMAIN);
  vi.stubEnv("NODE_ENV", "test");
  store = new FakeNonceStore();
});

/** Sign a well-formed proof for `action`, consuming a fresh nonce. */
async function makeProof(
  opts: {
    action?: OwnershipAction;
    signer?: typeof alice;
    address?: string;
    nonce?: string;
    domain?: string;
    uri?: string;
  } = {},
): Promise<{ message: string; signature: string; nonce: string }> {
  const action = opts.action ?? "wallet-register";
  const signer = opts.signer ?? alice;
  const nonce = opts.nonce ?? (await store.issue()).nonce;
  const message = buildOwnershipMessage({
    address: opts.address ?? alice.address,
    domain: opts.domain ?? DOMAIN,
    uri: opts.uri ?? URI,
    nonce,
    action,
  });
  const signature = await signer.signMessage({ message });
  return { message, signature, nonce };
}

describe("verifyWalletOwnership", () => {
  it("accepts a well-formed, action-bound proof and returns the lowercase wallet", async () => {
    const { message, signature } = await makeProof();
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(true);
    expect(result.wallet).toBe(alice.address.toLowerCase());
  });

  it("consumes the nonce, so an identical replay is rejected", async () => {
    const proof = await makeProof();
    const first = await verifyWalletOwnership(proof, "wallet-register", store);
    expect(first.ok).toBe(true);

    // The exact body the reviewer replayed five times against the old code.
    const replay = await verifyWalletOwnership(proof, "wallet-register", store);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe(401);
    expect(replay.error).toMatch(/already used or expired/);
  });

  it("rejects a MALLEATED signature once the nonce is consumed", async () => {
    // s -> n-s with a flipped v is different bytes over the same message, which
    // is why a "seen signature" cache would not have closed the replay hole.
    const proof = await makeProof();
    expect((await verifyWalletOwnership(proof, "wallet-register", store)).ok).toBe(true);

    const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const parsed = parseSignature(proof.signature as `0x${string}`);
    const malleated = serializeSignature({
      r: parsed.r,
      s: toHex(SECP256K1_N - BigInt(parsed.s), { size: 32 }),
      v: parsed.v === 27n ? 28n : 27n,
    });
    expect(malleated).not.toBe(proof.signature); // byte-dedupe would be bypassed

    const result = await verifyWalletOwnership(
      { message: proof.message, signature: malleated },
      "wallet-register",
      store,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects an expired nonce", async () => {
    const nonce = store.issueExpired();
    const { message, signature } = await makeProof({ nonce });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/already used or expired/);
  });

  it("gives a future-dated Issued At no extra lifetime (the clock is not the credential)", async () => {
    // The old protocol used Math.abs(now - issuedAt) < 10min, so a proof minted
    // at now+10min stayed valid for ~20 minutes. Now `Issued At` is inert:
    // lifetime belongs entirely to the server's nonce row.
    const nonce = store.issueExpired();
    const message = createSiweMessage({
      address: alice.address,
      chainId: SIWE_CHAIN_ID,
      domain: DOMAIN,
      nonce,
      uri: URI,
      version: "1",
      statement: "Register this wallet for PANIK liquidation monitoring.",
      resources: ["urn:panik:action:wallet-register"],
      issuedAt: new Date(Date.now() + 60 * 60_000),
    });
    const signature = await alice.signMessage({ message });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a proof signed by a different wallet than the message names", async () => {
    const { message, signature } = await makeProof({ address: alice.address, signer: mallory });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/does not match wallet/);
  });

  it("rejects a proof collected on another domain", async () => {
    // The solicitation attack: a fake airdrop checker prompts personal_sign and
    // POSTs the result to us. The victim never visits PANIK.
    const { message, signature } = await makeProof({
      domain: "evil.example",
      uri: "https://evil.example",
    });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/different site/);
  });

  it("rejects a domain/uri mismatch inside one message", async () => {
    const { message, signature } = await makeProof({ uri: "https://evil.example" });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/different site/);
  });

  it("rejects a proof bound to a different action", async () => {
    // The onboarding signature must NOT authorize redirecting the user's alerts.
    const { message, signature } = await makeProof({ action: "wallet-register" });
    const result = await verifyWalletOwnership({ message, signature }, "telegram-link", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/different action/);
  });

  it("rejects a message whose statement lies about the action it grants", async () => {
    // Canonical re-derivation: a hand-built message with a truthful-looking
    // Resources line but a mismatched statement cannot pass.
    const nonce = (await store.issue()).nonce;
    const message = createSiweMessage({
      address: alice.address,
      chainId: SIWE_CHAIN_ID,
      domain: DOMAIN,
      nonce,
      uri: URI,
      version: "1",
      statement: "Register this wallet for PANIK liquidation monitoring.",
      resources: ["urn:panik:action:telegram-link"],
    });
    const signature = await alice.signMessage({ message });
    const result = await verifyWalletOwnership({ message, signature }, "telegram-link", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(store.has(nonce)).toBe(true); // and it did not burn the nonce
  });

  it("rejects a proof naming the wrong chain", async () => {
    const nonce = (await store.issue()).nonce;
    const message = createSiweMessage({
      address: alice.address,
      chainId: 1,
      domain: DOMAIN,
      nonce,
      uri: URI,
      version: "1",
      statement: "Register this wallet for PANIK liquidation monitoring.",
      resources: ["urn:panik:action:wallet-register"],
    });
    const signature = await alice.signMessage({ message });
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/chain 8453/);
  });

  it("answers 401, not 500, for malformed or garbage input", async () => {
    const { message } = await makeProof();
    const cases: unknown[] = [
      undefined,
      {},
      { message, signature: "not-hex" },
      { message, signature: "0xdeadbeef" }, // valid hex, wrong length
      { message: "hello world", signature: "0x" + "11".repeat(65) },
      { message, signature: "0x" + "00".repeat(65) },
      { message: 42, signature: "0x" + "11".repeat(65) },
    ];
    for (const body of cases) {
      const result = await verifyWalletOwnership(body, "wallet-register", store);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
    }
  });

  it("does not burn the nonce when the signature is bad", async () => {
    // Otherwise anyone could invalidate nonces with garbage (cheap DoS).
    const proof = await makeProof();
    const bad = { message: proof.message, signature: "0x" + "22".repeat(65) };
    expect((await verifyWalletOwnership(bad, "wallet-register", store)).ok).toBe(false);
    expect(store.has(proof.nonce)).toBe(true);
    expect((await verifyWalletOwnership(proof, "wallet-register", store)).ok).toBe(true);
  });

  it("lets exactly one of two concurrent verifications of the same proof win", async () => {
    const proof = await makeProof();
    const results = await Promise.all([
      verifyWalletOwnership(proof, "wallet-register", store),
      verifyWalletOwnership(proof, "wallet-register", store),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("denies (503) rather than accepting any domain when the allowlist is unset in production", async () => {
    vi.stubEnv("SIWE_ALLOWED_DOMAINS", "");
    vi.stubEnv("NODE_ENV", "production");
    const { message, signature } = await makeProof();
    const result = await verifyWalletOwnership({ message, signature }, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("reports 502 (not a pass) when the nonce store is unreachable", async () => {
    const proof = await makeProof();
    store.throwOnConsume = true;
    const result = await verifyWalletOwnership(proof, "wallet-register", store);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
  });
});
