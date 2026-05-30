import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/memory-chunks", () => ({
  refreshKnowledgeChunksForFeedItemIfStale: vi.fn(),
}));

vi.mock("@/lib/memory-embeddings", () => ({
  embedMemoryTexts: vi.fn(),
  formatPgVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
}));

const mockAnthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

import { sql } from "@/lib/db";
import { embedMemoryTexts } from "@/lib/memory-embeddings";
import {
  PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
  buildPaperEvidenceLayerDrafts,
  embedMissingCurrentSourceSemanticSpans,
  getCurrentSourceSemanticEvidenceStatus,
  rebuildPaperEvidenceLayerForFeedItem,
} from "../paper-evidence-layer";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockEmbedMemoryTexts = embedMemoryTexts as unknown as ReturnType<typeof vi.fn>;

const sourceSentence =
  "We introduce PlayCoder, a self-evolving coding agent for repository tasks.";
const tableBlock = "Game Emulation | MMORPG Games | Desktop Widgets";

const samplePaper = {
  id: 42,
  external_id: "arxiv:2605.12345",
  source_type: "paper" as const,
  title: "PlayCoder",
  content: "We introduce PlayCoder.",
  author_name: "Research Team",
  author_handle: null,
  published_at: "2026-05-01T00:00:00Z",
  paper_meta: null,
  full_text: [
    "# PlayCoder",
    "## Abstract",
    sourceSentence,
    "## Results",
    tableBlock,
  ].join("\n"),
  full_text_source: "arxiv_html" as const,
};

function rangeFor(needle: string) {
  return rangeForText(samplePaper.full_text, needle);
}

function rangeForText(fullText: string, needle: string) {
  const start = fullText.indexOf(needle);
  if (start < 0) {
    throw new Error(`Missing fixture text: ${needle}`);
  }
  return { start, end: start + needle.length };
}

function llmExtractionJson() {
  return JSON.stringify({
    propositions: [
      {
        ...rangeFor(sourceSentence),
        text: sourceSentence,
        section_index: 1,
      },
    ],
    list_table_blocks: [
      {
        ...rangeFor(tableBlock),
        text: tableBlock,
        section_index: 2,
        block_kind: "table",
      },
    ],
    claims: [
      {
        claim: "PlayCoder is introduced as a self-evolving coding agent.",
        claim_type: "method",
        primary_support_span_ref: 0,
        support_span_refs: [0],
        entities: ["PlayCoder"],
        methods: ["self-evolving coding agent"],
        confidence: 0.8,
      },
    ],
    coined_terms: [
      {
        canonical: "PlayCoder",
        aliases: ["self-evolving coding agent"],
        anchor_type: "system",
        support_span_ref: 0,
      },
    ],
  });
}

function mockSchemaAndChunks() {
  mockSql.mockImplementation((strings: TemplateStringsArray) => {
    const template = strings.join(" ");
    if (template.includes("information_schema.columns")) {
      return Promise.resolve([
        { column_name: "embedding" },
        { column_name: "embedding_model" },
        { column_name: "embedding_updated_at" },
      ]);
    }
    if (template.includes("FROM knowledge_chunks")) {
      return Promise.resolve([{ id: 700, chunk_index: 0, text: samplePaper.full_text }]);
    }
    if (template.includes("WITH deleted_cards AS")) {
      return Promise.resolve([{ sections: 3, spans: 2, cards: 1, profiles: 1 }]);
    }
    if (template.includes("FROM paper_evidence_spans")) {
      return Promise.resolve([
        { id: 201, text: sourceSentence },
        { id: 202, text: tableBlock },
      ]);
    }
    if (template.includes("INSERT INTO paper_sections")) {
      return Promise.resolve([{ id: 101 }]);
    }
    if (template.includes("INSERT INTO paper_evidence_spans")) {
      return Promise.resolve([
        { id: 201, span_index: 0 },
        { id: 202, span_index: 1 },
      ]);
    }
    return Promise.resolve([]);
  });
}

const llmExtractorMode = { extractorMode: "llm" as const };

