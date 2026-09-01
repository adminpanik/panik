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
import type { AdvisorRecommendation, AdvisorReport, AdvisorUrgency } from "../lib/live";
import { formatUsd, PROTOCOL_LABEL, RISK_CHIP, URGENCY_VERDICT } from "../lib/utils";
import { Button, Card } from "../ui";

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
  onView,
}: {
  report: AdvisorReport | null;
  /**
   * Open the Advisor tab. The card's ONE destination, and the only handler this
   * component takes now.
   *
   * It used to take `onExit` and `onOpen` too, and offer the action itself: a
   * primary button that closed a position or opened one, from a strip whose
   * whole content was a band, a sentence and two controls. That button was
   * withheld whenever the selected chain could not settle the action, so the
   * card's shape depended on a fact that has nothing to do with the reading -
   * and when it did appear, the reader was being asked to sign for a position
   * with none of the numbers the Advisor puts around that decision. Both
   * actions are still offered, on the tab this card is a door to, next to the
   * repay sizing and the alternative the engine costed.
   */
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

  /**
   * The card's one destination. It is `onView` plus the dismissal the old
   * "View in Advisor" button already did: leaving the callout up behind the tab
   * it just opened is the same recommendation stated twice.
   *
   * `act` used to live here too, branching on `kind` to fire an exit, an open
   * or a view, alongside an `actionState` that decided whether the chain could
   * settle the first two. Both are gone with the button that read them - see
   * `onView` in the props above.
   */
  const view = () => {
    onView();
    setNotification(null);
  };

  if (!notification) return null;

  /**
   * The band this urgency wears, or null on an `info` reading.
   *
   * `URGENCY_VERDICT` rather than the leg's own `numbers.band`: the two ride
   * the same ramp on purpose, but only this one has a branch for "we looked and
   * there is nothing to act on", and painting an opportunity LOW green would be
   * the ramp making a safety claim from the absence of a finding.
   */
  const verdict = URGENCY_VERDICT[notification.urgency];
  /**
   * The leg's composite, beside the word that reads it. The same field the
   * Advisor tab's own card for this leg prints, so the number the reader taps
   * through to is the number they tapped.
   */
  const score = notification.rec.numbers.total;

  return (
    /* THE ADVISOR'S VERDICT, AS ONE DOOR.
     *
     * It used to be a card with two buttons on it: a primary that signed an
     * exit, a secondary that opened the Advisor, a chip, and a dismissal. Four
     * targets on a strip whose whole content is one sentence, and the largest
     * of them was withheld or not depending on whether the selected chain could
     * settle the action, so the card had two shapes for reasons that have
     * nothing to do with the reading. The question a reader has at this point
     * on the page is "how bad, and what now", and every answer to the second
     * half is a tab away with the numbers around it: so the card states the
     * first half and IS the way to the second. One press, anywhere on it.
     *
     * A BUTTON, not a card with a click handler: a real control with a role, a
     * focus ring, and Enter and Space for free. The dismissal is a SIBLING laid
     * over the corner rather than a child, because a button inside a button is
     * not something a browser will parse.
     *
     * The band is a CELL rather than a chip. Same reading a chip gives - the
     * score in the mono face, the band word under it, both on the band's own
     * fill - at the size a headline can be read against, and it is still one
     * risk-hued element, exactly as the chip it replaces was.
     *
     * ONE SHAPE AT EVERY WIDTH. The old card reflowed into three rows on a
     * phone, so the same recommendation was a strip on a desktop and a stack on
     * a phone; there is nothing here that has to wrap.
     *
     * `role="status"` stays: it can appear without the reader doing anything,
     * so it is worth announcing and not worth interrupting. */
    <Card tone="raised" role="status" padded={false} className="relative">
      <button
        type="button"
        onClick={view}
        className="flex w-full cursor-pointer items-stretch text-left"
      >
        {verdict ? (
          <span
            className={`flex w-20 shrink-0 flex-col items-center justify-center gap-0.5 border-r-[3px] border-solid border-border-strong px-1.5 py-2.5 md:w-24 ${RISK_CHIP[verdict.band]}`}
          >
            {/* Only when it is a real number. A cell reading "NaN Critical"
                would be this product stating a measurement it does not have,
                and the word under it carries the state on its own (SC 1.4.1). */}
            {Number.isFinite(score) && (
              <span className="font-mono text-2xl font-bold leading-none tabular-nums">
                {Math.round(score)}
              </span>
            )}
            <span className="label-type text-2xs">{verdict.word}</span>
          </span>
        ) : (
          /* No band on an `info` reading, because there is none, and no figure
             either: an opportunity is not a severity. The cell keeps the card's
             one shape without asserting a state the engine did not report. */
          <span className="flex w-20 shrink-0 items-center justify-center border-r-[3px] border-solid border-border-strong bg-surface-sunken px-1.5 py-2.5 md:w-24">
            <Sparkles className="h-6 w-6 text-text-primary" aria-hidden="true" />
          </span>
        )}

        <span className="flex min-w-0 grow flex-col justify-center gap-1 px-3.5 py-3">
          <span className="font-sans text-base font-bold leading-snug text-text-primary">
            {notification.title}
          </span>
          {notification.detail && (
            <span className="font-sans text-sm leading-relaxed text-text-secondary">
              {notification.detail}
            </span>
          )}
        </span>

        {/* Centred on the card's own height, and inset by the width of the
            dismissal in the corner beside it (`pr-8`, 32px, against a 28px
            square). Cleared SIDEWAYS rather than downwards because the card is
            two lines tall at some widths and three at others: an arrow pushed
            below the corner is centred at one of those heights and off at the
            rest, while a lane the dismissal cannot reach is clear at all of
            them. These are the card's only two targets and they must not share
            a pixel.

            The label moved here from a visible line under the sentence: the
            arrow is the whole affordance now, so it carries its own name
            (`aria-label`, plus `title` for a mouse hover) rather than the
            button repeating the words the sentence already led with. */}
        <span className="flex shrink-0 items-center pr-8 pl-1" title="Open in Advisor">
          <ArrowRight className="h-5 w-5 text-text-primary" aria-label="Open in Advisor" />
        </span>
      </button>

      {/* A real accessible name, because the glyph is the whole label: this
          announced as "button" and nothing else. Laid over the corner rather
          than placed in the row, so the sentence keeps the full width of the
          card and the two controls stay separate elements. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={dismiss}
        aria-label="Dismiss this advisor notice"
        className="absolute top-0 right-0"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Card>
  );
}
