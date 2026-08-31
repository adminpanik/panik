/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The parts of the account layer that are pure: the implicit-grant return leg,
 * the body reader, and the one sentence that describes a grant. Everything else
 * in lib/account.ts is a fetch or a hook and is exercised in the browser.
 */

import { describe, expect, it } from "vitest";
import {
  asAccount,
  membershipLedger,
  normalizeVoucherCode,
  gateScreen,
  readAuthHash,
  type Account,
  type AccountState,
} from "./account";

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

describe("readAuthHash", () => {
  it("ignores a fragment that says nothing about auth", () => {
    expect(readAuthHash("")).toBeNull();
    expect(readAuthHash("#")).toBeNull();
    expect(readAuthHash("#section-two")).toBeNull();
  });

  it("reads a magic-link return", () => {
    const result = readAuthHash(
      "#access_token=abc&refresh_token=def&expires_in=3600&token_type=bearer&type=magiclink",
      NOW,
    );
    expect(result).toEqual({
      session: { accessToken: "abc", refreshToken: "def", expiresAt: NOW + 3_600_000 },
      error: null,
    });
  });

  it("works without the leading hash, so a caller may pass either", () => {
    expect(readAuthHash("access_token=a&refresh_token=b&expires_in=60", NOW)?.session).toEqual({
      accessToken: "a",
      refreshToken: "b",
      expiresAt: NOW + 60_000,
    });
  });

  it("prefers the duration over the absolute expiry, so a skewed clock cannot shorten a session", () => {
    // `expires_at` here claims the token lapsed an hour ago; `expires_in` says
    // it has an hour left. The duration is the one that does not depend on this
    // browser's clock agreeing with the server's.
    const result = readAuthHash(
      `#access_token=a&refresh_token=b&expires_in=3600&expires_at=${Math.floor(NOW / 1000) - 3600}`,
      NOW,
    );
    expect(result?.session?.expiresAt).toBe(NOW + 3_600_000);
  });

  it("falls back to the absolute expiry, then to an hour", () => {
    const absolute = readAuthHash(
      `#access_token=a&refresh_token=b&expires_at=${Math.floor(NOW / 1000) + 120}`,
      NOW,
    );
    expect(absolute?.session?.expiresAt).toBe(NOW + 120_000);

    const neither = readAuthHash("#access_token=a&refresh_token=b", NOW);
    expect(neither?.session?.expiresAt).toBe(NOW + 3_600_000);
  });

  it("refuses a half-formed grant rather than storing an unusable session", () => {
    expect(readAuthHash("#access_token=a&expires_in=3600", NOW)).toBeNull();
    expect(readAuthHash("#refresh_token=b&expires_in=3600", NOW)).toBeNull();
  });

  it("turns an expired link into a sentence, with no session", () => {
    const result = readAuthHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      NOW,
    );
    expect(result?.session).toBeNull();
    expect(result?.error).toBe("Email link is invalid or has expired.");
  });

  it("falls back to its own sentence when the provider sends only a code", () => {
    const result = readAuthHash("#error=server_error", NOW);
    expect(result?.session).toBeNull();
    expect(result?.error).toBe("That sign-in link did not work. Ask for a new one and try again.");
  });
});

describe("asAccount", () => {
  const body = {
    account: { userId: "u-1", email: "reader@example.com" },
    member: true,
    membership: {
      id: "m-1",
      status: "trial",
      source: "voucher",
      voucherCode: "PANIK-TRY-BETA",
      startedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
    },
    wallets: [],
  };

  it("reads a full body", () => {
    const account = asAccount(body);
    expect(account?.email).toBe("reader@example.com");
    expect(account?.member).toBe(true);
    expect(account?.membership?.status).toBe("trial");
  });

  it("refuses a body with no member verdict rather than reading it as false", () => {
    // A missing flag means the server did not answer the question the whole
    // gate turns on. Defaulting it either way invents the answer.
    expect(asAccount({ ...body, member: undefined })).toBeNull();
    expect(asAccount({ ...body, member: "true" })).toBeNull();
  });

  it("refuses a body with no identity", () => {
    expect(asAccount({ ...body, account: { userId: "", email: "a@b.c" } })).toBeNull();
    expect(asAccount({ ...body, account: { userId: "u-1", email: "" } })).toBeNull();
    expect(asAccount(null)).toBeNull();
  });

  it("reads a signed-in account that has no membership", () => {
    const account = asAccount({ ...body, member: false, membership: null });
    expect(account?.member).toBe(false);
    expect(account?.membership).toBeNull();
  });

  it("drops a membership whose status is not one the server issues", () => {
    expect(asAccount({ ...body, membership: { ...body.membership, status: "vip" } })?.membership)
      .toBeNull();
  });
});

