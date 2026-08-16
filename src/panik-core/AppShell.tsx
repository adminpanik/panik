/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What stands in front of the dashboard, and the ONE place that decides it.
 *
 * Two independent questions have to be answered before the app exists:
 *
 *   WHICH WALLET may this browser be shown?   lib/session.ts  (SIWE or ?sid=)
 *   WHO is signed in, and is the beta open?   lib/account.ts  (Supabase Auth)
 *
 * They used to be asked inside AppDemo, which meant the answer arrived after
 * three thousand lines of hooks had already run. Every one of those hooks that
 * fetches - the compass catalog, the watchlist, prospective scores, the chain
 * read, the Telegram status - fired for a visitor who was about to be shown a
 * sign-in page and could not be shown anything else. Measured on this branch
 * before the move: four requests on load and three a minute afterwards, all of
 * them from a browser sitting at the gate. Mounting the dashboard only once the
 * gate is open is what takes that to zero, and no amount of care inside AppDemo
 * could have, because a React component cannot decline to run its own hooks.
 *
 * NOTHING HERE IS AN ACCESS BOUNDARY. Every screen below is a courtesy: the
 * server refuses an unauthenticated read on its own (server/accountAuth.ts
 * requireMember), and every wallet-scoped write signs its own action-bound
 * proof whatever this file renders. What this decides is which screen a person
 * meets, not what they are allowed to do.
 */

import { gateScreen, useAccountSession } from "./lib/account";
import { useSession } from "./lib/session";
import { AccountGate } from "./components/AccountGate";
import { AppDemo } from "./AppDemo";
import { BootSkeleton } from "./ui";

export function AppShell() {
  const session = useSession();
  const account = useAccountSession();

  /**
   * The wallet boot comes first and is wordless.
   *
   * Until GET /api/session answers, this app does not know whether the person
   * in front of it is a returning signed-in user or a first-time visitor, and
   * the two get different screens. It also cannot yet know whether a `?sid=`
   * was traded, which is the fact the precedence below turns on. Rendering
   * anything and correcting it a moment later is the worst option available: a
   * returning user watching the first-run overlay flash past learns that PANIK
   * forgot them.
   */
  if (session.status === "checking") return <BootSkeleton />;

  /**
   * ── THE PRECEDENCE, IN ONE PLACE ──────────────────────────────────────────
   *
   * A READ-ONLY WALLET SESSION OUTRANKS THE ACCOUNT GATE.
   *
   * A liquidation warning goes to whoever asked for it, and the person who taps
   * one may have no PANIK account at all. Putting a sign-in wall in front of a
   * `?sid=` reader would break the one message this product exists to deliver,
   * at the moment it matters most.
   *
   * That is not a way around the closed beta. A read-only scope is issued by
   * the SERVER against a single-use token it minted for one alert about one
   * wallet; the browser asserts nothing. It grants sight of that wallet and no
   * writes (`readOnlySession` inside AppDemo withholds every control whose
   * signature such a reader cannot produce), and the banner under the header
   * says so in words.
   *
   * ORDER MATTERS BOTH WAYS. This runs after the session boot above, so the
   * `?sid=` has already been traded and stripped from the URL and the scope is
   * settled. And the account gate is still evaluated for everyone else,
   * including a reader holding a FULL wallet session: signing a wallet message
   * says which address you are, never that the beta has let you in.
   *
   * A member who taps their own alert link satisfies both. They come through
   * here on the bypass and their account still renders in the header, because
   * the account session exists independently of how this tab was opened.
   */
  const readOnlySession = session.session?.scope === "readonly";
  const screen = gateScreen(account);
  if (screen !== null && !readOnlySession) {
    return <AccountGate screen={screen} account={account} note={session.note} />;
  }

  return <AppDemo session={session} account={account} />;
}
