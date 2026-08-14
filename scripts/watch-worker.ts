/**
 * PANIK - Watch worker (standalone, runs 24/7).
 * Run:  npm run worker   (host-agnostic: Dockerfile / Procfile at repo root)
 *
 * Three loops sharing one pg pool:
 *   1. WatchService @60s scores every active watched_wallets position via the
 *      same ActiveAdapter the dev api-server uses, debounced by confirmTicks,
 *      and persists a watch_transitions row (notified_at NULL) on a confirmed
 *      profile-relative status change, plus a score_snapshots row on
 *      change / 15-min heartbeat. A wallet is scored ONCE however many people
 *      watch it; the resulting total is evaluated against each DISTINCT
 *      subscriber profile, so ten watchers cost one chain read and at most
 *      three status comparisons.
 *   2. Dispatch loop @15s drains the pending DELIVERIES (server/watchDispatch.ts),
 *      applies the anti-spam gate (materiality / cooldown / escalation) per
 *      CHAT, sends Telegram, and stamps a watch_deliveries row. A recovery row
 *      sends the all-clear (formatResolution) instead of an alert, rate-limited
 *      by the same gate. Delivery attempts are BOUNDED (NOTIFY_MAX_ATTEMPTS)
 *      per recipient: the drain reads a fixed batch, so rows Telegram will
 *      never accept — a 400 for a chat that no longer exists — used to hold
 *      that batch against every other user's alerts for as long as the worker
 *      ran, and used to retire one transition for every watcher at once.
 *   3. Relayer loop @30s (Phase 4.A) offers every scored position to
 *      server/exitRelayer.ts, which submits a delegated exit when the user's
 *      SIGNED trigger has fired. IT SHIPS DISARMED: RELAYER_ENABLED defaults
 *      off, and off means the loop still evaluates and simulates every
 *      candidate and logs what it WOULD have done, so the decision can be
 *      watched against real positions long before anyone arms it.
 *   4. Monitor loop @5min (Phase 4.B) is the loop that watches the PROMISE
 *      rather than a component: RPC health across two providers, relayer
 *      balance against the burst its own caps allow, the coverage sweep (would
 *      the exit actually execute?), Telegram reachability, and the heartbeat
 *      staleness of the other loops. See server/monitorAlerts.ts.
 *
 * EVERY LOOP PINGS A HEARTBEAT on completion. The absence of a ping past one
 * expected cycle is itself a page (server/workerHeartbeat.ts), because a worker
 * that dies or hangs silences every other alert at once and silence is
 * indistinguishable from health. The row lives in Postgres so the API process —
 * deployed separately, with its own lifecycle — can be the one that notices.
 *
 * AND LIVENESS IS NOT HEALTH. A completed tick that scored nothing stamps a
 * heartbeat as healthy as any other, which is how a multi-day reader outage ran
 * unnoticed: every loop ticked, every leg was rejected, no transition was
 * written and therefore no alert was queued. Loop 1 also reports what it
 * PRODUCED, and a run of empty ticks against a non-empty registry is a page of
 * its own (server/scoringBlind.ts).
 *
 * NOTE THE TWO CHAINS. Loops 1-2 score the chain PANIK_SCORING_CHAIN selects
 * (Base mainnet by default; server/scoringChain.ts). Loop 3 executes on the
 * EXECUTOR's chain (Base Sepolia today, from EXIT_CHAIN_ID) because that is
 * where the audited-pending contract lives. They are separate clients on
 * separate RPCs, and they COINCIDE when the scoring chain is set to testnet:
 * see the chain-id note in server/exitPermit.ts.
 *
 * scripts/ is .vercelignore'd, so viem + pg are free here. See
 * docs/technical-docs/TELEGRAM_ALERTS.md.
 */

import pg from "pg";
import {
  ALERT_POLICY,
  CoinGeckoProvider,
  DefiLlamaProvider,
  WatchService,
  adviseLeg,
  // decideSend / formatAlert / formatResolution moved with the drain into
  // server/watchDispatch.ts.
  statusFor,
  type ActiveScore,
  type AlertExtras,
  type ProfileStatus,
  type Protocol,
  type RiskProfile,
  type WatchTransition,
} from "../packages/scoring/src/index";
import { describeReaderError } from "../server/readerError";
import { dispatchPending, type DispatchDeps } from "../server/watchDispatch";
import { subscriberProfiles } from "../server/watchlist";
import { alchemyKeyNotice, buildScoringChain, resolveAlchemyKey } from "../server/scoringChain";
import { SimulationCache, SimulationStore } from "../server/simulationStore";
import { transactionPoolerUrl } from "../server/profileDeps";
import { probeReachable, sendMessage, sendPhoto } from "../server/telegram";
import {
  AlertDispatcher,
  MemoryAlertLedger,
  SupabaseAlertLedger,
  operatorLogSink,
  operatorWebhookSink,
  type AlertLedger,
  type AlertSink,
  type MonitorAlert,
} from "../server/monitorAlerts";
import {
  MemoryHeartbeatStore,
  SupabaseHeartbeatStore,
  heartbeatAlerts,
  type HeartbeatStore,
} from "../server/workerHeartbeat";
import { ScoringBlindWatch } from "../server/scoringBlind";
import {
  freshScores,
  isScoreFresh,
  scoreMaxAgeMs,
  type StampedScore,
} from "../server/scoreFreshness";
import { assessRpc, endpointsForChain, sampleAll } from "../server/rpcHealth";
import { RelayerWatch, balanceAlerts, type SignerBalance } from "../server/relayerHealth";
import { sweepCoverage, type CoverageMarkets, type SweepTarget } from "../server/coverageSweep";
import { ViemCoverageChain, coverageMarketsFromEnv } from "../server/coverageChain";
import { linkState, probeDue, unreachableAlert } from "../server/telegramReach";
import { ViemExitChainReader } from "../server/exitChain";
import { SupabaseDelegationStore } from "../server/exitDelegationStore";
import { SupabaseRelayerAttemptStore, MemoryRelayerAttemptStore } from "../server/relayerAttemptStore";
import { ViemRelayerChain, relayerReserveOverride } from "../server/relayerChain";
import { signerPoolFromEnv } from "../server/relayerSigner";
import {
  SubmissionRateWindow,
  consoleEventSink,
  limitsFromEnv,
  relayerEnabled,
} from "../server/relayerPolicy";
import { runRelayerTick, type RelayerCandidate, type RelayerDeps } from "../server/exitRelayer";
// No EXIT_USDC_ADDRESS / EXIT_WETH_ADDRESS here on purpose. The reserve set the
// relayer and the sweep read is resolved from chain (see
// src/panik-core/lib/exitReserves.ts); EXIT_USDC_ADDRESS is the executor's
// PAYOUT token and naming it as a reserve is the bug this worker used to carry.
import { EXECUTOR_ADDRESS, EXIT_CHAIN_ID } from "../src/panik-core/lib/exit.generated";

