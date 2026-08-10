/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who redeemed one voucher code, and everyone who tried and failed. The failed
 * attempts are half the value: a column of "batch used up" says the print run
 * was too small, and a column of "code not found" from one address says
 * somebody is guessing codes.
 *
 * ── PERSONAL DATA ─────────────────────────────────────────────────────────
 * The claim IP and browser string are personal data. They are here because the
 * operator asked to see who redeemed a card, and they go no further than this
 * screen: the route that serves them is admin-gated and rate limited, and
 * nothing on either side logs them.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, EmptyState, Skeleton } from "../panik-core/ui";
import { NotRecorded, StatusPill, TableScroller, Th } from "./ui/controls";
import {
  isSignedOut,
  listRedemptions,
  type CampaignRedemption,
  type RedeemOutcome,
  type RedemptionAttempt,
} from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/**
 * Plain-language outcome. The database stores engine enums (`not_found`,
 * `exhausted`); rendering those raw is the "wtf is approaching outside" bug the
 * design system was written to stop.
 */
const OUTCOME_LABEL: Record<RedeemOutcome, string> = {
  success: "Redeemed",
  not_found: "Code not found",
  disabled: "Code switched off",
  expired: "Claim window closed",
  exhausted: "Batch used up",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Full browser string in the hover, a readable stub in the cell. */
function shortAgent(agent: string | null): string | null {
  if (!agent) return null;
  return agent.length > 44 ? `${agent.slice(0, 44)}...` : agent;
}

export function RedemptionsPanel({
  session,
  code,
  onSignedOut,
}: {
  session: Session;
  code: string;
  onSignedOut: () => void;
}) {
  const [redemptions, setRedemptions] = useState<CampaignRedemption[]>([]);
  const [attempts, setAttempts] = useState<RedemptionAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await listRedemptions(session, code);
    setLoading(false);
    if (res.ok && res.data) {
      setRedemptions(res.data.redemptions);
      setAttempts(res.data.attempts);
      setError("");
    } else if (isSignedOut(res.status)) {
      onSignedOut();
    } else {
      setError(res.error ?? "Could not load redemptions.");
    }
  }, [session, code, onSignedOut]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const failed = attempts.filter((a) => a.outcome !== "success");

  if (loading && redemptions.length === 0 && attempts.length === 0) {
    return (
      <div className="mt-4 flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4">
        <EmptyState
          tone="problem"
          title="Could not load redemptions"
          hint={error}
          action={
            <Button variant="outline" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-5">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-sans font-bold text-text-primary">
            Redeemed by {redemptions.length}
          </h4>
          <Button variant="quiet" onClick={refresh} aria-label="Reload redemptions">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Reload
          </Button>
        </div>
        {redemptions.length === 0 ? (
          <EmptyState
            tone="clear"
            title="Nobody has redeemed this code yet"
            hint="Each scan that starts a trial shows up here with the email it was claimed with."
          />
        ) : (
          <TableScroller>
            <table className="w-full min-w-[40rem] text-left text-sm font-sans">
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Redeemed</Th>
                  <Th>First opened</Th>
                  <Th>Claim address</Th>
                  <Th>Browser</Th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map((r, i) => (
                  <tr key={`${r.created_at}-${i}`} className="border-t border-border-subtle">
                    <td className="py-2 pr-4 text-text-primary">
                      {r.email ?? <NotRecorded>no email captured</NotRecorded>}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {when(r.created_at)}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {r.first_opened_at ? when(r.first_opened_at) : <NotRecorded>not opened yet</NotRecorded>}
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">
                      {r.claim_ip ?? <NotRecorded />}
                    </td>
                    <td className="py-2 pr-4 text-text-secondary" title={r.claim_user_agent ?? undefined}>
                      {shortAgent(r.claim_user_agent) ?? <NotRecorded />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      <section>
        <h4 className="mb-2 text-sm font-sans font-bold text-text-primary">
          Attempts that did not redeem: {failed.length}
        </h4>
        {failed.length === 0 ? (
          <p className="text-xs font-sans text-text-secondary">
            Every attempt against this code succeeded.
          </p>
        ) : (
          <TableScroller>
            <table className="w-full min-w-[34rem] text-left text-sm font-sans">
              <thead>
                <tr>
                  <Th>Outcome</Th>
                  <Th>When</Th>
                  <Th>Address</Th>
                  <Th>Browser</Th>
                </tr>
              </thead>
              <tbody>
                {failed.map((a, i) => (
                  <tr key={`${a.created_at}-${i}`} className="border-t border-border-subtle">
                    <td className="py-2 pr-4">
                      <StatusPill tone="done">{OUTCOME_LABEL[a.outcome]}</StatusPill>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                      {when(a.created_at)}
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">{a.ip ?? <NotRecorded />}</td>
                    <td className="py-2 pr-4 text-text-secondary" title={a.user_agent ?? undefined}>
                      {shortAgent(a.user_agent) ?? <NotRecorded />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>
    </div>
  );
}
