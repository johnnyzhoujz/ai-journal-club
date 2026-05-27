import { describe, expect, it } from "vitest";

import {
  PAPER_CORPUS_ARCHIVE_PRUNE_TABLES,
  buildPaperCorpusArchivePrunePlan,
  buildPaperCorpusReviewItemSnapshots,
  buildPaperCorpusReviewPersistenceSnapshot,
  buildPaperCorpusTierReviewUpdatePayload,
  buildPaperCorpusRefreshReport,
  buildRichEvidencePrunedTierMetadata,
  formatPaperCorpusArchivePrunePlan,
  formatPaperCorpusRefreshReport,
  type PaperCorpusRefreshRow,
  type PaperCorpusStorageFootprint,
  type PaperCorpusStoragePaperFootprint,
} from "@/lib/paper-corpus-refresh";

function row(overrides: Partial<PaperCorpusRefreshRow>): PaperCorpusRefreshRow {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Paper",
    content: overrides.content ?? "agent benchmark evaluation memory retrieval",
    published_at: overrides.published_at ?? "2026-05-01T00:00:00Z",
    corpus_tier: overrides.corpus_tier ?? "archive",
    paper_meta:
      overrides.paper_meta ??
      {
        upvotes: 0,
        numComments: 0,
        githubRepo: null,
        githubStars: null,
        aiSummary: null,
        aiKeywords: null,
        authors: [{ name: "Researcher" }],
      },
    tier_metadata_json: overrides.tier_metadata_json ?? null,
  };
}

function findRecommendation(
  report: ReturnType<typeof buildPaperCorpusRefreshReport>,
  id: number,
) {
  const item = [
    ...report.hotSetRecommendations,
    ...report.coreCanonRecommendations,
    ...report.recentArchiveRecommendations,
    ...report.ignoredRecommendations,
  ].find((recommendation) => recommendation.id === id);
  expect(item).toBeDefined();
  return item!;
}

function storagePaper(
  id: number,
  currentTier: PaperCorpusStoragePaperFootprint["currentTier"],
  tables: PaperCorpusStoragePaperFootprint["tables"],
  title = `Paper ${id}`,
): PaperCorpusStoragePaperFootprint {
  const values = Object.values(tables);
  return {
    id,
    title,
    currentTier,
    rowCount: values.reduce((total, table) => total + (table?.rowCount ?? 0), 0),
    estimatedBytes: values.reduce(
      (total, table) => total + (table?.estimatedBytes ?? 0),
      0,
    ),
    tables,
  };
}

