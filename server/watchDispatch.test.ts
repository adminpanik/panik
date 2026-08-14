import { describe, expect, it } from "vitest";
import { ALERT_POLICY } from "../packages/scoring/src/params";
import {
  dispatchPending,
  OPEN_IN_PANIK_TEXT,
  PANIK_APP_URL_DEFAULT,
  viewButton,
  type DispatchDeps,
  type PendingDelivery,
} from "./watchDispatch";
import type { SendOptions, TelegramSendResult } from "./telegram";

const WHALE = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const ANNA = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const BEN = "0xcccc3333cccc3333cccc3333cccc3333cccc3333";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

interface Call {
  sql: string;
  values: unknown[];
}

/** One pending delivery, with material debt so the anti-spam gate lets it past. */
function delivery(over: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: "1",
    wallet: WHALE,
    protocol: "aave_v3",
    risk_profile: "moderate",
    score: 62,
    band: "HIGH",
    from_status: "within",
    to_status: "outside",
    created_at: new Date(NOW).toISOString(),
    owner_wallet: ANNA,
    label: null,
    chat_id: "101",
    health_factor: "1.14",
    collateral_usd: "250000",
    borrow_usd: "180000",
    usd_values_unavailable: false,
    simulation_id: null,
    simulation_label: null,
    notify_attempts: 0,
    ...over,
  };
}

interface FakeOptions {
  pending: PendingDelivery[];
  /** Prior SENT messages per chat id, newest first. */
  priorByChat?: Record<string, Array<{ to_status: string; created_at: string }>>;
  send?: (chatId: number, text: string) => Promise<TelegramSendResult>;
}

function harness(opts: FakeOptions) {
  const calls: Call[] = [];
  const sent: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  const delivered: number[] = [];
  const blocked: number[] = [];

  const deps: DispatchDeps = {
    db: {
      query: (async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        // The prior-alert lookup is matched FIRST: it joins watch_transitions
        // too, so a looser drain matcher would answer it with the pending rows
        // and every alert would look like its own cooldown.
        if (sql.startsWith("select to_status, created_at from (")) {
          return { rows: opts.priorByChat?.[String(values[0])] ?? [] };
        }
        if (sql.includes("from public.watch_transitions t")) return { rows: opts.pending };
        return { rows: [], rowCount: 1 };
      }) as DispatchDeps["db"]["query"],
    },
    send: async (chatId, text, sendOpts) => {
      sent.push({ chatId, text, opts: sendOpts });
      return (await opts.send?.(chatId, text)) ?? { ok: true, status: 200 };
    },
    // No fresh score in these tests: the why-now line is omitted rather than
    // reconstructed, which is the documented cold-cache behaviour.
    whyNow: () => undefined,
    onDelivered: async (chatId) => {
      delivered.push(chatId);
    },
    onBlocked: async (chatId) => {
      blocked.push(chatId);
    },
    maxAttempts: 8,
  };

  const stamps = () =>
    calls
      .filter((c) => c.sql.includes("notified_at, notify_attempts"))
      .map((c) => ({
        transitionId: c.values[0],
        owner: c.values[1],
        chatId: c.values[2],
        channel: c.values[3],
        attempts: c.values[4],
      }));
  const attempts = () =>
    calls
      .filter((c) => c.sql.includes("(transition_id, owner_wallet, chat_id, notify_attempts)"))
      .map((c) => ({ transitionId: c.values[0], owner: c.values[1], attempts: c.values[3] }));

  return { deps, calls, sent, delivered, blocked, stamps, attempts };
}