describe("paper evidence layer LLM reader integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: llmExtractionJson() }],
      usage: { input_tokens: 123, output_tokens: 45 },
    });
    mockEmbedMemoryTexts.mockResolvedValue({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      model: "text-embedding-3-small",
    });
  });

  it("bumps the extractor version to v2", () => {
    expect(PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION).toBe(
      "paper-evidence-layer-extractor:v2",
    );
  });

  it("keeps the deterministic extractor path when the LLM flag is off", async () => {
    mockSchemaAndChunks();

    const drafts = await buildPaperEvidenceLayerDrafts(mockSql as never, samplePaper);

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(drafts.spans.some((span) => span.text.includes(sourceSentence))).toBe(true);
    expect(new Set(drafts.spans.map((span) => span.origin))).toEqual(
      new Set(["parser_sentence"]),
    );
    expect(drafts.cards.length).toBeGreaterThan(0);
  });

  it("fails before prompt construction when embedding schema is missing", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSql.mockResolvedValue([]);

    await expect(
      buildPaperEvidenceLayerDrafts(mockSql as never, samplePaper, llmExtractorMode),
    ).rejects.toThrow(/embedding columns/i);

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("fails clearly when LLM config is missing and does not fall back", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    mockSchemaAndChunks();

    await expect(
      buildPaperEvidenceLayerDrafts(mockSql as never, samplePaper, llmExtractorMode),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/i);

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("builds LLM spans, cards, coined anchors, and token telemetry when enabled", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(drafts.spans.map((span) => span.spanType)).toEqual([
      "sentence",
      "table_row",
    ]);
    expect(drafts.spans.map((span) => span.origin)).toEqual([
      "llm_proposition",
      "llm_proposition",
    ]);
    expect(drafts.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimType: "method",
          primarySupportSpanIndex: 0,
          supportSpanIndexes: [0],
          sectionPath: expect.arrayContaining(["Abstract"]),
        }),
      ]),
    );
    expect(drafts.identityAnchors).toEqual(
      expect.arrayContaining(["PlayCoder", "self-evolving coding agent"]),
    );
    expect(drafts.llmInputTokens).toBe(123);
    expect(drafts.llmOutputTokens).toBe(45);
    expect(drafts.droppedSpans).toBe(0);
  });

  it("keeps parser fallback cards for LLM propositions that have no accepted claim", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    const unclaimedDefinition =
      "To combine their strengths while mitigating their limitations, we propose ATLAS, a framework in which a single discrete word, termed as a functional token, serves both as an agentic operation and a latent visual reasoning unit.";
    const fullText = [
      "# PlayCoder",
      "## Abstract",
      sourceSentence,
      unclaimedDefinition,
      "## Results",
      tableBlock,
    ].join("\n");
    const paperWithUnclaimedDefinition = {
      ...samplePaper,
      content: unclaimedDefinition,
      full_text: fullText,
    };
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            propositions: [
              {
                ...rangeForText(fullText, sourceSentence),
                text: sourceSentence,
                section_index: 1,
              },
              {
                ...rangeForText(fullText, unclaimedDefinition),
                text: unclaimedDefinition,
                section_index: 1,
              },
            ],
            list_table_blocks: [],
            claims: [
              {
                claim: "PlayCoder is introduced as a self-evolving coding agent.",
                claim_type: "method",
                primary_support_span_ref: 0,
                support_span_refs: [0],
                confidence: 0.8,
              },
            ],
            coined_terms: [],
          }),
        },
      ],
      usage: { input_tokens: 123, output_tokens: 45 },
    });

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      paperWithUnclaimedDefinition,
      llmExtractorMode,
    );
    const unclaimedSpan = drafts.spans.find(
      (span) => span.text === unclaimedDefinition,
    );

    expect(unclaimedSpan).toMatchObject({
      origin: "llm_proposition",
    });
    expect(
      drafts.cards.some(
        (card) =>
          card.primarySupportSpanIndex === unclaimedSpan?.spanIndex &&
          card.claim === unclaimedDefinition,
      ),
    ).toBe(true);
  });

  it("adds parser-backed source spans in LLM mode when the model omits an abstract definition", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    const omittedDefinition =
      "To combine their strengths while mitigating their limitations, we propose ATLAS, a framework in which a single discrete word, termed as a functional token, serves both as an agentic operation and a latent visual reasoning unit.";
    const paperWithOmittedDefinition = {
      ...samplePaper,
      content: omittedDefinition,
    };

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      paperWithOmittedDefinition,
      llmExtractorMode,
    );

    expect(drafts.spans[0]?.text).toBe(sourceSentence);
    expect(drafts.spans[0]?.origin).toBe("llm_proposition");
    expect(drafts.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          primarySupportSpanIndex: 0,
          supportSpanIndexes: [0],
        }),
      ]),
    );
    expect(
      drafts.spans.some(
        (span) => span.text === omittedDefinition && span.origin === "parser_sentence",
      ),
    ).toBe(true);
  });

  it("deduplicates LLM cards that target the same source span and claim type", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            propositions: [
              {
                ...rangeFor(sourceSentence),
                text: sourceSentence,
                section_index: 1,
              },
            ],
            list_table_blocks: [],
            claims: [
              {
                claim: "PlayCoder is introduced as a self-evolving coding agent.",
                claim_type: "method",
                primary_support_span_ref: 0,
                support_span_refs: [0],
                confidence: 0.6,
              },
              {
                claim:
                  "PlayCoder is introduced as a self-evolving coding agent for repository tasks.",
                claim_type: "method",
                primary_support_span_ref: 0,
                support_span_refs: [0],
                confidence: 0.9,
              },
            ],
            coined_terms: [],
          }),
        },
      ],
      usage: { input_tokens: 123, output_tokens: 45 },
    });

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );

    const llmCardsForPrimarySpan = drafts.cards.filter(
      (card) => card.primarySupportSpanIndex === 0 && card.claimType === "method",
    );
    expect(llmCardsForPrimarySpan).toHaveLength(1);
    expect(llmCardsForPrimarySpan[0]).toMatchObject({
      claim:
        "PlayCoder is introduced as a self-evolving coding agent for repository tasks.",
      claimType: "method",
      primarySupportSpanIndex: 0,
    });
  });

  it("uses distinct stable keys for sentence and table spans over the same source range", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            propositions: [
              {
                ...rangeFor(tableBlock),
                text: tableBlock,
                section_index: 2,
              },
            ],
            list_table_blocks: [
              {
                ...rangeFor(tableBlock),
                text: tableBlock,
                section_index: 2,
                block_kind: "table",
              },
            ],
            claims: [],
            coined_terms: [],
          }),
        },
      ],
      usage: { input_tokens: 123, output_tokens: 45 },
    });

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );

    expect(drafts.spans.slice(0, 2).map((span) => span.spanType)).toEqual([
      "sentence",
      "table_row",
    ]);
    expect(new Set(drafts.spans.map((span) => span.stableKey)).size).toBe(
      drafts.spans.length,
    );
  });

  it("parses fenced JSON responses from the LLM extractor", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: `\`\`\`json\n${llmExtractionJson()}\n\`\`\`` }],
      usage: { input_tokens: 123, output_tokens: 45 },
    });

    const drafts = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );

    expect(drafts.spans).toHaveLength(2);
    expect(drafts.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimType: "method",
          primarySupportSpanIndex: 0,
        }),
      ]),
    );
  });

  it("keeps stable span keys for unchanged accepted source ranges", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();

    const first = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );
    const second = await buildPaperEvidenceLayerDrafts(
      mockSql as never,
      samplePaper,
      llmExtractorMode,
    );

    expect(second.spans.map((span) => span.stableKey)).toEqual(
      first.spans.map((span) => span.stableKey),
    );
  });

  it("dry-run validates LLM output without deleting, inserting, or embedding", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();

    const result = await rebuildPaperEvidenceLayerForFeedItem(
      mockSql as never,
      samplePaper,
      { dryRun: true, extractorMode: "llm" },
    );

    expect(result.spans).toBe(2);
    expect(result.wouldEmbedCount).toBe(2);
    expect(mockEmbedMemoryTexts).not.toHaveBeenCalled();
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").match(/\b(DELETE|INSERT|UPDATE)\b/),
      ),
    ).toBe(false);
  });

  it("embeds accepted LLM spans and writes model and timestamp on success", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();

    const result = await rebuildPaperEvidenceLayerForFeedItem(
      mockSql as never,
      samplePaper,
      { refreshChunks: false, extractorMode: "llm" },
    );

    expect(mockEmbedMemoryTexts).toHaveBeenCalledWith([sourceSentence, tableBlock]);
    expect(result.embeddingInputCount).toBe(2);
    expect(result.embeddingFailedCount).toBe(0);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("origin") &&
        call[0].join(" ").includes("INSERT INTO paper_evidence_spans"),
      ),
    ).toBe(true);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("embedding_updated_at = NOW()"),
      ),
    ).toBe(true);
  });

  it("preserves inserted spans and cards when embedding fails", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockSchemaAndChunks();
    mockEmbedMemoryTexts.mockRejectedValueOnce(new Error("embedding outage"));

    const result = await rebuildPaperEvidenceLayerForFeedItem(
      mockSql as never,
      samplePaper,
      { refreshChunks: false, extractorMode: "llm" },
    );

    expect(result.spans).toBe(2);
    expect(result.cards).toBe(1);
    expect(result.embeddingInputCount).toBe(2);
    expect(result.embeddingFailedCount).toBe(2);
    expect(result.embeddingIncomplete).toBe(true);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("INSERT INTO paper_evidence_cards"),
      ),
    ).toBe(true);
  });

  it("resumes a bounded batch of all current-source spans with missing embeddings", async () => {
    const sqlForResume = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const template = strings.join(" ");
      if (
        template.includes("SELECT id, text") &&
        template.includes("embedding IS NULL")
      ) {
        expect(template).not.toContain("origin = 'llm_proposition'");
        expect(values.at(-1)).toBe(2);
        return [
          { id: 301, text: "first missing proposition" },
          { id: 302, text: "parser fallback sentence" },
        ];
      }
      if (template.includes("UPDATE paper_evidence_spans")) {
        return [];
      }
      if (template.includes("section_count")) {
        return [{
          section_count: 2,
          semantic_span_count: 3,
          card_count: 2,
          profile_count: 1,
          missing_embedding_count: 1,
        }];
      }
      return [];
    });
    mockEmbedMemoryTexts.mockResolvedValueOnce({
      embeddings: [
        [0.11, 0.12, 0.13],
        [0.21, 0.22, 0.23],
      ],
      model: "text-embedding-3-small",
    });

    const result = await embedMissingCurrentSourceSemanticSpans(
      sqlForResume as never,
      samplePaper,
      { limit: 2 },
    );

    expect(mockEmbedMemoryTexts).toHaveBeenCalledWith([
      "first missing proposition",
      "parser fallback sentence",
    ]);
    expect(result).toMatchObject({
      feedItemId: 42,
      semanticSpanCount: 3,
      missingEmbeddingCount: 1,
      embeddingInputCount: 2,
      embeddingFailedCount: 0,
      embeddingIncomplete: true,
      embeddingsComplete: false,
    });
    expect(
      sqlForResume.mock.calls.filter((call) =>
        call[0].join(" ").includes("embedding_updated_at = NOW()"),
      ),
    ).toHaveLength(2);
  });

  it("reports current-source semantic embeddings complete without embedding when none are missing", async () => {
    const sqlForResume = vi.fn(async (strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (
        template.includes("SELECT id, text") &&
        template.includes("embedding IS NULL")
      ) {
        return [];
      }
      if (template.includes("section_count")) {
        return [{
          section_count: 2,
          semantic_span_count: 3,
          card_count: 2,
          profile_count: 1,
          missing_embedding_count: 0,
        }];
      }
      return [];
    });

    const status = await getCurrentSourceSemanticEvidenceStatus(
      sqlForResume as never,
      samplePaper,
    );
    const result = await embedMissingCurrentSourceSemanticSpans(
      sqlForResume as never,
      samplePaper,
    );

    expect(status).toMatchObject({
      hasSemanticEvidence: true,
      embeddingsComplete: true,
      missingEmbeddingCount: 0,
    });
    expect(result).toMatchObject({
      embeddingInputCount: 0,
      embeddingFailedCount: 0,
      embeddingIncomplete: false,
      embeddingsComplete: true,
    });
    expect(mockEmbedMemoryTexts).not.toHaveBeenCalled();
  });
});
