/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "End trial": the one row action three of this console's panels share.
 *
 * WHAT IT IS FOR: a renewal flow can only be tested by somebody whose trial has
 * just run out, and waiting three days for one is not a test plan. This closes
 * a named account's grant now. The account itself is untouched: they can sign
 * in, and they can redeem again, which is the whole point.
 *
 * ── WHY LIVENESS IS ASKED FOR AND NEVER DERIVED ───────────────────────────
 * Only the Accounts panel already knows: its rows carry the server's own
 * `live` verdict. The Trials roster and the voucher drill-down list
 * REDEMPTIONS, and a redemption's `expires_at` is the campaign grant's clock,
 * not the membership's. An operator can have ended the membership an hour ago
 * and that column would still read as running. So those two ask
 * `/api/admin/trials` which addresses hold an open grant and look themselves
 * up in the answer. `useLiveTrialEmails` is that request, once per panel.
 *
 * ── THE THREE BUTTON STATES ARE THE THREE THINGS WE KNOW ──────────────────
 *   live true    the control, enabled.
 *   live false   nothing at all. The row already says the trial is over, and a
 *                dead button beside it is one more thing to read.
 *   live null    we could not find out. DISABLED WITH A REASON, never hidden
 *                and never enabled: hiding it would claim the trial has ended
 *                and enabling it would offer an action that may 404.
 * A row with no address on file gets the same disabled treatment, because the
 * address is how the server finds the account.
 *
 * The pattern is the console's existing one, verbatim: a secondary `Button`
 * with a Lucide glyph and a `window.confirm` naming what is about to happen,
 * the same shape as "Switch off" in CampaignsPanel.
 */

import { useCallback, useRef, useState } from "react";
import { TimerOff } from "lucide-react";

import { Button } from "../panik-core/ui";
import {
  endTrial,
  isSignedOut,
  listLiveTrials,
  type TrialSummary,
} from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/**
 * The sentence the operator confirms against. Exported and pure so its two
 * promises (the account survives, the access does not) are pinned by a test
 * rather than living only in a dialog nobody can assert on.
 */
export function endTrialConfirmText(email: string): string {
  return `End the trial for ${email} now? They keep their account; access ends immediately.`;
}

/** An address in the one shape it is compared in, matching the server's own. */
export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * The addresses holding an open grant, as a lookup set. Rows with no address
 * are dropped rather than keyed on an empty string, which would make every
 * emailless row in a roster look live.
 */
export function liveTrialEmails(trials: TrialSummary[]): Set<string> {
  const out = new Set<string>();
  for (const t of trials) {
    const email = normalizeEmail(t.email);
    if (email !== "") out.add(email);
  }
  return out;
}

/**
 * Is this address's trial open? `null` means the live set never arrived, which
 * is a third answer and not a false: see the button states above.
 */
export function isTrialLive(live: Set<string> | null, email: string | null): boolean | null {
  if (live === null) return null;
  const key = normalizeEmail(email);
  return key === "" ? false : live.has(key);
}

/**
 * The live set, for a panel that has to look rows up in it. Kept null until it
 * arrives and set back to null if it fails, so a panel whose lookup broke
 * renders "could not check" rather than silently hiding every control.
 *
 * It does NOT fetch on mount. The two panels using it already have a `refresh`
 * that runs on mount and on Reload, and each calls `reloadLive` from inside
 * it: fetching here as well would spend two of the admin gate's ten requests a
 * minute on one panel opening, and would let the list and its live set be
 * reloaded independently, which is how a button outlives its trial.
 */
export function useLiveTrialEmails(session: Session, onSignedOut: () => void) {
  const [live, setLive] = useState<Set<string> | null>(null);

  const reloadLive = useCallback(async () => {
    const res = await listLiveTrials(session);
    if (res.ok && res.data) {
      setLive(liveTrialEmails(res.data.trials));
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setLive(null);
    }
  }, [session, onSignedOut]);

  return { live, reloadLive };
}

const NO_EMAIL_REASON = "No address on file, so this account cannot be looked up.";
const UNKNOWN_REASON = "Could not check whether this trial is still open.";

export function EndTrialAction({
  session,
  email,
  live,
  onEnded,
  onSignedOut,
}: {
  session: Session;
  /** The account's address. Null on a row that never captured one. */
  email: string | null;
  /** True open, false over, null not known. */
  live: boolean | null;
  /** Reload the panel: the row this action changed is now stale. */
  onEnded: () => void;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** `busy` state does not read back as true inside one frame; this does. */
  const inFlight = useRef(false);

  // The trial is over and the row already says so. Nothing to offer.
  if (live === false) return null;

  const reason = !email ? NO_EMAIL_REASON : live === null ? UNKNOWN_REASON : null;

  async function end() {
    if (!email || inFlight.current) return;
    if (!window.confirm(endTrialConfirmText(email))) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await endTrial(session, email);
      if (res.ok) {
        onEnded();
      } else if (isSignedOut(res.status)) {
        onSignedOut();
      } else {
        // The server's own sentence, which for a 404 says WHICH miss it was.
        setError(res.error ?? "Could not end the trial.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        onClick={end}
        disabled={busy || reason !== null}
        title={reason ?? undefined}
      >
        <TimerOff className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? "Ending" : "End trial"}
      </Button>
      {error ? (
        <span role="alert" className="font-sans text-xs text-text-secondary">
          {error}
        </span>
      ) : null}
    </span>
  );
}
