import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));
vi.mock("@/lib/paper-evidence-layer", () => ({
  embedMissingCurrentSourceSemanticSpans: vi.fn(),
  getCurrentSourceSemanticEvidenceStatus: vi.fn(),
  preparePaperEvidenceLayerForFeedItem: vi.fn(),
  publishPreparedPaperEvidenceLayer: vi.fn(),
}));
vi.mock("@/lib/paper-processing-state", () => ({
  claimNextSemanticPaper: vi.fn(),
  markSemanticEmbeddingPending: vi.fn(),
  markSemanticProcessingFailed: vi.fn(),
  markSemanticProcessingSucceeded: vi.fn(),
}));

import { sql } from "@/lib/db";
import {
  embedMissingCurrentSourceSemanticSpans,
  getCurrentSourceSemanticEvidenceStatus,
  preparePaperEvidenceLayerForFeedItem,
  publishPreparedPaperEvidenceLayer,
} from "@/lib/paper-evidence-layer";
import {
  claimNextSemanticPaper,
  markSemanticEmbeddingPending,
  markSemanticProcessingFailed,
  markSemanticProcessingSucceeded,
} from "@/lib/paper-processing-state";
import {
  GET,
  dynamic,
  maxDuration,
  minimumSemanticClaimTimeRemainingMs,
} from "../route";

const mockPreparePaperEvidenceLayerForFeedItem =
  preparePaperEvidenceLayerForFeedItem as unknown as ReturnType<typeof vi.fn>;
const mockPublishPreparedPaperEvidenceLayer =
  publishPreparedPaperEvidenceLayer as unknown as ReturnType<typeof vi.fn>;
const mockGetCurrentSourceSemanticEvidenceStatus =
  getCurrentSourceSemanticEvidenceStatus as unknown as ReturnType<typeof vi.fn>;
const mockEmbedMissingCurrentSourceSemanticSpans =
  embedMissingCurrentSourceSemanticSpans as unknown as ReturnType<typeof vi.fn>;
const mockClaimNextSemanticPaper =
  claimNextSemanticPaper as unknown as ReturnType<typeof vi.fn>;
const mockMarkSemanticEmbeddingPending =
  markSemanticEmbeddingPending as unknown as ReturnType<typeof vi.fn>;
const mockMarkSemanticProcessingFailed =
  markSemanticProcessingFailed as unknown as ReturnType<typeof vi.fn>;
const mockMarkSemanticProcessingSucceeded =
  markSemanticProcessingSucceeded as unknown as ReturnType<typeof vi.fn>;

const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function makeRequest(
  headers?: Record<string, string>,
  url = "http://localhost:3000/api/enrich-papers",
) {
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    leaseToken: "semantic-lease-token",
    state: {
      feed_item_id: 101,
      source_hash: "claim-source-hash",
      semantic_attempt_count: 0,
      deterministic_status: "succeeded",
      digest_ready: true,
    },
    paper: {
      id: 101,
      external_id: "2605.12345",
      source_type: "paper",
      title: "Semantic Paper",
      content: "This abstract reports a benchmark with 500 tasks.",
      url: "https://arxiv.org/abs/2605.12345",
      author_name: "Researcher",
      author_handle: null,
      published_at: "2026-05-21T00:00:00.000Z",
      paper_meta: null,
      full_text: "Full text reports a benchmark with 500 tasks.",
      full_text_source: "arxiv_html",
    },
    ...overrides,
  };
}

function preparedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    feedItemId: 101,
    sourceHash: "evidence-hash",
    skipped: false,
    chunksRefreshed: false,
    drafts: {
      sourceHash: "evidence-hash",
      sections: [{ stableKey: "section-1" }, { stableKey: "section-2" }],
      spans: Array.from({ length: 8 }, (_, index) => ({ stableKey: `span-${index}` })),
      cards: Array.from({ length: 3 }, (_, index) => ({ stableKey: `card-${index}` })),
      extractorMode: "llm",
      droppedSpans: 1,
      droppedClaims: 2,
      droppedAnchors: 0,
      llmInputTokens: 123,
      llmOutputTokens: 45,
    },
    ...overrides,
  };
}

function semanticEvidenceStatus(overrides: Record<string, unknown> = {}) {
  return {
    feedItemId: 101,
    sourceHash: "evidence-hash",
    sectionCount: 2,
    semanticSpanCount: 8,
    cardCount: 3,
    profileCount: 1,
    missingEmbeddingCount: 0,
    hasSemanticEvidence: true,
    embeddingsComplete: true,
    ...overrides,
  };
}

function noSemanticEvidence() {
  return semanticEvidenceStatus({
    sectionCount: 0,
    semanticSpanCount: 0,
    cardCount: 0,
    profileCount: 0,
    missingEmbeddingCount: 0,
    hasSemanticEvidence: false,
    embeddingsComplete: false,
  });
}

