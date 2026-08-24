/**
 * The alert button's `sid` — a single-use deep-link token that lets a worried
 * reader land already recognised instead of being asked to connect a wallet by
 * the message telling them their position is in trouble.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS THE FALLBACK. Minting is a convenience
 * bolted onto the one code path in this product that is genuinely sacred. If
 * the session table is unreachable, the alert still goes out — with the plain
 * button, exactly as it did before sessions existed. A liquidation warning lost
 * to a sign-in nicety would be the worst trade this codebase could make, so it
 * is pinned here rather than left to the reading of a try/catch.
 *
 * Kept in its own file rather than folded into watchDispatch.test.ts so the
 * session work does not collide with concurrent edits to the alert message.
 */

import { describe, expect, it } from "vitest";
import {
  dispatchPending,
  OPEN_IN_PANIK_TEXT,
  PANIK_APP_URL_DEFAULT,
  viewButton,
  type DispatchDeps,
  type PendingDelivery,
} from "./watchDispatch";
import { hashToken } from "./sessionStore";
import type { SendOptions, TelegramSendResult } from "./telegram";

const WHALE = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const ANNA = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const BEN = "0xcccc3333cccc3333cccc3333cccc3333cccc3333";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

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

interface Minted {
  tokenHash: string;
  owner: string;
  transitionId: unknown;
}

function harness(opts: { pending: PendingDelivery[]; mintFails?: boolean }) {
  const sent: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  const minted: Minted[] = [];
  const errors: string[] = [];

  const deps: DispatchDeps = {
    db: {
      query: (async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith("select to_status, created_at from (")) return { rows: [] };
        if (sql.includes("from public.watch_transitions t")) return { rows: opts.pending };
        if (sql.startsWith("insert into public.deep_link_tokens")) {
          if (opts.mintFails) throw new Error("deep_link_tokens unreachable");
          minted.push({
            tokenHash: String(values[0]),
            owner: String(values[1]),
            transitionId: values[2],
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }) as DispatchDeps["db"]["query"],
    },
    send: async (chatId, text, sendOpts): Promise<TelegramSendResult> => {
      sent.push({ chatId, text, opts: sendOpts });
      return { ok: true, status: 200 };
    },
    whyNow: () => undefined,
    onDelivered: async () => undefined,
    onBlocked: async () => undefined,
    maxAttempts: 8,
    log: { error: (m: string) => errors.push(m) },
  };

  return { deps, sent, minted, errors };
}

/** The `sid` on the button of the nth sent message, or null. */
const sidOf = (url: string | undefined): string | null =>
  url ? new URL(url).searchParams.get("sid") : null;

describe("viewButton — sid is optional", () => {
  it("produces the pre-session URL when there is no token", () => {
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE)).toEqual({
      text: OPEN_IN_PANIK_TEXT,
      url: `https://www.panik.fi/app?view=${WHALE}&tab=advisor`,
    });
    expect(viewButton(PANIK_APP_URL_DEFAULT, WHALE, null)?.url).not.toContain("sid");
  });

  it("appends sid last, leaving view and tab untouched", () => {
    const url = viewButton(PANIK_APP_URL_DEFAULT, WHALE, "tok123")!.url;
    expect(url).toBe(`https://www.panik.fi/app?view=${WHALE}&tab=advisor&sid=tok123`);
  });

  it("still refuses a malformed base, sid or no sid", () => {
    // Telegram 400s the whole send on a bad button URL. A token must not turn a
    // refused button into a refused alert.
    expect(viewButton("panik.fi/app", WHALE, "tok123")).toBeNull();
    expect(viewButton("javascript:alert(1)", WHALE, "tok123")).toBeNull();
  });
});