describe("membershipLedger", () => {
  const base: Account = {
    userId: "u-1",
    email: "reader@example.com",
    member: true,
    membership: {
      id: "m-1",
      status: "trial",
      source: "voucher",
      voucherCode: null,
      startedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
    },
    wallets: [],
  };

  it("names the kind of grant and puts its end date in the value", () => {
    expect(membershipLedger(base)).toEqual({ label: "Beta trial ends", value: "Sep 1, 2026" });
    expect(membershipLedger({ ...base, membership: { ...base.membership!, status: "active" } }))
      .toEqual({ label: "Beta access ends", value: "Sep 1, 2026" });
  });

  it("states no date when the grant has no expiry", () => {
    const forever = { ...base, membership: { ...base.membership!, expiresAt: null } };
    expect(membershipLedger(forever)).toEqual({ label: "Beta access", value: "Trial" });
  });

  it("states no date when the expiry cannot be read, rather than inventing one", () => {
    const broken = { ...base, membership: { ...base.membership!, expiresAt: "not-a-date" } };
    expect(membershipLedger(broken)).toEqual({ label: "Beta access", value: "Trial" });
  });

  it("never describes access the server did not grant", () => {
    expect(membershipLedger({ ...base, member: false })).toEqual({
      label: "Beta access",
      value: "None",
    });
    expect(membershipLedger({ ...base, membership: null })).toEqual({
      label: "Beta access",
      value: "None",
    });
  });
});

describe("gateScreen", () => {
  const account: Account = {
    userId: "u-1",
    email: "reader@example.com",
    member: true,
    membership: null,
    wallets: [],
  };

  /** Only the five fields the predicate reads ever differ; the rest are inert. */
  const state = (over: Partial<AccountState>): AccountState => ({
    status: "resolved",
    configured: true,
    session: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    account: null,
    error: null,
    busy: false,
    pendingVoucher: null,
    sendLink: async () => ({ ok: true, error: null }),
    startGoogle: () => {},
    redeem: async () => ({ ok: true, error: null }),
    signOut: async () => {},
    reload: async () => {},
    ...over,
  });

  it("gates while the answer has not arrived, whatever else is set", () => {
    // The one that must never fall through: rendering the dashboard and then
    // replacing it with a sign-in page tells someone they are in and then that
    // they are not.
    expect(gateScreen(state({ status: "checking" }))).toBe("checking");
    expect(gateScreen(state({ status: "checking", account }))).toBe("checking");
  });

  it("asks a visitor with no session to sign in", () => {
    expect(gateScreen(state({ session: null }))).toBe("signin");
  });

  it("admits it could not find out rather than asking for a code", () => {
    // The branch this shape exists for: a 502 from the account service must not
    // render as "enter your invite code" at a member who already has one.
    expect(gateScreen(state({ account: null, error: "PANIK could not check your account." })))
      .toBe("unavailable");
  });

  it("asks for the invite code when the server says this account is not a member", () => {
    expect(gateScreen(state({ account: { ...account, member: false } }))).toBe("voucher");
  });

  it("stands aside for a member", () => {
    expect(gateScreen(state({ account }))).toBeNull();
  });

  it("is unmoved by a busy flag or a configured deployment", () => {
    // Neither is evidence about who is signed in, and both were in scope for a
    // predicate that read the whole state object.
    expect(gateScreen(state({ account, busy: true }))).toBeNull();
    expect(gateScreen(state({ account, configured: false }))).toBeNull();
    expect(gateScreen(state({ session: null, configured: false }))).toBe("signin");
  });
});