describe("dispatchPending — fan-out", () => {
  it("sends ONE transition to every subscriber's chat and ledgers each separately", async () => {
    // Anna and Ben both watch the whale at moderate. The worker scored it once
    // and wrote one transition; the drain owes two messages.
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
    });

    const report = await dispatchPending(h.deps);

    expect(report).toEqual({ considered: 2, sent: 2, suppressed: 0, failed: 0 });
    expect(h.sent.map((s) => s.chatId)).toEqual([101, 202]);
    expect(h.delivered).toEqual([101, 202]);
    // One ledger row per RECIPIENT, both against the same transition id.
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "telegram", attempts: 1 },
      { transitionId: "1", owner: BEN, chatId: 202, channel: "telegram", attempts: 1 },
    ]);
  });

  it("both messages describe the same crossing", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
    });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).toBe(h.sent[1]!.text);
  });

  it("one recipient failing does not stop or retire the others", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
      send: async (chatId) =>
        chatId === 101
          ? { ok: false, status: 400, description: "chat not found" }
          : { ok: true, status: 200 },
    });

    const report = await dispatchPending(h.deps);

    expect(report).toEqual({ considered: 2, sent: 1, suppressed: 0, failed: 1 });
    // Ben still got his message and his row is resolved...
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: BEN, chatId: 202, channel: "telegram", attempts: 1 },
    ]);
    // ...while Anna's row only spent an attempt, so the next pass retries HER.
    expect(h.attempts()).toEqual([{ transitionId: "1", owner: ANNA, attempts: 1 }]);
  });

  it("a 403 disables one chat and retires only that delivery", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
      send: async (chatId) =>
        chatId === 101
          ? { ok: false, status: 403, errorCode: 403, description: "bot was blocked" }
          : { ok: true, status: 200 },
    });

    await dispatchPending(h.deps);

    expect(h.blocked).toEqual([101]);
    expect(h.delivered).toEqual([202]);
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "blocked", attempts: 1 },
      { transitionId: "1", owner: BEN, chatId: 202, channel: "telegram", attempts: 1 },
    ]);
  });
});

describe("dispatchPending — the cooldown is per chat", () => {
  const recentAlert = [
    { to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() },
  ];

  it("suppresses the watcher who was just told and sends to the one who was not", async () => {
    // Same whale, same crossing. Anna was messaged a minute ago; Ben has never
    // been messaged about this position. Two people watching one wallet are not
    // each other's spam.
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
      priorByChat: { "101": recentAlert },
    });

    const report = await dispatchPending(h.deps);

    expect(report).toEqual({ considered: 2, sent: 1, suppressed: 1, failed: 0 });
    expect(h.sent.map((s) => s.chatId)).toEqual([202]);
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "suppressed_cooldown", attempts: 0 },
      { transitionId: "1", owner: BEN, chatId: 202, channel: "telegram", attempts: 1 },
    ]);
  });

  it("looks the cooldown up by CHAT, wallet and protocol", async () => {
    const h = harness({
      pending: [delivery({ owner_wallet: ANNA, chat_id: "101" })],
    });
    await dispatchPending(h.deps);
    const prior = h.calls.find((c) => c.sql.includes("select to_status, created_at from ("))!;
    expect(prior.values).toEqual([101, WHALE, "aave_v3"]);
  });

  it("sends again once the window has passed", async () => {
    const h = harness({
      pending: [delivery({ owner_wallet: ANNA, chat_id: "101" })],
      priorByChat: {
        "101": [
          {
            to_status: "outside",
            created_at: new Date(NOW - ALERT_POLICY.cooldownMs - 1).toISOString(),
          },
        ],
      },
    });
    const report = await dispatchPending(h.deps);
    expect(report.sent).toBe(1);
  });

  it("escalation bypasses one chat's cooldown without touching another's", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101", from_status: "approaching" }),
        delivery({ owner_wallet: BEN, chat_id: "202", from_status: "approaching" }),
      ],
      priorByChat: {
        "101": [{ to_status: "approaching", created_at: new Date(NOW - 60_000).toISOString() }],
        "202": [{ to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() }],
      },
    });

    const report = await dispatchPending(h.deps);

    // Anna's last message said "approaching" and this one says "outside": worse
    // news, so it bypasses. Ben was already told "outside" a minute ago.
    expect(h.sent.map((s) => s.chatId)).toEqual([101]);
    expect(report).toEqual({ considered: 2, sent: 1, suppressed: 1, failed: 0 });
  });
});

describe("dispatchPending — the attempt cap is per delivery", () => {
  it("retires ONE recipient at maxAttempts and leaves the co-watcher retrying", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101", notify_attempts: 7 }),
        delivery({ owner_wallet: BEN, chat_id: "202", notify_attempts: 1 }),
      ],
      send: async () => ({ ok: false, status: 400, description: "chat not found" }),
    });

    await dispatchPending(h.deps);

    // Anna's 8th attempt is her last: stamped undeliverable, never "delivered".
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "undeliverable", attempts: 8 },
    ]);
    // Ben's row just counts up and stays in the queue.
    expect(h.attempts()).toEqual([{ transitionId: "1", owner: BEN, attempts: 2 }]);
  });

  it("passes the cap and the batch size into the drain", async () => {
    const h = harness({ pending: [] });
    await dispatchPending({ ...h.deps, batchSize: 25 });
    expect(h.calls[0]!.values).toEqual([8, 25]);
  });
});

