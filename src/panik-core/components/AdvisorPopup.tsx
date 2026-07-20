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

const STORE_KEY = "panik_advisor_popup_v1";
const COOLDOWN_MS = 30 * 60 * 1000;

const PROTOCOL_LABEL: Record<string, string> = {
  aave_v3: "Aave V3",
  moonwell: "Moonwell",
  morpho: "Morpho",
  compound_v3: "Compound V3",
};

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

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function legHeadline(rec: AdvisorRecommendation): string {
  const label = PROTOCOL_LABEL[rec.protocol] ?? rec.protocol;
  switch (rec.action) {
    case "EXIT":
      return `${label} position moved to EXIT - full atomic exit recommended.`;
    case "REDUCE":
      return `${label} moved to REDUCE${rec.repayPlan ? ` - repay ~${fmtUsd(rec.repayPlan.repayUsd)}` : ""}.`;
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

  return (
    <AnimatePresence>
      {notification ? (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          className={`fixed bottom-6 right-6 z-[80] w-full max-w-sm rounded-2xl border p-4 shadow-2xl shadow-black/60 backdrop-blur-md ${
            notification.urgency === "critical"
              ? "bg-[#1a0f10]/95 border-red-500/40"
              : notification.urgency === "warning"
                ? "bg-[#171208]/95 border-amber-500/30"
                : "bg-[#111318]/95 border-panik-orange/25"
          }`}
        >
          <div className="flex items-start gap-3">
            {notification.urgency === "info" ? (
              <Sparkles className="w-4 h-4 mt-0.5 text-panik-orange shrink-0" />
            ) : (
              <AlertTriangle
                className={`w-4 h-4 mt-0.5 shrink-0 ${
                  notification.urgency === "critical" ? "text-red-400" : "text-amber-400"
                }`}
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-mono tracking-widest uppercase text-white/40 mb-1">
                AI Advisor
              </p>
              <p className="text-sm text-white font-sans leading-relaxed">{notification.headline}</p>
              <div className="flex items-center gap-2 mt-3">
                {notification.actionLabel ? (
                  <button
                    onClick={act}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold tracking-wide transition-colors ${
                      notification.kind === "exit"
                        ? "bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25"
                        : notification.kind === "reduce"
                          ? "bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25"
                          : "bg-panik-orange/15 text-panik-orange border border-panik-orange/30 hover:bg-panik-orange/25"
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
                  className="px-3 py-1.5 rounded-lg text-[11px] font-mono text-white/60 border border-white/10 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  View in Advisor
                </button>
              </div>
            </div>
            <button onClick={dismiss} className="text-white/30 hover:text-white transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
