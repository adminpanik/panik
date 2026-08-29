/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Waitlist API bridge for the landing page.
 *
 * LEAN design (no Edge Function, no SDK, no CAPTCHA): the browser calls two
 * SECURITY DEFINER Postgres functions directly via PostgREST with the
 * publishable key. The waitlist_signups table is deny-all RLS; these functions
 * are the only door. See supabase/migrations/20260614000001_waitlist.sql.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const waitlistConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

export type Appetite = "conservative" | "moderate" | "aggressive";

/** Stable option keys, must match the DB CHECK lists. */
export interface SignupAnswers {
  email: string;
  walletAddress: string;
  q1DefiActivity: "never" | "tried" | "active_1_2" | "active_3_plus";
  q2Liquidation: "no_unsure" | "no_managed" | "yes_caught" | "yes_accept";
  q3RiskTracking: ("manual_dashboard" | "portfolio_tracker" | "custom_alerts" | "protocol_alerts")[];
  q4Frustrations: ("no_unified_view" | "slow_reaction" | "silent_risk" | "execution_friction")[];
  q5PortfolioSize: "lt_1k" | "1k_10k" | "10k_50k" | "50k_200k" | "gt_200k";
  additionalNotes?: string;
  /** Honeypot: real users never fill this; bots do. */
  honeypot?: string;
}

export interface SignupResult {
  ok: boolean;
  position?: number;
  error?: string;
}

export const isValidEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/**
 * Client-side mirror of public.waitlist_appetite(), used only to SHOW the
 * profile on the success screen. Appetite is derived (never stored); the DB
 * view recomputes it for analysis. Keep this in sync with the SQL function.
 */
export function deriveAppetite(
  q1: SignupAnswers["q1DefiActivity"],
  q2: SignupAnswers["q2Liquidation"],
  q5: SignupAnswers["q5PortfolioSize"],
): Appetite {
  const s1 = { never: 1, tried: 1, active_1_2: 2, active_3_plus: 3 }[q1];
  const s2 = { no_unsure: 1, no_managed: 2, yes_caught: 2, yes_accept: 3 }[q2];
  const s5 = { lt_1k: 1, "1k_10k": 1, "10k_50k": 2, "50k_200k": 3, gt_200k: 3 }[q5];
  const score = s1 + s2 * 2 + s5; // 4..12
  if (score <= 6) return "conservative";
  if (score <= 9) return "moderate";
  return "aggressive";
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(args),
  });
}

/** Submit a signup via the waitlist_signup RPC. Never throws, returns a result. */
export async function submitSignup(answers: SignupAnswers): Promise<SignupResult> {
  if (!waitlistConfigured) return { ok: false, error: "config_missing" };
  try {
    const res = await rpc("waitlist_signup", {
      p_email: answers.email,
      p_wallet: answers.walletAddress,
      p_q1_defi_activity: answers.q1DefiActivity,
      p_q2_liquidation: answers.q2Liquidation,
      p_q3_risk_tracking: answers.q3RiskTracking,
      p_q4_frustrations: answers.q4Frustrations,
      p_q5_portfolio_size: answers.q5PortfolioSize,
      p_additional_notes: answers.additionalNotes ?? null,
      p_honeypot: answers.honeypot ?? "",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${text.slice(0, 160)}` };
    }
    const position = await res.json(); // scalar integer
    return { ok: true, position: typeof position === "number" ? position : undefined };
  } catch {
    return { ok: false, error: "network" };
  }
}

/**
 * Returns true if the email is already on the waitlist (same normalisation
 * as the DB). Returns false on network failure (fail-open so the user can
 * still attempt to sign up: the server will handle it).
 */
export async function checkEmailExists(email: string): Promise<boolean> {
  if (!waitlistConfigured) return false;
  try {
    const res = await rpc("waitlist_check_email", { p_email: email.trim() });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

/** Public waitlist count via the SECURITY DEFINER RPC. null on failure. */
export async function getWaitlistCount(): Promise<number | null> {
  if (!waitlistConfigured) return null;
  try {
    const res = await rpc("waitlist_count", {});
    if (!res.ok) return null;
    const n = await res.json();
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

// Wallet connect: EIP-6963 multi-provider discovery (no wagmi)
// EIP-6963 is the current standard for discovering injected wallets without
// the legacy window.ethereum collision (when several wallets are installed
// they fight over that single object). Each wallet announces itself with an
// rdns id; we match MetaMask (io.metamask) / Coinbase (com.coinbase.wallet)
// exactly. Falls back to window.ethereum for wallets that predate EIP-6963.
// We only read the address, no signing, no chain switch.

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
}
interface Eip6963ProviderInfo { uuid: string; name: string; icon: string; rdns: string; }
interface Eip6963ProviderDetail { info: Eip6963ProviderInfo; provider: Eip1193Provider; }

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] };
    coinbaseWalletExtension?: Eip1193Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

export type WalletRdns = "io.metamask" | "com.coinbase.wallet";
const WALLET_LABEL: Record<WalletRdns, string> = {
  "io.metamask": "MetaMask",
  "com.coinbase.wallet": "Coinbase Wallet",
};

// Providers announce in response to the request event; collect them by rdns.
const announced = new Map<string, Eip6963ProviderDetail>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e) => {
    announced.set(e.detail.info.rdns, e.detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function refreshAnnouncements(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(resolve, 250); // small grace window for late announcers
  });
}

// Legacy fallback for wallets that don't emit EIP-6963 yet. Handles the
// window.ethereum.providers[] array that multi-wallet setups expose.
function legacyProvider(rdns: WalletRdns): Eip1193Provider | null {
  const eth = window.ethereum;
  if (!eth) return rdns === "com.coinbase.wallet" ? window.coinbaseWalletExtension ?? null : null;
  const list = eth.providers?.length ? eth.providers : [eth];
  const found = list.find((p) =>
    rdns === "io.metamask" ? p.isMetaMask && !p.isCoinbaseWallet : p.isCoinbaseWallet,
  );
  return found ?? (rdns === "com.coinbase.wallet" ? window.coinbaseWalletExtension ?? null : null);
}

/** True if at least one injected wallet is present (EIP-6963 or legacy). */
export const hasInjectedWallet = (): boolean =>
  typeof window !== "undefined" && (announced.size > 0 || Boolean(window.ethereum));

/**
 * Connect to a specific wallet by rdns and return a lowercased EVM address.
 * Throws a user-facing message if the wallet isn't installed or is rejected.
 */
export async function connectWallet(rdns: WalletRdns): Promise<string> {
  await refreshAnnouncements();
  const provider = announced.get(rdns)?.provider ?? legacyProvider(rdns);
  if (!provider) {
    throw new Error(`${WALLET_LABEL[rdns]} not detected. Install it, or paste your address below.`);
  }
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const addr = accounts?.[0];
    if (!addr || !isValidEvmAddress(addr)) {
      throw new Error("Could not read a valid address from your wallet.");
    }
    return addr.toLowerCase();
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code === 4001 || code === 4100) throw new Error("Connection request was rejected.");
    throw e instanceof Error ? e : new Error("Wallet connection failed.");
  }
}
