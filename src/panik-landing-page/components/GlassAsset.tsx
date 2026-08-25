/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

/**
 * Brand glass placements. Named by what each depicts so call sites read
 * semantically instead of by opaque file number. All keys currently point at
 * the single brand mark pending dedicated glass renders for the new mark.
 */
export const GLASS = {
  shieldKey: "/panik-mark.svg", // security / gated early access
  question: "/panik-mark.svg", // FAQ / answers
  dataCoins: "/panik-mark.svg", // multi-asset data / coverage
  ethCoin: "/panik-mark.svg", // performance / on-chain returns
  megaphone: "/panik-mark.svg", // announcement / join the waitlist
} as const;

/**
 * GlassAsset - a single floating, glowing 3D-glass brand icon.
 *
 * Historically the source art was amber glass on a solid black frame at 16:9,
 * composited with `mix-blend-mode: screen` on this near-black site so the
 * black dropped to transparent and each icon read as a real light source
 * rather than a pasted PNG. The current placements use the flat brand mark
 * (`GLASS`, see above) and pass `blend="normal"` since a solid-fill mark has
 * no black frame to knock out.
 *
 * "Different angles" from a fixed raster set are faked convincingly with CSS:
 * a base `rotate`, an optional horizontal `flip`, and a 3D `tiltX`/`tiltY`
 * perspective turn. Motion composes those static transforms with an animated
 * float drift + micro-rotation, and an optional scroll-linked parallax adds
 * depth. All motion is disabled under `prefers-reduced-motion`.
 */
export interface GlassAssetProps {
  /** Public path, e.g. "/panik-mark.svg". */
  src: string;
  alt?: string;
  /** Positioning + width utilities, e.g. "absolute left-[-6%] top-[20%] w-[320px]". */
  className?: string;
  /** Base tilt in the plane (deg). */
  rotate?: number;
  /** Mirror horizontally to present a fresh silhouette. */
  flip?: boolean;
  /** 3D perspective turns (deg): read as a different camera angle. */
  tiltX?: number;
  tiltY?: number;
  /** Float drift amplitude in px. */
  floatX?: number;
  floatY?: number;
  /** Micro-rotation amplitude layered on top of `rotate` (deg). */
  sway?: number;
  /** Seconds for one float cycle. */
  duration?: number;
  /** Start offset so neighbours never move in lockstep. */
  delay?: number;
  /** Scroll-linked vertical parallax range in px across the viewport pass. */
  parallax?: number;
  /** Ambient glow colour behind the icon. */
  glow?: string;
  /** Overall opacity. */
  opacity?: number;
  /** Compositing mode: "screen" is the default and knocks out the black frame. */
  blend?: "screen" | "lighten" | "plus-lighter" | "normal";
}

export function GlassAsset({
  src,
  alt = "",
  className = "",
  rotate = 0,
  flip = false,
  tiltX = 0,
  tiltY = 0,
  floatX = 0,
  floatY = 14,
  sway = 2,
  duration = 9,
  delay = 0,
  parallax = 0,
  glow = "rgb(from var(--color-panik-orange) r g b / 0.30)",
  opacity = 1,
  blend = "screen",
}: GlassAssetProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  // Scroll-linked parallax: element drifts as it crosses the viewport.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const parallaxY = useTransform(scrollYProgress, [0, 1], [parallax, -parallax]);

  const staticTransform = {
    scaleX: flip ? -1 : 1,
    rotateX: tiltX,
    rotateY: tiltY,
    transformPerspective: tiltX || tiltY ? 900 : undefined,
  } as const;

  const floatAnim = reduce
    ? undefined
    : {
        y: [0, -floatY, 0],
        x: floatX ? [0, floatX, 0] : undefined,
        rotate: [rotate - sway, rotate + sway, rotate - sway],
      };

  return (
    <motion.div
      ref={ref}
      aria-hidden={alt ? undefined : true}
      className={`pointer-events-none select-none ${className}`}
      style={{ opacity, y: parallax && !reduce ? parallaxY : undefined, willChange: "transform" }}
    >
      {/* Ambient radial glow: normal blend so the halo stays soft on any backdrop. */}
      <div
        className="absolute left-1/2 top-1/2 h-[62%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[42px]"
        style={{ background: `radial-gradient(circle, ${glow} 0%, transparent 68%)` }}
      />

      {/* The glass icon itself. */}
      <motion.img
        src={src}
        alt={alt}
        draggable={false}
        loading="lazy"
        decoding="async"
        className="relative w-full h-auto"
        style={{
          ...staticTransform,
          rotate: reduce ? rotate : undefined,
          mixBlendMode: blend,
          filter: `drop-shadow(0 18px 32px rgba(0,0,0,0.55)) drop-shadow(0 0 26px ${glow})`,
        }}
        animate={floatAnim}
        transition={
          reduce
            ? undefined
            : { duration, delay, repeat: Infinity, ease: "easeInOut" }
        }
      />
    </motion.div>
  );
}
