import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/memory-embeddings", () => ({
  embedMemoryText: vi.fn(),
  formatPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
  isMemoryVectorEnabled: vi.fn(
    (
      env: { MEMORY_VECTOR_ENABLED?: string } = process.env as {
        MEMORY_VECTOR_ENABLED?: string;
      },
    ) =>
      env.MEMORY_VECTOR_ENABLED === "true",
  ),
}));

const mockAnthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

import { sql } from "@/lib/db";
import { buildEvidenceClaimProfile } from "@/lib/memory-evidence-rerank";
import { embedMemoryText } from "@/lib/memory-embeddings";
import type { MemorySearchChunkHit } from "@/lib/schema";
import {
  buildMemoryLexicalAliasQueries,
  classifyMemoryQueryIntent,
  extractSignificantExactTerms,
  getMemoryItemForTool,
  isMemoryReadsEnabled,
  mergeMemoryCandidateRowsByRrf,
  normalizeMemorySearchLimit,
  parseMemoryRerankerScores,
  rankMemoryParentCandidates,
  searchMemoryForTool,
  selectPaperEvidenceSnippetFromText,
} from "../memory-retrieval";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockEmbedMemoryText = embedMemoryText as unknown as ReturnType<typeof vi.fn>;

function memoryRow(
  overrides: Partial<{
    id: number;
    feed_item_id: number;
    source_type: "tweet" | "podcast" | "newsletter" | "paper";
    title: string | null;
    author_name: string;
    text: string;
    entity_labels: string[];
  }>,
) {
  const id = overrides.id ?? 1;
  const text = overrides.text ?? "agent memory retrieval notes.";
  return {
    id,
    feed_item_id: overrides.feed_item_id ?? id,
    source_type: overrides.source_type ?? "tweet",
    title: overrides.title ?? null,
    author_name: overrides.author_name ?? "Builder",
    published_at: null,
    url: `https://example.com/${id}`,
    snippet: text,
    text,
    entity_labels: overrides.entity_labels ?? [],
  };
}

