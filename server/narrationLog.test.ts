/**
 * The audit writer sits on the advice path, so the property that matters most
 * is the negative one: nothing it does may reach the caller. A rejected model
 * response is worth recording, never worth withholding advice over.
 */

import { describe, expect, it, vi } from "vitest";

import {
  logNarration,
  narrationLogRow,
  payloadHash,
  RAW_RESPONSE_MAX,
  type NarrationLogInput,
  type NarrationLogRow,
  type NarrationStore,
} from "./narrationLog";

const input = (over: Partial<NarrationLogInput> = {}): NarrationLogInput => ({
  wallet: "0xAbCdEf0000000000000000000000000000000001",
  model: "google/gemini-2.5-flash",
  raw: '{"position":"..."}',
  numericPass: true,
  hedgePass: true,
  served: "narrated",
  payload: "<<<PANIK_DATA>>>\n{}\n<<<END_PANIK_DATA>>>",
  ...over,
});

/** Collects rows; `fail` makes every insert reject. */
function store(fail = false): NarrationStore & { rows: NarrationLogRow[] } {
  const rows: NarrationLogRow[] = [];
  return {
    rows,
    insert: async (row) => {
      if (fail) throw new Error("PostgREST unreachable");
      rows.push(row);
    },
  };
}

describe("narrationLogRow", () => {
  it("lower-cases the wallet, matching every other wallet-keyed table", () => {
    expect(narrationLogRow(input()).wallet).toBe(
      "0xabcdef0000000000000000000000000000000001",
    );
  });

  it("hashes the prompt instead of storing it", () => {
    const row = narrationLogRow(input());
    expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.payloadHash).not.toContain("PANIK_DATA");
    expect(row).not.toHaveProperty("payload");
  });

  it("hashes deterministically, so repeats of one position group", () => {
    expect(payloadHash("abc")).toBe(payloadHash("abc"));
    expect(payloadHash("abc")).not.toBe(payloadHash("abd"));
  });

  it("truncates a runaway completion rather than storing it whole", () => {
    const row = narrationLogRow(input({ raw: "x".repeat(RAW_RESPONSE_MAX * 3) }));
    expect(row.rawResponse).toHaveLength(RAW_RESPONSE_MAX);
  });

  it("keeps a null completion null - there is a difference between empty and absent", () => {
    // Breaker open, hostile symbol and provider timeout all produce no text at
    // all, and "" would read as "the model returned nothing".
    expect(narrationLogRow(input({ raw: null })).rawResponse).toBeNull();
  });

  it("carries the rejection verdicts and what was actually served", () => {
    const row = narrationLogRow(
      input({ numericPass: false, hedgePass: true, served: "fallback" }),
    );
    expect(row.numericPass).toBe(false);
    expect(row.hedgePass).toBe(true);
    expect(row.served).toBe("fallback");
  });
});

describe("logNarration", () => {
  it("writes the row", async () => {
    const s = store();
    logNarration(s, input());
    await vi.waitFor(() => expect(s.rows).toHaveLength(1));
    expect(s.rows[0]!.model).toBe("google/gemini-2.5-flash");
  });

  it("swallows a failing insert and reports it out of band", async () => {
    const s = store(true);
    const errors: unknown[] = [];
    expect(() => logNarration(s, input(), (e) => errors.push(e))).not.toThrow();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toContain("PostgREST unreachable");
  });

  it("swallows a store that throws synchronously", async () => {
    const throwing: NarrationStore = {
      insert: () => {
        throw new Error("pool exhausted");
      },
    };
    const errors: unknown[] = [];
    expect(() => logNarration(throwing, input(), (e) => errors.push(e))).not.toThrow();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });

  it("needs no error handler to stay quiet", async () => {
    const s = store(true);
    expect(() => logNarration(s, input())).not.toThrow();
    // Nothing to await: the point is that the unhandled rejection never escapes.
    await Promise.resolve();
  });
});
