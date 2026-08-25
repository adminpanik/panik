import { FlaskConical } from "lucide-react";

import { Chip } from "./Chip";

import type { SimulationInfo } from "../lib/live";
/**
 * A VALUE import from the engine, deep into `simulation.ts`, which has no
 * runtime imports of its own. The package barrel reaches viem and must never
 * enter a browser bundle (see lib/live.ts); this module is the same exception
 * `prospective.ts` already is. It keeps the sentence a user reads and the
 * sentence an alert carries as one string in one place.
 */
import {
  SIMULATION_CHIP_LABEL,
  SIMULATION_EXIT_NOTE,
  SIMULATION_MARKER_BODY,
  SIMULATION_MARKER_TITLE,
  formatSimulationRemaining,
} from "../../../packages/scoring/src/simulation";

/**
 * The marker for a simulated market event.
 *
 * WHY IT LOOKS LIKE THIS. `docs/DESIGN_SYSTEM.md` was written around one rule:
 * never state a fact the code does not know. A simulation inverts that risk -
 * the code knows the price is invented and the screen has to say so - and the
 * failure it guards against is a screenshot of a crashed dashboard with no
 * marker in frame. So the bar is full width and sticky rather than a badge in a
 * corner, and every affected figure carries a chip of its own.
 *
 * COLOUR. None is spent. The risk ramp's five hues each mean exactly one thing
 * (a liquidation band), and a simulation is not a band - a simulated position
 * can be perfectly safe. So the marker is built from the neutral surface,
 * border and text tokens and takes its weight from contrast, an icon and words
 * instead. That also keeps it legible for the red/green confusion a risk
 * dashboard is already carrying.
 *
 * NO ANIMATION. The house rule bans pulsing and live indicators, and a marker
 * that throbs would be the most anxious element in the product. Remaining time
 * is rendered at minute granularity for the same reason: a per-second countdown
 * is a live indicator wearing a number.
 */
export function SimulationBanner({ simulation, now }: { simulation: SimulationInfo; now: number }) {
  return (
    /* `shrink-0`, and mounted OUTSIDE the scroll container rather than sticky
       inside it: sticky positioning is defeated by any ancestor with
       `overflow: hidden` or a transform, both of which this shell has, and the
       one guarantee this element must make is that it cannot leave the frame. */
    <div
      role="status"
      className="shrink-0 border-b-hard border-solid border-b-border-strong bg-surface-overlay px-4 py-2.5"
    >
      <div className="mx-auto flex max-w-[1600px] items-start gap-3">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {/* The scenario is named, the ASSETS are not. Two reasons: the
              symbols come from the engine's `scoredCollateralSymbol`, which can
              be an internal marker like "WETH (proxy)" and must never reach a
              user's screen; and which positions are affected is answered
              precisely by the per-row chip rather than approximately by a list
              here. */}
          <p className="label-type text-xs text-text-primary">
            {SIMULATION_MARKER_TITLE}: {simulation.label}
          </p>
          <p className="mt-0.5 text-2xs font-sans leading-relaxed text-text-secondary">
            {SIMULATION_MARKER_BODY} {SIMULATION_EXIT_NOTE} Ends in{" "}
            {formatSimulationRemaining(simulation.expiresAt - now)}.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The per-figure marker. Sits beside a number that came from an imagined price.
 *
 * The banner alone is not enough: a card can be screenshotted, scrolled past,
 * or read on a phone where the bar is above the fold and the position row is
 * not. A figure that is not real says so where it is rendered.
 */
export function SimulationChip({ className = "" }: { className?: string }) {
  return (
    <Chip
      className={className}
      title="This figure was produced from a simulated price. Real market prices have not moved."
    >
      <FlaskConical className="h-3 w-3" aria-hidden="true" />
      {SIMULATION_CHIP_LABEL}
    </Chip>
  );
}
