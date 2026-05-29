import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));
vi.mock("@/lib/paper-evidence-layer", () => ({
  preparePaperEvidenceLayerForFeedItem: vi.fn(),
  publishPreparedPaperEvidenceLayer: vi.fn(),
}));
vi.mock("@/lib/paper-processing-state", () => ({
  claimNextSemanticPaper: vi.fn(),
  markSemanticProcessingFailed: vi.fn(),
  markSemanticProcessingSucceeded: vi.fn(),
}));

import { sql } from "@/lib/db";
import {
  preparePaperEvidenceLayerForFeedItem,
  publishPreparedPaperEvidenceLayer,
} from "@/lib/paper-evidence-layer";
import {
  claimNextSemanticPaper,
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
const mockClaimNextSemanticPaper =
  claimNextSemanticPaper as unknown as ReturnType<typeof vi.fn>;
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

describe("GET /api/enrich-papers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    process.env.CRON_SECRET = "test-secret";
    process.env.PAPER_SEMANTIC_ENRICHMENT_ENABLED = "true";
    delete process.env.PAPER_ENRICH_INTERNAL_DEADLINE_MS;
    delete process.env.PAPER_SEMANTIC_LLM_TIMEOUT_MS;
    delete process.env.PAPER_SEMANTIC_MIN_ATTEMPT_MS;
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
      embeddingInputCount: 8,
      embeddingFailedCount: 0,
      llmInputTokens: 123,
      llmOutputTokens: 45,
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