describe("paper corpus refresh report", () => {
  const referenceDate = "2026-05-24T00:00:00Z";

  it("applies freshness decay without using topic matches as scoring points", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 1,
        title: "Fresh topical paper",
        content: "agent benchmark evaluation memory retrieval tool use",
        published_at: "2026-05-14T00:00:00Z",
        corpus_tier: "hot_set",
      }),
      row({
        id: 2,
        title: "Expired topical paper",
        content: "agent benchmark evaluation memory retrieval tool use",
        published_at: "2026-03-01T00:00:00Z",
        corpus_tier: "hot_set",
      }),
    ], referenceDate);

    const fresh = findRecommendation(report, 1);
    const expired = findRecommendation(report, 2);
    expect(fresh.scoreComponents).toEqual({
      freshness: 40,
      popularity: 0,
      growth: 0,
    });
    expect(fresh.score).toBe(40);
    expect(fresh.recommendedTier).toBe("hot_set");
    expect(expired.scoreComponents.freshness).toBe(0);
    expect(expired.score).toBe(0);
    expect(expired.recommendedTier).toBe("archive");
  });

  it("promotes a recent archive candidate on external popularity and treats missing prior snapshots as zero growth", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 10,
        title: "Popular late bloomer",
        published_at: "2026-05-04T00:00:00Z",
        corpus_tier: "archive",
        paper_meta: {
          upvotes: 60,
          numComments: 12,
          githubRepo: "https://github.com/example/popular-paper",
          githubStars: 620,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
      }),
    ], referenceDate);

    const recommendation = findRecommendation(report, 10);
    expect(recommendation.reviewGroup).toBe("recent_archive");
    expect(recommendation.action).toBe("promote");
    expect(recommendation.recommendedTier).toBe("hot_set");
    expect(recommendation.scoreComponents.popularity).toBeGreaterThanOrEqual(45);
    expect(recommendation.scoreComponents.growth).toBe(0);
    expect(recommendation.popularityGrowth.hasPriorSnapshot).toBe(false);
  });

  it("promotes Core Canon papers when popularity grows from a prior snapshot", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 20,
        title: "Growing canon paper",
        published_at: "2026-03-15T00:00:00Z",
        corpus_tier: "core_canon",
        paper_meta: {
          upvotes: 35,
          numComments: 9,
          githubRepo: "https://github.com/example/growing-paper",
          githubStars: 160,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
        tier_metadata_json: {
          signals: {
            popularity: {
              hfUpvotes: 10,
              hfComments: 2,
              githubStars: 30,
              reviewedAt: "2026-05-10T00:00:00Z",
            },
          },
        },
      }),
    ], referenceDate);

    const recommendation = findRecommendation(report, 20);
    expect(recommendation.action).toBe("promote");
    expect(recommendation.recommendedTier).toBe("hot_set");
    expect(recommendation.popularityGrowth).toMatchObject({
      hfUpvotes: 25,
      hfComments: 7,
      githubStars: 130,
      hasPriorSnapshot: true,
    });
    expect(recommendation.scoreComponents.growth).toBeGreaterThanOrEqual(16);
  });

  it("uses saved review popularity snapshots when tier metadata was not mutated", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 21,
        title: "Growing paper from saved review history",
        published_at: "2026-03-15T00:00:00Z",
        corpus_tier: "core_canon",
        paper_meta: {
          upvotes: 35,
          numComments: 9,
          githubRepo: "https://github.com/example/saved-review-growth",
          githubStars: 160,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
        tier_metadata_json: null,
      }),
    ], {
      referenceDate,
      previousPopularityByFeedItemId: new Map([
        [21, {
          hfUpvotes: 10,
          hfComments: 2,
          githubStars: 30,
          githubRepo: "https://github.com/example/saved-review-growth",
          reviewedAt: "2026-05-10T00:00:00Z",
        }],
      ]),
    });

    const recommendation = findRecommendation(report, 21);
    expect(recommendation.popularityGrowth).toMatchObject({
      hfUpvotes: 25,
      hfComments: 7,
      githubStars: 130,
      hasPriorSnapshot: true,
    });
    expect(recommendation.scoreComponents.growth).toBeGreaterThanOrEqual(16);
  });

  it("demotes stale Hot Set papers without popularity or growth", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 30,
        title: "Stale quiet paper",
        published_at: "2025-12-01T00:00:00Z",
        corpus_tier: "hot_set",
      }),
    ], referenceDate);

    const recommendation = findRecommendation(report, 30);
    expect(recommendation.action).toBe("demote");
    expect(recommendation.recommendedTier).toBe("archive");
    expect(recommendation.score).toBe(0);
  });

  it("reviews only recent archive candidates inside the configured lookback", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 40,
        title: "Old archive",
        published_at: "2025-12-01T00:00:00Z",
        corpus_tier: "archive",
      }),
      row({
        id: 41,
        title: "Recent archive",
        published_at: "2026-03-20T00:00:00Z",
        corpus_tier: "archive",
      }),
    ], {
      referenceDate,
      archiveLookbackDays: 90,
    });

    expect(report.totalInputCount).toBe(2);
    expect(report.reviewedCount).toBe(1);
    expect(report.skippedArchiveCount).toBe(1);
    expect(report.recentArchiveRecommendations.map((item) => item.id)).toEqual([41]);
  });

  it("preserves pinned, manualTier, and ignored overrides in recommendations", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 50,
        title: "Pinned old archive",
        published_at: "2025-01-01T00:00:00Z",
        corpus_tier: "archive",
        tier_metadata_json: {
          pinned: true,
        },
      }),
      row({
        id: 51,
        title: "Manual archive despite popularity",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "hot_set",
        paper_meta: {
          upvotes: 100,
          numComments: 20,
          githubRepo: "https://github.com/example/manual",
          githubStars: 1000,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
        tier_metadata_json: {
          manualTier: "archive",
        },
      }),
      row({
        id: 52,
        title: "Ignored paper",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "hot_set",
        tier_metadata_json: {
          ignored: true,
        },
      }),
      row({
        id: 53,
        title: "Ignored tier with stale pin",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "ignored",
        tier_metadata_json: {
          pinned: true,
        },
      }),
    ], referenceDate);

    expect(report.manualOverrideCount).toBe(4);
    expect(findRecommendation(report, 50)).toMatchObject({
      recommendedTier: "hot_set",
      manualOverride: { type: "pinned" },
    });
    expect(findRecommendation(report, 51)).toMatchObject({
      recommendedTier: "archive",
      manualOverride: { type: "manualTier" },
    });
    expect(findRecommendation(report, 52)).toMatchObject({
      recommendedTier: "ignored",
      manualOverride: { type: "ignored" },
    });
    expect(findRecommendation(report, 53)).toMatchObject({
      recommendedTier: "ignored",
      manualOverride: { type: "currentIgnoredTier" },
    });
  });

  it("formats recommendations and storage footprint for operator review", () => {
    const storage: PaperCorpusStorageFootprint = {
      tables: [
        {
          tableName: "paper_evidence_spans",
          totalBytes: 2048,
          tableBytes: 1024,
          indexBytes: 1024,
        },
      ],
      tiers: [
        {
          tableName: "paper_evidence_spans",
          tier: "hot_set",
          rowCount: 10,
          estimatedBytes: 1500,
        },
      ],
      largestPapers: [
        {
          id: 1,
          title: "Large paper",
          currentTier: "hot_set",
          rowCount: 10,
          estimatedBytes: 1500,
          tables: {
            paper_evidence_spans: {
              rowCount: 10,
              estimatedBytes: 1500,
            },
          },
        },
      ],
    };
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 1,
        corpus_tier: "hot_set",
      }),
    ], {
      referenceDate,
      storage,
    });

    const text = formatPaperCorpusRefreshReport(report, { sectionLimit: 5 });
    expect(text).toContain("Paper Corpus Retention Review Report");
    expect(text).toContain("Mode: dry-run/read-only");
    expect(text).toContain("Hot Set recommendations");
    expect(text).toContain("Core Canon recommendations");
    expect(text).toContain("Recent Archive recommendations");
    expect(text).toContain("Storage footprint");
    expect(text).toContain("paper_evidence_spans");
    expect(text).toContain("Largest papers");
  });

  it("builds an archive rich-evidence prune dry-run without mutating rows", () => {
    const rows = [
      row({
        id: 100,
        title: "Eligible archive",
        corpus_tier: "archive",
        tier_metadata_json: {
          retention: {
            selectedAt: "2026-05-01T00:00:00.000Z",
          },
        },
      }),
      row({
        id: 101,
        title: "Archive without rich rows",
        corpus_tier: "archive",
      }),
      row({
        id: 102,
        title: "Hot Set is protected",
        corpus_tier: "hot_set",
      }),
    ];
    const before = JSON.stringify(rows);
    const storageByFeedItemId = new Map([
      [100, storagePaper(100, "archive", {
        feed_items: { rowCount: 1, estimatedBytes: 600 },
        knowledge_chunks: { rowCount: 8, estimatedBytes: 8000 },
        paper_evidence_cards: { rowCount: 2, estimatedBytes: 200 },
        paper_reader_profiles: { rowCount: 1, estimatedBytes: 300 },
        paper_evidence_spans: { rowCount: 4, estimatedBytes: 400 },
        paper_sections: { rowCount: 3, estimatedBytes: 500 },
      }, "Eligible archive")],
      [101, storagePaper(101, "archive", {
        feed_items: { rowCount: 1, estimatedBytes: 600 },
        knowledge_chunks: { rowCount: 4, estimatedBytes: 4000 },
      }, "Archive without rich rows")],
      [102, storagePaper(102, "hot_set", {
        paper_evidence_cards: { rowCount: 1, estimatedBytes: 100 },
      }, "Hot Set is protected")],
    ]);
    const storage: PaperCorpusStorageFootprint = {
      tables: [],
      largestPapers: [],
      tiers: [
        {
          tableName: "paper_evidence_cards",
          tier: "archive",
          rowCount: 2,
          estimatedBytes: 200,
        },
        {
          tableName: "paper_reader_profiles",
          tier: "archive",
          rowCount: 1,
          estimatedBytes: 300,
        },
        {
          tableName: "paper_evidence_spans",
          tier: "archive",
          rowCount: 4,
          estimatedBytes: 400,
        },
        {
          tableName: "paper_sections",
          tier: "archive",
          rowCount: 3,
          estimatedBytes: 500,
        },
        {
          tableName: "knowledge_chunks",
          tier: "archive",
          rowCount: 8,
          estimatedBytes: 8000,
        },
      ],
    };

    const plan = buildPaperCorpusArchivePrunePlan(rows, {
      generatedAt: "2026-05-24T00:00:00.000Z",
      prunedAt: "2026-05-24T01:00:00.000Z",
      storage,
      storageByFeedItemId,
    });

    expect(JSON.stringify(rows)).toBe(before);
    expect(plan.mode).toBe("dry-run");
    expect(plan.candidateIds).toEqual([100]);
    expect(plan.candidateCount).toBe(1);
    expect(plan.rowCount).toBe(10);
    expect(plan.estimatedReclaimableBytes).toBe(1400);
    expect(plan.archiveRichEvidenceEstimatedBytes).toBe(1400);
    expect(plan.estimatedRemainingArchiveRichEvidenceBytes).toBe(0);
    expect(plan.tables.map((table) => table.tableName)).toEqual([
      ...PAPER_CORPUS_ARCHIVE_PRUNE_TABLES,
    ]);
    expect(plan.tables).toEqual([
      { tableName: "paper_evidence_cards", rowCount: 2, estimatedBytes: 200 },
      { tableName: "paper_reader_profiles", rowCount: 1, estimatedBytes: 300 },
      { tableName: "paper_evidence_spans", rowCount: 4, estimatedBytes: 400 },
      { tableName: "paper_sections", rowCount: 3, estimatedBytes: 500 },
    ]);
    expect(plan.candidates[0].tables).not.toHaveProperty("feed_items");
    expect(plan.candidates[0].tables).not.toHaveProperty("knowledge_chunks");
  });

  it("protects non-archive, pending, pinned, manual, ignored, and manually archived papers from pruning", () => {
    const rows = [
      row({ id: 110, title: "Eligible archive", corpus_tier: "archive" }),
      row({ id: 111, title: "Hot Set", corpus_tier: "hot_set" }),
      row({ id: 112, title: "Core Canon", corpus_tier: "core_canon" }),
      row({
        id: 113,
        title: "Pending Hot Set",
        corpus_tier: "archive",
        tier_metadata_json: { retention: { pendingTier: "hot_set" } },
      }),
      row({
        id: 114,
        title: "Pinned archive",
        corpus_tier: "archive",
        tier_metadata_json: { pinned: true },
      }),
      row({
        id: 115,
        title: "Manual Hot Set",
        corpus_tier: "archive",
        tier_metadata_json: { manualTier: "hot_set" },
      }),
      row({
        id: 116,
        title: "Manual Core",
        corpus_tier: "archive",
        tier_metadata_json: { manualTier: "core_canon" },
      }),
      row({
        id: 117,
        title: "Ignored metadata",
        corpus_tier: "archive",
        tier_metadata_json: { ignored: true },
      }),
      row({
        id: 118,
        title: "Manual archive",
        corpus_tier: "archive",
        tier_metadata_json: { manualTier: "archive" },
      }),
      row({ id: 119, title: "Ignored tier", corpus_tier: "ignored" }),
    ];
    const storageByFeedItemId = new Map(
      rows.map((entry) => [
        entry.id,
        storagePaper(entry.id, entry.corpus_tier, {
          paper_evidence_cards: { rowCount: 1, estimatedBytes: 10 },
          paper_reader_profiles: { rowCount: 1, estimatedBytes: 10 },
          paper_evidence_spans: { rowCount: 1, estimatedBytes: 10 },
          paper_sections: { rowCount: 1, estimatedBytes: 10 },
        }, entry.title ?? `Paper ${entry.id}`),
      ]),
    );

    const plan = buildPaperCorpusArchivePrunePlan(rows, { storageByFeedItemId });

    expect(plan.candidateIds).toEqual([110]);
    expect(plan.protectedArchivePapers.map((paper) => [paper.id, paper.reason])).toEqual([
      [113, "pending Hot Set promotion"],
      [114, "tier_metadata_json.pinned=true"],
      [115, "manualTier=hot_set"],
      [116, "manualTier=core_canon"],
      [117, "tier_metadata_json.ignored=true"],
      [118, "manualTier=archive"],
    ]);
  });

  it("marks rich evidence pruning metadata without dropping manual controls", () => {
    const metadata = buildRichEvidencePrunedTierMetadata({
      manualTier: "archive",
      notes: ["operator decision"],
      retention: {
        selectedAt: "2026-05-01T00:00:00.000Z",
        graceDays: 14,
      },
    }, "2026-05-24T12:00:00.000Z");

    expect(metadata).toEqual({
      manualTier: "archive",
      notes: ["operator decision"],
      retention: {
        selectedAt: "2026-05-01T00:00:00.000Z",
        graceDays: 14,
        richEvidencePrunedAt: "2026-05-24T12:00:00.000Z",
      },
    });
  });

  it("formats archive prune row counts, candidate IDs, and storage impact", () => {
    const plan = buildPaperCorpusArchivePrunePlan([
      row({ id: 120, title: "Eligible archive", corpus_tier: "archive" }),
    ], {
      generatedAt: "2026-05-24T00:00:00.000Z",
      prunedAt: "2026-05-24T12:00:00.000Z",
      storageByFeedItemId: new Map([
        [120, storagePaper(120, "archive", {
          paper_evidence_cards: { rowCount: 1, estimatedBytes: 100 },
          paper_reader_profiles: { rowCount: 1, estimatedBytes: 100 },
          paper_evidence_spans: { rowCount: 2, estimatedBytes: 200 },
          paper_sections: { rowCount: 1, estimatedBytes: 100 },
        }, "Eligible archive")],
      ]),
    });

    const text = formatPaperCorpusArchivePrunePlan(plan);

    expect(text).toContain("Archive Rich Evidence Prune Report");
    expect(text).toContain("Mode: dry-run");
    expect(text).toContain("Candidate IDs: 120");
    expect(text).toContain("paper_evidence_cards: rows=1");
    expect(text).toContain("Estimated reclaimable storage: 500 B");
    expect(text).toContain("Feed items, digests, source references, knowledge_chunks");
  });

  it("builds saved review snapshots without applying tier changes", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 60,
        title: "Stale quiet hot set paper",
        published_at: "2025-12-01T00:00:00Z",
        corpus_tier: "hot_set",
      }),
    ], referenceDate);

    const snapshots = buildPaperCorpusReviewItemSnapshots(report, { mode: "saved_review" });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      feedItemId: 60,
      previousTier: "hot_set",
      recommendedTier: "archive",
      appliedTier: "hot_set",
      action: "demote",
      manualOverride: false,
    });
  });

  it("stores review persistence snapshots with score, popularity, manual override, and storage state", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 70,
        title: "Pinned archive",
        published_at: "2025-12-01T00:00:00Z",
        corpus_tier: "archive",
        tier_metadata_json: { pinned: true },
      }),
    ], referenceDate);
    const storage = new Map([
      [70, {
        id: 70,
        title: "Pinned archive",
        currentTier: "archive" as const,
        rowCount: 3,
        estimatedBytes: 1200,
        tables: {
          feed_items: { rowCount: 1, estimatedBytes: 500 },
          paper_sections: { rowCount: 2, estimatedBytes: 700 },
        },
      }],
    ]);

    const snapshot = buildPaperCorpusReviewPersistenceSnapshot(report, {
      mode: "execute_tier_updates",
      storageByFeedItemId: storage,
    });

    expect(snapshot.mode).toBe("execute_tier_updates");
    expect(snapshot.archiveLookbackDays).toBe(90);
    expect(snapshot.summary.reviewedCount).toBe(1);
    expect(snapshot.items[0]).toMatchObject({
      feedItemId: 70,
      previousTier: "archive",
      recommendedTier: "hot_set",
      appliedTier: "archive",
      freshnessScore: 0,
      manualOverride: true,
      manualOverrideType: "pinned",
      storage: {
        rowCount: 3,
        estimatedBytes: 1200,
      },
    });
    expect(snapshot.items[0].reasons).toEqual(
      expect.arrayContaining(["manual override preserved: tier_metadata_json.pinned=true"]),
    );
  });

  it("builds execute-tier update payloads and preserves manual override metadata", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 80,
        title: "Manual archive despite popularity",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "hot_set",
        paper_meta: {
          upvotes: 100,
          numComments: 20,
          githubRepo: "https://github.com/example/manual",
          githubStars: 1000,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
        tier_metadata_json: {
          manualTier: "archive",
          notes: ["keep out of rich retention"],
        },
      }),
    ], referenceDate);
    const recommendation = findRecommendation(report, 80);

    const payload = buildPaperCorpusTierReviewUpdatePayload(recommendation, {
      currentMetadata: {
        manualTier: "archive",
        notes: ["keep out of rich retention"],
      },
      reviewRunId: 123,
      reviewedAt: referenceDate,
    });

    expect(payload.corpus_tier).toBe("archive");
    expect(payload.archive_reason).toContain("manual override preserved");
    expect(payload.hot_set_reason).toBeNull();
    expect(payload.last_scored_at).toBe("2026-05-24T00:00:00.000Z");
    expect(payload.tier_metadata_json).toMatchObject({
      manualTier: "archive",
      notes: ["keep out of rich retention"],
      lastReviewRunId: 123,
      lastReviewAction: "hot_set_to_archive",
      popularity: {
        hfUpvotes: 100,
        hfComments: 20,
        githubStars: 1000,
        reviewedAt: "2026-05-24T00:00:00.000Z",
      },
    });
  });

  it("marks Hot Set promotions pending until rich processing is complete", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 81,
        title: "Popular Hot Set candidate",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "archive",
        paper_meta: {
          upvotes: 80,
          numComments: 14,
          githubRepo: "https://github.com/example/hot-set-candidate",
          githubStars: 850,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
      }),
    ], referenceDate);
    const recommendation = findRecommendation(report, 81);

    const payload = buildPaperCorpusTierReviewUpdatePayload(recommendation, {
      reviewRunId: 124,
      reviewedAt: referenceDate,
    });

    expect(payload.corpus_tier).toBe("archive");
    expect(payload.recommended_tier).toBe("hot_set");
    expect(payload.pending_hot_set_promotion).toBe(true);
    expect(payload.relevance_score).toBe(recommendation.score);
    expect(payload.canon_score).toBeNull();
    expect(payload.hot_set_reason).toContain("strong freshness window");
    expect(payload.canon_reason).toBeNull();
    expect(payload.tier_metadata_json).toMatchObject({
      lastReviewAction: "archive_to_pending_hot_set",
      retention: {
        pendingTier: "hot_set",
        pendingSourceTier: "archive",
        pendingReviewRunId: 124,
        pendingReviewAction: "archive_to_hot_set",
      },
    });
  });

  it("preserves intake pending Hot Set rows during the grace window", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 82,
        title: "Fresh low-signal intake paper",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "archive",
        tier_metadata_json: {
          retention: {
            intakeDefaultTier: "hot_set",
            selectedAt: "2026-05-20T00:00:00.000Z",
            graceDays: 14,
            pendingTier: "hot_set",
            pendingSourceTier: "archive",
            pendingReviewAction: "intake_to_hot_set",
          },
        },
      }),
      row({
        id: 83,
        title: "Expired low-signal intake paper",
        published_at: "2026-05-01T00:00:00Z",
        corpus_tier: "archive",
        tier_metadata_json: {
          retention: {
            intakeDefaultTier: "hot_set",
            selectedAt: "2026-05-01T00:00:00.000Z",
            graceDays: 14,
            pendingTier: "hot_set",
            pendingSourceTier: "archive",
            pendingReviewAction: "intake_to_hot_set",
          },
        },
      }),
    ], referenceDate);
    const freshRecommendation = findRecommendation(report, 82);
    const expiredRecommendation = findRecommendation(report, 83);

    expect(freshRecommendation).toMatchObject({
      currentTier: "archive",
      recommendedTier: "hot_set",
      action: "promote",
    });
    expect(freshRecommendation.reasons).toContain("intake Hot Set grace window preserved");
    expect(expiredRecommendation).toMatchObject({
      currentTier: "archive",
      recommendedTier: "archive",
      action: "keep",
    });

    const freshPayload = buildPaperCorpusTierReviewUpdatePayload(freshRecommendation, {
      currentMetadata: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-20T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "intake_to_hot_set",
          pendingReviewStartedAt: "2026-05-20T00:00:00.000Z",
        },
      },
      reviewRunId: 125,
      reviewedAt: referenceDate,
    });
    const expiredPayload = buildPaperCorpusTierReviewUpdatePayload(expiredRecommendation, {
      currentMetadata: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
        },
      },
      reviewRunId: 126,
      reviewedAt: referenceDate,
    });

    expect(freshPayload).toMatchObject({
      corpus_tier: "archive",
      recommended_tier: "hot_set",
      pending_hot_set_promotion: true,
    });
    expect(freshPayload.tier_metadata_json.retention).toMatchObject({
      pendingTier: "hot_set",
      intakeDefaultTier: "hot_set",
      graceDays: 14,
      pendingReviewAction: "intake_to_hot_set",
      pendingReviewStartedAt: "2026-05-20T00:00:00.000Z",
    });
    expect(expiredPayload.pending_hot_set_promotion).toBe(false);
    expect(expiredPayload.tier_metadata_json.retention?.pendingTier).toBeNull();
  });

  it("keeps directly ingested Hot Set papers in the intake grace window", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 182,
        title: "Fresh direct intake paper",
        published_at: "2026-05-20T00:00:00Z",
        corpus_tier: "hot_set",
        tier_metadata_json: {
          retention: {
            intakeDefaultTier: "hot_set",
            selectedAt: "2026-05-20T00:00:00.000Z",
            graceDays: 14,
          },
        },
      }),
      row({
        id: 183,
        title: "Expired direct intake paper",
        published_at: "2026-05-01T00:00:00Z",
        corpus_tier: "hot_set",
        tier_metadata_json: {
          retention: {
            intakeDefaultTier: "hot_set",
            selectedAt: "2026-05-01T00:00:00.000Z",
            graceDays: 14,
          },
        },
      }),
    ], referenceDate);
    const freshRecommendation = findRecommendation(report, 182);
    const expiredRecommendation = findRecommendation(report, 183);

    expect(freshRecommendation).toMatchObject({
      currentTier: "hot_set",
      recommendedTier: "hot_set",
      action: "keep",
    });
    expect(freshRecommendation.reasons).toContain("intake Hot Set grace window preserved");
    expect(expiredRecommendation).toMatchObject({
      currentTier: "hot_set",
      recommendedTier: "core_canon",
      action: "demote",
    });
  });

  it("records expired intake rows with strong signals as new review promotions", () => {
    const report = buildPaperCorpusRefreshReport([
      row({
        id: 84,
        title: "Expired intake paper with strong signals",
        published_at: "2026-05-01T00:00:00Z",
        corpus_tier: "archive",
        paper_meta: {
          upvotes: 80,
          numComments: 14,
          githubRepo: "https://github.com/example/expired-strong-signal",
          githubStars: 850,
          aiSummary: null,
          aiKeywords: null,
          authors: [{ name: "Researcher" }],
        },
        tier_metadata_json: {
          retention: {
            intakeDefaultTier: "hot_set",
            selectedAt: "2026-05-01T00:00:00.000Z",
            graceDays: 14,
            pendingTier: "hot_set",
            pendingSourceTier: "archive",
            pendingReviewAction: "intake_to_hot_set",
            pendingReviewStartedAt: "2026-05-01T00:00:00.000Z",
          },
        },
      }),
    ], referenceDate);
    const recommendation = findRecommendation(report, 84);

    expect(recommendation).toMatchObject({
      currentTier: "archive",
      recommendedTier: "hot_set",
      action: "promote",
    });
    expect(recommendation.reasons).not.toContain("intake Hot Set grace window preserved");

    const payload = buildPaperCorpusTierReviewUpdatePayload(recommendation, {
      currentMetadata: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "intake_to_hot_set",
          pendingReviewStartedAt: "2026-05-01T00:00:00.000Z",
        },
      },
      reviewRunId: 127,
      reviewedAt: referenceDate,
    });

    expect(payload).toMatchObject({
      corpus_tier: "archive",
      recommended_tier: "hot_set",
      pending_hot_set_promotion: true,
    });
    expect(payload.tier_metadata_json.retention).toMatchObject({
      intakeDefaultTier: "hot_set",
      selectedAt: "2026-05-01T00:00:00.000Z",
      pendingTier: "hot_set",
      pendingReviewRunId: 127,
      pendingReviewAction: "archive_to_hot_set",
      pendingReviewStartedAt: new Date(referenceDate).toISOString(),
    });
  });
});
