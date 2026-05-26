import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { POST as login } from "../app/api/auth/login/route";
import { createAuthSessionToken } from "../lib/auth";

function makeLoginRequest(password: string): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("auth cookie round-trip", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-secret-123";
    process.env.AUTH_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
  });

  it("middleware accepts cookie set by login route", async () => {
    // 1. Call login to get the Set-Cookie header
    const loginRes = await login(makeLoginRequest("test-secret-123"));
    expect(loginRes.status).toBe(200);

    const setCookie = loginRes.headers.get("set-cookie")!;
    expect(setCookie).toBeDefined();

    // 2. Parse cookie name=value from Set-Cookie header
    const cookieValue = setCookie.split(";")[0]; // "auth=<signed-token>"

    // 3. Feed it into middleware on a protected route
    const protectedReq = new NextRequest("http://localhost:3000/", {
      headers: { cookie: cookieValue },
    });
    const mwRes = await middleware(protectedReq);

    // Should pass through (not redirect to /login)
    expect(mwRes.status).not.toBe(307);
    expect(mwRes.headers.get("location")).toBeNull();
  });

  it("middleware rejects request without auth cookie", async () => {
    const req = new NextRequest("http://localhost:3000/");
    const res = await middleware(req);

    // Should redirect to /login
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("middleware lets first-deploy users reach Initial Setup when auth is not configured", async () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;

    const req = new NextRequest("http://localhost:3000/setup");
    const res = await middleware(req);

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("middleware redirects protected pages to setup when auth is not configured", async () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;

    const req = new NextRequest("http://localhost:3000/sources");
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/setup");
  });

  it("middleware rejects tampered auth cookies from the login format", async () => {
    const token = await createAuthSessionToken();
    const [payload] = token.split(".");
    const req = new NextRequest("http://localhost:3000/api/search", {
      headers: { cookie: `auth=${payload}.tampered` },
    });
    const res = await middleware(req);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
