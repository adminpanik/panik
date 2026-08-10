/**
 * The invariant here is narrow and worth a test on its own: NO wagmi or viem
 * string ever reaches the alerts banner.
 *
 * It shipped broken. `registerWatchedWallet` interpolated `(err as Error)
 * .message` into its result, so a browser with no wallet extension rendered
 * "Provider not found. Version: @wagmi/core@3.5.1" in risk-critical red across
 * the top of the app — a library internal, a version number, and an alarm, for
 * the ordinary case of someone pasting an address to look around.
 *
 * These tests drive the real exported function through a stubbed `getProof`, so
 * they break if the classification is bypassed later.
 */
import { describe, expect, it } from "vitest";
import { OwnershipError, registerWatchedWallet } from "./telegram";

const WALLET = "0x5900c3b72458f12967dc1bef35b92d271f5cdbc1";

/** A `getProof` that fails the way a given library error would. */
const throwing = (err: unknown) => () => Promise.reject(err) as never;

/** Every substring that would betray an internal if it reached the screen. */
const LEAKS = [/@wagmi/i, /viem/i, /\bversion\b/i, /0x[0-9a-f]{40}\b/i, /undefined|null|NaN/];

describe("monitoring failure copy", () => {
  it("never passes a wagmi message through", async () => {
    const wagmiError = Object.assign(
      new Error("Provider not found. Version: @wagmi/core@3.5.1"),
      { name: "ProviderNotFoundError" },
    );
    const result = await registerWatchedWallet(WALLET, "moderate", throwing(wagmiError));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    for (const leak of LEAKS) expect(result.error).not.toMatch(leak);
    // No wallet to sign with is a precondition, not a failure: it must not
    // raise the critical banner.
    expect(result.severity).toBe("unverified");
  });

  it("treats a declined signature as blocked, not unverified", async () => {
    const rejected = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const result = await registerWatchedWallet(WALLET, "moderate", throwing(rejected));

    expect(result.severity).toBe("blocked");
    expect(result.error).toMatch(/declined/i);
  });

  it("passes our OWN message through verbatim", async () => {
    const mine = new OwnershipError("Alerts need a signature from 0x5900...dbc1.");
    const result = await registerWatchedWallet(WALLET, "moderate", throwing(mine));

    expect(result.error).toBe("Alerts need a signature from 0x5900...dbc1.");
    expect(result.severity).toBe("unverified");
  });

  it("falls back to product copy for an unrecognised throw", async () => {
    const weird = { toString: () => "TypeError: cannot read properties of undefined" };
    const result = await registerWatchedWallet(WALLET, "moderate", throwing(weird));

    expect(result.severity).toBe("blocked");
    for (const leak of LEAKS) expect(result.error).not.toMatch(leak);
    // A complete sentence carrying its own consequence: the banner no longer
    // concatenates a second half onto whatever came back.
    expect(result.error).toMatch(/alerts are off\.$/i);
  });

  it("reports success with no message and no severity", async () => {
    const proof = () => Promise.resolve({ message: "m", signature: "0x1" as const });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    try {
      // A wallet not used by the other cases: registerWatchedWallet dedupes
      // per session at module scope, and a hit there would fake this pass.
      const result = await registerWatchedWallet(
        "0x1111111111111111111111111111111111111111",
        "moderate",
        proof,
      );
      expect(result).toEqual({ ok: true, error: null, severity: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
