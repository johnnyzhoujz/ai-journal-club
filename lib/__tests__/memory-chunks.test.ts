import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/memory-embeddings", () => ({
  embedMemoryTexts: vi.fn(),
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

import { sql } from "@/lib/db";
import { embedMemoryTexts } from "@/lib/memory-embeddings";
import {
  backfillKnowledgeChunks,
  buildKnowledgeChunkDrafts,
  buildKnowledgeChunkRetrievalText,
  buildKnowledgeMemoryDocument,
  isMemoryChunkBackfillEnabled,
  isMemoryChunkWritesEnabled,
  refreshKnowledgeChunksForFeedItem,
  refreshKnowledgeChunksForFeedItemIfStale,
  selectKnowledgeChunkEmbeddingText,
  splitTextIntoMemoryChunks,
  writeKnowledgeChunksForFeedItem,
  type MemoryBackfillFeedItem,
} from "../memory-chunks";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockEmbedMemoryTexts = embedMemoryTexts as unknown as ReturnType<typeof vi.fn>;

const sampleFeedItem: MemoryBackfillFeedItem = {
  id: 10,
  source_type: "paper",
  title: "Agent evaluation loops",
  content: "Agent evaluation loops need realistic tasks and careful review.",
  author_name: "Research Team",
  author_handle: null,
  published_at: "2026-04-24T09:00:00Z",
  paper_meta: {
    upvotes: 42,
    numComments: 3,
    githubRepo: "https://github.com/example/evals",
    githubStars: 100,
    aiSummary: "Evaluation systems for agents.",
    aiKeywords: ["agents", "evals"],
    authors: [{ name: "Alice Example", user: "alice" }],
    providers: {
      hf: {
        upvotes: 42,
        numComments: 3,
        githubRepo: "https://github.com/example/evals",
        githubStars: 100,
        aiSummary: "HF summary for agent evaluations.",
        aiKeywords: ["agents", "evals"],
      },
      alphaxiv: {
        votes: 12,
        visitsAll: 500,
        visitsLast7Days: 80,
        githubUrl: "https://github.com/example/alphaxiv-evals",
        githubStars: 250,
        topics: ["Computer Science", "agents"],
        summary: "alphaXiv summary for the paper.",
        originalProblem: ["Agent evaluation is too synthetic."],
        solution: ["Use realistic review loops."],
        keyInsights: ["Benchmarks need task fidelity."],
        results: ["Review loops improved reliability."],
      },
    },
  },
};