const cgKey = process.env.COINGECKO_API_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
// Same switch, same default, same helper as scripts/api-server.ts - the worker
// and the API must never score different chains for the same wallet.
const alchemy = resolveAlchemyKey(process.env.PANIK_SCORING_CHAIN, process.env);
if (!cgKey || !dbUrl) {
  console.error(
    `Missing env (COINGECKO_API_KEY / SUPABASE_DB_URL)` +
      ` - scoring chain is ${alchemy.config.label} (PANIK_SCORING_CHAIN=${process.env.PANIK_SCORING_CHAIN ?? "unset"})`,
  );
  process.exit(1);
}
// A missing Alchemy key is a WARNING, not a boot failure: every chain has a
// keyless public node at the head of its fallback list (server/scoringChain.ts),
// and exiting here turned an expired free tier into a silent alerting outage.
const alchemyNotice = alchemyKeyNotice(alchemy);
if (alchemyNotice) console.warn(alchemyNotice);
if (!botToken) {
  console.error("Missing env TELEGRAM_BOT_TOKEN (worker cannot send alerts)");
  process.exit(1);
}

/** Floor at 15s: a tick is O(wallets x protocols) chain reads, so a tiny value is a self-inflicted rate limit. */
const TICK_MS = Math.max(15_000, Number(process.env.WATCH_TICK_MS) || 60_000);
console.log(`watch tick ${TICK_MS}ms (WATCH_TICK_MS=${process.env.WATCH_TICK_MS ?? "unset"})`);
const DISPATCH_MS = 15_000;
const RELAYER_MS = 30_000;
const SNAPSHOT_HEARTBEAT_MS = 15 * 60_000;
const WALLET_RELOAD_EVERY_TICKS = 5;
/**
 * Monitor cadence (Phase 4.B). Five minutes, not sixty seconds: the sweep does
 * O(wallets x reserves) RPC reads, and none of the conditions it looks for
 * (a revoked approval, an installed 7702 delegate, an expiring permit) appear
 * and disappear inside a minute. Fast enough to bound how long a silent gap can
 * stand, slow enough not to be its own load problem.
 */
const MONITOR_MS = 5 * 60_000;
/**
 * How old an entry in `lastScored` may be before its consumers treat it as
 * UNKNOWN rather than as current. Three ticks; see server/scoreFreshness.ts.
 */
const SCORE_MAX_AGE_MS = scoreMaxAgeMs(TICK_MS);

// ── chain + scoring adapter (same construction as scripts/api-server.ts) ────
const providers = {
  assetRisk: new CoinGeckoProvider(cgKey),
  systemic: new DefiLlamaProvider(),
};

/**
 * The armed market simulation, read through a 10s TTL cache.
 *
 * The worker and the API are separate processes, so this row is the only thing
 * that can tell them the same story: an operator arms a scenario against the
 * API and the very next watch tick here scores under it, within one TTL. And
 * because the cache re-judges expiry against the current clock on every read,
 * a scenario dies on schedule even if this process has been unable to reach the
 * database since it was armed. Unconfigured Supabase leaves it permanently
 * null, which is exactly the previous behaviour.
 */
