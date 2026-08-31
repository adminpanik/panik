/**
 * What an account can DO: redeem a voucher, and attach a wallet it can prove it
 * holds. The Express routes in scripts/api-server.ts are thin wrappers around
 * these two functions, so the decisions are unit-testable without booting a
 * server or reaching a database.
 *
 * ── REDEMPTION REUSES THE panik-try MACHINERY, VERBATIM ────────────────────
 * There is already a voucher system in this codebase: public.product_campaigns
 * (the printed PANIK-TRY-XXXXXXXX code on the business card), public.trial_grants
 * (one row per redeemer) and two SECURITY DEFINER functions that do the hard
 * parts atomically — `redeem_campaign_code` (usage limit, claim window, kill
 * switch, attempt log, mint) and `open_trial` (start the per-user clock).
 * server/campaignStore.ts is the client. See
 * supabase/migrations/20260704000001_product_codes.sql.
 *
 * A second voucher scheme would have to re-solve every one of those, and would
 * get the concurrency wrong: the "only one caller takes the last slot" guarantee
 * lives in a guarded UPDATE inside that function and nowhere else. So this
 * module does NOT validate codes. It calls redeem_campaign_code, and the only
 * thing it adds is what the panik-try flow had no concept of — an account:
 *
 *   redeem_campaign_code(code, ip, ua, email)  ->  a per-user trial token
 *   open_trial(token, ip, ua)                  ->  the clock starts, expiry known
 *   insert into memberships                    ->  the account is in the beta
 *
 * The account's OWN verified email is what gets captured on the grant, not a
 * form field. The /try flow had to ask for one and hope; here the address is
 * already established by Supabase Auth, so the campaign roster gains a real
 * identity instead of a typed-in string.
 *
 * A per-user trial token (PANIK-XXXXXX, the thing in /app?trial=...) is
 * DELIBERATELY NOT ACCEPTED here. `open_trial` is not single-use — it starts a
 * clock and can be called repeatedly — so honouring one would let a single
 * token, which is a bearer credential pasted into a URL, mint a membership on
 * every account it was forwarded to. Campaign codes are the voucher: they are
 * slot-limited and their consumption is atomic. Accepting existing trial links
 * is deferred and needs its own single-use burn.
 */

import type { CampaignStore } from "./campaignStore";
import { AccountConflict, type AccountStore, type AccountWallet, type Membership } from "./accountStore";
import { verifyWalletOwnership } from "./walletAuth";
import type { NonceStore } from "./nonceStore";

/**
 * Everything that takes up no room on the printed card: ordinary spaces and
 * tabs, the non-breaking space a paste out of a PDF carries, and the zero-width
 * and bidi-format characters a messaging app or a justified block of text can
 * leave behind. All of it is DELETED, internally as well as at the ends, because
 * "PANIK-TRY- 45QUHHUP" is the same card as the one without the space and a
 * reader retyping a printed string should not have to know that.
 *
 * THE SOFT HYPHEN IS DELETED, NOT FOLDED, and it belongs here rather than with
 * the dashes below. It renders as nothing, so it never arrives INSTEAD of a
 * hyphen the reader can see; it arrives BESIDE one, out of justified or
 * hyphenated text. Folding it to a hyphen turned PANIK-<SHY>TRY-45QUHHUP into
 * PANIK--TRY-45QUHHUP, which fails CAMPAIGN_CODE_RE exactly as the en dash did:
 * one invisible character traded for another, and the same unactionable refusal.
 */
