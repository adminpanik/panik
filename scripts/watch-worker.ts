/**
 * PANIK - Watch worker (standalone, runs 24/7).
 * Run:  npm run worker   (host-agnostic: Dockerfile / Procfile at repo root)
 *
 * Three loops sharing one pg pool:
 *   1. WatchService @60s scores every active watched_wallets position via the
 *      same ActiveAdapter the dev api-server uses, debounced by confirmTicks,
 *      and persists a watch_transitions row (notified_at NULL) on a confirmed
 *      profile-relative status change, plus a score_snapshots row on
 *      change / 15-min heartbeat.
 *   2. Dispatch loop @15s drains the unnotified queue, applies the anti-spam
 *      gate (materiality / cooldown / escalation), sends Telegram, and stamps
 *      notified_at + notify_channel.
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
 * NOTE THE TWO CHAINS. Loops 1-2 score Base MAINNET. Loop 3 executes on the
 * EXECUTOR's chain (Base Sepolia today, from EXIT_CHAIN_ID) because that is
 * where the audited-pending contract lives. They are deliberately different
 * clients on different RPCs; see the chain-id note in server/exitPermit.ts.
 *
 * scripts/ is .vercelignore'd, so viem + pg are free here. See
 * docs/technical-docs/TELEGRAM_ALERTS.md.
 */

import pg from "pg";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import {
  AaveActiveReader,
  ActiveAdapter,
  ALERT_POLICY,
  CoinGeckoProvider,
  CompoundActiveReader,
  DefiLlamaProvider,
  MoonwellActiveReader,
  MorphoActiveReader,
  WatchService,
  decideSend,
  formatAlert,
  statusFor,
  type ActiveScore,
  type ProfileStatus,
  type Protocol,
  type PublicClientLike,
  type RiskProfile,
  type WatchTransition,
} from "../packages/scoring/src/index";
import { transactionPoolerUrl } from "../server/profileDeps";
import { probeReachable, sendMessage } from "../server/telegram";
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
import { assessRpc, endpointsForChain, sampleAll } from "../server/rpcHealth";
import { RelayerWatch, balanceAlerts, type SignerBalance } from "../server/relayerHealth";
import { sweepCoverage, type SweepTarget } from "../server/coverageSweep";
import { ViemCoverageChain, coverageMarketsFromEnv } from "../server/coverageChain";
import { linkState, probeDue, unreachableAlert } from "../server/telegramReach";
import { ViemExitChainReader } from "../server/exitChain";
import { SupabaseDelegationStore } from "../server/exitDelegationStore";
import { SupabaseRelayerAttemptStore, MemoryRelayerAttemptStore } from "../server/relayerAttemptStore";
import { ViemRelayerChain, relayerRpcUrl } from "../server/relayerChain";
import { signerPoolFromEnv } from "../server/relayerSigner";
import {
  SubmissionRateWindow,
  consoleEventSink,
  limitsFromEnv,
  relayerEnabled,
} from "../server/relayerPolicy";
import { runRelayerTick, type RelayerCandidate, type RelayerDeps } from "../server/exitRelayer";
import {
  EXECUTOR_ADDRESS,
  EXIT_CHAIN_ID,
  EXIT_USDC_ADDRESS,
  EXIT_WETH_ADDRESS,
} from "../src/panik-core/lib/exit.generated";

const cgKey = process.env.COINGECKO_API_KEY;
const alchemyKey = process.env.ALCHEMY_API_KEY_BASE_MAINNET;
const dbUrl = process.env.SUPABASE_DB_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!cgKey || !alchemyKey || !dbUrl) {
  console.error("Missing env (COINGECKO_API_KEY / ALCHEMY_API_KEY_BASE_MAINNET / SUPABASE_DB_URL)");
  process.exit(1);
}
if (!botToken) {
  console.error("Missing env TELEGRAM_BOT_TOKEN (worker cannot send alerts)");
  process.exit(1);
}

const TICK_MS = 60_000;
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

