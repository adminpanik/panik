/**
 * The wire shape of a send.
 *
 * Telegram's API is hand-rolled here (no SDK, by policy), so the request body
 * is the contract and nothing else checks it. `reply_markup` in particular is a
 * shape Telegram validates strictly and rejects the WHOLE send over: a button
 * nested one level wrong does not degrade to a message without a button, it
 * turns into a 400 and an alert nobody received.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "./telegram";

interface SentBody {
  chat_id: number | string;
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
  disable_web_page_preview?: boolean;
}

function captureFetch(response: unknown = { ok: true }) {
  const bodies: SentBody[] = [];
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    urls.push(url);
    bodies.push(JSON.parse(init.body) as SentBody);
    return { ok: true, status: 200, json: async () => response } as unknown as Response;
  });
  return { bodies, urls };
}

afterEach(() => vi.unstubAllGlobals());

describe("sendMessage", () => {
  it("sends plain text with no keyboard key at all by default", async () => {
    const { bodies, urls } = captureFetch();
    const res = await sendMessage("token-123", 101, "hello");

    expect(res.ok).toBe(true);
    expect(urls[0]).toBe("https://api.telegram.org/bottoken-123/sendMessage");
    expect(bodies[0]!.text).toBe("hello");
    // Absent, not null: an explicit null reply_markup is rejected by some API
    // versions, and "no key" is the documented way to say "no keyboard".
    expect("reply_markup" in bodies[0]!).toBe(false);
  });

  it("wraps one URL button as a single-row inline keyboard", async () => {
    const { bodies } = captureFetch();
    await sendMessage("token-123", 101, "hello", {
      button: { text: "Open in PANIK", url: "https://www.panik.fi/app?view=0xabc" },
    });

    expect(bodies[0]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Open in PANIK", url: "https://www.panik.fi/app?view=0xabc" }]],
    });
  });

  it("reports Telegram's own refusal rather than throwing", async () => {
    captureFetch({ ok: false, error_code: 403, description: "bot was blocked by the user" });
    const res = await sendMessage("token-123", 101, "hello");
    expect(res).toMatchObject({ ok: false, errorCode: 403 });
  });
});