const VOUCHER_BLANKS = /[\s\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/**
 * Every dash a keyboard can produce where a person meant a hyphen: the Unicode
 * hyphens and dashes U+2010 to U+2015 (which includes the en dash and the em
 * dash), the mathematical minus, and the small/fullwidth forms a CJK keyboard
 * emits. Every one of them is VISIBLE, which is the whole of what separates this
 * set from the blanks above: a visible dash is standing where a hyphen was meant,
 * so it is replaced. An invisible character stands nowhere, so it is deleted.
 *
 * THIS IS THE INCIDENT. On 2026-08-31 a tester retyped PANIK-TRY-45QUHHUP on an
 * iPhone and was told the code was not recognised, with no attempt logged
 * anywhere: iOS smart punctuation had turned the two hyphens into en dashes, so
 * the string failed CAMPAIGN_CODE_RE below before any database call could record
 * it. The characters were visually identical on screen, which is exactly why the
 * user had nothing to correct.
 */
const VOUCHER_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

/**
 * The one shape a voucher code is compared in.
 *
 * TWIN: `normalizeVoucherCode` in `src/panik-core/lib/account.ts` is a
 * character-for-character copy and must stay one. This module cannot import that
 * one: lib/account.ts pulls in lib/goTrue.ts, which reads `import.meta.env` at
 * module scope, and this side runs under plain Node where that is undefined and
 * the import throws on load. `server/accounts.test.ts` imports both and asserts
 * they agree on every case, so the copies cannot drift silently.
 *
 * Applied here as well as in the browser because the browser is not a trust
 * boundary and, more prosaically, because a phone holding yesterday's bundle is
 * the exact case this fix exists for.
 */
export function normalizeVoucherCode(raw: string): string {
  return raw.replace(VOUCHER_BLANKS, "").replace(VOUCHER_DASHES, "-").toUpperCase();
}

/** The printed campaign code. Mirrors the CHECK on product_campaigns.campaign_code. */
const CAMPAIGN_CODE_RE = /^PANIK-TRY-[2-9A-HJ-NP-Z]{4,8}$/;

/** The per-user trial token. Matched only so we can refuse it by name. */
const TRIAL_TOKEN_RE = /^PANIK-[2-9A-HJ-NP-Z]{6}$/;

export type VoucherOutcome =
  | "success"
  | "already_member"
  | "invalid"
  | "expired"
  | "exhausted"
  | "trial_link";

export interface VoucherResult {
  outcome: VoucherOutcome;
  /** Only on success (or already_member) — the grant the account now holds. */
  membership?: Membership;
}

/**
 * What the caller is told for each refusal. Defined next to the outcomes so a
 * new one cannot be added without deciding what it says, and phrased as the
 * next thing to do rather than as a state — "this code has been used up" is
 * actionable in a way that "exhausted" is not.
 */
export const VOUCHER_REFUSALS: Record<Exclude<VoucherOutcome, "success" | "already_member">, string> = {
  invalid: "that code was not recognised",
  expired: "that code is past its claim window",
  exhausted: "that code has already been used its full number of times",
  trial_link:
    "that is a trial link, not a voucher code - use the code printed on the card",
};

export interface VoucherDeps {
  store: AccountStore;
  campaigns: CampaignStore;
  ip?: string | null;
  userAgent?: string | null;
}

export interface VoucherInput {
  userId: string;
  /** The account's verified address, from Supabase Auth. Never a body field. */
  email: string;
  code: unknown;
}

/**
 * Redeem a voucher for a signed-in account.
 *
 * Order matters. The membership check comes FIRST so a double submit does not
 * burn a second campaign slot on someone who is already in, and the insert
 * still tolerates a 409 because two requests can pass that check concurrently
 * — the partial unique index in the migration is the real arbiter.
 *
 * That check is a shortcut, NOT the guard. Two requests racing arrive here with
 * no membership either side of them, and until 2026-08-31 both went on to spend
 * a campaign slot: one account took two of PANIK-TRY-45QUHHUP's in sixteen
 * seconds. `redeem_campaign_code` is now idempotent per (campaign, email) -
 * supabase/migrations/20260831000001_idempotent_campaign_redeem.sql - so a
 * second call for an address that already holds a grant hands back THAT grant's
 * token without minting a row or incrementing the count. The email below is the
 * account's own verified address, which is what makes that key trustworthy
 * here: it is not a field the caller chose.
 */
export async function redeemVoucher(
  deps: VoucherDeps,
  input: VoucherInput,
): Promise<VoucherResult> {
  const code = normalizeVoucherCode(String(input.code ?? ""));
  if (TRIAL_TOKEN_RE.test(code)) return { outcome: "trial_link" };
  if (!CAMPAIGN_CODE_RE.test(code)) return { outcome: "invalid" };

  const existing = await deps.store.liveMembership(input.userId);
  if (existing) return { outcome: "already_member", membership: existing };

  const redeemed = await deps.campaigns.redeem(code, input.email, deps.ip, deps.userAgent);
  if (redeemed.outcome !== "success" || !redeemed.token) {
    // `not_found` and `disabled` collapse to "invalid" on purpose: telling a
    // stranger that a code exists but was switched off is a hint they can use
    // to enumerate the print run. `expired` and `exhausted` describe a code the
    // caller demonstrably has, so those stay distinct — the user needs to know
    // whether to wait, or to ask for a different card.
    if (redeemed.outcome === "expired") return { outcome: "expired" };
    if (redeemed.outcome === "exhausted") return { outcome: "exhausted" };
    return { outcome: "invalid" };
  }

  // Redeeming ON an account IS the first open, so start the clock now rather
  // than leaving a grant whose expiry is null until the user follows a link
  // they will never see. A failure here costs the expiry, not the membership:
  // the slot is already spent and refusing would leave the user with neither.
  let expiresAt: string | null = null;
  try {
    const opened = await deps.campaigns.openTrial(redeemed.token, deps.ip, deps.userAgent);
    expiresAt = opened.expiresAt ?? null;
  } catch (err) {
    console.error(`voucher clock start failed for ${input.userId}: ${(err as Error).message}`);
  }

  try {
    const membership = await deps.store.createMembership({
      userId: input.userId,
      status: "trial",
      source: "voucher",
      voucherCode: code,
      expiresAt,
    });
    return { outcome: "success", membership };
  } catch (err) {
    if (err instanceof AccountConflict && err.kind === "membership-exists") {
      // Lost a race with the account's own other tab. It is a member either
      // way, and saying so is more truthful than a 409 the user cannot act on.
      const live = await deps.store.liveMembership(input.userId);
      return live ? { outcome: "already_member", membership: live } : { outcome: "invalid" };
    }
    throw err;
  }
}

// ── wallet linking ──────────────────────────────────────────────────────────

export type LinkOutcome = "linked" | "bad_proof" | "wallet_taken";

export interface LinkResult {
  outcome: LinkOutcome;
  wallet?: AccountWallet;
  /** Verbatim response for the caller when the proof was refused. */
  status?: number;
  error?: string;
}

export interface LinkDeps {
  store: AccountStore;
  /** Injectable for tests; production resolves it from env inside walletAuth. */
  nonces?: NonceStore;
}

/**
 * Attach a wallet to an account. BOTH credentials are required and they answer
 * different questions:
 *
 *   the account bearer  WHO is asking          (checked upstream by
 *                                               requireAccount + requireMember;
 *                                               `userId` here is its output,
 *                                               never a body field)
 *   the SIWE signature  WHAT they can prove    (checked here, single-use nonce,
 *                                               bound to account-wallet-link)
 *
 * Dropping either one is a whole account takeover in a different direction:
 * without the signature anyone signed in could claim a stranger's address and
 * inherit its data in PR 4; without the bearer, a signature harvested from any
 * other PANIK flow would attach the victim's wallet to the attacker's account.
 * That is why the action URN is its own — a proof minted for "register this
 * wallet for monitoring" must not be spendable here.
 */
export async function linkAccountWallet(
  deps: LinkDeps,
  userId: string,
  body: unknown,
): Promise<LinkResult> {
  const proof = await verifyWalletOwnership(body, "account-wallet-link", deps.nonces);
  if (!proof.ok) {
    return { outcome: "bad_proof", status: proof.status, error: proof.error };
  }
  try {
    return { outcome: "linked", wallet: await deps.store.linkWallet(userId, proof.wallet) };
  } catch (err) {
    if (err instanceof AccountConflict && err.kind === "wallet-taken") {
      return {
        outcome: "wallet_taken",
        status: 409,
        // Says nothing about WHICH account. A prober who owns a key could
        // otherwise use this endpoint to learn that an address is already a
        // PANIK user, which is exactly the fact the roster is gated to protect.
        error: "that wallet is already linked to a PANIK account",
      };
    }
    throw err;
  }
}