describe("memory chunk backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEMORY_VECTOR_ENABLED;
    delete process.env.PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS;
  });

  it("gates backfill on an explicit true feature flag", () => {
    expect(isMemoryChunkBackfillEnabled({ MEMORY_CHUNK_BACKFILL_ENABLED: "true" })).toBe(true);
    expect(isMemoryChunkBackfillEnabled({ MEMORY_CHUNK_BACKFILL_ENABLED: "false" })).toBe(false);
    expect(isMemoryChunkBackfillEnabled({})).toBe(false);
  });

  it("gates fetch pipeline writes on an exact true feature flag", () => {
    expect(isMemoryChunkWritesEnabled({ MEMORY_CHUNK_WRITES_ENABLED: "true" })).toBe(true);
    expect(isMemoryChunkWritesEnabled({ MEMORY_CHUNK_WRITES_ENABLED: "TRUE" })).toBe(false);
    expect(isMemoryChunkWritesEnabled({ MEMORY_CHUNK_WRITES_ENABLED: "false" })).toBe(false);
    expect(isMemoryChunkWritesEnabled({})).toBe(false);
  });

  it("splits long text into bounded overlapping chunks", () => {
    const text = Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ");

    const chunks = splitTextIntoMemoryChunks(text, 5, 2, 10);

    expect(chunks).toEqual([
      "word0 word1 word2 word3 word4",
      "word3 word4 word5 word6 word7",
      "word6 word7 word8 word9 word10",
      "word9 word10 word11",
    ]);
  });

  it("builds chunk drafts with stable indexes and entity labels", () => {
    const drafts = buildKnowledgeChunkDrafts(sampleFeedItem, {
      chunkTokenLimit: 5,
      chunkTokenOverlap: 1,
    });

    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts[0]).toMatchObject({
      feedItemId: 10,
      chunkIndex: 0,
      sourceType: "paper",
      title: "Agent evaluation loops",
      authorName: "Research Team",
      authorHandle: null,
    });
    expect(drafts[0].tokenCount).toBeGreaterThan(0);
    expect(drafts[0].entityLabels).toEqual(
      expect.arrayContaining(["research team", "agents", "evals", "alice example", "alice"]),
    );
    expect(drafts[0].retrievalText).toContain("Source type: paper");
    expect(drafts[0].retrievalText).toContain("Title: Agent evaluation loops");
    expect(drafts[0].retrievalText).toContain("Paper authors: Alice Example (@alice)");
    expect(drafts[0].retrievalText).toContain("Paper keywords: agents, evals");
    expect(drafts[0].retrievalText).toContain("Content:\nTitle: Agent evaluation loops");
    expect(drafts[0].memorySourceKind).toBe("feed_item:paper:v3-card");
    expect(drafts[0].memorySourceHash).toBe(
      buildKnowledgeMemoryDocument(sampleFeedItem).sourceHash,
    );
  });

  it("keeps a paper card and splits full text by section headings", () => {
    process.env.PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS = "true";
    const fullText = [
      "# Introduction",
      Array.from({ length: 12 }, (_, i) => `intro${i}`).join(" "),
      "## Method",
      Array.from({ length: 12 }, (_, i) => `method${i}`).join(" "),
      "## Results",
      Array.from({ length: 12 }, (_, i) => `result${i}`).join(" "),
    ].join("\n");

    const drafts = buildKnowledgeChunkDrafts(
      { ...sampleFeedItem, full_text: fullText },
      { chunkTokenLimit: 8, chunkTokenOverlap: 2 },
    );

    expect(drafts[0].text).toContain("Paper card:");
    expect(drafts[0].text).toContain("Abstract: Agent evaluation loops");
    expect(drafts[0].text).not.toContain("intro0");
    expect(drafts[1].text).toContain("Section: Introduction");
    expect(drafts[1].text).toContain("intro0");
    expect(drafts.some((draft) => draft.text.includes("Section: Introduction > Method"))).toBe(
      true,
    );
    expect(drafts.some((draft) => draft.text.includes("Section: Introduction > Results"))).toBe(
      true,
    );
    expect(drafts[1].retrievalText).toContain("Content:\nSection: Introduction");
  });

  it("builds paper memory documents from abstract, provider signals, and full_text", () => {
    process.env.PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS = "true";
    const longFullText = Array.from({ length: 30 }, (_, i) => `body${i}`).join(" ");
    const memoryDocument = buildKnowledgeMemoryDocument({
      ...sampleFeedItem,
      full_text: longFullText,
    });

    expect(memoryDocument.text).toContain("Abstract: Agent evaluation loops need realistic tasks");
    expect(memoryDocument.text).toContain("HF AI summary: HF summary for agent evaluations.");
    expect(memoryDocument.text).toContain("Original problem: Agent evaluation is too synthetic.");
    expect(memoryDocument.text).toContain("GitHub signal: https://github.com/example/evals (100 stars)");
    expect(memoryDocument.text).toContain("Full text: body0 body1");
  });

  it("keeps paper global memory card-only by default even when full_text exists", () => {
    const longFullText = Array.from({ length: 30 }, (_, i) => `body${i}`).join(" ");
    const memoryDocument = buildKnowledgeMemoryDocument({
      ...sampleFeedItem,
      full_text: longFullText,
    });
    const drafts = buildKnowledgeChunkDrafts({
      ...sampleFeedItem,
      full_text: longFullText,
    });

    expect(memoryDocument.text).toContain("Abstract: Agent evaluation loops need realistic tasks");
    expect(memoryDocument.text).not.toContain("Full text: body0 body1");
    expect(memoryDocument.sourceKind).toBe("feed_item:paper:v3-card");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toContain("Agent evaluation loops");
    expect(drafts[0].text).not.toContain("body0");
  });

  it("formats database Date values in retrieval text", () => {
    const publishedAt = new Date("2026-04-24T09:00:00.000Z");
    const drafts = buildKnowledgeChunkDrafts({
      ...sampleFeedItem,
      published_at: publishedAt,
    });

    expect(drafts[0].publishedAt).toBe(publishedAt);
    expect(drafts[0].retrievalText).toContain(
      "Published: 2026-04-24T09:00:00.000Z",
    );
  });

  it("changes the memory source hash when paper memory inputs change", () => {
    const withoutFullText = buildKnowledgeMemoryDocument(sampleFeedItem);
    const withFullText = buildKnowledgeMemoryDocument({
      ...sampleFeedItem,
      full_text: "new full text",
    });
    const withProviderUpdate = buildKnowledgeMemoryDocument({
      ...sampleFeedItem,
      paper_meta: {
        ...sampleFeedItem.paper_meta!,
        aiSummary: "Updated evaluation summary.",
      },
    });

    expect(withFullText.sourceHash).toBe(withoutFullText.sourceHash);
    expect(withProviderUpdate.sourceHash).not.toBe(withoutFullText.sourceHash);
  });

  it("falls back to content when full_text is null or undefined", () => {
    const draftsWithNull = buildKnowledgeChunkDrafts(
      { ...sampleFeedItem, full_text: null },
      { chunkTokenLimit: 50, chunkTokenOverlap: 5 },
    );
    expect(draftsWithNull[0].text).toContain("Agent evaluation loops");

    const draftsWithUndefined = buildKnowledgeChunkDrafts(sampleFeedItem, {
      chunkTokenLimit: 50,
      chunkTokenOverlap: 5,
    });
    expect(draftsWithUndefined[0].text).toContain("Agent evaluation loops");
  });

  it("builds metadata-rich retrieval text for non-paper chunks", () => {
    const retrievalText = buildKnowledgeChunkRetrievalText({
      sourceType: "tweet",
      title: null,
      authorName: "Peter Yang",
      authorHandle: "@petergyang",
      publishedAt: "2026-04-24T09:00:00Z",
      text: "A personal assistant should use Gmail and Calendar APIs proactively.",
      entityLabels: ["gmail", "calendar", "google workspace"],
      paperMeta: null,
    });

    expect(retrievalText).toBe(
      [
        "Source type: tweet",
        "Author/source: Peter Yang / @petergyang",
        "Published: 2026-04-24T09:00:00Z",
        "Entities: gmail, calendar, google workspace",
        "Content:",
        "A personal assistant should use Gmail and Calendar APIs proactively.",
      ].join("\n"),
    );
  });

  it("prefers retrieval text for embedding input and falls back to chunk text", () => {
    expect(
      selectKnowledgeChunkEmbeddingText({
        retrievalText: " Source type: tweet\nContent:\nmetadata plus text ",
        text: "raw chunk text",
      }),
    ).toBe("Source type: tweet\nContent:\nmetadata plus text");
    expect(
      selectKnowledgeChunkEmbeddingText({
        retrievalText: "   ",
        text: "raw chunk text",
      }),
    ).toBe("raw chunk text");
  });

  it("selects unchunked feed items and upserts generated chunks", async () => {
    mockSql.mockResolvedValueOnce([sampleFeedItem]);
    mockSql.mockResolvedValue([]);

    const result = await backfillKnowledgeChunks({
      limit: 10,
      chunkTokenLimit: 1000,
    });

    expect(result).toMatchObject({
      selectedItemCount: 1,
      upsertedChunkCount: 1,
      skippedItemCount: 0,
      failedItemCount: 0,
      lastFeedItemId: 10,
      errors: [],
    });
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("FROM feed_items");
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("NOT EXISTS");
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("DELETE FROM knowledge_chunks");
    expect(mockSql.mock.calls[2][0].join(" ")).toContain("INSERT INTO knowledge_chunks");
    expect(mockSql.mock.calls[2][0].join(" ")).toContain("ON CONFLICT");
    expect(mockSql.mock.calls[2].slice(1)).toContain(10);
  });

  it("writes chunks for one already known feed item", async () => {
    mockSql.mockResolvedValue([]);

    const result = await writeKnowledgeChunksForFeedItem(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });

    expect(result).toEqual({
      upsertedChunkCount: 1,
      skippedItem: false,
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("DELETE FROM knowledge_chunks");
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("INSERT INTO knowledge_chunks");
    expect(mockSql.mock.calls[1].slice(1)).toContain(10);
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("embedding = NULL");
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("memory_source_hash");
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("memory_source_kind");
    expect(mockEmbedMemoryTexts).not.toHaveBeenCalled();
  });

  it("stores embeddings for new chunk writes when vector search is enabled", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    mockEmbedMemoryTexts.mockResolvedValueOnce({
      embeddings: [[0.1, 0.2, 0.3]],
      model: "text-embedding-3-small",
    });
    mockSql.mockResolvedValue([]);

    const result = await writeKnowledgeChunksForFeedItem(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });

    expect(result.upsertedChunkCount).toBe(1);
    expect(mockEmbedMemoryTexts).toHaveBeenCalledWith([
      expect.stringContaining("Source type: paper"),
    ]);
    expect(mockEmbedMemoryTexts.mock.calls[0][0][0]).toContain(
      "Paper authors: Alice Example (@alice)",
    );
    expect(mockEmbedMemoryTexts.mock.calls[0][0][0]).toContain(
      "Content:\nTitle: Agent evaluation loops Abstract: Agent evaluation loops need realistic tasks",
    );

    const template = mockSql.mock.calls[1][0].join(" ");
    const values = mockSql.mock.calls[1].slice(1);
    expect(template).toContain("retrieval_text");
    expect(template).toContain("memory_source_hash");
    expect(template).toContain("memory_source_kind");
    expect(template).toContain("embedding,");
    expect(template).toContain("embedding_model");
    expect(template).toContain("embedding_updated_at");
    expect(template).toContain("::vector");
    expect(template).toContain("embedding = EXCLUDED.embedding");
    expect(values).toContain("[0.1,0.2,0.3]");
    expect(values).toContain("text-embedding-3-small");
  });

  it("does not delete existing chunks when embedding fails during refresh", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockEmbedMemoryTexts.mockRejectedValueOnce(new Error("embedding unavailable"));
    mockSql.mockResolvedValue([]);

    await expect(
      refreshKnowledgeChunksForFeedItem(sampleFeedItem, {
        chunkTokenLimit: 1000,
      }),
    ).rejects.toThrow("embedding unavailable");

    expect(consoleError).toHaveBeenCalledWith(
      "memory_chunks.embedding_failed",
      expect.objectContaining({ error: "embedding unavailable" }),
    );
    expect(mockSql).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("skips chunk writes for an empty feed item", async () => {
    const result = await writeKnowledgeChunksForFeedItem({
      ...sampleFeedItem,
      title: null,
      content: "   ",
      paper_meta: null,
      full_text: null,
    });

    expect(result).toEqual({
      upsertedChunkCount: 0,
      skippedItem: true,
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("deletes existing chunks before a refresh backfill", async () => {
    mockSql.mockResolvedValueOnce([sampleFeedItem]);
    mockSql.mockResolvedValue([]);

    await backfillKnowledgeChunks({
      feedItemId: 10,
      refreshExisting: true,
      chunkTokenLimit: 1000,
    });

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("DELETE FROM knowledge_chunks");
    expect(mockSql.mock.calls[2][0].join(" ")).toContain("INSERT INTO knowledge_chunks");
  });

  it("checks chunk source hashes and skips refresh when chunks are fresh", async () => {
    const drafts = buildKnowledgeChunkDrafts(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });
    mockSql.mockResolvedValueOnce([
      {
        existing_chunk_count: drafts.length,
        stale_chunk_count: 0,
      },
    ]);

    const result = await refreshKnowledgeChunksForFeedItemIfStale(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });

    expect(result.refreshed).toBe(false);
    expect(result.upsertedChunkCount).toBe(0);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSql.mock.calls[0][0].join(" ")).toContain("memory_source_hash IS DISTINCT FROM");
  });

  it("refreshes chunks when source hashes are stale", async () => {
    mockSql.mockResolvedValueOnce([
      {
        existing_chunk_count: 1,
        stale_chunk_count: 1,
      },
    ]);
    mockSql.mockResolvedValue([]);

    const result = await refreshKnowledgeChunksForFeedItemIfStale(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });

    expect(result.refreshed).toBe(true);
    expect(result.upsertedChunkCount).toBe(1);
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockSql.mock.calls[1][0].join(" ")).toContain("DELETE FROM knowledge_chunks");
    expect(mockSql.mock.calls[2][0].join(" ")).toContain("INSERT INTO knowledge_chunks");
  });

  it("generates embeddings before deleting existing chunks during refresh", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    const events: string[] = [];
    mockEmbedMemoryTexts.mockImplementationOnce(async () => {
      events.push("embed");
      return {
        embeddings: [[0.1, 0.2, 0.3]],
        model: "text-embedding-3-small",
      };
    });
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("DELETE FROM knowledge_chunks")) {
        events.push("delete");
      }
      if (template.includes("INSERT INTO knowledge_chunks")) {
        events.push("insert");
      }
      return [];
    });

    await refreshKnowledgeChunksForFeedItem(sampleFeedItem, {
      chunkTokenLimit: 1000,
    });

    expect(events).toEqual(["embed", "delete", "insert"]);
  });

  it("cleans up partial chunks when an item fails", async () => {
    mockSql
      .mockResolvedValueOnce([sampleFeedItem])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce([]);

    const result = await backfillKnowledgeChunks({
      chunkTokenLimit: 1000,
    });

    expect(result.upsertedChunkCount).toBe(0);
    expect(result.failedItemCount).toBe(1);
    expect(result.errors[0]).toContain("feed_item_id=10");
    expect(mockSql.mock.calls[3][0].join(" ")).toContain("DELETE FROM knowledge_chunks");
  });
});
