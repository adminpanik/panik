/**
 * Endpoint selection + failure classification for the exit flow.
 *
 * The case that motivated the module is the first one in `classifyExitError`:
 * a fresh wallet on Base Sepolia hit a rate limit on `https://sepolia.base.org`
 * and the modal printed viem's raw `HttpRequestError` - the endpoint URL and the
 * whole `aggregate3` request body, calldata and all. Every assertion below that
 * says `.not.toContain` is guarding that exact regression.
 *
 * The second thing under test is the ordering. A revert arrives wrapped in an
 * `RpcRequestError`, whose name is also in the network set, so "which check runs
 * first" decides whether a user is told to retry something that will fail
 * identically forever.
 */

import { describe, expect, it } from "vitest";
import {
  classifyExitError,
  exitFailureMessage,
  exitRpcUrls,
  PUBLIC_RPC_URLS,
  type ExitFailureKind,
} from "./exitRpc";

const NETWORK = "Base Sepolia";

/** Shape of the error viem hands back when a transport call fails. */
function viemError(
  name: string,
  message: string,
  cause?: unknown,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { name, cause, ...extra });
}

/**
 * The message the founder actually saw, reproduced in the shape viem builds it:
 * the endpoint, then the JSON-RPC body, then the aggregate3 calldata.
 */
const RATE_LIMITED_HTTP_ERROR = viemError(
  "HttpRequestError",
  [
    "HTTP request failed.",
    "",
    "Status: 429",
    "URL: https://sepolia.base.org",
    'Request body: {"method":"eth_call","params":[{"to":"0xca11bde05977b3631167028862be2a173976ca11","data":"0x82ad56cb00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001"}]}',
  ].join("\n"),
  undefined,
  { status: 429 },
);

describe("exitRpcUrls", () => {
  it("defaults to the chain's public endpoints, chain-owned node first", () => {
    expect(exitRpcUrls(84532)).toEqual([
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
    ]);
  });

  it("gives the same treatment to Base mainnet, so the cutover keeps the failover", () => {
    expect(exitRpcUrls(8453)[0]).toBe("https://mainnet.base.org");
    expect(exitRpcUrls(8453)).toHaveLength(3);
  });

  it("puts a configured override in front of the public list without dropping it", () => {
    expect(exitRpcUrls(84532, "https://my-node.example/v1")).toEqual([
      "https://my-node.example/v1",
      ...PUBLIC_RPC_URLS[84532]!,
    ]);
  });

  it("trims whitespace around an override", () => {
    expect(exitRpcUrls(84532, "  https://my-node.example/v1  ")[0]).toBe(
      "https://my-node.example/v1",
    );
  });

  it.each(["", "   ", undefined, null])(
    "ignores a blank override (%p) rather than making it endpoint zero",
    (override) => {
      expect(exitRpcUrls(84532, override)).toEqual(PUBLIC_RPC_URLS[84532]);
    },
  );

  it.each(["not-a-url", "wss://node.example", "ftp://node.example", "sepolia.base.org"])(
    "ignores a non-http override (%s) - a typo would otherwise be tried first on every read",
    (override) => {
      expect(exitRpcUrls(84532, override)).toEqual(PUBLIC_RPC_URLS[84532]);
    },
  );

  it("collapses an override that names a node already in the list", () => {
    const urls = exitRpcUrls(84532, "https://sepolia.base.org");
    expect(urls).toEqual(PUBLIC_RPC_URLS[84532]);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns an empty list for a chain it has no endpoints for", () => {
    expect(exitRpcUrls(1)).toEqual([]);
  });
});

