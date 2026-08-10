/**
 * Relayer health (Phase 4.B): the derived balance threshold and the observer
 * that turns 4.A's event stream into pages.
 *
 * The balance tests are really tests about the DERIVATION. A flat "alert under
 * 0.01 ETH" is wrong in both directions — never firing on a quiet day, firing
 * too late during a gas spike — so what is asserted is that the threshold moves
 * with the caps and with the live gas price, which is the whole reason it is
 * computed rather than configured.
 *
 * The observer tests are about the difference between "nothing to do" and
 * "cannot do it". A permit skipped forever for `trigger_not_met` is the system
 * working; a permit skipped forever for `simulation_reverted` is an invisible
 * coverage gap, and only the second one may page.
 */

import { describe, expect, it } from "vitest";
import {
  BURST_HOURS,
  COVERAGE_BLOCKING_SKIPS,
  REPEATED_SKIP_THRESHOLD,
  RelayerWatch,
  balanceAlerts,
  hourlyBurstWei,
  requiredPoolBalanceWei,
} from "./relayerHealth";
import {
  DEFAULT_RELAYER_LIMITS,
  type RelayerEvent,
  type RelayerLimits,
  type SkipReason,
} from "./relayerPolicy";

const NOW = 1_800_000_000_000;
const WALLET = "0x00000000000000000000000000000000000000a1";
const SIGNER = "0x00000000000000000000000000000000000000b1";
/** ~0.05 gwei, a quiet Base day. */
const QUIET_FEE = 50_000_000n;

const limits = (over: Partial<RelayerLimits> = {}): RelayerLimits => ({
  ...DEFAULT_RELAYER_LIMITS,
  ...over,
});

describe("the derived balance threshold", () => {
  it("is the product of the caps and the live fee", () => {
    const l = limits({ maxSubmissionsPerHour: 20, maxGasPerTx: 3_000_000n });
    expect(hourlyBurstWei(l, QUIET_FEE)).toBe(20n * 3_000_000n * QUIET_FEE);
    expect(requiredPoolBalanceWei(l, QUIET_FEE)).toBe(hourlyBurstWei(l, QUIET_FEE) * BURST_HOURS);
  });

  it("rises with the gas price rather than being invalidated by it", () => {
    const l = limits();
    const quiet = requiredPoolBalanceWei(l, QUIET_FEE);
    const spike = requiredPoolBalanceWei(l, QUIET_FEE * 100n);
    expect(spike).toBe(quiet * 100n);
  });

  it("rises when an operator raises the caps", () => {
    const tight = requiredPoolBalanceWei(limits({ maxSubmissionsPerHour: 5 }), QUIET_FEE);
    const loose = requiredPoolBalanceWei(limits({ maxSubmissionsPerHour: 50 }), QUIET_FEE);
    expect(loose).toBe(tight * 10n);
  });
});

describe("balanceAlerts", () => {
  it("says nothing when the pool is funded", () => {
    const l = limits();
    const funded = requiredPoolBalanceWei(l, QUIET_FEE);
    expect(balanceAlerts([{ address: SIGNER, balanceWei: funded }], l, QUIET_FEE, NOW)).toEqual([]);
  });

  it("pages CRITICAL for a signer under the floor the relayer itself enforces", () => {
    const l = limits();
    // Below minSignerBalanceWei the relayer already refuses to submit, so the
    // coverage that signer provided is gone right now — not "at risk".
    const alerts = balanceAlerts(
      [{ address: SIGNER, balanceWei: l.minSignerBalanceWei - 1n }],
      l,
      QUIET_FEE,
      NOW,
    );
    const low = alerts.find((a) => a.kind === "relayer.balance_low");
    expect(low?.severity).toBe("critical");
    expect(low?.key).toBe(`relayer.balance_low:${SIGNER}`);
    expect(low?.summary).toContain("refuse to submit");
  });

  it("warns when the pool cannot fund the burst its own caps allow", () => {
    const l = limits();
    const alerts = balanceAlerts(
      // Comfortably over the per-signer floor, well under the burst budget.
      [{ address: SIGNER, balanceWei: l.minSignerBalanceWei * 2n }],
      l,
      QUIET_FEE * 1_000n,
      NOW,
    );
    const burst = alerts.find((a) => a.kind === "relayer.balance_under_burst");
    expect(burst?.severity).toBe("warning");
    expect(burst?.detail?.burstHours).toBe(Number(BURST_HOURS));
  });

  it("sums the pool rather than judging one signer", () => {
    const l = limits();
    const each = requiredPoolBalanceWei(l, QUIET_FEE) / 2n + 1n;
    const alerts = balanceAlerts(
      [
        { address: SIGNER, balanceWei: each },
        { address: "0x00000000000000000000000000000000000000b2", balanceWei: each },
      ],
      l,
      QUIET_FEE,
      NOW,
    );
    expect(alerts).toEqual([]);
  });

  it("says nothing at all when no signer is configured", () => {
    expect(balanceAlerts([], limits(), QUIET_FEE, NOW)).toEqual([]);
  });
});

