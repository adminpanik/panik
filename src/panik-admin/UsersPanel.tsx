/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Everyone who has an account, newest first. One row is one person who signed
 * up, which is a different question from the one RosterPanel above answers:
 * that list is card redemptions (who scanned a voucher), this one is the
 * closed-beta identity (who exists, what access they hold, what they connected).
 *
 * NOTHING HERE IS COLOURED. Not being in the beta is an inventory fact, not a
 * risk band, and the five risk hues mean liquidation risk everywhere else in
 * the product. The words carry the meaning on their own.
 *
 * The heading counts the rows on screen and says so: GoTrue hands back
 * `hasMore` and no total, so a bare number beside "Accounts" would be a total
 * this code does not have.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button, Card, EmptyState, Skeleton } from "../panik-core/ui";
import { NotRecorded, TableScroller, Th } from "./ui/controls";
import { describeAccess, isSignedOut, listAccounts, type AccountSummary } from "./lib/adminApi";
import type { Session } from "./lib/supabaseAuth";

/** One request's worth. The server's own default, and its ceiling is 200. */
const PER_PAGE = 50;

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

  return (
    <Card tone="panel" className="mb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-sans font-bold text-text-primary">
          Accounts: {loading && users.length === 0 ? "..." : users.length}
          {hasMore ? (
            <span className="ml-2 text-xs font-normal text-text-muted">(more available)</span>
          ) : null}
        </h2>
        <Button variant="ghost" className="ml-auto" onClick={reload} aria-label="Reload the accounts">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Reload
        </Button>
      </div>

      {error ? (
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
      ) : loading && users.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState
          tone="clear"
          title="Nobody has signed up yet"
          hint="Accounts land here the moment someone creates one, beta access or not."
        />
      ) : (
        <>
          <TableScroller>
            <table className="w-full min-w-[52rem] text-left text-sm font-sans">
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Beta access</Th>
                  <Th>Voucher</Th>
                  <Th>Wallets</Th>
                  <Th>Telegram</Th>
                  <Th>Signed up</Th>
                  <Th>Last sign-in</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const access = describeAccess(u);
                  return (
                    <tr key={u.userId} className="border-t border-border-subtle">
                      <td className="py-2 pr-4 text-text-primary">
                        {u.email ?? <NotRecorded>no email on file</NotRecorded>}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                        {access.label}
                        {/* A real space, not the block's own line break: a
                            screen reader reads the two runs back to back and
                            would otherwise say "Trialuntil". */}
                        {access.detail ? (
                          <>
                            {" "}
                            <span className="block text-xs text-text-muted">{access.detail}</span>
                          </>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 font-mono text-text-secondary">
                        {u.membership?.voucherCode ?? <NotRecorded />}
                      </td>
                      {/* A measured zero, so stating it is allowed. It is
                          worded rather than digited because a bare 0 in a
                          column of counts is the shape "we do not know" takes
                          everywhere else in this product. */}
                      <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                        {u.walletCount === 0 ? "None" : u.walletCount}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                        {u.telegramLinked ? "Linked" : "Not linked"}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                        {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : <NotRecorded />}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 text-text-secondary">
                        {u.lastSignInAt ? (
                          new Date(u.lastSignInAt).toLocaleDateString()
                        ) : (
                          <NotRecorded>never signed in</NotRecorded>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroller>

          {hasMore ? (
            <div className="mt-4">
              <Button variant="secondary" onClick={() => load(page + 1, true)} disabled={loading}>
                {loading ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
