/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The screens a reader can meet before the app: sign in, check your email,
 * enter your invite code, the one that says a trial has ended, the one that
 * says we could not find out, and the one that says they are in.
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
 *
 * ONE HEADING, ONE INPUT, ONE BUTTON, the same treatment `Settings` gets. Each
 * screen used to carry a sentence restating what its own heading and control
 * already said ("PANIK is in closed beta. Sign in first, then enter your
 * invite code.", "Your code was accepted."); none of it changed what a reader
 * did next, so it is gone by the three-way test in `docs/DESIGN_SYSTEM.md`.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, LogIn, Mail, Ticket, type LucideIcon } from "lucide-react";
import { BootSkeleton, Button, Card, EmptyState, Field, Notice } from "../ui";
import {
  endedMembership,
  formatGrantDate,
  normalizeVoucherCode,
  RESEND_COOLDOWN_MS,
  WAITLIST_URL,
  type AccountState,
  type GateScreen,
} from "../lib/account";

/** Every explanatory line on these screens reads the same. */
const PROSE = "text-xs font-sans leading-relaxed text-text-secondary";

/**
 * The Google mark, from Simple Icons (CC0), path data copied verbatim on a
 * 24x24 canvas (https://raw.githubusercontent.com/simple-icons/simple-icons/
 * develop/icons/google.svg). Never hand-drawn: an improvised G beside a real
 * product is the exact failure the icon rule in docs/DESIGN_SYSTEM.md exists
 * to stop.
 *
 * Drawn in `currentColor` rather than in Google's four brand colours: this
 * look has one brand accent (cobalt) and a four-colour mark on a neutral
 * secondary button would be the loudest saturated thing on a screen whose job
 * is to be calm. Sized to the button label's cap height (20px), matching every
 * other icon that sits beside text at this weight.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true">
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
      {/* The mark and the name. "Risk intelligence" used to sit under it as a
          tagline, which is a category rather than a claim: it told a reader
          nothing they could act on and nothing the product does. The heading
          below already says what this screen is for. */}
      <div className="flex items-center gap-2.5">
        <img src="/panik-mark.svg" alt="" width={32} height={32} style={{ objectFit: "contain" }} />
        <span className="font-sans text-lg font-extrabold leading-none text-text-primary">
          PANIK
        </span>
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
          We sent a one-time link to <span className="text-text-primary">{sent.to}</span>. Open it
          in this browser.
        </p>
        {message && <Notice text={message} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={send} disabled={account.busy || cooldown > 0}>
            {cooldown > 0 ? `Send another link in ${cooldown}s` : "Send another link"}
          </Button>
          <Button
            variant="ghost"
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

      {message && <Notice text={message} />}

      <Button
        variant="secondary"
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
        <Field
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

// ── 3. the invite code, and the two screens that ask for one ────────────────

/**
 * REDEEMING A CODE, ONCE, FOR BOTH SCREENS THAT DO IT.
 *
 * The first-time card and the trial-ended card ask the same question with
 * different framing, so they must not each own a copy of this: the
 * normalization, the `autoCorrect` the 2026-08-31 incident bought, and the
 * double-submit guard below are all one-mistake-away details, and the second
 * copy is where the mistake lands.
 *
 * It is held by `AccountGate` rather than by either card because the ANSWER
 * outlives the card: a successful redemption replaces the whole gate with the
 * cobalt screen, which is not a card and does not live inside the shell.
 */
function useRedeem(account: AccountState) {
  /**
   * A code the reader arrived holding, if they did: the `?code=` a scanned card
   * carried onto /try, kept by the account boot across the sign-in round trip.
   * Nobody is redeemed automatically - the code is typed into the box for them
   * and they press the control.
   */
  const [code, setCode] = useState(account.pendingVoucher ?? "");
  const [error, setError] = useState<string | null>(null);
  /** Whether the server has accepted a code on this screen. */
  const [redeemed, setRedeemed] = useState(false);

  /**
   * The second half of the double-submit guard, and the half `account.busy`
   * cannot be.
   *
   * `busy` is React state, so it is only true on the NEXT render. Two Enter
   * presses (or a click and an Enter) inside one frame both read the same stale
   * `canSubmit === true` from this closure and both reach the network. A ref
   * changes on the spot, before the second call can read it. On 2026-08-31 one
   * account posted the same code twice in sixteen seconds and wrote two rows to
   * trial_grants; the migration in that branch makes the SERVER refuse to spend
   * a second slot for it, which is where that has to be settled, and this stops
   * the browser sending the second request in the first place.
   */
  const inFlight = useRef(false);

  /** Same rule as the sign-in screen: one sentence, one place to look. */
  const message = error ?? account.error ?? null;

  /** The one predicate the guard and the control's disabled state both use. */
  const canSubmit = code.trim() !== "" && !account.busy;

  const submit = useCallback(async () => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
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
    } finally {
      inFlight.current = false;
    }
  }, [account, canSubmit, code]);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Normalized on every keystroke, so what the reader sees in the box is
      // exactly the string that will be posted. A field that accepts a
      // character and then quietly sends a different one is how a refusal
      // becomes unactionable: the code on screen looked right.
      setCode(normalizeVoucherCode(e.target.value));
      setError(null);
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void submit();
    },
    [submit],
  );

  return { code, message, canSubmit, submit, redeemed, onChange, onKeyDown };
}

