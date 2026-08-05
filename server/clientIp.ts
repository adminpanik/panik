/** Longest possible textual IP (IPv4-mapped IPv6 + zone) — cap so a forged
 * header can't feed unbounded strings to the rate limiter or the attempt log. */
const MAX_IP_LEN = 45;

/**
 * Best-effort client IP from proxy headers (Railway / Vercel both set
 * x-forwarded-for). Returns null when unknown. Used to log redemption attempts
 * and to key the rate limiter.
 *
 * Takes the RIGHT-most x-forwarded-for entry: our edge appends exactly one hop,
 * so that last entry is the address it observed. Everything to its left is
 * caller-supplied and trivially spoofable.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>): string | null {
  const xff = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (raw) {
    const parts = raw.split(",");
    const last = parts[parts.length - 1]!.trim();
    if (last) return last.slice(0, MAX_IP_LEN);
  }
  const real = headers["x-real-ip"];
  const realStr = Array.isArray(real) ? real[0] : real;
  return realStr ? realStr.slice(0, MAX_IP_LEN) : null;
}

export function userAgent(headers: Record<string, string | string[] | undefined>): string | null {
  const ua = headers["user-agent"] ?? headers["User-Agent"];
  const raw = Array.isArray(ua) ? ua[0] : ua;
  return raw ? raw.slice(0, 400) : null;
}
