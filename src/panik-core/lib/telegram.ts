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

export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

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
      const target = wallet.trim().toLowerCase();
      if (!isEvmAddress(target)) throw new Error("Needs an EVM wallet (0x...).");

      let signer = isConnected ? address : undefined;
      if (!signer) {
        const { accounts } = await connectAsync({ connector: injected() });
        signer = accounts[0];
      }
      if (!signer || signer.toLowerCase() !== target) {
        throw new Error(`Connect ${target.slice(0, 6)}...${target.slice(-4)} to prove you own it.`);
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

/** Outcome of a registration attempt. `error` is safe to show the user. */
export interface RegisterResult {
  ok: boolean;
  error: string | null;
}

/**
 * Wallets already registered in THIS page session, keyed lowercase:profile.
 * Module scope on purpose — AppDemo (onboarding) and OpenFlow (after an open)
 * both register, and a per-component ref meant the second one always missed and
 * fired a redundant signature prompt seconds after the user confirmed a
 * transaction. Registration is idempotent server-side, so skipping a repeat is
 * free; it only ever costs a popup.
 */
const registeredThisSession = new Set<string>();

/** Forget a wallet's registration so a retry actually re-runs it. */
export function forgetRegistration(wallet: string, profile: RiskProfile): void {
  registeredThisSession.delete(`${wallet.trim().toLowerCase()}:${profile}`);
}

/**
 * Register the onboarded wallet for monitoring. NEVER throws — callers treat it
 * as fire-and-forget — but it reports WHY it failed so the UI can say so.
 * Silent failure here is the worst outcome this product has: the dashboard
 * works, the user believes they are covered, and no alert will ever arrive.
 */
export async function registerWatchedWallet(
  wallet: string,
  profile: RiskProfile,
  getProof: GetProof,
): Promise<RegisterResult> {
  const target = wallet.trim().toLowerCase();
  if (!isEvmAddress(target)) return { ok: false, error: "Monitoring needs an EVM wallet (0x...)." };
  const key = `${target}:${profile}`;
  if (registeredThisSession.has(key)) return { ok: true, error: null };
  try {
    const proof = await getProof(target, "wallet-register");
    const res = await fetch("/api/wallets/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...proof, profile }),
    });
    if (!res.ok) return { ok: false, error: "Panik could not enable monitoring for this wallet." };
    registeredThisSession.add(key);
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok: false,
      error: rejectedSignature(err)
        ? "Signature declined. Alerts stay off until you verify this wallet."
        : ((err as Error).message ?? "Could not verify wallet ownership."),
    };
  }
}

/** User dismissed the wallet prompt (EIP-1193 4001, or viem's wrapper). */
function rejectedSignature(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string };
  return e?.code === 4001 || e?.name === "UserRejectedRequestError" || /rejected|denied/i.test(e?.message ?? "");
}

// "signing" = waiting on the ownership signature in the wallet;
// "opened" = deep link launched, waiting for Start; "connected" = link confirmed.
type LinkStatus = "idle" | "signing" | "requesting" | "opened" | "connected" | "error";

interface LinkResponse {
  code: string;
  botUsername: string;
  deepLink: string;
}

// /api/telegram/status returns ONLY `linked` — the @username is no longer
// exposed (unauthenticated, it mapped every wallet to a Telegram handle).
// The card shows a generic "Connected" instead.
interface StatusResponse {
  linked: boolean;
}

async function fetchLinkStatus(wallet: string): Promise<StatusResponse | null> {
  try {
    const res = await fetch(`/api/telegram/status?wallet=${encodeURIComponent(wallet.trim().toLowerCase())}`);
    if (!res.ok) return null;
    return (await res.json()) as StatusResponse;
  } catch {
    return null;
  }
}

/**
 * Hook driving the "Connect Telegram" button (with auto-confirm after Start).
 * The signature it collects is bound to the "telegram-link" action and cannot
 * be reused for anything else — nor can a registration signature be reused
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
        // Rejecting the prompt is a normal choice, not a crash.
        setStatus("error");
        setError(rejectedSignature(err) ? "Signature declined. Telegram alerts need it." : (err as Error).message);
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
          const txt = await res.text().catch(() => "");
          throw new Error(`http_${res.status}: ${txt.slice(0, 120)}`);
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
        setStatus("error");
        setError((err as Error).message);
      }
    },
    [stopPoll, getProof],
  );

  return { status, error, code, connect, check };
}
