import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Source } from "../schema";

// -- Helpers ------------------------------------------------------------------

function makeXSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 1,
    type: "x_account",
    name: "Test User",
    handle: "testuser",
    podcast_type: null,
    channel_handle: null,
    playlist_id: null,
    url: null,
    feed_url: null,
    created_at: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

function makePodcastSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 2,
    type: "podcast",
    name: "Test Podcast",
    handle: null,
    podcast_type: "youtube_channel",
    channel_handle: "TestChannel",
    playlist_id: null,
    url: "https://youtube.com/@TestChannel",
    feed_url: null,
    created_at: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

function makeNewsletterSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 3,
    type: "newsletter",
    name: "Test Newsletter",
    handle: null,
    podcast_type: null,
    channel_handle: null,
    playlist_id: null,
    url: null,
    feed_url: "https://example.com/feed",
    created_at: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

// -- X Fetcher Tests ----------------------------------------------------------

describe("fetchXContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("maps X API response to FeedItemInsert[]", async () => {
    const mockFetch = vi.fn();

    // User lookup response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "123",
            username: "testuser",
            name: "Test User",
            description: "A test bio",
          },
        ],
      }),
    });

    // Tweet fetch response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "tweet1",
            text: "Hello world",
            created_at: "2026-03-20T10:00:00Z",
            public_metrics: {
              like_count: 10,
              retweet_count: 2,
              reply_count: 1,
            },
            referenced_tweets: null,
          },
        ],
      }),
    });

    // Reply search (reply_count > 0 triggers search)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "reply1",
            text: "Nice post!",
            author_id: "a1",
            public_metrics: { like_count: 5, retweet_count: 0, reply_count: 0 },
          },
        ],
        includes: {
          users: [{ id: "a1", username: "replier1", name: "Replier One" }],
        },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const source = makeXSource();
    const results = await fetchXContent([source], "test-bearer-token");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "tweet",
      external_id: "tweet1",
      content: "Hello world",
      url: "https://x.com/testuser/status/tweet1",
      author_name: "Test User",
      author_handle: "testuser",
      author_bio: "A test bio",
      published_at: "2026-03-20T10:00:00Z",
      tweet_meta: {
        likes: 10,
        retweets: 2,
        replies: 1,
        isQuote: false,
        quotedTweetId: null,
      },
    });
  });

  it("uses note_tweet text when available", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "123",
            username: "testuser",
            name: "Test User",
            description: "",
          },
        ],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "tweet2",
            text: "Truncated...",
            note_tweet: { text: "Full long tweet text that was truncated" },
            created_at: "2026-03-20T10:00:00Z",
            public_metrics: {
              like_count: 0,
              retweet_count: 0,
              reply_count: 0,
            },
          },
        ],
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results[0].content).toBe(
      "Full long tweet text that was truncated"
    );
  });

  it("breaks on 429 rate limit", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "1", username: "user1", name: "User 1", description: "" },
          { id: "2", username: "user2", name: "User 2", description: "" },
        ],
      }),
    });

    // First user: rate limited
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const sources = [
      makeXSource({ id: 1, handle: "user1", name: "User 1" }),
      makeXSource({ id: 2, handle: "user2", name: "User 2" }),
    ];
    const results = await fetchXContent(sources, "token");

    expect(results).toHaveLength(0);
    // Should NOT have called fetch for user2's tweets (broke on 429)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns empty for empty sources array", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([], "token");

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips sources with null handle", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const source = makeXSource({ handle: null });
    const results = await fetchXContent([source], "token");

    expect(results).toHaveLength(0);
  });

  it("caps at MAX_TWEETS_PER_USER (3)", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "1", username: "testuser", name: "Test", description: "" }],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: Array.from({ length: 5 }, (_, i) => ({
          id: `tweet${i}`,
          text: `Tweet ${i}`,
          created_at: "2026-03-20T10:00:00Z",
          public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
        })),
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results).toHaveLength(3);
  });

  it("detects quote tweets via referenced_tweets", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "1", username: "testuser", name: "Test", description: "" }],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "qt1",
            text: "Check this out",
            created_at: "2026-03-20T10:00:00Z",
            public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
            referenced_tweets: [{ type: "quoted", id: "original123" }],
          },
        ],
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results[0].tweet_meta).toMatchObject({
      isQuote: true,
      quotedTweetId: "original123",
    });
  });

  it("continues when user lookup API returns error status", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results).toHaveLength(0);
  });

  it("continues when user lookup throws network error", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results).toHaveLength(0);
  });

  it("continues to next user on non-429 tweet fetch error", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "1", username: "user1", name: "User 1", description: "" },
          { id: "2", username: "user2", name: "User 2", description: "" },
        ],
      }),
    });

    // user1 tweets: 500 error
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    // user2 tweets: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "t1",
            text: "Hello",
            created_at: "2026-03-20T10:00:00Z",
            public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
          },
        ],
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const sources = [
      makeXSource({ id: 1, handle: "user1", name: "User 1" }),
      makeXSource({ id: 2, handle: "user2", name: "User 2" }),
    ];
    const results = await fetchXContent(sources, "token");

    // user1 failed but user2 succeeded
    expect(results).toHaveLength(1);
    expect(results[0].author_handle).toBe("user2");
  });

  it("logs partial errors from user lookup response", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "1", username: "testuser", name: "Test", description: "" }],
        errors: [{ value: "ghostuser", detail: "User not found" }],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    await fetchXContent([makeXSource()], "token");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("ghostuser")
    );
    consoleSpy.mockRestore();
  });

  it("batches user lookups when more than 100 handles", async () => {
    const mockFetch = vi.fn();

    // Generate 101 sources
    const sources = Array.from({ length: 101 }, (_, i) =>
      makeXSource({ id: i + 1, handle: `user${i}`, name: `User ${i}` })
    );

    // First batch lookup (100 users) — return empty so no tweet fetches happen
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    // Second batch lookup (1 user) — also empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    await fetchXContent(sources, "token");

    // Should have made exactly 2 user lookup calls (batches of 100 + 1)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstLookupUrl = mockFetch.mock.calls[0][0] as string;
    const secondLookupUrl = mockFetch.mock.calls[1][0] as string;
    expect(firstLookupUrl).toContain("users/by");
    expect(secondLookupUrl).toContain("users/by");

    // First batch should have 100 usernames, second batch should have 1
    const firstUsernames = firstLookupUrl.split("usernames=")[1].split("&")[0].split(",");
    const secondUsernames = secondLookupUrl.split("usernames=")[1].split("&")[0].split(",");
    expect(firstUsernames).toHaveLength(100);
    expect(secondUsernames).toHaveLength(1);
  });

  it("matches users case-insensitively", async () => {
    const mockFetch = vi.fn();

    // API returns username with different case
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "1", username: "TestUser", name: "Test", description: "Bio" },
        ],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "t1",
            text: "Hello",
            created_at: "2026-03-20T10:00:00Z",
            public_metrics: { like_count: 0, retweet_count: 0, reply_count: 0 },
          },
        ],
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    // Source handle is lowercase, API returns mixed case
    const source = makeXSource({ handle: "testuser" });
    const results = await fetchXContent([source], "token");

    expect(results).toHaveLength(1);
    expect(results[0].author_bio).toBe("Bio");
  });
});

