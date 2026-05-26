import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSql,
  mockGetBriefingSourceItems,
  mockBuildBriefingPromptPayload,
  mockBuildPromptTokenCountRepresentation,
  mockEstimatePromptTokens,
  mockCreateBriefingSession,
  mockCountActiveBriefingSessions,
  mockConsumeRateLimit,
  mockDeriveClientIpInfo,
  mockFetch,
  MockMissingClientIpError,
} = vi.hoisted(() => {
  class MissingClientIpError extends Error {}

  return {
    mockSql: vi.fn(),
    mockGetBriefingSourceItems: vi.fn(),
    mockBuildBriefingPromptPayload: vi.fn(),
    mockBuildPromptTokenCountRepresentation: vi.fn(),
    mockEstimatePromptTokens: vi.fn(),
    mockCreateBriefingSession: vi.fn(),
    mockCountActiveBriefingSessions: vi.fn(),
    mockConsumeRateLimit: vi.fn(),
    mockDeriveClientIpInfo: vi.fn(),
    mockFetch: vi.fn(),
    MockMissingClientIpError: MissingClientIpError,
  };
});

vi.mock("@/lib/db", () => ({
  sql: mockSql,
}));

vi.mock("@/lib/briefing", () => ({
  DEFAULT_BRIEFING_MODEL: "gpt-realtime-2",
  CURRENT_BRIEFING_MODEL: "gpt-realtime",
  getBriefingSourceItems: mockGetBriefingSourceItems,
  buildBriefingPromptPayload: mockBuildBriefingPromptPayload,
  buildPromptTokenCountRepresentation: mockBuildPromptTokenCountRepresentation,
  estimatePromptTokens: mockEstimatePromptTokens,
  resolveBriefingRealtimeModel: vi.fn(() =>
    process.env.BRIEFING_REALTIME_MODEL?.trim() === "gpt-realtime"
      ? "gpt-realtime"
      : "gpt-realtime-2",
  ),
  isBriefingRealtime2Model: vi.fn((model: string) => model === "gpt-realtime-2"),
}));

