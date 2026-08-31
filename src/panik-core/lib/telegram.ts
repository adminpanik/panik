/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Telegram alert wiring for panik-core.
 *  - useWalletOwnership: fetches a server nonce and signs the SIWE (EIP-4361)
 *    message for ONE named action, which is what the write endpoints below
 *    require.
 *  - registerWatchedWallet: after onboarding (and after an in-app open),
 *    registers the user's own wallet for monitoring via
 *    POST /api/wallets/register. Deduped per session so the user is never
 *    prompted twice for a wallet already registered.
 *  - useTelegramLink: mints a deep-link code from /api/telegram/link and opens
 *    t.me/<bot>?start=<code> so the user connects their Telegram.
 *
 * Both writes used to take a bare wallet address, so anyone could aim them at
 * someone else's wallet (steal their alerts, mute their liquidation warnings).
 * See server/walletAuth.ts, server/siweProof.ts, and
 * supabase/migrations/20260805000001_revoke_anon_wallet_register.sql.
 *
 * NO PROOF CACHE. A proof now embeds a server-issued nonce that verification
 * consumes on first use, so a cached one is guaranteed to 401. The old
 * per-instance useRef cache was also mounted twice (AppDemo + OpenFlow), which
 * meant its "one popup per onboarding" promise was already false. Deduping the
 * REGISTRATION (below) is what actually removes the redundant popup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { injected } from "wagmi/connectors";
import { buildOwnershipMessage, type OwnershipAction } from "../../../server/siweProof";

export type RiskProfile = "conservative" | "moderate" | "aggressive";

/**
 * Everything that takes up no room in a pasted address: ordinary whitespace,
 * the non-breaking space, the soft hyphen, and the zero-width and bidi-format
 * characters a copy out of a PDF or a rich-text document can carry. All of it
 * is DELETED, internally as well as at the ends, because a browser wallet
 * extension and `.trim()` both stop at the outer edges and an address pasted
 * with one of these in the middle otherwise fails a format check with nothing
 * for the reader to see wrong. Same character class as `VOUCHER_BLANKS` in
 * `server/accounts.ts`, applied here to addresses instead of voucher codes.
 *
 * TWIN: `ADDRESS_INVISIBLES` in `server/profileDeps.ts` (server twin) and
 * `src/panik-landing-page/lib/waitlist.ts` (landing copy) is a
 * character-for-character copy and must stay one. `server/profileDeps.test.ts`
 * asserts all three agree on every case, so they cannot drift apart silently.
 */
