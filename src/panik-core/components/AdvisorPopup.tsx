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
import { useChainMode } from "../lib/chainMode";
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
   * An OPEN notification the selected chain cannot execute. The notification
   * still shows - the opportunity is real information, and the same card is
   * readable in Compass either way - but its CTA would dead-end in the open
   * modal's unsupported screen, so it is gated by the one policy the Advisor
   * cards use. Only the open kind is gated: an exit CTA here is live wherever
   * the exit flow is, and nothing about that changes.
   */
  const openState =
    notification?.kind === "open" && notification.rec.openPlan
      ? openControlState(
          onOpen,
          chainMode,
          notification.rec.protocol,
          notification.rec.openPlan.collateralSymbol,
        )
      : null;
  const actionEnabled = openState === null || openState.enabled;

  return (
    <AnimatePresence>
      {notification ? (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          className={`fixed bottom-6 right-6 z-[80] w-full max-w-sm rounded-lg border p-4 shadow-2xl shadow-black/60 backdrop-blur-md ${
            notification.urgency === "critical"
              ? "bg-surface-overlay/95 border-risk-critical/40"
              : notification.urgency === "warning"
                ? "bg-surface-overlay/95 border-risk-elevated/30"
                : "bg-surface-raised/95 border-border-subtle"
          }`}
        >
          <div className="flex items-start gap-3">
            {notification.urgency === "info" ? (
              <Sparkles className="w-4 h-4 mt-0.5 text-text-primary shrink-0" />
            ) : (
              <AlertTriangle
                className={`w-4 h-4 mt-0.5 shrink-0 ${
                  notification.urgency === "critical" ? "text-risk-critical" : "text-risk-elevated"
                }`}
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-2xs font-sans text-text-muted mb-1">
                AI Advisor
              </p>
              <p className="text-sm text-text-primary font-sans leading-relaxed">{notification.headline}</p>
              <div className="flex items-center gap-2 mt-3">
                {notification.actionLabel ? (
                  <button
                    onClick={actionEnabled ? act : undefined}
                    disabled={!actionEnabled}
                    title={actionEnabled ? undefined : openState?.hint}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-2xs font-sans font-bold tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      notification.kind === "exit"
                        ? "bg-risk-critical/15 text-risk-critical border border-risk-critical/30 hover:bg-risk-critical/25"
                        : notification.kind === "reduce"
                          ? "bg-risk-elevated/15 text-risk-elevated border border-risk-elevated/30 hover:bg-risk-elevated/25"
                          : // `disabled:hover:` because a disabled button still
                            // takes :hover in the browser, and a control that
                            // lights up under the cursor reads as pressable.
                            "bg-white/10 text-text-primary border border-border-subtle hover:bg-white/15 disabled:hover:bg-white/10"
                    }`}
                  >
                    {notification.actionLabel} <ArrowRight className="w-3 h-3" />
                  </button>
                ) : null}
                <button
                  onClick={() => {
                    onView();
                    setNotification(null);
                  }}
                  className="px-3 py-1.5 rounded-md text-2xs font-sans text-text-secondary border border-border-subtle hover:text-text-primary hover:bg-white/[0.06] transition-colors"
                >
                  View in Advisor
                </button>
              </div>
            </div>
            <button onClick={dismiss} className="text-text-muted hover:text-text-primary transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
