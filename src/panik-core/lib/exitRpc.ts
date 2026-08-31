/**
 * How the exit flow reaches the chain, and what it says when it cannot.
 *
 * Two concerns live here because they are two halves of one failure:
 *
 * 1. **Which endpoints the transport tries.** The flow used to run on a bare
 *    `http()`, which resolves to the chain's single default public node
 *    (`https://sepolia.base.org` on Base Sepolia). That node rate-limits, and
 *    when it did there was nowhere else to go: one batched `aggregate3` read
 *    failed and took the whole modal with it.
 * 2. **What a failed chain call is called in front of a user.** viem builds its
 *    transport errors out of the endpoint URL and the full JSON request body,
 *    so `(err as Error).message` is a paragraph of hex calldata. Printing that
 *    was the defect logged as §4.2 in the UI audit.
 *
 * Both are pure functions with no viem, wagmi or `import.meta` dependency, so
 * they are unit tested directly - the transport wiring that consumes them lives
 * in `./exit`.
 *
 * The classification half is not exit-only: the OPEN flow signs against the
 * same chain through the same viem client and leaks the same paragraph when it
 * fails, so it routes its failures through `classifyExitError` too rather than
 * keeping a second, weaker copy of this reasoning.
 */

/**
 * Keyless public endpoints per chain, in the order they are tried.
 *
 * The chain's own node is first because it is the operator of record; the other
 * two are only contacted when the one before them has already failed, so the
 * usual request reaches exactly the node it reaches today. All three were
 * checked for `eth_chainId` and for Multicall3 bytecode at
 * `0xca11bde05977b3631167028862be2a173976ca11`, which is the contract the reads
 * in this flow are batched through - a fallback node without it would turn one
 * rate limit into a different, harder failure.
 */
export const PUBLIC_RPC_URLS: Readonly<Record<number, readonly string[]>> = {
  // Base mainnet. Unused while execution is testnet-gated, configured anyway so
  // the mainnet cutover does not have to rediscover this bug.
  8453: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
  ],
  // Base Sepolia - where execution actually runs today.
  84532: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The endpoint list for a chain: an operator's override first, then the public
 * nodes.
 *
 * The override is dropped rather than trusted when it is blank or not an
 * http(s) URL. A typo in a deploy-time env var would otherwise become the FIRST
 * endpoint every read tries, which is a worse outage than the one this list
 * exists to prevent, and it would be invisible because the reads still succeed
 * on the second entry.
 *
 * Duplicates are collapsed: an override that names the public node is one
 * endpoint, not two, and a fallback that retries the same URL twice is a
 * fallback in name only.
 */
export function exitRpcUrls(chainId: number, override?: string | null): string[] {
  const urls: string[] = [];
  const trimmed = typeof override === "string" ? override.trim() : "";
  if (trimmed && isHttpUrl(trimmed)) urls.push(trimmed);
  urls.push(...(PUBLIC_RPC_URLS[chainId] ?? []));
  return [...new Set(urls)];
}

// ── Failure classification ────────────────────────────────────────────────

export type ExitFailureKind = "network" | "rejected" | "reverted" | "stated" | "unknown";

/**
 * A failure whose sentence the flow already wrote.
 *
 * This classifier exists because viem's own messages are unreadable and carry
 * the endpoint URL and the calldata. Neither is true of a message a flow
 * authored for one exact situation ("Insufficient cbBTC: need ~0.00120, have
 * 0.00000"), and replacing that with "Something went wrong" would throw away
 * the only sentence that tells the user what to do about it.
 *
 * Throwing this instead of a plain Error keeps the sentence, and keeps the
 * decision at the throw site rather than in a regex over error text. The
 * message must therefore be safe to render: no URL, no JSON-RPC body, no
 * calldata, no contract address.
 */
export class StatedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatedFailure";
  }
}

export interface ExitFailure {
  kind: ExitFailureKind;
  /**
   * One plain sentence for the user. Never carries an endpoint URL, a JSON-RPC
   * body, calldata or a contract address.
   */
  message: string;
  /** The raw error text. For `console` and logs only - never rendered. */
  detail: string;
}

/**
 * A wallet rejection. `4001` is the EIP-1193 code; the names cover viem's own
 * wrappers, and the text covers wallets that only send a string.
 */
const REJECT_NAMES = new Set(["UserRejectedRequestError", "TransactionRejectedRpcError"]);
const REJECT_TEXT = /user rejected|user denied|rejected the request|denied transaction/i;

/**
 * An on-chain revert. Checked BEFORE the network patterns on purpose: a revert
 * reaches the client wrapped in an `RpcRequestError`, whose name also appears in
 * the network set, and calling a genuine revert "we could not reach the network"
 * would send the user to retry something that will fail identically forever.
 */
