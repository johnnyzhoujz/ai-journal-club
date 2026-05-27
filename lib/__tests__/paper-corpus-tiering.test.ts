import { describe, expect, it, vi } from "vitest";

import {
  buildPaperIntakeHotSetPayload,
  buildPaperCorpusTierUpdatePayload,
  persistPaperCorpusTierMetadata,
  scorePaperCorpusTier,
  summarizePaperCorpusTierDecision,
} from "@/lib/paper-corpus-tiering";

const referenceDate = "2026-05-16T00:00:00Z";

describe("paper corpus tiering", () => {
  it("classifies a fresh high-signal paper as hot_set with inspectable reasons", () => {
    const decision = scorePaperCorpusTier({
      title: "Tool-use benchmarks for agentic coding systems",
      content: "We release a benchmark for coding agents, workflows, memory, and retrieval.",
      publishedAt: "2026-05-08T00:00:00Z",
      paperMeta: {
        upvotes: 42,
        numComments: 7,
        githubRepo: "https://github.com/example/tool-use-benchmark",
        githubStars: 150,
        aiSummary: "A benchmark suite for agents and tool use.",
        aiKeywords: ["agents", "benchmark", "tool use"],
        authors: [{ name: "Researcher" }],
      },
      referenceDate,
    });

    expect(decision.tier).toBe("hot_set");
    expect(decision.score).toBeGreaterThanOrEqual(12);
    expect(decision.reasons.map((reason) => reason.code)).toContain("freshness");
    expect(decision.reasons.map((reason) => reason.code)).toContain("provider:github-stars");
    expect(summarizePaperCorpusTierDecision(decision)).toContain("hot_set");
  });

  it("classifies an older low-signal paper as archive", () => {
    const decision = scorePaperCorpusTier({
      title: "A small note on theorem proving",
      content: "An ordinary paper with little actionable signal.",
      publishedAt: "2024-02-01T00:00:00Z",
      paperMeta: {
        upvotes: 1,
        numComments: 0,
        githubRepo: null,
        githubStars: null,
        aiSummary: null,
        aiKeywords: null,
        authors: [{ name: "Researcher" }],
      },
      referenceDate,
    });

    expect(decision.tier).toBe("archive");
    expect(decision.reasons[0].code).toBe("freshness");
    expect(decision.reasons[0].points).toBeLessThanOrEqual(1);
  });

  it("honors manual ignore and pin overrides", () => {
    const ignored = scorePaperCorpusTier({
      title: "High-signal paper",
      content: "Still ignored.",
      publishedAt: "2026-05-08T00:00:00Z",
      tierMetadata: { ignored: true },
      referenceDate,
    });

    const pinned = scorePaperCorpusTier({
      title: "Low-signal paper",
      content: "Should still land in hot set.",
      publishedAt: "2022-01-01T00:00:00Z",
      tierMetadata: { pinned: true },
      referenceDate,
    });

    expect(ignored.tier).toBe("ignored");
    expect(ignored.reasons[0].code).toBe("override:ignored");
    expect(pinned.tier).toBe("hot_set");
    expect(pinned.reasons[0].code).toBe("override:pinned");
  });


  it("persists tier updates with metadata-only SQL", async () => {
    const mockSql = vi.fn().mockResolvedValue([{ id: 99 }]);
    const result = await persistPaperCorpusTierMetadata(mockSql as never, {
      id: 99,
      source_type: "paper",
      title: "Agentic coding benchmark",
      content: "A benchmark for code agents.",
      published_at: "2026-05-08T00:00:00Z",
      paper_meta: {
        upvotes: 25,
        numComments: 3,
        githubRepo: null,
        githubStars: 80,
        aiSummary: "A benchmark suite for agentic coding.",
        aiKeywords: ["agents", "benchmark"],
        authors: [{ name: "Researcher" }],
      },
      tier_metadata_json: { pinned: true },
    }, referenceDate);

    expect(result.updated).toBe(true);
    expect(result.decision.tier).toBe("hot_set");
    expect(mockSql).toHaveBeenCalledTimes(1);
    const sqlTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(sqlTemplate).toContain("UPDATE feed_items");
    expect(sqlTemplate).toContain("corpus_tier");
    expect(sqlTemplate).toContain("tier_metadata_json");
    expect(sqlTemplate).not.toContain("knowledge_chunks");
    expect(sqlTemplate).not.toContain("embedding");
  });

  it("produces metadata-only tier updates", () => {
    const decision = scorePaperCorpusTier({
      title: "Agentic coding benchmark",
      content: "A benchmark for code agents.",
      publishedAt: "2026-05-08T00:00:00Z",
      referenceDate,
    });

    const update = buildPaperCorpusTierUpdatePayload(decision, referenceDate);

    expect(update.corpus_tier).toBe(decision.tier);
    expect(update.last_scored_at).toBe(decision.scoredAt);
    expect(update.tier_metadata_json.scoreVersion).toBe("v1");
    expect(Object.keys(update)).toEqual(
      expect.arrayContaining([
        "corpus_tier",
        "relevance_score",
        "canon_score",
        "hot_set_reason",
        "canon_reason",
        "archive_reason",
        "ignored_reason",
        "last_seen_at",
        "last_scored_at",
        "tier_metadata_json",
      ]),
    );
  });

  it("defaults newly selected intake papers into the Hot Set grace window", () => {
    const payload = buildPaperIntakeHotSetPayload(referenceDate);

    expect(payload.corpus_tier).toBe("hot_set");
    expect(payload.relevance_score).toBeNull();
    expect(payload.canon_score).toBeNull();
    expect(payload.last_scored_at).toBeNull();
    expect(payload.hot_set_reason).toContain("new selected paper grace window");
    expect(payload.archive_reason).toBeNull();
    expect(payload.tier_metadata_json).toMatchObject({
      scoreVersion: "intake-hot-set-v1",
      retention: {
        intakeDefaultTier: "hot_set",
        graceDays: 14,
        selectedAt: "2026-05-16T00:00:00.000Z",
      },
    });
    expect(payload.tier_metadata_json.retention?.pendingTier).toBeUndefined();
  });
});
