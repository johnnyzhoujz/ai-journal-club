import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSql,
  mockGetBriefingSourceItems,
  mockBuildBriefingPromptPayload,
  mockBuildPromptTokenCountRepresentation,
  mockEstimatePromptTokens,
  mockFormatDigestItemToolResult,
  mockSearchArchiveForTool,
  mockConsumeRateLimit,
  mockDeriveClientIpInfo,
  mockFetch,
  state,
} = vi.hoisted(() => {
  return {
    mockSql: vi.fn(),
    mockGetBriefingSourceItems: vi.fn(),
    mockBuildBriefingPromptPayload: vi.fn(),
    mockBuildPromptTokenCountRepresentation: vi.fn(),
    mockEstimatePromptTokens: vi.fn(),
    mockFormatDigestItemToolResult: vi.fn(),
    mockSearchArchiveForTool: vi.fn(),
    mockConsumeRateLimit: vi.fn(),
    mockDeriveClientIpInfo: vi.fn(),
    mockFetch: vi.fn(),
    state: {
      sessions: new Map<string, Record<string, unknown>>(),
      handledCalls: new Map<string, Record<string, unknown>>(),
      nextSessionId: 1,
    },
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
  formatDigestItemToolResult: mockFormatDigestItemToolResult,
  resolveBriefingRealtimeModel: vi.fn(() =>
    process.env.BRIEFING_REALTIME_MODEL?.trim() === "gpt-realtime"
      ? "gpt-realtime"
      : "gpt-realtime-2",
  ),
  isBriefingRealtime2Model: vi.fn((model: string) => model === "gpt-realtime-2"),
}));

vi.mock("@/lib/archive-search", () => ({
  VALID_ARCHIVE_SEARCH_SOURCES: ["all", "tweet", "podcast", "newsletter", "paper"],
  searchArchiveForTool: mockSearchArchiveForTool,
}));

vi.mock("@/lib/rate-limit", () => ({
  DEFAULT_BRIEFING_RATE_LIMITS: {
    call: 5,
    tool: 30,
  },
  MissingClientIpError: class MissingClientIpError extends Error {},
  consumeRateLimit: mockConsumeRateLimit,
  deriveClientIpInfo: mockDeriveClientIpInfo,
}));

