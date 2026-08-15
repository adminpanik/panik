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
import { captionLength, sendMessage, sendPhoto, TELEGRAM_CAPTION_MAX } from "./telegram";

interface SentBody {
  chat_id: number | string;
  text: string;
  parse_mode?: string;
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
    // No parse mode by default, so the senders that post text they did not
    // build keep posting it uninterpreted. A `<` in a wallet nickname reaching
    // an unescaped parse mode is a 400, not a styling bug.
    expect(bodies[0]!.parse_mode).toBeUndefined();
  });

  it("parses the body as HTML only when the caller opts in", async () => {
    const { bodies } = captureFetch();
    await sendMessage("token-123", 101, "<b>hi</b>", { parseMode: "HTML" });
    expect(bodies[0]!.parse_mode).toBe("HTML");
    expect(bodies[0]!.text).toBe("<b>hi</b>");
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

/** Captures a multipart body as a plain map, which is all these tests assert on. */
function captureForm(response: unknown = { ok: true }) {
  const forms: FormData[] = [];
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: FormData; headers?: unknown }) => {
    urls.push(url);
    forms.push(init.body);
    // Content-Type must be left to fetch: setting it by hand loses the boundary
    // and Telegram cannot parse the parts.
    expect(init.headers).toBeUndefined();
    return { ok: true, status: 200, json: async () => response } as unknown as Response;
  });
  return { forms, urls };
}

describe("sendPhoto", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it("uploads the bytes as multipart, with the caption and the button", async () => {
    const { forms, urls } = captureForm();
    const res = await sendPhoto("token-123", 101, png, {
      caption: "<b>hi</b>",
      parseMode: "HTML",
      button: { text: "Open PANIK Advisor", url: "https://www.panik.fi/app?view=0xabc&tab=advisor" },
    });

    expect(res.ok).toBe(true);
    expect(urls[0]).toBe("https://api.telegram.org/bottoken-123/sendPhoto");
    const form = forms[0]!;
    expect(form.get("chat_id")).toBe("101");
    expect(form.get("caption")).toBe("<b>hi</b>");
    expect(form.get("parse_mode")).toBe("HTML");
    expect(JSON.parse(form.get("reply_markup") as string)).toEqual({
      inline_keyboard: [
        [{ text: "Open PANIK Advisor", url: "https://www.panik.fi/app?view=0xabc&tab=advisor" }],
      ],
    });
    const photo = form.get("photo") as File;
    expect(photo.type).toBe("image/png");
    expect(photo.size).toBe(png.length);
  });

  it("omits the optional parts rather than sending empty ones", async () => {
    const { forms } = captureForm();
    await sendPhoto("token-123", 101, png);
    expect(forms[0]!.get("caption")).toBeNull();
    expect(forms[0]!.get("parse_mode")).toBeNull();
    expect(forms[0]!.get("reply_markup")).toBeNull();
  });

  it("returns a structured refusal instead of throwing", async () => {
    captureForm({ ok: false, error_code: 403, description: "bot was blocked" });
    expect(await sendPhoto("token-123", 101, png)).toMatchObject({ ok: false, errorCode: 403 });

    vi.stubGlobal("fetch", async () => {
      throw new Error("socket hang up");
    });
    expect(await sendPhoto("token-123", 101, png)).toMatchObject({ ok: false, status: 0 });
  });
});

describe("captionLength", () => {
  it("counts what Telegram counts: the text, not the markup", () => {
    // Telegram's 1024 cap is "after entities parsing", so measuring the raw
    // string would push short messages onto the follow-up path over tags the
    // reader never sees.
    expect(captionLength("<b>abc</b>")).toBe(3);
    expect(captionLength("a &amp; b &lt;c&gt;")).toBe(9); // "a & b <c>"
    expect(captionLength("plain")).toBe(5);
    expect(TELEGRAM_CAPTION_MAX).toBe(1024);
  });
});
