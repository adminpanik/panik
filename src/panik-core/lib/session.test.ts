/**
 * The session client, at the three points where getting it wrong is expensive:
 * what leaves the URL, what a malformed answer is allowed to become, and the
 * order the boot does its two requests in.
 *
 * Everything here is driven through a fake `fetch`, so these are unit tests of
 * the client's decisions rather than of the API. The API's own contract is
 * pinned in server/sessionStore.test.ts and server/sessionBoundary.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnershipError, type GetProof } from "./telegram";
import {
  bootSession,
  endSession,
  exchangeAlertLink,
  fetchSession,
  readableServerError,
  searchWithoutSid,
  sidParam,
  startSession,
} from "./session";

const WALLET = "0xabcd567890123456789012345678901234567890";
/** The same address as a wallet extension hands it back: EIP-55 checksummed. */
const CHECKSUMMED = "0xAbCd567890123456789012345678901234567890";
const FULL = { wallet: WALLET, scope: "full", expiresAt: "2026-09-14T00:00:00.000Z" };
const READONLY = { wallet: WALLET, scope: "readonly", expiresAt: "2026-08-22T00:00:00.000Z" };

/** One `fetch` reply. `body` is what `res.json()` resolves to. */
interface Reply {
  ok?: boolean;
  status?: number;
  body?: unknown;
  /** Throw instead of answering, the way an unreachable API does. */
  throws?: boolean;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  /** Whatever the caller passed for credentials, to prove it passed nothing. */
  credentials: unknown;
}

/**
 * Install a fetch that answers a queued script and records what it was asked.
 * A call past the end of the script is a test asserting a request that should
 * not have happened, so it fails loudly rather than returning undefined.
 */
function mockFetch(replies: Reply[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const reply = replies[i++];
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      credentials: (init as { credentials?: unknown } | undefined)?.credentials,
    });
    if (!reply) throw new Error(`unexpected fetch #${i}: ${url}`);
    if (reply.throws) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({
      ok: reply.ok ?? true,
      status: reply.status ?? (reply.ok === false ? 401 : 200),
      json: () => Promise.resolve(reply.body),
    } as unknown as Response);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sidParam", () => {
  it("reads the token an alert link carried", () => {
    expect(sidParam("?view=0xabc&tab=advisor&sid=tok_123")).toBe("tok_123");
  });

  it("is null when there is no sid, an empty one, or only whitespace", () => {
    expect(sidParam("")).toBeNull();
    expect(sidParam("?view=0xabc")).toBeNull();
    expect(sidParam("?sid=")).toBeNull();
    expect(sidParam("?sid=%20%20")).toBeNull();
  });
});

describe("searchWithoutSid", () => {
  it("removes the credential and keeps the rest of the alert link", () => {
    expect(searchWithoutSid("?view=0xabc&tab=advisor&sid=tok_123")).toBe("?view=0xabc&tab=advisor");
  });

  it("leaves a search with no sid exactly as it was", () => {
    expect(searchWithoutSid("?view=0xabc&tab=advisor")).toBe("?view=0xabc&tab=advisor");
    expect(searchWithoutSid("")).toBe("");
  });

  it("returns an empty search when the sid was the only parameter", () => {
    expect(searchWithoutSid("?sid=tok_123")).toBe("");
  });

  it("removes every copy, so a duplicated parameter cannot survive", () => {
    expect(searchWithoutSid("?sid=a&tab=advisor&sid=b")).toBe("?tab=advisor");
  });
});

describe("readableServerError", () => {
  it("puts the API's own stale-link sentence into house style", () => {
    // The exact string scripts/api-server.ts returns, em dash and all.
    expect(
      readableServerError("alert link is no longer valid — open PANIK from a fresh alert", "fb"),
    ).toBe("Alert link is no longer valid, open PANIK from a fresh alert.");
  });

  it("keeps a sentence that is already punctuated", () => {
    expect(readableServerError("Nothing to save.", "fb")).toBe("Nothing to save.");
  });

  it("falls back for anything that is not a short string", () => {
    expect(readableServerError(undefined, "fb")).toBe("fb");
    expect(readableServerError(42, "fb")).toBe("fb");
    expect(readableServerError({ error: "x" }, "fb")).toBe("fb");
    expect(readableServerError("   ", "fb")).toBe("fb");
    expect(readableServerError("x".repeat(161), "fb")).toBe("fb");
  });
});