// -- fetchTopReplies Tests -----------------------------------------------------

describe("fetchTopReplies", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns top 5 replies sorted by likes", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: Array.from({ length: 8 }, (_, i) => ({
          id: `reply${i}`,
          text: `Reply ${i}`,
          author_id: `author${i}`,
          public_metrics: { like_count: i * 10, retweet_count: 0, reply_count: 0 },
        })),
        includes: {
          users: Array.from({ length: 8 }, (_, i) => ({
            id: `author${i}`,
            username: `user${i}`,
            name: `User ${i}`,
          })),
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const replies = await fetchTopReplies("tweet123", "bearer-token");

    expect(replies).toHaveLength(5);
    // Highest likes first
    expect(replies![0].likes).toBe(70);
    expect(replies![4].likes).toBe(30);
  });

  it("calls search/recent with conversation_id query", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], meta: { result_count: 0 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    await fetchTopReplies("tweet999", "bearer-token");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/2/tweets/search/recent");
    expect(calledUrl).toContain("conversation_id:tweet999");
    expect(calledUrl).toContain("expansions=author_id");
  });

  it("filters out the original tweet from results", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "original_tweet",
            text: "Original post",
            author_id: "author_orig",
            public_metrics: { like_count: 100, retweet_count: 0, reply_count: 0 },
          },
          {
            id: "reply1",
            text: "A reply",
            author_id: "author1",
            public_metrics: { like_count: 50, retweet_count: 0, reply_count: 0 },
          },
        ],
        includes: {
          users: [
            { id: "author_orig", username: "origuser", name: "Orig User" },
            { id: "author1", username: "replier1", name: "Replier One" },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const replies = await fetchTopReplies("original_tweet", "token");

    expect(replies).toHaveLength(1);
    expect(replies![0].text).toBe("A reply");
  });

  it("returns null on 429 rate limit", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const result = await fetchTopReplies("tweet1", "token");

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const result = await fetchTopReplies("tweet1", "token");

    expect(result).toBeNull();
  });

  it("returns null when search returns no results", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ meta: { result_count: 0 } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const result = await fetchTopReplies("tweet1", "token");

    expect(result).toBeNull();
  });

  it("handles missing user data gracefully", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "reply1",
            text: "A reply",
            author_id: "unknown_author",
            public_metrics: { like_count: 10, retweet_count: 0, reply_count: 0 },
          },
        ],
        includes: { users: [] },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchTopReplies } = await import("../fetchers/x");
    const replies = await fetchTopReplies("tweet1", "token");

    expect(replies).toHaveLength(1);
    expect(replies![0].authorHandle).toBe("unknown");
    expect(replies![0].authorName).toBe("Unknown");
  });
});

// -- fetchXContent + replies integration tests --------------------------------

