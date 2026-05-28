import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { sql } from "@/lib/db";
import type { Digest, FeedItem, FeedItemSourceType } from "@/lib/schema";
import { BRIEFING, BRIEFING_MEMORY } from "../prompts";
import {
  BRIEFING_BUDGETS,
  CURRENT_REALTIME_BRIEFING_BUDGETS,
  DEFAULT_BRIEFING_MODEL,
  CURRENT_BRIEFING_MODEL,
  buildBriefingDigestContext,
  buildBriefingDigestItemManifest,
  buildBriefingPromptPayload,
  buildBriefingSourceIndex,
  buildBriefingTools,
  buildPromptTokenCountRepresentation,
  estimatePromptTokens,
  formatDigestItemToolResult,
  getBriefingSourceItems,
  rankBriefingSourceItems,
  resolveBriefingRealtimeModel,
  type BriefingSourceItem,
} from "../briefing";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function makeSourceItem(
  overrides: Partial<BriefingSourceItem> = {},
): BriefingSourceItem {
  return {
    id: 1,
    source_type: "tweet",
    title: null,
    author_name: "Test Author",
    published_at: "2026-04-14T10:00:00Z",
    url: "https://example.com/item/1",
    preview:
      "A compact preview that still gives the ranking and source-index helpers enough context to work with.",
    retrievalRank: 0,
    ...overrides,
  };
}

function makeDigest(
  overrides: Partial<Digest> = {},
): Digest {
  return {
    id: 1,
    content: "# Daily Digest\n\n- Item one\n- Item two",
    item_count: 2,
    tweet_count: 1,
    podcast_count: 0,
    newsletter_count: 0,
    paper_count: 1,
    source_item_ids: [1, 2],
    model: "claude-haiku-4-5-20251001",
    generated_at: "2026-04-14T10:00:00Z",
    ...overrides,
  };
}

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 1,
    source_type: "tweet",
    external_id: "tweet-1",
    source_id: null,
    title: null,
    content: "hello world",
    url: "https://example.com/feed/1",
    author_name: "Test Author",
    author_handle: "test-author",
    author_bio: null,
    published_at: "2026-04-14T10:00:00Z",
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
    fetched_at: "2026-04-14T10:05:00Z",
    ...overrides,
  };
}

describe("getBriefingSourceItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a projected query and preserves source_item_ids order", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 10,
        source_type: "paper",
        title: "Paper",
        author_name: "Paper Author",
        published_at: "2026-04-14T09:00:00Z",
        url: "https://example.com/paper",
        preview: "Paper summary",
      },
      {
        id: 5,
        source_type: "tweet",
        title: null,
        author_name: "Tweet Author",
        published_at: "2026-04-14T08:00:00Z",
        url: "https://example.com/tweet",
        preview: "Tweet text",
      },
    ]);

    const items = await getBriefingSourceItems({
      digest: {
        source_item_ids: [5, 10],
        generated_at: "2026-04-14T10:00:00Z",
      },
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSql.mock.calls[0][0].join(" ")).not.toContain("SELECT *");
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("LEFT(");
    expect(items.map((item) => item.id)).toEqual([5, 10]);
  });
});

describe("buildBriefingDigestContext", () => {
  it("normalizes markdown noise while preserving headings and bullets", () => {
    const digest = makeDigest({
      content: [
        "# Daily Digest",
        "",
        "---",
        "",
        "## Highlights",
        "",
        "-   First point",
        "- Second point",
        "",
        "",
        "### Detail",
        "",
        "A paragraph with    uneven spacing.",
      ].join("\n"),
    });

    const context = buildBriefingDigestContext(digest, { maxChars: 240 });

    expect(context.text).toContain("## Digest Context");
    expect(context.text).toContain("# Daily Digest");
    expect(context.text).toContain("## Highlights");
    expect(context.text).toContain("- First point");
    expect(context.text).not.toContain("---");
    expect(context.charCount).toBeLessThanOrEqual(240);
  });
});

