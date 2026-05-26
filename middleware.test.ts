import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { createAuthSessionToken } from "@/lib/auth";

function makeRequest(
  path: string,
  options?: { cookie?: string; authorization?: string },
): NextRequest {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers();
  if (options?.cookie) {
    headers.set("cookie", options.cookie);
  }
  if (options?.authorization) {
    headers.set("authorization", options.authorization);
  }
  return new NextRequest(new Request(url, { headers }));
}

describe("middleware", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.AUTH_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
  });

  // -- Public paths pass through -----------------------------------------------

  it("allows requests to /login without cookie", async () => {
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeFalsy();
  });

  it("allows requests to /api/auth/login without cookie", async () => {
    const res = await middleware(makeRequest("/api/auth/login"));
    expect(res.status).toBe(200);
  });

  it("allows requests to /api/auth/logout without cookie", async () => {
    const res = await middleware(makeRequest("/api/auth/logout"));
    expect(res.status).toBe(200);
  });

  // -- Static assets pass through ----------------------------------------------

  it("allows requests to /_next/ static assets", async () => {
    const res = await middleware(makeRequest("/_next/static/chunk.js"));
    expect(res.status).toBe(200);
  });

  it("allows requests to /favicon.ico", async () => {
    const res = await middleware(makeRequest("/favicon.ico"));
    expect(res.status).toBe(200);
  });

  // -- Unauthenticated page requests redirect ----------------------------------

  it("redirects page requests to /login when no cookie", async () => {
    const res = await middleware(makeRequest("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects /digests to /login when no cookie", async () => {
    const res = await middleware(makeRequest("/digests"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("allows initial setup when auth is not configured", async () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;

    const res = await middleware(makeRequest("/setup"));
    expect(res.status).toBe(200);
  });

  it("redirects protected pages to setup when auth is not configured", async () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;

    const res = await middleware(makeRequest("/digests"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/setup");
  });

  // -- Unauthenticated API requests return 401 ---------------------------------

  it("returns 401 JSON for /api/synthesize without cookie", async () => {
    const res = await middleware(makeRequest("/api/synthesize"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 JSON for /api/search without cookie", async () => {
    const res = await middleware(makeRequest("/api/search"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // -- Authenticated requests pass through -------------------------------------

  it("allows page requests with valid auth cookie", async () => {
    const token = await createAuthSessionToken();
    const res = await middleware(makeRequest("/", { cookie: `auth=${token}` }));
    expect(res.status).toBe(200);
  });

  it("allows API requests with valid auth cookie", async () => {
    const token = await createAuthSessionToken();
    const res = await middleware(
      makeRequest("/api/search", { cookie: `auth=${token}` }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects forged auth cookies", async () => {
    const token = await createAuthSessionToken();
    const [payload] = token.split(".");
    const res = await middleware(
      makeRequest("/api/search", { cookie: `auth=${payload}.invalidsignature` }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects expired signed auth cookies", async () => {
    const token = await createAuthSessionToken({
      issuedAt: 100,
      expiresAt: 101,
    });
    const res = await middleware(
      makeRequest("/api/search", { cookie: `auth=${token}` }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  // -- CRON endpoints with Bearer header bypass cookie check -------------------

  it("allows /api/fetch with Bearer auth header (no cookie)", async () => {
    const res = await middleware(
      makeRequest("/api/fetch", { authorization: "Bearer cron-secret-123" }),
    );
    expect(res.status).toBe(200);
  });

  it("allows /api/digest with Bearer auth header (no cookie)", async () => {
    const res = await middleware(
      makeRequest("/api/digest", { authorization: "Bearer cron-secret-123" }),
    );
    expect(res.status).toBe(200);
  });

  it("allows /api/memory/backfill with Bearer auth header (no cookie)", async () => {
    const res = await middleware(
      makeRequest("/api/memory/backfill", {
        authorization: "Bearer cron-secret-123",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows /api/hydrate-papers with Bearer auth header (no cookie)", async () => {
    const res = await middleware(
      makeRequest("/api/hydrate-papers", {
        authorization: "Bearer cron-secret-123",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows /api/enrich-papers with Bearer auth header (no cookie)", async () => {
    const res = await middleware(
      makeRequest("/api/enrich-papers", {
        authorization: "Bearer cron-secret-123",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects /api/fetch without Bearer header or cookie", async () => {
    const res = await middleware(makeRequest("/api/fetch"));
    expect(res.status).toBe(401);
  });

  it("rejects /api/hydrate-papers without Bearer header or cookie", async () => {
    const res = await middleware(makeRequest("/api/hydrate-papers"));
    expect(res.status).toBe(401);
  });

  it("rejects /api/enrich-papers without Bearer header or cookie", async () => {
    const res = await middleware(makeRequest("/api/enrich-papers"));
    expect(res.status).toBe(401);
  });

  it("rejects /api/memory/backfill without Bearer header or cookie", async () => {
    const res = await middleware(makeRequest("/api/memory/backfill"));
    expect(res.status).toBe(401);
  });
});
