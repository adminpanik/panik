/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The three surfaces that tell a reader how PANIK knows who they are, and the
 * two controls that change it.
 *
 * WHY THE COLOUR IS NEUTRAL. None of this is a risk state. A read-only session
 * is not a warning, a stale alert link is not a liquidation, and "signed in" is
 * not good news about anyone's positions. The risk ramp is rationed to risk
 * indicators (docs/DESIGN_SYSTEM.md), so everything here is drawn in
 * text-secondary / text-muted on the subtle border, and the only thing that
 * distinguishes the note from the banner is the icon and the words.
 *
 * WHAT THE SIGNATURE BUYS, STATED WHERE IT IS ASKED FOR. A wallet popup that
 * does not say what it is for is the thing this product spent a whole PR
 * removing from the alert flow. `session-start` proves a key holder is here and
 * buys a name for thirty days; it authorizes nothing, and every write still
 * asks for its own signature. That sentence is on the card because a user
 * deciding whether to sign has no other way to learn it.
 */

import React from "react";
import { Eye, Info, KeyRound, X } from "lucide-react";
import { Button } from "../ui";
import type { Session } from "../lib/session";

/** Address, short. The same shape the wallet chip in the header uses. */
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

/**
 * The expiry as a date, or null when the server's value is not one.
 *
 * Null rather than a fallback string: the card simply drops the sentence. A
 * made-up date is worse than a missing one, and "unknown" printed where a date
 * goes reads as a bug rather than as information.
 */
function expiryDate(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * A read-only session, stated once, at the top of every tab.
 *
 * It sits outside the scroller for the same reason the simulated-price marker
 * does: it qualifies everything below it, so it must be impossible to read a
 * gated screen without seeing why it is gated. The sentence names the cause and
 * the cure, and the control that performs the cure is beside it rather than
 * somewhere the reader has to go and find.
 */
export function ReadOnlyBanner({
  onSignIn,
  busy,
}: {
  onSignIn: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border-subtle bg-white/[0.02] px-4 py-2 md:px-8"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Eye className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="text-xs font-sans leading-relaxed text-text-secondary">
          Viewing via alert link. Sign in with your wallet to make changes.
        </span>
      </div>
      <Button variant="outline" onClick={onSignIn} disabled={busy}>
        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? "Sign in wallet..." : "Sign in with wallet"}
      </Button>
    </div>
  );
}

/**
 * One line about the session itself: a link that could not be traded, a
 * signature that was declined, a sign-out that did not land.
 *
 * A note, not an alarm. Every case it carries leaves the app working exactly as
 * it works for a signed-out visitor, so the loudest thing it is allowed to be
 * is a sentence the reader can dismiss. `role="status"` rather than `alert` for
 * the same reason: it is worth announcing, it is not worth interrupting.
 */
export function SessionNote({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-border-subtle bg-white/[0.02] px-4 py-2 md:px-8"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-xs font-sans leading-relaxed text-text-secondary">
        {text}
      </span>
      <Button variant="quiet" onClick={onDismiss} aria-label="Dismiss this message">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export interface SessionCardProps {
  session: Session | null;
  /** The wallet a signature would be asked of. Null when none is bound yet. */
  wallet: string | null;
  busy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}

/**
 * Settings' account card: what PANIK remembers about this browser, and the one
 * control that changes it.
 *
 * SETTINGS RATHER THAN THE HEADER, for sign-out. The header holds identifiers
 * (which wallet, which network) and one-tap destinations; it is read on every
 * screen and has no room left at 390px. Sign-out is a deliberate, rare,
 * consequential action that a user goes looking for, and it belongs beside the
 * other things this tab already owns: which chain the numbers refer to, where
 * alerts are sent, and what standing permission has been granted. The offer to
 * sign IN is duplicated in the shell only because a signed-out reader has no
 * reason to open Settings.
 */
export function SessionCard({ session, wallet, busy, onSignIn, onSignOut }: SessionCardProps) {
  const until = session ? expiryDate(session.expiresAt) : null;

  return (
    <div className="bg-surface-raised/50 border border-border-subtle p-6 rounded-lg space-y-3">
      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
        <KeyRound className="w-4 h-4 text-text-primary" />
        <h3 className="text-2xs font-sans text-text-primary font-bold">Staying signed in</h3>
      </div>

      {session?.scope === "full" && (
        <>
          <p className="text-xs text-text-secondary leading-relaxed font-sans">
            This browser is signed in as {short(session.wallet)}.
            {until ? ` PANIK will recognise it until ${until}.` : ""} Signing out revokes that here
            and everywhere the same session was open.
          </p>
          <Button variant="outline" onClick={onSignOut} disabled={busy}>
            {busy ? "Signing out..." : "Sign out"}
          </Button>
        </>
      )}

      {session?.scope === "readonly" && (
        <>
          {/* The honest description of what the alert link proved: that the
              reader can see the chat those alerts go to. That is a real claim
              and a weaker one than holding the key, which is exactly why the
              writes are still withheld. */}
          <p className="text-xs text-text-secondary leading-relaxed font-sans">
            You opened PANIK from an alert link. That shows PANIK which wallet the alert was about,
            not that you hold it, so this view can read and not change. Sign in with that wallet to
            make changes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onSignIn} disabled={busy || !wallet}>
              {busy ? "Sign in wallet..." : "Sign in with wallet"}
            </Button>
            <Button variant="outline" onClick={onSignOut} disabled={busy}>
              Sign out
            </Button>
          </div>
        </>
      )}

      {session === null && (
        <>
          <p className="text-xs text-text-secondary leading-relaxed font-sans">
            This browser is not signed in, so PANIK asks for your wallet again on every visit.
          </p>
          {wallet ? (
            <Button onClick={onSignIn} disabled={busy}>
              {busy ? "Sign in wallet..." : "Stay signed in"}
            </Button>
          ) : (
            <p className="text-xs text-text-secondary leading-relaxed font-sans">
              Add the wallet PANIK should watch first, then this browser can remember it.
            </p>
          )}
        </>
      )}

      {session?.scope !== "full" && (
        /* Keep-inline by the three-way test: it is the only place the reader
           can learn what they are being asked to sign, and the limit on it is
           the reason signing is a reasonable thing to agree to. */
        <p className="text-xs text-text-secondary leading-relaxed font-sans">
          One signature, free, no transaction, no gas. It lets PANIK recognise this browser for 30
          days. It does not authorize anything: every change still asks for its own signature.
        </p>
      )}
    </div>
  );
}