describe("GET /api/enrich-papers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    mockGetCurrentSourceSemanticEvidenceStatus.mockReset();
    mockEmbedMissingCurrentSourceSemanticSpans.mockReset();
    mockPreparePaperEvidenceLayerForFeedItem.mockReset();
    mockPublishPreparedPaperEvidenceLayer.mockReset();
    mockClaimNextSemanticPaper.mockReset();
    mockMarkSemanticEmbeddingPending.mockReset();
    mockMarkSemanticProcessingFailed.mockReset();
    mockMarkSemanticProcessingSucceeded.mockReset();
    process.env.CRON_SECRET = "test-secret";
    process.env.PAPER_SEMANTIC_ENRICHMENT_ENABLED = "true";
    delete process.env.PAPER_ENRICH_INTERNAL_DEADLINE_MS;
    delete process.env.PAPER_SEMANTIC_LLM_TIMEOUT_MS;
    delete process.env.PAPER_SEMANTIC_MIN_ATTEMPT_MS;
    mockGetCurrentSourceSemanticEvidenceStatus
      .mockResolvedValueOnce(noSemanticEvidence())
      .mockResolvedValue(semanticEvidenceStatus({
        missingEmbeddingCount: 8,
        embeddingsComplete: false,
      }));
    mockEmbedMissingCurrentSourceSemanticSpans.mockResolvedValue(
      semanticEvidenceStatus({
        embeddingInputCount: 8,
        embeddingFailedCount: 0,
        embeddingIncomplete: false,
      }),
    );
    mockPreparePaperEvidenceLayerForFeedItem.mockResolvedValue(preparedEvidence());
    mockPublishPreparedPaperEvidenceLayer.mockResolvedValue({
      feedItemId: 101,
      sourceHash: "evidence-hash",
      sections: 2,
      spans: 8,
      cards: 3,
      profiles: 1,
      skipped: false,
      chunksRefreshed: false,
      droppedSpans: 1,
      droppedClaims: 2,
      droppedAnchors: 0,
      embeddingInputCount: 0,
      embeddingFailedCount: 0,
      embeddingIncomplete: true,
      llmInputTokens: 123,
      llmOutputTokens: 45,
    });
    mockMarkSemanticEmbeddingPending.mockResolvedValue({
      semantic_status: "pending",
      digest_ready: false,
      semantic_attempt_count: 0,
      semantic_next_run_at: "2026-05-22T12:00:00.000Z",
      semantic_last_error: "semantic embeddings pending",
    });
    mockMarkSemanticProcessingSucceeded.mockResolvedValue({
      semantic_status: "succeeded",
      digest_ready: true,
      semantic_next_run_at: "2026-05-22T12:00:00.000Z",
      semantic_last_error: null,
    });
    mockMarkSemanticProcessingFailed.mockResolvedValue({
      feedItemId: 101,
      status: "failed",
      attemptCount: 1,
      nextRunAt: new Date("2026-05-22T12:05:00.000Z"),
      dead: false,
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.PAPER_SEMANTIC_ENRICHMENT_ENABLED;
    delete process.env.PAPER_ENRICH_INTERNAL_DEADLINE_MS;
    delete process.env.PAPER_SEMANTIC_LLM_TIMEOUT_MS;
    delete process.env.PAPER_SEMANTIC_MIN_ATTEMPT_MS;
  });

  it("forces dynamic execution with a 300 second cap", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(300);
  });

  it("rejects requests without cron credentials", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
  });

  it("rejects requests with invalid cron credentials", async () => {
    const res = await GET(
      makeRequest({ Authorization: "Bearer wrong-token" }),
    );

    expect(res.status).toBe(401);
  });

  it("returns skipped disabled response without claiming work", async () => {
    process.env.PAPER_SEMANTIC_ENRICHMENT_ENABLED = "false";

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: false,
      skipped: true,
      skipReason: "disabled",
      claimed: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    });
    expect(mockClaimNextSemanticPaper).not.toHaveBeenCalled();
    expect(mockPreparePaperEvidenceLayerForFeedItem).not.toHaveBeenCalled();
    expect(mockPublishPreparedPaperEvidenceLayer).not.toHaveBeenCalled();
  });

  it("publishes valid semantic output and marks semantic success", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      claimed: 1,
      succeeded: 1,
      failed: 0,
      dead: 0,
      droppedSpans: 1,
      droppedClaims: 2,
      embeddingInputCount: 8,
      llmInputTokens: 123,
      llmOutputTokens: 45,
      noWork: true,
    });
    expect(mockClaimNextSemanticPaper).toHaveBeenCalledTimes(2);
    expect(mockPreparePaperEvidenceLayerForFeedItem).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        id: 101,
        full_text: "Full text reports a benchmark with 500 tasks.",
      }),
      expect.objectContaining({
        refreshChunks: false,
        extractorMode: "llm",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockPublishPreparedPaperEvidenceLayer).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        drafts: expect.objectContaining({
          sourceHash: "evidence-hash",
        }),
      }),
      { embedSpans: false },
    );
    expect(mockEmbedMissingCurrentSourceSemanticSpans).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ id: 101 }),
    );
    expect(mockMarkSemanticProcessingSucceeded).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "semantic-lease-token",
        expectedSourceHash: "claim-source-hash",
      }),
    );
  });

  it("reports semantic finalization retry as failure, not success", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockMarkSemanticProcessingSucceeded.mockResolvedValueOnce({
      semantic_status: "failed",
      digest_ready: false,
      semantic_attempt_count: 1,
      semantic_next_run_at: "2026-05-22T12:05:00.000Z",
      semantic_last_error: "finalize failed",
    });

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 0,
      errors: [{ feedItemId: 101, error: "finalize failed" }],
      noWork: true,
    });
    expect(mockPublishPreparedPaperEvidenceLayer).toHaveBeenCalledTimes(1);
    expect(mockMarkSemanticProcessingFailed).not.toHaveBeenCalled();
  });

  it("reports semantic finalization dead-letter as dead", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockMarkSemanticProcessingSucceeded.mockResolvedValueOnce({
      semantic_status: "dead",
      digest_ready: false,
      semantic_attempt_count: 3,
      semantic_next_run_at: "2026-05-22T12:00:00.000Z",
      semantic_last_error: "finalize failed",
    });

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      claimed: 1,
      succeeded: 0,
      failed: 0,
      dead: 1,
      errors: [{ feedItemId: 101, error: "finalize failed" }],
      noWork: true,
    });
    expect(mockPublishPreparedPaperEvidenceLayer).toHaveBeenCalledTimes(1);
    expect(mockMarkSemanticProcessingFailed).not.toHaveBeenCalled();
  });

  it("honors a paper limit without claiming extra semantic work", async () => {
    mockClaimNextSemanticPaper.mockResolvedValueOnce(claim());

    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "http://localhost:3000/api/enrich-papers?limit=1",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      paperLimit: 1,
      limitReached: true,
      claimed: 1,
      succeeded: 1,
      noWork: false,
    });
    expect(mockClaimNextSemanticPaper).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid semantic paper limits", async () => {
    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "http://localhost:3000/api/enrich-papers?limit=101",
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "limit must be an integer between 1 and 100",
    });
    expect(mockClaimNextSemanticPaper).not.toHaveBeenCalled();
  });

  it("rejects invalid semantic output and schedules retry", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockPreparePaperEvidenceLayerForFeedItem.mockResolvedValueOnce(
      preparedEvidence({
        drafts: {
          ...preparedEvidence().drafts,
          cards: [],
        },
      }),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 0,
    });
    expect(body.errors[0].error).toContain("insufficient rows");
    expect(mockPublishPreparedPaperEvidenceLayer).not.toHaveBeenCalled();
    expect(mockMarkSemanticProcessingSucceeded).not.toHaveBeenCalled();
    expect(mockMarkSemanticProcessingFailed).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "semantic-lease-token",
      }),
    );
  });

  it("schedules retry when semantic LLM extraction times out", async () => {
    process.env.PAPER_SEMANTIC_LLM_TIMEOUT_MS = "1";
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockPreparePaperEvidenceLayerForFeedItem.mockReturnValueOnce(
      new Promise(() => {}),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 0,
    });
    expect(body.errors[0].error).toContain("timed out");
    expect(mockPublishPreparedPaperEvidenceLayer).not.toHaveBeenCalled();
    expect(mockMarkSemanticProcessingFailed).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "semantic-lease-token",
        error: expect.any(Error),
      }),
    );
  });

  it("parks published semantic evidence when embedding budget is tight", async () => {
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    mockClaimNextSemanticPaper.mockResolvedValueOnce(claim());
    mockGetCurrentSourceSemanticEvidenceStatus
      .mockReset()
      .mockResolvedValueOnce(noSemanticEvidence())
      .mockResolvedValueOnce(semanticEvidenceStatus({
        missingEmbeddingCount: 8,
        embeddingsComplete: false,
      }));
    mockPreparePaperEvidenceLayerForFeedItem.mockImplementationOnce(async () => {
      now = 240_000;
      return preparedEvidence();
    });

    try {
      const res = await GET(
        makeRequest({ Authorization: "Bearer test-secret" }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        claimed: 1,
        succeeded: 0,
        failed: 0,
        dead: 0,
        deadlineReached: true,
        embeddingInputCount: 0,
        embeddingFailedCount: 0,
        errors: [],
      });
      expect(mockPublishPreparedPaperEvidenceLayer).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({ feedItemId: 101 }),
        { embedSpans: false },
      );
      expect(mockMarkSemanticEmbeddingPending).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          feedItemId: 101,
          leaseToken: "semantic-lease-token",
          expectedSourceHash: "claim-source-hash",
          reason: "semantic embeddings pending",
        }),
      );
      expect(mockMarkSemanticProcessingSucceeded).not.toHaveBeenCalled();
      expect(mockMarkSemanticProcessingFailed).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("backs off when semantic span embeddings fail", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockEmbedMissingCurrentSourceSemanticSpans.mockResolvedValueOnce(
      semanticEvidenceStatus({
        missingEmbeddingCount: 2,
        embeddingsComplete: false,
        embeddingInputCount: 8,
        embeddingFailedCount: 2,
        embeddingIncomplete: true,
      }),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      dead: 0,
      errors: [{
        feedItemId: 101,
        error: "semantic span embedding failed for feed_item_id=101; failed=2",
      }],
      embeddingInputCount: 8,
      embeddingFailedCount: 2,
    });
    expect(mockMarkSemanticProcessingSucceeded).not.toHaveBeenCalled();
    expect(mockMarkSemanticEmbeddingPending).not.toHaveBeenCalled();
    expect(mockMarkSemanticProcessingFailed).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "semantic-lease-token",
        error: expect.any(Error),
      }),
    );
  });

  it("resumes existing current-source semantic embeddings without regenerating LLM evidence", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockGetCurrentSourceSemanticEvidenceStatus.mockReset().mockResolvedValueOnce(
      semanticEvidenceStatus({
        missingEmbeddingCount: 4,
        embeddingsComplete: false,
      }),
    );
    mockEmbedMissingCurrentSourceSemanticSpans.mockResolvedValueOnce(
      semanticEvidenceStatus({
        missingEmbeddingCount: 0,
        embeddingsComplete: true,
        embeddingInputCount: 4,
        embeddingFailedCount: 0,
        embeddingIncomplete: false,
      }),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      dead: 0,
      embeddingInputCount: 4,
      noWork: true,
    });
    expect(mockPreparePaperEvidenceLayerForFeedItem).not.toHaveBeenCalled();
    expect(mockPublishPreparedPaperEvidenceLayer).not.toHaveBeenCalled();
    expect(mockEmbedMissingCurrentSourceSemanticSpans).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ id: 101 }),
    );
    expect(mockMarkSemanticProcessingSucceeded).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "semantic-lease-token",
      }),
    );
  });

  it("does not start semantic publish when finalization budget is exhausted", async () => {
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    mockClaimNextSemanticPaper.mockResolvedValueOnce(claim());
    mockPreparePaperEvidenceLayerForFeedItem.mockImplementationOnce(async () => {
      now = 265_000;
      return preparedEvidence();
    });

    try {
      const res = await GET(
        makeRequest({ Authorization: "Bearer test-secret" }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        claimed: 1,
        succeeded: 0,
        failed: 1,
        dead: 0,
        deadlineReached: true,
      });
      expect(body.errors[0].error).toContain("semantic publish skipped");
      expect(mockPublishPreparedPaperEvidenceLayer).not.toHaveBeenCalled();
      expect(mockMarkSemanticProcessingFailed).toHaveBeenCalledWith(
        sql,
        expect.objectContaining({
          feedItemId: 101,
          leaseToken: "semantic-lease-token",
          error: expect.any(Error),
        }),
      );
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("marks repeated semantic failure dead", async () => {
    mockClaimNextSemanticPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockPreparePaperEvidenceLayerForFeedItem.mockRejectedValueOnce(
      new Error("LLM still failing"),
    );
    mockMarkSemanticProcessingFailed.mockResolvedValueOnce({
      feedItemId: 101,
      status: "dead",
      attemptCount: 3,
      nextRunAt: null,
      dead: true,
    });

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 0,
      dead: 1,
      errors: [{ feedItemId: 101, error: "LLM still failing" }],
    });
  });

  it("respects the internal deadline before claiming more work", async () => {
    process.env.PAPER_ENRICH_INTERNAL_DEADLINE_MS = "1";

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 0,
      succeeded: 0,
      deadlineReached: true,
      noWork: false,
    });
    expect(mockClaimNextSemanticPaper).not.toHaveBeenCalled();
  });

  it("requires enough remaining time for a meaningful semantic attempt", () => {
    expect(
      minimumSemanticClaimTimeRemainingMs({
        llmTimeoutMs: 250_000,
        minSemanticAttemptMs: 120_000,
      }),
    ).toBe(150_000);

    expect(
      minimumSemanticClaimTimeRemainingMs({
        llmTimeoutMs: 60_000,
        minSemanticAttemptMs: 120_000,
      }),
    ).toBe(90_000);
  });
});
