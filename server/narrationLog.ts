/**
 * Audit trail for LLM narration - what the model said, and what we did with it.
 *
 * The Advisor's guards (packages/scoring/src/providers/narrationGuard.ts) throw
 * away any narration that invents a number or hedges a critical call, and the
 * user never sees the rejected text. That is the right behaviour and it is also
 * why the rejections have to be written down somewhere: without this table the
 * only evidence a model tried to talk a user out of an exit is a counter that
 * went up. Rows are the input to "is this model still fit for the job".
 *
 * The write is fire-and-forget in both directions - a failed insert must never
 * cost a user their advice, and a slow insert must never delay it.
 *
 * PII: the wallet address, which /api/advisor already stores in
 * `public.advisor_events`, and a hash of the prompt rather than the prompt.
 */

import { createHash } from "node:crypto";

/**
 * Longest raw completion kept.
 *
 * The narrator asks for four sections of ~40 words, so an honest response is
 * well under 2 kB. The cap is what stops one runaway or hostile completion from
 * writing a megabyte per leg per wallet into a table nobody is watching.
 */
export const RAW_RESPONSE_MAX = 8_000;

export type NarrationServed = "narrated" | "fallback";

export interface NarrationLogRow {
  wallet: string;
  model: string;
  /** Null when no model response exists: breaker open, hostile symbol, timeout. */
  rawResponse: string | null;
  numericPass: boolean;
  hedgePass: boolean;
  served: NarrationServed;
  payloadHash: string;
}

/** The one call the API server needs to provide. */
export interface NarrationStore {
  insert(row: NarrationLogRow): Promise<unknown>;
}

/**
 * SHA-256 of the exact user message.
 *
 * A hash rather than the payload itself: the prompt carries a wallet's whole
 * position (sizes, protocols, health factors), it is reconstructible from the
 * score snapshots already retained, and storing it twice would make this table
 * the most sensitive thing in the database. The hash is still enough to group
 * repeated narrations of an unchanged position, which is what the rows are for.
 */
export function payloadHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export interface NarrationLogInput {
  wallet: string;
  model: string;
  raw: string | null;
  numericPass: boolean;
  hedgePass: boolean;
  served: NarrationServed;
  /** The fenced user message; hashed here, never stored. */
  payload: string;
}

export function narrationLogRow(input: NarrationLogInput): NarrationLogRow {
  return {
    wallet: input.wallet.toLowerCase(),
    model: input.model,
    rawResponse: input.raw === null ? null : input.raw.slice(0, RAW_RESPONSE_MAX),
    numericPass: input.numericPass,
    hedgePass: input.hedgePass,
    served: input.served,
    payloadHash: payloadHash(input.payload),
  };
}

/**
 * Append one row, swallowing everything.
 *
 * Returns void rather than a promise on purpose: a caller that could `await`
 * this would eventually be tempted to, and the narration path is already
 * time-boxed against the model. `onError` exists so the failure is still
 * visible in the server log.
 */
export function logNarration(
  store: NarrationStore,
  input: NarrationLogInput,
  onError: (err: unknown) => void = () => {},
): void {
  let row: NarrationLogRow;
  try {
    row = narrationLogRow(input);
  } catch (err) {
    onError(err);
    return;
  }
  void Promise.resolve()
    .then(() => store.insert(row))
    .catch(onError);
}
