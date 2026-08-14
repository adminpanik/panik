import { describe, expect, it } from "vitest";
import {
  applyWatchlistOps,
  listSubscriptions,
  parseWatchlistOps,
  registerSelfSubscription,
  subscriberProfiles,
  WatchlistError,
  WATCHLIST_LABEL_MAX,
  WATCHLIST_MAX,
  WATCHLIST_MAX_OPS,
  type WatchlistClient,
  type WatchlistPool,
  type WatchOp,
} from "./watchlist";

const A = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const B = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const C = "0xcccc3333cccc3333cccc3333cccc3333cccc3333";

/**
 * The EIP-55 rendering a wallet actually sends: mixed-case hex, lowercase `0x`.
 * (`"0xAB…".toUpperCase()` would also upper the prefix, which is not an address
 * any wallet produces and which `isEvmAddress` rightly rejects.)
 */
const checksummed = (wallet: string): string => `0x${wallet.slice(2).toUpperCase()}`;

interface Call {
  sql: string;
  values: unknown[];
}

interface FakeState {
  /** What the post-batch cap count returns. */
  count: number;
  /** rowCount the UPDATE statement reports (0 = no such subscription). */
  updateRowCount: number;
  /** Rows the final list read returns. */
  list: Array<{
    watched_wallet: string;
    risk_profile: string;
    label: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

/**
 * A recording stand-in for `pg`. It answers the three statements that carry a
 * value (the cap count, the update's rowCount, the list read) and records every
 * statement in order, which is what lets the ordering assertions below — lock
 * before mutate, cap before sync, rollback on failure — be real assertions
 * rather than a re-description of the source.
 */
function fakePool(state: Partial<FakeState> = {}): {
  pool: WatchlistPool;
  calls: Call[];
  released: () => number;
} {
  const s: FakeState = {
    count: state.count ?? 1,
    updateRowCount: state.updateRowCount ?? 1,
    list: state.list ?? [],
  };
  const calls: Call[] = [];
  let releases = 0;

  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("count(*)::int")) return { rows: [{ count: s.count }] as never[] };
    if (sql.startsWith("select watched_wallet")) return { rows: s.list as never[] };
    if (sql.startsWith("update public.watch_subscriptions")) {
      return { rows: [] as never[], rowCount: s.updateRowCount };
    }
    return { rows: [] as never[], rowCount: 1 };
  };

  const client: WatchlistClient = {
    query: query as WatchlistClient["query"],
    release: () => {
      releases += 1;
    },
  };
  const pool: WatchlistPool = {
    query: query as WatchlistPool["query"],
    connect: async () => client,
  };
  return { pool, calls, released: () => releases };
}

const sqlOf = (calls: Call[]): string[] => calls.map((c) => c.sql.trim().split("\n")[0]!.trim());
const indexOf = (calls: Call[], needle: string): number =>
  calls.findIndex((c) => c.sql.includes(needle));

