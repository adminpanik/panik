/**
 * The client-IP resolution is the rate limiter's identity function: if it can
 * be forged, every limit below it is decorative. These cases pin the three
 * topologies (0/1/2 trusted proxies) and the forgery attempts that used to
 * work — a spoofed x-real-ip, a prepended x-forwarded-for entry, and a
 * non-address string that the old code truncated into a bucket key.
 */

import { describe, expect, it } from "vitest";

import { clientIp, ipBucket, normalizeIp, type ProxyConfig } from "./clientIp";

const HOPS = (hops: number, trustedHeader: string | null = null): ProxyConfig => ({ hops, trustedHeader });

const req = (headers: Record<string, string | string[] | undefined>, remoteAddress?: string) => ({
  headers,
  socket: remoteAddress ? { remoteAddress } : undefined,
});

describe("clientIp — proxy hops", () => {
  it("uses the socket peer when no proxy is configured", () => {
    expect(clientIp(req({}, "203.0.113.7"), HOPS(0))).toBe("203.0.113.7");
  });

  it("ignores a forged x-forwarded-for when no proxy is configured", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }, "203.0.113.7"), HOPS(0))).toBe("203.0.113.7");
  });

  it("takes the only hop behind one proxy", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), HOPS(1))).toBe("203.0.113.7");
  });

  it("takes the client, not the edge egress, behind two proxies", () => {
    // browser → Vercel edge (appends client) → Railway edge (appends Vercel).
    const headers = { "x-forwarded-for": "203.0.113.7, 76.76.21.21" };
    expect(clientIp(req(headers), HOPS(2))).toBe("203.0.113.7");
    // The one-proxy reading would hand every user the SAME shared bucket.
    expect(clientIp(req(headers), HOPS(1))).toBe("76.76.21.21");
  });

  it("survives entries the client prepends", () => {
    const headers = { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7, 76.76.21.21" };
    expect(clientIp(req(headers), HOPS(2))).toBe("203.0.113.7");
  });

  it("never trusts x-real-ip — rotating it used to hand out unlimited budget", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }), HOPS(1))).toBeNull();
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }, "203.0.113.7"), HOPS(0))).toBe("203.0.113.7");
  });

  it("fails closed (null) when a proxy is expected but the header is absent", () => {
    expect(clientIp(req({}, "10.0.0.5"), HOPS(2))).toBeNull();
  });

  it("fails closed when the trusted position holds a non-address", () => {
    expect(clientIp(req({ "x-forwarded-for": "not-an-ip, 76.76.21.21" }), HOPS(2))).toBeNull();
  });

  it("uses the trusted header only when configured", () => {
    const headers = { "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "203.0.113.7, 76.76.21.21" };
    expect(clientIp(req(headers), HOPS(2))).toBe("203.0.113.7");
    expect(clientIp(req(headers), HOPS(2, "x-vercel-forwarded-for"))).toBe("198.51.100.9");
  });
});

describe("normalizeIp", () => {
  it("rejects non-addresses instead of truncating them to 45 chars", () => {
    expect(normalizeIp("<script>alert(1)</script>")).toBeNull();
    expect(normalizeIp("a".repeat(200))).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it("accepts v4, v6, bracketed, ported and zoned forms", () => {
    expect(normalizeIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeIp("203.0.113.7:44321")).toBe("203.0.113.7");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });
});

describe("ipBucket", () => {
  it("keys IPv4 per address", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("203.0.113.8")).not.toBe(ipBucket("203.0.113.7"));
  });

  it("collapses an IPv6 /64 so address rotation is not free", () => {
    const a = ipBucket("2001:db8:1:2:3:4:5:6");
    expect(ipBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipBucket("2001:db8:1:2::")).toBe(a);
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(a);
  });

  it("does not merge unrelated IPv4-mapped clients into one bucket", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:198.51.100.9")).toBe("198.51.100.9");
  });
});
