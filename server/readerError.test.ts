/**
 * The two things this helper exists for: the cause must survive, and the key
 * must not. Both were regressions waiting to happen in a plain `.slice()`.
 */

import { describe, expect, it } from "vitest";

import { describeReaderError } from "./readerError";

/** A real viem transport error, shape-for-shape, from the 2026-08-14 outage. */
const VIEM_429 = new Error(
  [
    "RPC Request failed.",
    "",
    "URL: https://base-mainnet.g.alchemy.com/v2/WXTpVUk-glL2l_eVMf2Fs",
    `Request body: {"method":"eth_call","params":[{"data":"0x${"ab".repeat(400)}"}]}`,
    "",
    "Details: Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade.",
    "Version: viem@2.21.0",
  ].join("\n"),
);

describe("describeReaderError", () => {
  it("keeps the line that names the cause", () => {
    expect(describeReaderError(VIEM_429)).toContain("Monthly capacity limit exceeded");
  });

  it("never writes the API key to the log", () => {
    const out = describeReaderError(VIEM_429);
    expect(out).not.toContain("WXTpVUk-glL2l_eVMf2Fs");
    expect(out).toContain("<redacted>");
    // The host is the diagnosis and must survive the redaction.
    expect(out).toContain("base-mainnet.g.alchemy.com");
  });

  it("drops the calldata that used to consume the whole budget", () => {
    const out = describeReaderError(VIEM_429);
    expect(out).not.toContain("Request body");
    expect(out).not.toContain("abababab");
  });

  it("collapses to a single line", () => {
    expect(describeReaderError(VIEM_429)).not.toContain("\n");
  });

  it("truncates without letting the cause fall off the end", () => {
    // The old 120-char slice stopped inside the URL. This is the regression.
    const out = describeReaderError(VIEM_429, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("Monthly capacity");
  });

  it("redacts a key passed as a query parameter, not just a path", () => {
    const out = describeReaderError(new Error("boom https://rpc.example.com/?apikey=SECRET123"));
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("rpc.example.com");
  });

  it("leaves a bare origin alone", () => {
    expect(describeReaderError(new Error("down: https://mainnet.base.org"))).toContain(
      "https://mainnet.base.org",
    );
  });

  it("handles a non-Error throw", () => {
    expect(describeReaderError("plain string")).toBe("plain string");
  });

  /**
   * The regression the unit fixture above missed and a live run caught: on a
   * contract error viem spends the budget under `Raw Call Arguments:` instead of
   * `Request body:`, so filtering by label left the blob in and truncation ate
   * the cause. Payloads are dropped by shape now, whatever the heading.
   */
  it("drops calldata under any heading, not just the ones seen so far", () => {
    const err = new Error(
      [
        "RPC Request failed.",
        "URL: https://base-mainnet.g.alchemy.com/v2/WXTpVUk-glL2l_eVMf2Fs",
        "Raw Call Arguments:",
        "  to:    0xca11bde05977b3631167028862be2a173976ca11",
        `  data:  0x82ad56cb${"00".repeat(300)}`,
        "Contract Call:",
        "  function:  getAssetsIn(address account)",
        "Details: Monthly capacity limit exceeded.",
      ].join("\n"),
    );
    const out = describeReaderError(err);
    expect(out).toContain("Monthly capacity limit exceeded");
    expect(out).not.toContain("82ad56cb");
    // The short `to:` address is not a payload and stays readable.
    expect(out).toContain("0xca11bde05977b3631167028862be2a173976ca11");
    expect(out).toContain("getAssetsIn");
  });

  /**
   * The second thing the live run caught. Payload filtering alone still lost
   * the cause, because viem's middle section varies in length and pushed
   * `Details:` past the limit. The cause is hoisted, so it survives a prefix of
   * any size.
   */
  it("keeps the cause even when the middle of the error is long", () => {
    const err = new Error(
      [
        "RPC Request failed.",
        "URL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY",
        "Contract Call:",
        `  function:  ${"aggregate3((address target, bool allowFailure, bytes callData)[])".repeat(4)}`,
        "Docs: https://viem.sh/docs/contract/readContract",
        "Details: Monthly capacity limit exceeded.",
      ].join("\n"),
    );
    const out = describeReaderError(err, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("Monthly capacity limit exceeded");
    expect(out).not.toContain("SECRETKEY");
    expect(out).not.toContain("viem.sh");
  });
});