const ADDRESS_INVISIBLES = /[\s\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/** Strip the characters above. Used before both the format check and anywhere
 * the address is used as a value (signed, sent, stored), so an honest paste
 * is never accepted by the check and then carried forward uncleaned. */
export const stripAddressInvisibles = (a: string): string => a.replace(ADDRESS_INVISIBLES, "");

export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(stripAddressInvisibles(a));

/** A signed wallet-ownership proof, as the API expects it in the body. */
export interface OwnershipProof {
  /** The full EIP-4361 message. It names the wallet, domain, nonce and action. */
  message: string;
  signature: string;
}

/** Signs a proof for one wallet and one action. Throws with user-facing text. */
export type GetProof = (wallet: string, action: OwnershipAction) => Promise<OwnershipProof>;

/** Single-use value from the server; without it the message cannot be built. */
async function fetchNonce(): Promise<string> {
  const res = await fetch("/api/auth/nonce");
  if (!res.ok) throw new Error("Could not reach Panik to start the signature. Try again.");
  const { nonce } = (await res.json()) as { nonce?: string };
  if (!nonce) throw new Error("Could not reach Panik to start the signature. Try again.");
  return nonce;
}

/**
 * Ownership proof for ONE action. Every call costs a wallet popup by design:
 * the signature is single-use and names the action it authorizes, so it can no
 * longer be silently reused for a different, more dangerous endpoint.
 */
export function useWalletOwnership(): { getProof: GetProof } {
  const { address, isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();

  const getProof = useCallback<GetProof>(
    async (wallet, action) => {
      const target = stripAddressInvisibles(wallet).toLowerCase();
      if (!isEvmAddress(target)) throw new OwnershipError("Needs an EVM wallet (0x...).");

      let signer = isConnected ? address : undefined;
      if (!signer) {
        const { accounts } = await connectAsync({ connector: injected() });
        signer = accounts[0];
      }
      if (!signer || signer.toLowerCase() !== target) {
        throw new OwnershipError(
          `Alerts need a signature from ${target.slice(0, 6)}...${target.slice(-4)}. Connect that wallet to turn them on.`,
        );
      }

      const nonce = await fetchNonce();
      // Built by the SAME function the server re-derives with, so the two can
      // never drift apart byte-wise.
      const message = buildOwnershipMessage({
        address: target,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        action,
      });
      const signature = await signMessageAsync({ account: signer, message });
      return { message, signature };
    },
    [address, isConnected, connectAsync, signMessageAsync],
  );

  return { getProof };
}

/**
 * An error whose message THIS FILE wrote, and which is therefore safe to put on
 * screen. Everything else thrown in here comes from wagmi or viem, and their
 * messages are written for a developer reading a stack trace: the reason this
 * class exists is that `(err as Error).message` was being interpolated straight
 * into the alerts banner, so a user with no wallet extension installed read
 * "Provider not found. Version: @wagmi/core@3.5.1" across the top of the app.
 */
export class OwnershipError extends Error {}

/**
 * Why monitoring is off, which decides how loudly to say so.
 *
 *   "blocked"    we tried, we failed, and the user has reason to believe they
 *                are covered when they are not. This is the silent-failure case
 *                the banner exists for.
 *   "unverified" a precondition was never met: no wallet connected, or the
 *                connected one is not the address being watched. Nothing broke.
 *                A watch-only address someone pasted to look around cannot be
 *                monitored and never could be, so raising a critical alarm over
 *                it spends the loudest surface in the product on a non-event.
 */
export type MonitoringSeverity = "blocked" | "unverified";

/** Outcome of a registration attempt. `error` is safe to show the user. */
export interface RegisterResult {
  ok: boolean;
  error: string | null;
  /** Null exactly when `ok`. */
  severity: MonitoringSeverity | null;
}

/**
 * Wallets already registered in THIS page session, keyed lowercase:profile.
 * Module scope on purpose: AppDemo (onboarding) and OpenFlow (after an open)
 * both register, and a per-component ref meant the second one always missed and
 * fired a redundant signature prompt seconds after the user confirmed a
 * transaction. Registration is idempotent server-side, so skipping a repeat is
 * free; it only ever costs a popup.
 */
const registeredThisSession = new Set<string>();

/** Forget a wallet's registration so a retry actually re-runs it. */
export function forgetRegistration(wallet: string, profile: RiskProfile): void {
  registeredThisSession.delete(`${stripAddressInvisibles(wallet).toLowerCase()}:${profile}`);
}

/**
 * Register the onboarded wallet for monitoring. NEVER throws, callers treat it
 * as fire-and-forget, but it reports WHY it failed so the UI can say so.
 * Silent failure here is the worst outcome this product has: the dashboard
 * works, the user believes they are covered, and no alert will ever arrive.
 */
export async function registerWatchedWallet(
  wallet: string,
  profile: RiskProfile,
  getProof: GetProof,
): Promise<RegisterResult> {
  const target = stripAddressInvisibles(wallet).toLowerCase();
  if (!isEvmAddress(target))
    return { ok: false, error: "Monitoring needs an EVM wallet (0x...).", severity: "unverified" };
  const key = `${target}:${profile}`;
  if (registeredThisSession.has(key)) return { ok: true, error: null, severity: null };
  try {
    const proof = await getProof(target, "wallet-register");
    const res = await fetch("/api/wallets/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...proof, profile }),
    });
    if (!res.ok) {
      // Same `body?.error ?? fallback` pattern as `lib/watchlist.ts`'s
      // `saveWatchlist`: the server's own sentence names WHY registration was
      // refused (a distinct one per case), and a generic fallback speaks for it
      // only when the body carries nothing usable.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      console.error("registerWatchedWallet: request failed", res.status, body);
      return {
        ok: false,
        error: body?.error ?? "Panik could not enable monitoring for this wallet.",
        severity: "blocked",
      };
    }
    registeredThisSession.add(key);
    return { ok: true, error: null, severity: null };
  } catch (err) {
    return { ok: false, ...describeFailure(err) };
  }
}

/**
 * Turn whatever was thrown into a sentence a user can act on.
 *
 * The rule is that NO library message reaches this return value. A raw wagmi or
 * viem string names an internal it wants a developer to go read, and on the
 * alerts banner it read as the product being broken when the actual situation
 * was "this browser has no wallet extension".
 */
function describeFailure(err: unknown): { error: string; severity: MonitoringSeverity } {
  if (rejectedSignature(err)) {
    return {
      error: "Signature declined. Alerts stay off until you verify this wallet.",
      severity: "blocked",
    };
  }
  // Our own message, written for this screen: the only one safe to pass along.
  if (err instanceof OwnershipError) return { error: err.message, severity: "unverified" };
  if (noWalletAvailable(err)) {
    return {
      error: "Panik cannot watch a wallet it has not verified. Connect this wallet to turn alerts on.",
      severity: "unverified",
    };
  }
  return {
    error: "Panik could not verify that you own this wallet, so alerts are off.",
    severity: "blocked",
  };
}

/**
 * No wallet to sign with: no extension installed, or none connected. wagmi
 * raises these as ProviderNotFoundError / ConnectorNotFoundError; the message
 * test is a fallback for the versions that only set one of the two, and is used
 * ONLY to classify, the string itself never reaches the screen.
 *
 * Exported for `lib/watchlist.ts`, which needs the same three-way split and
 * must not own a second copy of it: these predicates encode which wagmi/viem
 * shapes mean what, and a copy that missed `ConnectorNotConnectedError` would
 * silently reclassify one whole failure mode into the generic sentence.
 */
export function noWalletAvailable(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    e?.name === "ProviderNotFoundError" ||
    e?.name === "ConnectorNotFoundError" ||
    e?.name === "ConnectorNotConnectedError" ||
    /provider not found|connector not found|no injected/i.test(e?.message ?? "")
  );
}