vi.mock("@/lib/briefing-session", () => ({
  createBriefingSession: mockCreateBriefingSession,
  countActiveBriefingSessions: mockCountActiveBriefingSessions,
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

vi.stubGlobal("fetch", mockFetch);

const latestDigest = {
  id: 1,
  content: "# Digest",
  item_count: 2,
  tweet_count: 1,
  podcast_count: 0,
  newsletter_count: 0,
  paper_count: 1,
  source_item_ids: [101, 102],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-04-14T09:30:00Z",
};

const promptPayload = {
  instructions: "briefing instructions",
  tools: [{ type: "function", name: "get_digest_item" }],
  budget: {
    withinHardCeiling: true,
  },
  digestItemManifest: {
    items: [
      { id: 101, source_type: "tweet", label: "Item 101" },
      { id: 102, source_type: "paper", label: "Item 102" },
    ],
  },
};

const briefingSessionRecord = {
  id: "session-123",
  digestId: 1,
  sourceItemIds: [101, 102],
  openaiCallId: "call_123",
  toolCallCount: 0,
  toolCallMax: 12,
  searchArchiveCount: 0,
  searchArchiveMax: 4,
  clientIpHash: "ip_hash_1",
  recommendedEndAt: "2026-04-14T10:10:00.000Z",
  expiresAt: "2026-04-14T11:05:00.000Z",
  closedAt: null,
  hangupAttemptedAt: null,
  hangupSucceededAt: null,
  createdAt: "2026-04-14T10:00:00.000Z",
};

function makeRequest(
  body: unknown = { digestId: 1, sdp: "v=0..." },
): Request {
  return new Request("http://localhost:3000/api/briefing/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/briefing/call", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.BRIEFING_REALTIME_COMPACTION_ENABLED;
    delete process.env.BRIEFING_REALTIME_COMPACTION_TRIGGER_INPUT_TOKENS;
    delete process.env.BRIEFING_REALTIME_COMPACTION_KEEP_RECENT_ITEMS;
    delete process.env.BRIEFING_REALTIME_COMPACTION_MIN_DELETE_ITEMS;

    mockSql.mockResolvedValue([latestDigest]);
    mockDeriveClientIpInfo.mockReturnValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockConsumeRateLimit.mockResolvedValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
      routeKey: "briefing/call",
      limit: 5,
      count: 1,
      allowed: true,
      bucket: "2026-04-14T10:00:00.000Z",
    });
    mockCountActiveBriefingSessions.mockResolvedValue(0);
    mockGetBriefingSourceItems.mockResolvedValue([
      { id: 101, source_type: "tweet" },
      { id: 102, source_type: "paper" },
    ]);
    mockBuildBriefingPromptPayload.mockReturnValue(promptPayload);
    mockBuildPromptTokenCountRepresentation.mockReturnValue({
      model: "gpt-realtime-2",
      input: [],
      tools: promptPayload.tools,
    });
    mockEstimatePromptTokens.mockResolvedValue({
      available: false,
      reason: "invalid_response",
    });
    mockCreateBriefingSession.mockResolvedValue(briefingSessionRecord);
    mockFetch.mockImplementation(async (input: string) => {
      if (input === "https://api.openai.com/v1/realtime/client_secrets") {
        return new Response(JSON.stringify({ value: "ek_test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (input === "https://api.openai.com/v1/realtime/calls") {
        return new Response("answer-sdp", {
          status: 200,
          headers: {
            Location: "https://api.openai.com/v1/realtime/calls/call_123",
          },
        });
      }

      throw new Error(`Unexpected fetch input: ${input}`);
    });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    consoleError.mockClear();
    consoleInfo.mockClear();
  });

  it("exports the required runtime configuration", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(30);
  });

  it("returns 400 for an invalid request body", async () => {
    const response = await POST(makeRequest({ digestId: "1", sdp: 123 }));

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

  it("returns stale digest metadata when the request is for a non-latest digest", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...latestDigest,
        id: 2,
        generated_at: "2026-04-14T09:45:00Z",
      },
    ]);

    const response = await POST(makeRequest({ digestId: 1, sdp: "v=0..." }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "stale_digest",
      latestDigestId: 2,
      latestDigestGeneratedAt: "2026-04-14T09:45:00Z",
    });
    expect(mockConsumeRateLimit).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-IP rate limit is exhausted", async () => {
    mockConsumeRateLimit.mockResolvedValueOnce({
      allowed: false,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to heuristic scoping when source_item_ids is empty", async () => {
    const legacyDigest = {
      ...latestDigest,
      source_item_ids: [],
    };
    mockSql.mockResolvedValueOnce([legacyDigest]);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockGetBriefingSourceItems).toHaveBeenCalledWith({
      digest: legacyDigest,
    });
  });

  it("returns 429 when the active-session cap is reached", async () => {
    mockCountActiveBriefingSessions.mockResolvedValueOnce(2);

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "too_many_active_sessions",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 429 when the atomic session-cap INSERT rejects a concurrent race", async () => {
    // Early count check passes (returns 1 < 2), but the atomic INSERT
    // returns null because a concurrent request inserted in the gap.
    mockCountActiveBriefingSessions.mockResolvedValueOnce(1);
    mockCreateBriefingSession.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "too_many_active_sessions",
    });
  });

  it("returns 500 when the prompt budget exceeds the hard ceiling", async () => {
    mockBuildBriefingPromptPayload.mockReturnValueOnce({
      ...promptPayload,
      budget: {
        withinHardCeiling: false,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "prompt_budget_exceeded",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 500 when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "openai_not_configured",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 500 when the available token estimate exceeds the Realtime 2 startup ceiling after margin", async () => {
    mockEstimatePromptTokens.mockResolvedValueOnce({
      available: true,
      inputTokens: 125_000,
      response: { input_tokens: 125000 },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "prompt_token_budget_exceeded",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("creates the OpenAI call with the bounded session payload and persists the documented call ID", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      answerSdp: "answer-sdp",
      briefingSessionId: "session-123",
      recommendedEndAt: "2026-04-14T10:10:00.000Z",
    });

    expect(mockGetBriefingSourceItems).toHaveBeenCalledWith({
      digest: latestDigest,
    });
    expect(mockBuildBriefingPromptPayload).toHaveBeenCalledWith({
      digest: latestDigest,
      sourceItems: [{ id: 101, source_type: "tweet" }, { id: 102, source_type: "paper" }],
      model: "gpt-realtime-2",
    });
    expect(mockBuildPromptTokenCountRepresentation).toHaveBeenCalledWith({
      instructions: "briefing instructions",
      tools: promptPayload.tools,
      model: "gpt-realtime-2",
    });

    // Step 1: client_secrets call
    const [secretUrl, secretInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(secretUrl).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(secretInit.method).toBe("POST");
    expect(secretInit.headers).toMatchObject({
      Authorization: "Bearer test-openai-key",
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "ip_hash_1",
    });

    const secretBody = JSON.parse(secretInit.body as string);
    expect(secretBody.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2",
      output_modalities: ["audio"],
      instructions: "briefing instructions",
      tools: promptPayload.tools,
      tool_choice: "auto",
      max_output_tokens: "inf",
      reasoning: { effort: "medium" },
      audio: {
        input: {
          noise_reduction: {
            type: "far_field",
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "low",
            create_response: true,
            interrupt_response: true,
          },
        },
      },
      truncation: {
        token_limits: {
          post_instructions: 96_000,
        },
      },
    });

    // Step 2: realtime/calls SDP exchange
    const [callUrl, callInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(callUrl).toBe("https://api.openai.com/v1/realtime/calls");
    expect(callInit.method).toBe("POST");
    expect(callInit.headers).toMatchObject({
      Authorization: "Bearer ek_test",
      "Content-Type": "application/sdp",
    });
    expect(callInit.body).toBe("v=0...");

    expect(mockCreateBriefingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        digestId: 1,
        sourceItemIds: [101, 102],
        clientIpHash: "ip_hash_1",
        openaiCallId: "call_123",
      }),
    );
  });

  it("returns compaction config only when the env flag is enabled", async () => {
    process.env.BRIEFING_REALTIME_COMPACTION_ENABLED = "true";
    process.env.BRIEFING_REALTIME_COMPACTION_TRIGGER_INPUT_TOKENS = "12000";
    process.env.BRIEFING_REALTIME_COMPACTION_KEEP_RECENT_ITEMS = "4";
    process.env.BRIEFING_REALTIME_COMPACTION_MIN_DELETE_ITEMS = "3";

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      answerSdp: "answer-sdp",
      briefingSessionId: "session-123",
      recommendedEndAt: "2026-04-14T10:10:00.000Z",
      compaction: {
        enabled: true,
        triggerInputTokens: 12000,
        keepRecentItemCount: 4,
        minDeleteItemCount: 3,
      },
    });
  });

  it("falls back to the char-budget gate when token counting is unavailable", async () => {
    mockEstimatePromptTokens.mockResolvedValueOnce({
      available: false,
      reason: "http_400",
      status: 400,
      response: { error: "unsupported input" },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses the rollback model configuration when BRIEFING_REALTIME_MODEL=gpt-realtime", async () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.BRIEFING_REALTIME_MODEL;
    env.BRIEFING_REALTIME_MODEL = "gpt-realtime";

    try {
      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      const [secretUrl, secretInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(secretUrl).toBe("https://api.openai.com/v1/realtime/client_secrets");
      const body = JSON.parse(secretInit.body as string) as { session: Record<string, unknown> };
      expect(mockBuildPromptTokenCountRepresentation).toHaveBeenCalledWith({
        instructions: "briefing instructions",
        tools: promptPayload.tools,
        model: "gpt-realtime",
      });
      expect(body.session).toMatchObject({
        model: "gpt-realtime",
        max_output_tokens: "inf",
      });
      expect(body.session).not.toHaveProperty("reasoning");
      expect((body.session as { audio?: { input?: { turn_detection?: Record<string, unknown> } } }).audio?.input?.turn_detection).toMatchObject({
        type: "server_vad",
        create_response: true,
        interrupt_response: true,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        threshold: 0.5,
      });
      expect((body.session as { truncation?: { token_limits?: Record<string, unknown> } }).truncation?.token_limits?.post_instructions).toBe(8_000);
    } finally {
      if (original === undefined) {
        delete env.BRIEFING_REALTIME_MODEL;
      } else {
        env.BRIEFING_REALTIME_MODEL = original;
      }
    }
  });

  it("hangs up the OpenAI call when persistence fails after create-call succeeds", async () => {
    mockCreateBriefingSession.mockRejectedValueOnce(new Error("db down"));
    mockFetch.mockImplementation(async (input: string) => {
      if (input === "https://api.openai.com/v1/realtime/client_secrets") {
        return new Response(JSON.stringify({ value: "ek_cleanup" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (input === "https://api.openai.com/v1/realtime/calls") {
        return new Response("answer-sdp", {
          status: 200,
          headers: {
            Location: "https://api.openai.com/v1/realtime/calls/call_cleanup",
          },
        });
      }

      if (input === "https://api.openai.com/v1/realtime/calls/call_cleanup/hangup") {
        return new Response("", { status: 200 });
      }

      throw new Error(`Unexpected fetch input: ${input}`);
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "briefing_call_failed",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2]?.[0]).toBe(
      "https://api.openai.com/v1/realtime/calls/call_cleanup/hangup",
    );
  });
});
