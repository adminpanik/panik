import React from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Two empty states that must never look alike.
 *
 * `clear` means we looked and there is nothing to report. In a liquidation
 * product that is good news, and it is safe to say so.
 *
 * `problem` means we could not look. That is NOT good news, and it is not a
 * safety claim we are allowed to make. It borrows the risk-unknown treatment
 * from the score chips — dashed edge, grey label — so "we don't know" reads
 * the same everywhere it appears, whether it is one number or a whole panel.
 *
 * Rendering both as the same grey box, which is what this replaces, silently
 * turns a failed fetch into "you're fine".
 */
const EMPTY_TONE = {
  clear: {
    icon: CheckCircle2,
    box: "border-border-subtle bg-white/[0.02]",
    mark: "text-risk-low",
  },
  problem: {
    icon: AlertTriangle,
    box: "border-dashed border-risk-unknown/40 bg-transparent",
    mark: "text-risk-unknown",
  },
} as const;

/**
 * The `clear` tone's box treatment, for the one surface that needs the skin
 * without the component: `SparklinePlaceholder` holds a chart's exact frame
 * open and centres a sentence in it, which `EmptyState`'s own layout (icon
 * beside a title, height set by its content) cannot do. It hand-copied these
 * two classes, so the two "nothing to report here" boxes on the Portfolio tab
 * were one edit away from reading as different kinds of statement.
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
  const { icon: Icon, box, mark } = EMPTY_TONE[tone];
  return (
    <div
      className={`flex flex-col gap-3 rounded-md border p-5 sm:flex-row sm:items-center sm:justify-between ${box}`}
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${mark}`} />
        <div>
          <span className="block text-sm font-sans font-bold text-text-primary">{title}</span>
          {hint && (
            <span className="mt-1 block text-xs font-sans leading-relaxed text-text-secondary">
              {hint}
            </span>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