describe("buildBriefingDigestItemManifest", () => {
  it("covers the full digest item set and compacts labels when requested", () => {
    const sourceItems = [
      makeSourceItem({
        id: 1,
        source_type: "paper",
        title: "A Long Paper Title About Compiler Architectures",
        author_name: "Alice",
        retrievalRank: 0,
      }),
      makeSourceItem({
        id: 2,
        source_type: "podcast",
        title: "Infra Episode 21",
        author_name: "Bob",
        retrievalRank: 1,
      }),
      makeSourceItem({
        id: 3,
        source_type: "tweet",
        title: null,
        author_name: "Carol",
        retrievalRank: 2,
      }),
    ];

    const regular = buildBriefingDigestItemManifest(sourceItems);
    const compact = buildBriefingDigestItemManifest(sourceItems, {
      compactLabels: true,
    });

    expect(regular.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(regular.text).toContain("A Long Paper Title");
    expect(compact.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(compact.charCount).toBeLessThan(regular.charCount);
  });
});

describe("rankBriefingSourceItems", () => {
  it("boosts digest title and author mentions before stable fallback ordering", () => {
    const digest = makeDigest({
      content:
        "Karpathy focused on inference stacks, and Thinking Machines stood out as the most important paper.",
      source_item_ids: [1, 2, 3],
    });
    const sourceItems = [
      makeSourceItem({
        id: 1,
        source_type: "newsletter",
        title: "Infra Notes",
        author_name: "Taylor",
        retrievalRank: 0,
      }),
      makeSourceItem({
        id: 2,
        source_type: "tweet",
        title: null,
        author_name: "Andrej Karpathy",
        retrievalRank: 1,
      }),
      makeSourceItem({
        id: 3,
        source_type: "paper",
        title: "Thinking Machines",
        author_name: "Research Team",
        retrievalRank: 2,
      }),
    ];

    const ranked = rankBriefingSourceItems({ digest, sourceItems });

    expect(ranked.map((item) => item.id).slice(0, 2)).toEqual([3, 2]);
  });

  it("falls back deterministically when digest prose lacks title or author matches", () => {
    const digest = makeDigest({
      content: "A broad industry roundup without explicit names.",
      source_item_ids: [20, 10, 30],
    });
    const sourceItems = [
      makeSourceItem({
        id: 10,
        source_type: "tweet",
        title: null,
        author_name: "Alice",
        published_at: null,
        retrievalRank: 1,
      }),
      makeSourceItem({
        id: 20,
        source_type: "tweet",
        title: null,
        author_name: "Bob",
        published_at: null,
        retrievalRank: 0,
      }),
      makeSourceItem({
        id: 30,
        source_type: "paper",
        title: "Compiler Tricks",
        author_name: "Carol",
        published_at: "2026-04-14T11:00:00Z",
        retrievalRank: 2,
      }),
    ];

    const ranked = rankBriefingSourceItems({ digest, sourceItems });

    expect(ranked.map((item) => item.id)).toEqual([30, 20, 10]);
  });
});

describe("buildBriefingSourceIndex", () => {
  it("keeps source-type spread, caps tweet-heavy digests, and stays within budget", () => {
    const sourceTypes: FeedItemSourceType[] = [
      "tweet",
      "tweet",
      "tweet",
      "tweet",
      "tweet",
      "tweet",
      "paper",
      "paper",
      "podcast",
      "podcast",
      "newsletter",
      "newsletter",
      "tweet",
      "tweet",
    ];

    const rankedItems = sourceTypes.map((sourceType, index) =>
      makeSourceItem({
        id: index + 1,
        source_type: sourceType,
        title: sourceType === "tweet" ? null : `${sourceType} title ${index + 1}`,
        author_name: `Author ${index + 1}`,
        preview:
          "This is a deliberately long preview block meant to force preview shortening when the source index budget is enforced. ".repeat(
            4,
          ),
        retrievalRank: index,
      }),
    );

    const sourceIndex = buildBriefingSourceIndex(rankedItems, {
      budgets: CURRENT_REALTIME_BRIEFING_BUDGETS,
    });
    const typesInIndex = new Set(sourceIndex.items.map((item) => item.source_type));
    const tweetCount = sourceIndex.items.filter(
      (item) => item.source_type === "tweet",
    ).length;

    expect(sourceIndex.items.length).toBeLessThanOrEqual(
      CURRENT_REALTIME_BRIEFING_BUDGETS.sourceIndexItemCount,
    );
    expect(sourceIndex.charCount).toBeLessThanOrEqual(
      CURRENT_REALTIME_BRIEFING_BUDGETS.sourceIndexChars,
    );
    expect(typesInIndex).toEqual(
      new Set<FeedItemSourceType>(["tweet", "paper", "podcast", "newsletter"]),
    );
    expect(tweetCount).toBeLessThanOrEqual(4);
    sourceIndex.items.forEach((item) => {
      expect(item.preview.length).toBeLessThanOrEqual(
        sourceIndex.previewCharLimits[item.source_type],
      );
    });
  });
});

describe("buildBriefingPromptPayload", () => {
  it("omits memory instructions unless both memory tools are available", () => {
    const digest = makeDigest();
    const sourceItems = [makeSourceItem()];
    const nonMemoryTools = buildBriefingTools({ env: {} });
    const memoryTools = buildBriefingTools({ env: { MEMORY_READS_ENABLED: "true" } });

    const withoutMemory = buildBriefingPromptPayload({
      digest,
      sourceItems,
      tools: nonMemoryTools,
    });
    const withMemory = buildBriefingPromptPayload({
      digest,
      sourceItems,
      tools: memoryTools,
    });

    expect(withoutMemory.instructions).not.toContain("search_memory");
    expect(withoutMemory.instructions).not.toContain("get_memory_item");
    expect(withMemory.instructions).toContain("search_memory");
    expect(withMemory.instructions).toContain("get_memory_item");
  });

  it("applies the planned fallback sequence and keeps the full manifest even when the index is trimmed", () => {
    const sourceItems = Array.from({ length: 28 }, (_, index) =>
      makeSourceItem({
        id: index + 1,
        source_type:
          index % 4 === 0
            ? "paper"
            : index % 4 === 1
              ? "podcast"
              : index % 4 === 2
                ? "newsletter"
                : "tweet",
        title:
          index % 4 === 3
            ? null
            : `Very long source title ${index + 1} about inference stacks and agent systems`,
        author_name: `Long Author Name ${index + 1}`,
        preview:
          "This preview is intentionally long so the source index builder has to shorten and potentially drop lower-value items to stay inside the briefing budget. ".repeat(
            3,
          ),
        retrievalRank: index,
      }),
    );
    const digest = makeDigest({
      content: "# Daily Digest\n\n" + "Detailed paragraph. ".repeat(900),
      source_item_ids: sourceItems.map((item) => item.id),
      item_count: sourceItems.length,
    });

    const payload = buildBriefingPromptPayload({
      digest,
      sourceItems,
      budgets: CURRENT_REALTIME_BRIEFING_BUDGETS,
    });

    expect(payload.digestItemManifest.items).toHaveLength(sourceItems.length);
    expect(payload.sourceIndex.items.length).toBeLessThan(sourceItems.length);
    expect(payload.stepsApplied).toContain("compact_manifest_labels");
    expect(payload.stepsApplied).toContain("compact_digest_context");
    expect(payload.budget.withinHardCeiling).toBe(true);
  });
});

describe("briefing model resolution", () => {
  it("defaults to gpt-realtime-2 and only allows the current rollback model", () => {
    expect(DEFAULT_BRIEFING_MODEL).toBe("gpt-realtime-2");
    expect(CURRENT_BRIEFING_MODEL).toBe("gpt-realtime");
    expect(resolveBriefingRealtimeModel()).toBe("gpt-realtime-2");
    expect(
      resolveBriefingRealtimeModel({ BRIEFING_REALTIME_MODEL: "gpt-realtime" }),
    ).toBe("gpt-realtime");
    expect(
      resolveBriefingRealtimeModel({ BRIEFING_REALTIME_MODEL: "bad-model" }),
    ).toBe("gpt-realtime-2");
  });
});

describe("briefing prompt", () => {
  it("keeps memory guidance separate unless memory tools are present", () => {
    expect(BRIEFING).not.toContain("search_memory");
    expect(BRIEFING).not.toContain("get_memory_item");
    expect(BRIEFING).not.toContain("Before every tool call");
    expect(BRIEFING_MEMORY).toContain("search_memory");
    expect(BRIEFING_MEMORY).toContain("get_memory_item");
    expect(BRIEFING_MEMORY).toContain("currentDigestOnly");
    expect(BRIEFING_MEMORY).not.toContain("Always say a short preamble");
  });

  it("includes conditional preambles, silence handling, and unclear audio guidance", () => {
    expect(BRIEFING).toContain("Use `commentary` only for a short spoken preamble");
    expect(BRIEFING).toContain("Use `final_answer` for the substantive answer");
    expect(BRIEFING).toContain("When a response will not be immediate, first acknowledge what the user asked");
    expect(BRIEFING).toContain("`get_digest_item`, `list_archive_items`, `search_archive`, or any memory");
    expect(BRIEFING).toContain("After a retrieval tool returns results, do not narrate the tool success");
    expect(BRIEFING).toContain("The indexed material I have for");
    expect(BRIEFING).toContain("Do not expose internal retrieval terms like chunks");
    expect(BRIEFING_MEMORY).toContain("Use a short `commentary` preamble immediately before either memory tool.");
    expect(BRIEFING_MEMORY).toContain("After a memory tool returns, answer in normal conversation");
    expect(BRIEFING).toContain("Skip preambles for quick direct answers");
    expect(BRIEFING).toContain("Do not treat archive item ids as passage ids");
    expect(BRIEFING).toContain("broad named-person/entity lookup");
    expect(BRIEFING).toContain("Call `wait_for_user` for silence, background noise, hold music, TV");
    expect(BRIEFING).toContain('Short backchannels like "uh-huh", "hmm"');
    expect(BRIEFING).toContain("resume from the next unfinished item");
    expect(BRIEFING).toContain("Ask one short clarification question.");
  });

  it("still opens with a proactive digest", () => {
    expect(BRIEFING).toContain("Don't ask what to cover.");
    expect(BRIEFING).toContain("open proactively with what matters");
    expect(BRIEFING).toContain("spend 5–8 minutes on the");
    expect(BRIEFING).toContain("skip, speed up, or summarize");
    expect(BRIEFING).toContain("title plus abstract summary");
  });

  it("frames paper discovery as candidates and paper claims as evidence", () => {
    expect(BRIEFING_MEMORY).toContain('set `source: "paper"` and `mode: "discovery"`');
    expect(BRIEFING_MEMORY).toContain("Discovery results");
    expect(BRIEFING_MEMORY).toContain("candidate or related papers");
    expect(BRIEFING_MEMORY).toContain("A few relevant papers are");
    expect(BRIEFING_MEMORY).toContain('Do not phrase');
    expect(BRIEFING_MEMORY).toContain('mode: "evidence"');
    expect(BRIEFING_MEMORY).toContain("When unsure, prefer");
    expect(BRIEFING_MEMORY).toContain("keep the first evidence query broad");
    expect(BRIEFING_MEMORY).toContain("main claims contributions methods results");
  });
});

describe("buildBriefingTools", () => {
  it("excludes memory tools by default", () => {
    const tools = buildBriefingTools({ env: {} });

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_digest_item",
      "search_archive",
      "list_archive_items",
      "wait_for_user",
    ]);
    expect(tools[0].parameters.additionalProperties).toBe(false);
    expect(
      (tools[1].parameters.properties.limit as { maximum: number }).maximum,
    ).toBe(20);
    expect(
      (tools[2].parameters.properties.limit as { maximum: number }).maximum,
    ).toBe(20);
  });

  it("includes chunk-only memory tools when memory reads are enabled", () => {
    const tools = buildBriefingTools({
      env: { MEMORY_READS_ENABLED: "true" },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_digest_item",
      "search_archive",
      "list_archive_items",
      "search_memory",
      "get_memory_item",
      "wait_for_user",
    ]);
    expect(tools[0].description).toContain(
      "Do not use this as the evidence path for paper methods",
    );
    expect(tools[1].description).toContain(
      "search the archive for PERSON/ENTITY",
    );
    expect(tools[2].description).toContain(
      "Do not use for named-person/entity archive search",
    );
    expect(
      (tools[3].parameters.properties.limit as { maximum: number }).maximum,
    ).toBe(20);
    expect(
      (tools[3].parameters.properties.scope as { enum: string[] }).enum,
    ).toEqual(["all", "chunk"]);
    expect(
      (tools[3].parameters.properties.paperCorpusScope as { enum: string[] })
        .enum,
    ).toEqual(["default", "latest", "archive", "all"]);
    expect(tools[3].description).toContain("mode='discovery'");
    expect(tools[3].description).toContain("candidate or related papers");
    expect(tools[3].description).toContain("not verified answers");
    expect(tools[3].description).toContain("when unsure, prefer evidence");
    expect(tools[3].parameters.properties.currentDigestOnly).toEqual({
      type: "boolean",
    });
    expect(
      (tools[4].parameters.properties.memory_kind as { enum: string[] }).enum,
    ).toEqual(["chunk"]);
  });
});