describe("fetchSession", () => {
  it("returns the identity the server vouched for", async () => {
    const calls = mockFetch([{ body: FULL }]);
    expect(await fetchSession()).toEqual(FULL);
    expect(calls[0]).toMatchObject({ url: "/api/session", method: "GET" });
  });

  it("sends no credentials option, because same-origin is already the default", async () => {
    const calls = mockFetch([{ body: FULL }]);
    await fetchSession();
    expect(calls[0].credentials).toBeUndefined();
  });

  it("reads a 401 as signed out rather than as an error", async () => {
    mockFetch([{ ok: false, status: 401, body: { error: "not signed in" } }]);
    expect(await fetchSession()).toBeNull();
  });

  it("reads an unreachable API as signed out, and never throws", async () => {
    mockFetch([{ throws: true }]);
    expect(await fetchSession()).toBeNull();
  });

  it("refuses a body it cannot fully believe", async () => {
    // A session with no scope would render as one with no gating.
    mockFetch([{ body: { wallet: WALLET, expiresAt: FULL.expiresAt } }]);
    expect(await fetchSession()).toBeNull();

    mockFetch([{ body: { ...FULL, scope: "admin" } }]);
    expect(await fetchSession()).toBeNull();

    mockFetch([{ body: { ...FULL, wallet: "not-a-wallet" } }]);
    expect(await fetchSession()).toBeNull();

    // No expiry means the Settings card would have to invent a date.
    mockFetch([{ body: { wallet: WALLET, scope: "full" } }]);
    expect(await fetchSession()).toBeNull();
  });

  it("lowercases the wallet, so comparisons against it cannot miss", async () => {
    mockFetch([{ body: { ...FULL, wallet: CHECKSUMMED } }]);
    expect((await fetchSession())?.wallet).toBe(WALLET);
  });
});

describe("exchangeAlertLink", () => {
  it("posts the token and returns the read-only session", async () => {
    const calls = mockFetch([{ body: READONLY }]);
    const result = await exchangeAlertLink("tok_123");
    expect(result).toEqual({ session: READONLY, error: null });
    expect(calls[0]).toMatchObject({
      url: "/api/session/exchange",
      method: "POST",
      body: { token: "tok_123" },
    });
  });

  it("passes the server's refusal through, in house style", async () => {
    mockFetch([
      { ok: false, status: 401, body: { error: "alert link is no longer valid — open PANIK from a fresh alert" } },
    ]);
    const result = await exchangeAlertLink("tok_123");
    expect(result.session).toBeNull();
    expect(result.error).toBe("Alert link is no longer valid, open PANIK from a fresh alert.");
  });

  it("does not claim the link was stale when the request never landed", async () => {
    mockFetch([{ throws: true }]);
    const result = await exchangeAlertLink("tok_123");
    expect(result.session).toBeNull();
    expect(result.error).toContain("could not be reached");
  });

  it("reports neither a session nor an error when the body was not a session", async () => {
    // The cookie is set by then, so the boot must fall through to the read
    // rather than treat this as a failure.
    mockFetch([{ body: { ok: true } }]);
    expect(await exchangeAlertLink("tok_123")).toEqual({ session: null, error: null });
  });
});

