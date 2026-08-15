/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wallets: the list of addresses PANIK watches for you, and the only surface
 * that changes it.
 *
 * NOT A SIXTH TAB, and not named Watch. The nav already holds five flat
 * destinations and one of them is the what-if simulator called Watch; a second
 * "Watch"-ish tab beside it would make the one word mean two things in the same
 * sidebar. This is a slide-in panel over the content area, the same shape as the
 * risk breakdown, reached from the wallet chip in the header (where the reader
 * is already thinking about which wallet) and from the Portfolio switcher.
 *
 * ONE SIGNATURE PER SAVE. Every edit is staged locally and the whole staged set
 * goes up as one batch behind one `watchlist-manage` proof. That is what the API
 * is shaped for, and it is the difference between approving "update the list of
 * wallets PANIK watches for you" once and dismissing five wallet popups.
 *
 * WHAT IS NOT COLOURED HERE. A risk profile picks the threshold a wallet is
 * measured against; it is not a risk band, so nothing on this panel takes a hue
 * from the risk ramp on the healthy path. The two exceptions both mean "this
 * failed": the unreachable-list state borrows `EmptyState`'s dashed
 * risk-unknown treatment, and a save error takes the same critical text the
 * Telegram card's error line already uses.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Undo2, WalletCards, X } from "lucide-react";
import type { RiskProfile } from "../../../packages/scoring/src/types";
import { Button, EmptyState, Skeleton } from "../ui";
import { RISK_PROFILES, truncateAddress } from "../lib/utils";
import { isEvmAddress, type GetProof } from "../lib/telegram";
import {
  draftCount,
  draftFromSubscriptions,
  saveWatchlist,
  stagedOps,
  type WatchDraftRow,
  type WatchlistState,
} from "../lib/watchlist";

/** Sentence case, because the whole product is. */
const profileLabel = (p: RiskProfile) => p.charAt(0).toUpperCase() + p.slice(1);

/**
 * Where a save has got to.
 *
 * "signing" and "saving" are separate because only the first is waiting on the
 * user: a button still reading "sign in wallet" after the popup closed is the
 * screen describing something that is no longer happening.
 */
type SaveStatus = "idle" | "signing" | "saving" | "saved" | "error";

export interface WalletsPanelProps {
  /** The bound wallet. It OWNS the list, and it is the only signer. */
  owner: string;
  state: WatchlistState;
  getProof: GetProof;
  /** The user's own profile from onboarding, as the add form's default. */
  defaultProfile: RiskProfile;
  /** Which wallet the Portfolio is currently showing, for the "viewing" marker. */
  viewedWallet: string | null;
  /**
   * Show the list without a single way to change it.
   *
   * Set by a read-only session (arrived through an alert link). It is a UX
   * truth, NOT a permission: the API would refuse these edits anyway, because
   * every one of them travels behind a `watchlist-manage` signature from the
   * owner's key and this reader has not produced one. What the flag buys is
   * that the reader is never offered a control that would end in a wallet popup
   * they cannot answer and a save that could not have worked.
   */
  readOnly?: boolean;
  onClose: () => void;
}

