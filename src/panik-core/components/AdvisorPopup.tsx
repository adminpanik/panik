/**
 * AdvisorPopup - floating advisor notification (Phase 2).
 *
 * Client-side change detection over the 60s /api/advisor poll - no push
 * infra. Fires when (a) a leg's recommended ACTION changes (HOLD -> REDUCE,
 * anything -> EXIT), (b) a crash-regime trigger appears, or (c) a new OPEN
 * opportunity enters profile fit. Anti-spam mirrors alertPolicy's spirit:
 * 30-min cooldown per (protocol, action), dismissals persist until the action
 * changes again, and a critical EXIT bypasses the cooldown and persists until
 * acted on or explicitly dismissed. Out-of-app alerting stays with Telegram.
 */

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowRight, Sparkles, X } from "lucide-react";
import type {
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
  AdvisorUrgency,
} from "../lib/live";
import { formatUsd, PROTOCOL_LABEL } from "../lib/utils";
import { Button } from "../ui";
import { exitControlState, useChainMode, type ControlState } from "../lib/chainMode";
import { openControlState } from "../lib/openProtocols";

const STORE_KEY = "panik_advisor_popup_v1";
const COOLDOWN_MS = 30 * 60 * 1000;

interface PopupStore {
  /** Last-seen action per protocol leg. */
  seenActions: Record<string, string>;
  /** Opportunity ids already surfaced. */
  seenOpps: string[];
  /** key -> action that was dismissed (cleared when the action changes). */
  dismissed: Record<string, string>;
  /** key -> last time this notification was shown. */
  lastShownAt: Record<string, number>;
}

function loadStore(): PopupStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { seenActions: {}, seenOpps: [], dismissed: {}, lastShownAt: {}, ...JSON.parse(raw) };
  } catch {
    /* corrupted store resets */
  }
  return { seenActions: {}, seenOpps: [], dismissed: {}, lastShownAt: {} };
}

