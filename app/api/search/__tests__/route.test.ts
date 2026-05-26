import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSearchArchiveForResearch } = vi.hoisted(() => ({
  mockSearchArchiveForResearch: vi.fn(),
}));

vi.mock("@/lib/archive-search", () => ({
  VALID_ARCHIVE_SEARCH_SOURCES: ["all", "tweet", "podcast", "newsletter", "paper"],
  searchArchiveForResearch: mockSearchArchiveForResearch,
}));

import { GET } from "../route";

function makeRequest(params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost:3000/api/search");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

describe("GET /api/search", () => {
  beforeEach(() => {
    mockSearchArchiveForResearch.mockReset();
  });

  it("returns 400 when q param is missing", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Missing required query parameter: q",
    });
    expect(mockSearchArchiveForResearch).not.toHaveBeenCalled();
  });

  it("returns 400 when q param is blank after trimming", async () => {
    const res = await GET(makeRequest({ q: "   " }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Missing required query parameter: q",
    });
    expect(mockSearchArchiveForResearch).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid source type", async () => {
    const res = await GET(makeRequest({ q: "agents", source: "banana" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid source type");
    expect(mockSearchArchiveForResearch).not.toHaveBeenCalled();
  });

  it("returns helper results unchanged for the Research UI", async () => {
    const results = [
      {
        id: 1,
        source_type: "tweet",
        title: null,
        author_name: "karpathy",
        url: "https://x.com/karpathy/status/123",
        published_at: "2026-03-20T12:00:00Z",
        snippet: "building <b>agents</b> with LLMs",
      },
    ];
    mockSearchArchiveForResearch.mockResolvedValueOnce(results);

    const res = await GET(makeRequest({ q: "agents" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(results);
  });

  it("passes normalized defaults to the shared helper", async () => {
    mockSearchArchiveForResearch.mockResolvedValueOnce([]);

    await GET(makeRequest({ q: "  agents  " }));

    expect(mockSearchArchiveForResearch).toHaveBeenCalledWith({
      query: "agents",
      source: "all",
      after: null,
      before: null,
      limit: 20,
    });
  });

  it("passes filters through and clamps limit to the route cap", async () => {
    mockSearchArchiveForResearch.mockResolvedValueOnce([]);

    await GET(
      makeRequest({
        q: "agents",
        source: "tweet",
        after: "2026-01-01",
        before: "2026-03-01",
        limit: "500",
      }),
    );

    expect(mockSearchArchiveForResearch).toHaveBeenCalledWith({
      query: "agents",
      source: "tweet",
      after: "2026-01-01",
      before: "2026-03-01",
      limit: 100,
    });
  });

  it("enforces the lower bound for limit", async () => {
    mockSearchArchiveForResearch.mockResolvedValueOnce([]);

    await GET(makeRequest({ q: "agents", limit: "0" }));

    expect(mockSearchArchiveForResearch).toHaveBeenCalledWith({
      query: "agents",
      source: "all",
      after: null,
      before: null,
      limit: 1,
    });
  });

  it("returns 500 when the shared helper throws", async () => {
    mockSearchArchiveForResearch.mockRejectedValueOnce(new Error("connection refused"));

    const res = await GET(makeRequest({ q: "agents" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Search query failed",
    });
  });
});
