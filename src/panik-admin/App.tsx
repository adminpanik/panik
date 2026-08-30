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
 * ── ONE PANEL AT A TIME ───────────────────────────────────────────────────
 * The five panels used to be a single stacked column, which meant an operator
 * opening the console to switch one voucher off scrolled past the dashboard,
 * the simulator and two rosters to reach it, and every one of those four
 * fetched on mount whether or not it was being looked at. They are tabs now:
 * one panel renders, the URL hash names it, and a reload or a shared link
 * lands on the same screen.
 *
 * ── WHAT THIS FILE ENFORCES: NOTHING ──────────────────────────────────────
 * Which of the three renders is decided from a session in localStorage, which
 * the visitor owns. Editing it swaps the screen and gets no data: every call
 * the manager makes carries the Supabase access token, and the server resolves
 * that token with Supabase and refuses any address but the allow-listed one on
 * every single request (server/adminIdentity.ts). Hiding the UI is a courtesy
 * to the person who signed in with the wrong account, never a boundary.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";

import { Button, Card, TabPanel } from "../panik-core/ui";
import { AdminHeader } from "./ui/controls";
import { SignIn } from "./SignIn";
import { ChangePassword } from "./ChangePassword";
import { CampaignsPanel } from "./CampaignsPanel";
import { MetricsPanel } from "./MetricsPanel";
import { RosterPanel } from "./RosterPanel";
import { SimulationPanel } from "./SimulationPanel";
import { UsersPanel } from "./UsersPanel";
import {
  ADMIN_EMAIL,
  ensureFresh,
  isAdminSession,
  loadSession,
  signOut,
  type Session,
} from "./lib/supabaseAuth";

/**
 * The five sections, in the order an operator meets them: what the product is
 * watching, the one control that changes what every user is looking at, the
 * two rosters that count people, and the vouchers that create them.
 *
 * The ids are the URL hash, so they are short lowercase words rather than
 * component names: `#vouchers` is a link somebody pastes into a chat.
 */
