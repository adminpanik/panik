/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The watchlist, client side: the wallets PANIK watches for one owner, and the
 * ONE path in the browser that changes them.
 *
 * ONE SIGNATURE PER SAVE, NOT PER ROW. The API takes a batch of add / update /
 * remove operations behind a single `watchlist-manage` proof (scripts/api-server
 * .ts), so the UI stages edits locally and turns the whole staged set into one
 * request. A per-row save would be a wallet popup per row, and - worse - a
 * half-applied list if the user dismissed the third of five.
 *
 * THE SIGNING PATH IS `useWalletOwnership`, not a second copy of it. `getProof`
 * arrives as an argument for exactly that reason: nonce fetch, message build and
 * `personal_sign` already live in ./telegram.ts and are shared byte-for-byte
 * with the verifier through `server/siweProof.ts`.
 *
 * THE CAP AND THE LABEL LENGTH COME FROM THE SERVER. `WATCHLIST_MAX` lives in
 * `server/watchlist.ts` and in the `register_watched_wallet` RPC, and a third
 * copy compiled into a browser bundle is the one nobody would think to update:
 * the counter on the panel TEACHES the number ("3 of 10 watched"), so a raised
 * cap would have the UI stating a wrong one with nothing visibly broken. The GET
 * response carries both, and the panel simply has no add form until it has read
 * them.
 *
 * Types are imported from `server/watchlist.ts` with `import type`, which is
 * erased before the bundler sees it - the module itself is NOT browser-safe (it
 * reaches `server/profileDeps.ts`, hence pg and the providers), so nothing here
 * may import a value from it.
 */

import { useCallback, useEffect, useState } from "react";
import type { RiskProfile } from "../../../packages/scoring/src/types";
import type { WatchOp, WatchSubscription } from "../../../server/watchlist";
import { noWalletAvailable, OwnershipError, rejectedSignature, type GetProof } from "./telegram";

export type { WatchOp, WatchSubscription };

/** GET /api/watchlist. `max` / `labelMax` are the server's own limits. */
interface WatchlistWire {
  updatedAt: number;
  watching: WatchSubscription[];
  max: number;
  labelMax: number;
}

/**
 * What the panel knows about the list right now.
 *
 * `subscriptions === null` and `offline` are separate for the reason every other
 * feed in this app separates them: a list we have not read yet and a list we
 * could not read are both "no wallets" to an array length, and only one of them
 * is good news. An unreachable watchlist rendered as an empty one tells someone
 * PANIK is watching nothing at the moment it cannot say.
 */
export interface WatchlistState {
  subscriptions: WatchSubscription[] | null;
  /** Null until the first successful read; never a hardcoded fallback. */
  max: number | null;
  labelMax: number | null;
  loading: boolean;
  offline: boolean;
  /** Adopt the list a save returned, so the panel does not wait for a refetch. */
  replace: (watching: WatchSubscription[]) => void;
  reload: () => void;
}

/**
 * One owner's watchlist. Fetched on mount and on an owner change, and NOT
 * polled: this list changes when the user changes it, and every change comes
 * back on the response that made it. A 60s poll would spend the wallet limiter's
 * budget re-reading a list nobody else can write.
 */
export function useWatchlist(owner: string | null): WatchlistState {
  const [data, setData] = useState<WatchlistWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Never show the previous owner's list while the new read is in flight.
    setData(null);
    setOffline(false);
    if (!owner) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/watchlist?owner=${encodeURIComponent(owner.toLowerCase())}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as WatchlistWire;
        if (cancelled) return;
        setData(body);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, nonce]);

  const replace = useCallback((watching: WatchSubscription[]) => {
    // Only the list moves. `max` and `labelMax` are the server's limits and are
    // not re-stated by the write path, so they keep whatever the read reported.
    setData((prev) => (prev ? { ...prev, watching, updatedAt: Date.now() } : prev));
    setOffline(false);
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    subscriptions: data?.watching ?? null,
    max: data?.max ?? null,
    labelMax: data?.labelMax ?? null,
    loading,
    offline,
    replace,
    reload,
  };
}

/** The subscription covering one wallet, or null when the list does not hold it. */
export function subscriptionFor(
  list: readonly WatchSubscription[] | null,
  wallet: string | null,
): WatchSubscription | null {
  if (!list || !wallet) return null;
  const target = wallet.trim().toLowerCase();
  return list.find((s) => s.wallet.toLowerCase() === target) ?? null;
}

// ── staging ──────────────────────────────────────────────────────────────────

/**
 * One row of the editor.
 *
 * `label` is a plain string because that is what an input holds; the empty
 * string is "no label" and is what the server's `null` reads back as. The
 * absent-vs-null distinction the API cares about is reconstructed in
 * `stagedOps` from the comparison, not carried around as a third state.
 */
export interface WatchDraftRow {
  /** Lowercase, always. The API lowercases too; agreeing avoids a phantom diff. */
  wallet: string;
  profile: RiskProfile;
  label: string;
  /** Staged locally and not yet on the server. */
  isNew: boolean;
  /** Staged for removal. Kept in the list so the row can be put back. */
  removed: boolean;
}

