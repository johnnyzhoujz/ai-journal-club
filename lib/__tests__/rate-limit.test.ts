import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  sql: mockSql,
}));

import {
  LOCAL_DEV_CLIENT_IP,
  MissingClientIpError,
  consumeRateLimit,
  deriveCanonicalClientIp,
  deriveClientIpInfo,
  extractCanonicalClientIp,
  hashClientIp,
} from "../rate-limit";

function makeHeaders(init: Record<string, string> = {}) {
  return new Headers(init);
}

describe("rate-limit helpers", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.unstubAllEnvs();
  });

  it("prefers x-vercel-forwarded-for and trims the first comma-separated IP", () => {
    const headers = makeHeaders({
      "x-vercel-forwarded-for": " 203.0.113.10, 198.51.100.2 ",
      "x-forwarded-for": "198.51.100.99",
      "x-real-ip": "192.0.2.44",
    });

    expect(extractCanonicalClientIp(headers)).toBe("203.0.113.10");
  });

  it("falls back through x-forwarded-for and x-real-ip", () => {
    const headers = makeHeaders({
      "x-real-ip": "192.0.2.44",
    });

    expect(extractCanonicalClientIp(headers)).toBe("192.0.2.44");
  });

  it("uses the local-dev sentinel outside production when no client IP header exists", () => {
    vi.stubEnv("NODE_ENV", "test");

    expect(deriveCanonicalClientIp(makeHeaders())).toBe(LOCAL_DEV_CLIENT_IP);
  });

  it("fails closed in production when no canonical client IP can be derived", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => deriveCanonicalClientIp(makeHeaders())).toThrow(MissingClientIpError);
  });

  it("hashes client IPs with a keyed HMAC", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", "briefing-secret");

    const expected = createHmac("sha256", "briefing-secret")
      .update("203.0.113.10")
      .digest("hex");

    expect(hashClientIp("203.0.113.10")).toBe(expected);
  });

  it("derives both the canonical client IP and its keyed hash", () => {
    vi.stubEnv("AUTH_SESSION_SECRET", "briefing-secret");

    const info = deriveClientIpInfo(
      makeHeaders({
        "x-forwarded-for": "203.0.113.10, 198.51.100.1",
      }),
    );

    expect(info.clientIp).toBe("203.0.113.10");
    expect(info.clientIpHash).toBe(
      createHmac("sha256", "briefing-secret")
        .update("203.0.113.10")
        .digest("hex"),
    );
  });

  it("stores rate-limit counters by hashed client IP, route key, and fixed one-minute bucket", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", "briefing-secret");
    mockSql.mockResolvedValueOnce([
      {
        count: 6,
        bucket: "2026-04-14 10:05:00+00",
      },
    ]);

    const result = await consumeRateLimit({
      headers: makeHeaders({
        "x-forwarded-for": "203.0.113.10, 198.51.100.1",
      }),
      routeKey: "briefing/tool",
      limit: 5,
    });

    expect(result.allowed).toBe(false);
    expect(result.count).toBe(6);
    expect(result.routeKey).toBe("briefing/tool");

    const interpolatedValues = mockSql.mock.calls[0].slice(1);
    expect(interpolatedValues[0]).toBe(
      createHmac("sha256", "briefing-secret")
        .update("203.0.113.10")
        .digest("hex"),
    );
    expect(interpolatedValues[0]).not.toBe("203.0.113.10");
    expect(interpolatedValues[1]).toBe("briefing/tool");

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("date_trunc('minute', NOW())");
    expect(template).toContain("ON CONFLICT");
    expect(template).toContain("count = rate_limit_buckets.count + 1");
  });
});
