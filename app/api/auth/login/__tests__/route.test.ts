import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  verifyAuthSessionToken,
} from "@/lib/auth";

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-secret-123";
    process.env.AUTH_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
  });

  it("returns 400 when body is missing", async () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is empty", async () => {
    const res = await POST(makeRequest({ password: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 when password is wrong", async () => {
    const res = await POST(makeRequest({ password: "wrong-password" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 200 with Set-Cookie when password is correct", async () => {
    const res = await POST(makeRequest({ password: "test-secret-123" }));
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeDefined();
    expect(cookie).toContain("auth=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie!.toLowerCase()).toContain("samesite=lax");

    const token = cookie!.match(/auth=([^;]+)/)?.[1];
    expect(token).toBeDefined();
    await expect(verifyAuthSessionToken(token!)).resolves.toBeTruthy();
  });

  it("sets 30-day Max-Age on cookie", async () => {
    const res = await POST(makeRequest({ password: "test-secret-123" }));
    const cookie = res.headers.get("set-cookie")!;
    const maxAge = cookie.match(/Max-Age=(\d+)/)?.[1];
    expect(Number(maxAge)).toBe(AUTH_SESSION_MAX_AGE_SECONDS);
  });

  it("returns JSON { success: true }", async () => {
    const res = await POST(makeRequest({ password: "test-secret-123" }));
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  it("returns 401 when AUTH_PASSWORD env var is not set", async () => {
    delete process.env.AUTH_PASSWORD;
    const res = await POST(makeRequest({ password: "anything" }));
    expect(res.status).toBe(401);
  });

  it("returns 500 when AUTH_SESSION_SECRET env var is not set", async () => {
    delete process.env.AUTH_SESSION_SECRET;
    const res = await POST(makeRequest({ password: "test-secret-123" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Auth is not configured",
    });
  });

  it("includes Secure flag when NODE_ENV is production", async () => {
    const originalEnv = process.env.NODE_ENV;
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";
    try {
      const res = await POST(makeRequest({ password: "test-secret-123" }));
      const cookie = res.headers.get("set-cookie")!;
      expect(cookie).toContain("Secure");
    } finally {
      env.NODE_ENV = originalEnv;
    }
  });

  it("does not include Secure flag when NODE_ENV is not production", async () => {
    const res = await POST(makeRequest({ password: "test-secret-123" }));
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).not.toContain("Secure");
  });
});
