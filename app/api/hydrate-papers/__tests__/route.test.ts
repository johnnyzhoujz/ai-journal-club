import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));
vi.mock("@/lib/fetchers/paper-full-text", () => ({
  fetchPaperFullTextWithStatus: vi.fn(),
}));
vi.mock("@/lib/paper-corpus-tiering", () => ({
  persistPaperCorpusTierMetadata: vi.fn(),
}));
vi.mock("@/lib/paper-evidence-layer", () => ({
  rebuildPaperEvidenceLayerForFeedItem: vi.fn(),
}));
vi.mock("@/lib/paper-processing-state", () => ({
  claimNextDeterministicPaper: vi.fn(),
  computePaperProcessingSourceHash: vi.fn(),
  markDeterministicProcessingFailed: vi.fn(),
  markDeterministicProcessingSucceeded: vi.fn(),
}));

import { sql } from "@/lib/db";
import { fetchPaperFullTextWithStatus } from "@/lib/fetchers/paper-full-text";
import { persistPaperCorpusTierMetadata } from "@/lib/paper-corpus-tiering";
import { rebuildPaperEvidenceLayerForFeedItem } from "@/lib/paper-evidence-layer";
import {
  claimNextDeterministicPaper,
  computePaperProcessingSourceHash,
  markDeterministicProcessingFailed,
  markDeterministicProcessingSucceeded,
} from "@/lib/paper-processing-state";
import { GET, dynamic, maxDuration } from "../route";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockFetchPaperFullTextWithStatus =
  fetchPaperFullTextWithStatus as unknown as ReturnType<typeof vi.fn>;
const mockPersistPaperCorpusTierMetadata =
  persistPaperCorpusTierMetadata as unknown as ReturnType<typeof vi.fn>;
const mockRebuildPaperEvidenceLayerForFeedItem =
  rebuildPaperEvidenceLayerForFeedItem as unknown as ReturnType<typeof vi.fn>;
const mockClaimNextDeterministicPaper =
  claimNextDeterministicPaper as unknown as ReturnType<typeof vi.fn>;
const mockComputePaperProcessingSourceHash =
  computePaperProcessingSourceHash as unknown as ReturnType<typeof vi.fn>;
const mockMarkDeterministicProcessingFailed =
  markDeterministicProcessingFailed as unknown as ReturnType<typeof vi.fn>;
const mockMarkDeterministicProcessingSucceeded =
  markDeterministicProcessingSucceeded as unknown as ReturnType<typeof vi.fn>;

const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function makeRequest(
  headers?: Record<string, string>,
  url = "http://localhost:3000/api/hydrate-papers",
) {
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    leaseToken: "lease-token",
    state: {
      feed_item_id: 101,
      source_hash: "claim-source-hash",
      deterministic_attempt_count: 0,
    },
    paper: {
      id: 101,
      external_id: "2605.12345",
      source_type: "paper",
      title: "Hydration Paper",
      content: "This abstract reports a benchmark with 500 tasks.",
      url: "https://arxiv.org/abs/2605.12345",
      author_name: "Researcher",
      author_handle: null,
      published_at: "2026-05-21T00:00:00.000Z",
      paper_meta: null,
      full_text: null,
      full_text_source: null,
    },
    ...overrides,
  };
}

