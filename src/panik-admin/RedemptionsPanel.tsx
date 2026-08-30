/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who redeemed one voucher code, and everyone who tried and failed. The failed
 * attempts are half the value: a column of "batch used up" says the print run
 * was too small, and a column of "code not found" from one address says
 * somebody is guessing codes.
 *
 * ── WHY TWO NUMBERS DISAGREE, AND WHY THAT IS NOT A BUG ───────────────────
 * The row above this panel says "Redeemed 2 of 10" and this panel could say
 * "Redeemed by 0", which read as a contradiction and were reported as one.
 * They count different things and both are correct:
 *
 *   product_campaigns.redemption_count  a RUNNING TOTAL. The redeem RPC
 *                                       increments it once per successful
 *                                       redemption and nothing ever decrements
 *                                       it (20260704000001_product_codes.sql).
 *   trial_grants rows                   the CONTACT LIST. A pg_cron job deletes
 *                                       a grant 30 days after its trial
 *                                       expired, so a redemption from two
 *                                       months ago is counted above and gone
 *                                       from here.
 *
 * Neither can be made to equal the other without either losing the total or
 * keeping personal data past its retention window, so the gap is STATED
 * instead: the heading says how many are still on file, and a line below it
 * says how many more this code has taken and where they went. A panel that
 * said "Nobody has redeemed this code yet" over a counter reading 2 was the
 * actual defect.
 *
 * ── PERSONAL DATA ─────────────────────────────────────────────────────────
 * The claim IP and browser string are personal data. They are here because the
 * operator asked to see who redeemed a card, and they go no further than this
 * screen: the route that serves them is admin-gated and rate limited, and
 * nothing on either side logs them.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, Chip, EmptyState, Skeleton } from "../panik-core/ui";
import { Ledger, NotRecorded, StackedFact, StackedRow, Td, Th, Tr } from "./ui/controls";
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

/** A section heading inside the drill-down. Label type at the 11px floor. */
const SECTION = "label-type text-2xs text-text-muted";

