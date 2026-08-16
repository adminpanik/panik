/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The account, in the header: who is signed in, what that account holds, and
 * the one control that ends it.
 *
 * IT REPLACES THE "STAY SIGNED IN" CHIP, and only that. The SIWE wallet session
 * is untouched: its sign-in offer still lives on the read-only banner and in
 * Settings' account card, because those are about a WALLET and this is about an
 * ACCOUNT, and the header has room for exactly one of them at 390px. Merging
 * this with the wallet chip and the Wallets button is a separate change.
 *
 * WHY NOT `ui/Listbox`. That primitive is the app's one dropdown and the reason
 * is keyboard support, but it is a select-only COMBOBOX: it exists to choose a
 * value from a list and it reports the chosen one. This is a menu button whose
 * panel holds a status line and a single action, which has no chosen value to
 * report; dressing it as a combobox would tell a screen reader that signing out
 * is one of several selectable settings. The keyboard contract that made
 * Listbox worth having is implemented here instead: open on Enter, Space or
 * ArrowDown with focus moved into the panel, Escape to dismiss with focus
 * returned to the trigger, and an outside press to dismiss.
 *
 * WHY A PORTAL. The header sets `backdrop-blur-md`, which creates a stacking
 * context, so an absolutely positioned panel inside it is trapped behind the
 * content that follows it in the document. `components/InfoTip.tsx` solved the
 * same problem the same way.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UserRound } from "lucide-react";
import { LAYER, useDismissOnOutsidePress } from "../ui";
import { describeMembership, type Account } from "../lib/account";

/** Panel width. Wide enough for an ordinary address without truncating it. */
const PANEL = "w-64";

export interface AccountMenuProps {
  account: Account;
  busy: boolean;
  onSignOut: () => void;
}

export function AccountMenu({ account, busy, onSignOut }: AccountMenuProps) {
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const open = anchor !== null;

  const close = useCallback(
    (returnFocus: boolean) => {
      setAnchor(null);
      if (returnFocus) trigger.current?.focus();
    },
    [],
  );

  const show = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    // Right-aligned to the trigger, because the trigger is the last thing in a
    // right-aligned header row and a left-aligned panel would leave the
    // viewport at 390px.
    setAnchor({ right: window.innerWidth - box.right, top: box.bottom + 6 });
  }, []);

  /* Two elements count as inside: the panel is portalled to the body, so it is
     not a descendant of the trigger. The listener itself, and why it is a
     `mousedown` rather than this component's old capturing `pointerdown`, is
     ui/useDismissOnOutsidePress. */
  const dismiss = useCallback(() => close(false), [close]);
  useDismissOnOutsidePress([panel, trigger], open ? dismiss : null);

  useEffect(() => {
    if (!open) return;
    // Focus lands on the action, which is the WAI-ARIA menu-button contract and
    // is also what makes Escape meaningful: there is somewhere for focus to
    // come back from.
    firstItem.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    /* A fixed panel measured once cannot follow its anchor, so a resize
       dismisses it rather than leaving it pointing at nothing. */
    const onResize = () => close(false);

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account, signed in as ${account.email}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
        className="flex min-w-0 shrink-0 items-center gap-2 rounded-md border border-border-subtle bg-white/[0.02] px-3 py-2 text-2xs font-semibold text-text-secondary transition-colors cursor-pointer hover:bg-white/[0.06] md:py-1.5"
      >
        <UserRound className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        {/* The address drops at 390 the same way the Wallets label does, with
            the accessible name carrying it. The header already holds the tier
            chip, the wallet chip and Wallets at that width. */}
        <span className="hidden max-w-40 truncate sm:inline">{account.email}</span>
      </button>

      {anchor &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            aria-labelledby={triggerId}
            style={{ right: anchor.right, top: anchor.top }}
            className={`fixed ${LAYER.popover} ${PANEL} rounded-md border border-border-subtle bg-surface-overlay p-1 shadow-2xl`}
          >
            <div role="group" aria-label="Account" className="space-y-0.5 px-2.5 py-2">
              <p className="truncate text-xs font-sans font-bold text-text-primary">{account.email}</p>
              {/* Stated from the grant the server returned, never assumed: a
                  membership with no expiry gets no date rather than an
                  invented one (lib/account.ts describeMembership). */}
              <p className="text-2xs font-sans leading-relaxed text-text-muted">
                {describeMembership(account)}
              </p>
            </div>
            <div className="my-1 h-px bg-border-subtle" role="separator" />
            <button
              ref={firstItem}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                close(false);
                onSignOut();
              }}
              className="flex w-full cursor-pointer items-center rounded-sm px-2.5 py-2 text-left text-xs font-sans font-bold text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Signing out..." : "Sign out"}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
