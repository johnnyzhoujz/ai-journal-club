import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { POST } from "../route";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/detect-x-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/detect-x-profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.X_BEARER_TOKEN = "test-bearer-token";
  });

  afterEach(() => {
    delete process.env.X_BEARER_TOKEN;
  });

  it("returns name and handle for valid username", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "123", username: "karpathy", name: "Andrej Karpathy", description: "AI researcher" }],
      }),
    });

    const res = await POST(makeRequest({ handle: "karpathy" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      name: "Andrej Karpathy",
      handle: "karpathy",
      description: "AI researcher",
    });
  });

  it("strips @ from handle input", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "123", username: "karpathy", name: "Andrej Karpathy", description: "" }],
      }),
    });

    const res = await POST(makeRequest({ handle: "@karpathy" }));
    expect(res.status).toBe(200);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("usernames=karpathy"),
      expect.any(Object),
    );
  });

  it("returns 400 when handle is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when handle is empty", async () => {
    const res = await POST(makeRequest({ handle: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid handle format", async () => {
    const res = await POST(makeRequest({ handle: "has spaces" }));
    expect(res.status).toBe(400);

    const res2 = await POST(makeRequest({ handle: "too_long_handle_name!" }));
    expect(res2.status).toBe(400);
  });

  it("returns 404 when X API user not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ detail: "Could not find user", value: "nonexistent" }],
      }),
    });

    const res = await POST(makeRequest({ handle: "nonexistent" }));
    expect(res.status).toBe(404);
  });

  it("returns 500 when X_BEARER_TOKEN is not set", async () => {
    delete process.env.X_BEARER_TOKEN;

    const res = await POST(makeRequest({ handle: "karpathy" }));
    expect(res.status).toBe(500);
  });

  it("returns 502 on X API network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const res = await POST(makeRequest({ handle: "karpathy" }));
    expect(res.status).toBe(502);
  });

  it("returns 429 when X API rate limits", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    const res = await POST(makeRequest({ handle: "karpathy" }));
    expect(res.status).toBe(429);
  });

  it("sends correct Authorization header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "1", username: "test", name: "Test", description: "" }],
      }),
    });

    await POST(makeRequest({ handle: "test" }));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer test-bearer-token" },
      }),
    );
  });
});
