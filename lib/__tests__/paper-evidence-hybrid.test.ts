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
    ) => env.MEMORY_VECTOR_ENABLED === "true",
  ),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn() },
  })),
}));

import { sql } from "@/lib/db";
import { embedMemoryText } from "@/lib/memory-embeddings";
import {
  PAPER_EVIDENCE_SECTION_BONUS,
  queryHybridPaperEvidenceRows,
  searchMemoryForTool,
} from "@/lib/memory-retrieval";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockEmbedMemoryText = embedMemoryText as unknown as ReturnType<typeof vi.fn>;

function hybridRow(
  overrides: Partial<{
    id: number;
    feed_item_id: number;
    corpus_tier: string | null;
    span_id: number;
    card_id: number | null;
    section_type: string | null;
    origin: "llm_proposition" | "parser_sentence";
    text: string;
    fts_rank: number | null;
    vec_rank: number | null;
    vec_distance: number | null;
    rrf_score: number | null;
  }> = {},
) {
  const id = overrides.id ?? 1;
  return {
    id,
    feed_item_id: overrides.feed_item_id ?? 101,
    corpus_tier: overrides.corpus_tier ?? "hot_set",
    chunk_index: 0,
    title: "Evidence Paper",
    author_name: "Author",
    published_at: null,
    url: `https://example.com/paper/${id}`,
    span_id: overrides.span_id ?? id + 1000,
    card_id: overrides.card_id ?? null,
    section_path: ["Results"],
    section_type: overrides.section_type ?? "unknown",
    span_type: "sentence",
    origin: overrides.origin ?? "parser_sentence",
    claim_type: "result",
    snippet: overrides.text ?? `hybrid evidence row ${id}`,
    text: overrides.text ?? `hybrid evidence row ${id}`,
    entities: [],
    methods: [],
    datasets: [],
    metrics: [],
    numbers: [],
    aliases: [],
    fts_rank: "fts_rank" in overrides ? overrides.fts_rank : 1,
    vec_rank: "vec_rank" in overrides ? overrides.vec_rank : 1,
    vec_distance: "vec_distance" in overrides ? overrides.vec_distance : 0.2,
    rrf_score: "rrf_score" in overrides ? overrides.rrf_score : null,
    evidence_score: null,
  };
}

async function runHybridQuery() {
  return queryHybridPaperEvidenceRows({
    feedItemIds: [101],
    query: "benchmark result",
    queryEmbedding: [0.1, 0.2, 0.3],
    paperCorpusScope: "default",
    after: null,
    before: null,
    limitPerItem: 3,
  });
}

