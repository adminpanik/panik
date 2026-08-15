/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The four screens a reader can meet before the app: sign in, check your email,
 * enter your invite code, and the one that says we could not find out.
 *
 * WHY THE COLOUR IS NEUTRAL, AGAIN. Being outside a closed beta is not a risk
 * state. A wrong invite code is not a liquidation and "you are in" is not good
 * news about anyone's positions, so the risk ramp is spent on none of this
 * (docs/DESIGN_SYSTEM.md). The only token borrowed from it is `risk-unknown`,
 * which is a grey and whose whole meaning is "we could not find out" — the
 * dashed-edge treatment `EmptyState tone="problem"` uses, reused here so a
 * failed read looks the same everywhere it appears.
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
import { AlertTriangle, ArrowRight, Check, LogIn, Mail, Ticket } from "lucide-react";
import { Button, Card, EmptyState, Skeleton } from "../ui";
import {
  RESEND_COOLDOWN_MS,
  WAITLIST_URL,
  type AccountState,
} from "../lib/account";

/** Every explanatory line on these screens reads the same. */
const PROSE = "text-xs font-sans leading-relaxed text-text-secondary";

/** The one input treatment, borrowed verbatim from `components/WalletsPanel`. */
const FIELD =
  "h-10 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-sans text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50";

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
 * A thing that did not work, in one line.
 *
 * `role="alert"`, not `status`: it answers a control the reader just pressed and
 * replaces the outcome they were expecting, so it is worth interrupting for.
 */
function Notice({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-dashed border-risk-unknown/40 px-3 py-2 text-xs font-sans leading-relaxed text-text-secondary"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-risk-unknown" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </p>
  );
}

/**
 * The page every gate screen sits on. One column, capped and centred, on the
 * page's own surface, with the brand block the sidebar carries once the app is
 * open. `min-h-screen` rather than `h-screen` so a short viewport scrolls
 * instead of clipping the control at the bottom of the card.
 */
function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-surface-base px-4 py-10 font-sans text-sm text-text-primary antialiased">
      <div className="flex items-center gap-2.5">
        <img src="/panik-logo.png" alt="" width={32} height={32} style={{ objectFit: "contain" }} />
        <div className="flex flex-col">
          <span className="text-lg font-sans font-extrabold leading-none text-text-primary">PANIK</span>
          <span className="mt-0.5 text-2xs font-sans text-text-muted">Risk intelligence</span>
        </div>
      </div>
      <div className="w-full max-w-md space-y-4">{children}</div>
    </div>
  );
}

