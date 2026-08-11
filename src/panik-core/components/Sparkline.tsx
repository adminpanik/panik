/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useId } from "react";
import { Skeleton } from "../ui/Skeleton";

/**
 * Dependency-free inline sparkline: an SVG polyline with a soft area fill,
 * stretched to its container width. Used for the 30d APY trend on Compass
 * cards and in the risk-breakdown panel.
 */
export interface SparklineAxes {
  /** Formats the y-axis min/max labels (e.g. v => `${v.toFixed(1)}%`). */
  yFormat: (v: number) => string;
  /** X-axis range labels, oldest first (e.g. "30d ago" / "today"). */
  xStart: string;
  xEnd: string;
}

/**
 * A single horizontal annotation — a threshold the series is measured against,
 * not a second dataset. Deliberately one, not many: tinting every band behind
 * the line is the "everything is coloured" failure this design system exists to
 * prevent. It draws in a neutral border token UNDER the series so the series
 * always wins, and never in a risk-ramp hue.
 *
 * Requires `axes`: the label lives in a gutter beside the plot, so that it can
 * never sit on top of the data no matter where the series happens to run.
 */
export interface SparklineReference {
  /** Position on the y scale. Only meaningful inside `domain`. */
  value: number;
  /** Short muted caption, e.g. "alert 50". */
  label: string;
}

/**
 * Width of the right-hand gutter holding the reference caption. Declared once
 * because the caption row and the x-label spacer row have to agree, and a
 * mismatch shows up as x labels drifting out from under the plot.
 */
const REF_GUTTER = "w-14";

/**
 * The chart's frame with no series in it: same left gutter, same plot width,
 * same reference gutter, same x-label row underneath. A card that draws a bare
 * sentence where a chart will go has to re-lay itself out the moment the series
 * arrives, and the reader loses their place in whatever sits below.
 *
 * It lives beside `Sparkline` because it borrows that layout's gutter widths.
 * A placeholder built from a second copy of those numbers is one that stops
 * matching the chart it stands in for, with nothing failing to say so.
 */
export function SparklinePlaceholder({ height = 36 }: { height?: number }) {
  return (
    <div aria-hidden="true">
      <div className="flex items-stretch gap-1.5">
        <div className="shrink-0 min-w-8" />
        <div className="flex-1 min-w-0" style={{ height }}>
          <Skeleton className="h-full w-full" />
        </div>
        <div className={`shrink-0 ${REF_GUTTER}`} />
      </div>
      <div className="flex gap-1.5 mt-0.5">
        <div className="shrink-0 min-w-8" />
        {/* The x-label row's own height, held open rather than measured: the
            labels are `text-2xs`, whose line box is 16px. */}
        <div className="h-4 flex-1" />
      </div>
    </div>
  );
}

export function Sparkline(props: {
  data: number[];
  /** CSS color for the line + gradient fill. Defaults to the chart-series token. */
  stroke?: string;
  /** Rendered height in px (width fills the container). */
  height?: number;
  className?: string;
  /** Optional min/max + time-range labels around the chart. */
  axes?: SparklineAxes;
  /**
   * Fixed `[min, max]` y range. Omit to auto-scale to the data (the default,
   * and what every caller without a meaningful absolute scale wants).
   *
   * Auto-scale makes the line fill the box whatever the numbers are, so a
   * 39 -> 57 move and a 39 -> 41 move draw the same picture. Pass a domain
   * wherever the scale itself carries meaning — a 0-100 risk score has fixed
   * bands and a fixed alert threshold, and cropping to the observed range hides
   * both. A fixed domain draws a flatter line; that flatness is the fact.
   */
  domain?: [number, number];
  /** Single threshold annotation. Ignored unless `axes` is also given. */
  reference?: SparklineReference;
}) {
  const {
    data,
    stroke = "var(--color-chart-series)",
    height = 36,
    className,
    axes,
    domain,
    reference,
  } = props;
  const gradientId = useId();
  if (data.length < 2) return null;

  const W = 100;
  const H = 32;
  const PAD = 2;
  const min = domain ? domain[0] : Math.min(...data);
  const max = domain ? domain[1] : Math.max(...data);
  const span = max - min || 1; // flat series still renders a midline
  const yFor = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD);
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    return `${x.toFixed(2)},${yFor(v).toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `${line} ${W},${H} 0,${H}`;
  const refY = reference ? yFor(reference.value) : 0;

  const svg = (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      style={{ height }}
      className={axes ? undefined : className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Under the series on purpose: an annotation the line crosses, never a
          second series competing with it. */}
      {axes && reference && (
        <line
          x1="0"
          x2={W}
          y1={refY}
          y2={refY}
          stroke="var(--color-border-strong)"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );

  if (!axes) return svg;

  // Axes layout: y min/max in the left gutter, the reference caption in a right
  // gutter, time range under the chart. The gutters are mirrored as empty
  // spacers on the second row so the x labels stay aligned to the plot.
  return (
    <div className={className}>
      <div className="flex items-stretch gap-1.5">
        <div
          className="flex flex-col justify-between items-end shrink-0 min-w-8"
          style={{ height }}
          aria-hidden="true"
        >
          <span className="text-2xs font-sans tabular-nums text-text-muted leading-none">{axes.yFormat(max)}</span>
          <span className="text-2xs font-sans tabular-nums text-text-muted leading-none">{axes.yFormat(min)}</span>
        </div>
        <div className="flex-1 min-w-0">{svg}</div>
        {reference && (
          <div className={`relative shrink-0 ${REF_GUTTER}`} style={{ height }} aria-hidden="true">
            <span
              className="absolute right-0 -translate-y-1/2 whitespace-nowrap text-2xs font-sans tabular-nums text-text-muted leading-none"
              style={{ top: (refY / H) * height }}
            >
              {reference.label}
            </span>
          </div>
        )}
      </div>
      <div className="flex gap-1.5 mt-0.5" aria-hidden="true">
        <div className="shrink-0 min-w-8" />
        <div className="flex-1 min-w-0 flex justify-between">
          <span className="text-2xs font-sans text-text-muted">{axes.xStart}</span>
          <span className="text-2xs font-sans text-text-muted">{axes.xEnd}</span>
        </div>
        {reference && <div className={`shrink-0 ${REF_GUTTER}`} />}
      </div>
    </div>
  );
}
