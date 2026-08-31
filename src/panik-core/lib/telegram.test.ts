/**
 * The two findings fixed alongside the address-invisibles bug:
 *  - `registerWatchedWallet` used to discard the response body on a refusal
 *    and always show one generic sentence, even though the server sends a
 *    distinct one per reason (already-registered elsewhere, rate limited,
 *    etc). It now prefers `body.error`, the same `body?.error ?? fallback`
 *    pattern `lib/watchlist.ts`'s `saveWatchlist` already uses.
 *  - `useTelegramLink.connect` used to render `http_NNN: <body>` and raw wagmi
 *    messages straight onto the alerts card, against the file's own
 *    doctrine (`describeFailure`, above `registerWatchedWallet`) that no
 *    library or wire-format string reaches the screen.
 *
 * This repo has no jsdom/testing-library, so `useTelegramLink`'s hook
 * closures are not reachable from a test; `describeTelegramSignatureFailure`
 * is exported specifically so its half of the mapping can be tested directly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeTelegramSignatureFailure,
  isEvmAddress,
  OwnershipError,
  registerWatchedWallet,
  stripAddressInvisibles,
  type GetProof,
  type RiskProfile,
} from "./telegram";

const WALLET = "0x" + "a".repeat(40);
const PROFILE: RiskProfile = "moderate";
const PROOF = { message: "siwe", signature: "0xsig" };

/** One `fetch` reply. `body` is what `res.json()` resolves to. */
interface Reply {
  ok?: boolean;
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
}

function mockFetch(reply: Reply) {
  vi.stubGlobal("fetch", async () => ({
    ok: reply.ok ?? true,
    status: reply.status ?? (reply.ok === false ? 502 : 200),
    json: () => (reply.jsonThrows ? Promise.reject(new Error("bad json")) : Promise.resolve(reply.body)),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stripAddressInvisibles / isEvmAddress", () => {
  // Built with `String.fromCharCode` rather than `\u` escapes in this source
  // file: a zero-width space or BOM pasted straight into a test file is
  // invisible in a diff, which is exactly the failure mode this fix exists for.
  const ZWSP = String.fromCharCode(0x200b);
  const WORD_JOINER = String.fromCharCode(0x2060);
  const SOFT_HYPHEN = String.fromCharCode(0x00ad);
  const BOM = String.fromCharCode(0xfeff);

  it("strips zero-width, soft-hyphen, word-joiner and BOM characters, and ordinary whitespace", () => {
    expect(stripAddressInvisibles(ZWSP + WALLET)).toBe(WALLET);
    expect(stripAddressInvisibles(WALLET + ZWSP)).toBe(WALLET);
    expect(stripAddressInvisibles("0x" + "a".repeat(20) + SOFT_HYPHEN + "a".repeat(20))).toBe(WALLET);
    expect(stripAddressInvisibles(BOM + WALLET + BOM)).toBe(WALLET);
    expect(stripAddressInvisibles("0x" + "a".repeat(20) + WORD_JOINER + "a".repeat(20))).toBe(WALLET);
    expect(stripAddressInvisibles("  " + WALLET + "  ")).toBe(WALLET);
  });

  it("accepts an address carrying any of those characters, at the edges or in the middle", () => {
    expect(isEvmAddress(ZWSP + WALLET)).toBe(true);
    expect(isEvmAddress(BOM + WALLET)).toBe(true);
    expect(isEvmAddress("0x" + "a".repeat(20) + SOFT_HYPHEN + "a".repeat(20))).toBe(true);
  });

  it("still rejects garbage that merely looks like an address", () => {
    expect(isEvmAddress("0x" + "g".repeat(40))).toBe(false);
    expect(isEvmAddress("0x" + "a".repeat(39))).toBe(false);
    expect(isEvmAddress("0x" + "a".repeat(20) + "-" + "a".repeat(19))).toBe(false); // a real, visible dash
    expect(isEvmAddress("")).toBe(false);
  });
});

describe("registerWatchedWallet", () => {
  const getProof: GetProof = async () => PROOF;

  it("prefers the server's own refusal message over the generic fallback", async () => {
    mockFetch({ ok: false, status: 409, body: { error: "this wallet is already registered elsewhere" } });
    const result = await registerWatchedWallet(WALLET, PROFILE, getProof);
    expect(result).toEqual({
      ok: false,
      error: "this wallet is already registered elsewhere",
      severity: "blocked",
    });
  });

  it("falls back to the generic sentence when the body carries nothing usable", async () => {
    mockFetch({ ok: false, status: 502, body: null });
    const result = await registerWatchedWallet(WALLET, PROFILE, getProof);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Panik could not enable monitoring for this wallet.");
    expect(result.error).not.toMatch(/http_/);
  });

  it("falls back when the failure body is not JSON at all", async () => {
    mockFetch({ ok: false, status: 500, jsonThrows: true });
    const result = await registerWatchedWallet(WALLET, PROFILE, getProof);
    expect(result.error).toBe("Panik could not enable monitoring for this wallet.");
    expect(result.error).not.toMatch(/http_/);
  });

  it("logs the status and body it could not show the user", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch({ ok: false, status: 409, body: { error: "already registered" } });
    await registerWatchedWallet(WALLET, PROFILE, getProof);
    expect(spy).toHaveBeenCalledWith(
      "registerWatchedWallet: request failed",
      409,
      { error: "already registered" },
    );
  });
});

describe("describeTelegramSignatureFailure", () => {
  it("says the signature was declined", () => {
    const err = Object.assign(new Error("User rejected the request"), { code: 4001 });
    expect(describeTelegramSignatureFailure(err)).toBe("Signature declined. Telegram alerts need it.");
  });

  it("passes our own OwnershipError sentence through untouched", () => {
    const err = new OwnershipError("Alerts need a signature from 0xabcd...7890.");
    expect(describeTelegramSignatureFailure(err)).toBe("Alerts need a signature from 0xabcd...7890.");
  });

  it("names the missing wallet rather than the wagmi/viem internal", () => {
    const err = Object.assign(new Error("Provider not found. Version: @wagmi/core@3.5.1"), {
      name: "ProviderNotFoundError",
    });
    const message = describeTelegramSignatureFailure(err);
    expect(message).toBe("Telegram alerts need a connected wallet. Connect it and try again.");
    expect(message).not.toContain("wagmi");
  });

  it("never lets an unclassified error's own message reach the screen", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = new Error("fetch failed: getaddrinfo ENOTFOUND rpc.example.com");
    const message = describeTelegramSignatureFailure(err);
    expect(message).toBe("Could not get a signature for Telegram alerts. Try again.");
    expect(message).not.toContain("ENOTFOUND");
    expect(message).not.toMatch(/http_/);
    expect(spy).toHaveBeenCalledWith("useTelegramLink.connect: signature failed", err);
  });
});