type Redeem = ReturnType<typeof useRedeem>;

/**
 * The invite-code box, and the FOUR attributes that make it one.
 *
 * Mono, because it is a printed string a reader is copying character by
 * character off a card: the face that makes 0/O and 1/l tell themselves apart
 * is the one every address and hash in this product already uses.
 *
 * `autoCorrect="off"` is not a nicety. iOS "smart punctuation" lives under
 * autocorrect, not under spellcheck: with it on, typing PANIK-TRY-45QUHHUP into
 * a text field silently rewrites both hyphens as en dashes. That is the whole
 * of the 2026-08-31 incident, and it is why the field says so out loud rather
 * than relying on `normalizeVoucherCode` to clean up after it. One component
 * for both cards so a second card cannot ship without the attribute.
 */
function CodeField({ redeem, busy }: { redeem: Redeem; busy: boolean }) {
  return (
    <Field
      id="account-voucher"
      label="Invite code"
      mono
      type="text"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="characters"
      autoCorrect="off"
      value={redeem.code}
      disabled={busy}
      onChange={redeem.onChange}
      onKeyDown={redeem.onKeyDown}
    />
  );
}

/** The account this browser is signed in as, and the way back out of it. */
function GateFooter({ account }: { account: AccountState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
      <span className="min-w-0 truncate text-2xs font-sans text-text-muted">
        {account.account?.email ?? ""}
      </span>
      <Button variant="ghost" onClick={() => void account.signOut()} disabled={account.busy}>
        Sign out
      </Button>
    </div>
  );
}

/**
 * A FULL-PAGE navigation to the waitlist, driven from a button.
 *
 * The landing page owns that flow and duplicating it here would give this
 * product two places a person can be on a list, which is one more than anybody
 * can keep in step. `window.location.assign` rather than an `<a>` dressed as a
 * control: this look has exactly one button treatment (ui/Button) and a second
 * hand-built copy of the plate, edge and shadow is how the two drift apart.
 */
const goToWaitlist = () => window.location.assign(WAITLIST_URL);

/** The first-timer's card. Nobody here has ever held a grant. */
function VoucherScreen({ account, redeem }: { account: AccountState; redeem: Redeem }) {
  return (
    <Card tone="raised" className="space-y-4">
      <GateHeading icon={Ticket} title="Enter your invite code" />

      <div className="space-y-2">
        <CodeField redeem={redeem} busy={account.busy} />
        {redeem.message && <Notice text={redeem.message} />}
        <Button onClick={redeem.submit} disabled={!redeem.canSubmit} className="w-full justify-center">
          {account.busy ? "Checking..." : "Redeem code"}
        </Button>
      </div>

      <a
        href={WAITLIST_URL}
        className="inline-flex min-h-6 items-center gap-1.5 text-xs font-sans font-bold text-text-secondary hover:text-text-primary"
      >
        No code? Join the waitlist
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>

      <GateFooter account={account} />
    </Card>
  );
}

