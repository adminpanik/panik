/**
 * Alert dispatch — draining confirmed transitions to the people who asked to be
 * told about them.
 *
 * IT USED TO BE ONE ROW, ONE MESSAGE. A transition belonged to a wallet, the
 * wallet had one Telegram link, and "was this alert delivered?" was three
 * columns on `watch_transitions`. Watchlists broke that in both directions: one
 * transition can now owe messages to several chats, and the same wallet
 * produces a SEPARATE transition per subscriber profile (`watch_transitions` is
 * keyed (wallet, protocol, risk_profile) and always was).
 *
 * So the unit of work is the DELIVERY, not the transition:
 *
 *   * `watch_deliveries` holds one row per (transition, subscriber), with its
 *     own attempts counter and its own outcome. One watcher blocking the bot
 *     retires that watcher's row and nobody else's — under the old shape it
 *     stamped the transition and silenced all of them.
 *   * The anti-spam cooldown is per (chat, watched wallet, protocol). It has to
 *     be: the gate exists to stop one PERSON being messaged too often, and two
 *     people watching the same whale are not each other's spam.
 *   * The 8-attempt cap and the `undeliverable` terminal stamp are per delivery,
 *     with the same semantics they had per transition.
 *
 * WHY IT LIVES HERE and not inline in scripts/watch-worker.ts: the worker boots
 * a process on import (pools, chain clients, timers), so nothing in it can be
 * unit-tested. The fan-out and the per-chat cooldown are the two behaviours
 * most likely to regress into either silence or spam, and both are exercised in
 * server/watchDispatch.test.ts against a recording fake.
 *
 * Legacy rows: `watch_transitions.notified_at / notify_channel /
 * notify_attempts` are untouched here. Rows written before the watchlist
 * migration carry their outcome in those columns and are excluded from the
 * drain by `t.notified_at is null`; new rows never get them stamped, so the
 * deliveries ledger is the only record of what happened to them.
 */

// Specific modules, NOT the barrel — see the note in server/profileDeps.ts:
// ../packages/scoring/src/index pulls in the chain adapters (viem -> isows ->
// the optional "ws" dep) and crashes a bundled function at load.
import { decideSend, isDeferred } from "../packages/scoring/src/watch/alertPolicy";
import { digestDueAtMs } from "../packages/scoring/src/watch/alertSettings";
import {
  formatAlert,
  formatDigest,
  formatHeadline,
  formatResolution,
  type AlertExtras,
  type DigestEntry,
} from "../packages/scoring/src/watch/alertMessage";
import { decodeAlertSettings, markDigestSent } from "./alertSettingsStore";
import type { WatchTransition } from "../packages/scoring/src/watch/loop";
import type { ProfileStatus, Protocol, RiskProfile } from "../packages/scoring/src/types";
import { renderAlertCard } from "./alertCard";
import { mintDeepLinkToken } from "./sessionStore";
import {
  captionLength,
  TELEGRAM_CAPTION_MAX,
  type SendOptions,
  type SendPhotoOptions,
  type TelegramSendResult,
  type TelegramUrlButton,
} from "./telegram";

/** The slice of `pg.Pool` this module uses. */
export interface DispatchQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** One (transition, subscriber) pair the drain owes a message. */
export interface PendingDelivery {
  /** watch_transitions.id */
  id: string;
  wallet: string;
  protocol: Protocol;
  risk_profile: RiskProfile;
  score: number;
  band: WatchTransition["band"];
  from_status: ProfileStatus | null;
  to_status: ProfileStatus;
  created_at: string;
  /** The SUBSCRIBER, not the watched wallet. Alerts route to their link. */
  owner_wallet: string;
  /**
   * The subscriber's own name for the watched wallet, or null.
   *
   * Selected from the SUBSCRIPTION rather than from any wallet-level table
   * because it belongs to the reader, not to the address: two people watching
   * one whale call it different things, and each of them should be told about
   * it in their own words. `alertMessage.ts` owns what happens to it.
   */
  label: string | null;
  chat_id: string;
  health_factor: string | null;
  collateral_usd: string | null;
  borrow_usd: string | null;
  usd_values_unavailable: boolean | null;
  /**
   * Read from the TRANSITION, not from the latest snapshot, and that choice is
   * the correctness of the marker. The snapshot join is "what does this
   * position look like now"; these two columns are "what produced this
   * crossing". A scenario cleared in the seconds between the crossing and the
   * dispatch would, on the snapshot's evidence, send an unmarked alert about a
   * price that had never moved.
   */
  simulation_id: string | null;
  simulation_label: string | null;
  /** Sends already spent on THIS delivery. 0 when the row does not exist yet. */
  notify_attempts: number;
  /**
   * The subscriber's `alert_settings` row as jsonb, or null when they have
   * never changed anything (7.4 / 7.5).
   *
   * Selected as ONE column rather than eight: the shape belongs to
   * `decodeAlertSettings`, and spreading it across the row type would make
   * every future setting a change to this interface, the drain, the fake in the
   * tests and the decoder instead of just the last one.
   */
  alert_settings?: unknown;
}

