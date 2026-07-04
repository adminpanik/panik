/**
 * Best-effort client IP from proxy headers (Railway / Vercel both set
 * x-forwarded-for). Returns null when unknown. Used to log redemption attempts.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>): string | null {
  const xff = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) return raw.split(",")[0]!.trim() || null;
  const real = headers["x-real-ip"];
  const realStr = Array.isArray(real) ? real[0] : real;
  return realStr ?? null;
}

export function userAgent(headers: Record<string, string | string[] | undefined>): string | null {
  const ua = headers["user-agent"] ?? headers["User-Agent"];
  const raw = Array.isArray(ua) ? ua[0] : ua;
  return raw ? raw.slice(0, 400) : null;
}
