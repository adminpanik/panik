/**
 * Wallet-ownership proof — the auth boundary for every endpoint that mutates
 * state belonging to a wallet the caller merely CLAIMS to own (minting a
 * Telegram deep-link code, registering a wallet for monitoring).
 *
 * Without it, `isEvmAddress(body.wallet)` is the only check, so anyone can name
 * a victim's address: mint their link code, open the deep link in their own
 * Telegram, and take over the victim's liquidation alerts.
 *
 * The proof is a plain personal_sign over a deterministic message. ONE message
 * format for every endpoint on purpose: the browser signs once per session and
 * replays the same {signature, timestamp} for the whole onboarding flow instead
 * of prompting the user per call.
 *
 * Replay window: the timestamp must be within OWNERSHIP_MAX_AGE_MS. No
 * server-side nonce store — a stolen signature only buys what the wallet's real
 * owner could already do (link THEIR OWN wallet, register THEIR OWN wallet),
 * and the link codes it can mint carry their own 15-minute single-use TTL. A
 * nonce table would add shared state to a stateless surface for no threat we
 * can name; revisit if a proof ever authorizes a value transfer.
 *
 * Limitation: viem's `verifyMessage` recovers an EOA signer, so smart-contract
 * wallets (ERC-1271, e.g. Safe) cannot pass. Accepted — validating ERC-1271
 * needs an RPC round-trip per request on a path an attacker can spam. Those
 * users keep every read path; only self-service linking is unavailable.
 */

import { verifyMessage } from "viem";
import { isEvmAddress } from "./profileDeps";

/** How long a signed proof stays usable. Covers a whole onboarding sitting. */
export const OWNERSHIP_MAX_AGE_MS = 10 * 60 * 1000;

/** The exact string the wallet signs. Must match src/panik-core/lib/telegram.ts. */
export function ownershipMessage(wallet: string, timestamp: number): string {
  return `PANIK wallet ownership\nWallet: ${wallet.toLowerCase()}\nIssued: ${timestamp}`;
}

export type OwnershipCheck =
  | { ok: true; wallet: string }
  | { ok: false; status: number; error: string };

/**
 * Validate `{wallet, signature, timestamp}` off a request body. Returns the
 * normalized (lowercase) wallet, or the status + message the caller should
 * return verbatim — these describe the caller's own input, never our internals.
 */
export async function verifyWalletOwnership(body: unknown): Promise<OwnershipCheck> {
  const { wallet, signature, timestamp } = (body ?? {}) as {
    wallet?: unknown;
    signature?: unknown;
    timestamp?: unknown;
  };

  if (!isEvmAddress(wallet)) return { ok: false, status: 400, error: "invalid EVM wallet address" };
  const address = wallet.trim().toLowerCase();

  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, status: 401, error: "missing wallet ownership signature" };
  }
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) {
    return { ok: false, status: 401, error: "missing signature timestamp" };
  }
  // Symmetric window: a future timestamp is as bogus as an expired one (it
  // would otherwise mint a proof that stays valid past the intended lifetime).
  if (Math.abs(Date.now() - issuedAt) > OWNERSHIP_MAX_AGE_MS) {
    return { ok: false, status: 401, error: "signature expired — sign again" };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: ownershipMessage(address, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false; // malformed signature bytes
  }
  if (!valid) return { ok: false, status: 401, error: "signature does not match wallet" };

  return { ok: true, wallet: address };
}
