/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * /admin - the internal console for the trial voucher cards.
 *
 * Three states and nothing between them: signed out (a form and nothing else),
 * signed in as somebody who is not the admin (a plain refusal, not a blank
 * page), and signed in as the admin (the manager).
 *
 * ── WHAT THIS FILE ENFORCES: NOTHING ──────────────────────────────────────
 * Which of the three renders is decided from a session in localStorage, which
 * the visitor owns. Editing it swaps the screen and gets no data: every call
 * the manager makes carries the Supabase access token, and the server resolves
 * that token with Supabase and refuses any address but the allow-listed one on
 * every single request (server/adminIdentity.ts). Hiding the UI is a courtesy
 * to the person who signed in with the wrong account, never a boundary.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";

import { Button, Card } from "../panik-core/ui";
import { SignIn } from "./SignIn";
import { ChangePassword } from "./ChangePassword";
import { CampaignsPanel } from "./CampaignsPanel";
import { MetricsPanel } from "./MetricsPanel";
import { RosterPanel } from "./RosterPanel";
import { SimulationPanel } from "./SimulationPanel";
import {
  ADMIN_EMAIL,
  ensureFresh,
  isAdminSession,
  loadSession,
  signOut,
  type Session,
} from "./lib/supabaseAuth";

export default function App() {
  // Restored synchronously so a reload does not flash the sign-in form at an
  // operator who is already signed in.
  const [session, setSession] = useState<Session | null>(() => loadSession());

  // A restored session may be minutes past its access-token lifetime. Renew it
  // once on mount so the first API call is not a guaranteed 401.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void ensureFresh(session).then((next) => {
      if (cancelled) return;
      if (!next) setSession(null);
      else if (next.accessToken !== session.accessToken) setSession(next);
    });
    return () => {
      cancelled = true;
    };
    // Only the identity of the stored session matters here, not every refresh
    // it goes through: depending on the whole object re-runs this on its own
    // result.
  }, [session?.refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Whether the password screen is showing. It opens by itself while the
   * account is still on the handover credential, so the operator lands on the
   * one thing that needs doing instead of having to find it.
   */
  const [changingPassword, setChangingPassword] = useState(false);
  /** "Not now" on the first-run prompt. Deliberately not persisted: the nudge
   *  comes back on the next sign-in until the credential is actually replaced. */
  const [promptDismissed, setPromptDismissed] = useState(false);

  const forget = useCallback(() => {
    setSession(null);
  }, []);

  const endSession = useCallback(async () => {
    const current = session;
    setSession(null);
    await signOut(current);
  }, [session]);

  if (!session) {
    return (
      <div className="min-h-screen bg-surface-base text-text-primary">
        <SignIn onSignedIn={setSession} />
      </div>
    );
  }

  const isAdmin = isAdminSession(session);
  // Opens on its own while the handover credential is still in force, so the
  // operator lands on the one thing that needs doing.
  const passwordPanelOpen =
    isAdmin && (changingPassword || (!session.passwordRotated && !promptDismissed));

  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
          <img src="/panik-logo.png" alt="" width={28} height={28} className="rounded-sm object-contain" />
          <span className="text-base font-sans font-bold text-text-primary">Admin</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="mr-1 hidden text-xs font-sans text-text-secondary sm:inline">{session.email}</span>
            {isAdmin && !passwordPanelOpen && (
              <Button variant="quiet" onClick={() => setChangingPassword(true)}>
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Password
              </Button>
            )}
            <Button variant="outline" onClick={endSession}>
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-8">
        {isAdmin ? (
          passwordPanelOpen ? (
            <ChangePassword
              session={session}
              firstRun={!session.passwordRotated}
              onChanged={setSession}
              onDismiss={() => {
                setChangingPassword(false);
                setPromptDismissed(true);
              }}
            />
          ) : (
            <>
              {/* Read-only, so it sits above the controls: an operator opening
                  dashboard.panik.fi wants the figures, and everything below
                  this line changes something. */}
              <MetricsPanel session={session} onSignedOut={forget} />
              {/* First of the controls, and deliberately: it is the only one
                  here that changes what every user of the app is looking at
                  right now. */}
              <SimulationPanel session={session} onSignedOut={forget} />
              <RosterPanel session={session} onSignedOut={forget} />
              <CampaignsPanel session={session} onSignedOut={forget} />
            </>
          )
        ) : (
          <Card tone="panel" className="mx-auto max-w-md">
            <h1 className="text-lg font-sans font-bold text-text-primary">This account cannot use admin</h1>
            <p className="mt-2 text-sm font-sans text-text-secondary">
              You are signed in as {session.email}. The console is limited to {ADMIN_EMAIL}. Sign out
              and try that account.
            </p>
            <Button variant="outline" className="mt-5" onClick={endSession}>
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> Sign out
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}
