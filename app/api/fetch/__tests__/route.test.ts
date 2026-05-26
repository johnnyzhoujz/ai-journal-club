import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));
vi.mock("@/lib/fetchers/x", () => ({
  fetchXContent: vi.fn(),
}));
vi.mock("@/lib/fetchers/youtube", () => ({
  fetchYouTubeContent: vi.fn(),
}));
vi.mock("@/lib/fetchers/rss", () => ({
  fetchRSSContent: vi.fn(),
}));
vi.mock("@/lib/fetchers/papers", () => ({
  fetchPapersContent: vi.fn(),
}));
vi.mock("@/lib/paper-processing-state", () => ({
  ensurePaperProcessingStateForFeedItem: vi.fn(),
}));
vi.mock("@/lib/paper-evidence-llm-extractor", () => ({
  extractPaperEvidenceWithLlm: vi.fn(),
}));

import { GET, dynamic } from "../route";
import { sql } from "@/lib/db";
import { fetchXContent } from "@/lib/fetchers/x";
import { fetchYouTubeContent } from "@/lib/fetchers/youtube";
import { fetchRSSContent } from "@/lib/fetchers/rss";
import { fetchPapersContent } from "@/lib/fetchers/papers";
import { ensurePaperProcessingStateForFeedItem } from "@/lib/paper-processing-state";
import { extractPaperEvidenceWithLlm } from "@/lib/paper-evidence-llm-extractor";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockFetchX = fetchXContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchYT = fetchYouTubeContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchRSS = fetchRSSContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchPapers = fetchPapersContent as unknown as ReturnType<typeof vi.fn>;
const mockEnsurePaperProcessingStateForFeedItem =
  ensurePaperProcessingStateForFeedItem as unknown as ReturnType<typeof vi.fn>;
const mockExtractPaperEvidenceWithLlm =
  extractPaperEvidenceWithLlm as unknown as ReturnType<typeof vi.fn>;
const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/fetch", {
    method: "GET",
    headers,
  });
}

