/**
 * Telegram Bot API send helper. Pure fetch (no viem/pg), so it bundles cleanly
 * in a Vercel serverless function and also runs in the standalone worker.
 *
 * The dispatcher stamps watch_transitions.notified_at only when ok === true, so
 * a transient failure (429/5xx) leaves the row for the next poll.
 */

export interface TelegramSendResult {
  /** Telegram's own ok flag (its JSON body), AND the HTTP request succeeded. */
  ok: boolean;
  /** HTTP status (or 0 if the request never completed). */
  status: number;
  /** Telegram error_code when ok is false (e.g. 403 = blocked, 429 = rate). */
  errorCode?: number;
  description?: string;
}

/**
 * A single URL button under the message.
 *
 * Telegram's `reply_markup` accepts several mutually exclusive shapes; this is
 * deliberately the narrowest one we have a use for (`inline_keyboard` with one
 * row of one URL button), rather than a passthrough of arbitrary JSON. A URL
 * button needs no callback handling, works in a one-to-one chat, and cannot
 * change what the bot does - the worst a bad value can do is fail Telegram's
 * own URL validation, which comes back as a 400 on the send.
 */
export interface TelegramUrlButton {
  text: string;
  url: string;
}

export interface SendOptions {
  /**
   * OPT-IN, and the caller owns escaping.
   *
   * Absent means Telegram does not parse the body at all, which is why every
   * sender that posts text it did not build - the webhook replies, the operator
   * pages, `formatWelcome` - leaves it absent and is unaffected by any of this.
   * Set it only for a formatter that escapes what it interpolates
   * (`packages/scoring/src/watch/alertMessage.ts`). Sending unescaped user text
   * under a parse mode does not render badly; Telegram returns 400 and the
   * message is never delivered.
   */
  parseMode?: "MarkdownV2" | "HTML";
  disablePreview?: boolean;
  /** Rendered as one inline-keyboard row holding one URL button. */
  button?: TelegramUrlButton;
  signal?: AbortSignal;
}

/**
 * POST sendMessage. Returns a structured result instead of throwing so callers
 * can branch on errorCode (403 -> disable link, 429 -> back off, else retry).
 */
export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  opts: SendOptions = {},
): Promise<TelegramSendResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode,
        disable_web_page_preview: opts.disablePreview ?? true,
        // Omitted entirely when there is no button: Telegram rejects a null
        // reply_markup on some API versions, and an absent key is the
        // documented "no keyboard" state.
        ...(opts.button
          ? { reply_markup: { inline_keyboard: [[{ text: opts.button.text, url: opts.button.url }]] } }
          : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, status: 0, description: (err as Error).message };
  }

  let body: { ok?: boolean; error_code?: number; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON body (rare); fall back to HTTP status.
  }

  return {
    ok: res.ok && body.ok === true,
    status: res.status,
    errorCode: body.error_code,
    description: body.description,
  };
}

/**
 * REACHABILITY PROBE. `sendChatAction` with "typing" runs Telegram's full
 * delivery permission check — it returns 403 "bot was blocked by the user" for
 * a blocked bot — while showing the user at most a typing indicator that
 * disappears on its own.
 *
 * The two obvious alternatives are both wrong. `getChat` succeeds for a user
 * who has blocked the bot, so it proves nothing. `sendMessage` proves
 * everything and messages someone who did not ask to be messaged, daily. This
 * is the only lightweight call that actually answers "can we still reach this
 * user", which is the question the honest alert state depends on.
 *
 * Returns the same structured result as sendMessage so callers branch on
 * errorCode identically (403 -> terminal, else transient).
 */
export async function probeReachable(
  token: string,
  chatId: number | string,
  opts: { signal?: AbortSignal } = {},
): Promise<TelegramSendResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, status: 0, description: (err as Error).message };
  }

  let body: { ok?: boolean; error_code?: number; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON body (rare); fall back to HTTP status.
  }

  return {
    ok: res.ok && body.ok === true,
    status: res.status,
    errorCode: body.error_code,
    description: body.description,
  };
}

/**
 * Register the bot's webhook with Telegram (idempotent). Called on API boot so
 * /start updates are delivered without a manual `telegram:setup`. `secret` is
 * echoed back by Telegram in the X-Telegram-Bot-Api-Secret-Token header, which
 * the webhook handler checks.
 */
export async function setWebhook(
  token: string,
  url: string,
  secret: string,
): Promise<TelegramSendResult> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
    });
  } catch (err) {
    return { ok: false, status: 0, description: (err as Error).message };
  }
  let body: { ok?: boolean; error_code?: number; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON body (rare); fall back to HTTP status.
  }
  return { ok: res.ok && body.ok === true, status: res.status, errorCode: body.error_code, description: body.description };
}
