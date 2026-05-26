import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/fetch-content", () => ({
  fetchAllContent: vi.fn(),
}));
vi.mock("@/lib/digest", () => ({
  generateDigest: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { generateDigestAction, runFetchAction } from "../actions";
import { fetchAllContent } from "@/lib/fetch-content";
import { generateDigest } from "@/lib/digest";
import { sql } from "@/lib/db";

const mockFetchAllContent = fetchAllContent as unknown as ReturnType<typeof vi.fn>;
const mockGenerateDigest = generateDigest as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

describe("generateDigestAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns digest data on success", async () => {
    mockGenerateDigest.mockResolvedValueOnce({
      content: "AI Digest",
      tweetCount: 3,
      podcastCount: 1,
      newsletterCount: 2,
      paperCount: 1,
      itemCount: 7,
      sourceItemIds: [1, 2, 3, 4, 5, 6, 7],
      model: "claude-haiku-4-5-20251001",
    });
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
    mockGenerateDigest.mockResolvedValueOnce({
      content: "digest content",
      tweetCount: 4,
      podcastCount: 2,
      newsletterCount: 3,
      paperCount: 5,
      itemCount: 14,
      sourceItemIds: [1, 2, 3],
      model: "claude-haiku-4-5-20251001",
    });
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

  it("passes force=true to generateDigest when called with force", async () => {
    mockGenerateDigest.mockResolvedValueOnce(null);

    await generateDigestAction(true);

    expect(mockGenerateDigest).toHaveBeenCalledWith(undefined, true);
  });

  it("passes force as undefined by default", async () => {
    mockGenerateDigest.mockResolvedValueOnce(null);

    await generateDigestAction();

    expect(mockGenerateDigest).toHaveBeenCalledWith(undefined, undefined);
  });

  it("works without CRON_SECRET configured", async () => {
    delete process.env.CRON_SECRET;
    mockGenerateDigest.mockResolvedValueOnce(null);

    const result = await generateDigestAction();

    // Should succeed — server actions don't need CRON_SECRET
    expect(result).toEqual({ message: "No new content to digest" });
  });

  it("returns message when no new content", async () => {
    mockGenerateDigest.mockResolvedValueOnce(null);

    const result = await generateDigestAction();

    expect(result).toEqual({ message: "No new content to digest" });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns error when generateDigest throws", async () => {
    mockGenerateDigest.mockRejectedValueOnce(new Error("API key invalid"));

    const result = await generateDigestAction();

    expect(result).toEqual({ error: "Failed to generate digest. Please try again." });
  });

  it("returns error when DB insert throws", async () => {
    mockGenerateDigest.mockResolvedValueOnce({
      content: "content",
      tweetCount: 0,
      podcastCount: 0,
      newsletterCount: 0,
      paperCount: 0,
      itemCount: 0,
      sourceItemIds: [],
      model: "claude-haiku-4-5-20251001",
    });
    mockSql.mockRejectedValueOnce(new Error("DB write failed"));

    const result = await generateDigestAction();

    expect(result).toEqual({ error: "Failed to generate digest. Please try again." });
  });

  it("does NOT make any HTTP fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGenerateDigest.mockResolvedValueOnce(null);

    await generateDigestAction();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("runFetchAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fetch counts on success", async () => {
    mockFetchAllContent.mockResolvedValueOnce({
      tweets: 5,
      podcasts: 3,
      newsletters: 2,
      papers: 1,
    });

    const result = await runFetchAction();

    expect(result).toEqual({
      tweets: 5,
      podcasts: 3,
      newsletters: 2,
      papers: 1,
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
