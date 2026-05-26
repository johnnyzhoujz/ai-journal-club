import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock("@/lib/prompts", () => ({
  DIGEST_INTRO: "DIGEST_INTRO_PROMPT",
  SUMMARIZE_TWEETS: "SUMMARIZE_TWEETS_PROMPT",
  SUMMARIZE_PODCAST: "SUMMARIZE_PODCAST_PROMPT",
  SUMMARIZE_NEWSLETTER: "SUMMARIZE_NEWSLETTER_PROMPT",
  SUMMARIZE_PAPERS: "SUMMARIZE_PAPERS_PROMPT",
}));

import { generateDigest, generateDigestWithMetadata, resolveDigestModel } from "../digest";
import { sql } from "@/lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function makeFeedItem(overrides: Record<string, unknown> = {}) {
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
    fetched_at: "2026-03-21T01:00:00Z",
    ...overrides,
  };
}

function mockAnthropicResponse(
  text = "AI Builders Digest — March 21, 2026\n\nTest digest content",
  overrides: Record<string, unknown> = {},
) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5-20251001",
    usage: { input_tokens: 500, output_tokens: 200 },
    ...overrides,
  });
}

describe("generateDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    delete process.env.DIGEST_MODEL;
  });

  // -- No content ---------------------------------------------------------------

  it("returns null when no feed items exist", async () => {
    mockSql.mockResolvedValueOnce([]); // 24h query
    mockSql.mockResolvedValueOnce([]); // 72h query

    const result = await generateDigest();

    expect(result).toBeNull();
    // Anthropic should NOT have been called
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // -- Mixed content types ------------------------------------------------------

  it("generates digest with all four content types", async () => {
    const tweets = [
      makeFeedItem({ id: 1, source_type: "tweet", external_id: "t1" }),
      makeFeedItem({ id: 2, source_type: "tweet", external_id: "t2" }),
    ];
    const papers = [
      makeFeedItem({ id: 3, source_type: "paper", external_id: "p1", title: "AI Paper" }),
    ];
    const podcasts = [
      makeFeedItem({ id: 4, source_type: "podcast", external_id: "pod1", title: "AI Podcast" }),
    ];
    const newsletters = [
      makeFeedItem({ id: 5, source_type: "newsletter", external_id: "n1", title: "AI Newsletter" }),
    ];

    mockSql.mockResolvedValueOnce([...tweets, ...papers]); // 24h query
    mockSql.mockResolvedValueOnce([...podcasts, ...newsletters]); // 72h query
    mockAnthropicResponse();

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.content).toContain("AI Builders Digest");
    expect(result!.tweetCount).toBe(2);
    expect(result!.paperCount).toBe(1);
    expect(result!.podcastCount).toBe(1);
    expect(result!.newsletterCount).toBe(1);
    expect(result!.itemCount).toBe(5);
    expect(result!.model).toBe("claude-haiku-4-5-20251001");
  });

  // -- Single content type ------------------------------------------------------

  it("generates digest with only tweets", async () => {
    const tweets = [
      makeFeedItem({ id: 1, source_type: "tweet", external_id: "t1" }),
    ];

    mockSql.mockResolvedValueOnce(tweets); // 24h query
    mockSql.mockResolvedValueOnce([]);     // 72h query
    mockAnthropicResponse();

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.tweetCount).toBe(1);
    expect(result!.podcastCount).toBe(0);
    expect(result!.newsletterCount).toBe(0);
    expect(result!.paperCount).toBe(0);
    expect(result!.itemCount).toBe(1);

    // System prompt should include SUMMARIZE_TWEETS but not others
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("SUMMARIZE_TWEETS_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_PODCAST_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_NEWSLETTER_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_PAPERS_PROMPT");
  });

  // -- Partial content types ----------------------------------------------------

  it("generates digest with only podcasts and newsletters", async () => {
    const podcasts = [
      makeFeedItem({ id: 1, source_type: "podcast", external_id: "pod1", title: "Pod" }),
    ];
    const newsletters = [
      makeFeedItem({ id: 2, source_type: "newsletter", external_id: "n1", title: "News" }),
    ];

    mockSql.mockResolvedValueOnce([]);                        // 24h query (no tweets/papers)
    mockSql.mockResolvedValueOnce([...podcasts, ...newsletters]); // 72h query
    mockAnthropicResponse();

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.tweetCount).toBe(0);
    expect(result!.podcastCount).toBe(1);
    expect(result!.newsletterCount).toBe(1);
    expect(result!.paperCount).toBe(0);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("SUMMARIZE_PODCAST_PROMPT");
    expect(callArgs.system).toContain("SUMMARIZE_NEWSLETTER_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_TWEETS_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_PAPERS_PROMPT");
  });

  // -- System prompt assembly ---------------------------------------------------

  it("builds system prompt with DIGEST_INTRO and only relevant SUMMARIZE prompts", async () => {
    const tweets = [makeFeedItem({ source_type: "tweet" })];
    const papers = [makeFeedItem({ source_type: "paper", title: "Paper" })];

    mockSql.mockResolvedValueOnce([...tweets, ...papers]); // 24h
    mockSql.mockResolvedValueOnce([]);                     // 72h
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("DIGEST_INTRO_PROMPT");
    expect(callArgs.system).toContain("SUMMARIZE_TWEETS_PROMPT");
    expect(callArgs.system).toContain("SUMMARIZE_PAPERS_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_PODCAST_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_NEWSLETTER_PROMPT");
  });

  // -- User message format ------------------------------------------------------

  it("builds user message as JSON grouped by source type", async () => {
    const tweets = [makeFeedItem({ source_type: "tweet", content: "tweet text" })];
    const podcasts = [makeFeedItem({ source_type: "podcast", content: "podcast transcript" })];

    mockSql.mockResolvedValueOnce(tweets);    // 24h
    mockSql.mockResolvedValueOnce(podcasts);  // 72h
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    const parsed = JSON.parse(userMessage);

    expect(parsed.tweets).toBeDefined();
    expect(parsed.tweets).toHaveLength(1);
    expect(parsed.podcasts).toBeDefined();
    expect(parsed.podcasts).toHaveLength(1);
    expect(parsed.newsletters).toBeUndefined();
    expect(parsed.papers).toBeUndefined();
  });

  it("user message includes source URL for every feed item", async () => {
    const items = [
      makeFeedItem({ source_type: "tweet", url: "https://x.com/user/status/111" }),
      makeFeedItem({ source_type: "tweet", url: "https://x.com/user/status/222", external_id: "t2" }),
    ];

    mockSql.mockResolvedValueOnce(items); // 24h
    mockSql.mockResolvedValueOnce([]);    // 72h
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    const parsed = JSON.parse(userMessage);

    for (const tweet of parsed.tweets) {
      expect(tweet.url).toBeDefined();
      expect(tweet.url).toMatch(/^https?:\/\//);
    }
  });

  it("user message includes tweet_meta and paper_meta when present", async () => {
    const tweetMeta = { likes: 42, retweets: 10, replies: 3, isQuote: false, quotedTweetId: null };
    const paperMeta = { upvotes: 15, numComments: 5, githubRepo: "org/repo", githubStars: 100, aiSummary: null, aiKeywords: null, authors: [{ name: "Author" }] };
    const items = [
      makeFeedItem({ source_type: "tweet", tweet_meta: tweetMeta }),
      makeFeedItem({ source_type: "paper", external_id: "p1", paper_meta: paperMeta, title: "ML Paper" }),
    ];

    mockSql.mockResolvedValueOnce(items); // 24h
    mockSql.mockResolvedValueOnce([]);    // 72h
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.messages[0].content);

    expect(parsed.tweets[0].tweet_meta).toEqual(tweetMeta);
    expect(parsed.papers[0].paper_meta).toEqual(paperMeta);
  });

  // -- Null optional fields -----------------------------------------------------

  it("handles feed items with null optional fields", async () => {
    const items = [
      makeFeedItem({
        source_type: "tweet",
        title: null,
        published_at: null,
        author_handle: null,
        author_bio: null,
      }),
    ];

    mockSql.mockResolvedValueOnce(items); // 24h
    mockSql.mockResolvedValueOnce([]);    // 72h
    mockAnthropicResponse();

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.tweetCount).toBe(1);
  });

  // -- Default model ------------------------------------------------------------

  it("uses default model claude-haiku-4-5-20251001", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses DIGEST_MODEL as the configured default model", async () => {
    process.env.DIGEST_MODEL = "claude-sonnet-4-6";
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  // -- Model override -----------------------------------------------------------

  it("allows model override via parameter", async () => {
    process.env.DIGEST_MODEL = "claude-haiku-4-5-20251001";
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest("claude-sonnet-4-20250514");

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-sonnet-4-20250514");
  });

  it("resolves digest model with explicit, env, and fallback precedence", () => {
    expect(resolveDigestModel(" claude-opus-4-1 ", {
      DIGEST_MODEL: "claude-sonnet-4-6",
    })).toBe("claude-opus-4-1");
    expect(resolveDigestModel(undefined, {
      DIGEST_MODEL: " claude-sonnet-4-6 ",
    })).toBe("claude-sonnet-4-6");
    expect(resolveDigestModel(" ", {
      DIGEST_MODEL: "",
    })).toBe("claude-haiku-4-5-20251001");
  });

  // -- Time window queries ------------------------------------------------------

  it("queries tweets and papers from last 24h, podcasts and newsletters from last 72h", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await generateDigest();

    expect(mockSql).toHaveBeenCalledTimes(2);

    // First call: 24h query for tweets and papers
    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(firstCallTemplate).toContain("feed_items");
    expect(firstCallTemplate).toMatch(/24 hours/i);

    // Second call: 72h query for podcasts and newsletters
    const secondCallTemplate = mockSql.mock.calls[1][0].join(" ");
    expect(secondCallTemplate).toContain("feed_items");
    expect(secondCallTemplate).toMatch(/72 hours/i);
  });

  it("gates paper selection on digest_ready and semantic success", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await generateDigest();

    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(firstCallTemplate).toContain("paper_processing_state");
    expect(firstCallTemplate).toContain("pps.digest_ready = TRUE");
    expect(firstCallTemplate).toContain("pps.semantic_status = 'succeeded'");
    expect(firstCallTemplate).toContain("intakeDefaultTier");
    expect(firstCallTemplate).toContain("graceDays");
  });

  // -- Deduplication: exclude already-digested items ----------------------------

  it("excludes already-digested items via NOT IN subquery on source_item_ids", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await generateDigest();

    // Both queries should contain the exclusion clause
    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    const secondCallTemplate = mockSql.mock.calls[1][0].join(" ");

    expect(firstCallTemplate).toContain("NOT IN");
    expect(firstCallTemplate).toContain("source_item_ids");
    expect(secondCallTemplate).toContain("NOT IN");
    expect(secondCallTemplate).toContain("source_item_ids");
  });

  // -- Deduplication: scoped time window ----------------------------------------

  it("scopes deduplication subquery to digests within last 72 hours", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await generateDigest();

    // Both subqueries should limit to recent digests, not scan all-time
    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    const secondCallTemplate = mockSql.mock.calls[1][0].join(" ");

    // The UNNEST subquery should have its own WHERE clause with a time window
    expect(firstCallTemplate).toMatch(/digests\s+WHERE\s+generated_at/i);
    expect(secondCallTemplate).toMatch(/digests\s+WHERE\s+generated_at/i);
  });

  // -- Force flag: skip deduplication ------------------------------------------

  it("skips deduplication when force=true", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest(undefined, true);

    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    const secondCallTemplate = mockSql.mock.calls[1][0].join(" ");

    // Neither query should exclude already digested source_item_ids.
    expect(firstCallTemplate).not.toContain("source_item_ids");
    expect(secondCallTemplate).not.toContain("source_item_ids");
  });

  it("still excludes digested items when force is not set", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await generateDigest();

    const firstCallTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(firstCallTemplate).toContain("NOT IN");
    expect(firstCallTemplate).toContain("source_item_ids");
  });

  // -- Multiple text blocks in response -----------------------------------------

  it("concatenates multiple text blocks in Claude response", async () => {
    const items = [makeFeedItem()];
    mockSql.mockResolvedValueOnce(items);
    mockSql.mockResolvedValueOnce([]);

    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Part 1 of digest" },
        { type: "text", text: "Part 2 of digest" },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.content).toContain("Part 1 of digest");
    expect(result!.content).toContain("Part 2 of digest");
  });

  it("returns empty string content when Claude returns no text blocks", async () => {
    const items = [makeFeedItem()];
    mockSql.mockResolvedValueOnce(items);
    mockSql.mockResolvedValueOnce([]);

    mockCreate.mockResolvedValueOnce({
      content: [],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 500, output_tokens: 0 },
    });

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.content).toBe("");
  });

  // -- Phase D: Edge cases ------------------------------------------------------

  it("propagates database query errors from 24h SQL", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection timeout"));

    await expect(generateDigest()).rejects.toThrow("connection timeout");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sets max_tokens in the Claude API call", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    expect(mockCreate.mock.calls[0][0].max_tokens).toBeDefined();
    expect(mockCreate.mock.calls[0][0].max_tokens).toBeGreaterThan(0);
  });

  it("scales max_tokens for journal-club paper-heavy digests", async () => {
    const papers = Array.from({ length: 20 }, (_, index) =>
      makeFeedItem({
        id: index + 1,
        source_type: "paper",
        external_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
      }),
    );

    mockSql.mockResolvedValueOnce(papers);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    expect(mockCreate.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(13_000);
  });

  it("retries with the maximum token budget when Claude stops at max_tokens", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse("partial digest", { stop_reason: "max_tokens" });
    mockAnthropicResponse("complete digest");

    const result = await generateDigest();

    expect(result!.content).toBe("complete digest");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4_096);
    expect(mockCreate.mock.calls[1][0].max_tokens).toBe(16_384);
  });

  it("throws instead of returning a truncated digest when the retry also stops at max_tokens", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse("partial digest", { stop_reason: "max_tokens" });
    mockAnthropicResponse("still partial", { stop_reason: "max_tokens" });

    await expect(generateDigest()).rejects.toThrow("refusing to store a truncated digest");
  });

  it("generates digest with only papers (24h window single type)", async () => {
    const papers = [
      makeFeedItem({ source_type: "paper", external_id: "p1", title: "ML Paper" }),
    ];

    mockSql.mockResolvedValueOnce(papers); // 24h
    mockSql.mockResolvedValueOnce([]);     // 72h
    mockAnthropicResponse();

    const result = await generateDigest();

    expect(result).not.toBeNull();
    expect(result!.paperCount).toBe(1);
    expect(result!.tweetCount).toBe(0);
    expect(result!.podcastCount).toBe(0);
    expect(result!.newsletterCount).toBe(0);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("SUMMARIZE_PAPERS_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_TWEETS_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_PODCAST_PROMPT");
    expect(callArgs.system).not.toContain("SUMMARIZE_NEWSLETTER_PROMPT");
  });

  it("includes bounded paper profile and deterministic evidence cards in the prompt", async () => {
    const longProfile = `${"profile ".repeat(300)}important final words`;
    const paper = makeFeedItem({
      id: 42,
      source_type: "paper",
      external_id: "p1",
      title: "Hydrated Paper",
      paper_profile_text: longProfile,
      paper_evidence_cards: Array.from({ length: 8 }, (_, index) => ({
        claim: `${"claim ".repeat(100)}${index}`,
        claim_type: "result",
        section_path: ["Hydrated Paper", "Results"],
        numbers: ["500 tasks", "99% pass rate"],
        confidence: 0.9,
      })),
    });

    mockSql.mockResolvedValueOnce([paper]);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.messages[0].content);
    const payloadPaper = parsed.papers[0];

    expect(payloadPaper.paper_reader_profile.profile_text).toContain("profile");
    expect(payloadPaper.paper_reader_profile.profile_text.length).toBeLessThanOrEqual(1200);
    expect(payloadPaper.paper_evidence_cards).toHaveLength(5);
    expect(payloadPaper.paper_evidence_cards[0].claim.length).toBeLessThanOrEqual(320);
    expect(payloadPaper.paper_evidence_cards[0]).toMatchObject({
      claim_type: "result",
      section_path: ["Hydrated Paper", "Results"],
      numbers: ["500 tasks", "99% pass rate"],
      confidence: 0.9,
    });
  });

  it("returns skipped deterministic-pending and dead paper IDs with metadata", async () => {
    mockSql.mockResolvedValueOnce([
      { id: 7, deterministic_status: "pending", semantic_status: "pending", total_count: 3 },
      { id: 8, deterministic_status: "succeeded", semantic_status: "pending", total_count: 3 },
      { id: 9, deterministic_status: "dead", semantic_status: "pending", total_count: 3 },
    ]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await generateDigestWithMetadata();

    expect(result.digest).toBeNull();
    expect(result.skippedPapers).toMatchObject({
      total: 3,
      ids: [7, 8, 9],
      countsByDeterministicStatus: { pending: 1, succeeded: 1, dead: 1 },
      countsBySemanticStatus: { pending: 3 },
      pendingIds: [7, 8],
      deadIds: [9],
    });
  });

  // -- Error propagation --------------------------------------------------------

  it("propagates Anthropic API errors", async () => {
    mockSql.mockResolvedValueOnce([makeFeedItem()]);
    mockSql.mockResolvedValueOnce([]);

    mockCreate.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    await expect(generateDigest()).rejects.toThrow("Rate limit exceeded");
  });

  // -- topReplies data flow -----------------------------------------------------

  it("includes topReplies in tweet_meta when passed to LLM", async () => {
    const tweetMeta = {
      likes: 42,
      retweets: 10,
      replies: 3,
      isQuote: false,
      quotedTweetId: null,
      topReplies: [
        { authorHandle: "replier", authorName: "Reply User", text: "Great point!", likes: 15 },
      ],
    };
    const items = [
      makeFeedItem({ source_type: "tweet", tweet_meta: tweetMeta }),
    ];

    mockSql.mockResolvedValueOnce(items);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.messages[0].content);

    expect(parsed.tweets[0].tweet_meta.topReplies).toHaveLength(1);
    expect(parsed.tweets[0].tweet_meta.topReplies[0].authorHandle).toBe("replier");
    expect(parsed.tweets[0].tweet_meta.topReplies[0].text).toBe("Great point!");
  });

  it("passes null topReplies through to LLM without error", async () => {
    const tweetMeta = {
      likes: 10,
      retweets: 2,
      replies: 0,
      isQuote: false,
      quotedTweetId: null,
      topReplies: null,
    };
    const items = [
      makeFeedItem({ source_type: "tweet", tweet_meta: tweetMeta }),
    ];

    mockSql.mockResolvedValueOnce(items);
    mockSql.mockResolvedValueOnce([]);
    mockAnthropicResponse();

    await generateDigest();

    const callArgs = mockCreate.mock.calls[0][0];
    const parsed = JSON.parse(callArgs.messages[0].content);

    expect(parsed.tweets[0].tweet_meta.topReplies).toBeNull();
  });
});

// -- Prompt content regression tests ------------------------------------------

describe("prompt content checks", () => {
  const summarizeTweets = readFileSync(
    join(process.cwd(), "prompts/summarize-tweets.md"),
    "utf-8"
  );

  const digestIntro = readFileSync(
    join(process.cwd(), "prompts/digest-intro.md"),
    "utf-8"
  );

  it("does not contain fixed sentence count instruction", () => {
    expect(summarizeTweets).not.toContain("Write 2-4 sentences per builder");
  });

  it("contains proportionality instruction", () => {
    expect(summarizeTweets).toContain("Match your summary length");
  });

  it("contains anti-hallucination rule", () => {
    expect(summarizeTweets).toContain("NEVER add information");
  });

  it("contains topReplies instruction", () => {
    expect(summarizeTweets).toContain("topReplies");
  });

  it("digest intro contains short-post expansion rule", () => {
    expect(digestIntro).toContain("NEVER expand a short post");
  });
});