describe("GET /api/hydrate-papers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    process.env.CRON_SECRET = "test-secret";
    delete process.env.PAPER_HYDRATE_INTERNAL_DEADLINE_MS;
    mockSql.mockResolvedValue([]);
    mockComputePaperProcessingSourceHash.mockReturnValue("state-hash");
    mockPersistPaperCorpusTierMetadata.mockResolvedValue({ updated: true });
    mockRebuildPaperEvidenceLayerForFeedItem.mockResolvedValue({
      feedItemId: 101,
      sourceHash: "evidence-hash",
      sections: 1,
      spans: 3,
      cards: 1,
      profiles: 1,
      skipped: false,
      chunksRefreshed: true,
    });
    mockMarkDeterministicProcessingSucceeded.mockResolvedValue({});
    mockMarkDeterministicProcessingFailed.mockResolvedValue({
      feedItemId: 101,
      status: "failed",
      attemptCount: 1,
      nextRunAt: new Date("2026-05-22T12:05:00.000Z"),
      dead: false,
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.PAPER_HYDRATE_INTERNAL_DEADLINE_MS;
    delete process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED;
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

  it("claims deterministic work and returns structured counts", async () => {
    process.env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED = "true";
    mockClaimNextDeterministicPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockFetchPaperFullTextWithStatus.mockResolvedValueOnce({
      status: "succeeded",
      fullText: { text: "## Abstract\nFull text with 500 tasks.", source: "arxiv_html" },
    });

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
      fullTextSucceeded: 1,
      fullTextUnavailable: 0,
      deadlineReached: false,
      noWork: true,
      errors: [],
    });
    expect(mockClaimNextDeterministicPaper).toHaveBeenCalledTimes(2);
    expect(mockFetchPaperFullTextWithStatus).toHaveBeenCalledWith("2605.12345");
    expect(mockPersistPaperCorpusTierMetadata).not.toHaveBeenCalled();
    expect(mockRebuildPaperEvidenceLayerForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 101,
        full_text: "## Abstract\nFull text with 500 tasks.",
        full_text_source: "arxiv_html",
      }),
      { refreshChunks: true, extractorMode: "deterministic" },
    );
    expect(mockMarkDeterministicProcessingSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "lease-token",
        sourceHash: "state-hash",
        expectedSourceHash: "claim-source-hash",
        evidenceQuality: "full_text",
        fullTextStatus: "succeeded",
      }),
    );
  });

  it("honors a paper limit without claiming extra work", async () => {
    mockClaimNextDeterministicPaper.mockResolvedValueOnce(claim());
    mockFetchPaperFullTextWithStatus.mockResolvedValueOnce({
      status: "succeeded",
      fullText: { text: "## Abstract\nFull text with 500 tasks.", source: "arxiv_html" },
    });

    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "http://localhost:3000/api/hydrate-papers?limit=1",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      paperLimit: 1,
      limitReached: true,
      claimed: 1,
      succeeded: 1,
      noWork: false,
    });
    expect(mockClaimNextDeterministicPaper).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid paper limits", async () => {
    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "http://localhost:3000/api/hydrate-papers?limit=0",
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "limit must be an integer between 1 and 100",
    });
    expect(mockClaimNextDeterministicPaper).not.toHaveBeenCalled();
  });

  it("respects the internal deadline before claiming more work", async () => {
    process.env.PAPER_HYDRATE_INTERNAL_DEADLINE_MS = "1";

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
    expect(mockClaimNextDeterministicPaper).not.toHaveBeenCalled();
  });

  it("treats full-text unavailable as abstract-based deterministic success", async () => {
    mockClaimNextDeterministicPaper
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    mockFetchPaperFullTextWithStatus.mockResolvedValueOnce({
      status: "unavailable",
      statusCode: 404,
      reason: "full text returned 404",
    });

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
      fullTextUnavailable: 1,
    });
    expect(mockRebuildPaperEvidenceLayerForFeedItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 101,
        full_text: null,
        content: expect.stringContaining("benchmark"),
      }),
      { refreshChunks: true, extractorMode: "deterministic" },
    );
    expect(mockMarkDeterministicProcessingSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fullTextStatus: "unavailable",
        evidenceQuality: "abstract_only",
      }),
    );
  });

  it("increments attempts and schedules retry when deterministic hydration fails", async () => {
    mockClaimNextDeterministicPaper
      .mockResolvedValueOnce(
        claim({
          paper: {
            ...claim().paper,
            full_text: "Existing full text",
            full_text_source: "hf_page",
          },
        }),
      )
      .mockResolvedValueOnce(null);
    mockRebuildPaperEvidenceLayerForFeedItem.mockRejectedValueOnce(
      new Error("build failed"),
    );
    mockMarkDeterministicProcessingFailed.mockResolvedValueOnce({
      feedItemId: 101,
      status: "failed",
      attemptCount: 2,
      nextRunAt: new Date("2026-05-22T12:15:00.000Z"),
      dead: false,
    });

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
      errors: [{ feedItemId: 101, error: "build failed" }],
    });
    expect(mockMarkDeterministicProcessingFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        feedItemId: 101,
        leaseToken: "lease-token",
        fullTextStatus: "succeeded",
      }),
    );
  });

  it("fails deterministic publish validation when the reader profile is empty", async () => {
    mockClaimNextDeterministicPaper
      .mockResolvedValueOnce(
        claim({
          paper: {
            ...claim().paper,
            full_text: "Existing full text with a benchmark result.",
            full_text_source: "hf_page",
          },
        }),
      )
      .mockResolvedValueOnce(null);
    mockRebuildPaperEvidenceLayerForFeedItem.mockResolvedValueOnce({
      feedItemId: 101,
      sourceHash: "evidence-hash",
      sections: 1,
      spans: 3,
      cards: 1,
      profiles: 0,
      skipped: false,
      chunksRefreshed: false,
    });

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(body.errors[0].error).toContain("profiles=0");
    expect(mockMarkDeterministicProcessingSucceeded).not.toHaveBeenCalled();
    expect(mockMarkDeterministicProcessingFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        feedItemId: 101,
        fullTextStatus: "succeeded",
      }),
    );
  });

  it("marks repeated deterministic failure dead", async () => {
    mockClaimNextDeterministicPaper
      .mockResolvedValueOnce(
        claim({
          paper: {
            ...claim().paper,
            full_text: "Existing full text",
            full_text_source: "hf_page",
          },
        }),
      )
      .mockResolvedValueOnce(null);
    mockRebuildPaperEvidenceLayerForFeedItem.mockRejectedValueOnce(
      new Error("still failing"),
    );
    mockMarkDeterministicProcessingFailed.mockResolvedValueOnce({
      feedItemId: 101,
      status: "dead",
      attemptCount: 5,
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
      errors: [{ feedItemId: 101, error: "still failing" }],
    });
  });
});