describe("the dispatcher mints one token per delivered alert", () => {
  it("puts a real, url-safe sid on the button and stores only its hash", async () => {
    const h = harness({ pending: [delivery()] });
    await dispatchPending(h.deps);

    expect(h.sent).toHaveLength(1);
    const sid = sidOf(h.sent[0]!.opts?.button?.url);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(h.minted).toHaveLength(1);
    expect(h.minted[0]!.tokenHash).toBe(hashToken(sid!));
    // The raw token never reached the database.
    expect(h.minted[0]!.tokenHash).not.toBe(sid);
  });

  it("binds the token to the SUBSCRIBER, never the watched wallet", async () => {
    // Anna watches the whale. The button opens the whale's position, but the
    // token signs Anna in as Anna — a token naming the whale would hand her a
    // stranger's identity.
    const h = harness({ pending: [delivery({ owner_wallet: ANNA })] });
    await dispatchPending(h.deps);

    expect(h.minted[0]!.owner).toBe(ANNA);
    expect(h.sent[0]!.opts?.button?.url).toContain(`view=${WHALE}`);
    expect(h.sent[0]!.opts?.button?.url).not.toContain(ANNA);
  });

  it("gives each subscriber their own token for the same transition", async () => {
    const h = harness({
      pending: [
        delivery({ owner_wallet: ANNA, chat_id: "101" }),
        delivery({ owner_wallet: BEN, chat_id: "202" }),
      ],
    });
    await dispatchPending(h.deps);

    expect(h.minted.map((m) => m.owner)).toEqual([ANNA, BEN]);
    const sids = h.sent.map((s) => sidOf(s.opts?.button?.url));
    expect(new Set(sids).size).toBe(2);
    // Ben's button must not carry Anna's claim.
    expect(sids[0]).not.toBe(sids[1]);
  });

  it("records the transition the token rode on", async () => {
    const h = harness({ pending: [delivery({ id: "77" })] });
    await dispatchPending(h.deps);
    expect(h.minted[0]!.transitionId).toBe("77");
  });

  it("mints nothing for a suppressed delivery", async () => {
    // The anti-spam gate resolves this one without sending, so there is no
    // button and no reader to recognise.
    const h = harness({
      pending: [delivery({ borrow_usd: "1", collateral_usd: "2", health_factor: "9" })],
    });
    const report = await dispatchPending(h.deps);

    expect(report.sent).toBe(0);
    expect(report.suppressed).toBe(1);
    expect(h.minted).toHaveLength(0);
  });
});

describe("the alert survives a mint failure", () => {
  it("sends the alert with a plain button when minting throws", async () => {
    const h = harness({ pending: [delivery()], mintFails: true });
    const report = await dispatchPending(h.deps);

    // THE ASSERTION THIS FILE EXISTS FOR: the warning still went out.
    expect(report).toEqual({ considered: 1, sent: 1, suppressed: 0, failed: 0, deferred: 0 });
    expect(h.sent).toHaveLength(1);

    const button = h.sent[0]!.opts?.button;
    expect(button?.text).toBe(OPEN_IN_PANIK_TEXT);
    expect(button?.url).toBe(`https://www.panik.fi/app?view=${WHALE}&tab=advisor`);
    expect(sidOf(button?.url)).toBeNull();
  });

  it("says so in the log rather than failing silently", async () => {
    const h = harness({ pending: [delivery()], mintFails: true });
    await dispatchPending(h.deps);

    expect(h.errors.some((e) => e.includes("deep-link token mint failed"))).toBe(true);
    expect(h.errors.some((e) => e.includes("without sid"))).toBe(true);
  });

  it("one subscriber's mint failure does not cost anyone else their sid", async () => {
    // A failure is per-call, so a transient error must not degrade the batch.
    let calls = 0;
    const pending = [
      delivery({ owner_wallet: ANNA, chat_id: "101" }),
      delivery({ owner_wallet: BEN, chat_id: "202" }),
    ];
    const sent: Array<{ opts?: SendOptions }> = [];
    const deps: DispatchDeps = {
      db: {
        query: (async (sql: string) => {
          if (sql.startsWith("select to_status, created_at from (")) return { rows: [] };
          if (sql.includes("from public.watch_transitions t")) return { rows: pending };
          if (sql.startsWith("insert into public.deep_link_tokens")) {
            calls += 1;
            if (calls === 1) throw new Error("transient");
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }) as DispatchDeps["db"]["query"],
      },
      send: async (_chatId, _text, sendOpts) => {
        sent.push({ opts: sendOpts });
        return { ok: true, status: 200 };
      },
      whyNow: () => undefined,
      onDelivered: async () => undefined,
      onBlocked: async () => undefined,
      maxAttempts: 8,
      log: { error: () => undefined },
    };

    const report = await dispatchPending(deps);
    expect(report.sent).toBe(2);
    expect(sidOf(sent[0]!.opts?.button?.url)).toBeNull();
    expect(sidOf(sent[1]!.opts?.button?.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
