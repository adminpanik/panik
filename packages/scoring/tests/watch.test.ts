import { describe, expect, it, vi } from "vitest";
import { WatchService, type WatchTransition } from "../src/watch/loop";

describe("WatchService", () => {
  it("emits on first observation, stays silent while stable, fires on change", async () => {
    const totals = [30, 30, 55]; // moderate profile: within, within, outside
    let call = 0;
    const transitions: WatchTransition[] = [];

    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: totals[call] ?? 55, band: "ELEVATED" },
      ],
      profileFor: () => "moderate",
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC"); // normalised to lowercase internally

    await service.tick(); // first observation → within (from null)
    call = 1;
    await service.tick(); // unchanged → no event
    call = 2;
    await service.tick(); // 55 ≥ 50 → outside

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ from: null, to: "within", score: 30 });
    expect(transitions[1]).toMatchObject({ from: "within", to: "outside", score: 55 });
  });

  it("seed() sets the committed status without emitting (restart dedupe)", async () => {
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 60, band: "HIGH" }, // moderate: outside
      ],
      profileFor: () => "moderate",
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");
    service.seed("0xABC", "aave_v3", "outside"); // pretend we already alerted before a restart

    await service.tick(); // still outside, no re-fire
    expect(transitions).toHaveLength(0);
  });

  it("confirmTicks debounces: a candidate that reverts before N ticks never emits", async () => {
    // moderate threshold 50. Sequence: within, outside, within (a 1-tick spike).
    const totals = [30, 60, 30];
    let call = 0;
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: totals[call] ?? 30, band: "ELEVATED" },
      ],
      profileFor: () => "moderate",
      onTransition: (t) => transitions.push(t),
      confirmTicks: 3,
    });
    service.watch("0xABC");

    await service.tick(); // 30 within (candidate, needs 3), not committed
    call = 1;
    await service.tick(); // 60 outside (new candidate, count resets to 1)
    call = 2;
    await service.tick(); // 30 within again (candidate flips), spike never confirmed

    expect(transitions).toHaveLength(0);
  });

  it("confirmTicks: a status held for N consecutive ticks emits exactly once", async () => {
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 60, band: "HIGH" }, // moderate: outside, sustained
      ],
      profileFor: () => "moderate",
      onTransition: (t) => transitions.push(t),
      confirmTicks: 3,
    });
    service.watch("0xABC");

    await service.tick(); // count 1
    await service.tick(); // count 2
    expect(transitions).toHaveLength(0);
    await service.tick(); // count 3, commit + emit
    await service.tick(); // already committed, silent
    await service.tick();

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: null, to: "outside", score: 60 });
  });

  it("confirmTicks suppresses threshold flapping (no emissions across oscillation)", async () => {
    // Oscillate 49/51 around the moderate threshold every tick; under confirmTicks=3
    // the candidate never survives 3 consecutive ticks, so nothing fires.
    const totals = [49, 51, 49, 51, 49, 51, 49, 51];
    let call = 0;
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: totals[call++] ?? 49, band: "ELEVATED" },
      ],
      profileFor: () => "moderate",
      onTransition: (t) => transitions.push(t),
      confirmTicks: 3,
    });
    service.watch("0xABC");

    for (let i = 0; i < totals.length; i++) await service.tick();
    expect(transitions).toHaveLength(0);
  });

  it("scores a wallet ONCE and evaluates it against every distinct subscriber profile", async () => {
    // 60 is outside for a conservative watcher (threshold 25) and for a
    // moderate one (50), but within for an aggressive one (75). One chain read,
    // three answers — that is the whole point of the watchlist split.
    const scoreWallet = vi.fn(async (wallet: string) => [
      { protocol: "aave_v3" as const, wallet, total: 60, band: "HIGH" as const },
    ]);
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet,
      profileFor: () => "moderate",
      profilesFor: () => ["conservative", "moderate", "aggressive"],
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");

    await service.tick();

    expect(scoreWallet).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(3);
    expect(transitions.map((t) => [t.profile, t.to])).toEqual([
      ["conservative", "outside"],
      ["moderate", "outside"],
      ["aggressive", "within"],
    ]);
  });

  it("keeps each profile's committed status separate (one must not silence the other)", async () => {
    // 30 is outside for conservative (25) and within for moderate (50). Under
    // the old single key, whichever profile ran first committed a status the
    // other then read as "unchanged" and never alerted on.
    const totals = [30, 30];
    let call = 0;
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: totals[call] ?? 30, band: "ELEVATED" },
      ],
      profileFor: () => "moderate",
      profilesFor: () => ["conservative", "moderate"],
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");

    await service.tick();
    call = 1;
    await service.tick(); // unchanged for both: silent

    expect(transitions).toHaveLength(2);
    expect(transitions.map((t) => [t.profile, t.to])).toEqual([
      ["conservative", "outside"],
      ["moderate", "within"],
    ]);
  });

  it("seed() scoped to a profile only silences that profile", async () => {
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 60, band: "HIGH" },
      ],
      profileFor: () => "moderate",
      profilesFor: () => ["conservative", "moderate"],
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");
    service.seed("0xABC", "aave_v3", "outside", "moderate");

    await service.tick();

    // The moderate stream was already at "outside" before the restart; the
    // conservative one had no record and reports its first observation.
    expect(transitions.map((t) => t.profile)).toEqual(["conservative"]);
  });

  it("de-duplicates repeated profiles so one crossing is not sent twice", async () => {
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 60, band: "HIGH" },
      ],
      profileFor: () => "moderate",
      profilesFor: () => ["moderate", "moderate", "moderate"],
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");

    await service.tick();
    expect(transitions).toHaveLength(1);
  });

  it("an empty profilesFor falls back to profileFor rather than watching nothing", async () => {
    // Zero profiles would mean a wallet in the registry that nobody is ever
    // evaluated for — silence dressed up as configuration.
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 60, band: "HIGH" },
      ],
      profileFor: () => "conservative",
      profilesFor: () => [],
      onTransition: (t) => transitions.push(t),
    });
    service.watch("0xABC");

    await service.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ profile: "conservative", to: "outside" });
  });

  it("confirmTicks debounces each profile independently", async () => {
    // 30: conservative says outside on every tick, moderate says within.
    const transitions: WatchTransition[] = [];
    const service = new WatchService({
      scoreWallet: async (wallet) => [
        { protocol: "aave_v3", wallet, total: 30, band: "ELEVATED" },
      ],
      profileFor: () => "moderate",
      profilesFor: () => ["conservative", "moderate"],
      onTransition: (t) => transitions.push(t),
      confirmTicks: 3,
    });
    service.watch("0xABC");

    await service.tick();
    await service.tick();
    expect(transitions).toHaveLength(0);
    await service.tick();

    expect(transitions.map((t) => [t.profile, t.to])).toEqual([
      ["conservative", "outside"],
      ["moderate", "within"],
    ]);
  });

  it("routes scoring failures to onError without killing the loop", async () => {
    const onError = vi.fn();
    const good = vi.fn(async (_wallet: string) => []);
    const service = new WatchService({
      scoreWallet: async (w) => {
        if (w === "0xbad") throw new Error("rpc down");
        return good(w);
      },
      profileFor: () => "moderate",
      onTransition: () => {},
      onError,
    });
    service.watch("0xbad");
    service.watch("0xgood");

    await service.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1); // the good wallet still got scored
  });
});