describe("fetchXContent reply integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("fetches topReplies for tweets with reply_count > 0", async () => {
    const mockFetch = vi.fn();

    // User lookup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "123", username: "testuser", name: "Test", description: "" }],
      }),
    });

    // Tweet fetch - one tweet with replies
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: "tweet1",
          text: "Hello world",
          created_at: "2026-03-20T10:00:00Z",
          public_metrics: { like_count: 10, retweet_count: 2, reply_count: 5 },
        }],
      }),
    });

    // Reply search
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: "reply1",
          text: "Great take!",
          author_id: "author1",
          public_metrics: { like_count: 20, retweet_count: 0, reply_count: 0 },
        }],
        includes: {
          users: [{ id: "author1", username: "replier1", name: "Replier One" }],
        },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results[0].tweet_meta!.topReplies).toHaveLength(1);
    expect(results[0].tweet_meta!.topReplies![0]).toMatchObject({
      authorHandle: "replier1",
      authorName: "Replier One",
      text: "Great take!",
      likes: 20,
    });
  });

  it("skips reply fetching when reply_count is 0", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "123", username: "testuser", name: "Test", description: "" }],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: "tweet1",
          text: "Hello",
          created_at: "2026-03-20T10:00:00Z",
          public_metrics: { like_count: 10, retweet_count: 2, reply_count: 0 },
        }],
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    expect(results[0].tweet_meta!.topReplies).toBeNull();
    // Only 2 fetch calls: user lookup + tweets. No search call.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("stores tweet with null topReplies when reply fetch fails", async () => {
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: "123", username: "testuser", name: "Test", description: "" }],
      }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: "tweet1",
          text: "Hello",
          created_at: "2026-03-20T10:00:00Z",
          public_metrics: { like_count: 10, retweet_count: 2, reply_count: 3 },
        }],
      }),
    });

    // Reply fetch: network error
    mockFetch.mockRejectedValueOnce(new Error("search failed"));

    vi.stubGlobal("fetch", mockFetch);

    const { fetchXContent } = await import("../fetchers/x");
    const results = await fetchXContent([makeXSource()], "token");

    // Tweet is still stored
    expect(results).toHaveLength(1);
    expect(results[0].tweet_meta!.topReplies).toBeNull();
  });
});

// -- YouTube Fetcher Tests ----------------------------------------------------

describe("fetchYouTubeContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("maps Supadata response to FeedItemInsert[]", async () => {
    const now = new Date().toISOString();
    const mockFetch = vi.fn();

    // Channel videos
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1"] }),
    });

    // Video metadata
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "Great Episode",
        uploadDate: now,
      }),
    });

    // Transcript
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "The full transcript text" }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const source = makePodcastSource();
    const results = await fetchYouTubeContent([source], "test-api-key");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "podcast",
      external_id: "vid1",
      title: "Great Episode",
      content: "The full transcript text",
      url: "https://youtube.com/watch?v=vid1",
      author_name: "Test Podcast",
      published_at: now,
    });
  });

  it("returns empty when no videos within lookback window", async () => {
    const oldDate = new Date(
      Date.now() - 100 * 60 * 60 * 1000
    ).toISOString(); // 100h ago
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1"] }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "Old Episode",
        uploadDate: oldDate,
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent(
      [makePodcastSource()],
      "key"
    );

    expect(results).toHaveLength(0);
  });

  it("returns empty for empty sources array", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([], "key");

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses playlist URL for youtube_playlist type", async () => {
    const now = new Date().toISOString();
    const mockFetch = vi.fn();

    // Playlist videos endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1"] }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Episode", uploadDate: now }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "Transcript" }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const source = makePodcastSource({
      podcast_type: "youtube_playlist",
      playlist_id: "PLtest123",
      channel_handle: null,
    });
    const results = await fetchYouTubeContent([source], "key");

    expect(results).toHaveLength(1);
    // Verify playlist URL was used (first fetch call)
    expect(mockFetch.mock.calls[0][0]).toContain("playlist/videos");
    expect(mockFetch.mock.calls[0][0]).toContain("PLtest123");
  });

  it("returns empty when transcript fetch fails", async () => {
    const now = new Date().toISOString();
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1"] }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Episode", uploadDate: now }),
    });

    // Transcript fetch fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([makePodcastSource()], "key");

    expect(results).toHaveLength(0);
  });

  it("handles videos API failure gracefully", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([makePodcastSource()], "key");

    expect(results).toHaveLength(0);
  });

  it("selects oldest video within lookback window", async () => {
    const older = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
    const newer = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1", "vid2"] }),
    });

    // vid1 metadata (newer)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Newer Episode", uploadDate: newer }),
    });

    // vid2 metadata (older but within window)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Older Episode", uploadDate: older }),
    });

    // Transcript for selected video (oldest)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "Transcript text" }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([makePodcastSource()], "key");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Older Episode");
    expect(results[0].external_id).toBe("vid2");
  });

  it("accepts video_ids as alternative response key", async () => {
    const now = new Date().toISOString();
    const mockFetch = vi.fn();

    // Supadata returns video_ids (snake_case) instead of videoIds (camelCase)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ video_ids: ["vid1"] }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Episode", uploadDate: now }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "Transcript" }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([makePodcastSource()], "key");

    expect(results).toHaveLength(1);
    expect(results[0].external_id).toBe("vid1");
  });

  it("skips individual video when metadata fetch fails", async () => {
    const now = new Date().toISOString();
    const mockFetch = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ videoIds: ["vid1", "vid2"] }),
    });

    // vid1 metadata: fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    // vid2 metadata: succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Good Episode", uploadDate: now }),
    });

    // Transcript for vid2
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "Transcript text" }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchYouTubeContent } = await import("../fetchers/youtube");
    const results = await fetchYouTubeContent([makePodcastSource()], "key");

    expect(results).toHaveLength(1);
    expect(results[0].external_id).toBe("vid2");
    expect(results[0].title).toBe("Good Episode");
  });
});