vi.mock("@/lib/briefing-session", () => {
  const handledCallKey = (briefingSessionId: string, functionCallId: string) =>
    `${briefingSessionId}:${functionCallId}`;

  return {
    createBriefingSession: vi.fn(async (options: Record<string, unknown>) => {
      const id = `session-flow-${state.nextSessionId++}`;
      const record = {
        id,
        digestId: options.digestId,
        sourceItemIds: options.sourceItemIds,
        openaiCallId: options.openaiCallId ?? null,
        toolCallCount: 0,
        toolCallMax: 12,
        searchArchiveCount: 0,
        searchArchiveMax: 4,
        clientIpHash: options.clientIpHash,
        recommendedEndAt: "2026-04-14T10:10:00.000Z",
        expiresAt: "3026-04-14T11:05:00.000Z",
        closedAt: null,
        hangupAttemptedAt: null,
        hangupSucceededAt: null,
        createdAt: "2026-04-14T10:00:00.000Z",
      };
      state.sessions.set(id, record);
      return record;
    }),
    countActiveBriefingSessions: vi.fn(async (clientIpHash: string) => {
      return [...state.sessions.values()].filter(
        (session) =>
          session.clientIpHash === clientIpHash &&
          !session.closedAt &&
          Date.parse(String(session.expiresAt)) > Date.now(),
      ).length;
    }),
    getBriefingSession: vi.fn(async (briefingSessionId: string) => {
      return state.sessions.get(briefingSessionId) ?? null;
    }),
    closeBriefingSession: vi.fn(async (options: Record<string, unknown>) => {
      const session = state.sessions.get(String(options.briefingSessionId));
      if (!session) {
        return null;
      }

      const updated = {
        ...session,
        closedAt: session.closedAt ?? options.closedAt ?? "2026-04-14T10:01:00.000Z",
        hangupAttemptedAt: session.hangupAttemptedAt ?? options.hangupAttemptedAt ?? null,
        hangupSucceededAt: session.hangupSucceededAt ?? options.hangupSucceededAt ?? null,
      };
      state.sessions.set(String(options.briefingSessionId), updated);
      return updated;
    }),
    claimHandledCallExecution: vi.fn(
      async ({
        briefingSessionId,
        functionCallId,
        toolName,
      }: {
        briefingSessionId: string;
        functionCallId: string;
        toolName: string;
      }) => {
        const key = handledCallKey(briefingSessionId, functionCallId);
        const existing = state.handledCalls.get(key);

        if (!existing) {
          const record = {
            briefingSessionId,
            functionCallId,
            toolName,
            status: "pending",
            leaseExpiresAt: "3026-04-14T10:00:30.000Z",
            attemptCount: 1,
            lastError: null,
            resultPayload: null,
            createdAt: "2026-04-14T10:00:00.000Z",
            updatedAt: "2026-04-14T10:00:00.000Z",
          };
          state.handledCalls.set(key, record);
          return {
            disposition: "execute",
            record,
          };
        }

        if (existing.toolName !== toolName) {
          return {
            disposition: "tool_mismatch",
            record: existing,
          };
        }

        if (existing.status === "completed") {
          return {
            disposition: "replay",
            record: existing,
          };
        }

        return {
          disposition: "pending",
          record: existing,
        };
      },
    ),
    completeHandledCall: vi.fn(
      async ({
        briefingSessionId,
        functionCallId,
        toolName,
        attemptCount,
        resultPayload,
        spendBudget = true,
      }: {
        briefingSessionId: string;
        functionCallId: string;
        toolName: string;
        attemptCount: number;
        resultPayload: unknown;
        spendBudget?: boolean;
      }) => {
        const session = state.sessions.get(briefingSessionId);
        const key = handledCallKey(briefingSessionId, functionCallId);
        const handledCall = state.handledCalls.get(key);

        if (!session || session.closedAt || Date.parse(String(session.expiresAt)) <= Date.now()) {
          return {
            status: "session_unavailable",
            budgetSpent: false,
            record: null,
          };
        }

        if (
          !handledCall ||
          handledCall.status !== "pending" ||
          handledCall.attemptCount !== attemptCount
        ) {
          return {
            status: "stale_attempt",
            budgetSpent: false,
            record: null,
          };
        }

        if (spendBudget) {
          const toolCallCount = Number(session.toolCallCount);
          const toolCallMax = Number(session.toolCallMax);

          if (toolCallCount >= toolCallMax) {
            return {
              status: "budget_exhausted",
              budgetSpent: false,
              record: null,
            };
          }

          session.toolCallCount = toolCallCount + 1;
          if (toolName === "search_archive") {
            session.searchArchiveCount = Number(session.searchArchiveCount) + 1;
          }
          state.sessions.set(briefingSessionId, session);
        }

        const completed = {
          ...handledCall,
          status: "completed",
          leaseExpiresAt: null,
          lastError: null,
          resultPayload,
          updatedAt: "2026-04-14T10:00:05.000Z",
        };
        state.handledCalls.set(key, completed);

        return {
          status: "completed",
          budgetSpent: Boolean(spendBudget),
          record: completed,
        };
      },
    ),
    failHandledCall: vi.fn(
      async ({
        briefingSessionId,
        functionCallId,
        lastError,
      }: {
        briefingSessionId: string;
        functionCallId: string;
        lastError: string;
      }) => {
        const key = handledCallKey(briefingSessionId, functionCallId);
        const handledCall = state.handledCalls.get(key);
        if (!handledCall) {
          return {
            status: "stale_attempt",
            record: null,
          };
        }

        const failed = {
          ...handledCall,
          status: "failed",
          leaseExpiresAt: null,
          lastError,
          updatedAt: "2026-04-14T10:00:05.000Z",
        };
        state.handledCalls.set(key, failed);
        return {
          status: "failed",
          record: failed,
        };
      },
    ),
    getHandledCallRecord: vi.fn(async (briefingSessionId: string, functionCallId: string) => {
      return state.handledCalls.get(handledCallKey(briefingSessionId, functionCallId)) ?? null;
    }),
  };
});

import { POST as postCall } from "../call/route";
import { POST as postTool } from "../tool/route";
import { POST as postEnd } from "../end/route";

vi.stubGlobal("fetch", mockFetch);

const latestDigest = {
  id: 1,
  content: "# Digest",
  item_count: 1,
  tweet_count: 1,
  podcast_count: 0,
  newsletter_count: 0,
  paper_count: 0,
  source_item_ids: [123],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-04-14T09:30:00Z",
};

const feedItem = {
  id: 123,
  source_type: "tweet",
  external_id: "tweet-123",
  source_id: null,
  title: null,
  content: "tweet content",
  url: "https://example.com/items/123",
  author_name: "Andrej Karpathy",
  author_handle: "karpathy",
  author_bio: null,
  published_at: "2026-04-14T09:00:00Z",
  tweet_meta: null,
  paper_meta: null,
  fetched_at: "2026-04-14T09:05:00Z",
};

function makeJsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("briefing route integration flow", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-openai-key";

    state.sessions.clear();
    state.handledCalls.clear();
    state.nextSessionId = 1;

    mockDeriveClientIpInfo.mockReturnValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockConsumeRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      limit: 30,
      bucket: "2026-04-14T10:00:00.000Z",
      routeKey: "briefing/call",
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const template = strings.join(" ");
      if (template.includes("FROM digests")) {
        return Promise.resolve([latestDigest]);
      }

      if (template.includes("FROM feed_items")) {
        return Promise.resolve([feedItem]);
      }

      throw new Error(`Unexpected SQL template: ${template}`);
    });
    mockGetBriefingSourceItems.mockResolvedValue([
      {
        id: 123,
        source_type: "tweet",
        title: null,
        author_name: "Andrej Karpathy",
        published_at: "2026-04-14T09:00:00Z",
        url: "https://example.com/items/123",
        preview: "tweet preview",
        retrievalRank: 0,
      },
    ]);
    mockBuildBriefingPromptPayload.mockReturnValue({
      instructions: "briefing instructions",
      tools: [{ type: "function", name: "get_digest_item" }],
      budget: {
        withinHardCeiling: true,
      },
      digestItemManifest: {
        items: [{ id: 123, source_type: "tweet", label: "Item 123" }],
      },
    });
    mockBuildPromptTokenCountRepresentation.mockReturnValue({
      model: "gpt-realtime-2",
      input: [],
      tools: [{ type: "function", name: "get_digest_item" }],
    });
    mockEstimatePromptTokens.mockResolvedValue({
      available: false,
      reason: "invalid_response",
    });
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
    mockSearchArchiveForTool.mockResolvedValue([]);
    mockFetch.mockImplementation(async (input: string) => {
      if (input === "https://api.openai.com/v1/realtime/client_secrets") {
        return new Response(JSON.stringify({ value: "ek_flow_test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (input === "https://api.openai.com/v1/realtime/calls") {
        return new Response("answer-sdp", {
          status: 200,
          headers: {
            Location: "https://api.openai.com/v1/realtime/calls/call_flow_1",
          },
        });
      }

      if (input === "https://api.openai.com/v1/realtime/calls/call_flow_1/hangup") {
        return new Response("", { status: 200 });
      }

      throw new Error(`Unexpected fetch input: ${input}`);
    });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    consoleError.mockClear();
    consoleInfo.mockClear();
  });

  it("preserves the client-facing contract across call, tool, and end", async () => {
    const callResponse = await postCall(
      makeJsonRequest("http://localhost:3000/api/briefing/call", {
        digestId: 1,
        sdp: "v=0...",
      }),
    );

    expect(callResponse.status).toBe(200);
    const callBody = await callResponse.json();
    expect(callBody).toEqual({
      answerSdp: "answer-sdp",
      briefingSessionId: "session-flow-1",
      recommendedEndAt: "2026-04-14T10:10:00.000Z",
    });

    const toolResponse = await postTool(
      makeJsonRequest("http://localhost:3000/api/briefing/tool", {
        briefingSessionId: callBody.briefingSessionId,
        functionCallId: "call_fn_1",
        toolName: "get_digest_item",
        arguments: {
          item_id: 123,
        },
      }),
    );

    expect(toolResponse.status).toBe(200);
    await expect(toolResponse.json()).resolves.toEqual({
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

    const endResponse = await postEnd(
      makeJsonRequest("http://localhost:3000/api/briefing/end", {
        briefingSessionId: callBody.briefingSessionId,
      }),
    );

    expect(endResponse.status).toBe(200);
    await expect(endResponse.json()).resolves.toEqual({
      ok: true,
      closed: true,
      hangupAttempted: true,
      hangupSucceeded: true,
    });

    const postEndToolResponse = await postTool(
      makeJsonRequest("http://localhost:3000/api/briefing/tool", {
        briefingSessionId: callBody.briefingSessionId,
        functionCallId: "call_fn_2",
        toolName: "get_digest_item",
        arguments: {
          item_id: 123,
        },
      }),
    );

    expect(postEndToolResponse.status).toBe(404);
    await expect(postEndToolResponse.json()).resolves.toEqual({
      error: "invalid_session",
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/realtime/client_secrets",
    );
    expect(mockFetch.mock.calls[1]?.[0]).toBe(
      "https://api.openai.com/v1/realtime/calls",
    );
    expect(mockFetch.mock.calls[2]?.[0]).toBe(
      "https://api.openai.com/v1/realtime/calls/call_flow_1/hangup",
    );
  });
});