export interface DispatchDeps {
  db: DispatchQueryable;
  /** Send one message to one chat. */
  send(chatId: number, text: string, opts?: SendOptions): Promise<TelegramSendResult>;
  /**
   * Upload the alert card. OPTIONAL, and its absence is a supported state, not
   * a degraded one: a caller that does not supply it gets text-only alerts,
   * which is what every caller got before the card existed.
   */
  sendPhoto?(chatId: number, photo: Uint8Array, opts?: SendPhotoOptions): Promise<TelegramSendResult>;
  /**
   * The chain this worker scores, as `ScoringChainConfig.label` spells it. Only
   * the process that built the scoring runtime knows it, so it arrives here
   * rather than being read from a constant - a testnet worker has to be able to
   * say "Base Sepolia" on its cards. Absent means the card omits the segment.
   */
  chainLabel?: string;
  /**
   * Where the "Open in PANIK" button points, before the `?view=` parameter.
   * Defaults to `PANIK_APP_URL` in the environment, then to the public app.
   */
  appUrl?: string;
  /**
   * The advisor's own triggers for this leg, or undefined when there is no
   * score fresh enough to be evidence. Supplied by the worker, which owns the
   * score cache; "why now" explained with pre-outage facts is worse than not
   * explained at all (server/scoreFreshness.ts).
   */
  whyNow(wallet: string, protocol: Protocol, profile: RiskProfile): AlertExtras["why"];
  /** Telegram accepted a message for this chat — proof of reachability. */
  onDelivered(chatId: number): Promise<void>;
  /** Telegram returned 403 for this chat — terminal. */
  onBlocked(chatId: number): Promise<void>;
  /**
   * Sends one DELIVERY gets before the queue gives up on it.
   *
   * Eight, at the 15s dispatch cadence, is about two minutes of retrying — long
   * enough to ride out a 429 burst or a Telegram 5xx, short enough that a row
   * Telegram will NEVER accept cannot hold a batch slot for the rest of time.
   * The 403 branch is separate and immediate: a blocked user is a KNOWN
   * terminal state and there is nothing to learn from seven more tries.
   */
  maxAttempts: number;
  /** Deliveries drained per pass. Default 50. */
  batchSize?: number;
  log?: { error(message: string): void };
}

/**
 * The drain.
 *
 * transitions → subscriptions on (watched_wallet, risk_profile) → the
 * subscriber's enabled Telegram link → the delivery row, if one exists yet.
 *
 * Three predicates carry the weight:
 *
 *   `t.created_at >= s.created_at` — you are told about crossings that happened
 *   AFTER you started watching. Without it, adding a wallet replays every
 *   transition it ever had straight into your chat.
 *
 *   `t.notified_at is null` — excludes the pre-watchlist rows that were already
 *   resolved through the old per-transition columns. New rows never stamp it,
 *   so it costs nothing going forward.
 *
 *   `d.notified_at is null and coalesce(d.notify_attempts, 0) < $1` — per
 *   RECIPIENT. A left join, because the first pass for a subscriber has no row
 *   yet; the stamps below create it.
 */
