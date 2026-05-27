import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("@/lib/fetchers/alphaxiv", () => ({
  fetchAlphaxivContent: vi.fn(),
}));
vi.mock("@/lib/memory-chunks", () => ({
  isMemoryChunkWritesEnabled: vi.fn(),
  refreshKnowledgeChunksForFeedItemIfStale: vi.fn(),
}));
vi.mock("@/lib/paper-corpus-tiering", () => ({
  buildPaperIntakeHotSetPayload: vi.fn(),
}));
vi.mock("@/lib/paper-processing-state", () => ({
  ensurePaperProcessingStateForFeedItem: vi.fn(),
}));

import { fetchAllContent } from "../fetch-content";
import { sql } from "@/lib/db";
import { fetchXContent } from "@/lib/fetchers/x";
import { fetchYouTubeContent } from "@/lib/fetchers/youtube";
import { fetchRSSContent } from "@/lib/fetchers/rss";
import { fetchPapersContent } from "@/lib/fetchers/papers";
import { fetchAlphaxivContent } from "@/lib/fetchers/alphaxiv";
import {
  isMemoryChunkWritesEnabled,
  refreshKnowledgeChunksForFeedItemIfStale,
} from "@/lib/memory-chunks";
import { buildPaperIntakeHotSetPayload } from "@/lib/paper-corpus-tiering";
import { ensurePaperProcessingStateForFeedItem } from "@/lib/paper-processing-state";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockFetchX = fetchXContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchYT = fetchYouTubeContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchRSS = fetchRSSContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchPapers = fetchPapersContent as unknown as ReturnType<typeof vi.fn>;
const mockFetchAlphaxiv =
  fetchAlphaxivContent as unknown as ReturnType<typeof vi.fn>;
const mockIsMemoryChunkWritesEnabled =
  isMemoryChunkWritesEnabled as unknown as ReturnType<typeof vi.fn>;
const mockRefreshKnowledgeChunksForFeedItemIfStale =
  refreshKnowledgeChunksForFeedItemIfStale as unknown as ReturnType<typeof vi.fn>;
const mockBuildPaperIntakeHotSetPayload =
  buildPaperIntakeHotSetPayload as unknown as ReturnType<typeof vi.fn>;
const mockEnsurePaperProcessingStateForFeedItem =
  ensurePaperProcessingStateForFeedItem as unknown as ReturnType<typeof vi.fn>;

