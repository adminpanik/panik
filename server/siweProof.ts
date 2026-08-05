/**
 * The ONE builder for the SIWE (EIP-4361) message PANIK asks a wallet to sign.
 *
 * BROWSER-SAFE ON PURPOSE. It imports nothing but `viem/siwe`, so the frontend
 * (src/panik-core/lib/telegram.ts) and the verifier (server/walletAuth.ts) call
 * the SAME function. The previous design duplicated a hand-built string on both
 * sides — one edit away from a silent byte drift that 401s every user.
 *
 * Two properties the old "PANIK wallet ownership / Wallet / Issued" format
 * lacked, both of which were exploitable:
 *
 *  1. DOMAIN BINDING. `domain` + `uri` name the site the user is signing in to,
 *     and the server checks them against an allowlist. Without it, any page (a
 *     fake airdrop checker, a malicious extension, a compromised dApp dep)
 *     could prompt personal_sign over our exact string offline and POST the
 *     result to us; the victim never had to visit PANIK at all.
 *
 *  2. ACTION BINDING. Every endpoint used to accept one generic proof, so the
 *     signature a user produced to "register my wallet" was equally a bearer
 *     token for redirecting their liquidation alerts to a stranger's Telegram.
 *     The action now rides in `Resources:` (machine-checked) AND in the
 *     statement (what the user actually reads in the wallet popup), and each
 *     endpoint accepts only its own.
 *
 * Note the message carries NO expiry. Lifetime belongs to the server-issued
 * nonce (see server/nonceStore.ts) — that keeps the client's OS clock out of
 * the protocol entirely, so a user whose clock is skewed is not locked out.
 */

import { createSiweMessage } from "viem/siwe";

/** Base mainnet. The only chain PANIK monitors, so the only one a proof may name. */
export const SIWE_CHAIN_ID = 8453;

/** Every wallet-scoped write, and the proof each one demands. */
export const OWNERSHIP_ACTIONS = ["wallet-register", "telegram-link"] as const;
export type OwnershipAction = (typeof OWNERSHIP_ACTIONS)[number];

/** The `Resources:` URN the server matches exactly. */
export function actionResource(action: OwnershipAction): string {
  return `urn:panik:action:${action}`;
}

/**
 * What the user reads in the wallet popup. Must describe the ACTUAL power the
 * signature grants — "register my wallet" hiding an alert-redirect is exactly
 * the consent failure this whole change exists to fix.
 */
export const ACTION_STATEMENT: Record<OwnershipAction, string> = {
  "wallet-register": "Register this wallet for PANIK liquidation monitoring.",
  "telegram-link": "Link this wallet to a Telegram account so PANIK can send it liquidation alerts.",
};

export interface OwnershipMessageParams {
  /** Signer address. Rendered EIP-55 checksummed by createSiweMessage. */
  address: string;
  /** RFC 3986 authority, e.g. "panik.fi" or "localhost:3000". */
  domain: string;
  /** Full origin the user is on, e.g. "https://panik.fi". */
  uri: string;
  /** Server-issued, single-use (GET /api/auth/nonce). */
  nonce: string;
  action: OwnershipAction;
  /** Informational only — never validated against a clock. Defaults to now. */
  issuedAt?: Date;
}

/** Build the exact string the wallet signs. Throws on a malformed field. */
export function buildOwnershipMessage(p: OwnershipMessageParams): string {
  return createSiweMessage({
    address: p.address as `0x${string}`,
    chainId: SIWE_CHAIN_ID,
    domain: p.domain,
    nonce: p.nonce,
    uri: p.uri,
    version: "1",
    statement: ACTION_STATEMENT[p.action],
    resources: [actionResource(p.action)],
    issuedAt: p.issuedAt ?? new Date(),
  });
}