export function RedemptionsPanel({
  session,
  code,
  redemptionCount,
  onSignedOut,
}: {
  session: Session;
  code: string;
  /**
   * The campaign's own running total, so this panel can explain its own
   * shortfall rather than leaving the reader to spot it. See the header.
   */
  redemptionCount: number;
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

  /**
   * Redemptions this code has taken that are no longer on file. Floored at
   * zero: a grant inserted between the campaign list load and this fetch would
   * otherwise render "-1 cleared", which is a fact about a race rather than
   * about the data.
   */
  const clearedOff = Math.max(0, redemptionCount - redemptions.length);
  const clearedLine =
    clearedOff > 0
      ? `This code has been redeemed ${redemptionCount} time${redemptionCount === 1 ? "" : "s"} in total. ` +
        `${clearedOff} of those trial${clearedOff === 1 ? " has" : "s have"} expired and been cleared from the contact list, which happens 30 days after a trial ends.`
      : null;

  if (loading && redemptions.length === 0 && attempts.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        tone="problem"
        title="Could not load redemptions"
        hint={error}
        action={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section>
        {/* `flex-nowrap` and a truncating caption, not `flex-wrap`: at 390px
            the caption and Reload used to wrap onto two lines the moment the
            "Redeemed by N, still on file" sentence grew past the width left
            beside the button. The caption gives way instead, and below `sm`
            Reload sheds its word and becomes the icon alone. */}
        <div className="mb-2 flex flex-nowrap items-center justify-between gap-3">
          <h4 className={`min-w-0 truncate ${SECTION}`}>
            Redeemed by {redemptions.length}, still on file
          </h4>
          <Button variant="ghost" onClick={refresh} aria-label="Reload" className="shrink-0">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Reload</span>
          </Button>
        </div>
        {clearedLine ? (
          <p className="mb-2 max-w-[640px] font-sans text-xs text-text-secondary">{clearedLine}</p>
        ) : null}
        {redemptions.length === 0 ? (
          <EmptyState
            tone="clear"
            title={clearedOff > 0 ? "No redemptions still on file" : "Nobody has redeemed this code yet"}
            hint={
              clearedOff > 0
                ? "The emails this code captured have passed their retention window. The total above is what it has taken."
                : "Each scan that starts a trial shows up here with the email it was claimed with."
            }
          />
        ) : (
          <>
            <div className="hidden md:block hard-edge bg-surface-raised">
              <Ledger
                minWidth="min-w-[44rem]"
                head={
                  <>
                    <Th>Email</Th>
                    <Th>Redeemed</Th>
                    <Th>First opened</Th>
                    <Th>Claim address</Th>
                    <Th>Browser</Th>
                  </>
                }
              >
                {redemptions.map((r, i) => (
                  <Tr key={`${r.created_at}-${i}`}>
                    <Td className="font-sans font-bold text-text-primary">
                      {r.email ?? <NotRecorded>no email captured</NotRecorded>}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {when(r.created_at)}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {r.first_opened_at ? when(r.first_opened_at) : <NotRecorded>not opened yet</NotRecorded>}
                    </Td>
                    <Td className="font-mono text-text-secondary">{r.claim_ip ?? <NotRecorded />}</Td>
                    <Td className="font-sans text-text-secondary" title={r.claim_user_agent ?? undefined}>
                      {shortAgent(r.claim_user_agent) ?? <NotRecorded />}
                    </Td>
                  </Tr>
                ))}
              </Ledger>
            </div>

            <div className="md:hidden hard-edge bg-surface-raised">
              {redemptions.map((r, i) => (
                <StackedRow
                  key={`${r.created_at}-${i}`}
                  lead={r.email ?? <NotRecorded>no email captured</NotRecorded>}
                >
                  <StackedFact label="Redeemed">
                    <span className="font-mono">{when(r.created_at)}</span>
                  </StackedFact>
                  <StackedFact label="First opened">
                    {r.first_opened_at ? (
                      <span className="font-mono">{when(r.first_opened_at)}</span>
                    ) : (
                      <NotRecorded>not opened yet</NotRecorded>
                    )}
                  </StackedFact>
                  <StackedFact label="Claim address">
                    {r.claim_ip ? <span className="font-mono">{r.claim_ip}</span> : <NotRecorded />}
                  </StackedFact>
                  <StackedFact label="Browser">
                    {shortAgent(r.claim_user_agent) ?? <NotRecorded />}
                  </StackedFact>
                </StackedRow>
              ))}
            </div>
          </>
        )}
      </section>

      <section>
        <h4 className={`mb-2 ${SECTION}`}>Attempts that did not redeem: {failed.length}</h4>
        {failed.length === 0 ? (
          <p className="font-sans text-xs text-text-secondary">
            Every attempt against this code succeeded.
          </p>
        ) : (
          <>
            <div className="hidden md:block hard-edge bg-surface-raised">
              <Ledger
                minWidth="min-w-[38rem]"
                head={
                  <>
                    <Th>Outcome</Th>
                    <Th>When</Th>
                    <Th>Address</Th>
                    <Th>Browser</Th>
                  </>
                }
              >
                {failed.map((a, i) => (
                  <Tr key={`${a.created_at}-${i}`}>
                    <Td>
                      {/* `whitespace-nowrap` because the outcome column is the
                          narrowest in the table and a wrapped chip breaks out
                          of its own 24px box. */}
                      <Chip className="whitespace-nowrap">{OUTCOME_LABEL[a.outcome]}</Chip>
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {when(a.created_at)}
                    </Td>
                    <Td className="font-mono text-text-secondary">{a.ip ?? <NotRecorded />}</Td>
                    <Td className="font-sans text-text-secondary" title={a.user_agent ?? undefined}>
                      {shortAgent(a.user_agent) ?? <NotRecorded />}
                    </Td>
                  </Tr>
                ))}
              </Ledger>
            </div>

            <div className="md:hidden hard-edge bg-surface-raised">
              {failed.map((a, i) => (
                <StackedRow
                  key={`${a.created_at}-${i}`}
                  lead={<Chip className="whitespace-nowrap">{OUTCOME_LABEL[a.outcome]}</Chip>}
                >
                  <StackedFact label="When">
                    <span className="font-mono">{when(a.created_at)}</span>
                  </StackedFact>
                  <StackedFact label="Address">
                    {a.ip ? <span className="font-mono">{a.ip}</span> : <NotRecorded />}
                  </StackedFact>
                  <StackedFact label="Browser">
                    {shortAgent(a.user_agent) ?? <NotRecorded />}
                  </StackedFact>
                </StackedRow>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
