/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Telegram alert wiring for panik-core.
 *  - registerWatchedWallet: after onboarding, register the user's own wallet for
 *    monitoring via the register_watched_wallet SECURITY DEFINER RPC (publishable
 *    key, like the waitlist flow). Fire-and-forget; never blocks the UI.
 *  - useTelegramLink: mints a deep-link code from /api/telegram/link and opens
 *    t.me/<bot>?start=<code> so the user connects their Telegram.
 * See supabase/migrations/20260627000001_telegram_alerts.sql.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/**
 * Register the onboarded wallet for monitoring. Resolves true on success.
 * Swallows errors (returns false) so onboarding never blocks on it. No-op for
 * non-EVM wallets (the on-chain readers can't monitor them).
 */
export async function registerWatchedWallet(wallet: string, profile: RiskProfile): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !isEvmAddress(wallet)) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/register_watched_wallet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ p_wallet: wallet.trim().toLowerCase(), p_profile: profile }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// "opened" = deep link launched, waiting for Start; "connected" = link confirmed.
type LinkStatus = "idle" | "requesting" | "opened" | "connected" | "error";

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

/** Hook driving the "Connect Telegram" button (with auto-confirm after Start). */
export function useTelegramLink() {
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
      setStatus("requesting");
      setError(null);
      setCode(null);
      try {
        const res = await fetch("/api/telegram/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: wallet.trim().toLowerCase() }),
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
    [stopPoll],
  );

  return { status, error, code, connect, check };
}