describe("dispatchPending — recoveries", () => {
  const recovery = (over: Partial<PendingDelivery> = {}) =>
    delivery({ to_status: "within", from_status: "outside", score: 20, band: "LOW", ...over });

  it("sends the all-clear only to the chat that got the alert", async () => {
    const h = harness({
      pending: [
        recovery({ owner_wallet: ANNA, chat_id: "101" }),
        recovery({ owner_wallet: BEN, chat_id: "202" }),
      ],
      // Anna was alerted; Ben never was, so he has nothing to be told is over.
      priorByChat: {
        "101": [{ to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() }],
      },
    });

    const report = await dispatchPending(h.deps);

    expect(h.sent.map((s) => s.chatId)).toEqual([101]);
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "telegram", attempts: 1 },
      { transitionId: "1", owner: BEN, chatId: 202, channel: "skipped", attempts: 0 },
    ]);
    expect(report.suppressed).toBe(1);
  });

  it("a recovery reads as resolved, not as a fresh alert", async () => {
    const h = harness({
      pending: [recovery({ owner_wallet: ANNA, chat_id: "101" })],
      priorByChat: {
        "101": [{ to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() }],
      },
    });
    await dispatchPending(h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).not.toBe("");
  });
});

describe("dispatchPending — whose wallet this is", () => {
  it("selects the subscription label and puts it in the message", async () => {
    const h = harness({
      pending: [delivery({ owner_wallet: ANNA, chat_id: "101", label: "Simulation target" })],
    });
    await dispatchPending(h.deps);

    // The drain has to ASK for it, or the formatter has nothing to render.
    expect(h.calls[0]!.sql).toContain("s.label");
    expect(h.sent[0]!.text.split("\n")[0]).toBe(
      "Simulation target (0xaaaa...1111) on Aave V3 is over your moderate limit.",
    );
  });

  it("falls back to the address when the subscriber never named the wallet", async () => {
    const h = harness({ pending: [delivery({ label: null })] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text.split("\n")[0]).toBe(
      "0xaaaa...1111 on Aave V3 is over your moderate limit.",
    );
  });

  it("never sends a message that is only advice", async () => {
    // A trailer paragraph with nothing in front of it was actually delivered
    // once. These are the two shapes that reach the formatter with the fewest
    // facts: an ALERT is gated on a health factor (alertPolicy: no debt, no
    // alert), so its floor is HF alone with the snapshot join otherwise empty;
    // a RECOVERY is not gated at all, so it can arrive with nothing.
    const h = harness({
      pending: [
        delivery({
          owner_wallet: ANNA,
          chat_id: "101",
          label: null,
          collateral_usd: null,
          borrow_usd: null,
          usd_values_unavailable: true,
        }),
        delivery({
          id: "2",
          owner_wallet: BEN,
          chat_id: "202",
          to_status: "within",
          from_status: "outside",
          score: 20,
          band: "LOW",
          label: null,
          health_factor: null,
          collateral_usd: null,
          borrow_usd: null,
        }),
      ],
      // Only the recovery needs a prior alert to be worth sending.
      priorByChat: {
        "202": [{ to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() }],
      },
    });
    await dispatchPending(h.deps);

    expect(h.sent).toHaveLength(2);
    for (const { text } of h.sent) {
      expect(text).toContain("0xaaaa...1111");
      expect(text).toContain("Aave V3");
      expect(text).toMatch(/Risk score \d+ of 100/);
      expect(text).not.toContain("$0");
    }
  });

  it("gives two watchers of one whale their own names for it", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101", label: "The whale" }),
        delivery({ owner_wallet: BEN, chat_id: "202", label: "Client A" }),
      ],
    });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).toContain("The whale (0xaaaa...1111)");
    expect(h.sent[1]!.text).toContain("Client A (0xaaaa...1111)");
  });
});

