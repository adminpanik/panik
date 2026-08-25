/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The four screens a reader can meet before the app: sign in, check your email,
 * enter your invite code, and the one that says we could not find out.
 *
 * WHICH ONE IS NOT DECIDED HERE. `gateScreen` in lib/account.ts names it and
 * this component switches on that name, so the shell and the gate cannot walk
 * two different chains over the same three fields and disagree about which
 * kind of "unknown" the reader is in.
 *
 * WHY THE COLOUR IS NEUTRAL, AGAIN. Being outside a closed beta is not a risk
 * state. A wrong invite code is not a liquidation and "you are in" is not good
 * news about anyone's positions, so the risk ramp is spent on none of this
 * (docs/DESIGN_SYSTEM.md). The only token borrowed from it is `risk-unknown`,
 * inside `ui/Notice` and `EmptyState tone="problem"`, and its whole meaning is
 * "we could not find out".
 *
 * WHY THE SERVER'S WORDS. Every refusal on the voucher screen is the sentence
 * server/accounts.ts wrote (`that code was not recognised`, `that code has
 * already been used its full number of times`). The server is the only party
 * that knows which one applies, and a local rewrite would be a second copy of a
 * message set free to drift from the one the API actually sends.
 *
 * WHAT IS DELIBERATELY NOT HERE. No waitlist form. The landing page already
 * owns that flow and duplicating it would give this product two places a person
 * can be on a list, which is one more than anybody can keep in step. The
 * secondary path is a link.
 */

import React, { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, LogIn, Mail, Ticket, type LucideIcon } from "lucide-react";
import { BootSkeleton, Button, Card, EmptyState, Notice, TextField } from "../ui";
import {
  RESEND_COOLDOWN_MS,
  WAITLIST_URL,
  type AccountState,
  type GateScreen,
} from "../lib/account";

/** Every explanatory line on these screens reads the same. */
const PROSE = "text-xs font-sans leading-relaxed text-text-secondary";

/**
 * The Google mark, from Simple Icons (CC0), path data copied verbatim on a
 * 24x24 canvas. Never hand-drawn: an improvised G beside a real product is the
 * exact failure the icon rule in docs/DESIGN_SYSTEM.md exists to stop.
 *
 * Drawn in `currentColor` rather than in Google's four brand colours, because
 * this is a neutral outline control on a dark surface and a four-colour mark on
 * it would be the loudest saturated thing on a screen whose job is to be calm.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

/**
 * The page every gate screen sits on. One column, capped and centred, on the
 * page's own surface, with the brand block the sidebar carries once the app is
 * open. `min-h-screen` rather than `h-screen` so a short viewport scrolls
 * instead of clipping the control at the bottom of the card.
 *
 * Rendered ONCE, by `AccountGate`, around whichever screen is up. The screens
 * return their card alone, so a block the hosting surface wants under the card
 * (`after`) is placed in exactly one signature and no screen can forget it.
 */
function GateShell({ children, after }: { children: React.ReactNode; after?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-surface-base px-4 py-10 font-sans text-sm text-text-primary antialiased">
      <div className="flex items-center gap-2.5">
        <img src="/panik-mark.svg" alt="" width={32} height={32} style={{ objectFit: "contain" }} />
        <div className="flex flex-col">
          <span className="text-lg font-sans font-extrabold leading-none text-text-primary">PANIK</span>
          <span className="mt-0.5 text-2xs font-sans text-text-muted">Risk intelligence</span>
        </div>
      </div>
      <div className="w-full max-w-md space-y-4">
        {children}
        {after}
      </div>
    </div>
  );
}

function GateHeading({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle pb-2.5">
      <Icon className="h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
      <h1 className="text-sm font-sans font-semibold text-text-primary">{title}</h1>
    </div>
  );
}

// ── 1 + 2. sign in, and the link we sent ────────────────────────────────────

/**
 * Whether an address is worth spending a request on. Deliberately loose: an
 * address is only really valid if mail arrives at it, every stricter regex
 * rejects somebody's real mailbox, and the authority here is Supabase. This
 * only stops the obvious typo from costing a round trip and a rate-limit slot.
 */
function plausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 320;
}

/**
 * Seconds left on the resend cooldown, ticking down to zero AND STOPPING there.
 * A timer left running past the last value anything reads is a render per
 * second for as long as the screen is open.
 */