// ── chain + scoring adapter (same construction as scripts/api-server.ts) ────
const rawClient = createPublicClient({
  chain: base,
  transport: http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`),
});
const chain = rawClient as unknown as PublicClientLike;

const providers = {
  assetRisk: new CoinGeckoProvider(cgKey),
  systemic: new DefiLlamaProvider(),
};

const adapter = new ActiveAdapter(
  [
    new AaveActiveReader(chain),
    new MoonwellActiveReader(chain),
    new CompoundActiveReader(chain, undefined, {
      onWarn: (m) => console.warn(`compound reader degraded: ${m}`),
    }),
    new MorphoActiveReader(),
  ],
  providers,
  (err) => console.error(`reader failed (other protocols continue): ${(err as Error).message.slice(0, 120)}`),
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
const profileByWallet = new Map<string, RiskProfile>();
/** Full ActiveScore per `${wallet}:${protocol}` from the latest tick. */
const lastScored = new Map<string, ActiveScore>();
/** Time (ms) of the last persisted snapshot per key, for the heartbeat. */
const lastSnapshotAt = new Map<string, number>();

function key(wallet: string, protocol: Protocol): string {
  return `${wallet.toLowerCase()}:${protocol}`;
}

// ── wallet registry ─────────────────────────────────────────────────────────
interface WatchedRow { wallet: string; risk_profile: RiskProfile; label: string | null }

async function loadWatched(): Promise<WatchedRow[]> {
  return withRetry("watched_wallets query", async () => {
    const { rows } = await db.query<WatchedRow>(
      "select wallet, risk_profile, label from public.watched_wallets where is_active order by created_at",
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
  }
  // Drop wallets no longer active.
  for (const w of [...profileByWallet.keys()]) {
    if (!active.has(w)) {
      service.unwatch(w);
      profileByWallet.delete(w);
    }
  }
}

// ── persistence ──────────────────────────────────────────────────────────────
async function maybeSnapshot(s: ActiveScore): Promise<void> {
  const k = key(s.wallet, s.protocol);
  const prev = lastScored.get(k);
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
          usd_values_unavailable)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
         (wallet, protocol, risk_profile, score, band, from_status, to_status)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [t.wallet.toLowerCase(), t.protocol, t.profile, t.score, t.band, t.from, t.to],
    );
  } catch (err) {
    console.error(`transition insert failed for ${t.wallet}:${t.protocol}: ${(err as Error).message.slice(0, 100)}`);
  }
}

// ── WatchService ──────────────────────────────────────────────────────────────
const service = new WatchService({
  scoreWallet: async (wallet) => {
    const scores = await adapter.scoreWallet(wallet);
    for (const s of scores) {
      lastScored.set(key(s.wallet, s.protocol), s);
      void maybeSnapshot(s);
    }
    return scores;
  },
  profileFor: (wallet) => profileByWallet.get(wallet.toLowerCase()) ?? "moderate",
  onTransition: (t) => void persistTransition(t),
  onError: (err, wallet) =>
    console.error(`score failed for ${wallet}: ${(err as Error).message.slice(0, 100)}`),
  intervalMs: TICK_MS,
  confirmTicks: ALERT_POLICY.confirmTicks,
});

/** Seed last committed status from the persisted transition tail (restart dedupe). */
async function seedLastStatus(): Promise<void> {
  const { rows } = await db.query<{ wallet: string; protocol: Protocol; to_status: ProfileStatus }>(
    `select distinct on (wallet, protocol) wallet, protocol, to_status
       from public.watch_transitions
      order by wallet, protocol, created_at desc`,
  );
  for (const r of rows) service.seed(r.wallet, r.protocol, r.to_status);
  console.log(`seeded ${rows.length} prior statuses`);
}

// ── dispatch loop ─────────────────────────────────────────────────────────────
interface PendingRow {
  id: string;
  wallet: string;
  protocol: Protocol;
  risk_profile: RiskProfile;
  score: number;
  band: WatchTransition["band"];
  to_status: ProfileStatus;
  created_at: string;
  chat_id: string;
  health_factor: string | null;
  collateral_usd: string | null;
  borrow_usd: string | null;
  usd_values_unavailable: boolean | null;
}

async function stamp(id: string, channel: string): Promise<void> {
  await db.query(
    "update public.watch_transitions set notified_at = now(), notify_channel = $2 where id = $1",
    [id, channel],
  );
}

async function dispatchPending(): Promise<void> {
  // First, mark recovery transitions (to_status = within) as seen so the queue
  // never accumulates them. They never notify.
  await db.query(
    "update public.watch_transitions set notified_at = now(), notify_channel = 'skipped' where notified_at is null and to_status = 'within'",
  );

  const { rows } = await db.query<PendingRow>(
    `select t.id, t.wallet, t.protocol, t.risk_profile, t.score, t.band, t.to_status,
            t.created_at, l.chat_id,
            s.health_factor, s.collateral_usd, s.borrow_usd, s.usd_values_unavailable
       from public.watch_transitions t
       join public.telegram_links l on l.wallet = t.wallet and l.enabled
       left join lateral (
         select health_factor, collateral_usd, borrow_usd, usd_values_unavailable
           from public.score_snapshots s
          where s.wallet = t.wallet and s.protocol = t.protocol
          order by created_at desc limit 1
       ) s on true
      where t.notified_at is null and t.to_status in ('approaching','outside')
      order by t.created_at
      limit 50`,
  );

  for (const r of rows) {
    const prior = await db.query<{ to_status: ProfileStatus; created_at: string }>(
      `select to_status, created_at from public.watch_transitions
        where wallet = $1 and protocol = $2 and notify_channel = 'telegram'
        order by created_at desc limit 1`,
      [r.wallet, r.protocol],
    );
    const priorRow = prior.rows[0];

    const decision = decideSend({
      toStatus: r.to_status,
      createdAt: new Date(r.created_at).getTime(),
      healthFactor: r.health_factor == null ? null : Number(r.health_factor),
      borrowUsd: r.borrow_usd == null ? null : Number(r.borrow_usd),
      // Degraded USD means the dust gate is UNEVALUABLE, not failed — waive it.
      usdValuesUnavailable: r.usd_values_unavailable === true,
      prior: priorRow
        ? { toStatus: priorRow.to_status, createdAt: new Date(priorRow.created_at).getTime() }
        : null,
    });

    if (decision !== "send") {
      await stamp(r.id, decision);
      continue;
    }

    const text = formatAlert(
      {
        wallet: r.wallet,
        protocol: r.protocol,
        profile: r.risk_profile,
        score: r.score,
        band: r.band,
        from: priorRow?.to_status ?? null,
        to: r.to_status,
      },
      {
        healthFactor: r.health_factor == null ? null : Number(r.health_factor),
        collateralUsd: r.collateral_usd == null ? null : Number(r.collateral_usd),
        borrowUsd: r.borrow_usd == null ? null : Number(r.borrow_usd),
      },
    );

    const result = await sendMessage(botToken!, Number(r.chat_id), text);
    if (result.ok) {
      await stamp(r.id, "telegram");
      // PROOF OF REACHABILITY. A delivery Telegram accepted is the strongest
      // evidence the bot can still reach this user, and stamping it here is
      // what lets the status API stop claiming coverage it has not verified in
      // a week (server/telegramReach.ts).
      await recordDelivery(Number(r.chat_id), true, false);
    } else if (result.errorCode === 403) {
      // User blocked the bot / deleted the chat: terminal. Disable + stop retrying.
      await recordDelivery(Number(r.chat_id), false, true);
      await stamp(r.id, "blocked");
      console.error(`telegram 403 for chat ${r.chat_id}; link disabled`);
    } else {
      // Transient (429/5xx/network): leave notified_at null for the next poll.
      console.error(`telegram send failed (status ${result.status}): ${result.description ?? ""}`.slice(0, 160));
    }
  }
}

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
// Which reserves a position read covers: only an asset the executor TRACKS can
// appear in a leg, so this is a configured list rather than a scan of every
// Aave reserve. Defaults to the same USDC + WETH pair the UI's ExitFlow reads;
// RELAYER_RESERVES overrides it with a comma-separated list when the deployed
// tracked-asset set widens.
function relayerReserves(): `0x${string}`[] {
  const raw = (process.env.RELAYER_RESERVES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
  if (raw.length > 0) return raw as `0x${string}`[];
  return [EXIT_USDC_ADDRESS, EXIT_WETH_ADDRESS];
}

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

  const rpcUrl = relayerRpcUrl();
  const pool = signerPoolFromEnv(rpcUrl, EXIT_CHAIN_ID);
  if (enabled && !pool) {
    console.error("relayer ARMED but no signer configured; refusing to run armed with no key");
    return null;
  }

  return {
    chain: new ViemRelayerChain({ rpcUrl, chainId: EXIT_CHAIN_ID, reserves: relayerReserves() }),
    delegations: {
      store: new SupabaseDelegationStore(supabaseUrl, supabaseKey),
      chain: new ViemExitChainReader(rpcUrl),
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
 */
async function runRelayer(): Promise<void> {
  if (!relayerDeps) return;
  const candidates: RelayerCandidate[] = [];
  for (const score of lastScored.values()) {
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

const coverageMarkets = coverageMarketsFromEnv();
const coverageChain = new ViemCoverageChain({
  rpcUrl: relayerRpcUrl(),
  chainId: EXIT_CHAIN_ID,
  reserves: coverageMarkets.aaveReserves,
});

/**
 * The wallets to sweep, with the ONE fact that drives severity: is anything
 * wrong right now?
 *
 * `atRisk` comes from the engine's own `statusFor` over the engine's own score,
 * not from a threshold invented here. A broken approval on a healthy position
 * is a warning worth fixing this week; the same break on a position the watcher
 * has already flagged is the exact moment the promise fails.
 */
function sweepTargets(): SweepTarget[] {
  const byWallet = new Map<string, { protocols: Set<Protocol>; atRisk: boolean }>();
  for (const score of lastScored.values()) {
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

/** RPC health on BOTH chains: scores read mainnet, the executor is elsewhere. */
async function checkRpc(nowMs: number): Promise<MonitorAlert[]> {
  const nowSec = Math.floor(nowMs / 1000);
  const limits = limitsFromEnv();
  const out: MonitorAlert[] = [];
  for (const [chainId, label] of [
    [base.id, "base-mainnet"],
    [EXIT_CHAIN_ID, "executor-chain"],
  ] as const) {
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
        ? sweepCoverage(targets, {
            delegations: relayerDeps.delegations,
            chain: coverageChain,
            markets: coverageMarkets,
            executor: EXECUTOR_ADDRESS,
            nowSec: Math.floor(nowMs / 1000),
            nowMs,
          }).then((reports) => reports.flatMap((r) => r.alerts))
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
    // The heartbeat is pinged AFTER the work, never before: a ping at the top
    // of a loop asserts "I started", and a loop that hangs mid-tick would keep
    // asserting health forever. Only completion is evidence.
    await beat("watch", TICK_MS);
  };

  await runTick(); // warm immediately
  setInterval(() => void runTick(), TICK_MS);
  setInterval(
    () =>
      void dispatchPending()
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
