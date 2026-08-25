/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The waitlist call to action, decided once in `App` and handed to the three
 * surfaces that carry it: the nav, the hero and the closing band.
 *
 * A component that built its own label would be the third place the words "Get
 * early access" are written, and the one that keeps saying them after the
 * reader has already signed up. The label and the disabled state travel
 * together for that reason: "on the list" beside a control that is still
 * pressable is a pair that must never occur.
 */
export interface WaitlistCta {
  /** What the control says right now. */
  label: string;
  /** True once this browser has completed a signup. */
  disabled: boolean;
  onClick: () => void;
}