const simulations = (() => {
  try {
    return new SimulationCache(SimulationStore.fromEnv());
  } catch {
    console.warn("market simulation disabled: SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return null;
  }
})();

const scoringChain = buildScoringChain({
  mode: process.env.PANIK_SCORING_CHAIN,
  alchemyKey: alchemy.key,
  providers,
  onReaderError: (err) =>
    console.error(`reader failed (other protocols continue): ${describeReaderError(err)}`),
  onCompoundWarn: (m) => console.warn(`compound reader degraded: ${m}`),
  simulation: () => simulations?.current() ?? null,
});
const adapter = scoringChain.adapter;
console.log(
  `scoring chain: ${scoringChain.config.label} (${scoringChain.config.chainId}), ` +
    `protocols ${scoringChain.config.protocols.join(", ")}, ` +
    `market context ${scoringChain.config.marketContext}`,
);

// ── pg pool (transaction pooler 6543; same self-heal as api-server) ─────────
const db = new pg.Pool({
  connectionString: transactionPoolerUrl(),
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});
db.on("error", (err) => console.error(`db pool error (recovered): ${err.message}`));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`${label} attempt ${attempt} failed: ${(err as Error).message.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

// ── shared state ────────────────────────────────────────────────────────────
/**
 * The registry's single derived profile per wallet: the STRICTEST any
 * subscriber asked for (see watchlist_sync_registry). Read by the consumers
 * that need one number for a wallet — the coverage sweep's `atRisk` flag, and
 * the fallback when a wallet has no subscription rows at all. Alert evaluation
 * does NOT use it; that is `profilesByWallet`.
 */
const profileByWallet = new Map<string, RiskProfile>();
/**
 * Every DISTINCT profile among a wallet's subscribers, at most three.
 *
 * This is what makes ten watchers cost one scoring pass: the wallet is scored
 * once and the resulting total is compared against each distinct threshold,
 * producing one transition stream per (wallet, protocol, profile).
 */
const profilesByWallet = new Map<string, RiskProfile[]>();
/**
 * Full ActiveScore per `${wallet}:${protocol}`, STAMPED with the tick that read
 * it.
 *
 * The stamp is load-bearing, not bookkeeping. Nothing evicts from this map, so
 * an outage leaves every entry sitting here looking exactly like a current
 * reading, and its three consumers (the relayer's candidate set, the coverage
 * sweep, the alert's why-now line) all act on it as if it described the wallet
 * now. Each of them rejects entries older than SCORE_MAX_AGE_MS, and a rejected
 * entry means UNKNOWN: the position leaves the set rather than being carried
 * forward as unchanged. See server/scoreFreshness.ts.
 */
const lastScored = new Map<string, StampedScore<ActiveScore>>();
/** Time (ms) of the last persisted snapshot per key, for the heartbeat. */
const lastSnapshotAt = new Map<string, number>();
/**
 * Legs the scoring pass has produced since boot. MONOTONIC on purpose: the
 * blind-scoring detector reads the DELTA across a tick rather than a counter
 * this loop resets, so two ticks that overlap (a pass that overruns its own
 * period) cannot lose each other's legs and manufacture an empty tick.
 */
let legsScoredTotal = 0;

function key(wallet: string, protocol: Protocol): string {
  return `${wallet.toLowerCase()}:${protocol}`;
}

// ── wallet registry ─────────────────────────────────────────────────────────
interface WatchedRow {
  wallet: string;
  risk_profile: RiskProfile;
  label: string | null;
  /** Every distinct profile among this wallet's subscribers (Postgres text[]). */
  profiles: string[] | null;
}

/**
 * The active registry, plus the profiles its subscribers asked for.
 *
 * `watched_wallets` is still the registry — it is what says a wallet is polled
 * at all, and the ops console and admin metrics read it. What changed is that
 * one wallet can now be watched by several people at different thresholds, so
 * the thing that drives ALERT evaluation is the aggregated subscriber list, not
 * the registry's own (derived, strictest-wins) `risk_profile` column.
 *
 * A left join, not an inner one: a registry row with no subscription is a state
 * the migration's backfill rules out, but if one ever appears the honest answer
 * is to keep watching it under its own column rather than to silently stop.
 */
async function loadWatched(): Promise<WatchedRow[]> {
  return withRetry("watched_wallets query", async () => {
    const { rows } = await db.query<WatchedRow>(
      `select w.wallet, w.risk_profile, w.label,
              array_remove(array_agg(distinct s.risk_profile), null) as profiles
         from public.watched_wallets w
         left join public.watch_subscriptions s on s.watched_wallet = w.wallet
        where w.is_active
        group by w.wallet, w.risk_profile, w.label, w.created_at
        order by w.created_at`,
    );
    return rows;
  });
}

function syncWatched(service: WatchService, rows: WatchedRow[]): void {
  const active = new Set(rows.map((r) => r.wallet.toLowerCase()));
  for (const r of rows) {
    const w = r.wallet.toLowerCase();
    service.watch(w);
    profileByWallet.set(w, r.risk_profile);
    profilesByWallet.set(w, subscriberProfiles(r.profiles, r.risk_profile));
  }
  // Drop wallets no longer active.
  for (const w of [...profileByWallet.keys()]) {
    if (!active.has(w)) {
      service.unwatch(w);
      profileByWallet.delete(w);
      profilesByWallet.delete(w);
    }
  }
}

// ── persistence ──────────────────────────────────────────────────────────────
async function maybeSnapshot(s: ActiveScore): Promise<void> {
  const k = key(s.wallet, s.protocol);
  const prev = lastScored.get(k)?.score;
  const lastAt = lastSnapshotAt.get(k) ?? 0;
  const changed =
    !prev || prev.total !== s.total || prev.band !== s.band;
  const heartbeatDue = Date.now() - lastAt >= SNAPSHOT_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;

  // Degraded legs have null USD, so LTV comes from the engine's own ratio
  // (denomination-free) rather than from dividing two unknowns.
  const ltv =
    s.collateralValueUsd !== null && s.borrowValueUsd !== null && s.collateralValueUsd > 0
      ? s.borrowValueUsd / s.collateralValueUsd
      : null;
  try {
    await db.query(
      `insert into public.score_snapshots
         (wallet, protocol, total, band, sub_scores, health_factor, current_ltv,
          collateral_usd, borrow_usd, collateral_symbol, asset_risk_is_proxy,
          usd_values_unavailable, simulation_id, simulation_hf_multiplier)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        s.wallet.toLowerCase(),
        s.protocol,
        s.total,
        s.band,
        JSON.stringify(s.subScores),
        s.healthFactor,
        ltv,
        s.collateralValueUsd,
        s.borrowValueUsd,
        s.scoredCollateralSymbol,
        s.assetRiskIsProxy,
        s.usdValuesUnavailable,
        // NULL = scored from real prices. Written here rather than derived
        // later because the scenario can be cleared a minute after the snapshot
        // and the row still has to say what produced it.
        s.simulation?.id ?? null,
        s.simulation?.healthFactorMultiplier ?? null,
      ],
    );
    lastSnapshotAt.set(k, Date.now());
  } catch (err) {
    console.error(`snapshot insert failed for ${k}: ${(err as Error).message.slice(0, 100)}`);
  }
}