/**
 * The card for a reader whose grant is OVER.
 *
 * Until now this account met "Enter your invite code" with no explanation,
 * which is the app declining to mention the one thing that just happened to it.
 * The heading says what happened and the line under it says when, from
 * `endedMembership` - the row's own `expires_at`, whether the clock ran out or
 * an operator closed the grant (server/adminTrials.ts writes both columns). The
 * gate only chooses this screen when that date is readable, so the line under
 * the heading can never be blank or an invented "recently".
 *
 * The controls are the same three the first-time card offers, in the order this
 * reader needs them: redeem a new code, ask for one, or leave.
 */
function TrialEndedScreen({
  account,
  redeem,
  endedAt,
}: {
  account: AccountState;
  redeem: Redeem;
  endedAt: Date;
}) {
  return (
    <Card tone="raised" className="space-y-4">
      <div>
        {/* 20px is this system's largest heading step below the stat scale:
            `text-xl` is one of the sizes src/index.css resets to `initial`, so
            the name does not exist and typing it would render nothing. */}
        <h1 className="text-lg font-sans font-bold leading-tight text-text-primary">
          Your trial ended
        </h1>
        {/* Mono, like every other date and figure in the product, and in the
            same "Sep 1, 2026" shape the Settings ledger prints a deadline in. */}
        <p className="font-mono text-xs text-text-secondary">{formatGrantDate(endedAt)}</p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <CodeField redeem={redeem} busy={account.busy} />
          </div>
          <Button onClick={redeem.submit} disabled={!redeem.canSubmit}>
            {account.busy ? "Checking..." : "Redeem"}
          </Button>
        </div>
        {redeem.message && <Notice text={redeem.message} />}
      </div>

      <Card tone="set-back" className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-sans font-bold text-text-primary">No code?</span>
        <Button variant="secondary" onClick={goToWaitlist} disabled={account.busy}>
          Join the waitlist
        </Button>
      </Card>

      <GateFooter account={account} />
    </Card>
  );
}

/** What a reader is told once a code has been accepted. */
function RedeemedScreen({ account }: { account: AccountState }) {
  return (
    <Card tone="raised" className="space-y-3">
      <GateHeading icon={Check} title="You're in" />
      <p className={PROSE}>
        PANIK is open for{" "}
        <span className="text-text-primary">{account.account?.email ?? ""}</span>.
      </p>
      <Button
        onClick={() => void account.reload()}
        disabled={account.busy}
        className="w-full justify-center"
      >
        {account.busy ? "Opening..." : "Open PANIK"}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
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
          <Button variant="secondary" onClick={() => void account.reload()} disabled={account.busy}>
            {account.busy ? "Checking..." : "Try again"}
          </Button>
        }
      />
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => void account.signOut()} disabled={account.busy}>
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
 *
 * The ONE thing decided here and not there is the moment after a redemption.
 * `gateScreen` is a function of the account the server last reported, and the
 * server has not been re-asked yet: the reader is still `voucher` or
 * `trial-ended` to it, and stays so until they press Open PANIK. Which is the
 * point - the good news is shown, then the app is entered, rather than the
 * screen vanishing from under them.
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
  const redeem = useRedeem(account);
  /**
   * The date the trial-ended card is headed with, found by the SAME helper
   * `gateScreen` chose the screen with. Computed here rather than asserted
   * non-null inside the branch: if the two ever disagreed, the honest fallback
   * is the first-time card, not a heading with a hole in it.
   */
  const endedAt = account.account === null ? null : endedMembership(account.account);

  if (screen === "checking") return <BootSkeleton />;
  return (
    <GateShell after={after}>
      {redeem.redeemed ? (
        <RedeemedScreen account={account} />
      ) : screen === "signin" ? (
        <SignInScreen account={account} note={note} />
      ) : screen === "unavailable" ? (
        <UnavailableScreen account={account} />
      ) : screen === "trial-ended" && endedAt !== null ? (
        <TrialEndedScreen account={account} redeem={redeem} endedAt={endedAt} />
      ) : (
        <VoucherScreen account={account} redeem={redeem} />
      )}
    </GateShell>
  );
}
