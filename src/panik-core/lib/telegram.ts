/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Telegram alert wiring for panik-core.
 *  - useWalletOwnership: signs the ONE proof message the write endpoints below
 *    require, and caches it for the session so the user signs once.
 *  - registerWatchedWallet: after onboarding, registers the user's own wallet
 *    for monitoring via POST /api/wallets/register. Fire-and-forget; never
 *    blocks the UI.
 *  - useTelegramLink: mints a deep-link code from /api/telegram/link and opens
 *    t.me/<bot>?start=<code> so the user connects their Telegram.
 *
 * Both writes used to take a bare wallet address, so anyone could aim them at
 * someone else's wallet (steal their alerts, mute their liquidation warnings).
 * See server/walletAuth.ts and
 * supabase/migrations/20260805000001_revoke_anon_wallet_register.sql.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { injected } from "wagmi/connectors";

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** A signed wallet-ownership proof, as the API expects it in the body. */
export interface OwnershipProof {
  wallet: string;
  signature: string;
  timestamp: number;
}

/** Must match ownershipMessage() in server/walletAuth.ts, byte for byte. */
const proofMessage = (wallet: string, timestamp: number): string =>
  `PANIK wallet ownership\nWallet: ${wallet}\nIssued: ${timestamp}`;

// Server accepts proofs for 10 minutes; re-sign a minute early so one that is
// about to expire mid-flight doesn't come back as a confusing 401.
const PROOF_REUSE_MS = 9 * 60 * 1000;

/**
 * Sign-once ownership proof for the session. The proof is generic (not
 * per-endpoint) precisely so the onboarding flow — register wallet, then
 * connect Telegram — costs the user a single wallet popup rather than one per
 * call. Kept in a ref: it is a short-lived credential and has no business in
 * localStorage or in React state that renders.
 */
export function useWalletOwnership() {
  const { address, isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const cache = useRef<OwnershipProof | null>(null);

  /**
   * Returns a usable proof for `wallet`, prompting a signature only when the
   * cached one is missing, stale, or for a different wallet. Throws with a
   * user-facing message when the wallet can't sign (wrong account connected,
   * user rejected the prompt).
   */
  const getProof = useCallback(
    async (wallet: string): Promise<OwnershipProof> => {
      const target = wallet.trim().toLowerCase();
      if (!isEvmAddress(target)) throw new Error("Needs an EVM wallet (0x...).");

      const cached = cache.current;
      if (cached && cached.wallet === target && Date.now() - cached.timestamp < PROOF_REUSE_MS) {
        return cached;
      }

      let signer = isConnected ? address : undefined;
      if (!signer) {
        const { accounts } = await connectAsync({ connector: injected() });
        signer = accounts[0];
      }
      if (!signer || signer.toLowerCase() !== target) {
        throw new Error(`Connect ${target.slice(0, 6)}...${target.slice(-4)} to prove you own it.`);
      }

      const timestamp = Date.now();
      const signature = await signMessageAsync({
        account: signer,
        message: proofMessage(target, timestamp),
      });
      const proof: OwnershipProof = { wallet: target, signature, timestamp };
      cache.current = proof;
      return proof;
    },
    [address, isConnected, connectAsync, signMessageAsync],
  );

  return { getProof };
}

/**
 * Register the onboarded wallet for monitoring. Resolves true on success.
 * Swallows errors (returns false) so onboarding never blocks on it — including
 * the user declining to sign, which simply leaves the wallet unmonitored until
 * they connect Telegram (that flow signs too, and surfaces failures).
 */
export async function registerWatchedWallet(
  wallet: string,
  profile: RiskProfile,
  getProof: (wallet: string) => Promise<OwnershipProof>,
): Promise<boolean> {
  if (!isEvmAddress(wallet)) return false;
  try {
    const proof = await getProof(wallet);
    const res = await fetch("/api/wallets/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...proof, profile }),
    });
    return res.ok;
  } catch {
    return false;
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
 * `getProof` comes from useWalletOwnership so the signature is shared with the
 * registration call — one popup for the whole onboarding, not two.
 */
export function useTelegramLink(getProof: (wallet: string) => Promise<OwnershipProof>) {
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
        // redirects its alerts. Cached, so usually no popup at all.
        setStatus("signing");
        proof = await getProof(wallet);
      } catch (err) {
        // Rejecting the prompt is a normal choice, not a crash.
        setStatus("error");
        setError(rejectedSignature(err) ? "Signature declined — Telegram alerts need it." : (err as Error).message);
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
