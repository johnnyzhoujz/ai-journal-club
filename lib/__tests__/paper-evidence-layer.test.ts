import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/memory-chunks", () => ({
  refreshKnowledgeChunksForFeedItemIfStale: vi.fn(),
}));

import { sql } from "@/lib/db";
import { refreshKnowledgeChunksForFeedItemIfStale } from "@/lib/memory-chunks";
import {
  extractPaperEvidenceCards,
  extractPaperEvidenceSpans,
  isPaperEvidenceLayerEnabled,
  parsePaperEvidenceSections,
  queryPaperEvidenceLayerRows,
  rebuildPaperEvidenceLayerForFeedItem,
} from "../paper-evidence-layer";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRefreshKnowledgeChunksForFeedItemIfStale =
  refreshKnowledgeChunksForFeedItemIfStale as unknown as ReturnType<typeof vi.fn>;

const samplePaper = {
  id: 5466,
  source_type: "paper" as const,
  title: "SWE-chat",
  content: "A dataset of agentic coding sessions.",
  author_name: "Research Team",
  author_handle: null,
  published_at: "2026-05-01T00:00:00Z",
  paper_meta: null,
  full_text: [
    "# SWE-chat",
    "## Abstract",
    "We study how developers use coding agents in realistic sessions.",
    "## Dataset",
    "SWE-chat contains 6,000 coding sessions, 63,000 user prompts, 355,000 agent tool calls, and 2.7M logged events from real users.",
    "## Results",
    "The analysis shows agent tool calls concentrate around debugging and repository navigation.",
  ].join("\n"),
  full_text_source: "arxiv_html" as const,
};

