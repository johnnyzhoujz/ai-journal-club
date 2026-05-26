import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSql,
  mockFormatDigestItemToolResult,
  mockListArchiveItemsForTool,
  mockSearchArchiveForTool,
  mockSearchMemoryForTool,
  mockGetMemoryItemForTool,
  mockIsMemoryReadsEnabled,
  mockClaimHandledCallExecution,
  mockCompleteHandledCall,
  mockFailHandledCall,
  mockGetBriefingSession,
  mockGetHandledCallRecord,
  mockConsumeRateLimit,
  mockDeriveClientIpInfo,
  MockMissingClientIpError,
} = vi.hoisted(() => {
  class MissingClientIpError extends Error {}

  return {
    mockSql: vi.fn(),
    mockFormatDigestItemToolResult: vi.fn(),
    mockListArchiveItemsForTool: vi.fn(),
    mockSearchArchiveForTool: vi.fn(),
    mockSearchMemoryForTool: vi.fn(),
    mockGetMemoryItemForTool: vi.fn(),
    mockIsMemoryReadsEnabled: vi.fn(),
    mockClaimHandledCallExecution: vi.fn(),
    mockCompleteHandledCall: vi.fn(),
    mockFailHandledCall: vi.fn(),
    mockGetBriefingSession: vi.fn(),
    mockGetHandledCallRecord: vi.fn(),
    mockConsumeRateLimit: vi.fn(),
    mockDeriveClientIpInfo: vi.fn(),
    MockMissingClientIpError: MissingClientIpError,
  };
});

vi.mock("@/lib/db", () => ({
  sql: mockSql,
}));

vi.mock("@/lib/briefing", () => ({
  formatDigestItemToolResult: mockFormatDigestItemToolResult,
}));

vi.mock("@/lib/archive-search", () => ({
  VALID_ARCHIVE_SEARCH_SOURCES: ["all", "tweet", "podcast", "newsletter", "paper"],
  listArchiveItemsForTool: mockListArchiveItemsForTool,
  searchArchiveForTool: mockSearchArchiveForTool,
}));

vi.mock("@/lib/memory-retrieval", () => ({
  SUPPORTED_MEMORY_SEARCH_MODES: ["discovery", "evidence"],
  SUPPORTED_MEMORY_SEARCH_SCOPES: ["all", "chunk"],
  VALID_PAPER_CORPUS_SCOPES: ["default", "latest", "archive", "all"],
  VALID_MEMORY_SEARCH_SOURCES: ["all", "tweet", "podcast", "newsletter", "paper"],
  getMemoryItemForTool: mockGetMemoryItemForTool,
  isMemoryReadsEnabled: mockIsMemoryReadsEnabled,
  normalizeMemorySearchLimit: (limit: number | undefined) => {
    if (!Number.isInteger(limit) || limit == null || limit <= 0) {
      return 4;
    }
    return Math.min(limit, 20);
  },
  searchMemoryForTool: mockSearchMemoryForTool,
}));

vi.mock("@/lib/briefing-session", () => ({
  claimHandledCallExecution: mockClaimHandledCallExecution,
  completeHandledCall: mockCompleteHandledCall,
  failHandledCall: mockFailHandledCall,
  getBriefingSession: mockGetBriefingSession,
  getHandledCallRecord: mockGetHandledCallRecord,
}));

vi.mock("@/lib/rate-limit", () => ({
  DEFAULT_BRIEFING_RATE_LIMITS: {
    call: 5,
    tool: 30,
  },
  MissingClientIpError: MockMissingClientIpError,
  consumeRateLimit: mockConsumeRateLimit,
  deriveClientIpInfo: mockDeriveClientIpInfo,
}));

import {
  POST,
  dynamic,
  maxDuration,
  runtime,
} from "../route";

const openSession = {
  id: "session-1",
  digestId: 42,
  sourceItemIds: [123, 456],
  openaiCallId: "call_123",
  toolCallCount: 0,
  toolCallMax: 12,
  searchArchiveCount: 0,
  searchArchiveMax: 4,
  clientIpHash: "ip_hash_1",
  recommendedEndAt: "2026-04-14T10:10:00.000Z",
  expiresAt: "3026-04-14T11:05:00.000Z",
  closedAt: null,
  hangupAttemptedAt: null,
  hangupSucceededAt: null,
  createdAt: "2026-04-14T10:00:00.000Z",
};