// -- RSS Fetcher Tests --------------------------------------------------------

describe("fetchRSSContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toUTCString(); // 1h ago

  it("parses RSS 2.0 format", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Test Blog</title>
        <item>
          <title>First Post</title>
          <link>https://example.com/post-1</link>
          <pubDate>${recentDate}</pubDate>
          <description>&lt;p&gt;Hello &amp; world&lt;/p&gt;</description>
        </item>
      </channel>
    </rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "newsletter",
      external_id: "https://example.com/post-1",
      title: "First Post",
      content: "Hello & world",
      url: "https://example.com/post-1",
      author_name: "Test Newsletter",
    });
  });

  it("parses Atom format with single link", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Blog</title>
      <entry>
        <title>Atom Post</title>
        <link href="https://example.com/atom-1"/>
        <updated>${new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()}</updated>
        <content type="html">&lt;p&gt;Atom content&lt;/p&gt;</content>
      </entry>
    </feed>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "newsletter",
      title: "Atom Post",
      url: "https://example.com/atom-1",
      content: "Atom content",
    });
  });

  it("parses Atom format with multiple link elements", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Multi-link Blog</title>
      <entry>
        <title>Multi Link Post</title>
        <link rel="self" href="https://example.com/api/entry/1"/>
        <link rel="alternate" href="https://example.com/post-1"/>
        <updated>${new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()}</updated>
        <content>Some content here</content>
      </entry>
    </feed>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/post-1");
  });

  it("caps at 3 articles per source", async () => {
    const items = Array.from(
      { length: 5 },
      (_, i) => `
      <item>
        <title>Post ${i + 1}</title>
        <link>https://example.com/post-${i + 1}</link>
        <pubDate>${recentDate}</pubDate>
        <description>Content ${i + 1}</description>
      </item>`
    ).join("");

    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(3);
  });

  it("filters out articles older than 72h", async () => {
    const oldDate = new Date(
      Date.now() - 100 * 60 * 60 * 1000
    ).toUTCString();
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Old Post</title>
        <link>https://example.com/old</link>
        <pubDate>${oldDate}</pubDate>
        <description>Old content</description>
      </item>
    </channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(0);
  });

  it("returns empty for empty sources array", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([]);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips sources without feed_url", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { fetchRSSContent } = await import("../fetchers/rss");
    const source = makeNewsletterSource({ feed_url: null });
    const results = await fetchRSSContent([source]);

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips items with no link", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>No Link Post</title>
        <pubDate>${recentDate}</pubDate>
        <description>Some content</description>
      </item>
    </channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, text: async () => xml })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(0);
  });

  it("skips items with empty content", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Empty Post</title>
        <link>https://example.com/empty</link>
        <pubDate>${recentDate}</pubDate>
        <description></description>
      </item>
    </channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, text: async () => xml })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(0);
  });

  it("prefers content:encoded over description", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Rich Post</title>
        <link>https://example.com/rich</link>
        <pubDate>${recentDate}</pubDate>
        <description>Short summary</description>
        <content:encoded>&lt;p&gt;Full article content here&lt;/p&gt;</content:encoded>
      </item>
    </channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, text: async () => xml })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Full article content here");
  });

  it("continues to next source when feed fetch returns HTTP error", async () => {
    const mockFetch = vi.fn();

    // First source: HTTP error
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    // Second source: success
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Good Post</title>
        <link>https://other.com/post</link>
        <pubDate>${recentDate}</pubDate>
        <description>Good content</description>
      </item>
    </channel></rss>`;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => xml });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([
      makeNewsletterSource({ id: 1, feed_url: "https://broken.com/feed" }),
      makeNewsletterSource({ id: 2, feed_url: "https://other.com/feed" }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://other.com/post");
  });

  it("continues to next source when feed fetch throws network error", async () => {
    const mockFetch = vi.fn();

    // First source: network error
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Second source: success
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Working Post</title>
        <link>https://working.com/post</link>
        <pubDate>${recentDate}</pubDate>
        <description>Working content</description>
      </item>
    </channel></rss>`;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => xml });

    vi.stubGlobal("fetch", mockFetch);

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([
      makeNewsletterSource({ id: 1, feed_url: "https://down.com/feed" }),
      makeNewsletterSource({ id: 2, feed_url: "https://working.com/feed" }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://working.com/post");
  });

  it("uses Atom published date over updated date", async () => {
    const publishedDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const updatedDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Blog</title>
      <entry>
        <title>Published Post</title>
        <link href="https://example.com/pub"/>
        <published>${publishedDate}</published>
        <updated>${updatedDate}</updated>
        <content>Some content</content>
      </entry>
    </feed>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, text: async () => xml })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(1);
    // extractDate returns pubDate || published || updated
    // Since there's no pubDate in Atom, published should take priority over updated
    expect(results[0].published_at).toBe(publishedDate);
  });

  it("skips articles without dates", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Undated Post</title>
        <link>https://example.com/undated</link>
        <description>Some content</description>
      </item>
    </channel></rss>`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        text: async () => xml,
      })
    );

    const { fetchRSSContent } = await import("../fetchers/rss");
    const results = await fetchRSSContent([makeNewsletterSource()]);

    expect(results).toHaveLength(0);
  });
});

// -- HTML Stripping -----------------------------------------------------------

describe("stripHtml", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("strips tags and decodes named entities", async () => {
    const { stripHtml } = await import("../fetchers/rss");
    expect(stripHtml("<p>Hello &amp; <b>world</b></p>")).toBe(
      "Hello & world"
    );
    expect(stripHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "<script>alert(1)</script>"
    );
    expect(stripHtml("a&nbsp;b")).toBe("a b");
  });

  it("decodes &quot; and &#39; entities", async () => {
    const { stripHtml } = await import("../fetchers/rss");
    expect(stripHtml("&quot;hello&quot;")).toBe('"hello"');
    expect(stripHtml("it&#39;s")).toBe("it's");
  });

  it("collapses whitespace and trims", async () => {
    const { stripHtml } = await import("../fetchers/rss");
    expect(stripHtml("  hello   world  ")).toBe("hello world");
    expect(stripHtml("<p>  spaced  </p>  <p>  out  </p>")).toBe("spaced out");
  });

  it("decodes numeric and hex entities", async () => {
    const { stripHtml } = await import("../fetchers/rss");
    // &#8217; = right single quote, &#8230; = ellipsis
    expect(stripHtml("it&#8217;s great&#8230;")).toBe(
      "it\u2019s great\u2026"
    );
    // &#x27; = apostrophe
    expect(stripHtml("don&#x27;t")).toBe("don't");
  });
});

// -- Prompts Tests ------------------------------------------------------------

describe("prompts", () => {
  it("exports core prompt constants as non-empty strings", async () => {
    const {
      DIGEST_INTRO,
      SUMMARIZE_TWEETS,
      SUMMARIZE_PODCAST,
      SUMMARIZE_NEWSLETTER,
      SUMMARIZE_PAPERS,
    } = await import("../prompts");

    expect(typeof DIGEST_INTRO).toBe("string");
    expect(DIGEST_INTRO.length).toBeGreaterThan(0);

    expect(typeof SUMMARIZE_TWEETS).toBe("string");
    expect(SUMMARIZE_TWEETS.length).toBeGreaterThan(0);

    expect(typeof SUMMARIZE_PODCAST).toBe("string");
    expect(SUMMARIZE_PODCAST.length).toBeGreaterThan(0);

    expect(typeof SUMMARIZE_NEWSLETTER).toBe("string");
    expect(SUMMARIZE_NEWSLETTER.length).toBeGreaterThan(0);

    expect(typeof SUMMARIZE_PAPERS).toBe("string");
    expect(SUMMARIZE_PAPERS.length).toBeGreaterThan(0);
  });
});

// -- Papers Fetcher Tests -----------------------------------------------------

function makeHFPaper(overrides: Record<string, unknown> = {}) {
  return {
    paper: {
      id: "2603.17187",
      title: "A Great Paper on AI",
      summary: "This paper presents a novel approach to AI alignment.",
      publishedAt: "2026-03-20T00:00:00.000Z",
      authors: [
        { name: "Alice Smith", user: { username: "alice" } },
        { name: "Bob Jones", user: { username: "bob" } },
        { name: "Carol White" },
      ],
    },
    title: "A Great Paper on AI",
    upvotes: 42,
    numComments: 5,
    ...overrides,
  };
}

describe("fetchPapersContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doMock("../fetchers/paper-full-text", () => ({
      fetchPaperFullText: vi.fn().mockResolvedValue(null),
      pLimit: () => <T>(fn: () => Promise<T>) => fn(),
    }));
  });

  it("fetches yesterday's top papers with title, abstract, authors, and metadata", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeHFPaper()],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "paper",
      external_id: "2603.17187",
      title: "A Great Paper on AI",
      content: "This paper presents a novel approach to AI alignment.",
      url: "https://arxiv.org/abs/2603.17187",
      author_name: "Alice Smith, Bob Jones, Carol White",
      published_at: "2026-03-20T00:00:00.000Z",
      paper_meta: {
        upvotes: 42,
        numComments: 5,
        githubRepo: null,
        githubStars: null,
        aiSummary: null,
        aiKeywords: null,
        authors: [
          { name: "Alice Smith", user: "alice" },
          { name: "Bob Jones", user: "bob" },
          { name: "Carol White" },
        ],
      },
    });
  });

  it("returns all papers sorted by upvotes", async () => {
    const papers = Array.from({ length: 25 }, (_, i) =>
      makeHFPaper({
        paper: {
          id: `paper-${i}`,
          title: `Paper ${i}`,
          summary: `Abstract ${i}`,
          publishedAt: "2026-03-20T00:00:00.000Z",
          authors: [{ name: "Author" }],
        },
        title: `Paper ${i}`,
        upvotes: i,
      }),
    );

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => papers,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results).toHaveLength(25);
    expect(results[0].external_id).toBe("paper-24");
    expect(results[24].external_id).toBe("paper-0");
  });

  it("supports an explicit date, maxPapers, and skipping full-text fetch", async () => {
    const papers = Array.from({ length: 3 }, (_, i) =>
      makeHFPaper({
        paper: {
          id: `paper-${i}`,
          title: `Paper ${i}`,
          summary: `Abstract ${i}`,
          publishedAt: "2026-03-20T00:00:00.000Z",
          authors: [{ name: "Author" }],
        },
        title: `Paper ${i}`,
        upvotes: i,
      }),
    );
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => papers });
    vi.stubGlobal("fetch", mockFetch);

    const helperMock = vi.fn();
    vi.doMock("../fetchers/paper-full-text", () => ({
      fetchPaperFullText: helperMock,
      pLimit: () => <T>(fn: () => Promise<T>) => fn(),
    }));

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent({
      date: "2026-03-20",
      maxPapers: 2,
      fetchFullText: false,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://huggingface.co/api/daily_papers?date=2026-03-20",
    );
    expect(helperMock).not.toHaveBeenCalled();
    expect(results.map((r) => r.external_id)).toEqual(["paper-2", "paper-1"]);
    expect(results[0].full_text).toBeNull();
    expect(results[0].full_text_source).toBeNull();
  });

  it("shows up to 3 author names for multi-author papers", async () => {
    const paper = makeHFPaper({
      paper: {
        id: "multi-author",
        title: "Many Authors",
        summary: "Abstract",
        publishedAt: "2026-03-20T00:00:00.000Z",
        authors: [
          { name: "Alice" },
          { name: "Bob" },
          { name: "Carol" },
          { name: "Dave" },
          { name: "Eve" },
        ],
      },
    });

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [paper],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results[0].author_name).toBe("Alice, Bob, Carol");
  });

  it("shows single author name without trailing comma", async () => {
    const paper = makeHFPaper({
      paper: {
        id: "solo-author",
        title: "Solo Paper",
        summary: "Abstract",
        publishedAt: "2026-03-20T00:00:00.000Z",
        authors: [{ name: "Alice" }],
      },
    });

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [paper],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results[0].author_name).toBe("Alice");
  });

  it("returns no papers when the source API is down", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results).toEqual([]);
  });

  it("returns no papers when network is unreachable", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results).toEqual([]);
  });

  it("returns no papers on a day with no publications", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results).toEqual([]);
  });

  it("always fetches yesterday's papers, not today's", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    await fetchPapersContent();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expectedDate = yesterday.toISOString().slice(0, 10);
    expect(mockFetch).toHaveBeenCalledWith(
      `https://huggingface.co/api/daily_papers?date=${expectedDate}`,
    );
  });

  it("handles papers with no GitHub link or publication date", async () => {
    const paper = makeHFPaper({
      numComments: 0,
      paper: {
        id: "no-extras",
        title: "Minimal Paper",
        summary: "Just an abstract",
        publishedAt: null,
        authors: [{ name: "Author" }],
      },
    });

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [paper],
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results[0].paper_meta).toMatchObject({
      upvotes: 42,
      numComments: 0,
      githubRepo: null,
      githubStars: null,
    });
    expect(results[0].published_at).toBeNull();
  });

  it("captures aiSummary and aiKeywords from the HF response", async () => {
    const paper = makeHFPaper({
      ai_summary: "A one-sentence AI-generated summary.",
      ai_keywords: ["alignment", "RLHF", "evaluation"],
    });

    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [paper] });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results[0].paper_meta).toMatchObject({
      aiSummary: "A one-sentence AI-generated summary.",
      aiKeywords: ["alignment", "RLHF", "evaluation"],
      providers: {
        hf: {
          upvotes: expect.any(Number),
          numComments: expect.any(Number),
          aiSummary: "A one-sentence AI-generated summary.",
          aiKeywords: ["alignment", "RLHF", "evaluation"],
        },
      },
    });
  });

  it("populates full_text and full_text_source from the helper, one call per paper", async () => {
    const papers = [
      makeHFPaper({ paper: { id: "1111.0001", title: "P1", summary: "S1", publishedAt: null, authors: [{ name: "A" }] } }),
      makeHFPaper({ paper: { id: "1111.0002", title: "P2", summary: "S2", publishedAt: null, authors: [{ name: "B" }] } }),
    ];
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => papers });
    vi.stubGlobal("fetch", mockFetch);

    const helperMock = vi.fn(async (id: string) =>
      id === "1111.0001"
        ? { text: "long body 1", source: "arxiv_html" as const }
        : { text: "short body 2", source: "hf_page" as const },
    );
    vi.doMock("../fetchers/paper-full-text", () => ({
      fetchPaperFullText: helperMock,
      pLimit: () => <T>(fn: () => Promise<T>) => fn(),
    }));

    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(helperMock).toHaveBeenCalledTimes(2);
    expect(helperMock).toHaveBeenCalledWith("1111.0001");
    expect(helperMock).toHaveBeenCalledWith("1111.0002");

    const byId = new Map(results.map((r) => [r.external_id, r]));
    expect(byId.get("1111.0001")).toMatchObject({
      full_text: "long body 1",
      full_text_source: "arxiv_html",
    });
    expect(byId.get("1111.0002")).toMatchObject({
      full_text: "short body 2",
      full_text_source: "hf_page",
    });
  });

  it("leaves full_text and full_text_source null when the helper returns null", async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [makeHFPaper()] });
    vi.stubGlobal("fetch", mockFetch);

    // The describe's beforeEach already mocks the helper to resolve null.
    const { fetchPapersContent } = await import("../fetchers/papers");
    const results = await fetchPapersContent();

    expect(results[0].full_text).toBeNull();
    expect(results[0].full_text_source).toBeNull();
  });
});

