/**
 * The Portfolio's advisor callout: what the Advisor would tell this reader
 * about the wallet they are looking at, on the tab that lists it.
 *
 * NOT A POPUP any more, and not a shell-level band either. It is an ordinary
 * card the Portfolio places under its page header and over its stat row, so it
 * pushes the dashboard down rather than covering anything, appears only where
 * it is about something, and takes the same treatment as the Advisor tab's own
 * verdict card. The name is kept because the SELECTION logic below - what fires,
 * when, and how often - is the thing this file owns and none of it changed.
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
import { ArrowRight, Sparkles, X } from "lucide-react";
import type {
  AdvisorOpenPlan,
  AdvisorRecommendation,
  AdvisorReport,
  AdvisorUrgency,
} from "../lib/live";
import { formatUsd, PROTOCOL_LABEL, URGENCY_VERDICT } from "../lib/utils";
import { Button, Card, RiskChip } from "../ui";
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
  /** The verdict, as a headline. See `legLines`. */
  title: string;
  /** One line under it, or none. */
  detail: string | null;
  actionLabel: string | null;
  rec: AdvisorRecommendation;
  kind: "exit" | "reduce" | "open" | "info";
}

/**
 * A leg's verdict as a HEADLINE and one detail line, in the Advisor panel's
 * vocabulary.
 *
 * What this replaces was a single sentence in the ENGINE'S enum: "Aave V3
 * position moved to EXIT - full atomic exit recommended." Three things were
 * wrong with it and each is a house rule. It printed `EXIT` and `REDUCE`, which
 * are engine tokens the UI is never allowed to render. It used a hyphen as a
 * dash. And it described a STATE CHANGE ("moved to") rather than what to do,
 * on the one surface that exists to say what to do.
 *
 * The wording is the Advisor panel's own verdict card, deliberately: the same
 * wallet, the same recommendation and the same action must not read as two
 * different findings depending on which screen the reader is standing on.
 */
function legLines(rec: AdvisorRecommendation): { title: string; detail: string | null } {
  const label = PROTOCOL_LABEL[rec.protocol] ?? rec.protocol;
  switch (rec.action) {
    case "EXIT":
      return { title: `Exit recommended on ${label}`, detail: null };
    case "REDUCE":
      return {
        title: `Reduce your ${label} exposure`,
        detail: rec.repayPlan
          ? `Repay ~${formatUsd(rec.repayPlan.repayUsd)} to bring it back in range.`
          : null,
      };
    case "REBALANCE":
      return { title: "Rebalance to a safer protocol", detail: `This is your ${label} position.` };
    default:
      // Every other action reaches here only through the `notable` filter in
      // `selectNotification`, which admits three. A default that printed
      // `rec.action` would put an engine enum on screen the moment a fourth
      // arrives, so it names the position and leaves the verdict to the panel.
      return { title: `Your ${label} position has changed`, detail: null };
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
      ...legLines(rec),
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
      title: `New ${plan.collateralSymbol} position available on ${PROTOCOL_LABEL[rec.protocol] ?? rec.protocol}`,
      detail:
        plan.apy !== null
          ? `About ${(plan.apy * 100).toFixed(1)}% APY, and it scores within your profile.`
          : "It scores within your profile.",
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

  if (!notification) return null;

  /** The band this urgency wears, or null on an `info` reading. */
  const verdict = URGENCY_VERDICT[notification.urgency];

  return (
    /* THE ADVISOR PANEL'S VERDICT CARD, on the Portfolio.
     *
     * It used to be a strip in the shell's notice band: an eyebrow reading "AI
     * Advisor", one sentence in the engine's own enum, and a primary that
     * rendered DISABLED whenever the exit could not be signed on the selected
     * chain. The disabled control was the loudest thing in the band and the one
     * thing on it that could not be pressed, which is the failure the position
     * rows already fixed by withholding an action they cannot perform.
     *
     * The shape is the Advisor tab's own verdict card now: a white plate, the
     * band as ONE `RiskChip`, the headline in the panel's wording and one
     * detail line under it. Deliberate rather than incidental - the same
     * wallet, the same recommendation and the same action must not read as two
     * different findings depending on which tab the reader is standing on.
     *
     * The CALLER places it, inside the Portfolio's own column, under the page
     * header and over the stat row. A recommendation is about this wallet's
     * positions, and the tab listing those positions is where it belongs; the
     * shell band it used to sit in put it over Compass and Settings too, which
     * is a message about positions on screens that are not about them.
     *
     * `role="status"` stays: it can appear without the reader doing anything,
     * so it is worth announcing and not worth interrupting. */
    <Card tone="raised" role="status" className="flex items-start gap-3">
      {verdict ? (
        <RiskChip band={verdict.band}>{verdict.word}</RiskChip>
      ) : (
        /* No band on an `info` reading, because there is none: an opportunity
           is not a severity, and painting it LOW green would be the ramp making
           a safety claim from the absence of a finding. */
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-text-primary" aria-hidden="true" />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-sans text-base font-bold text-text-primary">{notification.title}</p>
        {notification.detail && (
          <p className="font-sans text-sm leading-relaxed text-text-secondary">
            {notification.detail}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {/* WITHHELD, not disabled. `actionState` is false when the selected
              chain cannot settle this action, and a greyed primary is the
              largest element on the card asserting something the product cannot
              do, with its reason on a hover neither a phone nor a keyboard
              reaches. The secondary below is always live, so the card never
              ends with nothing to press. */}
          {notification.actionLabel && actionState.enabled && (
            <Button onClick={act}>
              {notification.actionLabel} <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="secondary"
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
          announced as "button" and nothing else. `Button` also gives it a hit
          area over the 24px floor SC 2.5.8 sets. */}
      <Button variant="ghost" onClick={dismiss} aria-label="Dismiss this advisor notice">
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Card>
  );
}
