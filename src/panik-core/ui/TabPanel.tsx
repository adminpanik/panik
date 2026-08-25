import React from "react";

/**
 * One measure for every tab panel, centred. The five panels had drifted to four
 * different caps (4xl through 6xl) and none was centred, so on a wide monitor
 * each tab settled at a different width and dumped all the slack on the right.
 *
 * 1600px is chosen for the widest thing on the page: Portfolio's 7/5 split. At
 * that cap the left column is ~930px, which is a table row a person can still
 * read across, and the right column is ~660px, which is enough for the
 * allocation legend to stop wrapping. Going wider only lengthens the rows.
 */
const PANEL = "mx-auto w-full max-w-[1600px]";

/**
 * The body of one tab. Five copies of this wrapper existed inline, identical
 * apart from the tab id and whether the children stacked at 24 or 32px, which
 * meant the ARIA contract — `role="tabpanel"` plus the `id`/`aria-labelledby`
 * pair that ties a panel to its tab — was retyped five times. A tabs pattern
 * fails silently when one of those attributes is missing or points at the wrong
 * id: nothing looks wrong, the screen reader simply stops announcing which
 * panel it is in. Deriving both ids from `tab` is what makes them unable to
 * disagree.
 *
 * NO TRANSITION. This used to be a `motion.div` that faded in over 180ms with
 * 5px of travel. There is no motion anywhere in this system: a tab swap is an
 * instantaneous fact about which panel you are in, and animating it puts a
 * moving element on a risk dashboard, which is the one thing the house rules
 * forbid outright. The panel is a plain `div` now.
 *
 * The caller still passes `key`. It mounts these inside an `AnimatePresence`
 * for the sibling overlays around them, and five `<TabPanel>`s of the same
 * component type reconcile as one element without distinct keys, so the swap
 * would not be detected at all.
 */
export function TabPanel({
  tab,
  gap = "space-y-6",
  children,
}: {
  tab: string;
  /** Child spacing. Compass runs looser than the other four. */
  gap?: "space-y-6" | "space-y-8";
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${tab}`}
      aria-labelledby={`tab-${tab}`}
      className={`${PANEL} ${gap}`}
    >
      {children}
    </div>
  );
}
