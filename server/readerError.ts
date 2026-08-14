/**
 * One-line, credential-free description of a scoring reader failure.
 *
 * Every `onReaderError` sink logged `(err as Error).message.slice(0, 120)`, and
 * on 2026-08-14 that hid a total outage for two days. Alchemy's monthly
 * capacity was exhausted and every Base mainnet call came back 429, but a viem
 * transport error reads:
 *
 *     RPC Request failed.
 *
 *     URL: https://base-mainnet.g.alchemy.com/v2/<key>
 *     Request body: {"method":"eth_call","params":[{"data":"0x252dba42…
 *
 *     Details: Monthly capacity limit exceeded.
 *     Version: viem@2.x
 *
 * The request body is a multicall's calldata — hundreds of characters of hex —
 * and it sits between the useless first line and the only line that names the
 * cause. 120 characters never reached `Details:`, so `grep 429` over the worker
 * log returned nothing while every read was failing.
 *
 * Raising the limit alone would have been worse, not better: the URL carries
 * the API key, so a wider slice writes the credential to the log on every
 * failure. Hence three transformations rather than a bigger number.
 */

/**
 * Host kept, path and query dropped.
 *
 * The host is the diagnosis — it says which provider refused — and the path is
 * where the secret lives (`/v2/<key>` for Alchemy, `?apikey=` elsewhere). There
 * is no allow-list of "safe" paths here on purpose: a redactor that has to
 * recognise every provider's key format fails silently the first time a new
 * provider is added, and failing silently is the whole bug above.
 */
function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s/?#]+)([^\s]*)/g, (_m, origin: string, rest: string) =>
    rest && rest !== "/" ? `${origin}/<redacted>` : origin,
  );
}

/**
 * `err` as a single line: no credentials, no calldata, cause preserved.
 *
 * `max` is generous compared with the 120 it replaces because the expensive
 * part is already gone by the time it applies.
 */
export function describeReaderError(err: unknown, max = 400): string {
  const raw = err instanceof Error ? err.message : String(err);

  const kept = raw
    .split("\n")
    // Encoded payloads, and nothing a reader of the log can act on. Matched by
    // SHAPE rather than by label: viem spends the budget under at least two
    // different headings (`Request body:` on a transport error, `Raw Call
    // Arguments:` on a contract error), and filtering the labels alone left the
    // second blob in place and pushed `Details:` off the end anyway. A run of
    // hex this long is calldata under any heading, including future ones.
    .filter((l) => !/0x[0-9a-fA-F]{64,}/.test(l))
    // `Docs:` is a static link to viem's website. It is the same on every
    // error and has never told anyone which of their reads is failing.
    .filter((l) => !/^\s*(Request body|Version|Docs):/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);

  // Order by usefulness, do not merely truncate. Dropping the payloads above
  // was not enough on its own: viem puts a `Contract Call:` block and a docs
  // link between the opening line and `Details:`, so the length of the prefix
  // varies with the error and the cause fell off the end anyway. Hoisting the
  // cause makes the surviving text independent of how chatty the middle is.
  const [head, ...tail] = kept;
  const isCause = (l: string): boolean => /^(Details|Status|Reason):/i.test(l);
  const ordered = [head, ...tail.filter(isCause), ...tail.filter((l) => !isCause(l))];

  const clean = redactUrls(ordered.filter(Boolean).join(" | "));
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