describe("startSession", () => {
  const proof = { message: "siwe", signature: "0xsig" };
  const getProof: GetProof = async () => proof;

  it("signs `session-start` for the wallet and posts the proof", async () => {
    const actions: string[] = [];
    const spy: GetProof = async (_wallet, action) => {
      actions.push(action);
      return proof;
    };
    const calls = mockFetch([{ body: FULL }]);
    expect(await startSession(WALLET, spy)).toEqual({ ok: true, session: FULL });
    expect(actions).toEqual(["session-start"]);
    expect(calls[0]).toMatchObject({ url: "/api/session", method: "POST", body: proof });
  });

  it("lowercases the wallet it asks a signature for", async () => {
    const seen: string[] = [];
    mockFetch([{ body: FULL }]);
    await startSession(` ${CHECKSUMMED} `, async (wallet, _a) => {
      seen.push(wallet);
      return proof;
    });
    expect(seen).toEqual([WALLET]);
  });

  it("says the signature was declined, and what that means", async () => {
    mockFetch([]);
    const result = await startSession(WALLET, async () => {
      throw Object.assign(new Error("User rejected"), { code: 4001 });
    });
    expect(result).toEqual({
      ok: false,
      error: "Signature declined, so this browser stays signed out.",
    });
  });

  it("passes our own OwnershipError sentence through untouched", async () => {
    mockFetch([]);
    const result = await startSession(WALLET, async () => {
      throw new OwnershipError("Alerts need a signature from 0xabcd...7890.");
    });
    expect(result).toEqual({ ok: false, error: "Alerts need a signature from 0xabcd...7890." });
  });

  it("never lets a wagmi string reach the screen", async () => {
    mockFetch([]);
    const result = await startSession(WALLET, async () => {
      throw Object.assign(new Error("Provider not found. Version: @wagmi/core@3.5.1"), {
        name: "ProviderNotFoundError",
      });
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).not.toContain("wagmi");
    expect(result.error).toContain("Connect it and try again");
  });

  it("reports a refused proof with the consequence attached", async () => {
    mockFetch([{ ok: false, status: 401, body: { error: "signature does not match" } }]);
    const result = await startSession(WALLET, getProof);
    expect(result).toEqual({ ok: false, error: "Signature does not match." });
  });

  it("falls back when the failure body says nothing usable", async () => {
    mockFetch([{ ok: false, status: 502, body: null }]);
    const result = await startSession(WALLET, getProof);
    expect(result).toEqual({
      ok: false,
      error: "PANIK could not sign this browser in, so it stays signed out.",
    });
  });
});

describe("endSession", () => {
  it("confirms only what the server confirmed", async () => {
    const calls = mockFetch([{ body: { ok: true } }]);
    expect(await endSession()).toBe(true);
    expect(calls[0]).toMatchObject({ url: "/api/session", method: "DELETE" });

    mockFetch([{ ok: false, status: 502, body: null }]);
    expect(await endSession()).toBe(false);

    mockFetch([{ throws: true }]);
    expect(await endSession()).toBe(false);
  });
});

describe("bootSession", () => {
  it("reads the session and touches the URL when there is no sid", async () => {
    const calls = mockFetch([{ body: FULL }]);
    const replaced: string[] = [];
    expect(await bootSession("?tab=advisor", (s) => replaced.push(s))).toEqual({
      session: FULL,
      note: null,
    });
    expect(replaced).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("trades the sid FIRST, strips it, and skips the second request", async () => {
    const calls = mockFetch([{ body: READONLY }]);
    const replaced: string[] = [];
    const result = await bootSession("?view=0xabc&tab=advisor&sid=tok_123", (s) => replaced.push(s));
    expect(result).toEqual({ session: READONLY, note: null });
    // The exchange is the only request: its body already named the session.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/session/exchange");
    expect(replaced).toEqual(["?view=0xabc&tab=advisor"]);
  });

  it("strips the sid even when the trade failed, and says why", async () => {
    const calls = mockFetch([
      { ok: false, status: 401, body: { error: "alert link is no longer valid — open PANIK from a fresh alert" } },
      { ok: false, status: 401, body: { error: "not signed in" } },
    ]);
    const replaced: string[] = [];
    const result = await bootSession("?view=0xabc&sid=tok_123", (s) => replaced.push(s));
    expect(replaced).toEqual(["?view=0xabc"]);
    expect(calls.map((c) => c.url)).toEqual(["/api/session/exchange", "/api/session"]);
    expect(result.session).toBeNull();
    expect(result.note).toBe("Alert link is no longer valid, open PANIK from a fresh alert.");
  });

  it("strips the sid even when the exchange threw", async () => {
    mockFetch([{ throws: true }, { ok: false, status: 401, body: null }]);
    const replaced: string[] = [];
    const result = await bootSession("?sid=tok_123", (s) => replaced.push(s));
    expect(replaced).toEqual([""]);
    expect(result.note).toContain("could not be reached");
  });

  it("says nothing about a spent link when the reader is signed in anyway", async () => {
    mockFetch([
      { ok: false, status: 401, body: { error: "alert link is no longer valid — open PANIK" } },
      { body: FULL },
    ]);
    const result = await bootSession("?sid=tok_123", () => undefined);
    expect(result.session).toEqual(FULL);
    expect(result.note).toBeNull();
  });

  it("falls back to the read when the exchange was accepted but said nothing", async () => {
    const calls = mockFetch([{ body: { ok: true } }, { body: READONLY }]);
    const result = await bootSession("?sid=tok_123", () => undefined);
    expect(calls.map((c) => c.url)).toEqual(["/api/session/exchange", "/api/session"]);
    expect(result.session).toEqual(READONLY);
    expect(result.note).toBeNull();
  });
});
