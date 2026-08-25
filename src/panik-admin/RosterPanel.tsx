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
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";

import { Button, Card, EmptyState, Skeleton } from "../panik-core/ui";
import { NotRecorded, TableScroller, Th } from "./ui/controls";
import { isSignedOut, listGrants, type TrialGrant } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

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
  }, [session, onSignedOut]);

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
    <Card tone="panel" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* "On file", not "everyone who ever redeemed": trial_grants is pruned
            30 days after a trial expires, so this is the live contact list and
            the per-code counter on the cards below is the running total. */}
        <h2 className="text-base font-sans font-bold text-text-primary">
          Trials on file: {loading && grants.length === 0 ? "..." : grants.length}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" onClick={copyEmails} disabled={emails.length === 0}>
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : `Copy ${emails.length} email${emails.length === 1 ? "" : "s"}`}
          </Button>
          <Button variant="ghost" onClick={refresh} aria-label="Reload the roster">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Reload
          </Button>
        </div>
      </div>

      {error ? (
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
      ) : loading && grants.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : grants.length === 0 ? (
        <EmptyState
          tone="clear"
          title="Nobody has redeemed a card yet"
          hint="Emails land here the moment someone scans a card and starts a trial."
        />
      ) : (
        <TableScroller>
          <table className="w-full min-w-[36rem] text-left text-sm font-sans">
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Voucher code</Th>
                <Th>Redeemed</Th>
                <Th>First opened</Th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g, i) => (
                <tr key={`${g.email ?? "none"}-${g.created_at}-${i}`} className="border-t border-border-subtle">
                  <td className="py-2 pr-4 text-text-primary">
                    {g.email ?? <NotRecorded>no email captured</NotRecorded>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                    {g.campaign_code ?? <NotRecorded />}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                    {new Date(g.created_at).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                    {g.first_opened_at ? (
                      new Date(g.first_opened_at).toLocaleDateString()
                    ) : (
                      <NotRecorded>not opened yet</NotRecorded>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </Card>
  );
}