export const DRAIN_SQL = `select t.id, t.wallet, t.protocol, t.risk_profile, t.score, t.band,
            t.from_status, t.to_status, t.created_at,
            t.simulation_id, t.simulation_label,
            s.owner_wallet, s.label, l.chat_id,
            coalesce(d.notify_attempts, 0) as notify_attempts,
            to_jsonb(a) as alert_settings,
            snap.health_factor, snap.collateral_usd, snap.borrow_usd,
            snap.usd_values_unavailable
       from public.watch_transitions t
       join public.watch_subscriptions s
         on s.watched_wallet = t.wallet
        and s.risk_profile   = t.risk_profile
        and t.created_at    >= s.created_at
       join public.telegram_links l
         on l.wallet = s.owner_wallet and l.enabled
       left join public.watch_deliveries d
         on d.transition_id = t.id and d.owner_wallet = s.owner_wallet
       -- 7.4 / 7.5. DEPLOY ORDER MATTERS: this table must exist before a worker
       -- carrying this query starts, or every drain fails and the product stops
       -- alerting. supabase/migrations/20260823000002_alert_settings.sql.
       left join public.alert_settings a
         on a.owner_wallet = s.owner_wallet
       left join lateral (
         select health_factor, collateral_usd, borrow_usd, usd_values_unavailable
           from public.score_snapshots sn
          where sn.wallet = t.wallet and sn.protocol = t.protocol
          order by created_at desc limit 1
       ) snap on true
      where t.notified_at is null
        and d.notified_at is null
        and coalesce(d.notify_attempts, 0) < $1
      order by t.created_at
      limit $2`;

// ── the "Open in PANIK" button ──────────────────────────────────────────────

/** Where the app lives when nothing in the environment says otherwise. */
export const PANIK_APP_URL_DEFAULT = "https://www.panik.fi/app";

/** The button's label. One string, so the tests and the send cannot drift. */
export const OPEN_IN_PANIK_TEXT = "Open PANIK Advisor";

/**
 * The deep link for one watched wallet: the app, the `?view=` parameter
 * `src/panik-core/AppDemo.tsx` honours after the watchlist loads, and the tab
 * to land on.
 *
 * ADVISOR, not the default Portfolio. The message ends in an instruction ("add
 * collateral or repay debt"), and the Advisor is the screen that sizes it. A
 * button that says "open" and lands on a summary makes the reader hunt for the
 * thing the message just told them to do.
 *
 * Null rather than a best effort when the base is not an absolute http(s) URL.
 * Telegram VALIDATES button URLs and rejects the whole `sendMessage` with a 400
 * if one is malformed, so a fat-fingered `PANIK_APP_URL` would not degrade the
 * button - it would silently stop every alert in the queue from being
 * delivered. A missing button is a worse message; a rejected send is no message
 * at all.
 *
 * `sid` is an optional single-use deep-link token (server/sessionStore.ts). It
 * lets the reader land already recognised, instead of being asked to connect a
 * wallet by the very message that just told them their position is in trouble.
 * OPTIONAL IS THE POINT: null produces exactly the URL this function produced
 * before sessions existed, which is what the alert falls back to when minting
 * fails.
 */
export function viewButton(
  appUrl: string,
  wallet: string,
  sid: string | null = null,
): TelegramUrlButton | null {
  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  base.searchParams.set("view", wallet.trim().toLowerCase());
  base.searchParams.set("tab", "advisor");
  if (sid) base.searchParams.set("sid", sid);
  return { text: OPEN_IN_PANIK_TEXT, url: base.toString() };
}

/**
 * Mint this alert's deep-link token, or null if anything at all goes wrong.
 *
 * THE ALERT IS SACRED AND THE TOKEN IS NOT. Everything about this call is
 * best-effort: an unreachable database, a constraint we did not anticipate, a
 * transition id the table will not take. All of it lands on the same line —
 * log, return null, send the button WITHOUT the sid. The reader then gets the
 * alert and a sign-in prompt, which is the pre-session experience and a
 * perfectly good one; the alternative is a liquidation warning that never
 * arrived because a convenience feature had a bad day.
 *
 * Bound to `owner_wallet` — the SUBSCRIBER this delivery is for, not the
 * watched wallet. See server/sessionStore.ts.
 */
async function mintViewToken(deps: DispatchDeps, row: PendingDelivery): Promise<string | null> {
  try {
    return await mintDeepLinkToken(deps.db, row.owner_wallet, row.id);
  } catch (err) {
    deps.log?.error(
      `deep-link token mint failed for alert ${row.id} -> ${row.owner_wallet}; sending button without sid: ${(err as Error).message.slice(0, 120)}`,
    );
    return null;
  }
}

/**
 * The last few messages actually SENT to THIS chat about THIS position.
 *
 * Per chat, which is the whole point: the cooldown is a promise to a person
 * about how often they will be messaged, and two subscribers watching one whale
 * must not consume each other's budget.
 *
 * The second arm reads the legacy per-transition columns, restricted to the
 * chat linked to the watched wallet itself. Before the watchlist migration
 * every send went to that one chat, so without it the first alert after the
 * migration would find no history and fire straight through a cooldown that had
 * not actually expired.
 */
