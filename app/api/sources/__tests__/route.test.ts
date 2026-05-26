import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Set DATABASE_URL so the route uses the real DB path (which we mock)
vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { GET, POST, DELETE } from "../route";
import { sql } from "@/lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function makeRequest(options: {
  method: string;
  body?: object;
  searchParams?: Record<string, string>;
}) {
  const url = new URL("http://localhost:3000/api/sources");
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url, {
    method: options.method,
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
}

describe("GET /api/sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active sources grouped by type", async () => {
    mockSql.mockResolvedValueOnce([
      { id: 1, type: "x_account", name: "Elon", handle: "elonmusk", active: true, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, type: "podcast", name: "Lex Pod", podcast_type: "youtube_channel", url: "https://youtube.com/@lex", channel_handle: "lex", active: true, created_at: "2026-01-01T00:00:00Z" },
      { id: 3, type: "newsletter", name: "AI Weekly", feed_url: "https://ai.com/feed", active: true, created_at: "2026-01-01T00:00:00Z" },
      { id: 4, type: "papers", name: "HF Daily Papers", active: true, created_at: "2026-01-01T00:00:00Z" },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.x_accounts).toHaveLength(1);
    expect(body.x_accounts[0].handle).toBe("elonmusk");
    expect(body.podcasts).toHaveLength(1);
    expect(body.newsletters).toHaveLength(1);
    expect(body.papers.enabled).toBe(true);
    expect(body.papers.id).toBe(4);
  });

  it("returns empty groups when no sources exist", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.x_accounts).toEqual([]);
    expect(body.podcasts).toEqual([]);
    expect(body.newsletters).toEqual([]);
    expect(body.papers.enabled).toBe(false);
    expect(body.papers.id).toBeNull();
  });

  it("returns 500 when database query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an x_account source", async () => {
    const created = { id: 1, type: "x_account", name: "Test User", handle: "testuser", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([created]);

    const req = makeRequest({ method: "POST", body: { type: "x_account", name: "Test User", handle: "testuser" } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.type).toBe("x_account");
    expect(body.handle).toBe("testuser");
  });

  it("creates a podcast source (youtube_channel)", async () => {
    const created = { id: 2, type: "podcast", name: "My Pod", podcast_type: "youtube_channel", url: "https://youtube.com/@pod", channel_handle: "pod", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([created]);

    const req = makeRequest({ method: "POST", body: { type: "podcast", name: "My Pod", podcast_type: "youtube_channel", url: "https://youtube.com/@pod", channel_handle: "pod" } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.type).toBe("podcast");
    expect(body.podcast_type).toBe("youtube_channel");
  });

  it("creates a podcast source (youtube_playlist)", async () => {
    const created = { id: 3, type: "podcast", name: "My Playlist", podcast_type: "youtube_playlist", url: "https://youtube.com/playlist?list=PL123", playlist_id: "PL123", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([created]);

    const req = makeRequest({ method: "POST", body: { type: "podcast", name: "My Playlist", podcast_type: "youtube_playlist", url: "https://youtube.com/playlist?list=PL123", playlist_id: "PL123" } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.podcast_type).toBe("youtube_playlist");
    expect(body.playlist_id).toBe("PL123");
  });

  it("creates a newsletter source", async () => {
    const created = { id: 4, type: "newsletter", name: "AI Weekly", feed_url: "https://ai.com/feed", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([created]);

    const req = makeRequest({ method: "POST", body: { type: "newsletter", name: "AI Weekly", feed_url: "https://ai.com/feed" } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.type).toBe("newsletter");
    expect(body.feed_url).toBe("https://ai.com/feed");
  });

  it("creates a papers source", async () => {
    const created = { id: 5, type: "papers", name: "HF Daily Papers", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([created]);

    const req = makeRequest({ method: "POST", body: { type: "papers", name: "HF Daily Papers" } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.type).toBe("papers");
  });

  it("rejects request without type", async () => {
    const req = makeRequest({ method: "POST", body: { name: "No Type" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects request without name", async () => {
    const req = makeRequest({ method: "POST", body: { type: "x_account", handle: "test" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects x_account without handle", async () => {
    const req = makeRequest({ method: "POST", body: { type: "x_account", name: "No Handle" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/handle/i);
  });

  it("rejects x_account with only @ as handle", async () => {
    const req = makeRequest({ method: "POST", body: { type: "x_account", name: "At Only", handle: "@" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/handle/i);
  });

  it("rejects podcast without podcast_type", async () => {
    const req = makeRequest({ method: "POST", body: { type: "podcast", name: "Bad Pod", url: "https://youtube.com/@test" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/podcast_type/i);
  });

  it("rejects podcast without url", async () => {
    const req = makeRequest({ method: "POST", body: { type: "podcast", name: "Bad Pod", podcast_type: "youtube_channel", channel_handle: "test" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/url/i);
  });

  it("rejects newsletter without feed_url", async () => {
    const req = makeRequest({ method: "POST", body: { type: "newsletter", name: "No Feed" } });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/feed_url/i);
  });

  it("returns 409 for duplicate handle", async () => {
    const pgError = new Error("duplicate key value violates unique constraint");
    (pgError as unknown as Record<string, string>).code = "23505";
    mockSql.mockRejectedValueOnce(pgError);

    const req = makeRequest({ method: "POST", body: { type: "x_account", name: "Dupe", handle: "existing" } });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("DELETE /api/sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("soft-deletes a source", async () => {
    const deleted = { id: 1, type: "x_account", name: "Test", handle: "test", active: false, created_at: "2026-01-01T00:00:00Z" };
    mockSql.mockResolvedValueOnce([deleted]);

    const req = makeRequest({ method: "DELETE", searchParams: { id: "1" } });
    const res = await DELETE(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("returns 404 for non-existent source", async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = makeRequest({ method: "DELETE", searchParams: { id: "999" } });
    const res = await DELETE(req);

    expect(res.status).toBe(404);
  });

  it("returns 400 when no id provided", async () => {
    const req = makeRequest({ method: "DELETE" });
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric id", async () => {
    const req = makeRequest({ method: "DELETE", searchParams: { id: "abc" } });
    const res = await DELETE(req);

    expect(res.status).toBe(400);
  });
});
