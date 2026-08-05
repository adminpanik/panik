/**
 * Wallet-ownership proof — the auth boundary for every endpoint that mutates
 * state belonging to a wallet the caller merely CLAIMS to own (minting a
 * Telegram deep-link code, registering a wallet for monitoring).
 *
 * Without it, `isEvmAddress(body.wallet)` is the only check, so anyone can name
 * a victim's address: mint their link code, open the deep link in their own
 * Telegram, and take over the victim's liquidation alerts.
 *
 * The proof is SIWE (EIP-4361), personal_sign'd, over a message this server
 * partly dictates. Three things make it a credential rather than a bearer
 * token anyone can mint or reuse:
 *
 *   NONCE   — server-issued (GET /api/auth/nonce), consumed ATOMICALLY here.
 *             A signature is accepted exactly once, ever. The previous design
 *             was stateless and replayable, which was fatal rather than
 *             theoretical: POST /api/telegram/link RETURNS the freshly minted
 *             deep-link code to whoever presented the proof, so replaying a
 *             victim's proof handed the replayer a brand-new code for the
 *             victim's wallet — the original account hijack, verbatim. The
 *             code's own 15-minute single-use TTL bought nothing, because the
 *             attacker was minting a NEW code, not reusing an old one.
 *
 *   DOMAIN  — checked against SIWE_ALLOWED_DOMAINS. Without it the message
 *             contained no server-issued value at all, so an attacker did not
 *             even need to intercept a proof: any page could prompt
 *             personal_sign over our exact string and POST the result here.
 *
 *   ACTION  — each endpoint accepts only its own `Resources:` URN. One generic
 *             message meant every user who completed onboarding produced a
 *             signature that doubled as authorization to redirect their
 *             liquidation alerts, having consented only to "register my wallet".
 *
 * The client's clock is NOT part of the protocol (no timestamp, no expiry field
 * we enforce): lifetime is the nonce row's TTL. A skewed OS clock therefore
 * cannot lock a user out — the old symmetric ±10min window both did that AND
 * accepted future-dated proofs, doubling the replay window it claimed to close.
 *
 * Limitation: viem's `verifyMessage` recovers an EOA signer, so smart-contract
 * wallets (ERC-1271/6492, e.g. Safe) cannot pass. Accepted, and the reason we
 * do not use viem's `verifySiweMessage` action: it needs a client and an RPC
 * round-trip per request on a path an attacker can spam. `parseSiweMessage` +
 * `validateSiweMessage` + `verifyMessage` is the same EIP-4361 check without
 * the network hop. Those users keep every read path; only self-service linking
 * is unavailable.
 */

import { verifyMessage } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { isEvmAddress } from "./profileDeps";
import { SupabaseNonceStore, type NonceStore } from "./nonceStore";
import {
  actionResource,
  buildOwnershipMessage,
  SIWE_CHAIN_ID,
  type OwnershipAction,
} from "./siweProof";

export { SIWE_CHAIN_ID, type OwnershipAction };

/** Dev fallback so `npm run dev` works with no extra env. Never used in prod. */
const DEV_DOMAINS = ["localhost:3000", "localhost:5173", "127.0.0.1:3000", "127.0.0.1:5173"];

/**
 * Origins allowed to collect a proof, from SIWE_ALLOWED_DOMAINS (comma-
 * separated RFC 3986 authorities, e.g. "panik.fi,www.panik.fi").
 *
 * In production an unset value yields an EMPTY list, which denies everything.
 * A missing allowlist must never silently widen to "any domain" — that is the
 * exact hole the domain binding exists to close (mirrors the CORS_ORIGINS
 * refuse-to-boot rule in scripts/api-server.ts).
 */
export function siweAllowedDomains(): string[] {
  const raw = process.env.SIWE_ALLOWED_DOMAINS;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return process.env.NODE_ENV === "production" ? [] : [...DEV_DOMAINS];
}

/**
 * Flat (not a discriminated union) because the project compiles without
 * `strict`, where narrowing on an `ok: true | false` discriminant does not fire.
 */
export interface OwnershipCheck {
  ok: boolean;
  /** Normalized (lowercase) wallet. Only meaningful when ok. */
  wallet: string;
  /** Status + message to return verbatim when !ok. */
  status: number;
  error: string;
}