function saveStore(store: PopupStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

interface Notification {
  key: string;
  urgency: AdvisorUrgency;
  headline: string;
  actionLabel: string | null;
  rec: AdvisorRecommendation;
  kind: "exit" | "reduce" | "open" | "info";
}

function legHeadline(rec: AdvisorRecommendation): string {
  const label = PROTOCOL_LABEL[rec.protocol] ?? rec.protocol;
  switch (rec.action) {
    case "EXIT":
      return `${label} position moved to EXIT - full atomic exit recommended.`;
    case "REDUCE":
      return `${label} moved to REDUCE${rec.repayPlan ? ` - repay ~${formatUsd(rec.repayPlan.repayUsd)}` : ""}.`;
    case "REBALANCE":
      return `${label}: consider rebalancing to a safer protocol.`;
    default:
      return `${label} recommendation changed to ${rec.action}.`;
  }
}

/** Pick the notification to show for this report (or null). Pure on inputs. */
function selectNotification(report: AdvisorReport, store: PopupStore, now: number): Notification | null {
  const candidates: Notification[] = [];

  for (const rec of report.recommendations) {
    const key = `${rec.protocol}:${rec.action}`;
    const changed = store.seenActions[rec.protocol] !== rec.action;
    const crash = rec.triggers.includes("regime:crash");
    const notable = rec.action === "EXIT" || rec.action === "REDUCE" || rec.action === "REBALANCE";
    if (!notable || (!changed && !crash)) continue;
    if (store.dismissed[key] === rec.action) continue;
    const critical = rec.urgency === "critical" && rec.action === "EXIT";
    const cooled = (store.lastShownAt[key] ?? 0) + COOLDOWN_MS > now;
    if (cooled && !critical) continue;
    candidates.push({
      key,
      urgency: rec.urgency,
      headline: legHeadline(rec),
      actionLabel: rec.action === "EXIT" ? "Execute exit" : rec.action === "REDUCE" ? "Reduce" : null,
      rec,
      kind: rec.action === "EXIT" ? "exit" : rec.action === "REDUCE" ? "reduce" : "info",
    });
  }

  for (const rec of report.opportunities) {
    const plan = rec.openPlan;
    if (!plan) continue;
    const key = `open:${rec.protocol}:${plan.collateralSymbol}`;
    if (store.seenOpps.includes(key)) continue;
    if (store.dismissed[key] === "OPEN") continue;
    if ((store.lastShownAt[key] ?? 0) + COOLDOWN_MS > now) continue;
    candidates.push({
      key,
      urgency: "info",
      headline: `New opportunity: ${plan.collateralSymbol} on ${PROTOCOL_LABEL[rec.protocol] ?? rec.protocol}${
        plan.apy !== null ? `, ~${(plan.apy * 100).toFixed(1)}% APY` : ""
      } - fits your profile.`,
      actionLabel: "Open position",
      rec,
      kind: "open",
    });
  }

  const severity: Record<AdvisorUrgency, number> = { critical: 2, warning: 1, info: 0 };
  candidates.sort((a, b) => severity[b.urgency] - severity[a.urgency]);
  return candidates[0] ?? null;
}

export function AdvisorPopup({
  report,
  onExit,
  onOpen,
  onView,
}: {
  report: AdvisorReport | null;
  onExit: (prefill: NonNullable<AdvisorRecommendation["exitPrefill"]>) => void;
  onOpen: (plan: AdvisorOpenPlan) => void;
  onView: () => void;
}) {
  const [notification, setNotification] = useState<Notification | null>(null);
  const chainMode = useChainMode();

  useEffect(() => {
    if (!report) return;
    const store = loadStore();
    const next = selectNotification(report, store, Date.now());

    // Mark the report's state as seen AFTER selection so a change fires once.
    for (const rec of report.recommendations) {
      const key = `${rec.protocol}:${rec.action}`;
      if (store.seenActions[rec.protocol] !== rec.action) {
        // Action changed: clear any stale dismissal for this protocol.
        for (const k of Object.keys(store.dismissed)) {
          if (k.startsWith(`${rec.protocol}:`) && k !== key) delete store.dismissed[k];
        }
      }
      store.seenActions[rec.protocol] = rec.action;
    }
    for (const rec of report.opportunities) {
      const plan = rec.openPlan;
      if (plan) {
        const key = `open:${rec.protocol}:${plan.collateralSymbol}`;
        if (!store.seenOpps.includes(key)) store.seenOpps.push(key);
        if (store.seenOpps.length > 50) store.seenOpps = store.seenOpps.slice(-50);
      }
    }
    if (next) store.lastShownAt[next.key] = Date.now();
    saveStore(store);
    if (next) setNotification(next);
  }, [report]);

  const dismiss = () => {
    if (notification) {
      const store = loadStore();
      store.dismissed[notification.key] =
        notification.kind === "open" ? "OPEN" : notification.rec.action;
      saveStore(store);
    }
    setNotification(null);
  };

  const act = () => {
    if (!notification) return;
    const { rec, kind } = notification;
    if (kind === "exit" || kind === "reduce") {
      onExit(rec.exitPrefill ?? { protocol: rec.protocol, kind: "full" });
    } else if (kind === "open" && rec.openPlan) {
      onOpen(rec.openPlan);
    } else {
      onView();
    }
    setNotification(null);
  };

  /**
   * Whether the CTA may be pressed on the selected chain, by the same policy
   * the Advisor cards and the Portfolio row apply to the same actions. The
   * notification itself still shows either way - the reading is real
   * information - but a button whose flow would dead-end renders disabled with
   * the reason on hover, instead of this surface being the one place in the
   * product where the same action answers differently.
   */
  const actionState: ControlState =
    notification?.kind === "open" && notification.rec.openPlan
      ? openControlState(
          onOpen,
          chainMode,
          notification.rec.protocol,
          notification.rec.openPlan.collateralSymbol,
        )
      : notification?.kind === "exit" || notification?.kind === "reduce"
        ? exitControlState(onExit, chainMode)
        : { enabled: true, hint: undefined };

  return (
    <AnimatePresence>
      {notification ? (
        <motion.div
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          /* IN THE FLOW, in the band this shell already reserves for
             session-level notices (SimulationBanner, ReadOnlyBanner,
             SessionNote), between the header and the scroller.

             It used to be `fixed bottom-6 right-6`, which put a 384x141 panel
             over the bottom-right of whatever tab was open: measured on the
             Portfolio tab at 1440, it covered "See all 12 alerts" and the last
             Alert history row by 86% each, on load, with no interaction. A
             floating panel cannot be positioned out of that on a page taller
             than the viewport - anywhere it sits, it sits on content - so it
             stops floating. Here it pushes the page down instead of covering
             it, and being outside the scroller it is still in frame at every
             scroll position, which the toast was only ever approximating.

             No hue, on any branch. The severity is the sentence, and this
             surface can appear over ANY tab: a critical border, a critical
             glyph and a critical button added three risk-hued elements to
             whatever screen was underneath, which is how the Portfolio tab
             measured eleven against a documented budget of five. */
          className="flex shrink-0 items-start gap-3 border-b border-border-subtle bg-surface-raised/60 px-4 py-3 md:px-8"
        >
          {notification.urgency === "info" ? (
            <Sparkles className="w-4 h-4 mt-0.5 text-text-primary shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle
              className="w-4 h-4 mt-0.5 shrink-0 text-text-secondary"
              aria-hidden="true"
            />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-2xs font-sans text-text-muted mb-1">
              AI Advisor
            </p>
            <p className="text-sm text-text-primary font-sans leading-relaxed">{notification.headline}</p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {notification.actionLabel ? (
                /* The `Button` primitive, whose `primary` is a neutral
                   high-contrast fill and which accepts no risk band by design.
                   This was a hand-rolled control painted
                   `bg-risk-critical/15 text-risk-critical`, which is the ramp
                   colouring a VERB: "Execute exit" in critical red is the
                   colour system making a claim about an action, the exact
                   thing DESIGN_SYSTEM.md names when it says not to. */
                <Button
                  onClick={actionState.enabled ? act : undefined}
                  disabled={!actionState.enabled}
                  title={actionState.enabled ? undefined : actionState.hint}
                >
                  {notification.actionLabel} <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => {
                  onView();
                  setNotification(null);
                }}
              >
                View in Advisor
              </Button>
            </div>
          </div>
          {/* A real accessible name, because the glyph is the whole label: this
              announced as "button" and nothing else. `Button` also gives it a
              44x32 hit area, over the 24px floor SC 2.5.8 sets and well over
              the 16x16 the bare `<X>` measured. */}
          <Button variant="quiet" onClick={dismiss} aria-label="Dismiss this advisor notice">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
