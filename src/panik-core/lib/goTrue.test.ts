/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The shared GoTrue transport, and in particular THE BRANCH THE TWO COPIES OF
 * IT USED TO DISAGREE ON: what a refresh that never reached the service costs
 * the stored session. One of them erased it, which signs a user out for a
 * dropped packet; the other kept it. Every case below exists to pin that down,
 * because the failure is invisible until someone is on a train.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFresh, readStored, writeStored, type TokenBody } from "./goTrue";

const KEY = "panik_test_session";

interface TestSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Only the four members these functions touch. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  };
}

let store = fakeStorage();

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal("localStorage", store);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const decode = (body: TokenBody): TestSession | null =>
  body.access_token && body.refresh_token
    ? {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + 3_600_000,
      }
    : null;

/** A session with plenty of life left, and one already inside the margin. */
const fresh = (): TestSession => ({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 600_000 });
const stale = (): TestSession => ({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1_000 });

function answers(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe("ensureFresh", () => {
  it("does not spend a request on a session that is not close to lapsing", async () => {
    const fetchMock = answers(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const held = fresh();
    await expect(ensureFresh(held, KEY, decode)).resolves.toBe(held);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores and returns the renewed session", async () => {
    vi.stubGlobal("fetch", answers(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
    const next = await ensureFresh(stale(), KEY, decode);
    expect(next?.accessToken).toBe("a2");
    expect(JSON.parse(store.raw.get(KEY)!)).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
  });

  it("clears the stored session when GoTrue REFUSES the refresh token", async () => {
    store.setItem(KEY, JSON.stringify(stale()));
    vi.stubGlobal("fetch", answers(400, { error: "invalid_grant" }));
    await expect(ensureFresh(stale(), KEY, decode)).resolves.toBeNull();
    expect(store.raw.has(KEY)).toBe(false);
  });

  it("clears it too when the grant succeeded but nothing usable came back", async () => {
    // A 200 with no tokens in it is still the service having answered, and the
    // answer contains no session. Keeping the old one would leave a browser
    // retrying a credential the server has already replaced with nothing.
    store.setItem(KEY, JSON.stringify(stale()));
    vi.stubGlobal("fetch", answers(200, { hello: "world" }));
    await expect(ensureFresh(stale(), KEY, decode)).resolves.toBeNull();
    expect(store.raw.has(KEY)).toBe(false);
  });

  it("KEEPS the stored session when the request never completed", async () => {
    // The tunnel case. A dropped request is not evidence about a credential,
    // so the next load must find the session exactly where it was.
    const held = stale();
    store.setItem(KEY, JSON.stringify(held));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(ensureFresh(held, KEY, decode)).resolves.toBeNull();
    expect(JSON.parse(store.raw.get(KEY)!)).toMatchObject({ refreshToken: "r" });
  });
});

describe("readStored / writeStored", () => {
  it("reads back what was written", () => {
    writeStored(KEY, { accessToken: "a", refreshToken: "r", expiresAt: 1 });
    expect(readStored<TestSession>(KEY, (p) => p as TestSession)?.accessToken).toBe("a");
  });

  it("answers null for an absent key, for unparseable JSON, and for a refused shape", () => {
    expect(readStored(KEY, (p) => p)).toBeNull();
    store.setItem(KEY, "{not json");
    expect(readStored(KEY, (p) => p)).toBeNull();
    store.setItem(KEY, JSON.stringify({ accessToken: "" }));
    expect(readStored(KEY, () => null)).toBeNull();
  });

  it("clears the key on null rather than storing the word", () => {
    writeStored(KEY, { accessToken: "a" });
    writeStored(KEY, null);
    expect(store.raw.has(KEY)).toBe(false);
  });

  it("survives storage that throws, which is what private mode does", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    });
    expect(() => writeStored(KEY, { accessToken: "a" })).not.toThrow();
    expect(readStored(KEY, (p) => p)).toBeNull();
  });
});
