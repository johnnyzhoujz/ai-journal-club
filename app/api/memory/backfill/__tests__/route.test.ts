import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/memory-chunks", () => ({
  backfillKnowledgeChunks: vi.fn(),
  isMemoryChunkBackfillEnabled: vi.fn(),
}));

import { GET, dynamic } from "../route";
import {
  backfillKnowledgeChunks,
  isMemoryChunkBackfillEnabled,
} from "@/lib/memory-chunks";

const mockBackfillKnowledgeChunks =
  backfillKnowledgeChunks as unknown as ReturnType<typeof vi.fn>;
const mockIsMemoryChunkBackfillEnabled =
  isMemoryChunkBackfillEnabled as unknown as ReturnType<typeof vi.fn>;
const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function makeRequest(headers?: Record<string, string>, params?: string) {
  const url = `http://localhost:3000/api/memory/backfill${params ? `?${params}` : ""}`;
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

describe("GET /api/memory/backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy.mockClear();
    errorSpy.mockClear();
    process.env.CRON_SECRET = "test-secret";
  });

  it("forces dynamic execution for cron requests", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("rejects unauthorized requests", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockBackfillKnowledgeChunks).not.toHaveBeenCalled();
  });

  it("returns disabled without touching the database when the flag is off", async () => {
    mockIsMemoryChunkBackfillEnabled.mockReturnValueOnce(false);

    const res = await GET(
      makeRequest({ Authorization: "Bearer test-secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: false,
      featureFlag: "MEMORY_CHUNK_BACKFILL_ENABLED",
    });
    expect(mockBackfillKnowledgeChunks).not.toHaveBeenCalled();
  });

  it("parses bounded backfill options when enabled", async () => {
    mockIsMemoryChunkBackfillEnabled.mockReturnValueOnce(true);
    mockBackfillKnowledgeChunks.mockResolvedValueOnce({
      selectedItemCount: 2,
      upsertedChunkCount: 3,
      skippedItemCount: 0,
      failedItemCount: 0,
      lastFeedItemId: 12,
      errors: [],
    });

    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "limit=12&afterId=4&beforeId=20&feedItemId=10&maxChunksPerItem=5&refresh=true",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      selectedItemCount: 2,
      upsertedChunkCount: 3,
    });
    expect(mockBackfillKnowledgeChunks).toHaveBeenCalledWith({
      limit: 12,
      afterId: 4,
      beforeId: 20,
      feedItemId: 10,
      maxChunksPerItem: 5,
      refreshExisting: true,
    });
  });

  it("rejects invalid integer query params before running backfill", async () => {
    mockIsMemoryChunkBackfillEnabled.mockReturnValueOnce(true);

    const res = await GET(
      makeRequest(
        { Authorization: "Bearer test-secret" },
        "limit=not-a-number",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("limit");
    expect(mockBackfillKnowledgeChunks).not.toHaveBeenCalled();
  });
});
