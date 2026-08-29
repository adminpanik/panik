/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useWalletProfile: drives the timeout-proof start/poll profiler from the
 * onboarding flow. The scan is kicked off the moment the wallet is entered
 * (start), runs in the background while the user answers the quiz, and is
 * revealed at the end (resolve, polled with the quiz's stated profile).
 *
 * Degrades gracefully: if the scoring API is offline, phase becomes "error"
 * and the caller simply proceeds with the quiz-only result.
 */

import { useCallback, useRef, useState } from "react";

export interface WalletProfileData {
  profile: "conservative" | "moderate" | "aggressive";
  archetype: string;
  riskAppetiteIndex: number;
  confidence: number;
  stated?: { riskProfile3: string };
  alignment?: "aligned" | "understated" | "overstated";
  tagline: string;
  description: string;
  reasons: string[];
  features: {
    lendingTxCount: number;
    chainsActive: number;
    protocolsUsed: number;
    liquidations: number;
    borrowToDepositRatio: number;
    topProtocol: string | null;
    topChain: string | null;
    [k: string]: unknown;
  };
}

export type ProfilePhase = "idle" | "scanning" | "revealing" | "done" | "error";

const POLL_MS = 3000;
const REVEAL_TIMEOUT_MS = 70_000;

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export function useWalletProfile() {
  const [phase, setPhase] = useState<ProfilePhase>("idle");
  const [data, setData] = useState<WalletProfileData | null>(null);
  const walletRef = useRef<string>("");
  const execRef = useRef<string | undefined>(undefined);

  /** Fire on wallet entry, begins the background scan (non-blocking). */
  const start = useCallback(async (wallet: string) => {
    walletRef.current = wallet.toLowerCase();
    execRef.current = undefined;
    setPhase("scanning");
    try {
      const j = await postJson("/api/profile/start", { wallet: walletRef.current });
      if (j.status === "scanning") execRef.current = j.executionId;
      // status "ready" → already cached; resolve() will return instantly.
    } catch {
      setPhase("error"); // API offline, caller falls back to quiz-only.
    }
  }, []);

  /** Call at the reveal step, polls until the combined analysis is ready. */
  const resolve = useCallback(async (stated: { riskProfile3: string }): Promise<WalletProfileData | null> => {
    setPhase("revealing");
    const deadline = Date.now() + REVEAL_TIMEOUT_MS;
    try {
      for (;;) {
        const j = await postJson("/api/profile/result", {
          wallet: walletRef.current,
          executionId: execRef.current,
          stated,
        });
        if (j.status === "done") {
          setData(j.profile as WalletProfileData);
          setPhase("done");
          return j.profile as WalletProfileData;
        }
        if (j.status === "pending" && j.executionId) execRef.current = j.executionId;
        if (Date.now() > deadline) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch {
      setPhase("error");
      return null;
    }
  }, []);

  return { phase, data, start, resolve };
}
