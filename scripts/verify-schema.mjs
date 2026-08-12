/**
 * PANIK — Supabase schema verification.
 * Run:  npm run db:verify
 * Connects exactly like the Watch worker will (SUPABASE_DB_URL, session
 * pooler) and checks tables, RLS, indexes, the retention cron, and seeds.
 *
 * IT USED TO CHECK ONLY THE FIRST MIGRATION. The five tables below were the
 * whole of the schema in June; sixteen migrations later it still checked those
 * five, so "PASS — schema is live and worker-ready" was true of a database
 * missing three migrations. That is how it went unnoticed that production had
 * never run 20260719000001, 20260810000001 and 20260810000002: the worker's
 * telegram monitor threw `column "last_delivered_at" does not exist` every five
 * minutes into logs nobody was reading, and /api/health/worker answered 502
 * because `worker_heartbeats` was not there either — which is the one endpoint
 * that would have said the worker was unobservable.
 *
 * So MIGRATION_OBJECTS below is the coverage, and it is the thing to extend
 * when a migration lands. One entry per migration that creates a table or adds
 * a column; the check names the migration file in the failure, because the fix
 * for a missing object is always "apply that file", never a code change.
 */

import pg from "pg";

/**
 * Every migration that creates a table or adds a column, and the objects it is
 * responsible for. Columns are the SUBSET worth proving - the ones code reads
 * by name - not the full DDL, which the migration file already is.
 *
 * Deliberately hand-maintained rather than parsed out of the .sql files. A
 * parser would agree with the migrations by construction and so could never
 * disagree with them, which is the entire value here: this list says what the
 * RUNNING CODE needs, and drifts from the files only when someone forgets.
 */
const MIGRATION_OBJECTS = [
  { file: "20260613000001_scoring_engine", tables: [
    "public.watched_wallets", "public.score_snapshots",
    "public.watch_transitions", "public.price_baselines", "onchain.lending_events",
  ], columns: { "public.watch_transitions": ["from_status", "to_status", "notify_channel", "notified_at"] } },
  { file: "20260614000001_waitlist", tables: ["public.waitlist_signups"] },
  { file: "20260623000001_wallet_profiles", tables: ["public.wallet_profiles"] },
  { file: "20260627000001_telegram_alerts", tables: ["public.telegram_links", "public.telegram_link_codes"] },
  { file: "20260704000001_product_codes", tables: [
    "public.product_campaigns", "public.trial_grants", "public.redemption_attempts",
  ] },
  { file: "20260707000001_trial_email", columns: { "public.trial_grants": ["email"] } },
  { file: "20260719000001_advisor_events", tables: ["public.advisor_events"] },
  { file: "20260806000001_auth_nonces", tables: ["public.auth_nonces"] },
  { file: "20260806000001_snapshot_degraded_prices",
    columns: { "public.score_snapshots": ["usd_values_unavailable"] } },
  { file: "20260809000001_advisor_narrations", tables: ["public.advisor_narrations"] },
  { file: "20260809000002_exit_delegations", tables: ["public.exit_delegations"] },
  { file: "20260810000001_relayer_attempts", tables: ["public.relayer_attempts"] },
  { file: "20260810000002_coverage_monitoring",
    tables: ["public.monitor_alerts", "public.worker_heartbeats"],
    columns: {
      // The reachability evidence the worker's telegram monitor reads.
      "public.telegram_links": [
        "last_delivered_at", "last_probe_at", "last_probe_ok", "unreachable_since",
      ],
      "public.exit_delegations": ["signer_had_code", "signer_code_hash"],
    } },
  { file: "20260810000003_market_simulations", tables: ["public.market_simulations"],
    columns: {
      "public.watch_transitions": ["simulation_id", "simulation_label"],
      "public.score_snapshots": ["simulation_id", "simulation_hf_multiplier"],
    } },
];

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL missing — run via: npm run db:verify");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS; pooler cert chain
});

const results = [];
const expect = (name, ok, detail) => results.push({ name, ok, detail });

