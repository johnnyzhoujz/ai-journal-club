import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/digest", () => ({
  fetchSkippedDigestPapers: vi.fn(),
  generateDigestWithMetadata: vi.fn(),
}));

import { GET, dynamic } from "../route";
import { sql } from "@/lib/db";
import {
  fetchSkippedDigestPapers,
  generateDigestWithMetadata,
} from "@/lib/digest";
import type { DigestSkippedPapers } from "@/lib/digest";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockGenerateDigestWithMetadata =
  generateDigestWithMetadata as unknown as ReturnType<typeof vi.fn>;
const mockFetchSkippedDigestPapers =
  fetchSkippedDigestPapers as unknown as ReturnType<typeof vi.fn>;
const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function makeRequest(headers?: Record<string, string>, params?: string) {
  const url = `http://localhost:3000/api/digest${params ? `?${params}` : ""}`;
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

const sampleDigestResult = {
  content: "AI Builders Digest — March 21, 2026\n\nTest content",
  tweetCount: 3,
  podcastCount: 1,
  newsletterCount: 2,
  paperCount: 1,
  itemCount: 7,
  sourceItemIds: [1, 2, 3, 4, 5, 6, 7],
  model: "claude-haiku-4-5-20251001",
  skippedPapers: {
    total: 0,
    ids: [],
    rows: [],
    countsByDeterministicStatus: {},
    countsBySemanticStatus: {},
    pendingIds: [],
    deadIds: [],
  },
};

const emptySkippedPapers: DigestSkippedPapers = sampleDigestResult.skippedPapers;

function generationResult({
  digest = sampleDigestResult,
  skippedPapers = emptySkippedPapers,
}: {
  digest?: typeof sampleDigestResult | null;
  skippedPapers?: DigestSkippedPapers;
} = {}) {
  return { digest, skippedPapers };
}

describe("GET /api/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    process.env.CRON_SECRET = "test-secret";
    mockFetchSkippedDigestPapers.mockResolvedValue(emptySkippedPapers);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  // -- Auth -------------------------------------------------------------------

  it("forces dynamic execution for cron requests", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("does not schedule digest directly through Vercel cron", () => {
    const vercelConfig = JSON.parse(
      readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    expect(vercelConfig.crons ?? []).toEqual([]);
  });

  it("rejects requests without credentials", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects requests with an invalid token", async () => {
    const res = await GET(
      makeRequest({ Authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests using non-Bearer auth", async () => {
    const res = await GET(
      makeRequest({ Authorization: "Basic test-secret" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET env var is not configured", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      makeRequest({ Authorization: "Bearer anything" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("CRON_SECRET");
  });

  it("rejects Bearer undefined when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      makeRequest({ Authorization: "Bearer undefined" }),
    );
    expect(res.status).toBe(500);
  });

  // -- Successful digest -------------------------------------------------------

  it("returns digest content and stores it in database", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(generationResult());
    mockSql.mockResolvedValueOnce([]); // INSERT

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.content).toContain("AI Builders Digest");
    expect(body.item_count).toBe(7);
    expect(body.tweet_count).toBe(3);
    expect(body.podcast_count).toBe(1);
    expect(body.newsletter_count).toBe(2);
    expect(body.paper_count).toBe(1);
    expect(body.model).toBe("claude-haiku-4-5-20251001");

    // Verify INSERT was called
    expect(mockSql).toHaveBeenCalledTimes(1);
    const insertTemplate = mockSql.mock.calls[0][0].join(" ");
    expect(insertTemplate).toContain("INSERT INTO digests");

    const startLog = JSON.parse(String(infoSpy.mock.calls[0][0]));
    const successLog = JSON.parse(String(infoSpy.mock.calls[1][0]));
    expect(startLog).toMatchObject({
      event: "start",
      job: "digest",
      requestPath: "/api/digest",
      requestedModel: null,
    });
    expect(successLog).toMatchObject({
      event: "success",
      job: "digest",
      itemCount: 7,
      tweetCount: 3,
      podcastCount: 1,
      newsletterCount: 2,
      paperCount: 1,
      model: "claude-haiku-4-5-20251001",
    });
    expect(successLog.durationMs).toEqual(expect.any(Number));
  });

  // -- No new content -----------------------------------------------------------

  it("returns 200 with message when no new content available", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(
      generationResult({ digest: null }),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBeDefined();
    expect(body.message).toMatch(/no new content/i);
    // No database INSERT should happen
    expect(mockSql).not.toHaveBeenCalled();

    const successLog = JSON.parse(String(infoSpy.mock.calls[1][0]));
    expect(successLog).toMatchObject({
      event: "success",
      job: "digest",
      status: "no_content",
      itemCount: 0,
      model: null,
    });
  });

  // -- Error handling -----------------------------------------------------------

  it("returns 500 when digest generation fails", async () => {
    mockGenerateDigestWithMetadata.mockRejectedValueOnce(
      new Error("Claude API down"),
    );

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Claude API down");

    const failureLog = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(failureLog).toMatchObject({
      event: "failure",
      job: "digest",
      requestPath: "/api/digest",
      error: "Claude API down",
    });
    expect(failureLog.durationMs).toEqual(expect.any(Number));
  });

  it("returns 500 when database insert fails", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(generationResult());
    mockSql.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  // -- Model override -----------------------------------------------------------

  it("passes model from query param to generateDigest", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(generationResult());
    mockSql.mockResolvedValueOnce([]);

    await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "model=claude-sonnet-4-20250514",
      ),
    );

    expect(mockGenerateDigestWithMetadata).toHaveBeenCalledWith(
      "claude-sonnet-4-20250514",
    );
  });

  // -- Phase D: INSERT values match ---------------------------------------------

  it("passes correct values to the INSERT statement", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(generationResult());
    mockSql.mockResolvedValueOnce([]);

    await GET(makeRequest({ Authorization: "Bearer test-secret" }));

    // Tagged template: mock.calls[0][0] is template strings, rest are interpolated values
    const insertValues = mockSql.mock.calls[0].slice(1).flat();
    expect(insertValues).toContain(sampleDigestResult.content);
    expect(insertValues).toContain(sampleDigestResult.itemCount);
    expect(insertValues).toContain(sampleDigestResult.tweetCount);
    expect(insertValues).toContain(sampleDigestResult.podcastCount);
    expect(insertValues).toContain(sampleDigestResult.newsletterCount);
    expect(insertValues).toContain(sampleDigestResult.paperCount);
    expect(insertValues).toContain(sampleDigestResult.model);
  });

  it("calls generateDigest with undefined when no model query param", async () => {
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(generationResult());
    mockSql.mockResolvedValueOnce([]);

    await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );

    expect(mockGenerateDigestWithMetadata).toHaveBeenCalledWith(undefined);
  });

  it("logs and returns skipped paper state in a structured shape", async () => {
    const skippedPapers = {
      total: 3,
      ids: [10, 11, 12],
      rows: [
        { id: 10, deterministicStatus: "pending", semanticStatus: "pending" },
        { id: 11, deterministicStatus: "dead", semanticStatus: "pending" },
        { id: 12, deterministicStatus: "stale", semanticStatus: "failed" },
      ],
      countsByDeterministicStatus: { pending: 1, dead: 1, stale: 1 },
      countsBySemanticStatus: { pending: 2, failed: 1 },
      pendingIds: [10, 12],
      deadIds: [11],
    };
    mockGenerateDigestWithMetadata.mockResolvedValueOnce(
      generationResult({ skippedPapers }),
    );
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(makeRequest({ Authorization: "Bearer test-secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.skipped_papers).toEqual(skippedPapers);

    const skippedLog = JSON.parse(String(infoSpy.mock.calls[1][0]));
    const successLog = JSON.parse(String(infoSpy.mock.calls[2][0]));
    expect(skippedLog).toMatchObject({
      event: "skipped_papers",
      job: "digest",
      skippedPaperCount: 3,
      skippedPaperIds: [10, 11, 12],
      pendingPaperIds: [10, 12],
      deadPaperIds: [11],
    });
    expect(successLog).toMatchObject({
      event: "success",
      job: "digest",
      skippedPaperCount: 3,
      skippedPaperIds: [10, 11, 12],
      skippedPaperCountsByStatus: { pending: 1, dead: 1, stale: 1 },
    });
  });

  it("blocks digest storage when requireReady finds skipped papers", async () => {
    const skippedPapers = {
      total: 2,
      ids: [20, 21],
      rows: [
        { id: 20, deterministicStatus: "pending", semanticStatus: "pending" },
        { id: 21, deterministicStatus: "failed", semanticStatus: "pending" },
      ],
      countsByDeterministicStatus: { pending: 1, failed: 1 },
      countsBySemanticStatus: { pending: 2 },
      pendingIds: [20, 21],
      deadIds: [],
    };
    mockFetchSkippedDigestPapers.mockResolvedValueOnce(skippedPapers);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }, "requireReady=true"),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.skipped_papers).toEqual(skippedPapers);
    expect(mockGenerateDigestWithMetadata).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
});
