import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock("@/lib/prompts", () => ({
  RESEARCH_ANSWER: "RESEARCH_ANSWER_PROMPT",
}));

import { POST } from "../route";

const SAMPLE_RESULTS = [
  {
    id: 1,
    source_type: "tweet",
    title: null,
    author_name: "karpathy",
    url: "https://x.com/karpathy/status/123",
    published_at: "2026-03-20T12:00:00Z",
    snippet: "building agents with LLMs",
  },
  {
    id: 2,
    source_type: "paper",
    title: "Multi-Agent Systems",
    author_name: "Jane Doe",
    url: "https://arxiv.org/abs/2603.12345",
    published_at: "2026-03-19T08:00:00Z",
    snippet: "research on agents",
  },
];

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost:3000/api/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function mockAnthropicResponse(text = "Here is a synthesis of the search results.") {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5-20251001",
    usage: { input_tokens: 500, output_tokens: 200 },
  });
}

describe("POST /api/synthesize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-api-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // -- Happy path tests -------------------------------------------------------

  it("returns synthesis text for valid request", async () => {
    mockAnthropicResponse("Agents are a key trend in AI development.");

    const res = await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.synthesis).toBe("Agents are a key trend in AI development.");
  });

  it("passes RESEARCH_ANSWER prompt as system message", async () => {
    mockAnthropicResponse();

    await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("RESEARCH_ANSWER_PROMPT");
  });

  it("passes query and results in user message", async () => {
    mockAnthropicResponse();

    await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).toContain("agents");
    expect(userMessage).toContain("karpathy");
    expect(userMessage).toContain("Multi-Agent Systems");
  });

  it("returns 200 status", async () => {
    mockAnthropicResponse();

    const res = await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));
    expect(res.status).toBe(200);
  });

  // -- Validation tests -------------------------------------------------------

  it("returns 400 when body is missing", async () => {
    const req = new Request("http://localhost:3000/api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when query is missing", async () => {
    const res = await POST(makeRequest({ results: SAMPLE_RESULTS }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when query is empty string", async () => {
    const res = await POST(makeRequest({ query: "", results: SAMPLE_RESULTS }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when results is missing", async () => {
    const res = await POST(makeRequest({ query: "agents" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when results is empty array", async () => {
    const res = await POST(makeRequest({ query: "agents", results: [] }));
    expect(res.status).toBe(400);
  });

  // -- Error handling tests ---------------------------------------------------

  it("returns 500 when Claude API fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const res = await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 500 when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const res = await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));
    expect(res.status).toBe(500);
  });

  // -- API call details -------------------------------------------------------

  it("uses correct model for synthesis", async () => {
    mockAnthropicResponse();

    await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBeDefined();
    expect(typeof callArgs.model).toBe("string");
  });

  it("sets max_tokens in Claude call", async () => {
    mockAnthropicResponse();

    await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBeDefined();
    expect(callArgs.max_tokens).toBeGreaterThan(0);
  });

  it("concatenates multiple text blocks from Claude response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Part 1. " },
        { type: "text", text: "Part 2." },
      ],
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    const res = await POST(makeRequest({ query: "agents", results: SAMPLE_RESULTS }));
    const body = await res.json();

    expect(body.synthesis).toContain("Part 1.");
    expect(body.synthesis).toContain("Part 2.");
  });
});