const deny = (status: number, error: string): OwnershipCheck => ({ ok: false, wallet: "", status, error });

/** Same host+port comparison the SIWE `domain` field uses. */
function uriMatchesDomain(uri: string, domain: string): boolean {
  try {
    return new URL(uri).host.toLowerCase() === domain.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Validate `{message, signature}` off a request body against `action`. Returns
 * the normalized (lowercase) wallet, or the status + message the caller should
 * return verbatim — these describe the caller's own input, never our internals.
 *
 * `store` is injectable for tests; production resolves it from env.
 */
export async function verifyWalletOwnership(
  body: unknown,
  action: OwnershipAction,
  store?: NonceStore,
): Promise<OwnershipCheck> {
  const { message, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };

  if (typeof message !== "string" || message.length === 0 || message.length > 4000) {
    return deny(401, "missing wallet ownership proof — sign in again");
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return deny(401, "missing wallet ownership signature");
  }

  const allowed = siweAllowedDomains();
  if (allowed.length === 0) {
    // Production with no allowlist: refuse rather than accept any domain.
    return deny(503, "sign-in unconfigured (SIWE_ALLOWED_DOMAINS)");
  }

  // parseSiweMessage never throws; a non-SIWE string just yields empty fields.
  const parsed = parseSiweMessage(message);
  if (!isEvmAddress(parsed.address)) return deny(401, "sign-in message names no valid wallet");
  const address = parsed.address.trim().toLowerCase();

  if (!parsed.domain || !allowed.includes(parsed.domain.toLowerCase())) {
    return deny(401, "sign-in message is for a different site");
  }
  if (!parsed.uri || !uriMatchesDomain(parsed.uri, parsed.domain)) {
    return deny(401, "sign-in message is for a different site");
  }
  if (parsed.chainId !== SIWE_CHAIN_ID) {
    return deny(401, `sign-in message must name chain ${SIWE_CHAIN_ID} (Base)`);
  }
  const want = actionResource(action);
  if (!parsed.resources || parsed.resources.length !== 1 || parsed.resources[0] !== want) {
    return deny(401, "sign-in message authorizes a different action");
  }
  const nonce = parsed.nonce;
  if (typeof nonce !== "string" || !nonce) return deny(401, "sign-in message carries no nonce");

  // viem's own EIP-4361 field check (address shape/equality, domain, and the
  // expiration/notBefore fields if a caller smuggled any in).
  if (!validateSiweMessage({ message: parsed, address: parsed.address, domain: parsed.domain })) {
    return deny(401, "invalid sign-in message");
  }

  // Re-derive the canonical message from the parsed fields and require an exact
  // match. This is what makes the field checks above binding: without it, a
  // crafted `statement` containing its own "Resources:" line could make the
  // parser and the signed bytes disagree about which action was authorized.
  const canonical = (() => {
    try {
      return buildOwnershipMessage({
        address: parsed.address as string,
        domain: parsed.domain as string,
        uri: parsed.uri as string,
        nonce,
        action,
        issuedAt: parsed.issuedAt ? new Date(parsed.issuedAt) : undefined,
      });
    } catch {
      return null; // malformed field viem's builder rejects
    }
  })();
  if (canonical !== message) return deny(401, "invalid sign-in message");

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false; // malformed signature bytes — a 401, never a 500
  }
  if (!valid) return deny(401, "signature does not match wallet");

  // LAST, and only once the signature is known good: burn the nonce. Ordering
  // matters both ways — consuming earlier would let anyone invalidate nonces
  // with garbage, and consuming later (or not at all) is the replay hole.
  // Signature malleability (s -> n-s) produces different bytes that still
  // verify, so this — not any signature dedupe — is what stops a replay.
  let nonceStore: NonceStore;
  try {
    nonceStore = store ?? SupabaseNonceStore.fromEnv();
  } catch (err) {
    return deny(503, `sign-in unconfigured: ${(err as Error).message}`);
  }
  let consumed: boolean;
  try {
    consumed = await nonceStore.consume(nonce);
  } catch (err) {
    console.error(`nonce consume failed: ${(err as Error).message}`);
    return deny(502, "could not verify sign-in request");
  }
  if (!consumed) return deny(401, "sign-in request already used or expired — sign in again");

  return { ok: true, wallet: address, status: 200, error: "" };
}