/** User dismissed the wallet prompt (EIP-1193 4001, or viem's wrapper). */
export function rejectedSignature(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string };
  return e?.code === 4001 || e?.name === "UserRejectedRequestError" || /rejected|denied/i.test(e?.message ?? "");
}

/**
 * What `useTelegramLink.connect` shows when getting the ownership signature
 * fails, before it ever asks the server for a link code. Same doctrine as
 * `describeFailure` above: no library string reaches the screen, and only our
 * own `OwnershipError` is trusted verbatim because this file wrote it.
 *
 * A plain, exported function rather than inlined in the hook's `catch`, so it
 * can be unit-tested directly: this repo has no jsdom/testing-library, so a
 * hook's closures are not otherwise reachable from a test.
 */
export function describeTelegramSignatureFailure(err: unknown): string {
  if (rejectedSignature(err)) return "Signature declined. Telegram alerts need it.";
  if (err instanceof OwnershipError) return err.message;
  if (noWalletAvailable(err)) return "Telegram alerts need a connected wallet. Connect it and try again.";
  console.error("useTelegramLink.connect: signature failed", err);
  return "Could not get a signature for Telegram alerts. Try again.";
}

// "signing" = waiting on the ownership signature in the wallet;
// "opened" = deep link launched, waiting for Start; "connected" = link confirmed.
type LinkStatus = "idle" | "signing" | "requesting" | "opened" | "connected" | "error";

interface LinkResponse {
  code: string;
  botUsername: string;
  deepLink: string;
}

// /api/telegram/status returns ONLY `linked`, the @username is no longer
// exposed (unauthenticated, it mapped every wallet to a Telegram handle).
// The card shows a generic "Connected" instead.
interface StatusResponse {
  linked: boolean;
}

async function fetchLinkStatus(wallet: string): Promise<StatusResponse | null> {
  try {
    const target = stripAddressInvisibles(wallet).toLowerCase();
    const res = await fetch(`/api/telegram/status?wallet=${encodeURIComponent(target)}`);
    if (!res.ok) return null;
    return (await res.json()) as StatusResponse;
  } catch {
    return null;
  }
}

/**
 * Hook driving the "Connect Telegram" button (with auto-confirm after Start).
 * The signature it collects is bound to the "telegram-link" action and cannot
 * be reused for anything else, nor can a registration signature be reused
 * here, which is precisely the point.
 */
export function useTelegramLink(getProof: GetProof) {
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Clear the poll if the component unmounts.
  useEffect(() => stopPoll, [stopPoll]);

  /** Check for an existing link (call on mount) so the card shows "Connected". */
  const check = useCallback(async (wallet: string) => {
    if (!isEvmAddress(wallet)) return;
    const s = await fetchLinkStatus(wallet);
    if (s?.linked) setStatus("connected");
  }, []);

  const connect = useCallback(
    async (wallet: string) => {
      if (!isEvmAddress(wallet)) {
        setStatus("error");
        setError("Telegram alerts need an EVM wallet (0x...).");
        return;
      }
      setError(null);
      setCode(null);
      let proof: OwnershipProof;
      try {
        // Proves the wallet is the caller's before we mint a code that
        // redirects its alerts. The popup states exactly that.
        setStatus("signing");
        proof = await getProof(wallet, "telegram-link");
      } catch (err) {
        setStatus("error");
        setError(describeTelegramSignatureFailure(err));
        return;
      }
      setStatus("requesting");
      try {
        const res = await fetch("/api/telegram/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proof),
        });
        if (!res.ok) {
          // Same `body?.error ?? fallback` pattern as `lib/watchlist.ts`'s
          // `saveWatchlist` and `registerWatchedWallet` above: the distinguishing
          // sentence is the server's, the raw status/body is for the console only.
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          console.error("useTelegramLink.connect: link request failed", res.status, body);
          setStatus("error");
          setError(body?.error ?? "Could not start the Telegram connection. Try again.");
          return;
        }
        const data = (await res.json()) as LinkResponse;
        setCode(data.code);
        window.open(data.deepLink, "_blank", "noopener,noreferrer");
        setStatus("opened");

        // Auto-confirm: poll until the webhook records the link (~2 min window).
        stopPoll();
        let tries = 0;
        pollRef.current = setInterval(async () => {
          tries += 1;
          const s = await fetchLinkStatus(wallet);
          if (s?.linked) {
            setStatus("connected");
            stopPoll();
          } else if (tries >= 40) {
            stopPoll(); // give up polling; user stays on "opened" with the manual code
          }
        }, 3000);
      } catch (err) {
        console.error("useTelegramLink.connect: link request errored", err);
        setStatus("error");
        setError("Could not reach PANIK to start the Telegram connection. Try again.");
      }
    },
    [stopPoll, getProof],
  );

  return { status, error, code, connect, check };
}