describe("token counting helpers", () => {
  it("builds a counting representation and falls back cleanly when no API key is configured", async () => {
    const representation = buildPromptTokenCountRepresentation({
      instructions: "System prompt",
      tools: buildBriefingTools(),
    });

    const estimate = await estimatePromptTokens({
      representation,
      apiKey: "",
    });

    expect(representation.model).toBe("gpt-realtime-2");
    expect(representation.input[0].content[0].text).toBe("System prompt");
    expect(estimate).toEqual({
      available: false,
      reason: "missing_api_key",
    });
  });

  it("accepts a successful token estimate response", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ input_tokens: 4321 }),
    });
    const representation = buildPromptTokenCountRepresentation({
      instructions: "System prompt",
    });

    const estimate = await estimatePromptTokens({
      representation,
      apiKey: "test-key",
      fetchImplementation,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(estimate).toMatchObject({
      available: true,
      inputTokens: 4321,
    });
  });
});

describe("formatDigestItemToolResult", () => {
  it("keeps tool output bounded and relay-safe", () => {
    const result = formatDigestItemToolResult(
      makeFeedItem({
        source_type: "tweet",
        content:
          "This is a very long tweet thread body. ".repeat(80),
        tweet_meta: {
          likes: 10,
          retweets: 4,
          replies: 3,
          isQuote: false,
          quotedTweetId: null,
          topReplies: [
            {
              authorHandle: "reply1",
              authorName: "Reply One",
              text: "A very long reply body. ".repeat(30),
              likes: 5,
            },
            {
              authorHandle: "reply2",
              authorName: "Reply Two",
              text: "Another long reply body. ".repeat(30),
              likes: 4,
            },
          ],
        },
      }),
    );

    expect(result.content_excerpt.length).toBeLessThanOrEqual(800);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      BRIEFING_BUDGETS.toolPayloadTargetChars,
    );
  });
});
