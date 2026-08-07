/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";

/**
 * Plain-language metric tooltip (UX research backlog #1: every metric gets a
 * one-sentence explanation). Rendered through a portal with fixed positioning
 * so it never gets clipped by the cards' overflow-hidden containers, and
 * flips below the anchor near the top of the viewport. Keyboard-accessible
 * (focusable, shows on focus).
 */
export function InfoTip(props: { text: string; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const show = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < 96; // not enough headroom: render under the icon
    setPos({ x: r.left + r.width / 2, y: below ? r.bottom : r.top, below });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={anchor}
      tabIndex={0}
      aria-label={props.text}
      className={`inline-flex align-middle ${props.className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <HelpCircle className="w-3 h-3 text-text-muted hover:text-panik-orange transition-colors cursor-help shrink-0" />
      {pos &&
        createPortal(
          <span
            role="tooltip"
            className={`fixed z-[300] w-60 -translate-x-1/2 pointer-events-none ${pos.below ? "" : "-translate-y-full"}`}
            style={{ left: pos.x, top: pos.below ? pos.y + 6 : pos.y - 6 }}
          >
            <span className="block p-2.5 rounded-md bg-surface-overlay border border-border-subtle text-2xs font-sans normal-case tracking-normal font-normal text-text-secondary leading-relaxed shadow-2xl text-left">
              {props.text}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
