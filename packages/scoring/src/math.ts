/** Core math utilities — arch §Build Order step 1. Pure, no I/O. */

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n − 1). Returns 0 for fewer than 2 points. */
export function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sumSq = xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return Math.sqrt(sumSq / (xs.length - 1));
}

/**
 * Pearson correlation coefficient over paired samples.
 * Returns 0 when either series has zero variance or lengths mismatch
 * (degraded input is treated as "no correlation signal", not an error —
 * the adapter layer is responsible for flagging data quality).
 */
export function pearsonCorr(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** Annualised volatility from daily returns — arch: std_dev × √365. */
export function annualizedVol(dailyReturns: readonly number[]): number {
  return stdDev(dailyReturns) * Math.sqrt(365);
}

/**
 * True maximum drawdown over an ORDERED price series (oldest → newest):
 * max over i of (runningPeak_i − p_i) / runningPeak_i, as a 0–1 fraction.
 *
 * Order is the whole point: (max − min) / max is a *range*, so a monotonic
 * rally reports the same "drawdown" as a crash of the same amplitude. The
 * running peak only looks backwards, so a rally scores 0.
 * Non-positive / non-finite points are skipped (degraded input, not an error).
 */
export function maxDrawdown(prices: readonly number[]): number {
  let peak = 0;
  let worst = 0;
  for (const price of prices) {
    if (!Number.isFinite(price) || price <= 0) continue;
    if (price > peak) peak = price;
    if (peak > 0) worst = Math.max(worst, (peak - price) / peak);
  }
  return worst;
}

/** Daily fractional returns from a price series (p[i] / p[i−1] − 1). */
export function dailyReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] as number;
    if (prev > 0) out.push((prices[i] as number) / prev - 1);
  }
  return out;
}
