import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismiss a floating thing when the press lands outside it.
 *
 * ONE LISTENER CONTRACT FOR EVERY OVERLAY, because the two that had their own
 * had chosen differently: `ui/Listbox` used `mousedown`, `AccountMenu` used a
 * capturing `pointerdown`. `mousedown` wins, and the reason is Listbox's:
 *
 *   - Not `click`: a press that starts outside and ends inside (a drag across
 *     the panel) should still dismiss, and waiting for the click lets the panel
 *     eat it.
 *   - Not a `fixed inset-0` backdrop element: a catcher swallows the first
 *     click on whatever the reader was actually reaching for, so dismissing and
 *     then pressing the next control takes two presses instead of one.
 *   - Not capturing: a control inside the panel must be able to stop an event
 *     before this sees it, and capture takes that away.
 *
 * `refs` is every element that counts as inside. A menu needs two (its panel is
 * portalled to the body, so it is not a descendant of its trigger); a listbox
 * needs one. The array is read through a ref, so a caller may build it inline
 * without re-subscribing on every render.
 *
 * `onDismiss` is null while the thing is closed, which is the whole enable
 * switch: no listener exists then. Keep it stable (`useCallback`) or the effect
 * re-subscribes each render.
 */
export function useDismissOnOutsidePress(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onDismiss: (() => void) | null,
): void {
  const inside = useRef(refs);
  inside.current = refs;

  useEffect(() => {
    if (!onDismiss) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inside.current.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onDismiss]);
}