async function persistTransition(t: WatchTransition): Promise<void> {
  try {
    await db.query(
      `insert into public.watch_transitions
         (wallet, protocol, risk_profile, score, band, from_status, to_status,
          simulation_id, simulation_label)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        t.wallet.toLowerCase(),
        t.protocol,
        t.profile,
        t.score,
        t.band,
        t.from,
        t.to,
        // The crossing is real; the price that caused it may not have been.
        // The label is denormalised so the dispatcher can mark the alert
        // without a join - an alert whose marker depends on a join is an alert
        // that goes out unmarked the day the join fails.
        t.simulation?.id ?? null,
        t.simulation?.label ?? null,
      ],
    );
  } catch (err) {
    console.error(`transition insert failed for ${t.wallet}:${t.protocol}: ${(err as Error).message.slice(0, 100)}`);
  }
}

// ── WatchService ──────────────────────────────────────────────────────────────
const service = new WatchService({
  scoreWallet: async (wallet) => {
    const scores = await adapter.scoreWallet(wallet);
    legsScoredTotal += scores.length;
    const at = Date.now();
    for (const s of scores) {
      lastScored.set(key(s.wallet, s.protocol), { score: s, at });
      void maybeSnapshot(s);
    }
    return scores;
  },
  profileFor: (wallet) => profileByWallet.get(wallet.toLowerCase()) ?? "moderate",
  profilesFor: (wallet) => profilesByWallet.get(wallet.toLowerCase()) ?? [],
  onTransition: (t) => void persistTransition(t),
  onError: (err, wallet) =>
    console.error(`score failed for ${wallet}: ${(err as Error).message.slice(0, 100)}`),
  intervalMs: TICK_MS,
  confirmTicks: ALERT_POLICY.confirmTicks,
});

/**
 * Seed last committed status from the persisted transition tail (restart dedupe).
 *
 * Per (wallet, protocol, PROFILE), because that is the grain the in-memory state
 * now keeps and the grain `watch_transitions` has always stored. Collapsing the
 * profile here would seed one subscriber's status over another's and re-fire, or
 * suppress, the first observation after every restart.
 */
async function seedLastStatus(): Promise<void> {
  const { rows } = await db.query<{
    wallet: string;
    protocol: Protocol;
    risk_profile: RiskProfile;
    to_status: ProfileStatus;
  }>(
    `select distinct on (wallet, protocol, risk_profile)
            wallet, protocol, risk_profile, to_status
       from public.watch_transitions
      order by wallet, protocol, risk_profile, created_at desc`,
  );
  for (const r of rows) service.seed(r.wallet, r.protocol, r.to_status, r.risk_profile);
  console.log(`seeded ${rows.length} prior statuses`);
}

// ── dispatch loop ─────────────────────────────────────────────────────────────
//
// The drain itself lives in server/watchDispatch.ts. One confirmed transition
// now owes a message to EVERY subscriber watching that wallet at that profile,
// and the two behaviours most likely to regress — the fan-out and the per-chat
// cooldown — are exactly the ones that fail silently in both directions (a
// missed warning, or the same person messaged five times about one whale). This
// file boots a process on import, so nothing in it can be unit-tested; the drain
// moved somewhere a test can reach it, and what stays here is the three things
// only the process has: the pool, the bot token, and the in-memory score cache.

/**
 * How many sends one DELIVERY gets before the queue gives up on it.
 *
 * Eight, at the 15s dispatch cadence, is about two minutes of retrying — long
 * enough to ride out a 429 burst or a Telegram 5xx, short enough that a row
 * Telegram will NEVER accept cannot hold a batch slot for the rest of time.
 *
 * PER DELIVERY, not per transition, and that is the watchlist change: under the
 * old shape one watcher whose chat had been deleted burned the transition's
 * whole budget and retired the alert for everyone else watching that wallet.
 *
 * The 403 branch in the drain is still separate and still immediate: a blocked
 * user is a KNOWN terminal state and there is nothing to learn from seven more
 * tries. This cap is for the failures we cannot classify — 400 "chat not found"
 * being the one that actually wedged the queue, because it is permanent and
 * does not announce itself as such.
 */
const NOTIFY_MAX_ATTEMPTS = 8;

/**
 * The advisor's own triggers for this leg, plus the facts that phrase them, so
 * the alert can state WHY it fired (7.1). Read from the in-memory ActiveScore of
 * the tick that produced the transition - the same object the snapshot row was
 * written from. Undefined right after a restart (the map is cold until the first
 * tick), and the message then simply omits the why-now line rather than
 * reconstructing one from a stale row.
 *
 * A score too old to be evidence is treated exactly like a cold map: omitted.
 * "Why now" is a claim about the moment of the crossing, and explaining it with
 * facts from before an outage is worse than not explaining it at all.
 *
 * The PROFILE is the SUBSCRIBER's, not the wallet's. The same crossing sent to a
 * conservative watcher and to an aggressive one is phrased against each one's
 * own thresholds, because that is what each of them asked to be told about.
 */
function whyNowFor(wallet: string, protocol: Protocol, profile: RiskProfile): AlertExtras["why"] {
  const entry = lastScored.get(key(wallet, protocol));
  if (!entry || !isScoreFresh(entry, Date.now(), SCORE_MAX_AGE_MS)) return undefined;
  const rec = adviseLeg(entry.score, profile);
  return {
    triggers: rec.triggers,
    facts: { ...rec.numbers, protocol: rec.protocol, profile },
  };
}

/**
 * What the drain cannot own: the pool, the bot, the score cache, and the
 * reachability stamp.
 *
 * `recordDelivery` is a hoisted function declaration defined further down (it
 * belongs with the monitoring core that also calls it); this object is only
 * READ inside an interval callback, long after module evaluation.
 */
const dispatchDeps: DispatchDeps = {
  db,
  send: (chatId, text, opts) => sendMessage(botToken!, chatId, text, opts),
  sendPhoto: (chatId, photo, opts) => sendPhoto(botToken!, chatId, photo, opts),
  whyNow: whyNowFor,
  onDelivered: (chatId) => recordDelivery(chatId, true, false),
  onBlocked: (chatId) => recordDelivery(chatId, false, true),
  maxAttempts: NOTIFY_MAX_ATTEMPTS,
  log: { error: (message: string) => console.error(message) },
};

// ── monitoring core (Phase 4.B) ──────────────────────────────────────────────
//
// Declared BEFORE the relayer so the relayer's event sink can be wired through
// `relayerWatch`: 4.A already emits a named event for every submission, failure
// and skip, and 4.B's job is to consume those, not to re-derive them.
//
// DELIVERY. Two operator channels, both optional, plus one that is always on:
//
//   * `operatorLogSink` — a single JSON line per alert on stderr. Never
//     disabled. The log drain is the one path that cannot itself be down, and
//     it is what a log-based monitor keys on.
//   * `MONITOR_OPERATOR_WEBHOOK_URL` — generic JSON POST; the body carries both
//     a rendered `text` (so a Slack/Discord incoming webhook works untouched)
//     and the structured alert.
//   * `MONITOR_OPERATOR_TELEGRAM_CHAT_ID` — pages an operator chat through the
//     bot this worker already holds a token for. No new infrastructure.
//
// USER-FACING alerts (an expiring permit, a coverage gap the user can fix) ride
// the EXISTING Telegram path: same bot, same links table, same 403 handling.
// They are gated by the same ledger, so a standing condition prompts a user
// once per window rather than once per five-minute tick.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

/**
 * The gate is DURABLE when Supabase is configured and in-memory otherwise.
 *
 * The fallback is honest but weaker and says so: an in-memory gate means a
 * crash-loop re-fires every standing condition, which is the spam failure the
 * durable ledger exists to prevent. It is still better than no gate.
 */
const alertLedger: AlertLedger =
  SUPABASE_URL && SUPABASE_KEY
    ? new SupabaseAlertLedger(SUPABASE_URL, SUPABASE_KEY)
    : new MemoryAlertLedger();
const heartbeats: HeartbeatStore =
  SUPABASE_URL && SUPABASE_KEY
    ? new SupabaseHeartbeatStore(SUPABASE_URL, SUPABASE_KEY)
    : new MemoryHeartbeatStore();
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "monitoring degraded: SUPABASE_URL / SUPABASE_SECRET_KEY missing, so the alert gate and the " +
      "heartbeat are process-local — a crash re-fires every standing alert and no other process " +
      "can observe this worker's death",
  );
}

const operatorChatId = process.env.MONITOR_OPERATOR_TELEGRAM_CHAT_ID;
const operatorWebhook = process.env.MONITOR_OPERATOR_WEBHOOK_URL;

const alertSinks: AlertSink[] = [operatorLogSink];
if (operatorWebhook && operatorWebhook.trim()) {
  alertSinks.push(operatorWebhookSink(operatorWebhook.trim()));
}
if (operatorChatId && /^-?\d+$/.test(operatorChatId.trim())) {
  const chat = Number(operatorChatId.trim());
  alertSinks.push(async (alert) => {
    await sendMessage(botToken!, chat, formatOperatorMessage(alert));
  });
}

/**
 * How often the same standing condition may reach a USER.
 *
 * Once a day, deliberately slower than the operator cadence. An operator who
 * gets an hourly reminder about a broken approval is being kept honest; a user
 * who gets one is being harassed into muting the bot that is supposed to warn
 * them about a liquidation. The gate is the same ledger, under a `user:` key
 * prefix, so the two cadences cannot interfere with each other.
 */
const USER_ALERT_REPEAT_MS = 24 * 3_600_000;

/**
 * The USER sink. Only alerts carrying a `userMessage` and a wallet reach a
 * user, and only through the wallet's own enabled link — an operator alert must
 * never leak to a customer, and a user must never be told about a wallet that
 * is not theirs.
 */
const userSink: AlertSink = async (alert) => {
  if (!alert.userMessage || !alert.wallet) return;

  const allowed = await alertLedger
    .claim({ ...alert, key: `user:${alert.key}` }, USER_ALERT_REPEAT_MS, Date.now())
    // A ledger outage fails open for the operator (a missed page is the worse
    // failure) and CLOSED for the user, where the worse failure is a message
    // every five minutes.
    .catch(() => false);
  if (!allowed) return;

  const { rows } = await db.query<{ chat_id: string }>(
    "select chat_id from public.telegram_links where wallet = $1 and enabled",
    [alert.wallet.toLowerCase()],
  );
  const chatId = rows[0]?.chat_id;
  if (!chatId) return;
  const result = await sendMessage(botToken!, Number(chatId), alert.userMessage);
  if (result.ok) {
    await recordDelivery(Number(chatId), true, false);
  } else if (result.errorCode === 403) {
    await recordDelivery(Number(chatId), false, true);
  }
};
alertSinks.push(userSink);

const alerts = new AlertDispatcher(alertLedger, alertSinks);
const relayerWatch = new RelayerWatch();
/**
 * The one monitor that watches what the watch loop PRODUCES rather than that it
 * ran. Fed from `runTick` at watch cadence, not from the 5-minute monitor loop:
 * the condition is a run of consecutive ticks, so it has to see every tick.
 */
const scoringWatch = new ScoringBlindWatch();

function formatOperatorMessage(alert: MonitorAlert): string {
  const lines = [`[${alert.severity.toUpperCase()}] ${alert.kind}`, alert.summary];
  if (alert.wallet) lines.push(`wallet: ${alert.wallet}`);
  return lines.join("\n").slice(0, 3_500);
}

/** Fire and forget, but never silently: a failed page is itself an incident. */
function raise(list: readonly MonitorAlert[]): void {
  if (list.length === 0) return;
  void alerts
    .dispatch(list)
    .catch((err) => console.error(`alert dispatch failed: ${(err as Error).message.slice(0, 160)}`));
}

/**
 * Record what Telegram told us about a chat.
 *
 * `blocked` is set ONLY on a 403, so `unreachable_since` means "Telegram said
 * we are blocked" and never "we have not heard from them lately". Those are
 * different facts with different alert severities, and conflating them is how
 * the old `enabled` flag ended up lying.
 */
async function recordDelivery(chatId: number, ok: boolean, blocked: boolean): Promise<void> {
  try {
    await db.query(
      `update public.telegram_links
          set last_delivered_at   = case when $2 then now() else last_delivered_at end,
              unreachable_since   = case when $3 then now()
                                         when $2 then null
                                         else unreachable_since end,
              enabled             = case when $3 then false else enabled end,
              updated_at          = now()
        where chat_id = $1`,
      [chatId, ok, blocked],
    );
  } catch (err) {
    console.error(`reachability stamp failed for chat ${chatId}: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** Ping a loop's heartbeat. Never throws: a failed ping must not kill a loop. */
async function beat(loop: string, intervalMs: number): Promise<void> {
  try {
    await heartbeats.ping(loop, intervalMs, Date.now());
  } catch (err) {
    console.error(`heartbeat ping (${loop}) failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** The loops whose absence is a page. Adding a loop means adding it here. */
const EXPECTED_LOOPS = ["watch", "dispatch", "monitor"] as const;
const LOOP_INTERVALS: Record<string, number> = {
  watch: TICK_MS,
  dispatch: DISPATCH_MS,
  monitor: MONITOR_MS,
};
const BOOTED_AT = Date.now();

// ── relayer loop (Phase 4.A) ─────────────────────────────────────────────────
//
// DISARMED BY DEFAULT. `relayerEnabled()` reads RELAYER_ENABLED and treats
// anything other than an explicit true/1/yes as OFF, so a typo or a swallowed
// value fails towards "did not spend money".
//
// Which reserves a position read covers. Empty is the normal case and means
// "resolve from chain": ViemRelayerChain intersects the Aave market's own
// reserve list with the executor's tracked assets, once per process.
//
// This used to default to `[EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS]`.
// EXIT_USDC_ADDRESS is `executor.usdc()` - the token the executor PAYS OUT in -
// and the Aave V3 Base Sepolia market does not list it, so `getUserReserveData`
// against it reverted for every wallet, while every real reserve other than
// WETH was simply never looked at. A position collateralised in cbETH or USDT
// would have produced legs that silently left it in place.
const RESERVE_OVERRIDE = relayerReserveOverride();

/**
 * Build the relayer's dependencies, or null when it cannot run safely.
 *
 * A missing Supabase config is fatal to the relayer and ONLY the relayer: the
 * attempt ledger is what stops a crash-restart re-firing a permit, so running
 * without it would trade the durable idempotency guard for a process-local map.
 * That is acceptable for a dry run (nothing is submitted) and never acceptable
 * once armed, which is exactly how it is gated below.
 */
function buildRelayerDeps(): RelayerDeps | null {
  const enabled = relayerEnabled();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("relayer disabled: SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return null;
  }

  // No rpcUrl anywhere below: every executor-side client resolves the SAME
  // ladder from `executorRpcUrls(EXIT_CHAIN_ID)` by default, so the relayer, its
  // signers and the delegation reader cannot end up on different nodes.
  const pool = signerPoolFromEnv(undefined, EXIT_CHAIN_ID);
  if (enabled && !pool) {
    console.error("relayer ARMED but no signer configured; refusing to run armed with no key");
    return null;
  }

  return {
    chain: new ViemRelayerChain({ chainId: EXIT_CHAIN_ID, reserves: RESERVE_OVERRIDE }),
    delegations: {
      store: new SupabaseDelegationStore(supabaseUrl, supabaseKey),
      chain: new ViemExitChainReader(),
      chainId: EXIT_CHAIN_ID,
      executor: EXECUTOR_ADDRESS,
    },
    // The durable ledger is required to ARM. A dry run never claims a row, so
    // an in-memory stand-in there costs nothing and keeps the loop observable
    // on a host that has not been given the table yet.
    attempts: enabled
      ? new SupabaseRelayerAttemptStore(supabaseUrl, supabaseKey)
      : new MemoryRelayerAttemptStore(),
    pool,
    limits: limitsFromEnv(),
    hourly: new SubmissionRateWindow(),
    // 4.A's structured events go to stdout exactly as before AND through the
    // 4.B observer, which turns a failure into a page and a permit that keeps
    // being skipped for the same reason into one too. The relayer is unaware of
    // either — it emits facts, this decides what is worth waking someone for.
    emit: (event) => {
      consoleEventSink(event);
      raise(relayerWatch.observe(event, Date.now()));
    },
    enabled,
    executor: EXECUTOR_ADDRESS,
    expectedChainId: EXIT_CHAIN_ID,
  };
}

const relayerDeps = buildRelayerDeps();

/**
 * Offer this tick's scored positions to the relayer.
 *
 * Candidates come from `lastScored`, which the WatchService fills with the
 * ENGINE's own ActiveScore — the relayer never recomputes a health factor. Only
 * positions carrying debt are offered: a position with no debt has no leg to
 * build and would only produce a `no_legs` skip.
 *
 * AND ONLY POSITIONS SCORED RECENTLY. The `healthFactor` on each candidate is
 * what `runRelayerTick` compares against the user's SIGNED trigger, so an entry
 * left over from before a scoring outage would arm a real transaction on a
 * reading nothing has confirmed since. A position with no fresh score is
 * unknown, and unknown does not enter the candidate set — the relayer is never
 * asked to decide it, which is why nothing in server/exitRelayer.ts needs to
 * change.
 */
async function runRelayer(): Promise<void> {
  if (!relayerDeps) return;
  const { fresh, staleKeys } = freshScores(lastScored, Date.now(), SCORE_MAX_AGE_MS);
  if (staleKeys.length > 0) {
    console.debug(
      `relayer: ${staleKeys.length} position(s) held out, no score inside ${Math.round(SCORE_MAX_AGE_MS / 1000)}s: ` +
        `${staleKeys.slice(0, 5).join(", ")}${staleKeys.length > 5 ? " …" : ""}`,
    );
  }
  const candidates: RelayerCandidate[] = [];
  for (const score of fresh) {
    if (score.borrowValueUsd !== null && score.borrowValueUsd <= 0) continue;
    candidates.push({
      wallet: score.wallet.toLowerCase() as `0x${string}`,
      // Deliberately NOT cast: the engine's `Protocol` and the executor's
      // `LiveProtocol` are the same four names today, and this assignment is
      // what makes a future divergence a compile error rather than a silent
      // `PROTOCOL_ID[undefined]` that mis-reads the permit's protocol mask.
      protocol: score.protocol,
      healthFactor: score.healthFactor,
    });
  }
  if (candidates.length === 0) return;

  const report = await runRelayerTick(candidates, relayerDeps);
  if (report.submitted > 0 || Object.keys(report.reasons).length > 0) {
    console.log(
      `relayer tick: ${report.candidates} candidates, ${report.submitted} submitted, ` +
        `${report.skipped} skipped${report.dryRun ? " (DRY RUN)" : ""} ${JSON.stringify(report.reasons)}`,
    );
  }
}

// ── monitor loop (Phase 4.B) ─────────────────────────────────────────────────

const coverageChain = new ViemCoverageChain({
  chainId: EXIT_CHAIN_ID,
  // Same override as the relayer, and the same chain resolution when it is
  // unset. The sweep verifying a different reserve list from the one the relayer
  // acts on would defeat the point of the sweep.
  reserves: RESERVE_OVERRIDE,
});

/**
 * The sweep's market set, built per pass from the resolved reserves.
 *
 * Resolution is cached in `loadExitReserveSet`, so this is free after the first
 * pass; it is called per pass rather than once at module load so that a node
 * that was unreachable at boot does not permanently leave the worker sweeping
 * nothing. If it throws, `runMonitor`'s per-check catch logs a failed coverage
 * sweep - which is the honest outcome, and never a clean bill of health.
 */
async function coverageMarkets(): Promise<CoverageMarkets> {
  return coverageMarketsFromEnv(await coverageChain.aaveReserves());
}

/**
 * The wallets to sweep, with the ONE fact that drives severity: is anything
 * wrong right now?
 *
 * `atRisk` comes from the engine's own `statusFor` over the engine's own score,
 * not from a threshold invented here. A broken approval on a healthy position
 * is a warning worth fixing this week; the same break on a position the watcher
 * has already flagged is the exact moment the promise fails.
 *
 * A position with no fresh score is left out, and leaving it out is the honest
 * answer in both directions: sweeping it would verify coverage against a stale
 * picture, and `atRisk` derived from a stale score would either invent an
 * emergency or, worse, quietly downgrade a real one to "healthy". Unknown is
 * not "within". The blind-scoring page (server/scoringBlind.ts) is what covers
 * the case where this empties out.
 */
function sweepTargets(): SweepTarget[] {
  const byWallet = new Map<string, { protocols: Set<Protocol>; atRisk: boolean }>();
  const { fresh, staleKeys } = freshScores(lastScored, Date.now(), SCORE_MAX_AGE_MS);
  if (staleKeys.length > 0) {
    console.debug(
      `coverage sweep: ${staleKeys.length} position(s) held out, no score inside ` +
        `${Math.round(SCORE_MAX_AGE_MS / 1000)}s: ${staleKeys.slice(0, 5).join(", ")}` +
        `${staleKeys.length > 5 ? " …" : ""}`,
    );
  }
  for (const score of fresh) {
    const wallet = score.wallet.toLowerCase();
    const profile = profileByWallet.get(wallet);
    // A wallet that has dropped out of the registry is no longer monitored, and
    // sweeping it would page about coverage nobody is watching.
    if (!profile) continue;
    const entry = byWallet.get(wallet) ?? { protocols: new Set<Protocol>(), atRisk: false };
    entry.protocols.add(score.protocol);
    if (statusFor(profile, score.total) !== "within") entry.atRisk = true;
    byWallet.set(wallet, entry);
  }
  return [...byWallet.entries()].map(([wallet, v]) => ({
    wallet: wallet as `0x${string}`,
    protocols: [...v.protocols],
    atRisk: v.atRisk,
  }));
}

/**
 * RPC health on every chain the worker depends on: the one scores are read from
 * and the one the executor lives on. Deduplicated by chain id, because the two
 * COINCIDE when PANIK_SCORING_CHAIN=testnet and probing the same endpoints
 * twice would double every alert about them.
 */
async function checkRpc(nowMs: number): Promise<MonitorAlert[]> {
  const nowSec = Math.floor(nowMs / 1000);
  const limits = limitsFromEnv();
  const out: MonitorAlert[] = [];
  const chains = new Map<number, string>([
    [scoringChain.config.chainId, `scoring-${scoringChain.config.alchemyHost}`],
  ]);
  if (!chains.has(EXIT_CHAIN_ID)) chains.set(EXIT_CHAIN_ID, "executor-chain");
  for (const [chainId, label] of chains) {
    const endpoints = endpointsForChain(chainId);
    if (endpoints.length === 0) continue;
    const samples = await sampleAll(endpoints);
    out.push(
      ...assessRpc(samples, {
        staleAfterSec: limits.sequencerStaleAfterSec,
        nowSec,
        nowMs,
        chainLabel: label,
      }),
    );
  }
  return out;
}

/** Relayer signer balances, against the burst the configured caps allow. */
async function checkRelayerBalances(nowMs: number): Promise<MonitorAlert[]> {
  const pool = relayerDeps?.pool;
  if (!relayerDeps || !pool) return [];
  const balances: SignerBalance[] = [];
  for (const signer of pool.all()) {
    try {
      balances.push({ address: signer.address, balanceWei: await signer.balance() });
    } catch (err) {
      console.error(`signer balance read failed (${signer.label}): ${(err as Error).message.slice(0, 120)}`);
    }
  }
  if (balances.length === 0) return [];
  // The fee is read LIVE so the threshold tracks a gas spike instead of being
  // invalidated by one. A failed read falls back to the last known good rather
  // than to a constant, and with no known good it skips the pool-wide check
  // entirely — a threshold derived from a made-up gas price is worse than none.
  let fee: bigint;
  try {
    fee = (await relayerDeps.chain.fees()).maxFeePerGas;
  } catch (err) {
    console.error(`fee read failed, skipping burst check: ${(err as Error).message.slice(0, 120)}`);
    return balanceAlerts(balances, relayerDeps.limits, 0n, nowMs).filter(
      (a) => a.kind !== "relayer.balance_under_burst",
    );
  }
  return balanceAlerts(balances, relayerDeps.limits, fee, nowMs);
}

/** Telegram reachability: probe stale links, page on unreachable at-risk users. */
async function checkTelegram(targets: readonly SweepTarget[], nowMs: number): Promise<MonitorAlert[]> {
  const out: MonitorAlert[] = [];
  const { rows } = await db.query<{
    wallet: string;
    chat_id: string;
    enabled: boolean;
    last_delivered_at: Date | null;
    last_probe_at: Date | null;
    last_probe_ok: boolean | null;
    unreachable_since: Date | null;
  }>(
    `select wallet, chat_id, enabled, last_delivered_at, last_probe_at, last_probe_ok, unreachable_since
       from public.telegram_links`,
  );
  const atRisk = new Set(targets.filter((t) => t.atRisk).map((t) => t.wallet.toLowerCase()));

  for (const r of rows) {
    let row = {
      chatId: Number(r.chat_id),
      enabled: r.enabled,
      lastDeliveredAt: r.last_delivered_at?.getTime() ?? null,
      lastProbeAt: r.last_probe_at?.getTime() ?? null,
      lastProbeOk: r.last_probe_ok,
      unreachableSince: r.unreachable_since?.getTime() ?? null,
    };

    if (probeDue(row, nowMs)) {
      const result = await probeReachable(botToken!, row.chatId);
      const blocked = result.errorCode === 403;
      await db.query(
        `update public.telegram_links
            set last_probe_at     = now(),
                last_probe_ok     = $2,
                unreachable_since = case when $3 then now() when $2 then null else unreachable_since end,
                enabled           = case when $3 then false else enabled end,
                updated_at        = now()
          where chat_id = $1`,
        [row.chatId, result.ok, blocked],
      );
      row = {
        ...row,
        lastProbeAt: nowMs,
        lastProbeOk: result.ok,
        unreachableSince: blocked ? nowMs : result.ok ? null : row.unreachableSince,
        enabled: blocked ? false : row.enabled,
      };
    }

    // Only wallets with something to be alerted ABOUT. An unreachable link on a
    // healthy position is a fact, not an emergency, and paging on all of them
    // is how a channel earns a mute rule.
    if (!atRisk.has(r.wallet.toLowerCase())) continue;
    const alert = unreachableAlert(r.wallet, linkState(row, nowMs), nowMs);
    if (alert) out.push(alert);
  }
  return out;
}

/**
 * One monitor pass. Each check is isolated: a failing RPC probe must not stop
 * the coverage sweep, because the sweep is the check that catches the failure
 * mode nothing else can see.
 */
async function runMonitor(): Promise<void> {
  const nowMs = Date.now();
  const targets = sweepTargets();

  const checks: [string, Promise<MonitorAlert[]>][] = [
    ["rpc", checkRpc(nowMs)],
    ["relayer balances", checkRelayerBalances(nowMs)],
    ["telegram", checkTelegram(targets, nowMs)],
    [
      "coverage sweep",
      relayerDeps
        ? coverageMarkets()
            .then((markets) =>
              sweepCoverage(targets, {
                delegations: relayerDeps.delegations,
                chain: coverageChain,
                markets,
                executor: EXECUTOR_ADDRESS,
                nowSec: Math.floor(nowMs / 1000),
                nowMs,
              }),
            )
            .then((reports) => reports.flatMap((r) => r.alerts))
        : Promise.resolve([]),
    ],
    [
      "heartbeat",
      heartbeats
        .list()
        .then((records) =>
          heartbeatAlerts(records, EXPECTED_LOOPS, nowMs, {
            bootedAt: BOOTED_AT,
            expectedIntervalMs: LOOP_INTERVALS,
          }),
        ),
    ],
  ];

  for (const [label, promise] of checks) {
    try {
      raise(await promise);
    } catch (err) {
      console.error(`monitor check "${label}" failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  await beat("monitor", MONITOR_MS);
}

// ── boot ──────────────────────────────────────────────────────────────────────
let tickCount = 0;
/** `legsScoredTotal` as of the end of the previous tick. */
let legsScoredAtLastTick = 0;

async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) =>
    console.error(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`),
  );

  await seedLastStatus();
  syncWatched(service, await loadWatched());
  console.log(`watching ${profileByWallet.size} wallets; confirmTicks=${ALERT_POLICY.confirmTicks}, cooldown=${ALERT_POLICY.cooldownMs / 3_600_000}h`);

  // Drive ticks ourselves (instead of service.start()) so we can interleave the
  // periodic wallet reload on the same cadence.
  const runTick = async () => {
    tickCount += 1;
    if (tickCount % WALLET_RELOAD_EVERY_TICKS === 0) {
      try {
        syncWatched(service, await loadWatched());
      } catch (err) {
        console.error(`wallet reload skipped: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    await service.tick();
    // WHAT THE TICK PRODUCED, not just that it ran. A tick that scores nothing
    // completes normally and stamps a healthy heartbeat, which is exactly how a
    // multi-day reader outage went unalerted: alive and blind reads as alive.
    // See server/scoringBlind.ts.
    const legsScored = legsScoredTotal - legsScoredAtLastTick;
    legsScoredAtLastTick = legsScoredTotal;
    raise(
      scoringWatch.observe({
        legsScored,
        walletsWatched: profileByWallet.size,
        at: Date.now(),
      }),
    );
    // The heartbeat is pinged AFTER the work, never before: a ping at the top
    // of a loop asserts "I started", and a loop that hangs mid-tick would keep
    // asserting health forever. Only completion is evidence.
    await beat("watch", TICK_MS);
  };

  await runTick(); // warm immediately
  setInterval(() => void runTick(), TICK_MS);
  setInterval(
    () =>
      void dispatchPending(dispatchDeps)
        .then(() => beat("dispatch", DISPATCH_MS))
        .catch((e) => console.error(`dispatch error: ${(e as Error).message.slice(0, 120)}`)),
    DISPATCH_MS,
  );

  if (relayerDeps) {
    console.log(
      `relayer loop @${RELAYER_MS / 1000}s on chain ${EXIT_CHAIN_ID} executor ${EXECUTOR_ADDRESS}: ` +
        `${relayerDeps.enabled ? "ARMED" : "DRY RUN (RELAYER_ENABLED is off)"}` +
        `, signers ${relayerDeps.pool?.size ?? 0}`,
    );
    setInterval(
      () => void runRelayer().catch((e) => console.error(`relayer error: ${(e as Error).message.slice(0, 160)}`)),
      RELAYER_MS,
    );
  } else {
    console.log("relayer loop not started (see the reason logged above)");
  }

  // Monitor loop. Started LAST and run once immediately, so the first pass
  // happens while the process is demonstrably healthy and establishes the
  // heartbeat baseline every later absence is measured against.
  setInterval(
    () => void runMonitor().catch((e) => console.error(`monitor error: ${(e as Error).message.slice(0, 200)}`)),
    MONITOR_MS,
  );
  void runMonitor().catch((e) => console.error(`monitor error: ${(e as Error).message.slice(0, 200)}`));
  console.log(
    `monitor loop @${MONITOR_MS / 60_000}min: operator channels = log` +
      `${operatorWebhook ? " + webhook" : ""}${operatorChatId ? " + telegram" : ""}`,
  );

  console.log("watch worker running");
}

void main().catch((err) => {
  console.error(`worker fatal: ${(err as Error).message}`);
  process.exit(1);
});