export function draftFromSubscriptions(list: readonly WatchSubscription[]): WatchDraftRow[] {
  return list.map((s) => ({
    wallet: s.wallet.toLowerCase(),
    profile: s.profile,
    label: s.label ?? "",
    isNew: false,
    removed: false,
  }));
}

/** How many wallets the list would hold if the draft were saved. */
export function draftCount(draft: readonly WatchDraftRow[]): number {
  return draft.filter((r) => !r.removed).length;
}

/**
 * The staged edits as the batch the API takes.
 *
 * Everything is derived by COMPARISON against the server's own list rather than
 * tracked as the user types, because the two disagree in the case that matters:
 * typing a label and then typing it back is not a change, and sending it as one
 * spends a signature and an `updated_at` on nothing.
 *
 * The label rules are the API's (server/watchlist.ts): an omitted `label` means
 * "leave whatever is there" and an explicit `null` means "clear it", and they
 * are NOT interchangeable - collapsing them is how onboarding used to stamp its
 * own name over one the user had chosen. So a row whose label is untouched sends
 * no label key at all, and a row whose label was emptied sends `null`.
 */
export function stagedOps(
  server: readonly WatchSubscription[],
  draft: readonly WatchDraftRow[],
): WatchOp[] {
  const before = new Map(server.map((s) => [s.wallet.toLowerCase(), s]));
  const ops: WatchOp[] = [];

  for (const row of draft) {
    const wallet = row.wallet.toLowerCase();
    const existing = before.get(wallet);

    if (row.removed) {
      // A row added and then removed in the same session never reached the
      // server, so there is nothing to remove and the API would 404 the op.
      if (existing) ops.push({ op: "remove", wallet });
      continue;
    }

    const label = row.label.trim();
    if (!existing) {
      ops.push({
        op: "add",
        wallet,
        profile: row.profile,
        // An add always states the label, including as an explicit null: there
        // is no prior value for "leave it alone" to refer to.
        label: label.length > 0 ? label : null,
      });
      continue;
    }

    const profileChanged = existing.profile !== row.profile;
    const labelChanged = (existing.label ?? "") !== label;
    if (!profileChanged && !labelChanged) continue;
    ops.push({
      op: "update",
      wallet,
      ...(profileChanged ? { profile: row.profile } : {}),
      ...(labelChanged ? { label: label.length > 0 ? label : null } : {}),
    });
  }

  // A wallet the draft dropped entirely (not marked removed, simply gone) is
  // not a case this editor can produce, and inventing removals for it would let
  // a rendering bug delete somebody's alerts.
  return ops;
}

// ── writing ──────────────────────────────────────────────────────────────────

/** A save either applied whole and returns the new list, or changed nothing. */
export type SaveResult =
  | { ok: true; watching: WatchSubscription[] }
  | { ok: false; error: string };

/**
 * Apply a staged batch. NEVER throws: every failure comes back as a sentence
 * this file or the API wrote, because the alternative is a viem string on
 * screen ("Provider not found. Version: @wagmi/core@3.5.1"), which is the bug
 * `OwnershipError` exists to stop.
 *
 * The API's own error text is passed through VERBATIM. It names the offending
 * operation ("ops[2].label is longer than 60 characters", "not watching 0x… -
 * add it first"), and rewording it here would lose the only part of the message
 * that tells the user which row to fix.
 */
export async function saveWatchlist(
  owner: string,
  ops: readonly WatchOp[],
  getProof: GetProof,
  /**
   * Fired once the wallet has signed and the request is on its way, so the
   * button can stop saying "sign in wallet" while nothing is waiting on the
   * user any more. The two phases are seconds apart and the popup is modal, so
   * a label that outlives it is the screen describing a prompt that is gone.
   */
  onSigned?: () => void,
): Promise<SaveResult> {
  if (ops.length === 0) return { ok: false, error: "Nothing to save." };
  try {
    // The proof's signer IS the owner_wallet server-side; the body cannot name
    // a different one. Watching a wallet you do not control is the feature,
    // deciding where its alerts go is not.
    const proof = await getProof(owner.trim().toLowerCase(), "watchlist-manage");
    onSigned?.();
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...proof, ops }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; watching?: WatchSubscription[]; error?: string }
      | null;
    if (!res.ok) {
      return { ok: false, error: body?.error ?? "PANIK could not save your watchlist." };
    }
    if (!body?.watching) {
      return { ok: false, error: "PANIK saved nothing it could confirm. Reopen this panel to check." };
    }
    return { ok: true, watching: body.watching };
  } catch (err) {
    return { ok: false, error: describeSaveFailure(err) };
  }
}

/**
 * Whatever was thrown, as a sentence a user can act on, with the consequence
 * stated: nothing changed. A message that only says a signature failed leaves
 * the reader unsure whether half their edits went through.
 */
export function describeSaveFailure(err: unknown): string {
  if (rejectedSignature(err)) return "Signature declined, so your watchlist is unchanged.";
  // Our own message, written for a screen - the only class safe to pass along.
  if (err instanceof OwnershipError) return err.message;
  if (noWalletAvailable(err)) {
    return "Changing this list needs a signature from the wallet it belongs to. Connect that wallet and try again.";
  }
  return "PANIK could not save your watchlist, so nothing changed.";
}
