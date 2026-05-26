import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeRequest(body?: object) {
  return new NextRequest("http://localhost:3000/api/detect-feed", {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
}

function xmlResponse(title: string) {
  return new Response(
    `<?xml version="1.0"?><rss><channel><title>${title}</title></channel></rss>`,
    { headers: { "Content-Type": "application/rss+xml" } }
  );
}

function htmlResponse(body: string) {
  return new Response(`<html><head>${body}</head><body></body></html>`, {
    headers: { "Content-Type": "text/html" },
  });
}

describe("POST /api/detect-feed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects feed from Substack-style /feed URL", async () => {
    mockFetch.mockResolvedValueOnce(xmlResponse("My Newsletter"));

    const req = makeRequest({ url: "https://example.substack.com" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.feedUrl).toBe("https://example.substack.com/feed");
    expect(body.name).toBe("My Newsletter");
  });

  it("falls back to HTML link tag when /feed fails", async () => {
    // /feed returns 404
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    // Page HTML has RSS link
    mockFetch.mockResolvedValueOnce(
      htmlResponse(
        '<title>Example Blog</title><link rel="alternate" type="application/rss+xml" href="https://example.com/rss" title="Example Feed">'
      )
    );

    const req = makeRequest({ url: "https://example.com" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.feedUrl).toBe("https://example.com/rss");
    expect(body.name).toBe("Example Feed");
  });

  it("resolves relative feed URL to absolute", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    mockFetch.mockResolvedValueOnce(
      htmlResponse(
        '<title>My Blog</title><link rel="alternate" type="application/rss+xml" href="/feed.xml">'
      )
    );

    const req = makeRequest({ url: "https://myblog.com" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.feedUrl).toBe("https://myblog.com/feed.xml");
  });

  it("returns error when no feed is found", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    mockFetch.mockResolvedValueOnce(
      htmlResponse("<title>No Feed Here</title>")
    );

    const req = makeRequest({ url: "https://nofeed.com" });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when url is missing from body", async () => {
    const req = makeRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("handles network errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const req = makeRequest({ url: "https://down.com" });
    const res = await POST(req);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("blocks localhost URLs (SSRF protection)", async () => {
    const req = makeRequest({ url: "http://localhost:3000/secret" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks private IP URLs (SSRF protection)", async () => {
    const req = makeRequest({ url: "http://192.168.1.1/admin" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks cloud metadata URLs (SSRF protection)", async () => {
    const req = makeRequest({ url: "http://169.254.169.254/latest/meta-data" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks non-http schemes (SSRF protection)", async () => {
    const req = makeRequest({ url: "file:///etc/passwd" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
