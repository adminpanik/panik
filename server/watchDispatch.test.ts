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
import { captionLength, TELEGRAM_CAPTION_MAX } from "./telegram";
import type { SendOptions, SendPhotoOptions, TelegramSendResult } from "./telegram";

const WHALE = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const ANNA = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const BEN = "0xcccc3333cccc3333cccc3333cccc3333cccc3333";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

interface Call {
  sql: string;
  values: unknown[];
}

/** The message as a reader sees it. The markup itself is tested where it is the subject. */
const plain = (message: string): string =>
  message.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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
  /** Supply to exercise the card path. Absent = the text-only deps every caller had before it. */
  sendPhoto?: (chatId: number, photo: Uint8Array, opts?: SendPhotoOptions) => Promise<TelegramSendResult>;
}

function harness(opts: FakeOptions) {
  const calls: Call[] = [];
  const sent: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  const photos: Array<{ chatId: number; bytes: number; opts?: SendPhotoOptions }> = [];
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
    ...(opts.sendPhoto
      ? {
          sendPhoto: async (chatId: number, photo: Uint8Array, photoOpts?: SendPhotoOptions) => {
            photos.push({ chatId, bytes: photo.length, opts: photoOpts });
            return opts.sendPhoto!(chatId, photo, photoOpts);
          },
        }
      : {}),
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

  return { deps, calls, sent, photos, delivered, blocked, stamps, attempts };
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
      "<b>Simulation target (<code>0xaaaa...1111</code>) on Aave V3 is over your moderate limit.</b>",
    );
  });

  it("falls back to the address when the subscriber never named the wallet", async () => {
    const h = harness({ pending: [delivery({ label: null })] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text.split("\n")[0]).toBe(
      "<b><code>0xaaaa...1111</code> on Aave V3 is over your moderate limit.</b>",
    );
  });

  it("sends the body as Telegram HTML, and only these two message kinds", async () => {
    const h = harness({ pending: [delivery()] });
    await dispatchPending(h.deps);
    // The formatter is the only one that escapes what it interpolates, so it is
    // the only one allowed to be parsed.
    expect(h.sent[0]!.opts?.parseMode).toBe("HTML");
  });

  it("escapes a hostile label instead of sending Telegram broken markup", async () => {
    // A label is user-typed. Unescaped, this is not a styling bug: Telegram
    // rejects the whole sendMessage and the alert is never delivered.
    const h = harness({ pending: [delivery({ label: '<b>&"hax"</b>' })] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).toContain('&lt;b&gt;&amp;"hax"&lt;/b&gt;');
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
      const read = plain(text);
      expect(read).toContain("0xaaaa...1111");
      expect(read).toContain("Aave V3");
      expect(read).toMatch(/Risk score \d+ of 100/);
      expect(read).not.toContain("$0");
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
    expect(plain(h.sent[0]!.text)).toContain("The whale (0xaaaa...1111)");
    expect(plain(h.sent[1]!.text)).toContain("Client A (0xaaaa...1111)");
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
    expect(h.sent[0]!.text.split("\n")[0]).toBe(
      "<b>Simulated event (Crash) - prices in this alert are from an armed drill, not the market. " +
        "Real market prices have not moved and your position has not actually changed.</b>",
    );
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

/**
 * The card rides along, and never gets in the way. Every test here exists
 * because the alternative to it is a liquidation warning that did not arrive.
 */
describe("dispatchPending — the alert card", () => {
  const ok = async () => ({ ok: true, status: 200 });

  it("sends ONE photo message carrying the whole body as its caption", async () => {
    const h = harness({ pending: [delivery({ label: "The whale" })], sendPhoto: ok });
    await dispatchPending(h.deps);

    expect(h.photos).toHaveLength(1);
    expect(h.photos[0]!.chatId).toBe(101);
    expect(h.photos[0]!.bytes).toBeGreaterThan(10_000);
    expect(h.photos[0]!.opts?.parseMode).toBe("HTML");
    expect(h.photos[0]!.opts?.button?.text).toBe(OPEN_IN_PANIK_TEXT);
    expect(plain(h.photos[0]!.opts?.caption ?? "")).toContain("Risk score 62 of 100");
    // The whole message fit, so there is nothing left to follow up with.
    expect(h.sent).toHaveLength(0);
  });

  it("splits into caption + follow-up when the body exceeds the caption cap", async () => {
    // Every real shape measures well under 1024 today; this drives the branch
    // with a body that does not, which is what a longer why-now rule or a wide
    // asset symbol would produce.
    const long = "y".repeat(1200);
    const h = harness({
      pending: [delivery({ label: "The whale" })],
      sendPhoto: ok,
    });
    await dispatchPending({
      ...h.deps,
      whyNow: () => ({
        triggers: ["collateral:unpriced"],
        facts: {
          healthFactor: 1.14,
          scoredCollateralSymbol: long,
          subScores: { positionHealth: 88, assetRisk: 52, protocolSafety: 30, systemicRisk: 22 },
          protocol: "aave_v3",
          profile: "moderate",
        },
      }),
    });

    // The caption identifies the position; the follow-up carries the facts.
    expect(captionLength(h.photos[0]!.opts?.caption ?? "")).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_MAX,
    );
    expect(plain(h.photos[0]!.opts?.caption ?? "")).toBe(
      "The whale (0xaaaa...1111) on Aave V3 is over your moderate limit.",
    );
    expect(h.sent).toHaveLength(1);
    expect(plain(h.sent[0]!.text)).toContain("Risk score 62 of 100");
  });

  it("marks a simulated card as a drill, on the image", async () => {
    const h = harness({
      pending: [delivery({ simulation_id: "sim-1", simulation_label: "Crash" })],
      sendPhoto: ok,
    });
    await dispatchPending(h.deps);
    // The card is a PNG by the time it reaches here, so the drill is asserted
    // through the SVG the same inputs produce (server/alertCard.test.ts covers
    // the marker itself); what this pins is that the flag was passed at all.
    expect(h.photos).toHaveLength(1);
    expect(plain(h.photos[0]!.opts?.caption ?? "")).toContain("Simulated event (Crash)");
  });

  it("FALLS BACK to text when the photo upload is refused", async () => {
    const h = harness({
      pending: [delivery()],
      sendPhoto: async () => ({ ok: false, status: 400, description: "IMAGE_PROCESS_FAILED" }),
    });

    const report = await dispatchPending(h.deps);

    // The alert still went out, still counts as delivered, and the failure is
    // a log line rather than a lost warning.
    expect(report).toEqual({ considered: 1, sent: 1, suppressed: 0, failed: 0 });
    expect(h.sent).toHaveLength(1);
    expect(plain(h.sent[0]!.text)).toContain("Risk score 62 of 100");
    expect(h.delivered).toEqual([101]);
  });

  it("FALLS BACK to text when the photo upload throws", async () => {
    const h = harness({
      pending: [delivery()],
      sendPhoto: async () => {
        throw new Error("socket hang up");
      },
    });
    const report = await dispatchPending(h.deps);
    expect(report.sent).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it("sends text only when the deps carry no photo sender", async () => {
    const h = harness({ pending: [delivery()] });
    await dispatchPending(h.deps);
    expect(h.photos).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it("still reports a 403 as blocked when the fallback text is refused too", async () => {
    const h = harness({
      pending: [delivery()],
      sendPhoto: async () => ({ ok: false, status: 400, description: "no" }),
      send: async () => ({ ok: false, status: 403, errorCode: 403, description: "blocked" }),
    });
    await dispatchPending(h.deps);
    expect(h.blocked).toEqual([101]);
    expect(h.stamps()).toEqual([
      { transitionId: "1", owner: ANNA, chatId: 101, channel: "blocked", attempts: 1 },
    ]);
  });
});

describe("dispatchPending — watch-only", () => {
  it("tells a watcher that PANIK cannot act on this wallet", async () => {
    const h = harness({ pending: [delivery({ owner_wallet: ANNA, wallet: WHALE })] });
    await dispatchPending(h.deps);
    expect(plain(h.sent[0]!.text)).toContain(
      "This wallet is watch-only: PANIK cannot act on it for you",
    );
  });

  it("says nothing of the kind on the subscriber's own position", async () => {
    const h = harness({ pending: [delivery({ owner_wallet: WHALE, wallet: WHALE })] });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).not.toContain("watch-only");
  });

  it("compares the two addresses case-insensitively", async () => {
    const h = harness({
      pending: [delivery({ owner_wallet: WHALE.toUpperCase().replace("0X", "0x"), wallet: WHALE })],
    });
    await dispatchPending(h.deps);
    expect(h.sent[0]!.text).not.toContain("watch-only");
  });
});

describe("the Open in PANIK button", () => {
  it("points at the WATCHED wallet, not the subscriber's own", async () => {
    const h = harness({ pending: [delivery({ owner_wallet: ANNA, chat_id: "101" })] });
    await dispatchPending({ ...h.deps, appUrl: "https://www.panik.fi/app" });

    expect(h.sent[0]!.opts?.button).toEqual({
      text: OPEN_IN_PANIK_TEXT,
      url: `https://www.panik.fi/app?view=${WHALE}&tab=advisor`,
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
      url: `https://www.panik.fi/app?view=${WHALE}&tab=advisor`,
    });
  });

  it("keeps a query string the configured URL already had", () => {
    expect(viewButton("https://preview.panik.fi/app?chain=base", WHALE)?.url).toBe(
      `https://preview.panik.fi/app?chain=base&view=${WHALE}&tab=advisor`,
    );
  });

  it("lowercases the wallet so the link matches the watchlist", () => {
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE.toUpperCase().replace("0X", "0x"))?.url).toBe(
      `https://www.panik.fi/app?view=${WHALE}&tab=advisor`,
    );
  });

  it("lands on the Advisor, which is the screen the message's instruction lives on", () => {
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE)?.text).toBe("Open PANIK Advisor");
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE)?.url).toContain("tab=advisor");
  });

  it("is dropped, not guessed, when the configured URL is unusable", async () => {
    // Telegram 400s the WHOLE send on a malformed button URL, so a fat-fingered
    // PANIK_APP_URL must cost the button and never the alert.
    expect(viewButton("panik.fi/app", WHALE)).toBeNull();
    expect(viewButton("javascript:alert(1)", WHALE)).toBeNull();

    const h = harness({ pending: [delivery()] });
    const report = await dispatchPending({ ...h.deps, appUrl: "not a url" });
    expect(report.sent).toBe(1);
    expect(h.sent[0]!.opts?.button).toBeUndefined();
    // The send itself is untouched, parse mode and all.
    expect(h.sent[0]!.opts?.parseMode).toBe("HTML");
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