function makeRequest(
  body: unknown = {
    briefingSessionId: "session-1",
    functionCallId: "call_fn_1",
    toolName: "get_digest_item",
    arguments: { item_id: 123 },
  },
): Request {
  return new Request("http://localhost:3000/api/briefing/tool", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/briefing/tool", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();

    mockDeriveClientIpInfo.mockReturnValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockConsumeRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      limit: 30,
      bucket: "2026-04-14T10:00:00.000Z",
      routeKey: "briefing/tool",
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockGetBriefingSession.mockResolvedValue(openSession);
    mockClaimHandledCallExecution.mockResolvedValue({
      disposition: "execute",
      record: {
        attemptCount: 1,
      },
    });
    mockSql.mockResolvedValue([
      {
        id: 123,
        source_type: "tweet",
        title: null,
        content: "tweet content",
        url: "https://example.com/items/123",
        author_name: "Andrej Karpathy",
        author_handle: "karpathy",
        author_bio: null,
        published_at: "2026-04-14T09:00:00Z",
        external_id: "tweet-123",
        source_id: null,
        tweet_meta: null,
        paper_meta: null,
        fetched_at: "2026-04-14T09:05:00Z",
      },
    ]);
    mockFormatDigestItemToolResult.mockReturnValue({
      id: 123,
      source_type: "tweet",
      title: null,
      author_name: "Andrej Karpathy",
      url: "https://example.com/items/123",
      published_at: "2026-04-14T09:00:00Z",
      content_excerpt: "tweet content",
      tweet_meta: null,
      paper_meta: null,
    });
    mockCompleteHandledCall.mockResolvedValue({
      status: "completed",
      budgetSpent: true,
      record: null,
    });
    mockSearchArchiveForTool.mockResolvedValue([
      {
        id: 999,
        source_type: "paper",
        title: "Agents Memory",
        author_name: "Research Team",
        url: "https://example.com/papers/999",
        published_at: "2026-04-10T00:00:00Z",
        snippet: "A plain text snippet about agents and memory.",
      },
    ]);
    mockListArchiveItemsForTool.mockResolvedValue({
      results: [
        {
          id: 321,
          source_type: "tweet",
          title: null,
          author_name: "Aaron Levie",
          author_handle: "levie",
          url: "https://example.com/tweets/321",
          published_at: "2026-04-20T00:00:00Z",
          content_excerpt: "A tweet about agents and software.",
        },
      ],
      total_count: 1,
      returned_count: 1,
      offset: 0,
      has_more: false,
    });
    mockIsMemoryReadsEnabled.mockReturnValue(false);
    mockSearchMemoryForTool.mockResolvedValue({
      query: "agents",
      scope: "all",
      source: "all",
      results: [
        {
          kind: "chunk",
          id: 31,
          feed_item_id: 12,
          source_type: "paper",
          title: "Agents Memory",
          author_name: "Research Team",
          published_at: "2026-04-10T00:00:00Z",
          url: "https://example.com/papers/999",
          snippet: "A plain text memory snippet about agents.",
          entity_labels: ["agents"],
        },
      ],
    });
    mockGetMemoryItemForTool.mockResolvedValue({
      kind: "chunk",
      id: 31,
      feed_item_id: 12,
      source_type: "paper",
      title: "Agents Memory",
      author_name: "Research Team",
      published_at: "2026-04-10T00:00:00Z",
      url: "https://example.com/papers/999",
      text_excerpt: "A bounded excerpt from the memory chunk.",
      entity_labels: ["agents"],
    });
  });

  afterEach(() => {
    consoleError.mockClear();
  });

  it("exports the required runtime configuration", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(15);
  });

  it("returns 400 for an invalid request body", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "unknown_tool",
        arguments: {},
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request_body",
    });
  });

  it("returns 400 in production when the canonical client IP is missing", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    mockDeriveClientIpInfo.mockImplementationOnce(() => {
      throw new MockMissingClientIpError("missing");
    });

    try {
      const response = await POST(makeRequest());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "missing_client_ip",
      });
    } finally {
      env.NODE_ENV = originalEnv;
    }
  });

  it("returns 429 when the per-IP tool rate limit is exhausted", async () => {
    mockConsumeRateLimit.mockResolvedValueOnce({
      allowed: false,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
    });
  });

  it("returns 404 when the briefing session is invalid or closed", async () => {
    mockGetBriefingSession.mockResolvedValueOnce(null);

    const invalidResponse = await POST(makeRequest());
    expect(invalidResponse.status).toBe(404);
    await expect(invalidResponse.json()).resolves.toEqual({
      error: "invalid_session",
    });

    mockGetBriefingSession.mockResolvedValueOnce({
      ...openSession,
      closedAt: "2026-04-14T10:01:00.000Z",
    });

    const closedResponse = await POST(makeRequest());
    expect(closedResponse.status).toBe(404);
    await expect(closedResponse.json()).resolves.toEqual({
      error: "invalid_session",
    });
  });

  it("returns 404 when the caller does not own the briefing session", async () => {
    mockDeriveClientIpInfo.mockReturnValueOnce({
      clientIp: "203.0.113.11",
      clientIpHash: "ip_hash_other",
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_session",
    });
    expect(mockClaimHandledCallExecution).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 410 when the backend session has expired", async () => {
    mockGetBriefingSession.mockResolvedValueOnce({
      ...openSession,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "session_expired",
    });
  });

  it("returns 409 while another worker still holds the handled-call lease", async () => {
    mockClaimHandledCallExecution.mockResolvedValueOnce({
      disposition: "pending",
      record: {
        attemptCount: 1,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "tool_call_in_progress",
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("replays completed handled calls without re-executing the tool", async () => {
    mockClaimHandledCallExecution.mockResolvedValueOnce({
      disposition: "replay",
      record: {
        attemptCount: 1,
        resultPayload: {
          id: 123,
          cached: true,
        },
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_1",
      output: {
        id: 123,
        cached: true,
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCompleteHandledCall).not.toHaveBeenCalled();
  });

  it("returns 400 and marks the handled call failed for invalid tool arguments", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        arguments: {},
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_arguments",
    });
    expect(mockFailHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        attemptCount: 1,
      }),
    );
  });

  it("rejects digest items that are outside the session-owned manifest", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        arguments: { item_id: 999 },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_arguments",
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns bounded get_digest_item output and persists the successful handled call", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_1",
      output: {
        id: 123,
        source_type: "tweet",
        title: null,
        author_name: "Andrej Karpathy",
        url: "https://example.com/items/123",
        published_at: "2026-04-14T09:00:00Z",
        content_excerpt: "tweet content",
        tweet_meta: null,
        paper_meta: null,
      },
    });

    expect(mockSql.mock.calls[0]?.[0].join(" ")).toContain("FROM feed_items");
    expect(mockClaimHandledCallExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        requestArguments: { item_id: 123 },
      }),
    );
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        attemptCount: 1,
        spendBudget: true,
      }),
    );
  });

  it("persists a relayable budget-exhausted payload instead of failing the call", async () => {
    mockCompleteHandledCall
      .mockResolvedValueOnce({
        status: "budget_exhausted",
        budgetSpent: false,
        record: null,
      })
      .mockResolvedValueOnce({
        status: "completed",
        budgetSpent: false,
        record: null,
      });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_1",
      output: {
        error: "tool_budget_exhausted",
        retryable: false,
      },
    });
    expect(mockCompleteHandledCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        spendBudget: false,
        resultPayload: {
          error: "tool_budget_exhausted",
          retryable: false,
        },
      }),
    );
  });

  it("returns a relayable retrieval failure when the lookup throws", async () => {
    mockSql.mockRejectedValueOnce(new Error("db timeout"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_1",
      output: {
        error: "retrieval_failed",
        retryable: true,
      },
    });
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        spendBudget: false,
        resultPayload: {
          error: "retrieval_failed",
          retryable: true,
        },
      }),
    );
  });

  it("executes search_archive with bounded defaults and returns plain-text results", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_2",
        toolName: "search_archive",
        arguments: {
          query: "Karpathy",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_2",
      output: {
        results: [
          {
            id: 999,
            source_type: "paper",
            title: "Agents Memory",
            author_name: "Research Team",
            url: "https://example.com/papers/999",
            published_at: "2026-04-10T00:00:00Z",
            snippet: "A plain text snippet about agents and memory.",
          },
        ],
      },
    });
    expect(mockSearchArchiveForTool).toHaveBeenCalledWith({
      query: "Karpathy",
      source: "all",
      after: null,
      before: null,
      limit: 5,
    });
  });

  it("normalizes exact-title search_archive source when observability is enabled", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalObservability = env.BRIEFING_OBSERVABILITY_ENABLED;
    env.BRIEFING_OBSERVABILITY_ENABLED = "true";
    mockSql
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([
        {
          title: "SAP's AI Strategy",
          source_type: "podcast",
          match_count: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    try {
      const response = await POST(
        makeRequest({
          briefingSessionId: "session-1",
          functionCallId: "call_fn_exact_title",
          toolName: "search_archive",
          arguments: {
            query: "SAP's AI Strategy",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(mockSearchArchiveForTool).toHaveBeenCalledWith({
        query: "SAP's AI Strategy",
        source: "podcast",
        after: null,
        before: null,
        limit: 5,
      });
      expect(
        mockSql.mock.calls.some((call) =>
          call.includes("exact_archive_title_source_inferred"),
        ),
      ).toBe(true);
    } finally {
      env.BRIEFING_OBSERVABILITY_ENABLED = originalObservability;
    }
  });

  it("leaves exact-title search_archive source unchanged when observability is disabled", async () => {
    const env = process.env as Record<string, string | undefined>;
    const originalObservability = env.BRIEFING_OBSERVABILITY_ENABLED;
    delete env.BRIEFING_OBSERVABILITY_ENABLED;

    try {
      const response = await POST(
        makeRequest({
          briefingSessionId: "session-1",
          functionCallId: "call_fn_exact_title_disabled",
          toolName: "search_archive",
          arguments: {
            query: "SAP's AI Strategy",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(mockSearchArchiveForTool).toHaveBeenCalledWith({
        query: "SAP's AI Strategy",
        source: "all",
        after: null,
        before: null,
        limit: 5,
      });
      expect(
        mockSql.mock.calls.some((call) =>
          call.includes("exact_archive_title_source_inferred"),
        ),
      ).toBe(false);
    } finally {
      env.BRIEFING_OBSERVABILITY_ENABLED = originalObservability;
    }
  });

  it("executes list_archive_items with structured filters and a 20 item default", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_2",
        toolName: "list_archive_items",
        arguments: {
          author: "Aaron Levie",
          source: "tweet",
          after: "2026-04-01",
          before: "2026-04-30",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_2",
      output: {
        results: [
          {
            id: 321,
            source_type: "tweet",
            title: null,
            author_name: "Aaron Levie",
            author_handle: "levie",
            url: "https://example.com/tweets/321",
            published_at: "2026-04-20T00:00:00Z",
            content_excerpt: "A tweet about agents and software.",
          },
        ],
        total_count: 1,
        returned_count: 1,
        offset: 0,
        has_more: false,
      },
    });
    expect(mockListArchiveItemsForTool).toHaveBeenCalledWith({
      source: "tweet",
      author: "Aaron Levie",
      after: "2026-04-01",
      before: "2026-04-30",
      limit: 20,
      offset: 0,
    });
  });

  it("rejects memory tools when memory reads are disabled", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_disabled",
        toolName: "search_memory",
        arguments: {
          query: "agents",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request_body",
    });
    expect(mockClaimHandledCallExecution).not.toHaveBeenCalled();
    expect(mockSearchMemoryForTool).not.toHaveBeenCalled();
  });

  it("executes search_memory when enabled and spends search budget", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search",
        toolName: "search_memory",
        arguments: {
          query: "agents",
          limit: 99,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_memory_search",
      output: {
        query: "agents",
        scope: "all",
        source: "all",
        results: [
          {
            kind: "chunk",
            id: 31,
            feed_item_id: 12,
            source_type: "paper",
            title: "Agents Memory",
            author_name: "Research Team",
            published_at: "2026-04-10T00:00:00Z",
            url: "https://example.com/papers/999",
            snippet: "A plain text memory snippet about agents.",
            entity_labels: ["agents"],
          },
        ],
      },
    });
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "agents",
      scope: "all",
      source: "all",
      paperCorpusScope: "default",
      mode: "discovery",
      feedItemIds: [123, 456],
      after: null,
      before: null,
      limit: 20,
    });
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search",
        toolName: "search_memory",
        spendBudget: true,
      }),
    );
  });

  it("forwards search_memory source and date filters when enabled", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search_filtered",
        toolName: "search_memory",
        arguments: {
          query: "agents",
          source: "podcast",
          after: "2026-04-23",
          before: "2026-04-23",
          limit: 2,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "agents",
      scope: "all",
      source: "podcast",
      paperCorpusScope: "default",
      mode: "discovery",
      feedItemIds: [123, 456],
      after: "2026-04-23",
      before: "2026-04-23",
      limit: 2,
    });
  });

  it("allows broader search_memory fallback when currentDigestOnly is false", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search_broader",
        toolName: "search_memory",
        arguments: {
          query: "agents",
          currentDigestOnly: false,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "agents",
      scope: "all",
      source: "all",
      paperCorpusScope: "default",
      mode: "discovery",
      feedItemIds: undefined,
      after: null,
      before: null,
      limit: 4,
    });
  });

  it("defaults paper search_memory calls to evidence mode when mode is omitted", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search_latest_papers",
        toolName: "search_memory",
        arguments: {
          query: "agent evaluation",
          source: "paper",
          paperCorpusScope: "latest",
          limit: 4,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "agent evaluation",
      scope: "all",
      source: "paper",
      paperCorpusScope: "latest",
      mode: "evidence",
      feedItemIds: [123, 456],
      after: null,
      before: null,
      limit: 4,
    });
  });

  it("forwards explicit paper discovery mode when enabled", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search_paper_discovery",
        toolName: "search_memory",
        arguments: {
          query: "agent evaluation",
          source: "paper",
          mode: "discovery",
          paperCorpusScope: "latest",
          limit: 4,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "agent evaluation",
      scope: "all",
      source: "paper",
      paperCorpusScope: "latest",
      mode: "discovery",
      feedItemIds: [123, 456],
      after: null,
      before: null,
      limit: 4,
    });
  });

  it("forwards search_memory evidence mode when enabled", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_search_evidence",
        toolName: "search_memory",
        arguments: {
          query: "Tree of Thoughts score on Game-of-24",
          source: "paper",
          mode: "evidence",
          limit: 4,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockSearchMemoryForTool).toHaveBeenCalledWith({
      query: "Tree of Thoughts score on Game-of-24",
      scope: "all",
      source: "paper",
      paperCorpusScope: "default",
      mode: "evidence",
      feedItemIds: [123, 456],
      after: null,
      before: null,
      limit: 4,
    });
  });

  it("executes get_memory_item when enabled and persists success", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);
    mockSql.mockResolvedValueOnce([
      {
        result_payload: JSON.stringify({
          results: [{ kind: "chunk", id: 31 }],
        }),
      },
    ]);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_item",
        toolName: "get_memory_item",
        arguments: {
          memory_kind: "chunk",
          memory_id: 31,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_memory_item",
      output: {
        kind: "chunk",
        id: 31,
        feed_item_id: 12,
        source_type: "paper",
        title: "Agents Memory",
        author_name: "Research Team",
        published_at: "2026-04-10T00:00:00Z",
        url: "https://example.com/papers/999",
        text_excerpt: "A bounded excerpt from the memory chunk.",
        entity_labels: ["agents"],
      },
    });
    expect(mockGetMemoryItemForTool).toHaveBeenCalledWith({
      memoryKind: "chunk",
      memoryId: 31,
    });
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_memory_item",
        spendBudget: true,
      }),
    );
  });

  it("blocks get_memory_item ids that did not come from search_memory", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);
    mockSql.mockResolvedValueOnce([
      {
        result_payload: JSON.stringify({
          results: [{ kind: "chunk", id: 7633 }],
        }),
      },
    ]);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_item_bad_id",
        toolName: "get_memory_item",
        arguments: {
          memory_kind: "chunk",
          memory_id: 5694,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_memory_item_bad_id",
      output: {
        error: "memory_item_requires_search_memory_result",
        retryable: true,
        guidance:
          "Call search_memory first and pass a chunk id from its results. Do not use digest item ids or archive feed item ids as memory_id.",
      },
    });
    expect(mockGetMemoryItemForTool).not.toHaveBeenCalled();
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_memory_item",
        spendBudget: false,
      }),
    );
  });

  it("returns retrieval_failed when a memory chunk is missing", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);
    mockGetMemoryItemForTool.mockResolvedValueOnce(null);
    mockSql.mockResolvedValueOnce([
      {
        result_payload: JSON.stringify({
          results: [{ kind: "chunk", id: 999 }],
        }),
      },
    ]);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_missing",
        toolName: "get_memory_item",
        arguments: {
          memory_kind: "chunk",
          memory_id: 999,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      functionCallId: "call_fn_memory_missing",
      output: {
        error: "retrieval_failed",
        retryable: true,
      },
    });
    expect(mockCompleteHandledCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_memory_item",
        spendBudget: false,
      }),
    );
  });

  it("rejects note-scoped memory search until notes exist", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_note_scope",
        toolName: "search_memory",
        arguments: {
          query: "agents",
          scope: "note",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_arguments",
    });
  });

  it("rejects note memory item lookups until notes exist", async () => {
    mockIsMemoryReadsEnabled.mockReturnValueOnce(true);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        functionCallId: "call_fn_memory_note_item",
        toolName: "get_memory_item",
        arguments: {
          memory_kind: "note",
          memory_id: 7,
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_arguments",
    });
  });
});