describe("memory retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEMORY_VECTOR_ENABLED;
    delete process.env.MEMORY_RERANK_ENABLED;
    delete process.env.MEMORY_QUERY_EXPANSION_ENABLED;
    delete process.env.MEMORY_RETRIEVAL_CANDIDATE_LIMIT;
    delete process.env.MEMORY_RERANK_MIN_RELEVANCE;
    delete process.env.MEMORY_RERANK_MODEL;
    delete process.env.PAPER_EVIDENCE_LAYER_ENABLED;
  });

  it("gates reads on an exact true feature flag", () => {
    expect(isMemoryReadsEnabled({ MEMORY_READS_ENABLED: "true" })).toBe(true);
    expect(isMemoryReadsEnabled({ MEMORY_READS_ENABLED: "TRUE" })).toBe(false);
    expect(isMemoryReadsEnabled({ MEMORY_READS_ENABLED: "false" })).toBe(false);
    expect(isMemoryReadsEnabled({})).toBe(false);
  });

  it("caps lexical search limits at six results", () => {
    expect(normalizeMemorySearchLimit(undefined)).toBe(4);
    expect(normalizeMemorySearchLimit(2)).toBe(2);
    expect(normalizeMemorySearchLimit(99)).toBe(20);
  });

  it("uses an inclusive date-only before filter for chunk searches", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "agent memory",
      before: "2026-04-23",
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("kc.published_at < (");
    expect(template).toContain("::date + interval '1 day'");
    expect(template).not.toContain("kc.published_at <=");
    expect(values).toContain("2026-04-23");
  });

  it("uses an inclusive date-only after filter for chunk searches", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "agent memory",
      after: "2026-04-23",
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("kc.published_at >= ");
    expect(template).toContain("::date");
    expect(values).toContain("2026-04-23");
  });

  it("returns a source, date, and limit filtered chunk result", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 35,
        feed_item_id: 12,
        source_type: "podcast",
        title: "On building eval systems",
        author_name: "Latent Space",
        published_at: "2026-04-23T18:30:00Z",
        url: "https://example.com/podcast/evals",
        snippet:
          "__memory_snippet_start__eval systems__memory_snippet_end__ need realistic tasks.",
        text: "eval systems need realistic tasks.",
        entity_labels: ["evals", "agents"],
      },
    ]);

    const result = await searchMemoryForTool({
      query: "eval systems",
      scope: "all",
      source: "podcast",
      after: "2026-04-01",
      before: "2026-04-23",
      limit: 1,
    });

    expect(result).toEqual({
      query: "eval systems",
      scope: "all",
      source: "podcast",
      results: [
        {
          kind: "chunk",
          id: 35,
          feed_item_id: 12,
          source_type: "podcast",
          title: "On building eval systems",
          author_name: "Latent Space",
          published_at: "2026-04-23T18:30:00Z",
          url: "https://example.com/podcast/evals",
          text: "eval systems need realistic tasks.",
          snippet: "eval systems need realistic tasks.",
          entity_labels: ["evals", "agents"],
        },
      ],
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("FROM knowledge_chunks");
    expect(template).toContain("kc.text_tsv AS search_tsv");
    expect(template).toContain("kc.entity_labels");
    expect(template).toContain("websearch_to_tsquery");
    expect(template).toContain("base.search_tsv @@ search_query.exact_query");
    expect(template).toContain("base.search_tsv @@ search_query.fallback_query");
    expect(template).toContain("kc.source_type");
    expect(template).toContain("kc.published_at");
    expect(template).not.toContain("fts AS");
    expect(values).toContain("eval systems");
    expect(values).toContain("podcast");
    expect(values).toContain("2026-04-01");
    expect(values).toContain("2026-04-23");
    expect(values.at(-1)).toBe(30);
    expect(mockEmbedMemoryText).not.toHaveBeenCalled();
  });

  it("returns full chunk text separately from the trimmed snippet", async () => {
    const fullText = Array.from({ length: 120 }, (_, index) => `token${index}`).join(
      " ",
    );
    mockSql.mockResolvedValueOnce([
      memoryRow({
        id: 36,
        feed_item_id: 12,
        source_type: "paper",
        title: "Long Evidence",
        text: fullText,
      }),
    ]);

    const result = await searchMemoryForTool({
      query: "long evidence",
      source: "paper",
      limit: 1,
    });

    const [hit] = result.results;
    expect(hit?.kind).toBe("chunk");
    if (hit?.kind !== "chunk") {
      throw new Error("expected chunk hit");
    }
    expect(hit.text).toBe(fullText);
    expect(hit.snippet).not.toBe(fullText);
    expect(hit.snippet.length).toBeLessThanOrEqual(500);
  });

  it("requires full text on MemorySearchChunkHit fixtures", () => {
    const hit = {
      kind: "chunk",
      id: 1,
      feed_item_id: 1,
      source_type: "paper",
      title: null,
      author_name: "Research Team",
      published_at: null,
      url: "https://example.com/paper",
      text: "full text",
      snippet: "snippet",
      entity_labels: [],
    } satisfies MemorySearchChunkHit;

    expect(hit.text).toBe("full text");

    // @ts-expect-error text is required for chunk hits.
    const missingText: MemorySearchChunkHit = {
      kind: "chunk",
      id: 1,
      feed_item_id: 1,
      source_type: "paper",
      title: null,
      author_name: "Research Team",
      published_at: null,
      url: "https://example.com/paper",
      snippet: "snippet",
      entity_labels: [],
    };
    expect(missingText.snippet).toBe("snippet");
  });

  it("can scope memory search to current digest feed items", async () => {
    mockSql.mockResolvedValueOnce([
      memoryRow({
        id: 31,
        feed_item_id: 123,
        source_type: "paper",
        title: "OpenSearch-VL",
        text: "OpenSearch-VL uses an open data pipeline and training recipe.",
      }),
    ]);

    const result = await searchMemoryForTool({
      query: "OpenSearch-VL training recipe",
      source: "paper",
      feedItemIds: [456, 123, 123],
      limit: 1,
    });

    expect(result.current_digest_search).toEqual({
      searched: true,
      source_item_ids: [123, 456],
      status: "hit",
    });
    expect(result.results).toHaveLength(1);

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("kc.feed_item_id = ANY");
    expect(values).toContainEqual([123, 456]);
  });

  it("marks current digest misses with broader-search guidance", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query: "OpenSearch-VL training recipe",
      source: "paper",
      feedItemIds: [123],
    });

    expect(result.current_digest_search).toMatchObject({
      searched: true,
      source_item_ids: [123],
      status: "miss",
      broader_search_suggested: true,
    });
    expect(result.current_digest_search?.guidance).toContain(
      "currentDigestOnly=false",
    );
  });

  it("applies the paper corpus tier filter when enabled", async () => {
    process.env.PAPER_CORPUS_TIER_FILTER_ENABLED = "true";
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "paper corpus tiering",
      source: "paper",
      paperCorpusScope: "latest",
    });

    const templates = mockSql.mock.calls.map((call) => call[0].join(" "));
    const values = mockSql.mock.calls.flatMap((call) => call.slice(1));
    expect(templates.some((template) => template.includes("corpus_tier <> 'ignored'"))).toBe(true);
    expect(values).toContain(true);
    expect(values).toContainEqual(["hot_set"]);
    expect(values).not.toContainEqual(["core_canon"]);
  });

  it("generates feed-item parent candidates with matching filters", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "Philipp Herzig SAP podcast",
      source: "podcast",
      after: "2026-04-01",
      before: "2026-04-23",
    });

    expect(mockSql).toHaveBeenCalledTimes(2);
    const chunkTemplate = mockSql.mock.calls[0][0].join(" ");
    const feedItemTemplate = mockSql.mock.calls[1][0].join(" ");
    const feedItemValues = mockSql.mock.calls[1].slice(1);

    expect(chunkTemplate).toContain("FROM knowledge_chunks");
    expect(feedItemTemplate).toContain("FROM feed_items");
    expect(feedItemTemplate).toContain("exact_terms AS");
    expect(feedItemTemplate).toContain("fi.source_type");
    expect(feedItemTemplate).toContain("fi.published_at");
    expect(feedItemTemplate).toContain("item_rank");
    expect(feedItemValues).toContain("podcast");
    expect(feedItemValues).toContain("2026-04-01");
    expect(feedItemValues).toContain("2026-04-23");
  });

  it("caps final evidence chunks per feed item at two", async () => {
    const baseRow = {
      feed_item_id: 12,
      source_type: "tweet" as const,
      title: null,
      author_name: "Builder",
      published_at: null,
      url: "https://example.com",
      snippet: "agent memory snippet",
      text: "agent memory snippet",
      entity_labels: [],
    };
    mockSql.mockResolvedValueOnce([
      { ...baseRow, id: 1 },
      { ...baseRow, id: 2 },
      { ...baseRow, id: 3 },
      { ...baseRow, id: 4, feed_item_id: 13 },
    ]);

    const result = await searchMemoryForTool({
      query: "agent memory",
      limit: 4,
    });

    expect(result.results.map((hit) => hit.id)).toEqual([1, 2, 4]);
  });

  it("classifies metadata and attribution intents and extracts exact entity terms", () => {
    expect(classifyMemoryQueryIntent("Philipp Herzig CTO SAP podcast")).toBe(
      "metadata",
    );
    expect(classifyMemoryQueryIntent("who said GBrain needs OpenClaw memory")).toBe(
      "attribution",
    );
    expect(
      extractSignificantExactTerms("GBrain OpenClaw Hermes Philipp Herzig SAP AI"),
    ).toEqual(["gbrain", "openclaw", "hermes", "philipp", "herzig", "sap"]);
  });

  it("boosts parent items with higher exact-token coverage", () => {
    const exactTerms = ["gbrain", "openclaw", "hermes"];
    const parents = rankMemoryParentCandidates({
      chunkRows: [],
      feedItemRows: [
        {
          feed_item_id: 1,
          source_type: "paper",
          title: "OpenClaw memory",
          author_name: "Research Team",
          published_at: null,
          url: "https://example.com/paper",
          item_rank: 1,
          exact_token_matches: 1,
          exact_token_count: 3,
          title_match: true,
          content_match: true,
        },
        {
          feed_item_id: 2,
          source_type: "paper",
          title: "GBrain OpenClaw Hermes",
          author_name: "Builder",
          published_at: null,
          url: "https://example.com/tweet",
          item_rank: 2,
          exact_token_matches: 3,
          exact_token_count: 3,
          title_match: true,
          content_match: true,
        },
      ],
      exactTerms,
      intent: "semantic",
      source: "all",
      limit: 2,
    });

    expect(parents[0].feed_item_id).toBe(2);
  });

  it("matches exact tokens inside hyphenated chunk text", () => {
    const parents = rankMemoryParentCandidates({
      chunkRows: [
        {
          id: 1234,
          feed_item_id: 99,
          source_type: "paper",
          title: "LLM-Generated GUI Code",
          author_name: "Research Team",
          published_at: null,
          url: "https://example.com/paper",
          snippet: "LLM-Generated GUI Code: playable games evaluation repair",
          text: "LLM-Generated GUI Code: playable games evaluation repair",
          entity_labels: [],
          fts_rank: 1,
          rrf_score: 1,
        },
      ],
      feedItemRows: [],
      exactTerms: ["llm", "generated", "gui", "code", "playable", "games"],
      highSignalTerms: ["llm", "gui"],
      intent: "semantic",
      source: "all",
      limit: 2,
    });

    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatchObject({
      feed_item_id: 99,
      exact_token_matches: 6,
      high_signal_token_matches: 2,
    });
  });

  it("weights podcast parents higher for metadata intent but dampens title-only semantic matches", () => {
    const metadataParents = rankMemoryParentCandidates({
      chunkRows: [],
      feedItemRows: [
        {
          feed_item_id: 1,
          source_type: "tweet",
          title: "SAP operating system",
          author_name: "Builder",
          published_at: null,
          url: "https://example.com/tweet",
          item_rank: 1,
          exact_token_matches: 2,
          exact_token_count: 2,
          title_match: true,
          content_match: true,
        },
        {
          feed_item_id: 2,
          source_type: "podcast",
          title: "SAP operating system",
          author_name: "No Priors",
          published_at: null,
          url: "https://example.com/podcast",
          item_rank: 1,
          exact_token_matches: 2,
          exact_token_count: 2,
          title_match: true,
          content_match: true,
        },
      ],
      exactTerms: ["sap", "operating"],
      intent: "metadata",
      source: "all",
      limit: 2,
    });
    expect(metadataParents[0].feed_item_id).toBe(2);

    const semanticParents = rankMemoryParentCandidates({
      chunkRows: [],
      feedItemRows: [
        {
          feed_item_id: 3,
          source_type: "podcast",
          title: "enterprise software AI UI",
          author_name: "No Priors",
          published_at: null,
          url: "https://example.com/podcast",
          item_rank: 1,
          exact_token_matches: 2,
          exact_token_count: 2,
          title_match: true,
          content_match: false,
        },
        {
          feed_item_id: 4,
          source_type: "paper",
          title: "enterprise software AI UI",
          author_name: "Research Team",
          published_at: null,
          url: "https://example.com/paper",
          item_rank: 2,
          exact_token_matches: 2,
          exact_token_count: 2,
          title_match: true,
          content_match: true,
        },
      ],
      exactTerms: ["enterprise", "software"],
      intent: "semantic",
      source: "all",
      limit: 2,
    });
    expect(semanticParents[0].feed_item_id).toBe(4);
  });

  it("builds bounded deterministic aliases only for targeted paraphrase families", () => {
    expect(
      buildMemoryLexicalAliasQueries(
        "software interfaces disappear agents call backend APIs directly instead of clicking apps",
      ),
    ).toEqual([
      "software interfaces disappear agents call backend APIs directly instead of clicking apps",
      "software going headless agents use tools 100X more than people",
      "agents are going to use software 100X more than people enterprise platforms become headless",
    ]);

    expect(
      buildMemoryLexicalAliasQueries(
        "clinical dosage guidelines for antibiotics in the builder digest",
      ),
    ).toEqual(["clinical dosage guidelines for antibiotics in the builder digest"]);
  });

  it("headless-software paraphrase boosts direct software/API parents over generic podcast matches", async () => {
    mockSql
      .mockResolvedValueOnce([
        memoryRow({
          id: 900,
          feed_item_id: 9000,
          source_type: "podcast",
          title: "Agent software podcast",
          author_name: "No Priors",
          text: "A broad podcast segment about software backend APIs agents and SAP systems.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1480,
          feed_item_id: 1760,
          source_type: "tweet",
          title: null,
          author_name: "Aaron Levie",
          text: "Software going headless means agents use tools 100X more than people through APIs.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1480,
          feed_item_id: 1760,
          source_type: "tweet",
          title: null,
          author_name: "Aaron Levie",
          text: "Agents are going to use software 100X more than people, so enterprise platforms become headless.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query:
        "software interfaces disappear agents call backend APIs directly instead of clicking apps",
      limit: 2,
    });

    expect(result.results.map((hit) => hit.id)).toEqual([1480, 900]);
    expect(result.results[0]).toMatchObject({
      source_type: "tweet",
      author_name: "Aaron Levie",
    });
  });

  it("proactive workspace paraphrase surfaces the Peter Yang-style item when exact words differ", async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 52,
          feed_item_id: 520,
          source_type: "paper",
          title: "Stateful assistants",
          author_name: "Peter Yang",
          text: "A personal assistant should proactively use Gmail Calendar and Google Workspace APIs.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 52,
          feed_item_id: 520,
          source_type: "paper",
          title: "Stateful assistants",
          author_name: "Peter Yang",
          text: "An agent can work across email calendar docs and workspace tools proactively.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query:
        "agent working across email calendar docs and workspace tools without waiting for instructions",
      limit: 2,
    });

    expect(result.results.map((hit) => hit.id)).toEqual([52]);
  });

  it("GUI game evaluate/fix paraphrase matches LLM-generated GUI code playable repair content", async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1234,
          feed_item_id: 12340,
          source_type: "paper",
          title: "LLM-Generated GUI Code",
          author_name: "Research Team",
          text: "LLM generated GUI code for playable games with evaluation and repair benchmark loops.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1234,
          feed_item_id: 12340,
          source_type: "paper",
          title: "LLM-Generated GUI Code",
          author_name: "Research Team",
          text: "A graphical game benchmark uses playable repair loops for generated code.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query: "language model creates graphical games then evaluates and fixes them",
      limit: 2,
    });

    expect(result.results.map((hit) => hit.id)).toEqual([1234]);
    expect(result.results[0].title).toBe("LLM-Generated GUI Code");
  });

  it("entity opinion queries prefer exact tweet parents over generic papers and newsletters", async () => {
    mockSql
      .mockResolvedValueOnce([
        memoryRow({
          id: 700,
          feed_item_id: 7000,
          source_type: "newsletter",
          title: "Knowledge wiki memory",
          author_name: "Builder Weekly",
          text: "A generic newsletter that mentions GBrain and OpenClaw in a broader knowledge wiki memory roundup.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1484,
          feed_item_id: 1764,
          source_type: "tweet",
          title: null,
          author_name: "Builder",
          text: "GBrain and OpenClaw are personal AI knowledge wiki memory product names with opinions from builders.",
        }),
        memoryRow({
          id: 1485,
          feed_item_id: 1765,
          source_type: "tweet",
          title: null,
          author_name: "Builder",
          text: "OpenClaw and GBrain connect agent memory to a knowledge wiki.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        memoryRow({
          id: 1484,
          feed_item_id: 1764,
          source_type: "tweet",
          title: null,
          author_name: "Builder",
          text: "Builders said GBrain and OpenClaw are about agent memory and a knowledge wiki.",
        }),
        memoryRow({
          id: 1485,
          feed_item_id: 1765,
          source_type: "tweet",
          title: null,
          author_name: "Builder",
          text: "OpenClaw and GBrain are product names for personal AI memory.",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query: "knowledge wiki agent memory opinions about GBrain and OpenClaw",
      limit: 3,
    });
    const chunkResults = result.results.filter((hit) => hit.kind === "chunk");

    expect(chunkResults.map((hit) => hit.feed_item_id).slice(0, 2)).toEqual([
      1764,
      1765,
    ]);
    expect(chunkResults[0].source_type).toBe("tweet");
  });

  it("explicit no-answer probes still abstain before candidate generation", async () => {
    const result = await searchMemoryForTool({
      query: "pricing details for a product launch not present in the archive",
    });

    expect(result.results).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("evidence mode returns only verifier-supported paper chunks", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([
          memoryRow({
            id: 2,
            feed_item_id: 10,
            source_type: "paper",
            title: "Tree of Thoughts",
            text: "Tree of Thoughts reaches a 74.0% score on Game-of-24.",
          }),
        ]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 10,
            source_type: "paper",
            title: "Tree of Thoughts",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/paper",
            item_rank: 1,
            exact_token_matches: 4,
            exact_token_count: 4,
            high_signal_token_matches: 3,
            high_signal_token_count: 3,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 1,
          feed_item_id: 10,
          source_type: "paper",
          title: "Tree of Thoughts",
          text: "Tree of Thoughts is evaluated on Game-of-24 reasoning benchmarks.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "Which paper reports Tree of Thoughts 74.0% score on Game-of-24?",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence).toMatchObject({
      status: "supports",
      candidate_feed_item_ids: [10],
      supporting_chunk_ids: [2],
    });
    expect(result.paper_evidence_debug?.[0]).toMatchObject({
      chunk_id: 2,
      feed_item_id: 10,
      returned_snippet:
        "Tree of Thoughts reaches a 74.0% score on Game-of-24.",
      matched_numbers: ["74.0%"],
      supports: true,
    });
    expect(result.paper_evidence_debug?.[0].verifier_evidence_text).toContain(
      "Tree of Thoughts reaches a 74.0% score on Game-of-24.",
    );
    expect(result.results.map((hit) => hit.id)).toEqual([2]);
  });

  it("selects concrete paper-local numeric windows over broad setup text", () => {
    const profile = buildEvidenceClaimProfile(
      "What scale did CUA-Suite use for computer-use video demonstrations?",
      ["CUA-Suite computer-use video demonstrations scale"],
    );

    const snippet = selectPaperEvidenceSnippetFromText(
      profile,
      [
        "CUA-Suite studies continuous video demonstrations for computer-use agents.",
        "This matters because agents increasingly operate professional desktops.",
        "The benchmark contains approximately 55 hours and 6 million frames from desktop computer-use demonstrations.",
      ].join(" "),
    );

    expect(snippet).toContain("55 hours");
    expect(snippet).toContain("6 million frames");
  });

  it("evidence mode uses paper-local detail snippets after candidate paper selection", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("local_rank")) {
        return Promise.resolve([
          memoryRow({
            id: 22,
            feed_item_id: 10,
            source_type: "paper",
            title: "CUA-Suite",
            text: [
              "CUA-Suite studies continuous video demonstrations for computer-use agents.",
              "This matters because agents increasingly operate professional desktops.",
              "The benchmark contains approximately 55 hours and 6 million frames from desktop computer-use demonstrations.",
            ].join(" "),
          }),
        ]);
      }
      if (template.includes("evidence_rank") && template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 10,
            source_type: "paper",
            title: "CUA-Suite",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/cua-suite",
            item_rank: 1,
            exact_token_matches: 4,
            exact_token_count: 5,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 11,
          feed_item_id: 10,
          source_type: "paper",
          title: "CUA-Suite",
          text: "CUA-Suite evaluates computer-use agents from continuous video demonstrations.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "What scale did CUA-Suite use for computer-use video demonstrations?",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence).toMatchObject({
      status: "supports",
      candidate_feed_item_ids: [10],
      supporting_chunk_ids: [22],
    });
    expect(result.paper_evidence_debug?.[0].returned_snippet).toContain(
      "55 hours",
    );
    expect(result.paper_evidence_debug?.[0].returned_snippet).toContain(
      "6 million frames",
    );
    const [hit] = result.results;
    expect(hit?.kind).toBe("chunk");
    if (hit?.kind !== "chunk") {
      throw new Error("expected a chunk hit");
    }
    expect(hit.snippet).toContain("55 hours");
  });

  it("uses exact DB-backed paper evidence spans when the evidence layer is enabled", async () => {
    process.env.PAPER_EVIDENCE_LAYER_ENABLED = "true";
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("FROM paper_evidence_cards")) {
        return Promise.resolve([
          {
            id: 88,
            feed_item_id: 10,
            chunk_index: 2,
            title: "EvalPaper",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/evalpaper",
            span_id: 501,
            card_id: 701,
            section_path: ["Results"],
            span_type: "sentence",
            claim_type: "result",
            snippet:
              "EvalPaper reports 77.0% accuracy on the benchmark after verifier-guided reranking.",
            text:
              "EvalPaper reports 77.0% accuracy on the benchmark after verifier-guided reranking.",
            entities: ["EvalPaper"],
            methods: ["verifier-guided reranking"],
            datasets: ["benchmark"],
            metrics: ["accuracy"],
            numbers: ["77.0%"],
            aliases: ["EvalPaper"],
            sql_score: 4,
            evidence_rank: 1,
            fallback_chunk_id: 88,
          },
        ]);
      }
      if (template.includes("local_rank")) {
        return Promise.resolve([]);
      }
      if (template.includes("evidence_rank") && template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 10,
            source_type: "paper",
            title: "EvalPaper",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/evalpaper",
            item_rank: 1,
            exact_token_matches: 4,
            exact_token_count: 4,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await searchMemoryForTool({
      query: "Which paper reports EvalPaper 77.0% accuracy?",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence).toMatchObject({
      status: "supports",
      candidate_feed_item_ids: [10],
      supporting_chunk_ids: [88],
      supporting_span_ids: [501],
      supporting_card_ids: [701],
    });
    const [hit] = result.results;
    expect(hit).toMatchObject({
      kind: "chunk",
      id: 88,
      text:
        "EvalPaper reports 77.0% accuracy on the benchmark after verifier-guided reranking.",
      snippet:
        "EvalPaper reports 77.0% accuracy on the benchmark after verifier-guided reranking.",
      paper_evidence: {
        span_id: 501,
        card_id: 701,
        section_path: ["Results"],
        claim_type: "result",
      },
    });
  });

  it("returns the FlowCompile compile-time compiler span from the supporting chunk", async () => {
    const flowCompileText = [
      "Structured LLM workflows, where specialized LLM sub-agents execute according to a predefined graph, have become a powerful abstraction for solving complex tasks.",
      "Optimizing such workflows, ie, selecting configurations for each sub-agent to balance accuracy and latency, is challenging due to the combinatorial design space.",
      "Drawing inspiration from machine learning compilers, we introduce FlowCompile, a structured LLM workflow compiler that performs compile-time design space exploration to identify a high-quality, reusable trade-off set.",
    ].join(" ");

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("local_rank")) {
        return Promise.resolve([
          memoryRow({
            id: 6313,
            feed_item_id: 5952,
            source_type: "paper",
            title: "FlowCompile: An Optimizing Compiler for Structured LLM Workflows",
            text: flowCompileText,
          }),
        ]);
      }
      if (template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([
          memoryRow({
            id: 6313,
            feed_item_id: 5952,
            source_type: "paper",
            title: "FlowCompile: An Optimizing Compiler for Structured LLM Workflows",
            text: flowCompileText,
          }),
        ]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 5952,
            source_type: "paper",
            title: "FlowCompile: An Optimizing Compiler for Structured LLM Workflows",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/flowcompile",
            item_rank: 1,
            exact_token_matches: 8,
            exact_token_count: 10,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 6313,
          feed_item_id: 5952,
          source_type: "paper",
          title: "FlowCompile: An Optimizing Compiler for Structured LLM Workflows",
          text: flowCompileText,
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "optimizing compiler for structured LLM workflows sub agents accuracy latency trade offs",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence).toMatchObject({
      status: "supports",
      candidate_feed_item_ids: [5952],
      supporting_chunk_ids: [6313],
    });
    const [hit] = result.results;
    expect(hit).toMatchObject({
      kind: "chunk",
      id: 6313,
      feed_item_id: 5952,
    });
    if (hit?.kind !== "chunk") {
      throw new Error("expected FlowCompile chunk evidence");
    }
    expect(hit.snippet).toContain("structured LLM workflow compiler");
    expect(hit.snippet).toContain("compile-time design space exploration");
  });

  it("prefers the SWE-chat dataset-scale evidence over generic tool-call chunks", async () => {
    const exactDatasetText =
      "We present SWE-chat, the first large-scale dataset of real coding agent sessions collected from open-source developers in the wild. The dataset currently contains 6,000 sessions, more than 63,000 user prompts, and 355,000 agent tool calls.";

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("local_rank")) {
        return Promise.resolve([
          memoryRow({
            id: 6534,
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            text: "However, as more open-source developers adopt the tool, the dataset becomes increasingly diverse.",
          }),
          memoryRow({
            id: 6509,
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            text: "Agents invoke many tools within a single turn, including file reads, edits, shell commands, and text output.",
          }),
          memoryRow({
            id: 6498,
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            text: exactDatasetText,
          }),
        ]);
      }
      if (template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([
          memoryRow({
            id: 6498,
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            text: exactDatasetText,
          }),
        ]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/swe-chat",
            item_rank: 1,
            exact_token_matches: 8,
            exact_token_count: 9,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 6502,
          feed_item_id: 5466,
          source_type: "paper",
          title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
          text: "SWE-chat studies coding agent interactions from real users and code commits.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "coding agent interactions from real users open source developers tool calls commits",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence?.status).toBe("supports");
    const [hit] = result.results;
    expect(hit).toMatchObject({
      kind: "chunk",
      id: 6498,
      feed_item_id: 5466,
    });
    if (hit?.kind !== "chunk") {
      throw new Error("expected SWE-chat chunk evidence");
    }
    expect(hit.snippet).toContain("355,000 agent tool calls");
  });

  it("repairs Claw-Eval-Live related-only evidence toward the refreshable signal span", async () => {
    const exactClawText =
      "We introduce Claw-Eval-Live, a live benchmark for workflow agents that separates a refreshable signal layer, updated across releases from public workflow-demand signals, from a reproducible, time-stamped release snapshot.";

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("local_rank")) {
        return Promise.resolve([
          memoryRow({
            id: 6544,
            feed_item_id: 5603,
            source_type: "paper",
            title: "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
            text: "The task mix is calibrated to live public workflow signals and materialized as time-stamped benchmark snapshots.",
          }),
          memoryRow({
            id: 6538,
            feed_item_id: 5603,
            source_type: "paper",
            title: "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
            text: exactClawText,
          }),
        ]);
      }
      if (template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([
          memoryRow({
            id: 6538,
            feed_item_id: 5603,
            source_type: "paper",
            title: "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
            text: exactClawText,
          }),
        ]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 5603,
            source_type: "paper",
            title: "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/claw-eval-live",
            item_rank: 1,
            exact_token_matches: 8,
            exact_token_count: 8,
            high_signal_token_matches: 2,
            high_signal_token_count: 2,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 6544,
          feed_item_id: 5603,
          source_type: "paper",
          title: "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
          text: "Claw-Eval-Live is a live workflow benchmark grounded in public workflow signals.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "live workflow agent benchmark refreshable signal layer public workflow demand signals",
      source: "paper",
      mode: "evidence",
      limit: 4,
      debug: true,
    });

    expect(result.paper_evidence?.status).toBe("supports");
    const [hit] = result.results;
    expect(hit).toMatchObject({
      kind: "chunk",
      id: 6538,
      feed_item_id: 5603,
    });
    if (hit?.kind !== "chunk") {
      throw new Error("expected Claw-Eval-Live chunk evidence");
    }
    expect(hit.snippet).toContain("refreshable signal layer");
    expect(hit.snippet).toContain("public workflow-demand signals");
  });

  it("reranks AgentLens above generic SWE-chat when Lucky Pass anchors are present", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("evidence_rank") && template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([
          {
            feed_item_id: 5466,
            source_type: "paper",
            title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/swe-chat",
            item_rank: 1,
            exact_token_matches: 6,
            exact_token_count: 8,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
          {
            feed_item_id: 5935,
            source_type: "paper",
            title: "AgentLens: Revealing The Lucky Pass Problem in SWE-Agent Evaluation",
            author_name: "Research Team",
            published_at: null,
            url: "https://example.com/agentlens",
            item_rank: 2,
            exact_token_matches: 4,
            exact_token_count: 8,
            high_signal_token_matches: 1,
            high_signal_token_count: 1,
            title_match: true,
            content_match: true,
          },
        ]);
      }
      return Promise.resolve([
        memoryRow({
          id: 6502,
          feed_item_id: 5466,
          source_type: "paper",
          title: "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
          text: "SWE agent evaluation can inspect coding agent trajectories and interactions.",
        }),
        memoryRow({
          id: 6299,
          feed_item_id: 5935,
          source_type: "paper",
          title: "AgentLens: Revealing The Lucky Pass Problem in SWE-Agent Evaluation",
          text: "AgentLens studies Lucky Pass cases and process-level assessment of SWE-agent trajectories.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query:
        "SWE agent evaluation lucky pass process level assessment trajectories",
      source: "paper",
      limit: 4,
    });

    expect(result.results[0]).toMatchObject({
      kind: "chunk",
      id: 6299,
      feed_item_id: 5935,
    });
  });

  it("evidence mode caps paper-local inspection at three candidate papers", async () => {
    let inspectedFeedItemIds: number[] | undefined;

    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const template = strings.join(" ");
      if (template.includes("local_rank")) {
        inspectedFeedItemIds = values.find(Array.isArray) as number[] | undefined;
        return Promise.resolve(
          (inspectedFeedItemIds ?? []).map((feedItemId, index) =>
            memoryRow({
              id: 500 + index,
              feed_item_id: feedItemId,
              source_type: "paper",
              title: `Paper ${feedItemId}`,
              text: `Paper ${feedItemId} reports a ${45 + index}.1% success rate on benchmark tasks.`,
            }),
          ),
        );
      }
      if (template.includes("evidence_rank") && template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        [101, 102, 103, 104].map((feedItemId, index) =>
          memoryRow({
            id: 300 + index,
            feed_item_id: feedItemId,
            source_type: "paper",
            title: `Paper ${feedItemId}`,
            text: `Paper ${feedItemId} benchmark papers report success rate results for agent tasks.`,
          }),
        ),
      );
    });

    const result = await searchMemoryForTool({
      query: "What success rate did the benchmark papers report?",
      source: "paper",
      mode: "evidence",
      limit: 10,
    });

    expect(inspectedFeedItemIds).toEqual([101, 102, 103]);
    expect(result.paper_evidence?.candidate_feed_item_ids).toEqual([
      101,
      102,
      103,
    ]);
  });

  it("evidence mode abstains when candidate papers lack claim support", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("kc.feed_item_id = ANY")) {
        return Promise.resolve([
          memoryRow({
            id: 2,
            feed_item_id: 10,
            source_type: "paper",
            title: "Claw-Eval-Live",
            text: "Paper card: Title: Claw-Eval-Live benchmark",
          }),
        ]);
      }
      if (template.includes("FROM feed_items")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        memoryRow({
          id: 1,
          feed_item_id: 10,
          source_type: "paper",
          title: "Claw-Eval-Live",
          text: "A paper about live workflow benchmarks.",
        }),
      ]);
    });

    const result = await searchMemoryForTool({
      query: "What dosage protocol did Claw-Eval-Live use?",
      source: "paper",
      mode: "evidence",
    });

    expect(result.results).toEqual([]);
    expect(result.paper_evidence).toMatchObject({
      status: "paper_related_only",
      candidate_feed_item_ids: [10],
      supporting_chunk_ids: [],
      related_chunk_ids: [2],
    });
  });

  it("uses hybrid FTS and vector retrieval when vector search is enabled", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([
      {
        id: 41,
        feed_item_id: 20,
        source_type: "paper",
        title: "Agent memory",
        author_name: "Research Team",
        published_at: "2026-04-24T09:00:00Z",
        url: "https://example.com/papers/agent-memory",
        snippet:
          "__memory_snippet_start__agent memory__memory_snippet_end__ retrieval notes.",
        text: "Agent memory retrieval notes.",
        entity_labels: ["memory"],
        fts_rank: 1,
        vec_rank: 2,
        vec_distance: "0.18",
        rrf_score: "0.04032258064516129",
      },
    ]);

    const result = await searchMemoryForTool({
      query: "agent memory",
      source: "paper",
      after: "2026-04-01",
      before: "2026-04-24",
      limit: 6,
    });

    expect(mockEmbedMemoryText).toHaveBeenCalledWith("agent memory");
    expect(result.results[0]).toMatchObject({
      kind: "chunk",
      id: 41,
      snippet: "agent memory retrieval notes.",
      source_score: {
        fts_rank: 1,
        vec_rank: 2,
        vec_distance: 0.18,
        rrf_score: expect.any(Number),
      },
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("fts AS");
    expect(template).toContain("fts_matches AS");
    expect(template).toContain("vec AS");
    expect(template).toContain("base.embedding <=>");
    expect(template).toContain("kc.text_tsv AS search_tsv");
    expect(template).toContain("kc.entity_labels");
    expect(template).toContain("websearch_to_tsquery");
    expect(template).toContain("vec.vec_distance");
    expect(template).toContain("fts_count AS");
    expect(template).toContain("::double precision");
    expect(template).toContain("vec_distance <= ");
    expect(template).toContain("vector_only_rank <= ");
    expect(template).toContain("(fts_rank IS NULL) ASC");
    expect(template).toContain("rrf_score");
    expect(values).toContain("[0.1,0.2,0.3]");
    expect(values).toContain(1.5);
    expect(values).toContain(1);
    expect(values).toContain(60);
    expect(values).toContain(0.72);
    expect(values).toContain(0.7);
    expect(values).toContain("paper");
    expect(values).toContain("2026-04-01");
    expect(values).toContain("2026-04-24");
    expect(values.at(-1)).toBe(30);
  });

  it("falls back to FTS-only retrieval when query embedding fails", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockEmbedMemoryText.mockRejectedValueOnce(new Error("embedding failed"));
    mockSql.mockResolvedValueOnce([]);

    const result = await searchMemoryForTool({
      query: "agent memory",
    });

    expect(result.results).toEqual([]);
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain(
      "base.search_tsv @@ search_query.exact_query",
    );
    expect(mockSql.mock.calls[0][0].join(" ")).not.toContain("fts AS");
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("FROM feed_items");
    expect(consoleError).toHaveBeenCalledWith(
      "memory_retrieval.query_embedding_failed",
      expect.objectContaining({ error: "embedding failed" }),
    );

    consoleError.mockRestore();
  });

  it("returns a plain excerpt for vector-only chunk hits", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        feed_item_id: 21,
        source_type: "newsletter",
        title: "Semantic systems",
        author_name: "Builder Weekly",
        published_at: null,
        url: "https://example.com/newsletter/semantic-systems",
        snippet: "",
        text: "A conceptually related passage with no exact lexical match.",
        entity_labels: [],
        fts_rank: null,
        vec_rank: 1,
        vec_distance: 0.42,
        rrf_score: 0.01639344262295082,
      },
    ]);

    const result = await searchMemoryForTool({
      query: "evaluation",
    });

    expect(result.results).toEqual([
      {
        kind: "chunk",
        id: 42,
        feed_item_id: 21,
        source_type: "newsletter",
          title: "Semantic systems",
          author_name: "Builder Weekly",
          published_at: null,
          url: "https://example.com/newsletter/semantic-systems",
          text: "A conceptually related passage with no exact lexical match.",
          snippet: "A conceptually related passage with no exact lexical match.",
        entity_labels: [],
        source_score: {
          fts_rank: null,
          vec_rank: 1,
          vec_distance: 0.42,
          rrf_score: 0.01639344262295082,
        },
      },
    ]);
  });

  it("keeps lexical/entity matches ahead of fresh vector-only ties", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "network effects",
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toMatch(/ORDER BY\s+rrf_score DESC/);
    expect(template).toContain("(fts_rank IS NULL) ASC");
    expect(template.lastIndexOf("(fts_rank IS NULL) ASC")).toBeLessThan(
      template.lastIndexOf("published_at DESC NULLS LAST"),
    );
  });

  it("caps vector-only agent memory results when FTS has candidates", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "agent memory",
      limit: 4,
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("fts_candidate_count > 0");
    expect(template).toContain("vec_distance <= ");
    expect(template).toContain("vector_only_rank <= ");
    expect(values).toContain(0.7);
    expect(values).toContain(1);
    expect(values.at(-1)).toBe(30);
  });

  it("allows low-distance vector-only results for FTS-empty paraphrase queries", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([
      {
        id: 43,
        feed_item_id: 22,
        source_type: "newsletter",
        title: "Product adoption",
        author_name: "Builder Weekly",
        published_at: null,
        url: "https://example.com/newsletter/product-adoption",
        snippet: "",
        text: "Users invite more users, making the product more useful.",
        entity_labels: ["network effects"],
        fts_rank: null,
        vec_rank: 1,
        vec_distance: 0.68,
        rrf_score: 0.01639344262295082,
      },
    ]);

    const result = await searchMemoryForTool({
      query: "moats from users reinforcing product adoption",
    });

    expect(result.results[0]).toMatchObject({
      id: 43,
      source_score: {
        fts_rank: null,
        vec_rank: 1,
        vec_distance: 0.68,
      },
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("fts_candidate_count = 0");
    expect(template).toContain("vec_distance <= ");
    expect(values).toContain(0.72);
  });

  it("excludes high-distance vector-only results in hybrid SQL", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValueOnce({
      embedding: [0.1, 0.2, 0.3],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "space survival novel appropriate for children",
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    const values = mockSql.mock.calls[0].slice(1);
    expect(template).toContain("fts_candidate_count = 0");
    expect(template).toContain("fts_candidate_count > 0");
    expect(values).toContain(0.72);
    expect(values).toContain(0.7);
  });

  it("parses valid reranker scores and rejects malformed output", () => {
    expect(
      parseMemoryRerankerScores(
        [
          "```json",
          JSON.stringify({
            scores: [
              { id: 2, score: 3 },
              { id: 1, score: 0 },
            ],
          }),
          "```",
        ].join("\n"),
        [2, 1],
      ),
    ).toEqual([
      { id: 2, score: 3 },
      { id: 1, score: 0 },
    ]);

    expect(() =>
      parseMemoryRerankerScores(
        JSON.stringify({ scores: [{ id: 2, score: 4 }] }),
        [2],
      ),
    ).toThrow("integer from 0 to 3");
    expect(() =>
      parseMemoryRerankerScores(
        JSON.stringify({ scores: [{ id: 4, score: 1 }] }),
        [2],
      ),
    ).toThrow("unknown or duplicate id");
  });

  it("reranker gates low relevance chunks and preserves score ordering", async () => {
    process.env.MEMORY_RERANK_ENABLED = "true";
    mockSql.mockResolvedValueOnce([
      {
        id: 101,
        feed_item_id: 31,
        source_type: "newsletter",
        title: "Topical only",
        author_name: "Builder Weekly",
        published_at: null,
        url: "https://example.com/topical",
        snippet: "Topical retrieval quality background.",
        text: "Topical retrieval quality background.",
        entity_labels: [],
      },
      {
        id: 102,
        feed_item_id: 32,
        source_type: "paper",
        title: "Direct evidence",
        author_name: "Research Team",
        published_at: null,
        url: "https://example.com/direct",
        snippet: "Direct retrieval quality evidence.",
        text: "Direct retrieval quality evidence.",
        entity_labels: ["evidence"],
      },
      {
        id: 103,
        feed_item_id: 33,
        source_type: "tweet",
        title: null,
        author_name: "Builder",
        published_at: null,
        url: "https://example.com/useful",
        snippet: "Useful retrieval quality evidence.",
        text: "Useful retrieval quality evidence.",
        entity_labels: [],
      },
    ]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            scores: [
              { id: 101, score: 1 },
              { id: 102, score: 3 },
              { id: 103, score: 2 },
            ],
          }),
        },
      ],
    });

    const result = await searchMemoryForTool({
      query: "which chunk directly answers retrieval quality",
      limit: 2,
    });

    expect(result.results.map((hit) => hit.id)).toEqual([102, 103]);
    expect(result.results[0]).toMatchObject({
      source_score: {
        rerank_score: 3,
        rerank_model: "claude-haiku-4-5-20251001",
      },
    });
    expect(result.results[1]).toMatchObject({
      source_score: {
        rerank_score: 2,
      },
    });
    expect(mockSql.mock.calls[0].at(-1)).toBe(30);
  });

  it("fails closed when reranking is enabled and the reranker fails", async () => {
    process.env.MEMORY_RERANK_ENABLED = "true";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSql.mockResolvedValueOnce([
      {
        id: 201,
        feed_item_id: 41,
        source_type: "newsletter",
        title: "Candidate",
        author_name: "Builder Weekly",
        published_at: null,
        url: "https://example.com/candidate",
        snippet: "Candidate text.",
        text: "Candidate text.",
        entity_labels: [],
      },
    ]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });

    const result = await searchMemoryForTool({
      query: "candidate",
    });

    expect(result.results).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "memory_retrieval.rerank_failed",
      expect.objectContaining({ error: "Memory reranker returned invalid JSON" }),
    );

    consoleError.mockRestore();
  });

  it("abstains when the reranker marks candidates as not answerable", async () => {
    process.env.MEMORY_RERANK_ENABLED = "true";
    mockSql.mockResolvedValueOnce([
      {
        id: 301,
        feed_item_id: 51,
        source_type: "tweet",
        title: null,
        author_name: "Builder",
        published_at: null,
        url: "https://example.com/topical",
        snippet: "Topical product launch text.",
        text: "Topical product launch text.",
        entity_labels: ["product launch"],
      },
    ]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            answerable: false,
            scores: [{ id: 301, score: 2 }],
          }),
        },
      ],
    });

    const result = await searchMemoryForTool({
      query: "pricing details for an unreleased product launch",
    });

    expect(result.results).toEqual([]);
  });

  it("runs query expansion only when reranking, expansion, and query length gates pass", async () => {
    process.env.MEMORY_RERANK_ENABLED = "true";
    process.env.MEMORY_QUERY_EXPANSION_ENABLED = "true";
    mockSql.mockResolvedValueOnce([]);

    await searchMemoryForTool({
      query: "short query",
    });

    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queries: [
              "keyword entity retrieval quality educational answer",
              "how to find safe evidence for educational memory answers",
            ],
          }),
        },
      ],
    });

    await searchMemoryForTool({
      query: "how should memory retrieval answer educational questions safely",
    });

    expect(mockSql).toHaveBeenCalledTimes(6);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("dedupes expanded candidates with stable RRF ordering", () => {
    const baseRow = {
      feed_item_id: 1,
      source_type: "newsletter" as const,
      title: null,
      author_name: "Builder Weekly",
      published_at: null,
      url: "https://example.com",
      snippet: "Snippet",
      text: "Snippet",
      entity_labels: [],
    };

    const rows = mergeMemoryCandidateRowsByRrf(
      [
        {
          query: "original",
          rows: [
            { ...baseRow, id: 1 },
            { ...baseRow, id: 2 },
          ],
        },
        {
          query: "variant",
          rows: [
            { ...baseRow, id: 2 },
            { ...baseRow, id: 3 },
          ],
        },
      ],
      3,
    );

    expect(rows.map((row) => row.id)).toEqual([2, 1, 3]);
    expect(rows[0].expansion_query).toBe("variant");
    expect(rows[0].rrf_score).toBeGreaterThan(rows[1].rrf_score as number);
  });

  it("returns a bounded chunk detail with the source URL", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 31,
        feed_item_id: 12,
        source_type: "newsletter",
        title: "Memory systems",
        author_name: "Builder Weekly",
        published_at: "2026-04-24T09:00:00Z",
        url: "https://example.com/newsletter",
        text: `[Memory](https://example.com) systems ${"need retrieval discipline. ".repeat(100)}`,
        entity_labels: ["memory"],
      },
    ]);

    const result = await getMemoryItemForTool({
      memoryKind: "chunk",
      memoryId: 31,
    });

    expect(result).toMatchObject({
      kind: "chunk",
      id: 31,
      feed_item_id: 12,
      source_type: "newsletter",
      url: "https://example.com/newsletter",
      entity_labels: ["memory"],
    });
    expect(result?.text_excerpt).toContain("Memory systems");
    expect(result?.text_excerpt).not.toContain("https://example.com");
    expect(result?.text_excerpt.length).toBeLessThanOrEqual(1_500);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("JOIN feed_items");
  });

  it("returns null when a chunk is missing", async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(
      getMemoryItemForTool({
        memoryKind: "chunk",
        memoryId: 999,
      }),
    ).resolves.toBeNull();
  });
});
