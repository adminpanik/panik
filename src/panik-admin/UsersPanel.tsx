/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Everyone who has an account, newest first. One row is one person who signed
 * up, which is a different question from the one RosterPanel answers: that list
 * is card redemptions (who scanned a voucher), this one is the closed-beta
 * identity (who exists, what access they hold, what they connected).
 *
 * NOTHING HERE IS COLOURED. Not being in the beta is an inventory fact, not a
 * risk band, and the five risk hues mean liquidation risk everywhere else in
 * the product. Beta access is a neutral `Chip`: the same white plate, black
 * edge and black ink every other marker in the product wears, and the WORD
 * carries the meaning on its own (WCAG 1.4.1).
 *
 * The heading counts the rows on screen and says so: GoTrue hands back
 * `hasMore` and no total, so a bare number beside "Accounts" would be a total
 * this code does not have.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, Chip, EmptyState, Skeleton } from "../panik-core/ui";
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
import { describeAccess, isSignedOut, listAccounts, type AccountSummary } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** One request's worth. The server's own default, and its ceiling is 200. */
const PER_PAGE = 50;

function day(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

export function UsersPanel({
  session,
  onSignedOut,
}: {
  session: Session;
  onSignedOut: () => void;
}) {
  const [users, setUsers] = useState<AccountSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /**
   * Page 1 replaces, later pages append. `append` is a parameter rather than
   * state so a reload mid-scroll cannot land a first page on top of the rows
   * it was meant to replace.
   */
  const load = useCallback(
    async (next: number, append: boolean) => {
      setLoading(true);
      const res = await listAccounts(session, next, PER_PAGE);
      setLoading(false);
      const data = res.data;
      if (res.ok && data) {
        setUsers((prev) => (append ? [...prev, ...data.users] : data.users));
        setPage(next);
        setHasMore(data.hasMore);
        setError("");
      } else if (isSignedOut(res.status)) {
        onSignedOut();
      } else {
        setError(res.error ?? "Could not load the accounts.");
      }
    },
    [session, onSignedOut],
  );

  const reload = useCallback(() => load(1, false), [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const title = `Accounts: ${loading && users.length === 0 ? "..." : users.length}${
    hasMore ? " (more available)" : ""
  }`;

  return (
    <Panel title={title} actions={<ReloadButton onClick={reload} label="Reload the accounts" />}>
      {error ? (
        <div className={PANEL_BODY}>
          <EmptyState
            tone="problem"
            title="Could not load the accounts"
            hint={error}
            action={
              <Button variant="secondary" onClick={reload}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            }
          />
        </div>
      ) : loading && users.length === 0 ? (
        <div className={`flex flex-col gap-3 ${PANEL_BODY}`}>
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : users.length === 0 ? (
        <div className={PANEL_BODY}>
          <EmptyState
            tone="clear"
            title="Nobody has signed up yet"
            hint="Accounts land here the moment someone creates one, beta access or not."
          />
        </div>
      ) : (
        <>
          <div className="hidden md:block">
            <Ledger
              minWidth="min-w-[56rem]"
              head={
                <>
                  <Th>Email</Th>
                  <Th>Beta access</Th>
                  <Th>Voucher</Th>
                  <Th>Wallets</Th>
                  <Th>Telegram</Th>
                  <Th>Signed up</Th>
                  <Th>Last sign-in</Th>
                </>
              }
            >
              {users.map((u) => {
                const access = describeAccess(u);
                return (
                  <Tr key={u.userId}>
                    <Td className="font-sans font-bold text-text-primary">
                      {u.email ?? <NotRecorded>no email on file</NotRecorded>}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Chip>{access.label}</Chip>
                      {/* A block under the chip rather than a clause inside it:
                          prose in a marker renders clipped the moment anything
                          truncates it. */}
                      {access.detail ? (
                        <span className="mt-1 block font-sans text-xs text-text-muted">
                          {access.detail}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {u.membership?.voucherCode ?? <NotRecorded />}
                    </Td>
                    {/* A measured zero, so stating it is allowed. It is
                        worded rather than digited because a bare 0 in a
                        column of counts is the shape "we do not know" takes
                        everywhere else in this product. */}
                    <Td className="whitespace-nowrap text-text-secondary">
                      {u.walletCount === 0 ? (
                        "None"
                      ) : (
                        <span className="font-mono">{u.walletCount}</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap font-sans text-text-secondary">
                      {u.telegramLinked ? "Linked" : "Not linked"}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {u.createdAt ? day(u.createdAt) : <NotRecorded />}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-text-secondary">
                      {u.lastSignInAt ? day(u.lastSignInAt) : <NotRecorded>never signed in</NotRecorded>}
                    </Td>
                  </Tr>
                );
              })}
            </Ledger>
          </div>

          <div className="md:hidden">
            {users.map((u) => {
              const access = describeAccess(u);
              return (
                <StackedRow
                  key={u.userId}
                  lead={u.email ?? <NotRecorded>no email on file</NotRecorded>}
                >
                  <span className="flex flex-wrap items-center gap-2 font-sans text-xs text-text-secondary">
                    <Chip>{access.label}</Chip>
                    {access.detail ? <span className="text-text-muted">{access.detail}</span> : null}
                  </span>
                  <StackedFact label="Voucher">
                    {u.membership?.voucherCode ? (
                      <span className="font-mono">{u.membership.voucherCode}</span>
                    ) : (
                      <NotRecorded />
                    )}
                  </StackedFact>
                  <StackedFact label="Wallets">
                    {u.walletCount === 0 ? "None" : <span className="font-mono">{u.walletCount}</span>}
                  </StackedFact>
                  <StackedFact label="Telegram">
                    {u.telegramLinked ? "Linked" : "Not linked"}
                  </StackedFact>
                  <StackedFact label="Signed up">
                    {u.createdAt ? <span className="font-mono">{day(u.createdAt)}</span> : <NotRecorded />}
                  </StackedFact>
                  <StackedFact label="Last sign-in">
                    {u.lastSignInAt ? (
                      <span className="font-mono">{day(u.lastSignInAt)}</span>
                    ) : (
                      <NotRecorded>never signed in</NotRecorded>
                    )}
                  </StackedFact>
                </StackedRow>
              );
            })}
          </div>

          {hasMore ? (
            <div className="border-t-[3px] border-border-strong p-4">
              <Button variant="secondary" onClick={() => load(page + 1, true)} disabled={loading}>
                {loading ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
