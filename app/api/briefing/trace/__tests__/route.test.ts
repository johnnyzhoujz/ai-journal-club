import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockIsBriefingObservabilityEnabled,
  mockRecordBriefingTraceEvent,
  mockRecordBriefingTraceFlag,
  mockGetBriefingSession,
  mockConsumeRateLimit,
  mockDeriveClientIpInfo,
  MockMissingClientIpError,
} = vi.hoisted(() => {
  class MissingClientIpError extends Error {}

  return {
    mockIsBriefingObservabilityEnabled: vi.fn(),
    mockRecordBriefingTraceEvent: vi.fn(),
    mockRecordBriefingTraceFlag: vi.fn(),
    mockGetBriefingSession: vi.fn(),
    mockConsumeRateLimit: vi.fn(),
    mockDeriveClientIpInfo: vi.fn(),
    MockMissingClientIpError: MissingClientIpError,
  };
});

vi.mock("@/lib/briefing-observability", () => ({
  isBriefingObservabilityEnabled: mockIsBriefingObservabilityEnabled,
  recordBriefingTraceEvent: mockRecordBriefingTraceEvent,
  recordBriefingTraceFlag: mockRecordBriefingTraceFlag,
}));

vi.mock("@/lib/briefing-session", () => ({
  getBriefingSession: mockGetBriefingSession,
}));

vi.mock("@/lib/rate-limit", () => ({
  DEFAULT_BRIEFING_RATE_LIMITS: {
    call: 5,
    tool: 30,
    trace: 60,
  },
  MissingClientIpError: MockMissingClientIpError,
  consumeRateLimit: mockConsumeRateLimit,
  deriveClientIpInfo: mockDeriveClientIpInfo,
}));

import { POST, dynamic, runtime } from "../route";

const openSession = {
  id: "session-1",
  digestId: 42,
  sourceItemIds: [123],
  openaiCallId: "call_123",
  model: "gpt-realtime",
  promptHash: "hash",
  promptBudgetJson: {},
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

function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/briefing/trace", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/briefing/trace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBriefingObservabilityEnabled.mockReturnValue(true);
    mockDeriveClientIpInfo.mockReturnValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockConsumeRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      limit: 60,
      bucket: "2026-04-14T10:00:00.000Z",
      routeKey: "briefing/trace",
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockGetBriefingSession.mockResolvedValue(openSession);
    mockRecordBriefingTraceEvent.mockResolvedValue(1);
    mockRecordBriefingTraceFlag.mockResolvedValue(undefined);
  });

  it("exports route configuration", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("accepts valid batched client events and flags", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        events: [
          {
            eventType: "tool.call",
            functionCallId: "fc_1",
            toolName: "search_memory",
            role: "assistant",
            textExcerpt: "I will search memory.",
            argumentsJson: { query: "agents" },
          },
        ],
        flags: [
          {
            ruleId: "source_filter_injected",
            severity: "warning",
            action: "normalized_args",
            toolName: "search_memory",
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      acceptedEvents: 1,
      acceptedFlags: 1,
    });
    expect(mockRecordBriefingTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        eventType: "tool.call",
        source: "client",
        textExcerpt: "I will search memory.",
      }),
    );
    expect(mockRecordBriefingTraceFlag).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
        ruleId: "source_filter_injected",
      }),
    );
  });

  it("rejects mismatched sessions", async () => {
    mockDeriveClientIpInfo.mockReturnValueOnce({
      clientIp: "203.0.113.11",
      clientIpHash: "wrong_hash",
    });

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        events: [],
        flags: [],
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_session",
    });
  });

  it("rejects unknown event fields", async () => {
    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        events: [
          {
            eventType: "tool.call",
            rawPayload: {},
          },
        ],
        flags: [],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request_body",
    });
  });

  it("no-ops cleanly when observability is disabled", async () => {
    mockIsBriefingObservabilityEnabled.mockReturnValueOnce(false);

    const response = await POST(
      makeRequest({
        briefingSessionId: "session-1",
        events: [],
        flags: [],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      disabled: true,
      acceptedEvents: 0,
      acceptedFlags: 0,
    });
    expect(mockGetBriefingSession).not.toHaveBeenCalled();
  });
});
