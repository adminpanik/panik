/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the Clear use dialog promises before anything is sent.
 *
 * It is asserted here rather than left to a component test this suite has no
 * DOM for, and it is asserted at all because the second half of the sentence
 * is the half nobody would guess. Clearing a use gives the CODE back to one
 * person; it does not give the SLOT back to the batch, because
 * `redemption_count` is a running total of redemptions and never a count of
 * live ones. An operator who pressed this expecting a batch of 20 to go back
 * from 2 used to 1 would be reading that counter wrong from then on.
 */

import { describe, expect, it } from "vitest";

import { clearUseConfirmText } from "./ClearUseAction";

/** By code point, so this file can forbid the character without typing one. */
const EM_DASH = String.fromCharCode(0x2014);

describe("clearUseConfirmText", () => {
  it("names the person and both halves of what happens", () => {
    const text = clearUseConfirmText("tester@panik.fi");
    expect(text).toBe(
      "Clear the use of this code for tester@panik.fi? " +
        "tester@panik.fi can redeem this code again. The redemption count is not reduced.",
    );
  });

  it("promises the re-redemption and warns that the count stays", () => {
    const text = clearUseConfirmText("tester@panik.fi");
    // The gain, and the cost. Neither may quietly drop out.
    expect(text).toContain("can redeem this code again");
    expect(text).toContain("The redemption count is not reduced");
  });

  it("says it in plain words: no jargon, no enum, no em dash", () => {
    const text = clearUseConfirmText("tester@panik.fi");
    expect(text).not.toContain(EM_DASH);
    expect(text).not.toMatch(/grant|trial_grants|already_used|slot/i);
  });
});