describe("hybrid paper evidence retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEMORY_VECTOR_ENABLED;
    delete process.env.PAPER_EVIDENCE_LAYER_ENABLED;
    delete process.env.PAPER_EVIDENCE_BONUS_RESULT;
    delete process.env.PAPER_EVIDENCE_BONUS_METHOD;
    delete process.env.PAPER_EVIDENCE_BONUS_LIMITATION;
    delete process.env.PAPER_EVIDENCE_BONUS_ABSTRACT;
    delete process.env.PAPER_EVIDENCE_BONUS_OTHER;
  });

  it("exports rescaled section bonus defaults", () => {
    expect(PAPER_EVIDENCE_SECTION_BONUS).toEqual({
      result: 0.04,
      method: 0.03,
      limitation: 0.02,
      abstract: 0.01,
      other: 0,
    });
  });

  it("reads section bonus overrides at module load", async () => {
    process.env.PAPER_EVIDENCE_BONUS_RESULT = "0.5";
    vi.resetModules();

    const { PAPER_EVIDENCE_SECTION_BONUS: reloadedBonus } = await import(
      "@/lib/memory-retrieval"
    );

    expect(reloadedBonus.result).toBe(0.5);
    expect(reloadedBonus.method).toBe(0.03);
  });

  it("rejects bad section bonus overrides at module load", async () => {
    process.env.PAPER_EVIDENCE_BONUS_RESULT = "abc";
    vi.resetModules();

    await expect(import("@/lib/memory-retrieval")).rejects.toThrow(
      "PAPER_EVIDENCE_BONUS_RESULT must be a finite number",
    );
  });

  it("returns vector-only paper evidence rows", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({ fts_rank: null, vec_rank: 1, text: "semantic-only recovery" }),
    ]);

    const rows = await runHybridQuery();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fts_rank: null,
      vec_rank: 1,
      text: "semantic-only recovery",
      origin: "parser_sentence",
    });
  });

  it("resolves tied ranks deterministically by span id", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({
        id: 1,
        span_id: 20,
        origin: "llm_proposition",
        fts_rank: 2,
        vec_rank: 2,
      }),
      hybridRow({
        id: 2,
        span_id: 10,
        origin: "parser_sentence",
        fts_rank: 2,
        vec_rank: 2,
      }),
    ]);

    const rows = await runHybridQuery();

    expect(rows.map((row) => row.paper_evidence.span_id)).toEqual([10, 20]);
    expect(rows[0].origin).toBe("parser_sentence");
  });

  it("enforces the per-paper cap after hybrid ranking", async () => {
    mockSql.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, index) =>
        hybridRow({
          id: index + 1,
          span_id: index + 100,
          fts_rank: index + 1,
          vec_rank: index + 1,
        }),
      ),
    );

    const rows = await runHybridQuery();

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.feed_item_id === 101)).toBe(true);
  });

  it("applies the paper corpus scope filter to mocked hybrid rows", async () => {
    mockSql.mockResolvedValueOnce([hybridRow({ corpus_tier: "archive" })]);

    const defaultRows = await runHybridQuery();

    mockSql.mockResolvedValueOnce([hybridRow({ corpus_tier: "archive" })]);
    const archiveRows = await queryHybridPaperEvidenceRows({
      feedItemIds: [101],
      query: "benchmark result",
      queryEmbedding: [0.1, 0.2, 0.3],
      paperCorpusScope: "archive",
      after: null,
      before: null,
      limitPerItem: 3,
    });

    expect(defaultRows).toHaveLength(0);
    expect(archiveRows).toHaveLength(1);
  });

  it("lets a strong abstract match surface above weak result-section rows", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({
        id: 1,
        span_id: 101,
        section_type: "result",
        fts_rank: null,
        vec_rank: 48,
        vec_distance: 0.48,
        text: "weak result row 1",
      }),
      hybridRow({
        id: 2,
        span_id: 102,
        section_type: "result",
        fts_rank: null,
        vec_rank: 49,
        vec_distance: 0.49,
        text: "weak result row 2",
      }),
      hybridRow({
        id: 3,
        span_id: 103,
        section_type: "result",
        fts_rank: null,
        vec_rank: 50,
        vec_distance: 0.5,
        text: "weak result row 3",
      }),
      hybridRow({
        id: 4,
        span_id: 104,
        section_type: "abstract",
        fts_rank: 1,
        vec_rank: 1,
        vec_distance: 0.01,
        text: "strong abstract row",
      }),
    ]);

    const rows = await runHybridQuery();

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.text)).toContain("strong abstract row");
  });

  it("preserves section ordering when RRF ranks are tied", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({
        id: 1,
        span_id: 101,
        section_type: "abstract",
        fts_rank: 3,
        vec_rank: 3,
        text: "abstract tied row",
      }),
      hybridRow({
        id: 2,
        span_id: 102,
        section_type: "result",
        fts_rank: 3,
        vec_rank: 3,
        text: "result tied row",
      }),
    ]);

    const firstRows = await runHybridQuery();

    mockSql.mockResolvedValueOnce([
      hybridRow({
        id: 3,
        span_id: 103,
        section_type: "result",
        fts_rank: 3,
        vec_rank: 3,
        text: "result tied row",
      }),
      hybridRow({
        id: 4,
        span_id: 104,
        section_type: "abstract",
        fts_rank: 3,
        vec_rank: 3,
        text: "abstract tied row",
      }),
    ]);

    const reversedRows = await runHybridQuery();

    expect(firstRows[0].text).toBe("result tied row");
    expect(reversedRows[0].text).toBe("result tied row");
  });

  it("surfaces origin in the paper evidence row shape", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({ origin: "llm_proposition", card_id: 77 }),
    ]);

    const rows = await runHybridQuery();

    expect(rows[0].origin).toBe("llm_proposition");
    expect(rows[0].paper_evidence.origin).toBe("llm_proposition");
  });

  it("returns rows compatible with the public search mapper", async () => {
    mockSql.mockResolvedValueOnce([
      hybridRow({ id: 88, span_id: 501, origin: "llm_proposition" }),
    ]);

    const [row] = await runHybridQuery();

    expect({ ...row }).toMatchObject({
      id: 88,
      source_type: "paper",
      snippet: expect.any(String),
      text: expect.any(String),
      paper_evidence: {
        span_id: 501,
        origin: "llm_proposition",
      },
    });
  });

  it("shares one query embedding across paper evidence and chunk hybrid retrieval", async () => {
    process.env.MEMORY_VECTOR_ENABLED = "true";
    process.env.PAPER_EVIDENCE_LAYER_ENABLED = "true";
    mockEmbedMemoryText.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("exact_terms AS")) {
        return Promise.resolve([
          {
            feed_item_id: 101,
            source_type: "paper",
            title: "Evidence Paper",
            author_name: "Author",
            published_at: null,
            url: "https://example.com/paper/101",
            item_rank: 1,
          },
        ]);
      }
      if (
        template.includes("FROM paper_evidence_spans pes") &&
        template.includes("pes.embedding IS NOT NULL")
      ) {
        return Promise.resolve([
          hybridRow({
            id: 88,
            feed_item_id: 101,
            span_id: 501,
            text: "unrelated semantic paper sentence",
            fts_rank: null,
            vec_rank: 1,
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    await searchMemoryForTool({
      query: "What benchmark result did the paper report?",
      source: "paper",
      mode: "evidence",
    });

    expect(mockEmbedMemoryText).toHaveBeenCalledTimes(1);
  });
});
