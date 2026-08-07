/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useId } from "react";

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

export function Sparkline(props: {
  data: number[];
  /** CSS color for the line + gradient fill. */
  stroke?: string;
  /** Rendered height in px (width fills the container). */
  height?: number;
  className?: string;
  /** Optional min/max + time-range labels around the chart. */
  axes?: SparklineAxes;
}) {
  const { data, stroke = "var(--color-sky-400)", height = 36, className, axes } = props;
  const gradientId = useId();
  if (data.length < 2) return null;

  const W = 100;
  const H = 32;
  const PAD = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1; // flat series still renders a midline
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = PAD + (1 - (v - min) / span) * (H - 2 * PAD);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = points.join(" ");
  const area = `${line} ${W},${H} 0,${H}`;

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

  // Axes layout: y min/max on the left gutter, time range under the chart.
  return (
    <div className={className}>
      <div className="flex items-stretch gap-1.5">
        <div
          className="flex flex-col justify-between items-end shrink-0 min-w-8"
          style={{ height }}
          aria-hidden="true"
        >
          <span className="text-2xs font-mono tabular-nums text-text-muted leading-none">{axes.yFormat(max)}</span>
          <span className="text-2xs font-mono tabular-nums text-text-muted leading-none">{axes.yFormat(min)}</span>
        </div>
        <div className="flex-1 min-w-0">{svg}</div>
      </div>
      <div className="flex justify-between pl-9 mt-0.5" aria-hidden="true">
        <span className="text-2xs font-mono text-text-muted uppercase">{axes.xStart}</span>
        <span className="text-2xs font-mono text-text-muted uppercase">{axes.xEnd}</span>
      </div>
    </div>
  );
}
