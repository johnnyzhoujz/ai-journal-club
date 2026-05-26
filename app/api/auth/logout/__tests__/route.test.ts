import { describe, it, expect } from "vitest";
import { POST } from "../route";

describe("POST /api/auth/logout", () => {
  it("returns 200 and clears cookie with Max-Age=0", async () => {
    const res = await POST();
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeDefined();
    expect(cookie).toContain("auth=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie!.toLowerCase()).toContain("samesite=lax");
  });

  it("includes Secure on the clearing cookie in production", async () => {
    const originalEnv = process.env.NODE_ENV;
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";

    try {
      const res = await POST();
      expect(res.headers.get("set-cookie")).toContain("Secure");
    } finally {
      env.NODE_ENV = originalEnv;
    }
  });

  it("returns JSON { success: true }", async () => {
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });
});