describe("parseWatchlistOps", () => {
  it("rejects a body with no ops array", () => {
    expect(parseWatchlistOps({})).toEqual({ error: expect.stringContaining("array") });
    expect(parseWatchlistOps({ ops: "add" })).toEqual({ error: expect.stringContaining("array") });
    expect(parseWatchlistOps(null)).toEqual({ error: expect.stringContaining("array") });
  });

  it("rejects an empty batch and an oversized one", () => {
    expect(parseWatchlistOps({ ops: [] })).toEqual({ error: expect.stringContaining("empty") });
    const many = Array.from({ length: WATCHLIST_MAX_OPS + 1 }, (_, i) => ({
      op: "remove",
      wallet: `0x${String(i).padStart(40, "0")}`,
    }));
    expect(parseWatchlistOps({ ops: many })).toEqual({
      error: expect.stringContaining(String(WATCHLIST_MAX_OPS)),
    });
  });

  it("rejects an unknown op and a malformed wallet", () => {
    expect(parseWatchlistOps({ ops: [{ op: "delete", wallet: A }] })).toEqual({
      error: expect.stringContaining("ops[0].op"),
    });
    expect(parseWatchlistOps({ ops: [{ op: "remove", wallet: "0xnope" }] })).toEqual({
      error: expect.stringContaining("EVM address"),
    });
  });

  it("rejects the same wallet twice in one batch (the order would be luck)", () => {
    const out = parseWatchlistOps({
      ops: [
        { op: "add", wallet: A, profile: "moderate" },
        { op: "remove", wallet: checksummed(A) },
      ],
    });
    expect(out).toEqual({ error: expect.stringContaining("more than once") });
  });

  it("REJECTS an unknown profile instead of defaulting it", () => {
    // The default would silently move someone from conservative (alert at 25)
    // to moderate (50) and mute warnings they asked for.
    const out = parseWatchlistOps({ ops: [{ op: "add", wallet: A, profile: "yolo" }] });
    expect(out).toEqual({ error: expect.stringContaining("profile") });
  });

  it("requires a profile when adding, but not when updating a label", () => {
    expect(parseWatchlistOps({ ops: [{ op: "add", wallet: A }] })).toEqual({
      error: expect.stringContaining("required"),
    });
    expect(parseWatchlistOps({ ops: [{ op: "update", wallet: A, label: "vault" }] })).toEqual({
      ops: [{ op: "update", wallet: A, label: "vault" }],
    });
  });

  it("rejects an update that changes nothing", () => {
    expect(parseWatchlistOps({ ops: [{ op: "update", wallet: A }] })).toEqual({
      error: expect.stringContaining("changes nothing"),
    });
  });

  it("normalises the wallet, trims the label, and treats blank as cleared", () => {
    const out = parseWatchlistOps({
      ops: [{ op: "add", wallet: checksummed(A), profile: "conservative", label: "  desk  " }],
    });
    expect(out).toEqual({
      ops: [{ op: "add", wallet: A, profile: "conservative", label: "desk" }],
    });

    const cleared = parseWatchlistOps({
      ops: [{ op: "update", wallet: A, label: "   " }],
    });
    expect(cleared).toEqual({ ops: [{ op: "update", wallet: A, label: null }] });
  });

  it("distinguishes an absent label from an explicit null", () => {
    const absent = parseWatchlistOps({ ops: [{ op: "add", wallet: A, profile: "moderate" }] });
    expect("ops" in absent && Object.prototype.hasOwnProperty.call(absent.ops[0]!, "label")).toBe(
      false,
    );
    const explicit = parseWatchlistOps({
      ops: [{ op: "add", wallet: A, profile: "moderate", label: null }],
    });
    expect("ops" in explicit && explicit.ops[0]).toEqual({
      op: "add",
      wallet: A,
      profile: "moderate",
      label: null,
    });
  });

  it("rejects a label longer than the cap and a non-string label", () => {
    const long = "x".repeat(WATCHLIST_LABEL_MAX + 1);
    expect(parseWatchlistOps({ ops: [{ op: "add", wallet: A, profile: "moderate", label: long }] })).toEqual({
      error: expect.stringContaining(String(WATCHLIST_LABEL_MAX)),
    });
    expect(parseWatchlistOps({ ops: [{ op: "add", wallet: A, profile: "moderate", label: 7 }] })).toEqual({
      error: expect.stringContaining("string"),
    });
  });
});

