import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCloseBriefingSession,
  mockGetBriefingSession,
  mockDeriveClientIpInfo,
  mockFetch,
} = vi.hoisted(() => ({
  mockCloseBriefingSession: vi.fn(),
  mockGetBriefingSession: vi.fn(),
  mockDeriveClientIpInfo: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@/lib/briefing-session", () => ({
  closeBriefingSession: mockCloseBriefingSession,
  getBriefingSession: mockGetBriefingSession,
}));

vi.mock("@/lib/rate-limit", () => ({
  deriveClientIpInfo: mockDeriveClientIpInfo,
}));

import {
  POST,
  dynamic,
  maxDuration,
  runtime,
} from "../route";

vi.stubGlobal("fetch", mockFetch);

const openSession = {
  id: "session-1",
  digestId: 42,
  sourceItemIds: [123],
  openaiCallId: null,
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
  body: unknown = {
    briefingSessionId: "session-1",
  },
): Request {
  return new Request("http://localhost:3000/api/briefing/end", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/briefing/end", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-openai-key";

    mockGetBriefingSession.mockResolvedValue(openSession);
    mockCloseBriefingSession.mockResolvedValue({
      ...openSession,
      closedAt: "2026-04-14T10:01:00.000Z",
      hangupAttemptedAt: null,
      hangupSucceededAt: null,
    });
    mockDeriveClientIpInfo.mockReturnValue({
      clientIp: "203.0.113.10",
      clientIpHash: "ip_hash_1",
    });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    consoleError.mockClear();
    consoleInfo.mockClear();
    consoleWarn.mockClear();
  });

  it("exports the required runtime configuration", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(15);
  });

  it("returns 400 for an invalid request body", async () => {
    const response = await POST(makeRequest({ briefingSessionId: 123 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request_body",
    });
  });

  it("returns 404 when the session is unknown", async () => {
    mockGetBriefingSession.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
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
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCloseBriefingSession).not.toHaveBeenCalled();
  });

  it("returns 404 when client IP ownership cannot be verified", async () => {
    mockDeriveClientIpInfo.mockImplementationOnce(() => {
      throw new Error("missing client ip");
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_session",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCloseBriefingSession).not.toHaveBeenCalled();
  });

  it("closes locally without attempting a server hangup when no verified openaiCallId exists", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      closed: true,
      hangupAttempted: false,
      hangupSucceeded: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCloseBriefingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        briefingSessionId: "session-1",
      }),
    );
  });

  it("hangs up the OpenAI call when a verified call ID exists", async () => {
    mockGetBriefingSession.mockResolvedValueOnce({
      ...openSession,
      openaiCallId: "call_123",
    });
    mockCloseBriefingSession.mockResolvedValueOnce({
      ...openSession,
      openaiCallId: "call_123",
      closedAt: "2026-04-14T10:01:00.000Z",
      hangupAttemptedAt: "2026-04-14T10:01:00.000Z",
      hangupSucceededAt: "2026-04-14T10:01:00.000Z",
    });
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      closed: true,
      hangupAttempted: true,
      hangupSucceeded: true,
    });
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/realtime/calls/call_123/hangup",
    );
    expect(mockCloseBriefingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        hangupAttemptedAt: expect.any(String),
        hangupSucceededAt: expect.any(String),
      }),
    );
  });

  it("still closes the session when the upstream hangup fails", async () => {
    mockGetBriefingSession.mockResolvedValueOnce({
      ...openSession,
      openaiCallId: "call_123",
    });
    mockFetch.mockResolvedValueOnce(new Response("fail", { status: 500 }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      closed: true,
      hangupAttempted: true,
      hangupSucceeded: false,
    });
    expect(mockCloseBriefingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        hangupAttemptedAt: expect.any(String),
        hangupSucceededAt: null,
      }),
    );
  });

  it("returns the existing success shape for repeated end requests against a closed session", async () => {
    mockGetBriefingSession.mockResolvedValueOnce({
      ...openSession,
      closedAt: "2026-04-14T10:01:00.000Z",
      hangupAttemptedAt: "2026-04-14T10:01:00.000Z",
      hangupSucceededAt: null,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      closed: true,
      hangupAttempted: true,
      hangupSucceeded: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCloseBriefingSession).not.toHaveBeenCalled();
  });
});