describe("GET /api/fetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    process.env.CRON_SECRET = "test-secret";
    process.env.X_BEARER_TOKEN = "x-token";
    process.env.SUPADATA_API_KEY = "supadata-key";
    mockEnsurePaperProcessingStateForFeedItem.mockResolvedValue({
      action: "created",
      sourceHash: "paper-source-hash",
      state: null,
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.X_BEARER_TOKEN;
    delete process.env.SUPADATA_API_KEY;
    delete process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED;
  });

  // -- Auth -------------------------------------------------------------------

  it("forces dynamic execution for cron requests", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("rejects requests without credentials", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects requests with an invalid token", async () => {
    const res = await GET(
      makeRequest({ Authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests using non-Bearer auth", async () => {
    const res = await GET(
      makeRequest({ Authorization: "Basic test-secret" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET env var is not configured", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      makeRequest({ Authorization: "Bearer anything" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("CRON_SECRET");
  });

  it("rejects Bearer undefined when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      makeRequest({ Authorization: "Bearer undefined" }),
    );
    expect(res.status).toBe(500);
  });

  // -- Successful fetch -------------------------------------------------------

  it("fetches tweets, podcasts, newsletters, and papers and reports how many of each", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
      { id: 2, type: "podcast", name: "Pod", podcast_type: "youtube_channel", channel_handle: "pod", url: "https://youtube.com/@pod", active: true },
      { id: 3, type: "newsletter", name: "News", feed_url: "https://example.com/feed", active: true },
      { id: 4, type: "papers", name: "HF Papers", active: true },
    ];

    // SELECT sources
    mockSql.mockResolvedValueOnce(sources);
    // INSERT calls resolve
    mockSql.mockResolvedValue([]);

    mockFetchX.mockResolvedValueOnce([
      { source_type: "tweet", external_id: "t1", content: "tweet", url: "https://x.com/t1", author_name: "A" },
      { source_type: "tweet", external_id: "t2", content: "tweet2", url: "https://x.com/t2", author_name: "B" },
    ]);
    mockFetchYT.mockResolvedValueOnce([
      { source_type: "podcast", external_id: "v1", content: "transcript", url: "https://youtube.com/v1", author_name: "C" },
    ]);
    mockFetchRSS.mockResolvedValueOnce([
      { source_type: "newsletter", external_id: "n1", content: "article", url: "https://example.com/1", author_name: "D" },
      { source_type: "newsletter", external_id: "n2", content: "article2", url: "https://example.com/2", author_name: "E" },
      { source_type: "newsletter", external_id: "n3", content: "article3", url: "https://example.com/3", author_name: "F" },
    ]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tweets).toBe(2);
    expect(body.podcasts).toBe(1);
    expect(body.newsletters).toBe(3);
    expect(body.papers).toBe(1);

    const startLog = JSON.parse(String(infoSpy.mock.calls[0][0]));
    const successLog = JSON.parse(String(infoSpy.mock.calls[1][0]));
    expect(startLog).toMatchObject({
      event: "start",
      job: "fetch",
      requestPath: "/api/fetch",
    });
    expect(successLog).toMatchObject({
      event: "success",
      job: "fetch",
      tweets: 2,
      podcasts: 1,
      newsletters: 3,
      papers: 1,
      errorCount: 0,
    });
    expect(successLog.durationMs).toEqual(expect.any(Number));
  });

  // -- Source grouping --------------------------------------------------------

  it("sends only X accounts to the tweet fetcher", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User1", handle: "user1", active: true },
      { id: 2, type: "x_account", name: "User2", handle: "user2", active: true },
      { id: 3, type: "newsletter", name: "News", feed_url: "https://example.com/feed", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchX.mockResolvedValueOnce([]);
    mockFetchRSS.mockResolvedValueOnce([]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    expect(mockFetchX).toHaveBeenCalledWith(
      sources.filter((s) => s.type === "x_account"),
      "x-token",
    );
  });

  it("sends only podcasts to the YouTube fetcher", async () => {
    const sources = [
      { id: 1, type: "podcast", name: "Pod", podcast_type: "youtube_channel", channel_handle: "pod", url: "https://youtube.com/@pod", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchYT.mockResolvedValueOnce([]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    expect(mockFetchYT).toHaveBeenCalledWith(sources, "supadata-key");
  });

  // -- Papers behavior --------------------------------------------------------

  it("fetches papers when papers source is enabled", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    expect(mockFetchPapers).toHaveBeenCalledWith({
      currentYearOnly: true,
      fetchFullText: false,
    });
  });

  it("enqueues paper processing state for returned paper rows", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const insertedItem = {
      id: 101,
      external_id: "2605.12345",
      source_type: "paper",
      title: "Paper",
      content: "abstract",
      url: "https://arxiv.org/abs/2605.12345",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      tier_metadata_json: null,
      inserted: true,
    };

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(res.status).toBe(200);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      insertedItem,
    );
  });

  it("does not invoke semantic LLM extraction while enqueueing papers", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const insertedItem = {
      id: 101,
      external_id: "2605.12345",
      source_type: "paper",
      title: "Paper",
      content: "abstract",
      url: "https://arxiv.org/abs/2605.12345",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      tier_metadata_json: null,
      inserted: true,
    };

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(res.status).toBe(200);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      insertedItem,
    );
    expect(mockExtractPaperEvidenceWithLlm).not.toHaveBeenCalled();
  });

  it("skips papers when no papers source is enabled", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchX.mockResolvedValueOnce([]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    expect(mockFetchPapers).not.toHaveBeenCalled();
  });

  // -- Partial failure --------------------------------------------------------

  it("still fetches other sources when one source type fails", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
      { id: 2, type: "newsletter", name: "News", feed_url: "https://example.com/feed", active: true },
      { id: 3, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchX.mockRejectedValueOnce(new Error("X API rate limited"));
    mockFetchRSS.mockResolvedValueOnce([
      { source_type: "newsletter", external_id: "n1", content: "article", url: "https://example.com/1", author_name: "D" },
    ]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tweets).toBe(0);
    expect(body.newsletters).toBe(1);
    expect(body.papers).toBe(1);
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toContain("X API rate limited");
  });

  it("logs failures when the route handler throws", async () => {
    mockSql.mockRejectedValueOnce(new Error("Database unavailable"));

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret", "x-vercel-id": "req_123" }),
    );

    expect(res.status).toBe(500);
    const failureLog = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(failureLog).toMatchObject({
      event: "failure",
      job: "fetch",
      requestPath: "/api/fetch",
      vercelRequestId: "req_123",
      error: "Database unavailable",
    });
    expect(failureLog.durationMs).toEqual(expect.any(Number));
  });

  // -- Dedup ------------------------------------------------------------------

  it("inserting duplicate items produces no duplicates", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    // The second call to mockSql is the INSERT
    const insertCall = mockSql.mock.calls[1];
    // Tagged template: first arg is the template strings array
    const sqlTemplate = insertCall[0].join("$");
    expect(sqlTemplate).toContain("INSERT INTO feed_items");
    expect(sqlTemplate).toContain("ON CONFLICT");
    expect(sqlTemplate).toContain("DO UPDATE SET");
    expect(sqlTemplate).toContain("EXCLUDED.source_type = 'paper'");
  });

  // -- Insert resilience ------------------------------------------------------

  it("a single bad item does not prevent other items from being saved", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql
      .mockResolvedValueOnce(sources)   // SELECT sources
      .mockRejectedValueOnce(new Error("invalid input")) // first INSERT fails
      .mockResolvedValueOnce([])        // second INSERT succeeds
      .mockResolvedValueOnce([]);       // third INSERT succeeds

    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "bad", content: "x", url: "https://arxiv.org/abs/bad", author_name: "A" },
      { source_type: "paper", external_id: "good1", content: "y", url: "https://arxiv.org/abs/good1", author_name: "B" },
      { source_type: "paper", external_id: "good2", content: "z", url: "https://arxiv.org/abs/good2", author_name: "C" },
    ]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // All 3 INSERT calls were attempted (1 SELECT + 3 INSERTs = 4 total)
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(body.papers).toBe(3);
  });

  // -- Edge cases -------------------------------------------------------------

  it("returns all zeros when no sources are configured", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tweets).toBe(0);
    expect(body.podcasts).toBe(0);
    expect(body.newsletters).toBe(0);
    expect(body.papers).toBe(0);
  });

  it("returns 500 when the database is unreachable", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
