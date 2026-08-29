/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";
import { LAYER } from "../ui";

/**
 * Plain-language metric tooltip (UX research backlog #1: every metric gets a
 * one-sentence explanation). Rendered through a portal with fixed positioning
 * so it never gets clipped by the cards' overflow-hidden containers, and
 * flips below the anchor near the top of the viewport. Keyboard-accessible
 * (focusable, shows on focus).
 *
 * `children` replaces the help glyph with a custom anchor, for the case where
 * the thing being explained is itself the obvious hover target and a separate
 * "?" beside it would be a second control for one idea. The anchor keeps the
 * focus, the portal and the viewport flip either way. The alternative was a
 * native `title`, which cannot be focused, cannot be styled, and does not
 * appear for a keyboard user at all.
 *
 * THE HIT AREA IS 24px AND THE GLYPH IS NOT. This is a focusable element, so
 * WCAG 2.2 SC 2.5.8 applies to it, and it was a 12x12 target, measured, twelve
 * of them on the Watch tab alone. The fix is a centred 24x24 pseudo-element
 * rather than padding, because padding would make the ANCHOR 24px and shove the
 * label it sits beside: the glyph has to stay 12px next to 12px type, and only
 * the area a finger has to find gets bigger. `::before` participates in hit
 * testing and takes no layout space, which is exactly the pair of properties
 * needed. It is centred so it grows symmetrically over whitespace rather than
 * over the words in front of it.
 */
export function InfoTip(props: { text: string; className?: string; children?: React.ReactNode }) {
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
      className={`relative inline-flex align-middle before:absolute before:top-1/2 before:left-1/2 before:h-6 before:w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] ${props.className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {props.children ?? (
        <HelpCircle className="w-3 h-3 text-text-muted hover:text-text-primary transition-colors cursor-help shrink-0" />
      )}
      {pos &&
        createPortal(
          <span
            role="tooltip"
            className={`fixed ${LAYER.tip} w-60 -translate-x-1/2 pointer-events-none ${pos.below ? "" : "-translate-y-full"}`}
            style={{ left: pos.x, top: pos.below ? pos.y + 6 : pos.y - 6 }}
          >
            {/* 12px, not 11px. A tooltip is a paragraph a user opened on
                purpose because they did not understand something; setting the
                explanation smaller than the thing it explains is the wrong way
                round. `surface-overlay` is the lightest surface in the system,
                which is exactly the case text-secondary (#94A3B8, 6.68:1) is
                specified against. */}
            <span className="block p-2.5 rounded-md bg-surface-overlay border border-border-subtle text-xs font-sans normal-case tracking-normal font-normal text-text-secondary leading-relaxed shadow-2xl text-left">
              {props.text}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