describe("classifyExitError - transport failures", () => {
  it("classifies the rate-limited Base Sepolia read the founder hit as a network failure", () => {
    expect(classifyExitError(RATE_LIMITED_HTTP_ERROR, NETWORK).kind).toBe("network");
  });

  it("never leaks the endpoint, the JSON-RPC body or the calldata into the message", () => {
    const { message } = classifyExitError(RATE_LIMITED_HTTP_ERROR, NETWORK);
    expect(message).toBe(
      "We could not reach Base Sepolia just now. Check your connection and try again in a moment.",
    );
    expect(message).not.toContain("https://");
    expect(message).not.toContain("0x");
    expect(message).not.toContain("eth_call");
    expect(message).not.toContain("aggregate3");
    expect(message).not.toContain("{");
  });

  it("keeps the raw text on `detail`, for the console", () => {
    const { detail } = classifyExitError(RATE_LIMITED_HTTP_ERROR, NETWORK);
    expect(detail).toContain("https://sepolia.base.org");
    expect(detail).toContain("0x82ad56cb");
  });

  it("finds a transport failure nested under viem's contract-call wrappers", () => {
    const nested = viemError(
      "ContractFunctionExecutionError",
      "The contract function 'getUserReserveData' reverted.",
      viemError("CallExecutionError", "An error occurred.", RATE_LIMITED_HTTP_ERROR),
    );
    // "reverted" appears in the OUTER message and is still not the answer: the
    // decisive marker is the 429 underneath it.
    expect(classifyExitError(nested, NETWORK).kind).toBe("network");
  });

  it.each([
    ["TimeoutError", "The request took too long to respond."],
    ["RpcRequestError", "rate limit exceeded"],
    ["LimitExceededRpcError", "Request exceeds defined limit"],
    ["SocketClosedError", "The socket has been closed."],
  ])("classifies %s as a network failure", (name, message) => {
    expect(classifyExitError(viemError(name, message), NETWORK).kind).toBe("network");
  });

  it("classifies a bare fetch failure, which carries no viem name at all", () => {
    expect(classifyExitError(new TypeError("Failed to fetch"), NETWORK).kind).toBe("network");
  });
});

describe("classifyExitError - reverts", () => {
  it("classifies an on-chain revert, and does not call it a network problem", () => {
    const reverted = viemError(
      "ContractFunctionExecutionError",
      "The contract function 'atomicExit' reverted.",
      viemError("ContractFunctionRevertedError", "Execution reverted for an unknown reason."),
    );
    const { kind, message } = classifyExitError(reverted, NETWORK);
    expect(kind).toBe("reverted");
    expect(message).toBe(
      "Base Sepolia would not accept this transaction, so nothing in your position changed.",
    );
  });

  it("classifies a revert delivered as an RpcRequestError, whose name is also in the network set", () => {
    // This is the ordering test. `RpcRequestError` alone means network; the
    // "execution reverted" marker has to win.
    const rpcRevert = viemError("RpcRequestError", "execution reverted: insufficient collateral", {
      code: 3,
    });
    expect(classifyExitError(rpcRevert, NETWORK).kind).toBe("reverted");
  });

  it("classifies the flow's own post-receipt check, which throws a plain Error", () => {
    // ExitFlow and useExitApprovals both throw this shape after a
    // `status !== "success"` receipt.
    expect(classifyExitError(new Error("Exit transaction reverted on-chain"), NETWORK).kind).toBe(
      "reverted",
    );
    expect(
      classifyExitError(new Error("Approve USDC for debt repayment reverted on-chain"), NETWORK)
        .kind,
    ).toBe("reverted");
  });

  it("never puts a revert reason or a contract address in the message", () => {
    const { message } = classifyExitError(
      viemError(
        "ContractFunctionRevertedError",
        "execution reverted: ERC20: transfer amount exceeds balance (0x554530E0a5C428Bd7f617F875a3C5570803842E4)",
      ),
      NETWORK,
    );
    expect(message).not.toContain("ERC20");
    expect(message).not.toContain("0x");
  });
});

describe("classifyExitError - wallet rejection", () => {
  it("classifies EIP-1193 code 4001 as a dismissal, not a failure", () => {
    const rejected = viemError("UserRejectedRequestError", "User rejected the request.", undefined, {
      code: 4001,
    });
    const { kind, message } = classifyExitError(rejected, NETWORK);
    expect(kind).toBe("rejected");
    expect(message).toBe("You dismissed the request in your wallet, so nothing was signed.");
  });

  it("classifies a wallet that only sends the code, with no viem name", () => {
    expect(classifyExitError({ code: 4001, message: "denied" }, NETWORK).kind).toBe("rejected");
  });

  it("classifies a rejection wrapped by viem's write path", () => {
    const wrapped = viemError(
      "ContractFunctionExecutionError",
      "User rejected the request.",
      viemError("UserRejectedRequestError", "User denied transaction signature."),
    );
    expect(classifyExitError(wrapped, NETWORK).kind).toBe("rejected");
  });
});

