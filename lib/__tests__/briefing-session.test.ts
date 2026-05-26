import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  sql: mockSql,
}));

import {
  DEFAULT_BRIEFING_EXPIRY_MS,
  DEFAULT_BRIEFING_RECOMMENDED_DURATION_MS,
  claimHandledCallExecution,
  closeBriefingSession,
  completeHandledCall,
  countActiveBriefingSessions,
  createBriefingSession,
  failHandledCall,
  getBriefingSession,
} from "../briefing-session";

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    digest_id: 42,
    source_item_ids: [11, 22],
    openai_call_id: "call_123",
    tool_call_count: 0,
    tool_call_max: 12,
    search_archive_count: 0,
    search_archive_max: 4,
    client_ip_hash: "hash_abc",
    recommended_end_at: "2026-04-14T10:10:00.000Z",
    expires_at: "2026-04-14T11:05:00.000Z",
    closed_at: null,
    hangup_attempted_at: null,
    hangup_succeeded_at: null,
    created_at: "2026-04-14T10:00:00.000Z",
    ...overrides,
  };
}

function makeHandledCallRow(overrides: Record<string, unknown> = {}) {
  return {
    briefing_session_id: "session-1",
    function_call_id: "fc_1",
    tool_name: "get_digest_item",
    status: "pending",
    lease_expires_at: "2026-04-14T10:00:30.000Z",
    attempt_count: 1,
    last_error: null,
    result_payload: null,
    request_arguments: null,
    created_at: "2026-04-14T10:00:00.000Z",
    updated_at: "2026-04-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("briefing-session helpers", () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it("creates briefing sessions with the expected defaults and source item IDs", async () => {
    const now = new Date("2026-04-14T10:00:00.000Z");
    mockSql.mockResolvedValueOnce([
      makeSessionRow({
        id: "session-123",
        source_item_ids: [7, 8, 9],
        openai_call_id: null,
        client_ip_hash: "ip_hash_1",
        recommended_end_at: new Date(
          now.getTime() + DEFAULT_BRIEFING_RECOMMENDED_DURATION_MS,
        ).toISOString(),
        expires_at: new Date(
          now.getTime() + DEFAULT_BRIEFING_EXPIRY_MS,
        ).toISOString(),
      }),
    ]);

    const session = await createBriefingSession({
      id: "session-123",
      digestId: 42,
      sourceItemIds: [7, 8, 9],
      clientIpHash: "ip_hash_1",
      now,
    });

    expect(session).not.toBeNull();
    expect(session!.id).toBe("session-123");
    expect(session!.sourceItemIds).toEqual([7, 8, 9]);
    expect(session!.openaiCallId).toBeNull();
    expect(session!.recommendedEndAt).toBe("2026-04-14T10:10:00.000Z");
    expect(session!.expiresAt).toBe("2026-04-14T11:05:00.000Z");

    const interpolatedValues = mockSql.mock.calls[0].slice(1);
    expect(interpolatedValues[0]).toBe("session-123");
    expect(interpolatedValues[1]).toBe(42);
    expect(interpolatedValues[2]).toEqual([7, 8, 9]);
    expect(interpolatedValues[6]).toBe("ip_hash_1");
  });

  it("returns null when the atomic per-IP active-session cap rejects the insert", async () => {
    mockSql.mockResolvedValueOnce([]);

    const session = await createBriefingSession({
      id: "session-race",
      digestId: 42,
      sourceItemIds: [7],
      clientIpHash: "ip_hash_1",
      maxActivePerIp: 2,
      now: new Date("2026-04-14T10:00:00.000Z"),
    });

    expect(session).toBeNull();

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("SELECT");
    expect(template).toContain("WHERE");
    expect(template).toContain("COUNT(*)");
    expect(template).toContain("closed_at IS NULL");
  });

  it("loads briefing sessions and maps the stored fields back to camelCase", async () => {
    mockSql.mockResolvedValueOnce([
      makeSessionRow({
        source_item_ids: [5, 6],
        tool_call_count: 3,
        search_archive_count: 2,
      }),
    ]);

    const session = await getBriefingSession("session-1");

    expect(session).toMatchObject({
      id: "session-1",
      digestId: 42,
      sourceItemIds: [5, 6],
      toolCallCount: 3,
      searchArchiveCount: 2,
      clientIpHash: "hash_abc",
    });
  });

  it("counts only active non-closed, non-expired sessions for a hashed client IP", async () => {
    mockSql.mockResolvedValueOnce([{ count: "2" }]);

    const count = await countActiveBriefingSessions(
      "hash_abc",
      "2026-04-14T10:00:00.000Z",
    );

    expect(count).toBe(2);

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("closed_at IS NULL");
    expect(template).toContain("expires_at >");
  });

  it("marks sessions closed while atomically capturing hangup timestamps", async () => {
    mockSql.mockResolvedValueOnce([
      makeSessionRow({
        closed_at: "2026-04-14T10:12:00.000Z",
        hangup_attempted_at: "2026-04-14T10:12:01.000Z",
        hangup_succeeded_at: "2026-04-14T10:12:02.000Z",
      }),
    ]);

    const session = await closeBriefingSession({
      briefingSessionId: "session-1",
      closedAt: "2026-04-14T10:12:00.000Z",
      hangupAttemptedAt: "2026-04-14T10:12:01.000Z",
      hangupSucceededAt: "2026-04-14T10:12:02.000Z",
    });

    expect(session?.closedAt).toBe("2026-04-14T10:12:00.000Z");
    expect(session?.hangupAttemptedAt).toBe("2026-04-14T10:12:01.000Z");
    expect(session?.hangupSucceededAt).toBe("2026-04-14T10:12:02.000Z");

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("COALESCE(closed_at");
    expect(template).toContain("hangup_attempted_at");
    expect(template).toContain("hangup_succeeded_at");
  });

  it("claims a new handled call for execution with an initial lease", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow(),
        claimed: true,
      },
    ]);

    const result = await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      leaseDurationSeconds: 45,
      now: "2026-04-14T10:00:00.000Z",
    });

    expect(result.disposition).toBe("execute");
    expect(result.record.attemptCount).toBe(1);

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("INSERT INTO briefing_handled_calls");
    expect(template).toContain("ON CONFLICT (briefing_session_id, function_call_id) DO UPDATE");
    expect(template).toContain("lease_expires_at");
    expect(template).toContain("INTERVAL '1 second'");
    expect(template).toContain("request_arguments");
  });

  it("persists the model's raw tool arguments as request_arguments at claim time", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow({
          tool_name: "search_memory",
          request_arguments: { query: "supply chain", source: "paper" },
        }),
        claimed: true,
      },
    ]);

    const requestArguments = {
      query: "supply chain",
      source: "paper",
      limit: 4,
    };

    const result = await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "search_memory",
      requestArguments,
      now: "2026-04-14T10:00:00.000Z",
    });

    expect(result.disposition).toBe("execute");
    expect(result.record.requestArguments).toEqual({
      query: "supply chain",
      source: "paper",
    });

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("request_arguments");
    expect(template).toContain("EXCLUDED.request_arguments");

    const interpolatedValues = mockSql.mock.calls[0].slice(1);
    expect(interpolatedValues).toContain(JSON.stringify(requestArguments));
  });

  it("passes a null request_arguments when the caller omits it", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow(),
        claimed: true,
      },
    ]);

    await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      now: "2026-04-14T10:00:00.000Z",
    });

    const interpolatedValues = mockSql.mock.calls[0].slice(1);
    expect(interpolatedValues).toContain(null);
  });

  it("replays completed handled calls without re-executing them", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow({
          status: "completed",
          result_payload: JSON.stringify({ ok: true, answer: "cached" }),
        }),
        claimed: false,
      },
    ]);

    const result = await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
    });

    expect(result.disposition).toBe("replay");
    expect(result.record.resultPayload).toEqual({ ok: true, answer: "cached" });
  });

  it("returns pending when another worker still holds an unexpired lease", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow({
          status: "pending",
        }),
        claimed: false,
      },
    ]);

    const result = await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
    });

    expect(result.disposition).toBe("pending");
  });

  it("reclaims expired pending leases so failed workers do not wedge a handled call forever", async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...makeHandledCallRow({
          status: "pending",
          attempt_count: 2,
          lease_expires_at: "2026-04-14T10:01:00.000Z",
        }),
        claimed: true,
      },
    ]);

    const result = await claimHandledCallExecution({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      now: "2026-04-14T10:02:00.000Z",
    });

    expect(result.disposition).toBe("execute");
    expect(result.record.attemptCount).toBe(2);
  });

  it("atomically completes handled calls and spends tool budget on success", async () => {
    mockSql.mockResolvedValueOnce([
      {
        session_eligible: true,
        call_claimable: true,
        budget_spent: true,
        completed: true,
        ...makeHandledCallRow({
          tool_name: "search_archive",
          status: "completed",
          attempt_count: 2,
          lease_expires_at: null,
          result_payload: JSON.stringify({ results: [] }),
        }),
      },
    ]);

    const result = await completeHandledCall({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "search_archive",
      attemptCount: 2,
      resultPayload: { results: [] },
      now: "2026-04-14T10:03:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.budgetSpent).toBe(true);
    expect(result.record?.toolName).toBe("search_archive");

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("FOR UPDATE");
    expect(template).toContain("tool_call_count = tool_call_count + 1");
    expect(template).toContain("search_archive_count = search_archive_count +");
    expect(template).toContain("tool_call_count < tool_call_max");
    expect(template).toContain("search_archive_count < search_archive_max");
  });

  it("counts search_memory against the existing search budget", async () => {
    mockSql.mockResolvedValueOnce([
      {
        session_eligible: true,
        call_claimable: true,
        budget_spent: true,
        completed: true,
        ...makeHandledCallRow({
          tool_name: "search_memory",
          status: "completed",
          lease_expires_at: null,
          result_payload: JSON.stringify({ results: [] }),
        }),
      },
    ]);

    const result = await completeHandledCall({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "search_memory",
      attemptCount: 1,
      resultPayload: { results: [] },
      now: "2026-04-14T10:03:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.record?.toolName).toBe("search_memory");

    const values = mockSql.mock.calls[0].slice(1);
    expect(values).toContain("search_memory");
    expect(values).toContain(1);
    expect(values).toContain(true);
  });

  it("returns budget_exhausted when a successful tool result can no longer spend session budget", async () => {
    mockSql.mockResolvedValueOnce([
      {
        session_eligible: true,
        call_claimable: true,
        budget_spent: false,
        completed: false,
        briefing_session_id: null,
        function_call_id: null,
        tool_name: null,
        status: null,
        lease_expires_at: null,
        attempt_count: null,
        last_error: null,
        result_payload: null,
        created_at: null,
        updated_at: null,
      },
    ]);

    const result = await completeHandledCall({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      attemptCount: 2,
      resultPayload: { ok: true },
      now: "2026-04-14T10:03:00.000Z",
    });

    expect(result.status).toBe("budget_exhausted");
    expect(result.budgetSpent).toBe(false);
  });

  it("persists relayable tool errors without burning budget", async () => {
    mockSql.mockResolvedValueOnce([
      {
        session_eligible: true,
        call_claimable: true,
        budget_spent: false,
        completed: true,
        ...makeHandledCallRow({
          status: "completed",
          attempt_count: 3,
          lease_expires_at: null,
          result_payload: JSON.stringify({
            error: "retrieval_failed",
            retryable: true,
          }),
        }),
      },
    ]);

    const result = await completeHandledCall({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      attemptCount: 3,
      resultPayload: { error: "retrieval_failed", retryable: true },
      spendBudget: false,
    });

    expect(result.status).toBe("completed");
    expect(result.budgetSpent).toBe(false);
    expect(result.record?.resultPayload).toEqual({
      error: "retrieval_failed",
      retryable: true,
    });
  });

  it("marks handled calls failed without permanently burning session budget", async () => {
    mockSql.mockResolvedValueOnce([
      makeHandledCallRow({
        status: "failed",
        attempt_count: 4,
        lease_expires_at: null,
        last_error: "upstream timeout",
      }),
    ]);

    const result = await failHandledCall({
      briefingSessionId: "session-1",
      functionCallId: "fc_1",
      toolName: "get_digest_item",
      attemptCount: 4,
      lastError: "upstream timeout",
    });

    expect(result.status).toBe("failed");
    expect(result.record?.lastError).toBe("upstream timeout");

    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).not.toContain("tool_call_count");
    expect(template).toContain("SET status = 'failed'");
  });
});