describe("paper evidence layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshKnowledgeChunksForFeedItemIfStale.mockResolvedValue({
      upsertedChunkCount: 0,
      skippedItem: false,
      refreshed: false,
      sourceHash: "hash",
      sourceKind: "feed_item:paper:v1",
    });
  });

  it("gates runtime search on an exact feature flag", () => {
    expect(isPaperEvidenceLayerEnabled({ PAPER_EVIDENCE_LAYER_ENABLED: "true" })).toBe(true);
    expect(isPaperEvidenceLayerEnabled({ PAPER_EVIDENCE_LAYER_ENABLED: "TRUE" })).toBe(false);
    expect(isPaperEvidenceLayerEnabled({})).toBe(false);
  });

  it("parses sections and extracts exact numeric evidence spans/cards", () => {
    const sections = parsePaperEvidenceSections(samplePaper);
    expect(sections.map((section) => section.sectionPath.at(-1))).toContain("Dataset");

    const spans = extractPaperEvidenceSpans({
      feedItemId: samplePaper.id,
      sourceHash: "source-hash",
      sections,
      chunks: [
        {
          id: 6500,
          chunk_index: 4,
          text: `Section: Dataset\n${samplePaper.full_text}`,
        },
      ],
    });
    const scaleSpan = spans.find((span) =>
      span.text.includes("355,000 agent tool calls"),
    );

    expect(scaleSpan).toMatchObject({
      feedItemId: 5466,
      backingChunkId: 6500,
    });

    const cards = extractPaperEvidenceCards({
      feedItemId: samplePaper.id,
      sourceHash: "source-hash",
      sections,
      spans,
    });
    const scaleCard = cards.find((card) =>
      card.claim.includes("355,000 agent tool calls"),
    );

    expect(scaleCard?.claimType).toBe("dataset");
    expect(scaleCard?.numbers).toEqual(
      expect.arrayContaining(["355,000 agent tool calls", "2.7M logged events"]),
    );
  });

  it("rebuilds sections, spans, and cards after refreshing backing chunks", async () => {
    let sectionId = 100;
    const spanId = 500;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("FROM knowledge_chunks")) {
        return Promise.resolve([
          {
            id: 6500,
            chunk_index: 4,
            text: `Section: Dataset\n${samplePaper.full_text}`,
          },
        ]);
      }
      if (template.includes("WITH deleted_cards AS")) {
        return Promise.resolve([
          {
            sections: 4,
            spans: 6,
            cards: 2,
            profiles: 1,
          },
        ]);
      }
      if (template.includes("INSERT INTO paper_sections")) {
        sectionId += 1;
        return Promise.resolve([{ id: sectionId }]);
      }
      if (template.includes("INSERT INTO paper_evidence_spans")) {
        return Promise.resolve(
          Array.from({ length: 1_300 }, (_, index) => ({
            id: spanId + index + 1,
            span_index: index,
          })),
        );
      }
      return Promise.resolve([]);
    });

    const result = await rebuildPaperEvidenceLayerForFeedItem(mockSql as never, samplePaper);

    expect(mockRefreshKnowledgeChunksForFeedItemIfStale).toHaveBeenCalledWith(samplePaper);
    expect(result.skipped).toBe(false);
    expect(result.sections).toBeGreaterThan(0);
    expect(result.spans).toBeGreaterThan(0);
    expect(result.cards).toBeGreaterThan(0);
    expect(result.profiles).toBe(1);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("DELETE FROM paper_evidence_cards"),
      ),
    ).toBe(true);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("DELETE FROM paper_sections"),
      ),
    ).toBe(true);
  });

  it("validates drafts before deleting existing evidence", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("FROM knowledge_chunks")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await expect(
      rebuildPaperEvidenceLayerForFeedItem(mockSql as never, {
        ...samplePaper,
        content: "Too short.",
        full_text: null,
        full_text_source: null,
      }),
    ).rejects.toThrow("paper evidence draft has no spans");

    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("DELETE FROM paper_evidence_cards"),
      ),
    ).toBe(false);
    expect(
      mockSql.mock.calls.some((call) =>
        call[0].join(" ").includes("DELETE FROM paper_sections"),
      ),
    ).toBe(false);
  });

  it("publishes replacement evidence and profile in one atomic statement", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("FROM knowledge_chunks")) {
        return Promise.resolve([
          {
            id: 6500,
            chunk_index: 4,
            text: `Section: Dataset\n${samplePaper.full_text}`,
          },
        ]);
      }
      if (template.includes("WITH deleted_cards AS")) {
        return Promise.reject(new Error("insert failed"));
      }
      return Promise.resolve([]);
    });

    await expect(
      rebuildPaperEvidenceLayerForFeedItem(mockSql as never, samplePaper),
    ).rejects.toThrow("insert failed");

    const mutatingCalls = mockSql.mock.calls
      .map((call) => call[0].join(" "))
      .filter((template) => template.match(/\b(DELETE|INSERT|UPDATE)\b/));
    expect(mutatingCalls).toHaveLength(1);
    expect(mutatingCalls[0]).toContain("DELETE FROM paper_evidence_cards");
    expect(mutatingCalls[0]).toContain("INSERT INTO paper_sections");
    expect(mutatingCalls[0]).toContain("INSERT INTO paper_reader_profiles");
    expect(mutatingCalls[0]).toContain("deletion_barrier");
    expect(mutatingCalls[0]).toContain("CROSS JOIN deletion_barrier");
    expect(mutatingCalls[0]).toContain("jsonb_to_recordset");
    expect(mutatingCalls[0]).not.toContain("::text[][]");
  });

  it("ranks exact evidence phrases above broad same-paper spans", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 6500,
        feed_item_id: 5466,
        chunk_index: 4,
        title: "SWE-chat",
        author_name: "Research Team",
        published_at: null,
        url: "https://example.com/swe-chat",
        span_id: 11,
        card_id: null,
        section_path: ["Dataset"],
        span_type: "sentence",
        claim_type: null,
        snippet: "SWE-chat studies real developer interactions with coding agents.",
        text: "SWE-chat studies real developer interactions with coding agents.",
        entities: ["SWE-chat"],
        methods: [],
        datasets: ["coding agents"],
        metrics: [],
        numbers: [],
        aliases: ["SWE-chat"],
        sql_score: 8,
        evidence_rank: 1,
        fallback_chunk_id: 6500,
      },
      {
        id: 6498,
        feed_item_id: 5466,
        chunk_index: 3,
        title: "SWE-chat",
        author_name: "Research Team",
        published_at: null,
        url: "https://example.com/swe-chat",
        span_id: 12,
        card_id: 77,
        section_path: ["Dataset"],
        span_type: "sentence",
        claim_type: "dataset",
        snippet:
          "SWE-chat contains 6,000 coding sessions, 63,000 user prompts, 355,000 agent tool calls, and 2.7M logged events.",
        text:
          "SWE-chat contains 6,000 coding sessions, 63,000 user prompts, 355,000 agent tool calls, and 2.7M logged events.",
        entities: ["SWE-chat"],
        methods: [],
        datasets: ["coding sessions", "agent tool calls"],
        metrics: [],
        numbers: ["355,000 agent tool calls", "2.7M logged events"],
        aliases: ["SWE-chat"],
        sql_score: 4,
        evidence_rank: 2,
        fallback_chunk_id: 6498,
      },
    ]);

    const rows = await queryPaperEvidenceLayerRows({
      query: "What scale did SWE-chat use for real users?",
      feedItemIds: [5466],
      paperCorpusScope: "default",
      after: null,
      before: null,
      limitPerItem: 2,
      exactEvidencePhrases: ["355,000 agent tool calls"],
    });

    expect(rows[0].id).toBe(6498);
    expect(rows[0].snippet).toContain("355,000 agent tool calls");
    expect(rows[0].paper_evidence).toMatchObject({
      span_id: 12,
      card_id: 77,
      claim_type: "dataset",
      numbers: expect.arrayContaining(["355,000 agent tool calls"]),
    });
  });

  it("keeps FTS-only SQL section bonus as inline numeric literals", async () => {
    // The hybrid SQL path casts parameterized section bonuses. This FTS-only
    // path uses inline numeric literals, so it should stay cast-free unless the
    // bonuses become bound parameters here too.
    mockSql.mockResolvedValueOnce([]);

    await queryPaperEvidenceLayerRows({
      query: "any",
      feedItemIds: [1],
      paperCorpusScope: "default",
      after: null,
      before: null,
      limitPerItem: 1,
    });

    const template = (mockSql.mock.calls[0][0] as TemplateStringsArray).join(
      " ",
    );
    expect(template).toMatch(/WHEN 'result' THEN 1\.2/);
    expect(template).toMatch(/WHEN 'method' THEN 1\.0/);
    expect(template).toMatch(/WHEN 'limitation' THEN 0\.9/);
    expect(template).toMatch(/WHEN 'abstract' THEN 0\.5/);
    expect(template).not.toMatch(
      /CASE ps\.section_type[\s\S]*?::double precision/,
    );
  });
});
