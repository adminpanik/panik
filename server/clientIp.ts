/**
 * Client-IP resolution from proxy headers, for the rate limiter and the
 * redemption attempt log.
 *
 * ── THE ASSUMPTION THIS FILE ENCODES ──────────────────────────────────────
 * X-Forwarded-For is a client-supplied header that each trusted proxy APPENDS
 * to. Only the entries our own infrastructure appended are trustworthy, and
 * those are always the RIGHT-most ones. So the client address is the entry
 * `TRUSTED_PROXY_HOPS` from the right — never a hardcoded position.
 *
 * The production topology (see vercel.json: every /api/* is rewritten to the
 * Railway service) has TWO proxies:
 *
 *   browser --> Vercel edge --> Railway edge --> this app
 *               appends <client>  appends <vercel-egress>
 *   x-forwarded-for: "<client>, <vercel-egress>"   → hops = 2
 *
 * Deployed straight on Railway with no Vercel rewrite in front, it is ONE:
 *
 *   x-forwarded-for: "<client>"                    → hops = 1
 *
 * Locally / in Docker / over private networking there is no proxy at all:
 *
 *   no x-forwarded-for                             → hops = 0, use the socket
 *
 * Getting this wrong is not cosmetic in either direction: count too many hops
 * and every user shares one bucket (the proxy's egress IP) so the whole site
 * rate-limits itself; count too few and the right-most entry is attacker-
 * supplied, which is a total bypass by header rotation. Hence TRUSTED_PROXY_HOPS
 * is configuration, and it MUST be re-confirmed against the live deployment
 * whenever the topology changes (adding/removing the Vercel rewrite, moving to
 * a custom domain pointed straight at Railway, adding a CDN). Log a request's
 * raw x-forwarded-for once after any such change and count the entries — and
 * watch for the "x-forwarded-for has N entries but TRUSTED_PROXY_HOPS=M" error
 * below, which says the setting is too high for the live topology.
 *
 * TRUSTED_CLIENT_IP_HEADER (optional) names a single-value header that carries
 * the true client address, e.g. `x-vercel-forwarded-for`. It is OFF by default
 * and must only be enabled when the origin cannot be reached directly: a header
 * our own edge sets is forgeable by anyone who can talk to the origin without
 * going through that edge, and the Railway public domain is reachable directly.
 */

import { isIP } from "node:net";

export interface ProxyConfig {
  /** Proxies in front of this app that append to x-forwarded-for. */
  hops: number;
  /** Lower-case header that overrides XFF, or null. */
  trustedHeader: string | null;
}

/** Default when TRUSTED_PROXY_HOPS is unset: the Vercel → Railway → app path. */
export const DEFAULT_PROXY_HOPS = 2;

function parseProxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const raw = env.TRUSTED_PROXY_HOPS;
  let hops = DEFAULT_PROXY_HOPS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 8) hops = n;
    else console.error(`TRUSTED_PROXY_HOPS=${raw} is not an integer in 0..8 — using ${hops}`);
  }
  return { hops, trustedHeader: env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase() || null };
}

let cached: ProxyConfig | null = null;

/** The process-wide proxy config, parsed once from env. */
export function proxyConfig(): ProxyConfig {
  return (cached ??= parseProxyConfig(process.env));
}

let warnedShortChain = false;

/**
 * Shorter forwarded-for chain than TRUSTED_PROXY_HOPS claims. We clamp to the
 * left-most entry (availability over strictness — a fail-closed read here would
 * 503 the whole site on a misconfiguration), but that entry is then
 * caller-supplied, so the setting is WRONG and must be corrected. Logged once.
 */
function warnShortChain(seen: number, expected: number): void {
  if (warnedShortChain) return;
  warnedShortChain = true;
  console.error(
    `x-forwarded-for has ${seen} entr${seen === 1 ? "y" : "ies"} but TRUSTED_PROXY_HOPS=${expected}: ` +
      "the client address is being read from a caller-supplied position. Set TRUSTED_PROXY_HOPS to the real hop count.",
  );
}

export interface IpRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Present on Express/Node requests; absent on the serverless shims. */
  socket?: { remoteAddress?: string | null | undefined } | null | undefined;
}

function header(headers: IpRequest["headers"], name: string): string | undefined {
  // Node lower-cases incoming header names, so one lookup is enough.
  const v = headers[name];
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/**
 * Normalize an address to a comparable form, or null when it is not an IP at
 * all. Rejects rather than truncates: a value that is not an address is forged
 * or a bug, and silently slicing it to 45 chars just promotes an
 * attacker-chosen string to a rate-limit bucket.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.length > 64) return null; // the longest legal textual IP + zone is well under this
  // Strip [brackets]/:port and an IPv6 zone index ("fe80::1%eth0").
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    value = value.slice(1, close);
  }
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (isIP(value) === 0) {
    // "1.2.3.4:5678" — some proxies append the source port.
    const colon = value.lastIndexOf(":");
    if (colon > 0 && isIP(value.slice(0, colon)) === 4) return value.slice(0, colon);
    return null;
  }
  return value.toLowerCase();
}

/**
 * Best-effort client IP. Returns null when it cannot be established — callers
 * MUST treat that as "unknown client" and fail closed rather than lumping every
 * such request into one shared bucket.
 *
 * Deliberately does NOT fall back to x-real-ip: with a proxy in front, our edge
 * sets x-forwarded-for; without one, x-real-ip is 100% caller-controlled and
 * rotating it hands out an unlimited rate-limit budget.
 */
export function clientIp(req: IpRequest, config: ProxyConfig = proxyConfig()): string | null {
  if (config.trustedHeader) {
    const trusted = normalizeIp(header(req.headers, config.trustedHeader));
    if (trusted) return trusted;
  }

  if (config.hops > 0) {
    const xff = header(req.headers, "x-forwarded-for");
    if (xff) {
      const parts = xff.split(",");
      // Trusted proxies append, so count from the RIGHT. Entries a client
      // prepends only push the real one further left, which this survives.
      if (parts.length < config.hops) warnShortChain(parts.length, config.hops);
      const ip = normalizeIp(parts[Math.max(0, parts.length - config.hops)]);
      if (ip) return ip;
    }
    // XFF missing/garbage while a proxy is expected: the peer address is the
    // proxy's, not the client's, so it identifies nothing. Fail closed.
    return null;
  }

  // No proxy configured: the TCP peer IS the client.
  return normalizeIp(req.socket?.remoteAddress);
}

/**
 * Rate-limit bucket for an address.
 *
 * IPv6 collapses to the /64: a single host is routinely handed an entire /64,
 * i.e. 2^64 source addresses, so per-address keying makes rotation free.
 * IPv4 stays per-address on purpose — v4 space is scarce and carrier NAT puts
 * unrelated subscribers behind one address, so widening to /24 would merge
 * strangers into one budget for no attacker cost (v4 rotation is never free).
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;

  // IPv4-mapped ("::ffff:1.2.3.4") is an IPv4 client; bucket it as one.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;

  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

/** Expand a (possibly ::-compressed) IPv6 literal to its 8 hextets. */
function expandIpv6(ip: string): string[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => g.replace(/^0+(?=.)/, ""));
}

export function userAgent(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = header(headers, "user-agent");
  return raw ? raw.slice(0, 400) : null;
}