const REVERT_NAMES = new Set([
  "ContractFunctionRevertedError",
  "ExecutionRevertedError",
  "RawContractError",
]);
const REVERT_TEXT = /execution reverted|reverted on-chain|reverted with|revert reason/i;

/**
 * A transport problem: unreachable, timed out, or rate limited. This is the
 * bucket the founder's `https://sepolia.base.org` failure lands in.
 */
const NETWORK_NAMES = new Set([
  "HttpRequestError",
  "TimeoutError",
  "RpcRequestError",
  "InternalRpcError",
  "LimitExceededRpcError",
  "SocketClosedError",
  "WebSocketRequestError",
  "UnknownRpcError",
]);
const NETWORK_TEXT =
  /rate ?limit|too many requests|timed out|timeout|fetch failed|failed to fetch|networkerror|load failed|econnrefused|econnreset|enotfound|socket hang up|http request failed|request failed/i;

interface ErrorFacts {
  names: string[];
  codes: number[];
  text: string;
}

/**
 * Flatten an error and everything it wraps into the three things worth matching
 * on. viem nests deeply (`ContractFunctionExecutionError` -> `CallExecutionError`
 * -> `HttpRequestError`), and the decisive signal is almost never on the
 * outermost object.
 *
 * The `seen` set and the depth cap are there because a cause chain that points
 * back at itself is a hang, not an error message.
 */
function collectFacts(err: unknown): ErrorFacts {
  const names: string[] = [];
  const codes: number[] = [];
  const parts: string[] = [];
  const seen = new Set<unknown>();

  let current: unknown = err;
  for (let depth = 0; depth < 12 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const node = current as {
      name?: unknown;
      code?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof node.name === "string") names.push(node.name);
    if (typeof node.code === "number") codes.push(node.code);
    for (const field of [node.shortMessage, node.details, node.message]) {
      if (typeof field === "string" && field) parts.push(field);
    }
    current = node.cause;
  }

  if (parts.length === 0 && typeof err === "string" && err) parts.push(err);
  return { names, codes, text: parts.join(" | ") };
}

function matches(facts: ErrorFacts, names: Set<string>, text: RegExp): boolean {
  return facts.names.some((n) => names.has(n)) || text.test(facts.text);
}

/** The user-facing sentence for each kind. Kept apart so it can be asserted on. */
export function exitFailureMessage(kind: ExitFailureKind, network: string): string {
  switch (kind) {
    case "network":
      // Says what to do, and claims nothing about transaction state: a
      // transport error while waiting on a receipt can follow a transaction
      // that was in fact broadcast.
      return `We could not reach ${network} just now. Check your connection and try again in a moment.`;
    case "rejected":
      return "You dismissed the request in your wallet, so nothing was signed.";
    case "reverted":
      // A revert is the one case where "nothing changed" is knowable: a
      // reverted transaction leaves no state behind.
      return `${network} would not accept this transaction, so nothing in your position changed.`;
    case "stated":
      // A stated failure carries its own sentence on the error, so there is no
      // generic wording for it here; `classifyExitError` never routes one
      // through this function. Reaching this case means a caller asked for a
      // sentence the kind does not have, and the catch-all is the honest
      // answer. Falls through deliberately.
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/**
 * Turn any thrown value into a kind and a sentence.
 *
 * Order is the whole design: rejection, then revert, then transport, then a
 * catch-all. Each earlier test is more specific than the one after it, and the
 * two that would otherwise collide (a revert delivered as an `RpcRequestError`)
 * are separated by putting the decisive marker first.
 */
export function classifyExitError(err: unknown, network: string): ExitFailure {
  // Ahead of every pattern: a stated failure is not a machine error waiting to
  // be recognised, it is a sentence the flow already chose. Only a flow that
  // throws `StatedFailure` can reach this branch, so no existing caller's
  // behaviour moves.
  if (err instanceof StatedFailure) {
    const message = err.message.replace(/\s+/g, " ").trim();
    return { kind: "stated", message, detail: message.slice(0, 500) };
  }

  const facts = collectFacts(err);

  let kind: ExitFailureKind = "unknown";
  if (facts.codes.includes(4001) || matches(facts, REJECT_NAMES, REJECT_TEXT)) {
    kind = "rejected";
  } else if (matches(facts, REVERT_NAMES, REVERT_TEXT)) {
    kind = "reverted";
  } else if (matches(facts, NETWORK_NAMES, NETWORK_TEXT)) {
    kind = "network";
  }

  const detail = (facts.text || String(err)).replace(/\s+/g, " ").trim().slice(0, 500);
  return { kind, message: exitFailureMessage(kind, network), detail };
}
