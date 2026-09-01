/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Everyone who has redeemed anything, across every voucher batch, newest first.
 * One row is one person: the count at the top IS the user count, and the copy
 * button hands the whole list to a mailer in one go.
 *
 * The per-batch view (RedemptionsPanel) answers "who used THIS card and who
 * tried and failed". This one answers "how many people do we have".
 *
 * Two shapes for one list. From `md` it is a ledger; below that each record is
 * a stacked block, because four columns of email addresses and dates on a
 * 390px phone is a table that scrolls sideways rather than a table anyone
 * reads.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";

import { Button, EmptyState, Skeleton } from "../panik-core/ui";
import {
  Ledger,
  NotRecorded,
  Panel,
  PANEL_BODY,
  ReloadButton,
  StackedFact,
  StackedRow,
  Td,
  Th,
  Tr,
} from "./ui/controls";
import { EndTrialAction, isTrialLive, useLiveTrialEmails } from "./EndTrialAction";
import { isSignedOut, listGrants, type TrialGrant } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** A date, in the one face this product sets figures in. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function RosterPanel({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [grants, setGrants] = useState<TrialGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  /**
   * Which addresses still hold an OPEN membership. Not derivable from a row
   * here: `expires_at` on a grant is the campaign trial's own clock, and an
   * operator ending the membership it produced does not touch it. So the
   * server is asked, and a row whose address is absent from the answer gets no
   * End control.
   */
  const { live, reloadLive } = useLiveTrialEmails(session, onSignedOut);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listGrants(session);
    setLoading(false);
    if (res.ok && res.data) {
      setGrants(res.data.grants);
      setError("");
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setError(res.error ?? "Could not load the roster.");
    }
    // Both halves of a row's state, refreshed together: reloading the list
    // while keeping a stale live set is how a button outlives its trial.
    await reloadLive();
  }, [session, onSignedOut, reloadLive]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const emails = grants.map((g) => g.email).filter((e): e is string => Boolean(e));

  async function copyEmails() {
    if (emails.length === 0) return;
    try {
      await navigator.clipboard.writeText(emails.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the addresses are on screen and selectable */
    }
  }

  return (
    <Panel
      /* "On file", not "everyone who ever redeemed": trial_grants is pruned
         30 days after a trial expires, so this is the live contact list and
         the per-code counter on the Vouchers tab is the running total. */
      title={`Trials on file: ${loading && grants.length === 0 ? "..." : grants.length}`}
      actions={
        <>
          <Button variant="secondary" onClick={copyEmails} disabled={emails.length === 0}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied ? "Copied" : `Copy ${emails.length} email${emails.length === 1 ? "" : "s"}`}
          </Button>
          <ReloadButton onClick={refresh} label="Reload the roster" />
        </>
      }
    >
      {error ? (
        <div className={PANEL_BODY}>
          <EmptyState
            tone="problem"
            title="Could not load the roster"
            hint={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            }
          />
        </div>
      ) : loading && grants.length === 0 ? (
        <div className={`flex flex-col gap-3 ${PANEL_BODY}`}>
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : grants.length === 0 ? (
        <div className={PANEL_BODY}>
          <EmptyState
            tone="clear"
            title="Nobody has redeemed a card yet"
            hint="Emails land here the moment someone scans a card and starts a trial."
          />
        </div>
      ) : (
        <>
          <div className="hidden md:block">
            <Ledger
              minWidth="min-w-[48rem]"
              head={
                <>
                  <Th>Email</Th>
                  <Th>Voucher code</Th>
                  <Th>Redeemed</Th>
                  <Th>First opened</Th>
                  <Th>Action</Th>
                </>
              }
            >
              {grants.map((g, i) => (
                <Tr key={`${g.email ?? "none"}-${g.created_at}-${i}`}>
                  <Td className="font-sans font-bold text-text-primary">
                    {g.email ?? <NotRecorded>no email captured</NotRecorded>}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-text-secondary">
                    {g.campaign_code ?? <NotRecorded />}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-text-secondary">
                    {day(g.created_at)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-text-secondary">
                    {g.first_opened_at ? day(g.first_opened_at) : <NotRecorded>not opened yet</NotRecorded>}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <EndTrialAction
                      session={session}
                      email={g.email}
                      live={isTrialLive(live, g.email)}
                      onEnded={refresh}
                      onSignedOut={onSignedOut}
                    />
                  </Td>
                </Tr>
              ))}
            </Ledger>
          </div>

          <div className="md:hidden">
            {grants.map((g, i) => (
              <StackedRow
                key={`${g.email ?? "none"}-${g.created_at}-${i}`}
                lead={g.email ?? <NotRecorded>no email captured</NotRecorded>}
              >
                <StackedFact label="Voucher code">
                  {g.campaign_code ? (
                    <span className="font-mono">{g.campaign_code}</span>
                  ) : (
                    <NotRecorded />
                  )}
                </StackedFact>
                <StackedFact label="Redeemed">
                  <span className="font-mono">{day(g.created_at)}</span>
                </StackedFact>
                <StackedFact label="First opened">
                  {g.first_opened_at ? (
                    <span className="font-mono">{day(g.first_opened_at)}</span>
                  ) : (
                    <NotRecorded>not opened yet</NotRecorded>
                  )}
                </StackedFact>
                <EndTrialAction
                  session={session}
                  email={g.email}
                  live={isTrialLive(live, g.email)}
                  onEnded={refresh}
                  onSignedOut={onSignedOut}
                />
              </StackedRow>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