describe("applyWatchlistOps — the cap", () => {
  const add = (wallet: string): WatchOp => ({ op: "add", wallet, profile: "moderate" });

  it("refuses the batch when it would leave more than WATCHLIST_MAX", async () => {
    const { pool, calls, released } = fakePool({ count: WATCHLIST_MAX + 1 });
    await expect(applyWatchlistOps(pool, A, [add(B)])).rejects.toBeInstanceOf(WatchlistError);
    await expect(applyWatchlistOps(pool, A, [add(B)])).rejects.toMatchObject({ status: 409 });

    // Rolled back, never committed, and the registry was never touched.
    expect(sqlOf(calls)).toContain("rollback");
    expect(sqlOf(calls)).not.toContain("commit");
    expect(indexOf(calls, "watchlist_sync_registry")).toBe(-1);
    expect(released()).toBe(2); // one per call, both connections handed back
  });

  it("allows a batch that lands exactly on the cap", async () => {
    const { pool, calls } = fakePool({ count: WATCHLIST_MAX });
    await expect(applyWatchlistOps(pool, A, [add(B)])).resolves.toEqual([]);
    expect(sqlOf(calls)).toContain("commit");
  });

  it("counts AFTER the batch, so remove-one-add-two cannot slip past it", async () => {
    // The pre-batch count is irrelevant: the fake reports the post-batch total.
    const { pool } = fakePool({ count: WATCHLIST_MAX + 1 });
    await expect(
      applyWatchlistOps(pool, A, [{ op: "remove", wallet: B }, add(C)]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("takes the per-owner advisory lock BEFORE the first mutation", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await applyWatchlistOps(pool, A, [add(B)]);
    const lock = indexOf(calls, "pg_advisory_xact_lock");
    const insert = indexOf(calls, "insert into public.watch_subscriptions");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(insert);
    expect(calls[lock]!.values).toEqual([`panik:watchlist:${A}`]);
    // And the count is read after the writes, before the sync.
    expect(indexOf(calls, "count(*)::int")).toBeGreaterThan(insert);
    expect(indexOf(calls, "count(*)::int")).toBeLessThan(indexOf(calls, "watchlist_sync_registry"));
  });
});

describe("applyWatchlistOps — registry sync", () => {
  it("re-derives the registry for every wallet the batch touched", async () => {
    const { pool, calls } = fakePool({ count: 2 });
    await applyWatchlistOps(pool, A, [
      { op: "add", wallet: B, profile: "conservative", label: "friend" },
      { op: "remove", wallet: C },
    ]);
    const synced = calls
      .filter((c) => c.sql.includes("watchlist_sync_registry"))
      .map((c) => c.values[0]);
    // Both directions go through the same call: the added wallet must come back
    // is_active, the wallet whose last subscription just left must not.
    expect(synced).toEqual([B, C]);
    expect(sqlOf(calls)).toContain("commit");
  });

  it("syncs the removed wallet inside the SAME transaction as the delete", async () => {
    const { pool, calls } = fakePool({ count: 0 });
    await applyWatchlistOps(pool, A, [{ op: "remove", wallet: B }]);
    const begin = indexOf(calls, "begin");
    const del = indexOf(calls, "delete from public.watch_subscriptions");
    const sync = indexOf(calls, "watchlist_sync_registry");
    const commit = indexOf(calls, "commit");
    expect(begin).toBeLessThan(del);
    expect(del).toBeLessThan(sync);
    expect(sync).toBeLessThan(commit);
  });

  it("re-adding the wallet issues the same sync call, which flips it back", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await applyWatchlistOps(pool, A, [{ op: "add", wallet: B, profile: "moderate" }]);
    expect(
      calls.filter((c) => c.sql.includes("watchlist_sync_registry")).map((c) => c.values[0]),
    ).toEqual([B]);
  });
});

describe("applyWatchlistOps — ops", () => {
  it("passes labelGiven=false when no label was supplied, so an edit cannot blank one", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await applyWatchlistOps(pool, A, [{ op: "add", wallet: B, profile: "aggressive" }]);
    const insert = calls[indexOf(calls, "insert into public.watch_subscriptions")]!;
    expect(insert.values).toEqual([A, B, "aggressive", null, false]);
  });

  it("passes labelGiven=true for an explicit null, so a clear really clears", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await applyWatchlistOps(pool, A, [{ op: "update", wallet: B, label: null }]);
    const update = calls[indexOf(calls, "update public.watch_subscriptions")]!;
    expect(update.values).toEqual([A, B, null, null, true]);
  });

  it("404s an update against a wallet the owner is not watching", async () => {
    const { pool, calls } = fakePool({ count: 1, updateRowCount: 0 });
    await expect(
      applyWatchlistOps(pool, A, [{ op: "update", wallet: B, profile: "moderate" }]),
    ).rejects.toMatchObject({ status: 404 });
    expect(sqlOf(calls)).toContain("rollback");
    expect(sqlOf(calls)).not.toContain("commit");
  });

  it("scopes every statement to the PROVEN owner, never to a body field", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await applyWatchlistOps(pool, checksummed(A), [{ op: "remove", wallet: B }]);
    const del = calls[indexOf(calls, "delete from public.watch_subscriptions")]!;
    expect(del.values).toEqual([A, B]); // lowercased owner, and it is $1
  });

  it("returns the decoded post-batch list", async () => {
    const { pool } = fakePool({
      count: 1,
      list: [
        {
          watched_wallet: B,
          risk_profile: "conservative",
          label: "friend",
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z",
        },
      ],
    });
    await expect(applyWatchlistOps(pool, A, [{ op: "add", wallet: B, profile: "conservative" }]))
      .resolves.toEqual([
        {
          wallet: B,
          profile: "conservative",
          label: "friend",
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        },
      ]);
  });
});