describe("classifyExitError - fallbacks and robustness", () => {
  it("falls back to `unknown` rather than guessing", () => {
    const { kind, message } = classifyExitError(new Error("something odd happened"), NETWORK);
    expect(kind).toBe("unknown");
    expect(message).toBe("Something went wrong. Try again in a moment.");
  });

  it.each([undefined, null, 0, "", {}])("survives a thrown %p", (thrown) => {
    const failure = classifyExitError(thrown, NETWORK);
    expect(failure.kind).toBe("unknown");
    expect(failure.message).toBe("Something went wrong. Try again in a moment.");
  });

  it("does not hang on a cause chain that points back at itself", () => {
    const a = viemError("HttpRequestError", "HTTP request failed.");
    const b = viemError("CallExecutionError", "An error occurred.", a);
    (a as { cause?: unknown }).cause = b;
    expect(classifyExitError(b, NETWORK).kind).toBe("network");
  });

  it("caps `detail` so a multi-kilobyte request body cannot be logged whole", () => {
    const huge = viemError("HttpRequestError", `URL: https://sepolia.base.org ${"0".repeat(5000)}`);
    expect(classifyExitError(huge, NETWORK).detail.length).toBeLessThanOrEqual(500);
  });
});

/**
 * `ExitFlow.loadPosition` reads each Aave reserve inside a try/catch and asks
 * exactly one question of the result: was this the connection, or was it this
 * reserve? A `network` answer is rethrown so the whole load reports an outage; a
 * revert is recorded as an unreadable reserve and blocks execution with a
 * different sentence.
 *
 * These pin that fork, because getting it backwards is how a user gets told to
 * retry a read that cannot start working. The USDC case is live today: the
 * executor was deployed against Circle's Base Sepolia USDC
 * (0x036CbD53…), which the Aave V3 Base Sepolia market does not list, so
 * `getUserReserveData` reverts on it for every wallet.
 */
describe("classifyExitError - the fork ExitFlow branches on per reserve", () => {
  it("calls an unlisted-reserve revert a revert, so the reserve is skipped rather than retried", () => {
    const unlistedReserve = viemError(
      "ContractFunctionExecutionError",
      'The contract function "getUserReserveData" reverted.',
      viemError(
        "ContractFunctionRevertedError",
        'The contract function "getUserReserveData" reverted.',
        viemError("CallExecutionError", "Execution reverted for an unknown reason."),
      ),
    );
    expect(classifyExitError(unlistedReserve, NETWORK).kind).not.toBe("network");
    expect(classifyExitError(unlistedReserve, NETWORK).kind).toBe("reverted");
  });

  it("calls a transport failure on the very same read a network failure, so the load rethrows", () => {
    const transport = viemError(
      "ContractFunctionExecutionError",
      'The contract function "getUserReserveData" reverted.',
      RATE_LIMITED_HTTP_ERROR,
    );
    expect(classifyExitError(transport, NETWORK).kind).toBe("network");
  });
});

describe("exitFailureMessage", () => {
  const kinds: ExitFailureKind[] = ["network", "rejected", "reverted", "unknown"];

  it("names the chain the flow actually runs on", () => {
    expect(exitFailureMessage("network", "Base Sepolia")).toContain("Base Sepolia");
    expect(exitFailureMessage("network", "Base")).toContain("Base");
  });

  it("gives every kind a distinct sentence", () => {
    const messages = kinds.map((k) => exitFailureMessage(k, NETWORK));
    expect(new Set(messages).size).toBe(kinds.length);
  });

  it.each(kinds)("keeps %s free of jargon, punctuation and machine text", (kind) => {
    const message = exitFailureMessage(kind, NETWORK);
    // House style: no em dashes, and nothing a user cannot read out loud.
    expect(message).not.toContain("—");
    expect(message).not.toMatch(/0x|https?:\/\/|eth_call|aggregate3|RPC|JSON|\{|\}/);
    expect(message.endsWith(".")).toBe(true);
  });

  it("claims nothing about transaction state it cannot know", () => {
    // A transport error can follow a transaction that WAS broadcast (the
    // receipt wait is a network call too), so the network sentence must not
    // promise that nothing was sent. A revert is the one case where it can.
    expect(exitFailureMessage("network", NETWORK)).not.toMatch(/nothing was sent|not sent/i);
    expect(exitFailureMessage("reverted", NETWORK)).toContain("nothing in your position changed");
  });
});