function GateHeading({ icon: Icon, title }: { icon: typeof Mail; title: string }) {
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

/** Seconds left on the resend cooldown, ticking down to zero. */
function useCooldown(startedAt: number | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (startedAt === null) {
      setLeft(0);
      return;
    }
    const tick = () =>
      setLeft(Math.max(0, Math.ceil((startedAt + RESEND_COOLDOWN_MS - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return left;
}

export function SignInScreen({
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
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useCooldown(sentAt);

  const send = useCallback(async () => {
    if (!plausibleEmail(email) || account.busy) return;
    setError(null);
    const result = await account.sendLink(email);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSentTo(email.trim().toLowerCase());
    setSentAt(Date.now());
  }, [account, email]);

  if (!account.configured) {
    return (
      <GateShell>
        <EmptyState
          tone="problem"
          title="Sign-in is not available here"
          hint="This deployment has no sign-in service configured, so PANIK cannot open an account for you."
        />
      </GateShell>
    );
  }

  if (sentTo) {
    return (
      <GateShell>
        <Card tone="raised" className="space-y-3">
          <GateHeading icon={Mail} title="Check your email" />
          <p className={PROSE}>
            We sent a sign-in link to <span className="text-text-primary">{sentTo}</span>. Open it in
            this browser to finish signing in.
          </p>
          <p className={PROSE}>The link can be used once.</p>
          {error && <Notice text={error} />}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={send} disabled={account.busy || cooldown > 0}>
              {cooldown > 0 ? `Send another link in ${cooldown}s` : "Send another link"}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setSentTo(null);
                setSentAt(null);
                setError(null);
              }}
            >
              Use a different address
            </Button>
          </div>
        </Card>
      </GateShell>
    );
  }

  return (
    <GateShell>
      <Card tone="raised" className="space-y-4">
        <GateHeading icon={LogIn} title="Sign in to PANIK" />
        {/* Keep-inline by the three-way test: it is the only place a first-time
            visitor learns that an account alone is not enough, and knowing it
            before signing in is what stops the next screen reading as a
            rejection. */}
        <p className={PROSE}>
          PANIK is in closed beta. Sign in first, then enter your invite code.
        </p>

        {note && <Notice text={note} />}
        {account.error && <Notice text={account.error} />}

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
          <label htmlFor="account-email" className="block text-xs font-sans font-bold text-text-primary">
            Email
          </label>
          <input
            id="account-email"
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
            className={FIELD}
          />
          {error && <Notice text={error} />}
          <Button
            onClick={send}
            disabled={account.busy || !plausibleEmail(email)}
            className="w-full justify-center"
          >
            {account.busy ? "Sending..." : "Send sign-in link"}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <p className={PROSE}>We email a one-time link. There is no password to set.</p>
        </div>
      </Card>
    </GateShell>
  );
}

// ── 3. the invite code ──────────────────────────────────────────────────────

export function VoucherScreen({ account }: { account: AccountState }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const email = account.account?.email ?? "";

  const submit = useCallback(async () => {
    if (code.trim() === "" || account.busy) return;
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
  }, [account, code]);

  if (redeemed) {
    return (
      <GateShell>
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
      </GateShell>
    );
  }

  return (
    <GateShell>
      <Card tone="raised" className="space-y-4">
        <GateHeading icon={Ticket} title="Enter your invite code" />
        <p className={PROSE}>
          PANIK is in closed beta. Your code opens it for this account.
        </p>

        <div className="space-y-2">
          <label htmlFor="account-voucher" className="block text-xs font-sans font-bold text-text-primary">
            Invite code
          </label>
          <input
            id="account-voucher"
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
            className={FIELD}
          />
          {error && <Notice text={error} />}
          <Button
            onClick={submit}
            disabled={account.busy || code.trim() === ""}
            className="w-full justify-center"
          >
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
    </GateShell>
  );
}

// ── the screen that admits it does not know ─────────────────────────────────

function UnavailableScreen({ account }: { account: AccountState }) {
  return (
    <GateShell>
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
    </GateShell>
  );
}

// ── the gate itself ─────────────────────────────────────────────────────────

/**
 * Which of the four screens this account state produces.
 *
 * The order is the point, and each branch is a DIFFERENT thing being unknown:
 *
 *   checking      we have not asked yet          -> nothing, wordlessly
 *   no session    nobody is signed in            -> sign in
 *   no account    we asked and could not find out -> say so, offer a retry
 *   not a member  we asked and the answer is no  -> the invite code
 *
 * Collapsing the third into the fourth is the failure this shape exists to
 * stop: a 502 from the account service would otherwise render as "enter your
 * invite code" at a paying member, which is the app stating a fact it does not
 * know (docs/DESIGN_SYSTEM.md).
 */
export function AccountGate({ account, note }: { account: AccountState; note?: string | null }) {
  if (account.status !== "resolved") {
    /* Wordless, for the reason the session boot gate gives: every sentence
       available here would be a claim about an answer that has not arrived. */
    return (
      <div
        aria-busy="true"
        className="flex min-h-screen w-full items-center justify-center bg-surface-base p-6"
      >
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    );
  }
  if (account.session === null) return <SignInScreen account={account} note={note} />;
  if (account.account === null) return <UnavailableScreen account={account} />;
  return <VoucherScreen account={account} />;
}
