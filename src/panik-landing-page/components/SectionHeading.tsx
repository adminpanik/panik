/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";

/**
 * The uppercase heading a section opens with, and nothing above it.
 *
 * The eyebrow this used to carry is gone from every section. It was a second
 * label naming what the heading beneath it already named, which is the page
 * telling the reader the same thing twice at two sizes. The `note` line went
 * with the FAQ, the only section that had one.
 *
 * One component rather than two copies of the same utilities, so the two
 * sections cannot drift to different sizes.
 */
export function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="text-2xl font-black uppercase tracking-tight text-text-primary">{title}</h2>
  );
}
