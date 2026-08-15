/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * How the app covers itself: one ladder, and one scrim.
 *
 * THE PROBLEM THIS FIXES. There were nine z-indexes in `panik-core`, invented
 * one at a time (30, 50, 90, 100, 150, 200, 210, 300, 9998), and the order they
 * produced was not the order anybody meant. The alerts-inactive banner sat at
 * 210 while both slide-ins sat at 50, so at a 390px viewport the banner covered
 * the top 107px of an open sheet - its heading and its close control - and
 * `elementFromPoint` at the close button returned the banner. The same banner
 * outranked every modal in the app (90 / 100 / 150), including the exit flow,
 * which is the one surface in the product that signs a transaction.
 *
 * THE RULE, and it is the whole reason this file is one object: a surface the
 * READER opened is above a notice the APP raised. The reader asked for the sheet
 * and is working in it; the banner is persistent and is still there the moment
 * the sheet closes, so nothing is hidden from anyone - a covered close button, by
 * contrast, is a dead end.
 *
 * Each rung names its occupants. A new overlay picks a rung rather than a
 * number; if none fits, that is a conversation about the ladder, not a `z-[47]`.
 */
export const LAYER = {
  /** Page chrome: the sidebar, the mobile tab bar. */
  chrome: "z-30",
  /**
   * A panel anchored to a control in the page (`ui/Listbox`). Deliberately BELOW
   * the notices: it belongs to the content, and it dismisses on the first press
   * outside it, so reaching past one costs nothing.
   */
  popover: "z-50",
  /**
   * Notices the app raises on its own: alerts-inactive, the first-run tour, the
   * trial pill. Above the page, below anything the reader opened.
   */
  banner: "z-[100]",
  /** The dimmed backdrop under any user-invoked surface. */
  scrim: "z-[200]",
  /** The slide-in sheet. */
  sheet: "z-[210]",
  /** A modal, which may be opened from inside a sheet, so it is a rung above. */
  modal: "z-[220]",
  /** `InfoTip`, which can be opened from inside every one of the above. */
  tip: "z-[300]",
} as const;

/**
 * The dim behind a sheet or a modal, in one place.
 *
 * Four surfaces hardcoded `bg-black/70` or `bg-black/80` with three different
 * blurs while the sheet used the surface token, so the app dimmed itself four
 * ways depending on which control you pressed. `surface-base` is the page's own
 * black, which is what a scrim should be receding towards, and 85% keeps the
 * layout underneath legible as context rather than deleting it.
 */
export const SCRIM = "bg-surface-base/85 backdrop-blur-xs";