const TABS = [
  { id: "watching", label: "Watching" },
  { id: "simulator", label: "Simulator" },
  { id: "trials", label: "Trials" },
  { id: "accounts", label: "Accounts" },
  { id: "vouchers", label: "Vouchers" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB: TabId = "watching";

/** The hash as a tab, or the default. Anything unrecognised is the default. */
function tabFromHash(): TabId {
  const raw = window.location.hash.replace(/^#/, "");
  return TABS.some((t) => t.id === raw) ? (raw as TabId) : DEFAULT_TAB;
}

/**
 * Where you are, as a BLOCK, and the same two states the app shell uses: the
 * selected tab is a solid cobalt plate with white ink (5.03:1), every other
 * tab is flat black ink with a lavender wash on hover. Cobalt shares nothing
 * with the risk ramp, so the loudest block on the screen can never be read as
 * a verdict.
 */
const TAB_STATE = {
  selected: "bg-brand text-white",
  resting: "text-text-primary hover:bg-highlight",
} as const;

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

  /**
   * The open panel, seeded from the hash so a reload and a pasted link land in
   * the same place. The Back button works for the same reason: the hash is the
   * only copy of this fact, and the listener below adopts whatever it says.
   */
  const [tab, setTab] = useState<TabId>(() => tabFromHash());
  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    // Writing the hash fires `hashchange`, which sets the same value again.
    // Setting state here as well is what makes the swap immediate rather than
    // waiting a frame for the event.
    window.location.hash = id;
  }, []);

  // Arrow / Home / End navigation for the tablist. Focus has to be moved
  // explicitly: the roving tabindex means the newly selected tab is the only
  // one focusable, and without this the browser would leave focus on a button
  // that just became tabindex="-1".
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  /**
   * Keep the open tab visible in the strip. At 390px five words are 561px in a
   * 352px box, so a reload on `#vouchers` landed with the selected tab off the
   * right edge and nothing on screen saying which panel this was.
   * `block: "nearest"` so it never scrolls the PAGE, only the strip.
   */
  useEffect(() => {
    tabRefs.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    const id = TABS[next].id;
    selectTab(id);
    tabRefs.current[id]?.focus();
  };

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

  const signOutButton = (
    <Button variant="secondary" onClick={endSession}>
      <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> Sign out
    </Button>
  );

  return (
    <div className="min-h-screen bg-surface-base text-text-primary">
      <AdminHeader>
        {/* Wrappers rather than `hidden sm:inline-flex` on the buttons: `Button`
            already sets `inline-flex`, Tailwind emits `.inline-flex` after
            `.hidden`, and the control would stay on screen at 390px with the
            source saying it does not. */}
        <span className="hidden sm:block">
          <span className="mr-1 font-sans text-xs text-text-secondary">{session.email}</span>
        </span>
        {isAdmin && !passwordPanelOpen && (
          <span className="hidden sm:block">
            <Button variant="ghost" onClick={() => setChangingPassword(true)}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Password
            </Button>
          </span>
        )}
        {signOutButton}
      </AdminHeader>

      {isAdmin && !passwordPanelOpen && (
        <div className="mx-auto max-w-[1240px] px-4 pt-4 sm:px-8 sm:pt-8">
          {/* One block, five tabs, divided by the same 3px edge everything else
              on this look is drawn with. Below `sm` the strip scrolls inside
              itself: five words do not fit 358px, and the PAGE must never be
              the thing that travels sideways. From `sm` there is room for all
              five, so the strip stops pretending to be a full-width bar:
              `sm:w-fit` on the box and `sm:flex-none` on each tab shrink it to
              its own content instead of five equal columns stretched across
              the 1240px column. */}
          <div className="hard-edge overflow-x-auto bg-surface-raised sm:w-fit">
            <div
              role="tablist"
              aria-label="Admin sections"
              aria-orientation="horizontal"
              className="flex min-w-max"
              onKeyDown={onTabKeyDown}
            >
              {TABS.map(({ id, label }, i) => {
                const selected = tab === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    id={`tab-${id}`}
                    aria-selected={selected}
                    aria-controls={`panel-${id}`}
                    tabIndex={selected ? 0 : -1}
                    ref={(el) => {
                      tabRefs.current[id] = el;
                    }}
                    onClick={() => selectTab(id)}
                    className={`flex min-h-12 flex-1 sm:flex-none cursor-pointer items-center justify-center whitespace-nowrap px-5 py-3 label-type text-xs ${
                      i > 0 ? "border-l-[3px] border-border-strong" : ""
                    } ${TAB_STATE[selected ? "selected" : "resting"]}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto flex max-w-[1240px] flex-col gap-8 p-4 sm:p-8">
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
            <TabPanel key={tab} tab={tab} gap="space-y-8">
              {tab === "watching" && <MetricsPanel session={session} onSignedOut={forget} />}
              {tab === "simulator" && <SimulationPanel session={session} onSignedOut={forget} />}
              {tab === "trials" && <RosterPanel session={session} onSignedOut={forget} />}
              {tab === "accounts" && <UsersPanel session={session} onSignedOut={forget} />}
              {tab === "vouchers" && <CampaignsPanel session={session} onSignedOut={forget} />}
            </TabPanel>
          )
        ) : (
          <Card tone="raised" className="mx-auto w-full max-w-md">
            <h1 className="font-sans text-lg font-black uppercase tracking-tight text-text-primary">
              This account cannot use admin
            </h1>
            <p className="mt-2 font-sans text-sm text-text-secondary">
              You are signed in as {session.email}. The console is limited to {ADMIN_EMAIL}. Sign out
              and try that account.
            </p>
            <div className="mt-5">{signOutButton}</div>
          </Card>
        )}
      </main>
    </div>
  );
}