export function WalletsPanel({
  owner,
  state,
  getProof,
  defaultProfile,
  viewedWallet,
  readOnly = false,
  onClose,
}: WalletsPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Focus on open, Escape to close: the dismissal contract a keyboard user
  // expects from anything covering the page behind a backdrop. `preventScroll`
  // because this mounts while the element is still translated off-screen, and
  // the browser's scroll-into-view otherwise fights the spring.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  const { subscriptions, max, labelMax, loading, offline } = state;

  /**
   * The editable copy of the list.
   *
   * Seeded from the server list and RESEEDED whenever that list is replaced (by
   * a save, or by a reload). Keyed on the array identity rather than on a
   * length or a stringify: the hook only hands back a new array when a read or
   * a write actually brought one, so this cannot stomp a half-typed label on an
   * unrelated re-render.
   */
  const [draft, setDraft] = useState<WatchDraftRow[]>([]);
  useEffect(() => {
    setDraft(subscriptions ? draftFromSubscriptions(subscriptions) : []);
  }, [subscriptions]);

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const ops = useMemo(() => stagedOps(subscriptions ?? [], draft), [subscriptions, draft]);
  const count = draftCount(draft);
  const atCap = max !== null && count >= max;
  const busy = status === "signing" || status === "saving";

  const patch = (wallet: string, change: Partial<WatchDraftRow>) => {
    // Any edit invalidates the previous outcome: a green "saved" line sitting
    // over three fresh unsaved edits is the panel claiming work it has not done.
    setStatus("idle");
    setSaveError(null);
    setDraft((rows) => rows.map((r) => (r.wallet === wallet ? { ...r, ...change } : r)));
  };

  const addRow = (row: WatchDraftRow) => {
    setStatus("idle");
    setSaveError(null);
    setDraft((rows) => [...rows, row]);
  };

  const save = async () => {
    setStatus("signing");
    setSaveError(null);
    const result = await saveWatchlist(owner, ops, getProof, () => setStatus("saving"));
    if (result.ok) {
      // The server's list, not the draft: the response is what was actually
      // written, and adopting it is what makes an upsert of a wallet already on
      // the list read back correctly instead of appearing twice.
      state.replace(result.watching);
      setStatus("saved");
      return;
    }
    setSaveError(result.error);
    setStatus("error");
  };

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-labelledby="wallets-panel-heading"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="flex h-full flex-col overflow-hidden outline-hidden"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle p-5">
        <div className="flex min-w-0 items-start gap-3">
          <WalletCards className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
          <div className="min-w-0">
            <h3
              id="wallets-panel-heading"
              className="text-sm font-sans font-bold text-text-primary"
            >
              Wallets
            </h3>
            {/* Keep-inline by the three-way test: it names the one thing a
                reader cannot infer from the rows, which is that the level beside
                each address decides when that wallet raises an alert. */}
            <span className="mt-1 block text-xs font-sans leading-relaxed text-text-secondary">
              {readOnly
                ? "Wallets PANIK watches for this account. Sign in with your wallet to change the list."
                : "Wallets PANIK watches for you. The level beside each one sets when it alerts."}
            </span>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={onClose}
          aria-label="Close wallets"
          title={ops.length > 0 ? "Close without saving your changes" : "Close wallets"}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {/* The cap, stated only once it is known. A counter that guesses the
            limit is a counter that teaches a wrong one the day the server
            raises it, so the number comes off the read that produced the list. */}
        {max !== null && (
          <p className="text-xs font-sans text-text-secondary tabular-nums">
            {count} of {max} watched
            {atCap && ". Remove one to add another."}
          </p>
        )}

        {loading && (
          <ul className="divide-y divide-border-subtle" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="py-4 first:pt-0">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-2 h-9 w-full" />
              </li>
            ))}
          </ul>
        )}

        {/* `problem`, and it must not resemble an empty list: a watchlist we
            could not read rendering as "no wallets watched" is this product
            reporting that it watches nothing at the one moment it cannot say. */}
        {offline && (
          <EmptyState
            tone="problem"
            title="Your watchlist could not be loaded"
            hint="That does not mean it is empty. We could not reach the list of wallets PANIK watches for you, so what is on it is unknown right now."
            action={
              <Button variant="outline" onClick={state.reload}>
                Try again
              </Button>
            }
          />
        )}

        {!loading && !offline && subscriptions !== null && draft.length === 0 && (
          <p className="text-xs font-sans leading-relaxed text-text-secondary">
            {readOnly
              ? "PANIK is watching no wallets for this account."
              : "PANIK is watching no wallets for you. Add one below and it is scored every minute, with alerts at the level you pick."}
          </p>
        )}

        {draft.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {draft.map((row) => (
              <WalletRow
                key={row.wallet}
                row={row}
                labelMax={labelMax}
                isOwner={row.wallet === owner.toLowerCase()}
                isViewed={viewedWallet !== null && row.wallet === viewedWallet.toLowerCase()}
                disabled={busy}
                readOnly={readOnly}
                onChange={(change) => patch(row.wallet, change)}
              />
            ))}
          </ul>
        )}

        {/* No add form until the server has said how long a list may be and how
            long a name may be. Offering one before then would be guessing at
            both, and the reader would find out which guess was wrong from a
            rejected batch. */}
        {!readOnly && max !== null && labelMax !== null && (
          <AddWalletForm
            defaultProfile={defaultProfile}
            labelMax={labelMax}
            atCap={atCap}
            max={max}
            disabled={busy}
            alreadyWatched={(w) => draft.some((r) => r.wallet === w && !r.removed)}
            onAdd={addRow}
          />
        )}
      </div>

      {/* The whole save footer, gone rather than disabled: there is nothing to
          stage, so a greyed "Save changes" would be a control describing an
          action that is not merely unavailable but meaningless here. The panel
          says why at the top, once. */}
      {!readOnly && (
      <div className="shrink-0 space-y-2 border-t border-border-subtle p-5">
        {/* The API's own words, verbatim. It names the operation that failed
            ("ops[2].label is longer than 60 characters"), and rewording it here
            would throw away the only part that says which row to fix. */}
        {status === "error" && saveError && (
          <p role="alert" className="text-xs font-sans leading-relaxed text-risk-critical">
            {saveError}
          </p>
        )}
        {status === "saved" && (
          <p role="status" className="text-xs font-sans text-text-secondary">
            Saved. PANIK is watching {count} wallet{count === 1 ? "" : "s"} for you.
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-sans tabular-nums text-text-secondary">
            {ops.length === 0
              ? "No unsaved changes"
              : `${ops.length} unsaved change${ops.length === 1 ? "" : "s"}`}
          </span>
          <Button size="lg" onClick={() => void save()} disabled={ops.length === 0 || busy}>
            {status === "signing"
              ? "Sign in wallet..."
              : status === "saving"
                ? "Saving..."
                : "Save changes"}
          </Button>
        </div>
        {/* Stated before the popup, not after it. One signature covers the whole
            batch, which is the fact that makes staging worth doing and the one a
            reader would otherwise learn by counting prompts. */}
        {ops.length > 0 && status !== "error" && (
          <p className="text-xs font-sans leading-relaxed text-text-secondary">
            Saving asks for one signature covering every change above. Free, no transaction, no gas.
          </p>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * One watched wallet: what it is called, what it is, and what level it alerts
 * at.
 *
 * Both fields are live inputs rather than an edit mode, because this panel is
 * only ever opened to change something and a per-row edit toggle would put a
 * click in front of every change while the save is batched anyway.
 */
function WalletRow({
  row,
  labelMax,
  isOwner,
  isViewed,
  disabled,
  readOnly,
  onChange,
}: {
  row: WatchDraftRow;
  labelMax: number | null;
  isOwner: boolean;
  isViewed: boolean;
  disabled: boolean;
  readOnly: boolean;
  onChange: (change: Partial<WatchDraftRow>) => void;
}) {
  const name = row.label.trim() || truncateAddress(row.wallet);
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        {/* Mono is reserved for hex addresses, and this is one. Truncated with
            the whole thing on hover: a 42-character string is not something a
            reader checks by reading, it is something they check by comparing
            the ends. */}
        <span
          className="font-mono text-xs text-text-secondary"
          title={row.wallet}
        >
          {truncateAddress(row.wallet)}
        </span>
        {isOwner && (
          <span className="rounded-sm border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-2xs font-sans font-bold text-text-muted">
            Your wallet
          </span>
        )}
        {isViewed && !isOwner && (
          <span className="rounded-sm border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-2xs font-sans font-bold text-text-muted">
            Showing in Portfolio
          </span>
        )}
      </div>

      {readOnly ? (
        /* The same two facts the editor holds, as text: what this wallet is
           called and the level it alerts at. Rendered as a sentence rather than
           as a disabled input, because a greyed-out field still reads as
           something to click, and there is nothing here to click. */
        <p className="mt-2 text-xs font-sans leading-relaxed text-text-secondary">
          {row.label.trim() ? `${row.label.trim()}. ` : ""}
          Alerts at the {profileLabel(row.profile)} level.
        </p>
      ) : row.removed ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-sans leading-relaxed text-text-secondary">
            {isOwner
              ? "Staged for removal. PANIK would stop watching your own wallet."
              : "Staged for removal."}
          </span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => onChange({ removed: false })}
            aria-label={`Keep watching ${name}`}
          >
            <Undo2 className="h-3.5 w-3.5" />
            Keep
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={row.label}
            maxLength={labelMax ?? undefined}
            disabled={disabled}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="Name this wallet"
            aria-label={`Name for ${truncateAddress(row.wallet)}`}
            autoComplete="off"
            spellCheck={false}
            /* Same 160px floor as the add form's name field, and for the same
               reason: the picker and the remove button beside it do not shrink. */
            className="h-10 min-w-40 flex-1 rounded-md border border-border-strong bg-surface-sunken px-3 font-sans text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50"
          />
          <select
            value={row.profile}
            disabled={disabled}
            onChange={(e) => onChange({ profile: e.target.value as RiskProfile })}
            aria-label={`Alert level for ${name}`}
            className="h-10 cursor-pointer rounded-md border border-border-strong bg-surface-sunken px-3 font-sans text-sm text-text-primary disabled:opacity-50"
          >
            {RISK_PROFILES.map((p) => (
              <option key={p} value={p}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => onChange({ removed: true })}
            aria-label={`Stop watching ${name}`}
            title={`Stop watching ${name}`}
            className="h-10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Add a wallet you want watched, including one you do not control.
 *
 * The address is validated here only to keep an obvious typo out of a signed
 * batch: the server validates every op again, and a batch is all-or-nothing, so
 * one malformed address would otherwise cost a signature and reject the four
 * good edits beside it.
 */
function AddWalletForm({
  defaultProfile,
  labelMax,
  atCap,
  max,
  disabled,
  alreadyWatched,
  onAdd,
}: {
  defaultProfile: RiskProfile;
  labelMax: number;
  atCap: boolean;
  max: number;
  disabled: boolean;
  alreadyWatched: (wallet: string) => boolean;
  onAdd: (row: WatchDraftRow) => void;
}) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState<RiskProfile>(defaultProfile);

  const typed = address.trim();
  const lower = typed.toLowerCase();
  const valid = isEvmAddress(typed);
  const duplicate = valid && alreadyWatched(lower);
  // The hint names the CONDITION, not the failure: the button is disabled until
  // the address is one, so there is nothing to have got wrong yet. That is also
  // why nothing here is repainted by what was typed.
  const hint = !typed
    ? null
    : !valid
      ? "An EVM address is 0x followed by 40 hexadecimal characters."
      : duplicate
        ? "That wallet is already on your list."
        : null;

  const submit = () => {
    if (!valid || duplicate || atCap || disabled) return;
    onAdd({ wallet: lower, profile, label: label.trim(), isNew: true, removed: false });
    setAddress("");
    setLabel("");
    setProfile(defaultProfile);
  };

  return (
    <div className="space-y-2 rounded-md border border-border-subtle bg-white/[0.02] p-4">
      <h4 className="text-xs font-sans font-bold text-text-primary">Add a wallet</h4>
      {atCap ? (
        /* The reason, beside the thing it disables. A greyed form with no
           sentence is a screen refusing without saying why, and the cap is a
           number the reader can act on. */
        <p className="text-xs font-sans leading-relaxed text-text-secondary">
          Your list is full at {max} wallets. Remove one above and save, then add another.
        </p>
      ) : (
        <>
          <p className="text-xs font-sans leading-relaxed text-text-secondary">
            Any Base address, including one you do not control. Watching it does not let PANIK act
            on it.
          </p>
          <input
            type="text"
            value={address}
            disabled={disabled}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="0x..."
            aria-label="Address of the wallet to watch"
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-mono text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={label}
              maxLength={labelMax}
              disabled={disabled}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Name (optional)"
              aria-label="Name for the wallet to watch"
              autoComplete="off"
              spellCheck={false}
              /* `min-w-40` is what makes the row wrap instead of crush. The
                 picker and the Add button are fixed width, so on a 390px panel
                 a `flex-1` name field was left ~120px and clipped its own
                 placeholder mid-word. At a 160px floor the field takes its own
                 full-width line instead, which is the structural fix rather
                 than shrinking the text to hide the overflow. */
              className="h-10 min-w-40 flex-1 rounded-md border border-border-strong bg-surface-sunken px-3 font-sans text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50"
            />
            <select
              value={profile}
              disabled={disabled}
              onChange={(e) => setProfile(e.target.value as RiskProfile)}
              aria-label="Alert level for the wallet to watch"
              className="h-10 cursor-pointer rounded-md border border-border-strong bg-surface-sunken px-3 font-sans text-sm text-text-primary disabled:opacity-50"
            >
              {RISK_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
            <Button
              onClick={submit}
              disabled={!valid || duplicate || disabled}
              className="h-10"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {hint && <p className="text-xs font-sans leading-relaxed text-text-secondary">{hint}</p>}
        </>
      )}
    </div>
  );
}