const skip = (reason: SkipReason, nonce: string | null = "7"): RelayerEvent => ({
  type: "relayer.skipped",
  wallet: WALLET,
  nonce,
  reason,
});

describe("RelayerWatch", () => {
  it("pages CRITICAL on every submission failure, without a streak", () => {
    const watch = new RelayerWatch();
    const alerts = watch.observe(
      {
        type: "relayer.failed",
        wallet: WALLET,
        nonce: "7",
        txHash: "0xdead",
        reason: "reverted",
      },
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("relayer.submission_failed");
    expect(alerts[0]!.severity).toBe("critical");
    // Keyed per ATTEMPT: a second failure is a second wasted transaction and
    // must not be suppressed as a repeat of the first.
    expect(alerts[0]!.key).toContain("0xdead");
  });

  it("never pages for a permit that is simply not triggered", () => {
    const watch = new RelayerWatch();
    for (let i = 0; i < 20; i++) {
      expect(watch.observe(skip("trigger_not_met"), NOW)).toEqual([]);
    }
  });

  it("pages once a coverage-blocking skip repeats past the threshold", () => {
    const watch = new RelayerWatch();
    for (let i = 1; i < REPEATED_SKIP_THRESHOLD; i++) {
      expect(watch.observe(skip("simulation_reverted"), NOW)).toEqual([]);
    }
    const alerts = watch.observe(skip("simulation_reverted"), NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("relayer.repeated_skip");
    expect(alerts[0]!.detail?.consecutive).toBe(REPEATED_SKIP_THRESHOLD);
    expect(alerts[0]!.summary).toContain("not protecting anything");
    // The ongoing condition, so the ledger suppresses every later observation.
    expect(alerts[0]!.key).toBe(`relayer.repeated_skip:${WALLET}:7:simulation_reverted`);
  });

  it("requires the skips to be CONSECUTIVE and for the SAME reason", () => {
    const watch = new RelayerWatch();
    watch.observe(skip("simulation_reverted"), NOW);
    watch.observe(skip("simulation_reverted"), NOW);
    // A benign skip in between means the position recovered; not a streak.
    watch.observe(skip("trigger_not_met"), NOW);
    expect(watch.observe(skip("simulation_reverted"), NOW)).toEqual([]);
  });

  it("resets the streak after a successful submission", () => {
    const watch = new RelayerWatch();
    watch.observe(skip("gas_cap_exceeded"), NOW);
    watch.observe(skip("gas_cap_exceeded"), NOW);
    watch.observe(
      {
        type: "relayer.succeeded",
        wallet: WALLET,
        nonce: "7",
        txHash: "0xfeed",
        gasUsed: "1",
        feeWei: "1",
      },
      NOW,
    );
    expect(watch.observe(skip("gas_cap_exceeded"), NOW)).toEqual([]);
  });

  it("tracks each permit's streak separately", () => {
    const watch = new RelayerWatch();
    for (let i = 0; i < REPEATED_SKIP_THRESHOLD - 1; i++) {
      watch.observe(skip("simulation_reverted"), NOW);
      watch.observe(skip("simulation_reverted", "8"), NOW);
    }
    expect(watch.observe(skip("simulation_reverted"), NOW)).toHaveLength(1);
  });

  it("surfaces the sequencer verdict without re-deriving it", () => {
    const watch = new RelayerWatch();
    const alerts = watch.observe(
      {
        type: "relayer.skipped",
        wallet: "*",
        nonce: null,
        reason: "sequencer_stale",
        detail: "latest block is 400s old",
      },
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("sequencer.stale");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.summary).toContain("400s old");
  });

  it("classifies chain-wide reasons out of the per-permit streak", () => {
    // These have their own dedicated alerts; counting them per permit would
    // page once per user for one fault.
    expect(COVERAGE_BLOCKING_SKIPS.has("sequencer_stale")).toBe(false);
    expect(COVERAGE_BLOCKING_SKIPS.has("chain_mismatch")).toBe(false);
    expect(COVERAGE_BLOCKING_SKIPS.has("relayer_balance_low")).toBe(false);
    expect(COVERAGE_BLOCKING_SKIPS.has("relayer_disabled")).toBe(false);
    // ...and these are exactly the ones nothing else would notice.
    expect(COVERAGE_BLOCKING_SKIPS.has("simulation_reverted")).toBe(true);
    expect(COVERAGE_BLOCKING_SKIPS.has("protocol_not_permitted")).toBe(true);
  });
});