function useCooldown(startedAt: number | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (startedAt === null) {
      setLeft(0);
      return;
    }
    const remaining = () =>
      Math.max(0, Math.ceil((startedAt + RESEND_COOLDOWN_MS - Date.now()) / 1000));
    setLeft(remaining());
    const id = window.setInterval(() => {
      const seconds = remaining();
      setLeft(seconds);
      if (seconds === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return left;
}

function SignInScreen({
  account,
  note,
}: {
  account: AccountState;
  /**
   * One line the SHELL knows and this screen does not: an alert link that could
   * not be traded. Passed in rather than read here, so this component stays a
   * function of the account layer alone.
   */
  note?: string | null;
}) {
  const [email, setEmail] = useState("");
  /** Where the link went and when, as one fact: neither half means anything alone. */
  const [sent, setSent] = useState<{ to: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useCooldown(sent?.at ?? null);

  /**
   * ONE line about what went wrong, and both halves of this screen read it.
   *
   * The order is what a reader needs to hear first: the answer to the control
   * they just pressed, then the account layer's own news (a sign-in link that
   * came back expired), then the shell's note about the alert link they
   * arrived on. Three separate strips would put three sentences about three
   * different failures on one card.
   */
  const message = error ?? account.error ?? note ?? null;

  /** The one predicate the guard and the control's disabled state both use. */
  const canSend = plausibleEmail(email) && !account.busy;

  const send = useCallback(async () => {
    if (!canSend) return;
    setError(null);
    const result = await account.sendLink(email);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSent({ to: email.trim().toLowerCase(), at: Date.now() });
  }, [account, canSend, email]);

  if (!account.configured) {
    return (
      <EmptyState
        tone="problem"
        title="Sign-in is not available here"
        hint="This deployment has no sign-in service configured, so PANIK cannot open an account for you."
      />
    );
  }

  if (sent) {
    return (
      <Card tone="raised" className="space-y-3">
        <GateHeading icon={Mail} title="Check your email" />
        <p className={PROSE}>
          We sent a sign-in link to <span className="text-text-primary">{sent.to}</span>. Open it
          in this browser to finish signing in.
        </p>
        <p className={PROSE}>The link can be used once.</p>
        {message && <Notice text={message} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={send} disabled={account.busy || cooldown > 0}>
            {cooldown > 0 ? `Send another link in ${cooldown}s` : "Send another link"}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setSent(null);
              setError(null);
            }}
          >
            Use a different address
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card tone="raised" className="space-y-4">
      <GateHeading icon={LogIn} title="Sign in to PANIK" />
      {/* Keep-inline by the three-way test: it is the only place a first-time
          visitor learns that an account alone is not enough, and knowing it
          before signing in is what stops the next screen reading as a
          rejection. */}
      <p className={PROSE}>
        PANIK is in closed beta. Sign in first, then enter your invite code.
      </p>

      {message && <Notice text={message} />}

      <Button
        variant="outline"
        onClick={account.startGoogle}
        disabled={account.busy}
        className="w-full justify-center"
      >
        <GoogleMark />
        Continue with Google
      </Button>

      {/* A hairline with a word on it, not a bordered row: nested chrome is
          what the design system forbids, and this is a separator. */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border-subtle" />
        <span className="text-2xs font-sans text-text-muted">or</span>
        <span className="h-px flex-1 bg-border-subtle" />
      </div>

      <div className="space-y-2">
        <TextField
          id="account-email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          value={email}
          disabled={account.busy}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder="you@email.com"
        />
        {/* "Sign in", not "Send sign-in link". What pressing this does is
            explained by the screen it produces, which names the address the
            link went to and says it can be used once; saying it here as well
            made the control describe its own mechanism before anyone had
            asked. The caption under it went for the same reason. */}
        <Button onClick={send} disabled={!canSend} className="w-full justify-center">
          {account.busy ? "Sending..." : "Sign in"}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

// ── 3. the invite code ──────────────────────────────────────────────────────

function VoucherScreen({ account }: { account: AccountState }) {
  /**
   * A code the reader arrived holding, if they did: the `?code=` a scanned card
   * carried onto /try, kept by the account boot across the sign-in round trip.
   * Nobody is redeemed automatically - the code is typed into the box for them
   * and they press the control.
   */
  const [code, setCode] = useState(account.pendingVoucher ?? "");
  const [error, setError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const email = account.account?.email ?? "";

  /** Same rule as the sign-in screen: one sentence, one place to look. */
  const message = error ?? account.error ?? null;

  /** The one predicate the guard and the control's disabled state both use. */
  const canSubmit = code.trim() !== "" && !account.busy;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    const result = await account.redeem(code);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The app is NOT entered here. `reload` is what re-reads GET /api/account
    // and opens the gate, and putting it behind a control means the reader is
    // told the code worked instead of being teleported by a screen that
    // vanished; it also means the membership on screen is the server's answer
    // rather than this component's assumption about what the POST did.
    setRedeemed(true);
  }, [account, canSubmit, code]);

  if (redeemed) {
    return (
      <Card tone="raised" className="space-y-3">
        <GateHeading icon={Check} title="You're in" />
        <p className={PROSE}>
          Your code was accepted. PANIK is open for{" "}
          <span className="text-text-primary">{email}</span>.
        </p>
        <Button onClick={() => void account.reload()} disabled={account.busy} className="w-full justify-center">
          {account.busy ? "Opening..." : "Open PANIK"}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </Card>
    );
  }

  return (
    <Card tone="raised" className="space-y-4">
      <GateHeading icon={Ticket} title="Enter your invite code" />
      <p className={PROSE}>
        PANIK is in closed beta. Your code opens it for this account.
      </p>

      <div className="space-y-2">
        {/* Mono, because it is a printed string a reader is copying character
            by character off a card: the face that makes 0/O and 1/l tell
            themselves apart is the one every address and hash in this product
            already uses. */}
        <TextField
          id="account-voucher"
          label="Invite code"
          mono
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          value={code}
          disabled={account.busy}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="PANIK-TRY-XXXXXXXX"
        />
        {message && <Notice text={message} />}
        <Button onClick={submit} disabled={!canSubmit} className="w-full justify-center">
          {account.busy ? "Checking..." : "Redeem code"}
        </Button>
      </div>

      <a
        href={WAITLIST_URL}
        className="inline-flex min-h-6 items-center gap-1.5 text-xs font-sans font-bold text-text-secondary transition-colors hover:text-text-primary"
      >
        No code? Join the waitlist
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <span className="min-w-0 truncate text-xs font-sans text-text-muted">
          Signed in as {email}
        </span>
        <Button variant="quiet" onClick={() => void account.signOut()} disabled={account.busy}>
          Sign out
        </Button>
      </div>
    </Card>
  );
}

// ── the screen that admits it does not know ─────────────────────────────────

function UnavailableScreen({ account }: { account: AccountState }) {
  return (
    <>
      <EmptyState
        tone="problem"
        title="PANIK could not check your account"
        hint={
          account.error ??
          "The account service did not answer, so PANIK cannot tell whether your beta access is live."
        }
        action={
          <Button variant="outline" onClick={() => void account.reload()} disabled={account.busy}>
            {account.busy ? "Checking..." : "Try again"}
          </Button>
        }
      />
      <div className="flex justify-end">
        <Button variant="quiet" onClick={() => void account.signOut()} disabled={account.busy}>
          Sign out
        </Button>
      </div>
    </>
  );
}

// ── the gate itself ─────────────────────────────────────────────────────────

/**
 * One named screen in, one screen out. No chain, no re-derivation: whatever
 * `gateScreen(state)` decided in the shell is what renders here, so the two
 * cannot disagree about whether "we could not find out" is the same thing as
 * "you have no membership".
 */
export function AccountGate({
  screen,
  account,
  note,
  after,
}: {
  screen: GateScreen;
  account: AccountState;
  note?: string | null;
  /**
   * One block the HOSTING SURFACE owns, under the gate's card. /try passes its
   * socials card here so the scanned-card reader meets the same sign-in as
   * /app rather than a second one built around the extra block. `checking` has
   * no card to sit under, so it ignores this.
   */
  after?: React.ReactNode;
}) {
  if (screen === "checking") return <BootSkeleton />;
  return (
    <GateShell after={after}>
      {screen === "signin" ? (
        <SignInScreen account={account} note={note} />
      ) : screen === "unavailable" ? (
        <UnavailableScreen account={account} />
      ) : (
        <VoucherScreen account={account} />
      )}
    </GateShell>
  );
}
