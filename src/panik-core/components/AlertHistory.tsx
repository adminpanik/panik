/**
 * The alert log, in its two forms.
 *
 * `AlertFeed` is one list of alert rows, and it is the ONLY place a row's
 * markup exists: the Portfolio card shows a short preview of it and the full
 * history page shows all of it, so the two cannot drift into looking like
 * different products.
 *
 * `AlertHistoryView` is the full page. It is not a modal and not a sixth tab
 * (see the note on the view itself).
 */

import React, { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import type { HistoryAlert, LiveProtocol } from "../lib/live";
import { limitEventCopy, limitStateCopy } from "../lib/utils";
import { Button, Card, EmptyState } from "../ui";
import { InfoTip } from "./InfoTip";

/**
 * How many alerts the Portfolio card previews.
 *
 * Measured, not guessed. At a 1440 window the card is the flex-1 child of the
 * right-hand column, so the position list beside it sets its height: 317px of
 * card, which leaves 194px between the heading and the "See all alerts" button.
 * Four rows measure 182px (39 + 53 + 53 + 37; the first and last rows drop their
 * outer padding), so the list fills the well with 12px to spare. A fifth row
 * needs another 53px and would push the column past the list beside it.
 */
export const ALERT_PREVIEW_COUNT = 4;

/**
 * One alert row's layout, shared by the linked (button) and inert (div) forms.
 *
 * `py-4` is the `p-4` a position row carries, so the two cards standing side by
 * side on Portfolio share one rhythm. At `py-2.5` with 12px content this feed
 * was visibly denser and smaller than the list beside it, which read as a
 * secondary panel rather than the other half of the same dashboard. The rules
 * stay hairlines rather than becoming boxes: a bordered row inside a bordered
 * card is chrome wrapping chrome, and `divide-y` is what this card is for.
 */
const ALERT_ROW_CLS =
  "flex w-full items-baseline justify-between gap-3 py-4 first:pt-0 last:pb-0";

/** Alert-outcome chip copy for the history feed. */
const CHIP_QUIET = "text-text-muted border-border-subtle bg-white/[0.03]";

/**
 * Delivery outcome, not risk. "Sent" was green and "queued" amber, which put
 * the risk ramp on a fact about our own plumbing. Only `blocked` keeps a hue:
 * it is the one state where PANIK is failing to reach the user, and that is
 * worth interrupting for.
 */
const NOTIFY_CHANNEL_CHIP: Record<string, { label: string; cls: string }> = {
  suppressed_cooldown: { label: "Muted · cooldown", cls: CHIP_QUIET },
  suppressed_immaterial: { label: "Muted · no debt", cls: CHIP_QUIET },
  blocked: { label: "Bot blocked", cls: "text-risk-critical border-risk-critical/25 bg-risk-critical/10" },
};

/**
 * Outcomes that render NO chip. Same rationale that left only `blocked` hued,
 * taken one step further: a chip that says "Sent · Telegram" on eleven of
 * twelve rows is the expected case drawn twelve times, and the one row that
 * matters — the alert that did not reach you — has to compete with it.
 *
 * `telegram` is delivery succeeding. `skipped` is a recovery, where the row's
 * own "back under your risk limit" already says there was nothing to send.
 * Everything else still renders: queued, both suppressions, blocked, and any
 * channel we do not know.
 * Silence here means "PANIK reached you", so nothing that failed can borrow it.
 */
const DELIVERY_SILENT = new Set(["telegram", "skipped"]);

/** null = delivered as expected, so the row stays one quiet line. */
export function deliveryChip(channel: string | null): { label: string; cls: string } | null {
  if (channel === null) return { label: "Queued", cls: CHIP_QUIET };
  if (DELIVERY_SILENT.has(channel)) return null;
  return NOTIFY_CHANNEL_CHIP[channel] ?? { label: channel, cls: CHIP_QUIET };
}

export function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface AlertFeedProps {
  alerts: HistoryAlert[];
  /**
   * The engine's protocol id -> the name a person reads. Passed in rather than
   * re-declared: six components already carry a copy of this map and a seventh
   * is how the app ends up calling one protocol two things.
   */
  protocolLabel: Record<LiveProtocol, string>;
  /** protocol -> `positionKey` of the open position an alert is about. */
  targets: Map<LiveProtocol, string>;
  onSelectTarget: (positionKey: string) => void;
}

/** One list of alert rows, hairline-separated. */
export function AlertFeed({ alerts, protocolLabel, targets, onSelectTarget }: AlertFeedProps) {
  return (
    <div className="divide-y divide-border-subtle">
      {alerts.map((a, i) => {
        const chip = deliveryChip(a.notify_channel);
        const label = protocolLabel[a.protocol] ?? a.protocol;
        const event = limitEventCopy(a.to_status);
        const when = timeAgo(a.created_at);
        /* The position this alert is ABOUT, if the wallet still holds it. A
           closed position has no row to scroll to, so the alert stays a record
           rather than becoming a control: no button, no hover, no pointer. A
           control that looks live and does nothing is worse than a plain line
           of text. */
        const target = targets.get(a.protocol) ?? null;
        /* The score, the band and the ORIGIN status live here rather than in the
           row: the band is a pure function of the score, and "approaching →
           outside" is a state-machine dump on the card whose job is to say what
           happened to someone's money. What happened is the destination. */
        const hover = `PANIK score ${a.score} (${a.band}). ${
          a.from_status
            ? `Previously ${limitStateCopy(a.from_status)}.`
            : "First reading recorded for this position."
        }${target ? "" : " This position is no longer open."}`;
        const body = (
          <>
            {/* Wraps rather than truncates: clipping this line kept the protocol
                and ate the event, which is the half that says whether things got
                worse.

                14px/600 in primary ink, the same weight a position row gives its
                money line. The protocol and what happened to it are the content
                of this row, and content is not what `text-muted` and 12px are
                for. */}
            <span className="min-w-0 text-left text-sm font-sans font-semibold text-text-primary">
              {label}
              <span className="text-text-secondary font-normal"> {event}</span>
              {/* The space is load-bearing: `ml-1` is margin, not whitespace, so
                  without it a screen reader and every text scrape run the event
                  into the chip ("risk limitQueued"). */}
              {chip && (
                <>{" "}<span className={`ml-1 inline-block align-middle text-2xs font-sans px-1.5 py-0.5 rounded-sm border ${chip.cls}`}>
                  {chip.label}
                </span></>
              )}
            </span>
            {/* Timestamps stay muted. This is what text-muted is FOR — you glance
                at it, you do not read it. */}
            <span className="text-xs font-sans text-text-muted shrink-0 tabular-nums">{when}</span>
          </>
        );
        return target ? (
          /* A real <button>, not a div with onClick: it is in the tab order,
             Enter and Space activate it, the global :focus-visible ring applies,
             and the accessibility tree calls it a button because it is one. */
          <button
            type="button"
            key={`${a.created_at}-${i}`}
            onClick={() => onSelectTarget(target)}
            title={hover}
            aria-label={`${label} ${event}${chip ? `, ${chip.label}` : ""}, ${when}. Show this position.`}
            className={`${ALERT_ROW_CLS} rounded-sm text-left cursor-pointer transition-colors hover:bg-white/[0.03]`}
          >
            {body}
          </button>
        ) : (
          <div key={`${a.created_at}-${i}`} className={ALERT_ROW_CLS} title={hover}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The day an alert belongs to, as a person names it. Local time on purpose: an
 * alert that reached someone at 11pm belongs to their evening, not to the next
 * UTC day. The year is always printed, because "14 March" with no year is a
 * date a reader has to guess at once a log is a few months old.
 */
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** Consecutive runs of alerts that fall on one local day, input order kept. */
function groupByDay(alerts: HistoryAlert[], now: number): { key: string; label: string; rows: HistoryAlert[] }[] {
  const groups: { key: string; label: string; rows: HistoryAlert[] }[] = [];
  for (const a of alerts) {
    const key = new Date(a.created_at).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(a);
    else groups.push({ key, label: dayLabel(a.created_at, now), rows: [a] });
  }
  return groups;
}

interface AlertHistoryViewProps {
  /** Newest first. The caller owns the ordering so the card's preview and this
   *  page cannot disagree about which alerts are the most recent. */
  alerts: HistoryAlert[];
  protocolLabel: Record<LiveProtocol, string>;
  targets: Map<LiveProtocol, string>;
  onSelectTarget: (positionKey: string) => void;
  onClose: () => void;
}

/**
 * The full alert log.
 *
 * A VIEW inside the Portfolio panel, not a modal and not a sixth tab.
 *
 * Not a modal: the complaint this replaces is "reading the log through a small
 * scrolling window", and a dialog is a smaller window with a scroller in it.
 *
 * Not a tab: the phone tab bar splits the viewport five ways (78px a tab at
 * 390); a sixth destination costs every tab a fifth of its target and promotes
 * a detail of one card to a peer of Compass and Watch. Portfolio stays selected
 * while this is open, so `panel-portfolio` keeps the `aria-labelledby` pair the
 * tabs pattern depends on.
 *
 * The section takes focus on open (it is `tabIndex={-1}`, so it is a focus
 * target without joining the tab order) and Escape closes it, which is the
 * dismissal contract a keyboard user expects from anything that takes over the
 * page. Returning focus to the trigger is the caller's job, because the trigger
 * unmounts while this is open.
 */
export function AlertHistoryView({
  alerts,
  protocolLabel,
  targets,
  onSelectTarget,
  onClose,
}: AlertHistoryViewProps) {
  const view = useRef<HTMLElement>(null);
  useEffect(() => {
    view.current?.focus();
  }, []);

  const groups = groupByDay(alerts, Date.now());

  return (
    <section
      ref={view}
      tabIndex={-1}
      aria-labelledby="alert-history-heading"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="outline-hidden space-y-6"
    >
      <div className="border-b border-border-subtle pb-5 space-y-3">
        {/* Above the title, not beside it: a back affordance that stacks under
            its own heading on a phone is a back affordance you find last. */}
        <Button variant="quiet" onClick={onClose}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to portfolio
        </Button>
        <div>
          <h1
            id="alert-history-heading"
            className="text-2xl font-sans font-extrabold tracking-tight text-text-primary"
          >
            Alert history
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-xs font-sans text-text-secondary">
            {alerts.length === 1 ? "1 alert" : `${alerts.length} alerts`}, newest first
            <InfoTip text="Every risk-status change PANIK detected. A chip appears only when the alert did not reach you; delivered alerts stay quiet." />
          </p>
        </div>
      </div>

      {alerts.length === 0 ? (
        /* "clear", not "problem": an empty log means we watched this wallet and
           nothing crossed its limit, which is good news. A failed fetch would be
           `problem`, and the two must never look alike. */
        <EmptyState
          tone="clear"
          title="No alerts yet"
          hint="PANIK messages you the moment a position crosses your profile's risk limit."
        />
      ) : (
        /* ONE card with dated sections inside it, not one card per day. A log
           where most days hold a single alert draws twelve bordered boxes for
           twelve rows, which is chrome wrapping chrome again; the hairline that
           separates rows separates days just as well, and the date sits on the
           run it names. */
        <Card>
          <div className="divide-y divide-border-subtle">
            {groups.map((g) => (
              <div key={g.key} className="space-y-2 py-4 first:pt-0 last:pb-0">
                <h2 className="text-xs font-sans font-semibold text-text-secondary">{g.label}</h2>
                <AlertFeed
                  alerts={g.rows}
                  protocolLabel={protocolLabel}
                  targets={targets}
                  onSelectTarget={onSelectTarget}
                />
              </div>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}
