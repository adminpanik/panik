/**
 * The snapshot change-detection bound.
 *
 * The property under test is the one the worker used to get wrong: a real
 * change in total or band must trigger a snapshot even when the heartbeat
 * isn't due, and an unchanged score must NOT trigger one just because it was
 * rescored. The regression this guards against compared a score against
 * itself (see snapshotDecision.ts's header) and made every change invisible.
 */

import { describe, expect, it } from "vitest";
import { shouldSnapshot, type SnapshotComparable } from "./snapshotDecision";

const T0 = 1_800_000_000_000;
const HEARTBEAT_MS = 15 * 60_000;

function score(total: number, band = "moderate"): SnapshotComparable {
  return { total, band };
}

describe("shouldSnapshot", () => {
  it("triggers on the very first score, when there is no previous entry", () => {
    expect(shouldSnapshot(undefined, score(50), 0, HEARTBEAT_MS, T0)).toBe(true);
  });

  it("triggers when total changed, well before the heartbeat is due", () => {
    const prev = score(50);
    const current = score(62);
    expect(shouldSnapshot(prev, current, T0, HEARTBEAT_MS, T0 + 1_000)).toBe(true);
  });

  it("triggers when only the band changed, total held constant", () => {
    const prev = score(74, "moderate");
    const current = score(74, "high");
    expect(shouldSnapshot(prev, current, T0, HEARTBEAT_MS, T0 + 1_000)).toBe(true);
  });

  it("does NOT trigger for an identical rescore before the heartbeat is due", () => {
    const prev = score(50, "moderate");
    const current = score(50, "moderate");
    expect(shouldSnapshot(prev, current, T0, HEARTBEAT_MS, T0 + 1_000)).toBe(false);
  });

  it("triggers an unchanged score once the heartbeat interval has elapsed", () => {
    const prev = score(50, "moderate");
    const current = score(50, "moderate");
    expect(shouldSnapshot(prev, current, T0, HEARTBEAT_MS, T0 + HEARTBEAT_MS)).toBe(true);
  });

  it("does not trigger one millisecond before the heartbeat bound", () => {
    const prev = score(50, "moderate");
    const current = score(50, "moderate");
    expect(shouldSnapshot(prev, current, T0, HEARTBEAT_MS, T0 + HEARTBEAT_MS - 1)).toBe(false);
  });

  it("would have masked a real change under the old write-then-compare bug", () => {
    // Reproduces the exact defect: comparing `current` against ITSELF, as the
    // old code did by reading the cache after writing `current` into it,
    // always reports "unchanged" regardless of what the real previous score
    // was. Comparing against the true previous score below correctly detects
    // the drop from 50 to 20.
    const realPrevious = score(50, "moderate");
    const current = score(20, "high");
    // Bug reproduction: comparing current to itself.
    expect(shouldSnapshot(current, current, T0, HEARTBEAT_MS, T0 + 1_000)).toBe(false);
    // Fix: comparing current to the real previous entry.
    expect(shouldSnapshot(realPrevious, current, T0, HEARTBEAT_MS, T0 + 1_000)).toBe(true);
  });
});