/**
 * The marker survived the fan-out. Worth its own test because the stamp now
 * travels through four hops (tick score -> transition row -> drain -> extras)
 * and a delivered alert was observed with `simulation_label` null while a
 * scenario was armed - which this proves was not a drop on THIS path.
 */
describe("dispatchPending — the simulation marker", () => {
  it("marks an alert whose transition row carries a simulation", async () => {
    const h = harness({
      pending: [delivery({ simulation_id: "sim-1", simulation_label: "Crash" })],
    });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text.split("\n")[0]).toContain("Simulated event (Crash)");
  });

  it("still marks when only the id was persisted", async () => {
    // The label is denormalised onto the row and could be null on an older row.
    // The id alone is enough to know the alert must not read as real.
    const h = harness({ pending: [delivery({ simulation_id: "sim-1", simulation_label: null })] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).toContain("Simulated event");
  });

  it("leaves a real alert unmarked", async () => {
    const h = harness({ pending: [delivery()] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).not.toContain("imulated");
  });
});

describe("the Open in PANIK button", () => {
  it("points at the WATCHED wallet, not the subscriber's own", async () => {
    const h = harness({ pending: [delivery({ owner_wallet: ANNA, chat_id: "101" })] });
    await dispatchPending({ ...h.deps, appUrl: "https://www.panik.fi/app" });

    expect(h.sent[0]!.opts?.button).toEqual({
      text: OPEN_IN_PANIK_TEXT,
      url: `https://www.panik.fi/app?view=${WHALE}`,
    });
    expect(h.sent[0]!.opts?.button?.url).not.toContain(ANNA);
  });

  it("rides on the all-clear too", async () => {
    const h = harness({
      pending: [delivery({ to_status: "within", from_status: "outside", score: 20, band: "LOW" })],
      priorByChat: {
        "101": [{ to_status: "outside", created_at: new Date(NOW - 60_000).toISOString() }],
      },
    });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.opts?.button?.text).toBe(OPEN_IN_PANIK_TEXT);
  });

  it("defaults to the public app when the environment names none", () => {
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE)).toEqual({
      text: OPEN_IN_PANIK_TEXT,
      url: `https://www.panik.fi/app?view=${WHALE}`,
    });
  });

  it("keeps a query string the configured URL already had", () => {
    expect(viewButton("https://preview.panik.fi/app?chain=base", WHALE)?.url).toBe(
      `https://preview.panik.fi/app?chain=base&view=${WHALE}`,
    );
  });

  it("lowercases the wallet so the link matches the watchlist", () => {
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE.toUpperCase().replace("0X", "0x"))?.url).toBe(
      `https://www.panik.fi/app?view=${WHALE}`,
    );
  });

  it("is dropped, not guessed, when the configured URL is unusable", async () => {
    // Telegram 400s the WHOLE send on a malformed button URL, so a fat-fingered
    // PANIK_APP_URL must cost the button and never the alert.
    expect(viewButton("panik.fi/app", WHALE)).toBeNull();
    expect(viewButton("javascript:alert(1)", WHALE)).toBeNull();

    const h = harness({ pending: [delivery()] });
    const report = await dispatchPending({ ...h.deps, appUrl: "not a url" });
    expect(report.sent).toBe(1);
    expect(h.sent[0]!.opts).toBeUndefined();
  });
});

describe("dispatchPending — materiality still applies per delivery", () => {
  it("suppresses a position with no debt for every recipient", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101", health_factor: null, borrow_usd: null }),
        delivery({ owner_wallet: BEN, chat_id: "202", health_factor: null, borrow_usd: null }),
      ],
    });
    const report = await dispatchPending(h.deps);
    expect(report).toEqual({ considered: 2, sent: 0, suppressed: 2, failed: 0 });
    expect(h.stamps().map((s) => s.channel)).toEqual([
      "suppressed_immaterial",
      "suppressed_immaterial",
    ]);
  });

  it("does not class a degraded six-figure debt as dust", async () => {
    const h = harness({
      pending: [
        delivery({
          owner_wallet: ANNA,
          chat_id: "101",
          borrow_usd: null,
          collateral_usd: null,
          usd_values_unavailable: true,
        }),
      ],
    });
    expect((await dispatchPending(h.deps)).sent).toBe(1);
  });
});
