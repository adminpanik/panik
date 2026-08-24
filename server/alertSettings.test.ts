/**
 * Alert settings: the auth boundary, the row, and the outcome counters.
 *
 * THE FIRST DESCRIBE IS THE POINT. Alert settings are per-wallet state, so a
 * write acts on a wallet: quiet hours, a mute and a digest all make a chat
 * quieter, and an unproven write would let anyone name a victim's address and
 * silence their liquidation warnings. That is a silent-failure attack - the
 * victim sees no error, no email and no missing button, just a chat that never
 * says anything again - so "rejected without a proof" and "rejected with
 * SOMEBODY ELSE'S action URN" are asserted here rather than assumed from
 * walletAuth's own suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_ALERT_SETTINGS } from "../packages/scoring/src/watch/alertSettings";
import type { IssuedNonce, NonceStore } from "./nonceStore";
import { buildOwnershipMessage, type OwnershipAction } from "./siweProof";
import { verifyWalletOwnership } from "./walletAuth";
import {
  decodeAlertSettings,
  loadAlertSettings,
  markDigestSent,
  saveAlertSettings,
  toWireSettings,
} from "./alertSettingsStore";

const DOMAIN = "panik.fi";
const URI = "https://panik.fi";
const alice = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

class FakeNonceStore implements NonceStore {
  private live = new Set<string>();
  private counter = 0;
  async issue(): Promise<IssuedNonce> {
    const nonce = `nonce${String(this.counter++).padStart(20, "0")}abcdef`;
    this.live.add(nonce);
    return { nonce, expiresAt: Date.now() + 300_000 };
  }
  async consume(nonce: string): Promise<boolean> {
    return this.live.delete(nonce);
  }
}

let store: FakeNonceStore;

beforeEach(() => {
  vi.stubEnv("SIWE_ALLOWED_DOMAINS", DOMAIN);
  vi.stubEnv("NODE_ENV", "test");
  store = new FakeNonceStore();
});

async function proofFor(action: OwnershipAction) {
  const { nonce } = await store.issue();
  const message = buildOwnershipMessage({ address: alice.address, domain: DOMAIN, uri: URI, nonce, action });
  return { message, signature: await alice.signMessage({ message }) };
}

describe("POST /api/alerts/settings — the ownership boundary", () => {
  it("rejects a body with no proof at all, however well-formed the settings are", async () => {
    const result = await verifyWalletOwnership(
      { wallet: alice.address, settings: { digest: "daily" } },
      "alert-settings",
      store,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a proof signed for ANOTHER endpoint's action", async () => {
    // The user consented to "update the list of wallets PANIK watches for you".
    // They did not consent to having their alerts muted.
    for (const action of ["watchlist-manage", "telegram-link", "wallet-register", "session-start"] as const) {
      const proof = await proofFor(action);
      const result = await verifyWalletOwnership(proof, "alert-settings", store);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/different action/);
    }
  });

  it("accepts the settings action's own proof, exactly once", async () => {
    const proof = await proofFor("alert-settings");
    const first = await verifyWalletOwnership(proof, "alert-settings", store);
    expect(first.ok).toBe(true);
    expect(first.wallet).toBe(alice.address.toLowerCase());
    // Single-use nonce: a captured settings proof cannot be replayed later.
    expect((await verifyWalletOwnership(proof, "alert-settings", store)).ok).toBe(false);
  });

  it("does not let a settings proof authorize a watchlist change", async () => {
    const proof = await proofFor("alert-settings");
    expect((await verifyWalletOwnership(proof, "watchlist-manage", store)).ok).toBe(false);
  });
});

interface Call {
  sql: string;
  values: unknown[];
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    query: (async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    }) as never,
  };
}

describe("alertSettingsStore", () => {
  it("treats a missing row as the shipped defaults", async () => {
    const db = fakeDb([]);
    const stored = await loadAlertSettings(db, alice.address.toUpperCase());
    expect(stored.settings).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(stored.lastDigestAt).toBeNull();
    // Normalised before it reaches SQL, like every other wallet-keyed write.
    expect(db.calls[0].values).toEqual([alice.address.toLowerCase()]);
  });

  it("treats a null column as the default for that field only", () => {
    const stored = decodeAlertSettings({
      min_borrow_usd: null,
      cooldown_minutes: 30,
      quiet_start_minute: null,
      quiet_end_minute: null,
      muted_protocols: ["morpho"],
      muted_positions: [],
      digest_frequency: "daily",
      last_digest_at: new Date("2026-08-23T09:00:00.000Z"),
    });
    expect(stored.settings.minBorrowUsd).toBe(DEFAULT_ALERT_SETTINGS.minBorrowUsd);
    expect(stored.settings.cooldownMs).toBe(30 * 60_000);
    expect(stored.settings.digest).toBe("daily");
    expect(stored.lastDigestAt).toBe("2026-08-23T09:00:00.000Z");
  });

  it("falls back rather than throwing on a value no code understands", () => {
    const stored = decodeAlertSettings({ digest_frequency: "fortnightly", min_borrow_usd: "not a number" });
    expect(stored.settings.digest).toBe(DEFAULT_ALERT_SETTINGS.digest);
    expect(stored.settings.minBorrowUsd).toBe(DEFAULT_ALERT_SETTINGS.minBorrowUsd);
  });

  it("writes minutes, not milliseconds, and never touches the digest clock", async () => {
    const db = fakeDb([]);
    await saveAlertSettings(db, alice.address, {
      ...DEFAULT_ALERT_SETTINGS,
      cooldownMs: 90 * 60_000,
      quietStartMinute: 1320,
      quietEndMinute: 420,
      digest: "hourly",
    });
    const call = db.calls[0];
    expect(call.values[2]).toBe(90);
    expect(call.values[3]).toBe(1320);
    expect(call.values[7]).toBe("hourly");
    // A user saving preferences must not be able to flush or postpone a batch.
    expect(call.sql).not.toContain("last_digest_at");
  });

  it("stamps the digest clock separately", async () => {
    const db = fakeDb([]);
    await markDigestSent(db, alice.address);
    expect(db.calls[0].sql).toContain("last_digest_at");
  });

  it("returns minutes on the wire", () => {
    const wire = toWireSettings({ settings: DEFAULT_ALERT_SETTINGS, lastDigestAt: null });
    expect(wire.cooldownMinutes).toBe(DEFAULT_ALERT_SETTINGS.cooldownMs / 60_000);
    expect(wire.digest).toBe("off");
  });
});