describe("fetchAllContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.X_BEARER_TOKEN = "x-token";
    process.env.SUPADATA_API_KEY = "supadata-key";
    mockIsMemoryChunkWritesEnabled.mockReturnValue(false);
    mockRefreshKnowledgeChunksForFeedItemIfStale.mockResolvedValue({
      upsertedChunkCount: 1,
      skippedItem: false,
      refreshed: true,
      sourceHash: "hash",
      sourceKind: "feed_item:paper:v1",
    });
    mockBuildPaperIntakeHotSetPayload.mockReturnValue({
      corpus_tier: "hot_set",
      relevance_score: null,
      canon_score: null,
      hot_set_reason: "new selected paper grace window (14 days)",
      canon_reason: null,
      archive_reason: null,
      ignored_reason: null,
      last_seen_at: "2026-01-01T00:00:00.000Z",
      last_scored_at: null,
      tier_metadata_json: {
        scoreVersion: "intake-hot-set-v1",
        retention: {
          intakeDefaultTier: "hot_set",
          graceDays: 14,
          selectedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    mockEnsurePaperProcessingStateForFeedItem.mockResolvedValue({
      action: "created",
      sourceHash: "paper-source-hash",
      state: null,
    });
  });

  afterEach(() => {
    delete process.env.X_BEARER_TOKEN;
    delete process.env.SUPADATA_API_KEY;
  });

  it("loads active sources and dispatches to correct fetchers by type", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
      { id: 2, type: "podcast", name: "Pod", podcast_type: "youtube_channel", channel_handle: "pod", url: "https://youtube.com/@pod", active: true },
      { id: 3, type: "newsletter", name: "News", feed_url: "https://example.com/feed", active: true },
      { id: 4, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchX.mockResolvedValueOnce([]);
    mockFetchYT.mockResolvedValueOnce([]);
    mockFetchRSS.mockResolvedValueOnce([]);
    mockFetchPapers.mockResolvedValueOnce([]);

    await fetchAllContent();

    expect(mockFetchX).toHaveBeenCalledWith(
      sources.filter((s) => s.type === "x_account"),
      "x-token",
    );
    expect(mockFetchYT).toHaveBeenCalledWith(
      sources.filter((s) => s.type === "podcast"),
      "supadata-key",
    );
    expect(mockFetchRSS).toHaveBeenCalledWith(
      sources.filter((s) => s.type === "newsletter"),
    );
    expect(mockFetchPapers).toHaveBeenCalledWith({
      currentYearOnly: true,
      fetchFullText: false,
    });
  });

  it("returns per-type counts matching fetcher output", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
      { id: 2, type: "podcast", name: "Pod", podcast_type: "youtube_channel", channel_handle: "pod", url: "https://youtube.com/@pod", active: true },
      { id: 3, type: "newsletter", name: "News", feed_url: "https://example.com/feed", active: true },
      { id: 4, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
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

    const result = await fetchAllContent();

    expect(result.tweets).toBe(2);
    expect(result.podcasts).toBe(1);
    expect(result.newsletters).toBe(3);
    expect(result.papers).toBe(1);
  });

  it("handles partial failure — reports errors for failed fetchers and counts for successful ones", async () => {
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

    const result = await fetchAllContent();

    expect(result.tweets).toBe(0);
    expect(result.newsletters).toBe(1);
    expect(result.papers).toBe(1);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toContain("X API rate limited");
  });

  it("returns all zeros when no sources are configured", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await fetchAllContent();

    expect(result.tweets).toBe(0);
    expect(result.podcasts).toBe(0);
    expect(result.newsletters).toBe(0);
    expect(result.papers).toBe(0);
    expect(result.errors).toBeUndefined();
  });

  it("throws when the database is unreachable", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));

    await expect(fetchAllContent()).rejects.toThrow("connection refused");
  });

  it("upserts items with JSONB-merge on paper_meta and xmax-guarded RETURNING", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await fetchAllContent();

    // The second call to mockSql is the INSERT
    const insertCall = mockSql.mock.calls[1];
    const sqlTemplate = insertCall[0].join("$");
    expect(sqlTemplate).toContain("INSERT INTO feed_items");
    expect(sqlTemplate).toContain("ON CONFLICT");
    expect(sqlTemplate).toContain("DO UPDATE SET");
    expect(sqlTemplate).toContain("jsonb_set");
    expect(sqlTemplate).toContain("providers");
    expect(sqlTemplate).toContain("EXCLUDED.source_type = 'paper'");
    expect(sqlTemplate).toContain("xmax = 0");
    expect(sqlTemplate).toContain("RETURNING");
    expect(sqlTemplate).toContain("full_text");
    expect(sqlTemplate).toContain("full_text_source");
    expect(sqlTemplate).toContain("corpus_tier");
    expect(sqlTemplate).toContain("hot_set_reason");
    expect(sqlTemplate).toContain("tier_metadata_json");
    // RETURNING should pull full_text fields for chunking and processing-state hashing.
    const returningStart = sqlTemplate.indexOf("RETURNING");
    expect(sqlTemplate.slice(returningStart)).toContain("full_text");
    expect(sqlTemplate.slice(returningStart)).toContain("full_text_source");
    // ON CONFLICT path should preserve existing full_text except when filling
    // a missing value or upgrading HF fallback text to arXiv HTML.
    expect(sqlTemplate).toContain(
      "WHEN feed_items.full_text_source = 'hf_page'",
    );
    expect(sqlTemplate).toContain(
      "AND EXCLUDED.full_text_source = 'arxiv_html'",
    );
    const conflictUpdate = sqlTemplate.slice(
      sqlTemplate.indexOf("DO UPDATE SET"),
      sqlTemplate.indexOf("WHERE EXCLUDED"),
    );
    expect(conflictUpdate).not.toContain("corpus_tier =");
    expect(conflictUpdate).not.toContain("tier_metadata_json =");
    expect(insertCall[15]).toBe("hot_set");
    expect(insertCall[18]).toBe("new selected paper grace window (14 days)");
    expect(insertCall[20]).toBeNull();
    expect(insertCall[24]).toContain('"intakeDefaultTier":"hot_set"');
    expect(insertCall[24]).not.toContain('"pendingTier"');
    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).not.toHaveBeenCalled();
    expect(insertCall[3]).toBe(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).not.toHaveBeenCalled();
  });

  it("enqueues paper processing state for upserted paper rows", async () => {
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
      corpus_tier: "hot_set",
      tier_metadata_json: {
        scoreVersion: "intake-hot-set-v1",
        retention: { intakeDefaultTier: "hot_set" },
      },
      inserted: true,
    };

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockFetchPapers.mockResolvedValueOnce([
      {
        source_type: "paper",
        external_id: "p1",
        content: "abstract",
        url: "https://arxiv.org/abs/p1",
        author_name: "G",
      },
    ]);

    await fetchAllContent();

    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      insertedItem,
    );
  });

  it("does not treat a processing enqueue failure as successful rich readiness", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      corpus_tier: "hot_set",
      tier_metadata_json: {
        scoreVersion: "intake-hot-set-v1",
        retention: { intakeDefaultTier: "hot_set" },
      },
      inserted: true,
    };

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockFetchPapers.mockResolvedValueOnce([
      {
        source_type: "paper",
        external_id: "p1",
        content: "abstract",
        url: "https://arxiv.org/abs/p1",
        author_name: "G",
      },
    ]);
    mockEnsurePaperProcessingStateForFeedItem.mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    const result = await fetchAllContent();

    expect(result.papers).toBe(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      insertedItem,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to enqueue paper processing state for feed_item_id=101:",
      "queue unavailable",
    );
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("writes memory chunks for newly inserted items when enabled", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const insertedItem = {
      id: 101,
      source_type: "paper",
      title: null,
      content: "abstract",
      external_id: "p1",
      url: "https://arxiv.org/abs/p1",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      corpus_tier: "hot_set",
      tier_metadata_json: {
        scoreVersion: "intake-hot-set-v1",
        retention: { intakeDefaultTier: "hot_set" },
      },
      inserted: true,
    };

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const result = await fetchAllContent();

    expect(result.papers).toBe(1);
    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).toHaveBeenCalledWith(insertedItem);
  });

  it("checks memory chunk freshness when UPSERT updates an existing paper row", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const updatedItem = {
      id: 101,
      source_type: "paper",
      title: null,
      content: "abstract",
      external_id: "p1",
      url: "https://arxiv.org/abs/p1",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: { upvotes: 10 },
      full_text: null,
      full_text_source: null,
      corpus_tier: "core_canon",
      tier_metadata_json: { scoreVersion: "review-v1" },
      inserted: false,
    };

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([updatedItem]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await fetchAllContent();

    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).toHaveBeenCalledWith(updatedItem);
  });

  it("skips chunk refresh when the paper is archive-only", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const archiveItem = {
      id: 103,
      source_type: "paper",
      title: null,
      content: "archive abstract",
      external_id: "p1",
      url: "https://arxiv.org/abs/p1",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      corpus_tier: "archive",
      tier_metadata_json: { scoreVersion: "review-v1" },
      inserted: true,
    };

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([archiveItem]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "archive abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await fetchAllContent();

    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).not.toHaveBeenCalled();
  });

  it("skips chunk refresh when the paper is ignored", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const ignoredItem = {
      id: 103,
      source_type: "paper",
      title: null,
      content: "ignored abstract",
      external_id: "p1",
      url: "https://arxiv.org/abs/p1",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      corpus_tier: "hot_set",
      tier_metadata_json: { ignored: true, scoreVersion: "review-v1" },
      inserted: true,
    };

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([ignoredItem]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "ignored abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await fetchAllContent();

    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).not.toHaveBeenCalled();
  });

  it("does not write memory chunks when a non-paper insert conflicts", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    await fetchAllContent();

    expect(mockBuildPaperIntakeHotSetPayload).toHaveBeenCalledTimes(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).not.toHaveBeenCalled();
    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).not.toHaveBeenCalled();
  });

  it("logs memory chunk failures without failing the fetch", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];
    const insertedItem = {
      id: 102,
      source_type: "paper",
      title: null,
      content: "abstract",
      external_id: "p1",
      url: "https://arxiv.org/abs/p1",
      author_name: "G",
      author_handle: null,
      published_at: null,
      paper_meta: null,
      full_text: null,
      full_text_source: null,
      corpus_tier: "hot_set",
      tier_metadata_json: {
        scoreVersion: "intake-hot-set-v1",
        retention: { intakeDefaultTier: "hot_set" },
      },
      inserted: true,
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockIsMemoryChunkWritesEnabled.mockReturnValue(true);
    mockRefreshKnowledgeChunksForFeedItemIfStale.mockRejectedValueOnce(
      new Error("chunk insert failed"),
    );
    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValueOnce([insertedItem]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "abstract", url: "https://arxiv.org/abs/p1", author_name: "G" },
    ]);

    const result = await fetchAllContent();

    expect(result.papers).toBe(1);
    expect(mockEnsurePaperProcessingStateForFeedItem).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to refresh memory chunks for feed_item_id=102:",
      "chunk insert failed",
    );

    consoleSpy.mockRestore();
  });

  it("a single bad insert does not prevent other items from being saved", async () => {
    const sources = [
      { id: 1, type: "papers", name: "HF Papers", active: true },
    ];

    mockSql
      .mockResolvedValueOnce(sources)       // SELECT sources
      .mockRejectedValueOnce(new Error("invalid input")) // first INSERT fails
      .mockResolvedValueOnce([])            // second INSERT succeeds
      .mockResolvedValueOnce([]);           // third INSERT succeeds

    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "bad", content: "x", url: "https://arxiv.org/abs/bad", author_name: "A" },
      { source_type: "paper", external_id: "good1", content: "y", url: "https://arxiv.org/abs/good1", author_name: "B" },
      { source_type: "paper", external_id: "good2", content: "z", url: "https://arxiv.org/abs/good2", author_name: "C" },
    ]);

    const result = await fetchAllContent();

    // All 3 INSERT calls were attempted (1 SELECT + 3 INSERTs = 4 total)
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(result.papers).toBe(3);
  });

  it("skips papers fetcher when no papers source exists", async () => {
    const sources = [
      { id: 1, type: "x_account", name: "User", handle: "user", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchX.mockResolvedValueOnce([]);

    await fetchAllContent();

    expect(mockFetchPapers).not.toHaveBeenCalled();
    expect(mockFetchAlphaxiv).not.toHaveBeenCalled();
  });

  it("dispatches the alphaxiv-handled papers source to fetchAlphaxivContent", async () => {
    const sources = [
      { id: 4, type: "papers", name: "alphaXiv Trending", handle: "alphaxiv", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchAlphaxiv.mockResolvedValueOnce([]);

    await fetchAllContent();

    expect(mockFetchAlphaxiv).toHaveBeenCalledTimes(1);
    expect(mockFetchAlphaxiv).toHaveBeenCalledWith({ fetchFullText: false });
    expect(mockFetchPapers).not.toHaveBeenCalled();
  });

  it("dispatches HF and alphaXiv in parallel and sums their counts", async () => {
    const sources = [
      { id: 4, type: "papers", name: "HF", handle: "hf", active: true },
      { id: 5, type: "papers", name: "alphaXiv", handle: "alphaxiv", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "x", url: "u1", author_name: "A" },
      { source_type: "paper", external_id: "p2", content: "y", url: "u2", author_name: "B" },
    ]);
    mockFetchAlphaxiv.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p3", content: "z", url: "u3", author_name: "C" },
    ]);

    const result = await fetchAllContent();

    expect(mockFetchPapers).toHaveBeenCalledTimes(1);
    expect(mockFetchAlphaxiv).toHaveBeenCalledTimes(1);
    // Counts must SUM across the two papers fetchers, not overwrite.
    expect(result.papers).toBe(3);
  });

  it("reports a labeled error when alphaXiv fetcher fails but HF still counts", async () => {
    const sources = [
      { id: 4, type: "papers", name: "HF", handle: "hf", active: true },
      { id: 5, type: "papers", name: "alphaXiv", handle: "alphaxiv", active: true },
    ];

    mockSql.mockResolvedValueOnce(sources);
    mockSql.mockResolvedValue([]);
    mockFetchPapers.mockResolvedValueOnce([
      { source_type: "paper", external_id: "p1", content: "x", url: "u1", author_name: "A" },
    ]);
    mockFetchAlphaxiv.mockRejectedValueOnce(new Error("alphaXiv WAF blocked us"));

    const result = await fetchAllContent();

    expect(result.papers).toBe(1);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("papers:alphaxiv"))).toBe(true);
    expect(result.errors!.some((e) => e.includes("alphaXiv WAF blocked us"))).toBe(true);
  });
});