describe("fetchPaperFullText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../fetchers/paper-full-text");
  });

  const LONG_BODY = `${"a".repeat(6000)}\n## Section\nmore`;

  it("classifies long body with '## ' heading as arxiv_html", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => LONG_BODY,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result).toEqual({ text: LONG_BODY, source: "arxiv_html" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://huggingface.co/papers/2603.17187.md",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it("classifies short body without '## ' heading as hf_page", async () => {
    const body = "Short page intro without level-two headings.";
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => body,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result).toEqual({ text: body, source: "hf_page" });
  });

  it("classifies long body without '## ' as hf_page (heading missing)", async () => {
    const body = "x".repeat(7000);
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => body,
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result?.source).toBe("hf_page");
  });

  it("returns null when the response is not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result).toBeNull();
  });

  it("returns null when the body is empty or whitespace", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "   \n\t ",
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPaperFullText } = await import("../fetchers/paper-full-text");
    const result = await fetchPaperFullText("2603.17187");

    expect(result).toBeNull();
  });
});

describe("pLimit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../fetchers/paper-full-text");
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    const { pLimit } = await import("../fetchers/paper-full-text");
    const limit = pLimit(3);

    let active = 0;
    let peak = 0;
    const deferreds: Array<() => void> = [];

    const task = () =>
      new Promise<void>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        deferreds.push(() => {
          active--;
          resolve();
        });
      });

    const pending = Promise.all(Array.from({ length: 8 }, () => limit(task)));

    // Let microtasks flush so initial slots are claimed.
    await Promise.resolve();
    await Promise.resolve();

    expect(active).toBe(3);

    // Resolve everything in order; each release should pull the next queued task.
    while (deferreds.length) {
      deferreds.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }

    await pending;
    expect(peak).toBe(3);
  });

  it("releases the slot when the task throws synchronously", async () => {
    const { pLimit } = await import("../fetchers/paper-full-text");
    const limit = pLimit(2);

    // Two synchronous throws should not stall the queue; subsequent tasks must still run.
    const throwingTask = () => {
      throw new Error("sync boom");
    };

    await expect(limit(throwingTask)).rejects.toThrow("sync boom");
    await expect(limit(throwingTask)).rejects.toThrow("sync boom");

    // If the slot leaked, this third call would queue forever.
    await expect(limit(async () => 42)).resolves.toBe(42);
  });
});

