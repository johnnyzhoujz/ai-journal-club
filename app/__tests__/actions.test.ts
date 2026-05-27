import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/fetch-content", () => ({
  fetchAllContent: vi.fn(),
}));
vi.mock("@/lib/digest", () => ({
  generateDigestWithMetadata: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));
vi.mock("@/app/api/hydrate-papers/route", () => ({
  runHydratePapersWorker: vi.fn(),
}));
vi.mock("@/app/api/enrich-papers/route", () => ({
  runEnrichPapersWorker: vi.fn(),
}));

import { generateDigestAction, runFetchAction } from "../actions";
import { fetchAllContent } from "@/lib/fetch-content";
import { generateDigestWithMetadata } from "@/lib/digest";
import { sql } from "@/lib/db";
import { runHydratePapersWorker } from "@/app/api/hydrate-papers/route";
import { runEnrichPapersWorker } from "@/app/api/enrich-papers/route";

const mockFetchAllContent = fetchAllContent as unknown as ReturnType<typeof vi.fn>;
const mockGenerateDigestWithMetadata =
  generateDigestWithMetadata as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRunHydratePapersWorker =
  runHydratePapersWorker as unknown as ReturnType<typeof vi.fn>;
const mockRunEnrichPapersWorker =
  runEnrichPapersWorker as unknown as ReturnType<typeof vi.fn>;

const hydrateResult = {
  paperLimit: null,
  limitReached: false,
  claimed: 1,
  succeeded: 1,
  failed: 0,
  dead: 0,
  fullTextSucceeded: 1,
  fullTextUnavailable: 0,
  fullTextFailed: 0,
  deadlineReached: false,
  noWork: true,
  durationMs: 100,
  errors: [],
};

const enrichResult = {
  enabled: true,
  skipped: false,
  skipReason: null,
  paperLimit: null,
  limitReached: false,
  claimed: 1,
  succeeded: 1,
  failed: 0,
  dead: 0,
  deadlineReached: false,
  noWork: true,
  durationMs: 100,
  droppedSpans: 0,
  droppedClaims: 0,
  droppedAnchors: 0,
  embeddingInputCount: 3,
  embeddingFailedCount: 0,
  llmInputTokens: 100,
  llmOutputTokens: 50,
  errors: [],
};

const noWorkHydrateResult = {
  ...hydrateResult,
  claimed: 0,
  succeeded: 0,
  fullTextSucceeded: 0,
  noWork: true,
};

const noWorkEnrichResult = {
  ...enrichResult,
  claimed: 0,
  succeeded: 0,
  embeddingInputCount: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
  noWork: true,
};

const emptySkippedPapers = {
  total: 0,
  ids: [] as number[],
  rows: [] as unknown[],
  countsByDeterministicStatus: {},
  countsBySemanticStatus: {},
  pendingIds: [] as number[],
  deadIds: [] as number[],
};

function digestGeneration(
  digest: Record<string, unknown> | null,
  skippedPapers = emptySkippedPapers,
) {
  return { digest, skippedPapers };
}

describe("generateDigestAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchAllContent.mockResolvedValue({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
    });
    mockRunHydratePapersWorker.mockResolvedValue(noWorkHydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValue(noWorkEnrichResult);
  });

  it("returns digest data on success", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(digestGeneration({
      content: "AI Digest",
      tweetCount: 3,
      podcastCount: 1,
      newsletterCount: 2,
      paperCount: 1,
      itemCount: 7,
      sourceItemIds: [1, 2, 3, 4, 5, 6, 7],
      model: "claude-haiku-4-5-20251001",
    }));
    mockSql.mockResolvedValueOnce([]);

    const result = await generateDigestAction();

    expect(result).toEqual({
      content: "AI Digest",
      item_count: 7,
      tweet_count: 3,
      podcast_count: 1,
      newsletter_count: 2,
      paper_count: 1,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("stores the digest in the database with correct column values including source_item_ids", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(digestGeneration({
      content: "digest content",
      tweetCount: 4,
      podcastCount: 2,
      newsletterCount: 3,
      paperCount: 5,
      itemCount: 14,
      sourceItemIds: [1, 2, 3],
      model: "claude-haiku-4-5-20251001",
    }));
    mockSql.mockResolvedValueOnce([]);

    await generateDigestAction();

    expect(mockSql).toHaveBeenCalledTimes(1);
    const insertCall = mockSql.mock.calls[0];
    const sqlTemplate = insertCall[0].join("$");
    expect(sqlTemplate).toContain("INSERT INTO digests");
    expect(sqlTemplate).toContain("source_item_ids");

    // Verify all interpolated values match the correct column order:
    // (content, item_count, tweet_count, podcast_count, newsletter_count, paper_count, source_item_ids, model)
    expect(insertCall[1]).toBe("digest content");
    expect(insertCall[2]).toBe(14);           // item_count = itemCount
    expect(insertCall[3]).toBe(4);            // tweet_count = tweetCount
    expect(insertCall[4]).toBe(2);            // podcast_count = podcastCount
    expect(insertCall[5]).toBe(3);            // newsletter_count = newsletterCount
    expect(insertCall[6]).toBe(5);            // paper_count = paperCount
    expect(insertCall[7]).toEqual([1, 2, 3]); // source_item_ids = sourceItemIds
    expect(insertCall[8]).toBe("claude-haiku-4-5-20251001"); // model
  });

  it("passes force=true to generateDigestWithMetadata when called with force", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(digestGeneration(null));

    await generateDigestAction(true);

    expect(mockGenerateDigestWithMetadata).toHaveBeenCalledWith(undefined, true);
  });

  it("passes force as undefined by default", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(digestGeneration({
      content: "AI Digest",
      tweetCount: 1,
      podcastCount: 0,
      newsletterCount: 0,
      paperCount: 0,
      itemCount: 1,
      sourceItemIds: [1],
      model: "claude-haiku-4-5-20251001",
    }));
    mockSql.mockResolvedValueOnce([]);

    await generateDigestAction();

    expect(mockGenerateDigestWithMetadata).toHaveBeenCalledWith(undefined, undefined);
  });

  it("works without CRON_SECRET configured", async () => {
    delete process.env.CRON_SECRET;
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null))
      .mockResolvedValueOnce(digestGeneration(null));

    const result = await generateDigestAction();

    // Should succeed — server actions don't need CRON_SECRET
    expect(result).toEqual({ message: "No new content to digest" });
  });

  it("returns message when no new content", async () => {
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null))
      .mockResolvedValueOnce(digestGeneration(null));

    const result = await generateDigestAction();

    expect(result).toEqual({ message: "No new content to digest" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns processing message when pending papers block digest generation", async () => {
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null, {
        ...emptySkippedPapers,
        total: 28,
        pendingIds: [1, 2],
      }))
      .mockResolvedValueOnce(digestGeneration(null, {
        ...emptySkippedPapers,
        total: 28,
        pendingIds: [1, 2],
      }));
    mockRunHydratePapersWorker.mockResolvedValueOnce(hydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValueOnce(enrichResult);

    const result = await generateDigestAction();

    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      message: "28 papers are still being processed before a digest can be generated.",
      paperProcessing: {
        hydrate: hydrateResult,
        enrich: enrichResult,
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("processes pending papers and retries digest generation", async () => {
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null, {
        ...emptySkippedPapers,
        total: 2,
        pendingIds: [1, 2],
      }))
      .mockResolvedValueOnce(digestGeneration({
        content: "AI Digest",
        tweetCount: 0,
        podcastCount: 0,
        newsletterCount: 0,
        paperCount: 2,
        itemCount: 2,
        sourceItemIds: [1, 2],
        model: "claude-haiku-4-5-20251001",
      }));
    mockRunHydratePapersWorker.mockResolvedValueOnce(hydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValueOnce(enrichResult);
    mockSql.mockResolvedValueOnce([]);

    const result = await generateDigestAction();

    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
    expect(mockGenerateDigestWithMetadata).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      content: "AI Digest",
      item_count: 2,
      paperProcessing: {
        hydrate: hydrateResult,
        enrich: enrichResult,
      },
    });
  });

  it("fetches first-run content, processes papers, and retries digest generation", async () => {
    const fetchResult = {
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 2,
    };
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null))
      .mockResolvedValueOnce(digestGeneration({
        content: "AI Digest",
        tweetCount: 0,
        podcastCount: 0,
        newsletterCount: 0,
        paperCount: 2,
        itemCount: 2,
        sourceItemIds: [1, 2],
        model: "claude-haiku-4-5-20251001",
      }));
    mockFetchAllContent.mockResolvedValueOnce(fetchResult);
    mockRunHydratePapersWorker.mockResolvedValueOnce(hydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValueOnce(enrichResult);
    mockSql.mockResolvedValueOnce([]);

    const result = await generateDigestAction();

    expect(mockFetchAllContent).toHaveBeenCalledTimes(1);
    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      content: "AI Digest",
      item_count: 2,
      fetch: fetchResult,
      paperProcessing: {
        hydrate: hydrateResult,
        enrich: enrichResult,
      },
    });
  });

  it("returns error when generateDigest throws", async () => {
    mockGenerateDigestWithMetadata.mockRejectedValueOnce(new Error("API key invalid"));

    const result = await generateDigestAction();

    expect(result).toEqual({ error: "Failed to generate digest. Please try again." });
  });

  it("returns error when DB insert throws", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(digestGeneration({
      content: "content",
      tweetCount: 0,
      podcastCount: 0,
      newsletterCount: 0,
      paperCount: 0,
      itemCount: 0,
      sourceItemIds: [],
      model: "claude-haiku-4-5-20251001",
    }));
    mockSql.mockRejectedValueOnce(new Error("DB write failed"));

    const result = await generateDigestAction();

    expect(result).toEqual({ error: "Failed to generate digest. Please try again." });
  });

  it("does NOT make any HTTP fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGenerateDigestWithMetadata
      .mockResolvedValueOnce(digestGeneration(null))
      .mockResolvedValueOnce(digestGeneration(null));

    await generateDigestAction();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("runFetchAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunHydratePapersWorker.mockResolvedValue(noWorkHydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValue(noWorkEnrichResult);
  });

  it("returns fetch counts on success", async () => {
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 5,
      podcasts: 3,
      newsletters: 2,
      papers: 0,
    });

    const result = await runFetchAction();

    expect(result).toEqual({
      tweets: 5,
      podcasts: 3,
      newsletters: 2,
      papers: 0,
    });
    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
  });

  it("runs paper hydration and enrichment after fetching papers", async () => {
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 28,
    });
    mockRunHydratePapersWorker.mockResolvedValueOnce(hydrateResult);
    mockRunEnrichPapersWorker.mockResolvedValueOnce(enrichResult);

    const result = await runFetchAction();

    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 28,
      paperProcessing: {
        hydrate: hydrateResult,
        enrich: enrichResult,
      },
    });
  });

  it("passes through errors array from fetchAllContent", async () => {
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 1,
      papers: 0,
      errors: ["tweets: X API rate limited"],
    });

    const result = await runFetchAction();

    expect(result).toEqual({
      tweets: 0,
      podcasts: 0,
      newsletters: 1,
      papers: 0,
      errors: ["tweets: X API rate limited"],
    });
    expect(mockRunHydratePapersWorker).toHaveBeenCalledTimes(1);
    expect(mockRunEnrichPapersWorker).toHaveBeenCalledTimes(1);
  });

  it("returns error when fetchAllContent throws", async () => {
    mockFetchAllContent.mockRejectedValueOnce(new Error("DB unreachable"));

    const result = await runFetchAction();

    expect(result).toEqual({ error: "Failed to fetch content. Please try again." });
  });

  it("does NOT make any HTTP fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
    });

    await runFetchAction();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("works without CRON_SECRET configured", async () => {
    delete process.env.CRON_SECRET;
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 1,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
    });

    const result = await runFetchAction();

    // Should succeed — server actions don't need CRON_SECRET
    expect(result).toEqual({
      tweets: 1,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
    });
  });
});
