/**
 * Which chain the app is LOOKING at: Base mainnet or Base Sepolia.
 *
 * The product has two honest modes and they demonstrate different halves of it.
 * Mainnet shows the risk management working on real positions and real scores.
 * Testnet shows the execution working, because the exit executor is deployed on
 * Base Sepolia alone (`exit.generated.ts`) and will be until the audit lands.
 * Those used to be two separate builds; this is the switch that makes them one
 * product.
 *
 * The chain is NOT decided here. It is sent to the API as `?chain=`, the API
 * validates it against `packages/scoring/src/chains.ts` and answers with the
 * chain it actually read in the `chain` block on the payload. Every label the
 * dashboard prints comes from THAT block, so this preference can never put a
 * chain name on numbers from another chain: the worst a bad value can do is get
 * mainnet back.
 *
 * ── Why localStorage is the right home for this, and is not for the wallet ──
 *
 * This is a DISPLAY preference: which of two public chains to read. Nothing is
 * authorized by it, no server trusts it, and the worst outcome of a tampered
 * value is that the user is shown the other chain's public positions, which
 * they can also get by clicking the toggle. Persisting it is what stops the
 * screen resetting to mainnet on every reload mid-demo.
 *
 * Issue #51 is about the WALLET, and it must never work this way. An address in
 * localStorage is an identity claim, and an identity claim a user can edit is
 * not authentication: anything acting on a wallet needs the ownership signature
 * in `server/walletAuth.ts`. Do not "make these consistent" by moving the wallet
 * here, and do not move this to the server on the grounds that the wallet is
 * there. They are different kinds of value.
 */

import { useSyncExternalStore } from "react";
import { EXIT_CHAIN_ID } from "./exit.generated";

export type ChainMode = "testnet" | "mainnet";

/** Chain names fit to render. Never a raw mode string in UI copy. */
export const CHAIN_MODE_LABEL: Record<ChainMode, string> = {
  mainnet: "Base",
  testnet: "Base Sepolia",
};

export const CHAIN_MODE_STORAGE_KEY = "panik_chain_mode";

/**
 * The mode the executor can actually settle a transaction on, derived from the
 * generated deployment rather than written down again: `sync:exit-config`
 * rewrites `EXIT_CHAIN_ID` at cutover and this follows it in the same commit.
 */
// Widened copy, same as `lib/exit.ts`: the generated constant is a literal
// type, and TS rejects a literal-vs-literal comparison that can only become
// true after a redeploy.
const EXIT_CHAIN: number = EXIT_CHAIN_ID;
export const EXIT_EXECUTABLE_MODE: ChainMode = EXIT_CHAIN === 8453 ? "mainnet" : "testnet";

/** Whether an exit can be signed and settled while this mode is selected. */
export function exitsExecutableOn(mode: ChainMode): boolean {
  return mode === EXIT_EXECUTABLE_MODE;
}

/**
 * What this mode can DO, in one sentence, at the point of action.
 *
 * Four surfaces need to say this: the Settings switch, the Advisor's position
 * section, the disabled exit button's hover, and the exit modal's dead-end
 * step. One sentence, one place, so they cannot drift into contradicting each
 * other about whether a button works.
 *
 * Derived rather than written down: the day `sync:exit-config` points
 * `EXIT_CHAIN_ID` at Base, this moves with it instead of standing there
 * insisting on Sepolia.
 */
export function exitAvailabilityLine(mode: ChainMode): string {
  const here = CHAIN_MODE_LABEL[mode];
  return exitsExecutableOn(mode)
    ? `Exits can be signed and settled on ${here}, against whatever this wallet holds there.`
    : `Exits cannot be signed on ${here} yet. The exit executor is deployed on ${CHAIN_MODE_LABEL[EXIT_EXECUTABLE_MODE]}, and ${here} execution ships after the audit.`;
}

/**
 * What the app opens on when the user has never chosen: the build's configured
 * chain, else mainnet. Same precedence as the server's `PANIK_SCORING_CHAIN`,
 * so an unset deployment behaves exactly as it did before the switch existed.
 */
export function defaultChainMode(): ChainMode {
  const configured = (import.meta.env.VITE_SCORING_CHAIN as string | undefined)?.trim().toLowerCase();
  return configured === "testnet" ? "testnet" : "mainnet";
}

function parseChainMode(raw: string | null): ChainMode | null {
  if (raw === "testnet" || raw === "mainnet") return raw;
  return null;
}

// A module-level store rather than a context, because the readers are spread
// across the tab shell, the Advisor panel, the exit flow and the delegation
// card, and a provider would have to wrap all of them to serve a single string.
// `useSyncExternalStore` gives every one of them the same value in the same
// render, which a bare module variable does not.
let current: ChainMode | null = null;
const listeners = new Set<() => void>();

function readStored(): ChainMode {
  if (current !== null) return current;
  let stored: ChainMode | null = null;
  try {
    stored = parseChainMode(localStorage.getItem(CHAIN_MODE_STORAGE_KEY));
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). The switch
    // still works for the session; it just does not survive a reload.
  }
  current = stored ?? defaultChainMode();
  return current;
}

export function getChainMode(): ChainMode {
  return readStored();
}

export function setChainMode(mode: ChainMode): void {
  if (readStored() === mode) return;
  current = mode;
  try {
    localStorage.setItem(CHAIN_MODE_STORAGE_KEY, mode);
  } catch {
    // See readStored: a session-only preference is better than a thrown render.
  }
  for (const listener of listeners) listener();
}

/**
 * Test seam and the `storage`-event path in one: drops the cached value so the
 * next read goes back to localStorage.
 */
export function resetChainModeCache(): void {
  current = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A second tab switching mode should not leave this one insisting on the old
  // chain: the preference is one per browser, not one per tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === CHAIN_MODE_STORAGE_KEY) resetChainModeCache();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The selected chain, shared by every component that asks. */
export function useChainMode(): ChainMode {
  return useSyncExternalStore(subscribe, getChainMode, defaultChainMode);
}

/**
 * Whether an exit control may be pressed, and what to say on hover when it may
 * not.
 *
 * The composition, not just the primitives. `exitsExecutableOn` and
 * `exitAvailabilityLine` were already exported, so the two surfaces that offer
 * an exit — the Advisor card and the Portfolio row — each wrote the same three
 * lines around them, down to the same fallback sentence. That is one policy
 * decision ("is this control live, and why not") stored in two places, and the
 * product presents both as the same control: a third state, or a reworded hint,
 * would have made the same button disagree with itself across two tabs.
 *
 * `handler` is the surface's own `onExit` prop. Absent means the flow is not
 * wired in on that surface at all, which is a different reason from the chain
 * being unable to execute, and the hint has to name the right one.
 */
/**
 * What a gated action control renders: pressable or not, and the hover hint
 * when not. Shared by `exitControlState` here and `openControlState` in
 * `openProtocols.ts` (which cannot live here without an import cycle), so the
 * two policies cannot drift into different shapes under the same buttons.
 */
export interface ControlState {
  enabled: boolean;
  hint: string | undefined;
}

export function exitControlState(handler: unknown, mode: ChainMode): ControlState {
  const executable = exitsExecutableOn(mode);
  if (!executable) return { enabled: false, hint: exitAvailabilityLine(mode) };
  if (!handler) {
    return { enabled: false, hint: "Transaction flow ships with the Atomic Exit integration" };
  }
  return { enabled: true, hint: undefined };
}
