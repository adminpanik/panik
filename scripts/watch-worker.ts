/**
 * PANIK - Watch worker (standalone, runs 24/7).
 * Run:  npm run worker   (host-agnostic: Dockerfile / Procfile at repo root)
 *
 * Two loops sharing one pg pool:
 *   1. WatchService @60s scores every active watched_wallets position via the
 *      same ActiveAdapter the dev api-server uses, debounced by confirmTicks,
 *      and persists a watch_transitions row (notified_at NULL) on a confirmed
 *      profile-relative status change, plus a score_snapshots row on
 *      change / 15-min heartbeat.
 *   2. Dispatch loop @15s drains the unnotified queue, applies the anti-spam
 *      gate (materiality / cooldown / escalation), sends Telegram, and stamps
 *      notified_at + notify_channel.
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
  type ActiveScore,
  type ProfileStatus,
  type Protocol,
  type PublicClientLike,
  type RiskProfile,
  type WatchTransition,
} from "../packages/scoring/src/index";
import { transactionPoolerUrl } from "../server/profileDeps";
import { sendMessage } from "../server/telegram";

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
const SNAPSHOT_HEARTBEAT_MS = 15 * 60_000;
const WALLET_RELOAD_EVERY_TICKS = 5;

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
    } else if (result.errorCode === 403) {
      // User blocked the bot / deleted the chat: terminal. Disable + stop retrying.
      await db.query("update public.telegram_links set enabled = false, updated_at = now() where chat_id = $1", [r.chat_id]);
      await stamp(r.id, "blocked");
      console.error(`telegram 403 for chat ${r.chat_id}; link disabled`);
    } else {
      // Transient (429/5xx/network): leave notified_at null for the next poll.
      console.error(`telegram send failed (status ${result.status}): ${result.description ?? ""}`.slice(0, 160));
    }
  }
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
  };

  await runTick(); // warm immediately
  setInterval(() => void runTick(), TICK_MS);
  setInterval(() => void dispatchPending().catch((e) => console.error(`dispatch error: ${(e as Error).message.slice(0, 120)}`)), DISPATCH_MS);

  console.log("watch worker running");
}

void main().catch((err) => {
  console.error(`worker fatal: ${(err as Error).message}`);
  process.exit(1);
});
