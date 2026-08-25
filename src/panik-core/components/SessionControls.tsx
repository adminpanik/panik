/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The three surfaces that tell a reader how PANIK knows who they are, and the
 * control that changes it.
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
import { Button, Card } from "../ui";
import { truncateAddress } from "../lib/utils";
import type { Session, SessionScope } from "../lib/session";

/** Every explanatory line on these surfaces reads the same. */
const PROSE = "text-xs font-sans leading-relaxed text-text-secondary";

/**
 * Pinned once at module scope rather than rebuilt per render: constructing a
 * formatter is the expensive half of formatting a date, and this one renders on
 * every pass over the Settings tab.
 */
const EXPIRY_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * The expiry as a date, or null when the server's value is not one.
 *
 * Null rather than a fallback string: the card simply drops the sentence. A
 * made-up date is worse than a missing one, and "unknown" printed where a date
 * goes reads as a bug rather than as information.
 */
function expiryDate(iso: string): string | null {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : EXPIRY_FORMAT.format(when);
}

/** What a session is worth here, with "no session at all" as a fourth answer. */
type SessionState = SessionScope | "none";

export interface SignInButtonProps {
  scope: SessionState;
  busy: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

/**
 * The one control that asks for a `session-start` signature, in the two places
 * it is offered: the read-only banner and Settings' account card.
 *
 * The label is the reason this is a component and not two buttons. What is
 * being offered genuinely differs by state, "stay signed in" for a visitor who
 * is nobody yet and "sign in with wallet" for a reader the server can name but
 * not vouch for, and hand-typed copies of that ternary are how one of them ends
 * up saying the wrong thing about what pressing it does.
 */
export function SignInButton({ scope, busy, onClick, variant = "secondary" }: SignInButtonProps) {
  const label = busy
    ? "Sign in wallet..."
    : scope === "readonly"
      ? "Sign in with wallet"
      : "Stay signed in";

  return (
    <Button variant={variant} onClick={onClick} disabled={busy}>
      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
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
export function ReadOnlyBanner({ onSignIn, busy }: { onSignIn: () => void; busy: boolean }) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border-subtle bg-white/[0.02] px-4 py-2 md:px-8"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Eye className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        <span className={PROSE}>
          Viewing via alert link. Sign in with your wallet to make changes.
        </span>
      </div>
      <SignInButton scope="readonly" busy={busy} onClick={onSignIn} />
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
      <span className={`min-w-0 flex-1 ${PROSE}`}>{text}</span>
      <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss this message">
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
  const state: SessionState = session?.scope ?? "none";

  /**
   * One STATE LINE per branch, and nothing else.
   *
   * Every branch used to open with two or three sentences explaining what a
   * session is, what signing out does elsewhere, and what an alert link proved.
   * On a settings screen that is a paragraph between the reader and the control
   * they came for. What survives is the fact each branch actually carries: the
   * address, the expiry the server returned, and whether this view can change
   * anything. The one line under the card explains what is being signed, which
   * is the single genuinely ambiguous thing here.
   */
  let body: React.ReactNode;
  if (session && state === "full") {
    const until = expiryDate(session.expiresAt);
    body = (
      <>
        <p className={PROSE}>
          {truncateAddress(session.wallet)}
          {until ? `, until ${until}` : ""}
        </p>
        <Button variant="secondary" onClick={onSignOut} disabled={busy}>
          {busy ? "Signing out..." : "Sign out"}
        </Button>
      </>
    );
  } else if (state === "readonly") {
    body = (
      <>
        {/* The honest description of what the alert link proved: that the
            reader can see the chat those alerts go to. That is a real claim
            and a weaker one than holding the key, which is exactly why the
            writes are still withheld. */}
        <p className={PROSE}>Opened from an alert link, so this view can read and not change.</p>
        <div className="flex flex-wrap items-center gap-2">
          {wallet && <SignInButton scope="readonly" busy={busy} onClick={onSignIn} variant="primary" />}
          <Button variant="secondary" onClick={onSignOut} disabled={busy}>
            Sign out
          </Button>
        </div>
      </>
    );
  } else {
    body = wallet ? (
      <SignInButton scope="none" busy={busy} onClick={onSignIn} variant="primary" />
    ) : (
      <p className={PROSE}>Add a wallet first, then this browser can remember it.</p>
    );
  }

  return (
    <Card tone="raised" className="space-y-3">
      <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
        <KeyRound className="w-4 h-4 text-text-primary" />
        {/* The card-heading treatment the rest of the product uses. Settings
            was running its own at `text-2xs`, one step under everything else's
            row content. */}
        <h3 className="text-sm font-sans font-semibold text-text-primary">Staying signed in</h3>
      </div>

      {body}

      {state !== "full" && (
        /* Keep-inline by the three-way test, and cut to the three facts: it is
           the only place the reader can learn what they are being asked to
           sign, and what it does not buy is the reason agreeing is reasonable. */
        <p className={PROSE}>
          One signature, no gas, 30 days. It authorizes nothing on its own.
        </p>
      )}
    </Card>
  );
}
