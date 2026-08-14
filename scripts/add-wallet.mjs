/**
 * Add wallet(s) to the watch registry.
 * Usage: node --env-file=.env scripts/add-wallet.mjs 0xabc... [label]
 * (no args = add the predefined multi-protocol test wallets)
 *
 * Writes a SELF-SUBSCRIPTION, not a registry row. Since the watchlist migration
 * `watched_wallets` is derived — a wallet is is_active iff some subscription
 * references it — so an insert straight into the registry is a row the next
 * sync of that wallet silently deactivates. Test wallets have no owner, so they
 * own themselves, exactly like the seed cohort the migration backfilled.
 */
import pg from "pg";

const DEFAULTS = [
  ["0x77819d746a876b523b0b41d942c1477f248f9137", "multi-protocol tester (Aave+Moonwell)"],
  ["0x93b0c5daa1518bb65c42eb25ce198b5231759647", "multi-protocol tester #2 (Aave+Moonwell)"],
];

const [, , argWallet, argLabel] = process.argv;
const wallets = argWallet ? [[argWallet.toLowerCase(), argLabel ?? null]] : DEFAULTS;

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

for (const [wallet, label] of wallets) {
  const r = await c.query(
    `insert into public.watch_subscriptions (owner_wallet, watched_wallet, risk_profile, label)
     values ($1, $1, 'moderate', $2)
     on conflict (owner_wallet, watched_wallet) do nothing
     returning watched_wallet`,
    [wallet, label],
  );
  await c.query("select public.watchlist_sync_registry($1)", [wallet]);
  console.log(r.rowCount ? `added:   ${wallet}` : `exists:  ${wallet}`);
}

const all = await c.query(
  "select wallet, label from public.watched_wallets where is_active order by created_at",
);
console.log("\nwatch registry:");
for (const w of all.rows) console.log(`  ${w.wallet.slice(0, 10)}…  ${w.label ?? ""}`);
await c.end();
