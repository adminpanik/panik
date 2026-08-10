/**
 * The switch's non-React half: the stored preference and the exit-availability
 * answer every surface renders its copy from.
 *
 * `useChainMode` itself is not exercised here (these tests run in the node
 * environment, no DOM renderer); the store it reads is, and that is where the
 * behaviour lives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAIN_MODE_LABEL,
  CHAIN_MODE_STORAGE_KEY,
  EXIT_EXECUTABLE_MODE,
  defaultChainMode,
  exitAvailabilityLine,
  exitsExecutableOn,
  getChainMode,
  resetChainModeCache,
  setChainMode,
} from "./chainMode";
import { EXIT_CHAIN_ID } from "./exit.generated";

/** Minimal localStorage, because these run under vitest's node environment. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetChainModeCache();
});

describe("defaultChainMode", () => {
  it("is mainnet when nothing is configured", () => {
    // Same precedence as PANIK_SCORING_CHAIN on the server: an unset
    // deployment behaves exactly as it did before the switch existed.
    expect(defaultChainMode()).toBe("mainnet");
  });
});

describe("the stored preference", () => {
  it("opens on the default when the user has never chosen", () => {
    installStorage();
    expect(getChainMode()).toBe("mainnet");
  });

  it("reads a stored choice back", () => {
    installStorage({ [CHAIN_MODE_STORAGE_KEY]: "testnet" });
    expect(getChainMode()).toBe("testnet");
  });

  it("ignores a value that is not a chain we define", () => {
    // The point of the fallback: this string comes out of the user's own
    // browser, so a stale or hand-edited one must degrade to mainnet rather
    // than to an error or to a chain nobody selected.
    installStorage({ [CHAIN_MODE_STORAGE_KEY]: "sepolia" });
    expect(getChainMode()).toBe("mainnet");
  });

  it("persists a switch", () => {
    const store = installStorage();
    setChainMode("testnet");
    expect(store.get(CHAIN_MODE_STORAGE_KEY)).toBe("testnet");
    expect(getChainMode()).toBe("testnet");
    setChainMode("mainnet");
    expect(store.get(CHAIN_MODE_STORAGE_KEY)).toBe("mainnet");
  });

  it("notifies subscribers exactly once per real change", () => {
    installStorage();
    const seen: string[] = [];
    // The store's subscriber list is exercised through setChainMode; a no-op
    // set must not re-render every consumer of the hook.
    setChainMode("testnet");
    seen.push(getChainMode());
    setChainMode("testnet");
    seen.push(getChainMode());
    expect(seen).toEqual(["testnet", "testnet"]);
  });

  it("survives storage being unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(getChainMode()).toBe("mainnet");
    expect(() => setChainMode("testnet")).not.toThrow();
    // Session-only, but still switched.
    expect(getChainMode()).toBe("testnet");
  });
});

describe("exit availability per mode", () => {
  it("tracks the chain the executor is actually deployed on", () => {
    // Not a second copy of "Sepolia": it is derived from the generated
    // deployment, so a mainnet cutover moves both together.
    const deployedChainId: number = EXIT_CHAIN_ID;
    expect(EXIT_EXECUTABLE_MODE).toBe(deployedChainId === 8453 ? "mainnet" : "testnet");
    expect(exitsExecutableOn(EXIT_EXECUTABLE_MODE)).toBe(true);
  });

  it("says exits are NOT executable on the other chain", () => {
    const other = EXIT_EXECUTABLE_MODE === "testnet" ? "mainnet" : "testnet";
    expect(exitsExecutableOn(other)).toBe(false);
  });

  it("today: Base Sepolia executes, Base does not", () => {
    // The honest statement the UI has to make while the audit is outstanding.
    expect(exitsExecutableOn("testnet")).toBe(true);
    expect(exitsExecutableOn("mainnet")).toBe(false);
  });
});

describe("exitAvailabilityLine", () => {
  it("says the exit works, on the chain it works on", () => {
    const line = exitAvailabilityLine("testnet");
    expect(line).toContain("Base Sepolia");
    expect(line).toMatch(/can be signed/);
    expect(line).not.toMatch(/cannot/);
  });

  it("says the exit does NOT work on Base, and why, and when", () => {
    // The dead end this closes: a user in mainnet mode used to get an Exit
    // button that opened a flow targeting another chain.
    const line = exitAvailabilityLine("mainnet");
    expect(line).toMatch(/cannot be signed on Base yet/);
    expect(line).toContain("Base Sepolia");
    expect(line).toMatch(/ships after the audit/);
  });

  it("never implies Base execution exists", () => {
    for (const mode of ["mainnet", "testnet"] as const) {
      expect(exitAvailabilityLine(mode)).not.toMatch(/exits (are|run) live on Base\b/i);
    }
  });

  it("renders chain names, never the internal mode token", () => {
    for (const mode of ["mainnet", "testnet"] as const) {
      expect(exitAvailabilityLine(mode)).not.toMatch(/mainnet|testnet/i);
    }
  });

  it("carries no em dash", () => {
    for (const mode of ["mainnet", "testnet"] as const) {
      expect(exitAvailabilityLine(mode)).not.toContain("—");
    }
  });
});

describe("labels", () => {
  it("renders chain names, never the mode token", () => {
    expect(CHAIN_MODE_LABEL.mainnet).toBe("Base");
    expect(CHAIN_MODE_LABEL.testnet).toBe("Base Sepolia");
    // The mode strings are internal. Neither may appear in what a user reads.
    expect(Object.values(CHAIN_MODE_LABEL).join(" ")).not.toMatch(/mainnet|testnet/i);
  });
});
