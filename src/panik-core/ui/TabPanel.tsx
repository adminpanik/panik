import React from "react";
import { motion } from "motion/react";

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
 * The transition is a fade with 5px of travel, mounted under an
 * `AnimatePresence mode="wait"` in the caller so the outgoing panel finishes
 * before the incoming one starts. The caller must pass `key` as well as `tab`:
 * a key set in here would be on the inner element, and AnimatePresence reads
 * the key of the child IT renders. Without one, five sibling `<TabPanel>`s of
 * the same component type reconcile as one element and no swap is detected.
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
    <motion.div
      role="tabpanel"
      id={`panel-${tab}`}
      aria-labelledby={`tab-${tab}`}
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -5 }}
      transition={{ duration: 0.18 }}
      className={`${PANEL} ${gap}`}
    >
      {children}
    </motion.div>
  );
}