describe("registerSelfSubscription", () => {
  it("creates a self-subscription (owner === watched) and names no label", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await registerSelfSubscription(pool, checksummed(A), "conservative");
    const insert = calls[indexOf(calls, "insert into public.watch_subscriptions")]!;
    // owner, watched, profile, label, labelGiven — the last two are what keep a
    // re-onboard from stamping over the name the user chose.
    expect(insert.values).toEqual([A, A, "conservative", null, false]);
  });

  it("re-derives only the caller's own wallet — it cannot resurrect another", async () => {
    const { pool, calls } = fakePool({ count: 1 });
    await registerSelfSubscription(pool, A, "moderate");
    expect(
      calls.filter((c) => c.sql.includes("watchlist_sync_registry")).map((c) => c.values[0]),
    ).toEqual([A]);
    // No other wallet is written at all: registration creates one subscription
    // and lets the registry follow from what exists afterwards.
    expect(calls.filter((c) => c.sql.includes("delete from"))).toHaveLength(0);
  });

  it("is subject to the same cap as the batch endpoint", async () => {
    const { pool } = fakePool({ count: WATCHLIST_MAX + 1 });
    await expect(registerSelfSubscription(pool, A, "moderate")).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("listSubscriptions", () => {
  it("reads one owner's rows, lowercased", async () => {
    const { pool, calls } = fakePool({
      list: [
        {
          watched_wallet: B,
          risk_profile: "moderate",
          label: null,
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z",
        },
      ],
    });
    const out = await listSubscriptions(pool, checksummed(A));
    expect(calls[0]!.values).toEqual([A]);
    expect(out).toEqual([
      {
        wallet: B,
        profile: "moderate",
        label: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
  });
});

describe("subscriberProfiles", () => {
  it("de-duplicates so one wallet is evaluated once per DISTINCT profile", () => {
    expect(subscriberProfiles(["moderate", "moderate", "conservative"], "moderate")).toEqual([
      "moderate",
      "conservative",
    ]);
  });

  it("drops anything that is not a profile", () => {
    expect(subscriberProfiles(["moderate", "yolo", null, 7], "aggressive")).toEqual(["moderate"]);
  });

  it("falls back to the registry's own column rather than to a guess", () => {
    // Not "moderate": a wallet with no subscription rows is unknown, and the
    // registry column is the only thing that knows anything about it.
    expect(subscriberProfiles([], "conservative")).toEqual(["conservative"]);
    expect(subscriberProfiles(null, "aggressive")).toEqual(["aggressive"]);
  });
});