describe("normalizeVoucherCode", () => {
  /**
   * The 2026-08-31 refusal, character for character. iOS smart punctuation had
   * turned both hyphens of PANIK-TRY-45QUHHUP into en dashes on the way into
   * the field. At 14px the two are the same glyph, so the reader was told the
   * code was not recognised and had nothing on screen to correct.
   */
  it("undoes the iOS smart-punctuation rewrite", () => {
    expect(normalizeVoucherCode("PANIK\u2013TRY\u201345QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
  });

  it("folds every other dash a keyboard can produce", () => {
    const dashes = [
      "\u2010", // hyphen
      "\u2011", // non-breaking hyphen
      "\u2012", // figure dash
      "\u2013", // en dash
      "\u2014", // em dash
      "\u2015", // horizontal bar
      "\u2212", // minus sign
      "\uFE58", // small em dash
      "\uFE63", // small hyphen-minus
      "\uFF0D", // fullwidth hyphen-minus
    ];
    for (const dash of dashes) {
      expect(normalizeVoucherCode(`PANIK${dash}TRY${dash}45QUHHUP`)).toBe("PANIK-TRY-45QUHHUP");
    }
  });

  it("deletes a soft hyphen instead of folding it, even beside a real one", () => {
    // It renders as nothing, so it never arrives INSTEAD of a hyphen the reader
    // can see; it arrives beside one, out of hyphenated or justified text.
    // Folding it to a hyphen made PANIK--TRY-45QUHHUP, which fails the regex
    // exactly as the en dash did: one invisible character traded for another.
    expect(normalizeVoucherCode("PANIK-\u00ADTRY-45QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
    expect(normalizeVoucherCode("PANIK\u00AD-TRY\u00AD-45QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
    expect(normalizeVoucherCode("PANIK-TRY-45QU\u00ADHHUP")).toBe("PANIK-TRY-45QUHHUP");
  });

  it("deletes every other character that renders as nothing", () => {
    // Zero-width and bidi-format marks, all of which a paste can carry in and
    // none of which the reader can see to remove.
    const invisible = ["\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\u2060", "\uFEFF"];
    for (const ch of invisible) {
      expect(normalizeVoucherCode(`PANIK-${ch}TRY-45QU${ch}HHUP`)).toBe("PANIK-TRY-45QUHHUP");
    }
  });

  it("removes whitespace inside the code, not only at the ends", () => {
    // A reader copying a printed string in groups is not making a mistake, and
    // a paste out of a PDF brings a non-breaking space with it.
    expect(normalizeVoucherCode("  PANIK-TRY- 45QU HHUP\u000A")).toBe("PANIK-TRY-45QUHHUP");
    expect(normalizeVoucherCode("PANIK-TRY-\u00A045QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
    expect(normalizeVoucherCode("PANIK-TRY-45\u200BQUHHUP")).toBe("PANIK-TRY-45QUHHUP");
  });

  it("uppercases, because the card is printed in upper case and the SQL compares it there", () => {
    expect(normalizeVoucherCode("panik-try-45quhhup")).toBe("PANIK-TRY-45QUHHUP");
  });

  it("leaves a code that is wrong rather than merely mistyped exactly as wrong", () => {
    // This changes the SHAPE of a string, never its content. Nothing here can
    // turn a code the reader does not hold into one they do.
    expect(normalizeVoucherCode("hunter1")).toBe("HUNTER1");
    expect(normalizeVoucherCode("PANIK\u2013TRY\u2013HUNTER1")).toBe("PANIK-TRY-HUNTER1");
  });

  it("is a no-op on a code that was already clean", () => {
    expect(normalizeVoucherCode("PANIK-TRY-45QUHHUP")).toBe("PANIK-TRY-45QUHHUP");
  });
});