export const PRIOR_SQL = `select to_status, created_at from (
        select t.to_status, t.created_at
          from public.watch_deliveries d
          join public.watch_transitions t on t.id = d.transition_id
         where d.chat_id = $1 and t.wallet = $2 and t.protocol = $3
           and d.notify_channel = 'telegram'
        union all
        select t.to_status, t.created_at
          from public.watch_transitions t
          join public.telegram_links l on l.wallet = t.wallet
         where l.chat_id = $1 and t.wallet = $2 and t.protocol = $3
           and t.notify_channel = 'telegram'
      ) prior
      order by created_at desc
      limit 5`;

/**
 * Stamp a delivery's OUTCOME. Upsert, because the anti-spam gate can resolve a
 * delivery on the first pass, before any row exists.
 */
export const STAMP_SQL = `insert into public.watch_deliveries
         (transition_id, owner_wallet, chat_id, notify_channel, notified_at, notify_attempts)
       values ($1, $2, $3, $4, now(), $5)
       on conflict (transition_id, owner_wallet) do update
          set chat_id         = excluded.chat_id,
              notify_channel  = excluded.notify_channel,
              notified_at     = now(),
              notify_attempts = excluded.notify_attempts`;

/** Record a spent attempt without resolving the delivery. */
export const ATTEMPT_SQL = `insert into public.watch_deliveries
         (transition_id, owner_wallet, chat_id, notify_attempts)
       values ($1, $2, $3, $4)
       on conflict (transition_id, owner_wallet) do update
          set chat_id         = excluded.chat_id,
              notify_attempts = excluded.notify_attempts`;

async function stamp(
  deps: DispatchDeps,
  row: PendingDelivery,
  channel: string,
  attempts: number,
): Promise<void> {
  await deps.db.query(STAMP_SQL, [
    row.id,
    row.owner_wallet,
    Number(row.chat_id),
    channel,
    attempts,
  ]);
}

/**
 * Record a failed send, and retire the delivery once it has had its attempts.
 *
 * `undeliverable` is stamped through the same two columns every other
 * non-delivery uses, so the drain skips the row and a reader can still tell it
 * apart from a delivery: only `telegram` means Telegram accepted it. Nothing
 * here renders as delivered, and nothing here is silent — a retired alert is a
 * user who was not warned, which is worth a line in the log whatever the cause.
 */
async function recordSendFailure(
  deps: DispatchDeps,
  row: PendingDelivery,
  reason: string,
): Promise<void> {
  const attempts = (row.notify_attempts ?? 0) + 1;
  try {
    if (attempts >= deps.maxAttempts) {
      await stamp(deps, row, "undeliverable", attempts);
      deps.log?.error(
        `alert ${row.id} -> ${row.owner_wallet} (${row.wallet}:${row.protocol}) undeliverable after ${attempts} attempts: ${reason}`.slice(
          0,
          200,
        ),
      );
      return;
    }
    await deps.db.query(ATTEMPT_SQL, [
      row.id,
      row.owner_wallet,
      Number(row.chat_id),
      attempts,
    ]);
  } catch (err) {
    // The counter failing to persist is itself worth saying out loud: it is the
    // only thing standing between a permanent failure and an infinite retry.
    deps.log?.error(
      `attempt counter update failed for alert ${row.id} -> ${row.owner_wallet}: ${(err as Error).message.slice(0, 120)}`,
    );
  }
}

/**
 * Send one message, with its card if a card can be had.
 *
 * THE CARD IS NEVER LOAD-BEARING. Three things can go wrong - the renderer
 * returns null, the deps carry no `sendPhoto`, or Telegram refuses the upload -
 * and all three land on the same line: send the text. A liquidation warning
 * that did not arrive because an image renderer had a bad day is the worst
 * trade this product could make, so the fallback is the function's structure
 * rather than a defensive afterthought.
 *
 * Two shapes go out, decided by Telegram's 1024-character caption cap measured
 * AFTER entity parsing:
 *
 *   * It fits: ONE message, the card with the whole body as its caption.
 *   * It does not (a long "why now", a labelled watch-only alert): the card
 *     captioned with the headline, then the full body as an immediate
 *     follow-up. The FOLLOW-UP is the delivery that counts - the facts are what
 *     was promised, and a caption that only names the position is not them.
 */
