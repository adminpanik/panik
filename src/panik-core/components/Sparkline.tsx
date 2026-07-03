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
export function Sparkline(props: {
  data: number[];
  /** CSS color for the line + gradient fill. */
  stroke?: string;
  /** Rendered height in px (width fills the container). */
  height?: number;
  className?: string;
}) {
  const { data, stroke = "#34d399", height = 36, className } = props;
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

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      style={{ height }}
      className={className}
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
}
