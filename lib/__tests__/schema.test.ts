import { describe, it, expect } from "vitest";
import type {
  Source,
  FeedItem,
  Digest,
  FeedItemInsert,
  SourceType,
  FeedItemSourceType,
  CorpusTier,
  TweetMeta,
  TopReply,
  KnowledgeChunk,
  KnowledgeNote,
  KnowledgeNoteSource,
  UserMemory,
  SearchMemoryToolArguments,
  SearchMemoryToolResult,
  GetMemoryItemToolResult,
  ThemeBriefToolResult,
  BuilderBriefToolResult,
} from "../schema";

describe("schema types", () => {
  it("Source type accepts valid x_account source", () => {
    const source: Source = {
      id: 1,
      type: "x_account",
      name: "Andrej Karpathy",
      handle: "karpathy",
      podcast_type: null,
      channel_handle: null,
      playlist_id: null,
      url: null,
      feed_url: null,
      created_at: "2026-01-01T00:00:00Z",
      active: true,
    };
    expect(source.type).toBe("x_account");
    expect(source.handle).toBe("karpathy");
    expect(source.active).toBe(true);
  });

  it("Source type accepts valid podcast source", () => {
    const source: Source = {
      id: 2,
      type: "podcast",
      name: "Latent Space",
      handle: null,
      podcast_type: "youtube_channel",
      channel_handle: "LatentSpacePod",
      playlist_id: null,
      url: "https://www.youtube.com/@LatentSpacePod",
      feed_url: null,
      created_at: "2026-01-01T00:00:00Z",
      active: true,
    };
    expect(source.type).toBe("podcast");
    expect(source.podcast_type).toBe("youtube_channel");
  });

  it("Source type accepts valid newsletter source", () => {
    const source: Source = {
      id: 3,
      type: "newsletter",
      name: "AI Newsletter",
      handle: null,
      podcast_type: null,
      channel_handle: null,
      playlist_id: null,
      url: "https://example.substack.com",
      feed_url: "https://example.substack.com/feed",
      created_at: "2026-01-01T00:00:00Z",
      active: true,
    };
    expect(source.type).toBe("newsletter");
    expect(source.feed_url).toBe("https://example.substack.com/feed");
  });

  it("Source type accepts valid papers source", () => {
    const source: Source = {
      id: 4,
      type: "papers",
      name: "Hugging Face Daily Papers",
      handle: null,
      podcast_type: null,
      channel_handle: null,
      playlist_id: null,
      url: null,
      feed_url: null,
      created_at: "2026-01-01T00:00:00Z",
      active: true,
    };
    expect(source.type).toBe("papers");
  });

  it("all four source types are valid", () => {
    const types: SourceType[] = [
      "x_account",
      "podcast",
      "newsletter",
      "papers",
    ];
    expect(types).toHaveLength(4);
  });

  it("all four feed item source types are valid", () => {
    const types: FeedItemSourceType[] = [
      "tweet",
      "podcast",
      "newsletter",
      "paper",
    ];
    expect(types).toHaveLength(4);
  });

  it("all four corpus tiers are valid", () => {
    const tiers: CorpusTier[] = [
      "hot_set",
      "core_canon",
      "archive",
      "ignored",
    ];
    expect(tiers).toHaveLength(4);
  });

  it("FeedItemInsert requires minimum fields", () => {
    const item: FeedItemInsert = {
      source_type: "tweet",
      external_id: "123456789",
      content: "AI agents are the future",
      url: "https://x.com/test/status/123456789",
      author_name: "Test User",
    };
    expect(item.source_type).toBe("tweet");
    expect(item.title).toBeUndefined();
    expect(item.tweet_meta).toBeUndefined();
  });

  it("FeedItemInsert accepts all optional fields", () => {
    const item: FeedItemInsert = {
      source_type: "tweet",
      external_id: "123456789",
      source_id: 1,
      title: null,
      content: "AI agents are the future",
      url: "https://x.com/test/status/123456789",
      author_name: "Test User",
      author_handle: "testuser",
      author_bio: "Building things",
      published_at: "2026-01-01T12:00:00Z",
      tweet_meta: {
        likes: 100,
        retweets: 20,
        replies: 5,
        isQuote: false,
        quotedTweetId: null,
        topReplies: null,
      },
      paper_meta: null,
    };
    expect(item.author_handle).toBe("testuser");
    expect(item.tweet_meta?.likes).toBe(100);
  });

  it("FeedItem has all required database fields", () => {
    const item: FeedItem = {
      id: 1,
      source_type: "paper",
      external_id: "2603.17187",
      source_id: null,
      title: "Attention Is All You Need (Revisited)",
      content: "Full abstract text here...",
      url: "https://arxiv.org/abs/2603.17187",
      author_name: "Researcher",
      author_handle: null,
      author_bio: null,
      published_at: "2026-03-19T00:00:00Z",
      tweet_meta: null,
      paper_meta: {
        upvotes: 42,
        numComments: 7,
        githubRepo: "https://github.com/example/repo",
        githubStars: 150,
        aiSummary: "A revisited approach to attention mechanisms",
        aiKeywords: ["attention", "transformers"],
        authors: [{ name: "Alice", user: "alice_hf" }],
      },
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
      fetched_at: "2026-03-20T06:00:00Z",
    };
    expect(item.id).toBe(1);
    expect(item.paper_meta?.upvotes).toBe(42);
    expect(item.fetched_at).toBeDefined();
  });

  it("TweetMeta accepts topReplies array", () => {
    const meta: TweetMeta = {
      likes: 42,
      retweets: 10,
      replies: 5,
      isQuote: false,
      quotedTweetId: null,
      topReplies: [
        { authorHandle: "replier", authorName: "Reply User", text: "Great point!", likes: 15 },
      ],
    };
    expect(meta.topReplies).toHaveLength(1);
    expect(meta.topReplies![0].authorHandle).toBe("replier");
    expect(meta.topReplies![0].text).toBe("Great point!");
  });

  it("TweetMeta accepts null topReplies", () => {
    const meta: TweetMeta = {
      likes: 10,
      retweets: 2,
      replies: 0,
      isQuote: false,
      quotedTweetId: null,
      topReplies: null,
    };
    expect(meta.topReplies).toBeNull();
  });

  it("TopReply has all required fields", () => {
    const reply: TopReply = {
      authorHandle: "commenter",
      authorName: "Comment User",
      text: "Interesting take",
      likes: 25,
    };
    expect(reply.authorHandle).toBe("commenter");
    expect(reply.authorName).toBe("Comment User");
    expect(reply.text).toBe("Interesting take");
    expect(reply.likes).toBe(25);
  });

  it("Digest has all count fields", () => {
    const digest: Digest = {
      id: 1,
      content: "# Daily AI Digest\n\nToday's highlights...",
      item_count: 30,
      tweet_count: 15,
      podcast_count: 3,
      newsletter_count: 5,
      paper_count: 7,
      source_item_ids: [1, 2, 3],
      model: "claude-haiku-4-5-20251001",
      generated_at: "2026-03-20T06:30:00Z",
    };
    expect(digest.item_count).toBe(30);
    expect(
      digest.tweet_count +
        digest.podcast_count +
        digest.newsletter_count +
        digest.paper_count
    ).toBe(30);
  });

  it("KnowledgeChunk includes retrieval metadata", () => {
    const chunk: KnowledgeChunk = {
      id: 1,
      feed_item_id: 42,
      chunk_index: 0,
      source_type: "newsletter",
      title: "Why memory systems fail",
      author_name: "Builder Weekly",
      published_at: "2026-04-24T08:00:00Z",
      text: "A bounded chunk of newsletter text",
      retrieval_text:
        "Source type: newsletter\nTitle: Why memory systems fail\nContent:\nA bounded chunk of newsletter text",
      token_count: 212,
      text_tsv: "'bound':1 'chunk':2",
      entity_labels: ["memory", "retrieval"],
      embedding_model: "text-embedding-3-small",
      embedding_updated_at: "2026-04-24T09:00:00Z",
      created_at: "2026-04-24T09:00:00Z",
      updated_at: "2026-04-24T09:00:00Z",
    };

    expect(chunk.feed_item_id).toBe(42);
    expect(chunk.entity_labels).toContain("memory");
  });

  it("KnowledgeNote stores structured claims and source refs", () => {
    const note: KnowledgeNote = {
      id: 7,
      scope: "builder",
      scope_key: "andrej-karpathy",
      title: "Karpathy keeps returning to eval ergonomics",
      summary: "Recent source material keeps framing evals as the bottleneck.",
      claims_json: [
        {
          claim: "Karpathy is focused on eval ergonomics.",
          confidence: "high",
          sourceFeedItemIds: [12, 14],
          sourceChunkIds: [31],
        },
      ],
      source_refs_json: [
        {
          feedItemId: 12,
          knowledgeChunkId: 31,
          citationReason: "supporting_evidence",
          excerpt: "evals are the bottleneck",
        },
      ],
      entity_labels: ["andrej karpathy", "evals"],
      effective_date: "2026-04-24",
      summary_tsv: "'ergonom':4 'eval':3",
      created_from_digest_id: 3,
      embedding_model: null,
      embedding_updated_at: null,
      created_at: "2026-04-24T10:00:00Z",
      updated_at: "2026-04-24T10:00:00Z",
    };

    expect(note.scope).toBe("builder");
    expect(note.claims_json[0].sourceFeedItemIds).toContain(12);
  });

  it("KnowledgeNoteSource links notes back to feed items", () => {
    const source: KnowledgeNoteSource = {
      id: 4,
      knowledge_note_id: 7,
      feed_item_id: 12,
      knowledge_chunk_id: 31,
      source_rank: 1,
      citation_reason: "supporting_evidence",
      excerpt: "evals are the bottleneck",
      created_at: "2026-04-24T10:00:00Z",
    };

    expect(source.knowledge_note_id).toBe(7);
    expect(source.citation_reason).toBe("supporting_evidence");
  });

  it("UserMemory captures briefing preferences and open questions", () => {
    const memory: UserMemory = {
      user_id: "user-123",
      preferred_topics: ["evals", "agents"],
      tracked_builders: ["andrej-karpathy"],
      known_context: [
        {
          topic: "evals",
          summary: "User already knows the basic harness landscape.",
          confidence: "medium",
          sourceDigestId: 2,
        },
      ],
      open_questions: [
        {
          question: "How are teams measuring agent reliability this month?",
          topic: "agents",
          status: "open",
          sourceDigestId: 3,
        },
      ],
      briefing_preferences: {
        voice: "marin",
        pace: "medium",
        verbosity: "brief",
      },
      last_briefing_at: "2026-04-24T11:00:00Z",
      created_at: "2026-04-24T11:00:00Z",
      updated_at: "2026-04-24T11:00:00Z",
    };

    expect(memory.preferred_topics).toContain("evals");
    expect(memory.open_questions[0].status).toBe("open");
  });

  it("SearchMemory tool contracts accept bounded inputs and mixed hits", () => {
    const args: SearchMemoryToolArguments = {
      query: "builder views on evals",
      scope: "all",
      source: "all",
      currentDigestOnly: true,
      limit: 4,
    };
    const result: SearchMemoryToolResult = {
      query: args.query,
      scope: "all",
      source: "all",
      current_digest_search: {
        searched: true,
        source_item_ids: [12],
        status: "hit",
      },
      results: [
        {
          kind: "note",
          id: 7,
          scope: "builder",
          scope_key: "andrej-karpathy",
          title: "Karpathy on eval ergonomics",
          summary: "He keeps returning to evaluation loops.",
          effective_date: "2026-04-24",
          source_refs: [
            {
              feedItemId: 12,
              knowledgeChunkId: 31,
              citationReason: "supporting_evidence",
              excerpt: "evaluation loops matter",
            },
          ],
        },
        {
          kind: "chunk",
          id: 31,
          feed_item_id: 12,
          source_type: "podcast",
          title: "On building eval systems",
          author_name: "Latent Space",
          published_at: "2026-04-23T00:00:00Z",
          url: "https://example.com/evals",
          text: "Full transcript text around the evaluation loops.",
          snippet: "A short bounded snippet from the transcript.",
          entity_labels: ["evals"],
        },
      ],
    };

    expect(args.limit).toBe(4);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].kind).toBe("note");
  });

  it("GetMemoryItem tool result supports chunk and note payloads", () => {
    const chunkResult: GetMemoryItemToolResult = {
      kind: "chunk",
      id: 31,
      feed_item_id: 12,
      source_type: "podcast",
      title: "On building eval systems",
      author_name: "Latent Space",
      published_at: "2026-04-23T00:00:00Z",
      url: "https://example.com/podcast",
      text_excerpt: "A bounded excerpt from the supporting chunk.",
      entity_labels: ["evals"],
    };
    const noteResult: GetMemoryItemToolResult = {
      kind: "note",
      id: 7,
      scope: "theme",
      scope_key: "agents-evals",
      title: "Agent evals keep moving toward production-style checks",
      summary: "Recent sources are converging on realistic eval loops.",
      claims: [
        {
          claim: "Teams are shifting to production-style checks.",
          confidence: "medium",
          sourceFeedItemIds: [12],
        },
      ],
      effective_date: "2026-04-24",
      source_refs: [
        {
          feedItemId: 12,
          knowledgeChunkId: 31,
          citationReason: "supporting_evidence",
          excerpt: "production-style checks",
        },
      ],
    };

    expect(chunkResult.kind).toBe("chunk");
    expect(noteResult.kind).toBe("note");
  });

  it("Theme and builder brief contracts remain compact", () => {
    const themeBrief: ThemeBriefToolResult = {
      theme: "agents-evals",
      as_of: "2026-04-24",
      notes: [
        {
          id: 7,
          title: "Agent evals keep moving toward production-style checks",
          summary: "Recent sources are converging on realistic eval loops.",
          effective_date: "2026-04-24",
          source_refs: [],
        },
      ],
      supporting_source_refs: [],
    };
    const builderBrief: BuilderBriefToolResult = {
      builder: "andrej-karpathy",
      as_of: "2026-04-24",
      notes: [
        {
          id: 8,
          title: "Karpathy is focused on eval ergonomics",
          summary: "His recent comments keep circling back to better feedback loops.",
          effective_date: "2026-04-24",
          source_refs: [],
        },
      ],
      supporting_source_refs: [],
    };

    expect(themeBrief.notes[0].title).toContain("evals");
    expect(builderBrief.notes[0].title).toContain("Karpathy");
  });
});
