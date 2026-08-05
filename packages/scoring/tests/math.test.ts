import { describe, expect, it } from "vitest";
import {
  annualizedVol,
  clamp,
  maxDrawdown,
  mean,
  pearsonCorr,
  stdDev,
} from "../src/math";

describe("clamp", () => {
  it("passes through in-range values", () => expect(clamp(42, 0, 100)).toBe(42));
  it("clamps below", () => expect(clamp(-5, 0, 100)).toBe(0));
  it("clamps above", () => expect(clamp(150, 0, 100)).toBe(100));
});

describe("mean / stdDev", () => {
  it("mean of known series", () => expect(mean([1, 2, 3, 4])).toBe(2.5));
  it("stdDev of known series (sample, n−1)", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, sum sq dev 32, 32/7 → √4.571… ≈ 2.138
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 3);
  });
  it("stdDev of constant series is 0", () => expect(stdDev([3, 3, 3])).toBe(0));
  it("stdDev degrades to 0 for <2 points", () => expect(stdDev([1])).toBe(0));
});

describe("pearsonCorr", () => {
  it("perfectly correlated → 1", () =>
    expect(pearsonCorr([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9));
  it("perfectly anti-correlated → −1", () =>
    expect(pearsonCorr([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9));
  it("zero-variance series → 0 (degraded, not NaN)", () =>
    expect(pearsonCorr([1, 1, 1], [1, 2, 3])).toBe(0));
  it("length mismatch → 0 (degraded, not error)", () =>
    expect(pearsonCorr([1, 2], [1, 2, 3])).toBe(0));
});

describe("annualizedVol", () => {
  it("is stdDev × √365", () => {
    const returns = [0.01, -0.02, 0.015, 0.005, -0.01];
    expect(annualizedVol(returns)).toBeCloseTo(stdDev(returns) * Math.sqrt(365), 9);
  });
  it("zero for flat returns", () => expect(annualizedVol([0, 0, 0, 0])).toBe(0));
});

describe("maxDrawdown", () => {
  // Time ordering is the whole point: the old (max − min) / max range scored
  // a rally exactly like a crash of the same amplitude.
  const cases: [string, number[], number][] = [
    ["flat series", [100, 100, 100], 0],
    ["monotonic 2x rally (range says 50%)", [100, 120, 150, 180, 200], 0],
    ["rally with shallow dips — only the dips count", [100, 90, 140, 130, 200], 0.1],
    ["monotonic 50% crash", [200, 150, 120, 100], 0.5],
    ["crash then full recovery (peak-to-trough survives)", [200, 100, 200], 0.5],
    ["rally then crash — measured from the LATER peak", [100, 400, 200], 0.5],
    ["two dips — the deeper one wins", [100, 80, 100, 55, 100], 0.45],
    ["single point", [1234], 0],
    ["empty series", [], 0],
    ["non-positive points ignored", [0, -5, 100, 25], 0.75],
  ];

  it.each(cases)("%s → %f", (_label, prices, expected) => {
    expect(maxDrawdown(prices)).toBeCloseTo(expected, 9);
  });

  it("is order-sensitive: reversing a crash into a rally zeroes it", () => {
    const crash = [200, 160, 120, 100];
    expect(maxDrawdown(crash)).toBeCloseTo(0.5, 9);
    expect(maxDrawdown([...crash].reverse())).toBe(0);
  });
});