async function deliver(
  deps: DispatchDeps,
  chatId: number,
  text: string,
  transition: WatchTransition,
  extras: AlertExtras,
  button: TelegramUrlButton | null,
): Promise<TelegramSendResult> {
  // HTML, and only for these two message kinds. `formatAlert` /
  // `formatResolution` are the only formatters that emit markup and the only
  // ones that escape what they interpolate; the webhook replies, the operator
  // pages and the welcome all still post plain text, where a parse mode would
  // turn a stray angle bracket into a 400.
  const opts = { parseMode: "HTML" as const, ...(button ? { button } : {}) };

  if (deps.sendPhoto) {
    const card = renderAlertCard(
      {
        score: transition.score,
        band: transition.band,
        status: transition.to,
        profile: transition.profile,
        wallet: transition.wallet,
        protocol: transition.protocol,
        label: extras.label ?? null,
        chainLabel: deps.chainLabel ?? null,
        simulated: extras.simulation != null || transition.simulation != null,
      },
      deps.log,
    );
    if (card) {
      const fits = captionLength(text) <= TELEGRAM_CAPTION_MAX;
      try {
        const photo = await deps.sendPhoto(chatId, card, {
          caption: fits ? text : formatHeadline(transition, extras),
          ...opts,
        });
        if (photo.ok) return fits ? photo : await deps.send(chatId, text, opts);
        deps.log?.error(
          `card upload refused (status ${photo.status}); sending text: ${(photo.description ?? "").slice(0, 120)}`,
        );
      } catch (err) {
        deps.log?.error(`card upload threw; sending text: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }

  return deps.send(chatId, text, opts);
}

/** One drain pass. Returns what it did, for the caller's logs and tests. */
export interface DispatchReport {
  /** Deliveries the drain looked at. */
  considered: number;
  /** Messages Telegram accepted. One digest counts as one message. */
  sent: number;
  /** Deliveries the anti-spam gate resolved without sending. */
  suppressed: number;
  /** Sends that failed (transient or terminal). */
  failed: number;
  /**
   * Deliveries HELD by a user preference (quiet hours, or a digest that is not
   * due yet) and left unresolved for a later pass. Distinct from `suppressed`,
   * which is a delivery nobody will ever receive.
   */
  deferred: number;
}

/** What the message builders need, reconstructed from one delivery row. */
function toEntry(deps: DispatchDeps, r: PendingDelivery): DigestEntry & { transition: WatchTransition; extras: AlertExtras } {
  const transition: WatchTransition = {
    wallet: r.wallet,
    protocol: r.protocol,
    profile: r.risk_profile,
    score: r.score,
    band: r.band,
    // The row's own record of where the position came from, not the last
    // thing we happened to SEND. A wallet whose prior alert was suppressed
    // would otherwise be described as moving from a status it never left.
    from: r.from_status,
    to: r.to_status,
    // The stamp itself is not recoverable from a row (it carries multipliers
    // and an expiry the table does not keep), so the marker travels as
    // `extras.simulation`, which asks only for what WAS persisted.
    // `formatAlert` refuses to build an unmarked body once either is set,
    // which makes "a simulated alert says so" a property of the message
    // builder rather than of this caller remembering.
    simulation: null,
  };
  const extras: AlertExtras = {
    // The reader's own name for this wallet. Straight through: the formatter
    // owns the copy, including what a too-long or whitespace-only label
    // becomes, so this path has no opinion beyond passing on what was stored.
    label: r.label,
    healthFactor: r.health_factor == null ? null : Number(r.health_factor),
    collateralUsd: r.collateral_usd == null ? null : Number(r.collateral_usd),
    borrowUsd: r.borrow_usd == null ? null : Number(r.borrow_usd),
    simulation: r.simulation_id ? { label: r.simulation_label ?? "Simulated market event" } : null,
    // The subscriber is not this wallet's owner, so nothing the message
    // advises is something the reader can do. Compared here because this is
    // the only place that holds both addresses.
    watchOnly: r.owner_wallet.trim().toLowerCase() !== r.wallet.trim().toLowerCase(),
    why: deps.whyNow(r.wallet, r.protocol, r.risk_profile),
  };
  return { transition, extras };
}

/** Alerts one subscriber is holding for their next digest. */
interface DigestBucket {
  chatId: number;
  rows: PendingDelivery[];
  lastDigestAt: string | null;
  dueAtMs: number | null;
}

/**
 * Send the digests that are due (7.5).
 *
 * Nothing critical can be in here: `decideSend` returns `deferred_digest` only
 * for an alert `isCriticalAlert` rejected, so batching is structurally incapable
 * of delaying a liquidation warning. That is asserted in
 * packages/scoring/tests/alertSettings.test.ts, not promised in this comment.
 *
 * A digest that fails to send leaves its rows UNRESOLVED but spends an attempt
 * each, so a chat Telegram will never accept retires the same way a single
 * alert does instead of re-rendering a digest every 15 seconds forever.
 */
async function flushDigests(
  deps: DispatchDeps,
  buckets: Map<string, DigestBucket>,
  nowMs: number,
  report: DispatchReport,
): Promise<void> {
  for (const [owner, bucket] of buckets) {
    if (bucket.dueAtMs === null || nowMs < bucket.dueAtMs) {
      report.deferred += bucket.rows.length;
      continue;
    }
    const entries = bucket.rows.map((r) => toEntry(deps, r));
    const text = formatDigest(entries, bucket.lastDigestAt);
    const result = await deps.send(bucket.chatId, text, { parseMode: "HTML" });
    if (result.ok) {
      for (const r of bucket.rows) await stamp(deps, r, "digest", r.notify_attempts + 1);
      await deps.onDelivered(bucket.chatId);
      // Before the stamps would be a digest the user never got, resetting their
      // clock; after them is at worst one repeated line in the next digest.
      try {
        await markDigestSent(deps.db, owner);
      } catch (err) {
        deps.log?.error(`digest clock update failed for ${owner}: ${(err as Error).message.slice(0, 120)}`);
      }
      report.sent += 1;
      continue;
    }
    if (result.errorCode === 403) {
      await deps.onBlocked(bucket.chatId);
      for (const r of bucket.rows) await stamp(deps, r, "blocked", r.notify_attempts + 1);
      deps.log?.error(`telegram 403 for chat ${bucket.chatId}; link disabled`);
    } else {
      deps.log?.error(
        `digest send failed for ${owner} (status ${result.status}): ${result.description ?? ""}`.slice(0, 200),
      );
      for (const r of bucket.rows) await recordSendFailure(deps, r, `digest HTTP ${result.status}`);
    }
    report.failed += bucket.rows.length;
  }
}

export async function dispatchPending(deps: DispatchDeps): Promise<DispatchReport> {
  const appUrl = deps.appUrl ?? process.env.PANIK_APP_URL ?? PANIK_APP_URL_DEFAULT;
  const { rows } = await deps.db.query<PendingDelivery>(DRAIN_SQL, [
    deps.maxAttempts,
    deps.batchSize ?? 50,
  ]);
  const report: DispatchReport = {
    considered: rows.length,
    sent: 0,
    suppressed: 0,
    failed: 0,
    deferred: 0,
  };
  const nowMs = Date.now();
  /** Non-critical alerts held for a digest, per subscriber. Flushed below. */
  const digests = new Map<string, DigestBucket>();

  for (const r of rows) {
    const chatId = Number(r.chat_id);
    // The last few SENT messages, newest first. A recovery is rate-limited
    // against the last message of either kind (so one all-clear per alert is the
    // ceiling), while an alert still measures its cooldown from the last ALERT —
    // an all-clear must not reset the clock and re-open the cooldown.
    const prior = await deps.db.query<{ to_status: ProfileStatus; created_at: string }>(PRIOR_SQL, [
      chatId,
      r.wallet,
      r.protocol,
    ]);
    const recovery = r.to_status === "within";
    const priorRow = recovery ? prior.rows[0] : prior.rows.find((p) => p.to_status !== "within");

    // The subscriber's own tuning (7.4). A missing row decodes to the shipped
    // defaults, so a user who never opened the settings screen gets exactly the
    // behaviour this dispatcher had before they existed.
    const stored = decodeAlertSettings(r.alert_settings ?? {});
    const createdAtMs = new Date(r.created_at).getTime();

    const decision = decideSend({
      toStatus: r.to_status,
      createdAt: createdAtMs,
      healthFactor: r.health_factor == null ? null : Number(r.health_factor),
      borrowUsd: r.borrow_usd == null ? null : Number(r.borrow_usd),
      // Degraded USD means the dust gate is UNEVALUABLE, not failed — waive it.
      usdValuesUnavailable: r.usd_values_unavailable === true,
      prior: priorRow
        ? { toStatus: priorRow.to_status, createdAt: new Date(priorRow.created_at).getTime() }
        : null,
      settings: stored.settings,
      // The band widens what counts as critical; the wallet and protocol are
      // what a mute is expressed against.
      band: r.band,
      wallet: r.wallet,
      protocol: r.protocol,
      // Quiet hours are a fact about the clock NOW, not about when the crossing
      // happened: a transition raised at 21:59 and drained at 22:01 is being
      // delivered inside the window.
      nowMs,
    });

    // Held, not resolved: no stamp and no attempt spent, so the next pass
    // reconsiders it once the window closes or the digest falls due.
    //
    // ponytail: a held row keeps its slot in the batch of 50. One subscriber in
    // quiet hours can hold at most WATCHLIST_MAX x protocols rows, so a busy
    // night could crowd the batch. If that ever shows up, filter held rows in
    // the drain (the settings are already joined) or raise batchSize.
    if (isDeferred(decision)) {
      if (decision === "deferred_digest") {
        const lastMs = stored.lastDigestAt ? new Date(stored.lastDigestAt).getTime() : null;
        const bucket = digests.get(r.owner_wallet) ?? {
          chatId,
          rows: [],
          lastDigestAt: stored.lastDigestAt,
          // The drain is ordered by created_at, so the FIRST row into a bucket
          // is the oldest one waiting - which is the clock a user who has never
          // had a digest measures their first one from.
          dueAtMs: digestDueAtMs(
            stored.settings,
            Number.isFinite(lastMs as number) ? lastMs : null,
            createdAtMs,
          ),
        };
        bucket.rows.push(r);
        digests.set(r.owner_wallet, bucket);
      } else {
        report.deferred += 1;
      }
      continue;
    }

    if (decision !== "send") {
      await stamp(deps, r, decision, r.notify_attempts);
      report.suppressed += 1;
      continue;
    }

    const { transition, extras } = toEntry(deps, r);
    const text = recovery ? formatResolution(transition, extras) : formatAlert(transition, extras);

    // Straight from the message to the position it is about. The button carries
    // the WATCHED wallet, not the subscriber's own - a watchlist alert that
    // opens the reader's own dashboard has sent them to the wrong wallet - and
    // a single-use token that signs the SUBSCRIBER in read-only on arrival.
    const button = viewButton(appUrl, r.wallet, await mintViewToken(deps, r));
    const result = await deliver(deps, chatId, text, transition, extras, button);
    if (result.ok) {
      await stamp(deps, r, "telegram", r.notify_attempts + 1);
      // PROOF OF REACHABILITY. A delivery Telegram accepted is the strongest
      // evidence the bot can still reach this user, and stamping it is what lets
      // the status API stop claiming coverage it has not verified in a week
      // (server/telegramReach.ts).
      await deps.onDelivered(chatId);
      report.sent += 1;
    } else if (result.errorCode === 403) {
      // User blocked the bot / deleted the chat: terminal for THIS chat. The
      // link is disabled, which removes every one of that subscriber's pending
      // deliveries from the next drain — and nobody else's.
      await deps.onBlocked(chatId);
      await stamp(deps, r, "blocked", r.notify_attempts + 1);
      deps.log?.error(`telegram 403 for chat ${r.chat_id}; link disabled`);
      report.failed += 1;
    } else {
      // Everything else (429, 5xx, network, and Telegram's 400s for a chat that
      // does not exist) leaves the delivery unresolved for the next poll, but no
      // longer forever: the attempt counter is what turns "retry until it works"
      // into "retry until it clearly will not".
      deps.log?.error(
        `telegram send failed (status ${result.status}, attempt ${r.notify_attempts + 1}/${deps.maxAttempts}): ${result.description ?? ""}`.slice(
          0,
          200,
        ),
      );
      await recordSendFailure(deps, r, `HTTP ${result.status} ${result.description ?? ""}`);
      report.failed += 1;
    }
  }

  // Digests last: the live alerts above have already gone out, so a batch can
  // only ever be the news that was not urgent enough to interrupt anyone.
  await flushDigests(deps, digests, nowMs, report);

  return report;
}
