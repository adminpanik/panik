/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";

/**
 * An eyebrow over an uppercase heading, which is how all three of this page's
 * middle sections open. It is one component rather than three copies of the
 * same six utilities because the pair has to stay a pair: the eyebrow is the
 * only thing naming the section, so an eyebrow that drifts to a different size
 * or colour reads as a heading of its own.
 *
 * `note` is optional and only the FAQ uses it, where the heading column has
 * room for a line under it and the other two do not.
 */
export function SectionHeading({
  eyebrow,
  title,
  note,
}: {
  eyebrow: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="label-type text-xs text-text-secondary">{eyebrow}</p>
      <h2 className="text-2xl font-black uppercase tracking-tight text-text-primary">{title}</h2>
      {note ? <p className="text-base text-text-secondary">{note}</p> : null}
    </div>
  );
}