try {
  await client.connect();

  // 1. Tables exist
  const { rows: tables } = await client.query(`
    select table_schema || '.' || table_name as t
    from information_schema.tables
    where (table_schema = 'public' and table_name in
            ('watched_wallets','score_snapshots','watch_transitions','price_baselines'))
       or (table_schema = 'onchain' and table_name = 'lending_events')
  `);
  const found = tables.map((r) => r.t).sort();
  expect("5 tables created", found.length === 5, found.join(", "));

  // 1b. EVERY migration's objects, one check per migration file.
  //
  // Two queries for the whole set rather than one per migration: the answer is
  // "which of these exist", and asking that once keeps a cold pooler
  // connection from turning a verification into a minute of round trips.
  const liveTables = new Set(
    (await client.query(
      `select table_schema || '.' || table_name as t from information_schema.tables
        where table_schema in ('public','onchain')`,
    )).rows.map((r) => r.t),
  );
  const liveColumns = new Set(
    (await client.query(
      `select table_schema || '.' || table_name || '.' || column_name as c
         from information_schema.columns where table_schema in ('public','onchain')`,
    )).rows.map((r) => r.c),
  );
  for (const m of MIGRATION_OBJECTS) {
    const missing = [];
    for (const t of m.tables ?? []) if (!liveTables.has(t)) missing.push(`table ${t}`);
    for (const [t, cols] of Object.entries(m.columns ?? {})) {
      for (const c of cols) if (!liveColumns.has(`${t}.${c}`)) missing.push(`${t}.${c}`);
    }
    expect(
      `migration ${m.file}`,
      missing.length === 0,
      missing.length === 0 ? "applied" : `NOT APPLIED — missing ${missing.join(", ")}`,
    );
  }

  // 2. RLS enabled on all five
  const { rows: rls } = await client.query(`
    select n.nspname || '.' || c.relname as t, c.relrowsecurity as on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where (n.nspname = 'public' and c.relname in
            ('watched_wallets','score_snapshots','watch_transitions','price_baselines'))
       or (n.nspname = 'onchain' and c.relname = 'lending_events')
  `);
  const rlsOff = rls.filter((r) => !r.on).map((r) => r.t);
  expect("RLS enabled (deny-all)", rlsOff.length === 0, rlsOff.length ? `OFF on: ${rlsOff}` : "all 5 locked");

  // 3. updated_at trigger
  const { rows: trig } = await client.query(`
    select tgname from pg_trigger
    where tgname = 'trg_watched_wallets_updated' and not tgisinternal
  `);
  expect("updated_at trigger", trig.length === 1, trig[0]?.tgname ?? "MISSING");

  // 4. Indexes (the partial unnotified-queue index is the one worth proving)
  const { rows: idx } = await client.query(`
    select indexname from pg_indexes
    where indexname in ('idx_snapshots_wallet_proto_time','idx_transitions_wallet_time',
                        'idx_transitions_unnotified','idx_lending_events_user_time',
                        'idx_lending_events_proto_event_time')
  `);
  expect("5 indexes", idx.length === 5, `${idx.length}/5 present`);

  // 5. Retention cron job
  const { rows: cron } = await client.query(`
    select jobname, schedule, active from cron.job where jobname = 'panik_retention'
  `);
  expect(
    "pg_cron retention job",
    cron.length === 1 && cron[0].active,
    cron[0] ? `'${cron[0].jobname}' @ '${cron[0].schedule}' active=${cron[0].active}` : "MISSING",
  );

  // 6. Seed rows
  const { rows: seeds } = await client.query(
    `select wallet, risk_profile, label from public.watched_wallets order by created_at`,
  );
  expect("validation cohort seeded", seeds.length >= 4, `${seeds.length} wallets`);
  for (const s of seeds) console.log(`   seed: ${s.wallet.slice(0, 10)}…  ${s.risk_profile}  ${s.label}`);

  // 7. Write-path sanity: worker can upsert a price baseline (then clean up)
  await client.query(`
    insert into public.price_baselines (symbol, price) values ('__VERIFY__', 1)
    on conflict (symbol) do update set price = 1, observed_at = now()
  `);
  await client.query(`delete from public.price_baselines where symbol = '__VERIFY__'`);
  expect("worker write path", true, "insert/upsert/delete OK over session pooler");
} catch (err) {
  expect("connection/query", false, err.message);
} finally {
  await client.end().catch(() => {});
}

console.log("\nSchema verification\n" + "─".repeat(96));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(96));
// A failing migration check is an OPS action, not a code change. Say so here:
// the last person to see this output went looking for the bug in the query.
console.log(
  failed === 0
    ? "Schema is live and worker-ready."
    : `${failed} check(s) FAILED. A "NOT APPLIED" line means that migration file has never ` +
      `been run against this database — apply it, do not edit the code that reads it.`,
);
process.exit(failed === 0 ? 0 : 1);
