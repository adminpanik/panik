import React from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Two empty states that must never look alike.
 *
 * `clear` means we looked and there is nothing to report. In a liquidation
 * product that is good news, and it is safe to say so: a plain white plate with
 * the same hard edge every other box has.
 *
 * `problem` means we could not look. That is NOT good news, and it is not a
 * safety claim we are allowed to make. It takes the 45-degree hatch, which is
 * the same texture the UNKNOWN risk chip and the loading `Skeleton` wear, so
 * "there is nothing here and that is not a verdict" reads the same everywhere
 * it appears, whether it is one chip, one block or a whole panel.
 *
 * Rendering both as the same box, which is what this replaces, silently turns a
 * failed fetch into "you're fine". The hatch does that job better than the
 * dashed border it replaces: a dashed edge is a 1px difference a reader has to
 * look for, and on this look every other edge is 3px solid black anyway, so a
 * dashed one now reads as a rendering fault rather than as a distinction.
 */
const EMPTY_TONE = {
  clear: {
    icon: CheckCircle2,
    box: "hard-edge bg-surface-raised",
  },
  problem: {
    icon: AlertTriangle,
    box: "hard-edge hatch",
  },
} as const;

/**
 * The `clear` tone's box treatment, for the one surface that needs the skin
 * without the component: `SparklinePlaceholder` holds a chart's exact frame
 * open and centres a sentence in it, which `EmptyState`'s own layout (icon
 * beside a title, height set by its content) cannot do. It hand-copied these
 * classes, so the two "nothing to report here" boxes on the Portfolio tab were
 * one edit away from reading as different kinds of statement.
 */
export const CLEAR_TONE_BOX = EMPTY_TONE.clear.box;

/**
 * The `problem` tone's box treatment, for the same reason: `ui/Notice` is this
 * exact statement at one line rather than one panel, and it had hand-copied
 * these classes. "We could not do that" must look the same at both sizes.
 */
export const PROBLEM_TONE_BOX = EMPTY_TONE.problem.box;

interface EmptyStateProps {
  tone: keyof typeof EMPTY_TONE;
  title: string;
  hint?: React.ReactNode;
  /** One affordance at most. An empty state is not a place to offer choices. */
  action?: React.ReactNode;
}

export function EmptyState({ tone, title, hint, action }: EmptyStateProps) {
  const { icon: Icon, box } = EMPTY_TONE[tone];
  return (
    <div
      className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${box}`}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-primary" />
        <div>
          <span className="block font-sans text-lg font-black uppercase tracking-tight text-text-primary">
            {title}
          </span>
          {hint && (
            <span className="mt-1 block font-sans text-sm leading-relaxed text-text-secondary">
              {hint}
            </span>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