// -- alphaXiv Fetcher Tests ---------------------------------------------------

function makeAlphaxivPaper(overrides: Record<string, unknown> = {}) {
  return {
    universal_paper_id: "2605.09969",
    canonical_id: "2605.09969v1",
    title: "Tokens in the Middle",
    abstract: "We study mean pooling across autoregressively generated tokens.",
    paper_summary: {
      summary: "Mean pooling beats last-token pooling for semantic retrieval.",
      originalProblem: ["Decoder-only LMs have weak prompt embeddings."],
      solution: ["Pool hidden states of generated tokens, not prompt tokens."],
      keyInsights: ["Semantic content is spread across the generation."],
      results: ["CKA 0.410 generated vs 0.184 prompt."],
    },
    publication_date: "2026-05-11T04:20:04.000Z",
    first_publication_date: "2026-05-11T04:20:04.000Z",
    topics: ["Computer Science", "cs.CL", "cs.LG", "embedding-methods", "representation-learning"],
    authors: ["Sophie L. Wang", "Phillip Isola", "Brian Cheung"],
    full_authors: [
      { full_name: "Sophie L. Wang", username: null },
      { full_name: "Phillip Isola", username: null },
      { full_name: "Brian Cheung", username: "bcheung" },
    ],
    metrics: {
      visits_count: { all: 236, last_7_days: 236 },
      total_votes: 6,
      public_total_votes: 23,
    },
    github_url: "https://github.com/sophicle/tokens",
    github_stars: 0,
    ...overrides,
  };
}

