import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { getDigestSourceItems } from "../deep-dive";
import { sql } from "@/lib/db";
import type { FeedItem } from "@/lib/schema";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 1,
    source_type: "tweet",
    external_id: "t1",
    source_id: null,
    title: null,
    content: "Hello world",
    url: "https://x.com/user/status/123",
    author_name: "Test User",
    author_handle: "testuser",
    author_bio: null,
    published_at: "2026-03-21T00:00:00Z",
    tweet_meta: null,
    paper_meta: null,
    full_text: null,
    full_text_source: null,
    corpus_tier: "archive",
    relevance_score: null,
    canon_score: null,
    hot_set_reason: null,
    canon_reason: null,
    archive_reason: null,
    ignored_reason: null,
    last_seen_at: null,
    last_scored_at: null,
    last_hydrated_at: null,
    tier_metadata_json: {},
    fetched_at: "2026-03-21T01:00:00Z",
    ...overrides,
  };
}

describe("getDigestSourceItems — with stored IDs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries by ID array when source_item_ids is non-empty", async () => {
    const items = [
      makeFeedItem({ id: 10, source_type: "tweet" }),
      makeFeedItem({ id: 20, source_type: "paper", title: "Paper" }),
    ];
    mockSql.mockResolvedValueOnce(items);

    const result = await getDigestSourceItems([10, 20], "2026-03-21T08:00:00Z");

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(10);
    expect(result[1].id).toBe(20);
  });

  it("passes the ID array to the SQL query", async () => {
    mockSql.mockResolvedValueOnce([]);

    await getDigestSourceItems([5, 10, 15], "2026-03-21T08:00:00Z");

    // The template literal tag passes values as nested arrays
    const queryValues = mockSql.mock.calls[0].slice(1);
    const flatValues = JSON.stringify(queryValues);
    expect(flatValues).toContain("5");
    expect(flatValues).toContain("10");
    expect(flatValues).toContain("15");
  });

  it("does not fall back to time-window query when IDs are provided", async () => {
    mockSql.mockResolvedValueOnce([]);

    await getDigestSourceItems([1, 2], "2026-03-21T08:00:00Z");

    // Only 1 SQL call (the ID-based query), not 2 (time-window)
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe("getDigestSourceItems — fallback (no stored IDs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no items match the time window", async () => {
    mockSql.mockResolvedValueOnce([]); // 24h query
    mockSql.mockResolvedValueOnce([]); // 72h query

    const result = await getDigestSourceItems([], "2026-03-21T08:00:00Z");

    expect(result).toEqual([]);
  });

  it("queries tweets/papers with 24h window relative to generated_at", async () => {
    const tweets = [makeFeedItem({ id: 1, source_type: "tweet" })];
    mockSql.mockResolvedValueOnce(tweets);
    mockSql.mockResolvedValueOnce([]);

    await getDigestSourceItems([], "2026-03-21T08:00:00Z");

    expect(mockSql).toHaveBeenCalledTimes(2);
    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(firstCallTemplate).toContain("feed_items");
    expect(firstCallTemplate).toMatch(/24 hours/i);
  });

  it("queries podcasts/newsletters with 72h window relative to generated_at", async () => {
    mockSql.mockResolvedValueOnce([]);
    const podcasts = [makeFeedItem({ id: 2, source_type: "podcast", title: "Pod" })];
    mockSql.mockResolvedValueOnce(podcasts);

    await getDigestSourceItems([], "2026-03-21T08:00:00Z");

    const secondCallTemplate = mockSql.mock.calls[1][0].join(" ");
    expect(secondCallTemplate).toContain("feed_items");
    expect(secondCallTemplate).toMatch(/72 hours/i);
  });

  it("combines results from both time windows", async () => {
    const tweets = [makeFeedItem({ id: 1, source_type: "tweet" })];
    const podcasts = [makeFeedItem({ id: 3, source_type: "podcast", title: "Pod" })];

    mockSql.mockResolvedValueOnce(tweets);
    mockSql.mockResolvedValueOnce(podcasts);

    const result = await getDigestSourceItems([], "2026-03-21T08:00:00Z");

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it("passes generated_at timestamp as query parameter", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const timestamp = "2026-03-21T08:00:00Z";
    await getDigestSourceItems([], timestamp);

    const firstCallValues = mockSql.mock.calls[0].slice(1).flat();
    const secondCallValues = mockSql.mock.calls[1].slice(1).flat();
    expect(firstCallValues).toContain(timestamp);
    expect(secondCallValues).toContain(timestamp);
  });
});

describe("getDigestSourceItems — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when source_item_ids reference non-existent rows", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getDigestSourceItems([99999, 88888], "2026-03-21T08:00:00Z");

    expect(result).toEqual([]);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("propagates SQL errors to the caller", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      getDigestSourceItems([1], "2026-03-21T08:00:00Z"),
    ).rejects.toThrow("connection refused");
  });
});
