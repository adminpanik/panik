/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Clear use": the row action that gives one voucher code back to one person.
 *
 * WHAT IT IS FOR. One trial code is good for one account. Once the access it
 * bought is over, re-entering it is refused ("that code was already used on
 * this account"), and this is the only thing that undoes that: it deletes that
 * address's grant row, which frees the slot the (campaign, email) unique index
 * holds, so the same card works for them once more.
 *
 * ── THE TWO FACTS THE CONFIRM HAS TO CARRY ────────────────────────────────
 * What the operator gains (that person can redeem this code again) and what
 * they do not (the redemption count is a running total and is NOT reduced, so
 * the re-redemption takes another slot out of the batch). The second is the
 * one nobody would guess, and it is the difference between a batch of 20 that
 * still has 18 left and one that has 17. Both are in the sentence, and the
 * sentence is exported and pure so a test can hold it rather than leaving it
 * in a dialog nothing can assert on.
 *
 * ── WHY IT IS OFFERED ON EVERY ROW WITH AN ADDRESS ────────────────────────
 * Unlike "End trial", this control is not conditioned on whether the trial is
 * still open. Clearing a live redemption is a legitimate act (a card handed to
 * the wrong person, a test run to redo) and the confirm states exactly what it
 * does either way. A row that captured no address gets a disabled control with
 * the reason, because the address is how the server finds the grant.
 *
 * The pattern is the console's existing one, verbatim: a secondary `Button`
 * with a Lucide glyph and a `window.confirm` naming what is about to happen,
 * the same shape as "End trial" beside it and "Switch off" in CampaignsPanel.
 */

import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "../panik-core/ui";
import { clearRedemptionUse, isSignedOut } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/**
 * The sentence the operator confirms against. Exported and pure so both of its
 * promises are pinned by a test: the person gets the code back, and the batch
 * does not get the slot back.
 */
export function clearUseConfirmText(email: string): string {
  return (
    `Clear the use of this code for ${email}? ` +
    `${email} can redeem this code again. The redemption count is not reduced.`
  );
}

const NO_EMAIL_REASON = "No address on file, so this redemption cannot be looked up.";

export function ClearUseAction({
  session,
  code,
  email,
  onCleared,
  onSignedOut,
}: {
  session: Session;
  /** The campaign code this row belongs to. Half of what the server looks up. */
  code: string;
  /** The address that redeemed it. Null on a row that never captured one. */
  email: string | null;
  /** Reload the panel: the row this action removed is now gone. */
  onCleared: () => void;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** `busy` state does not read back as true inside one frame; this does. */
  const inFlight = useRef(false);

  async function clear() {
    if (!email || inFlight.current) return;
    if (!window.confirm(clearUseConfirmText(email))) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await clearRedemptionUse(session, code, email);
      if (res.ok) {
        onCleared();
      } else if (isSignedOut(res.status)) {
        onSignedOut();
      } else {
        // The server's own sentence, which for a 404 says what was not found.
        setError(res.error ?? "Could not clear this use.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* `whitespace-nowrap` because this sits in the narrowest column of a
          ledger, beside a second control: without it the label breaks across
          two lines and the button grows a second row of its own. */}
      <Button
        variant="secondary"
        className="whitespace-nowrap"
        onClick={clear}
        disabled={busy || !email}
        title={email ? undefined : NO_EMAIL_REASON}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? "Clearing" : "Clear use"}
      </Button>
      {error ? (
        <span role="alert" className="font-sans text-xs text-text-secondary">
          {error}
        </span>
      ) : null}
    </span>
  );
}
