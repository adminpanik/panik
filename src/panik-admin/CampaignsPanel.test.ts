/**
 * `guardInFlight` is the fix for the admin create-campaign double-fire: a
 * double click (or Enter held into a click) on "New voucher code" used to
 * call `createCampaign` twice inside one frame, because `busy` React state
 * does not read back as true until the next render. Each call minted a fresh
 * code and a fresh campaign server-side.
 *
 * Pinned here as a plain function, independent of React, because this
 * project's vitest config runs `*.test.ts` under a `node` environment with no
 * React Testing Library dependency to render `CreateForm` itself.
 */

import { describe, expect, it, vi } from "vitest";

import { guardInFlight } from "./CampaignsPanel";

describe("guardInFlight", () => {
  it("runs a single call through to completion", async () => {
    const ref = { current: false };
    const run = vi.fn(async () => {});
    await guardInFlight(ref, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(false); // released after completion
  });

  it("drops a second call that arrives while the first is still in flight", async () => {
    const ref = { current: false };
    let resolveFirst!: () => void;
    const started = { count: 0 };
    const run = vi.fn(() => {
      started.count += 1;
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    const first = guardInFlight(ref, run);
    // The synchronous double-click: this fires before `first` has any chance
    // to resolve, and before any `await` in the caller yields back to it.
    const second = guardInFlight(ref, run);

    expect(started.count).toBe(1); // the second call never ran `run` at all
    resolveFirst();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("releases the guard on a throw, so a later retry is not permanently blocked", async () => {
    const ref = { current: false };
    const run = vi.fn(async () => {
      throw new Error("network blip");
    });

    await expect(guardInFlight(ref, run)).rejects.toThrow("network blip");
    expect(ref.current).toBe(false);

    const retry = vi.fn(async () => {});
    await guardInFlight(ref, retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