describe("fetchAlphaxivContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doMock("../fetchers/paper-full-text", () => ({
      fetchPaperFullText: vi.fn().mockResolvedValue(null),
      pLimit: () => <T>(fn: () => Promise<T>) => fn(),
    }));
  });

  it("hits the api.alphaxiv.org feed endpoint with required params", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    await fetchAlphaxivContent();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("https://api.alphaxiv.org/papers/v3/feed");
    expect(url).toContain("pageNum=1");
    expect(url).toContain("pageSize=50");
    expect(url).toContain("sort=Hot");
    // Must be %20, not "+". alphaXiv's Zod matches literal "7 Days" and "+"
    // wouldn't decode back to a space in their query parser.
    expect(url).toContain("interval=7%20Days");
    expect(url).not.toContain("interval=7+Days");

    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["User-Agent"]).toMatch(/Mozilla/);
  });

  it("maps universal_paper_id, abstract, votes, and provider meta into FeedItemInsert", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [makeAlphaxivPaper()], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source_type: "paper",
      external_id: "2605.09969",
      title: "Tokens in the Middle",
      content: "We study mean pooling across autoregressively generated tokens.",
      url: "https://arxiv.org/abs/2605.09969",
      author_name: "Sophie L. Wang, Phillip Isola, Brian Cheung",
      published_at: "2026-05-11T04:20:04.000Z",
      paper_meta: {
        upvotes: 23,
        numComments: 0,
        githubRepo: "https://github.com/sophicle/tokens",
        githubStars: 0,
        aiSummary: "Mean pooling beats last-token pooling for semantic retrieval.",
        authors: [
          { name: "Sophie L. Wang" },
          { name: "Phillip Isola" },
          { name: "Brian Cheung", user: "bcheung" },
        ],
        providers: {
          alphaxiv: {
            votes: 23,
            visitsAll: 236,
            visitsLast7Days: 236,
            githubUrl: "https://github.com/sophicle/tokens",
            githubStars: 0,
            summary: "Mean pooling beats last-token pooling for semantic retrieval.",
            originalProblem: ["Decoder-only LMs have weak prompt embeddings."],
            solution: ["Pool hidden states of generated tokens, not prompt tokens."],
            keyInsights: ["Semantic content is spread across the generation."],
            results: ["CKA 0.410 generated vs 0.184 prompt."],
          },
        },
      },
    });
    // aiKeywords drops "Computer Science" and the arxiv codes, keeps the topic tags
    const aiKeywords = (results[0].paper_meta as { aiKeywords: string[] }).aiKeywords;
    expect(aiKeywords).toEqual(["embedding-methods", "representation-learning"]);
  });

  it("filters out papers without an AI-relevant arXiv topic", async () => {
    const ai = makeAlphaxivPaper({ universal_paper_id: "2605.00001", topics: ["Computer Science", "cs.LG"] });
    const nonAi = makeAlphaxivPaper({
      universal_paper_id: "2605.00002",
      topics: ["Mathematics", "math.AG"],
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [ai, nonAi], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results.map((r) => r.external_id)).toEqual(["2605.00001"]);
  });

  it("filters out alphaXiv papers not published in the current year", async () => {
    const currentYear = new Date().getUTCFullYear();
    const currentYearPaper = makeAlphaxivPaper({
      universal_paper_id: `${String(currentYear).slice(2)}05.00001`,
      publication_date: `${currentYear}-05-11T04:20:04.000Z`,
      first_publication_date: `${currentYear}-05-11T04:20:04.000Z`,
    });
    const priorYearPaper = makeAlphaxivPaper({
      universal_paper_id: `${String(currentYear - 1).slice(2)}05.00002`,
      publication_date: `${currentYear - 1}-05-11T04:20:04.000Z`,
      first_publication_date: `${currentYear - 1}-05-11T04:20:04.000Z`,
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [currentYearPaper, priorYearPaper], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results.map((r) => r.external_id)).toEqual([
      currentYearPaper.universal_paper_id,
    ]);
  });

  it("filters broad alphaXiv AI categories unless the paper has builder-relevant signals", async () => {
    const broadCv = makeAlphaxivPaper({
      universal_paper_id: "2605.00003",
      title: "Satellite Segmentation With Dense Visual Features",
      abstract: "We study remote sensing segmentation for earth observation.",
      paper_summary: { summary: "A remote sensing segmentation method." },
      topics: ["Computer Science", "cs.CV", "remote-sensing"],
    });
    const relevantCv = makeAlphaxivPaper({
      universal_paper_id: "2605.00004",
      title: "Multimodal LLM Agents for UI Automation",
      abstract: "We benchmark language model agents that use browser tools.",
      topics: ["Computer Science", "cs.CV", "ui-agents"],
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [broadCv, relevantCv], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results.map((r) => r.external_id)).toEqual(["2605.00004"]);
  });

  it("returns the top 20 by public_total_votes from a larger feed", async () => {
    const papers = Array.from({ length: 25 }, (_, i) =>
      makeAlphaxivPaper({
        universal_paper_id: `2605.${String(i).padStart(5, "0")}`,
        metrics: { public_total_votes: i, visits_count: { all: 0, last_7_days: 0 } },
      }),
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers, page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results).toHaveLength(20);
    // Sorted descending by votes — first should be the highest (votes=24)
    expect(results[0].external_id).toBe("2605.00024");
    expect(results[19].external_id).toBe("2605.00005");
  });

  it("returns no papers when the API returns non-2xx", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();
    expect(results).toEqual([]);
  });

  it("returns no papers when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();
    expect(results).toEqual([]);
  });

  it("skips papers missing universal_paper_id or abstract", async () => {
    const good = makeAlphaxivPaper();
    const missingId = makeAlphaxivPaper({
      universal_paper_id: undefined,
      title: "Bad",
    });
    const missingAbstract = makeAlphaxivPaper({
      universal_paper_id: "2605.99998",
      abstract: undefined,
    });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [good, missingId, missingAbstract], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();
    expect(results.map((r) => r.external_id)).toEqual(["2605.09969"]);
  });

  it("fetches full_text via fetchPaperFullText and populates full_text_source", async () => {
    vi.resetModules();
    vi.doMock("../fetchers/paper-full-text", () => ({
      fetchPaperFullText: vi
        .fn()
        .mockResolvedValueOnce({ text: "BODY", source: "arxiv_html" }),
      pLimit: () => <T>(fn: () => Promise<T>) => fn(),
    }));

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ papers: [makeAlphaxivPaper()], page: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchAlphaxivContent } = await import("../fetchers/alphaxiv");
    const results = await fetchAlphaxivContent();

    expect(results[0].full_text).toBe("BODY");
    expect(results[0].full_text_source).toBe("arxiv_html");
  });
});
